//! What Kortix Capture itself costs this computer, for `status.json`
//! `resources`: the CPU time and memory of its own processes (the recorder,
//! the capture engines, the tray, the machine service, the action recorder).
//! An admin reads it in Kortix ("Device details") to see if Capture slows a
//! computer down.
//!
//! The sync thread calls [`Sampler::tick`] on every tick. It reads the process
//! table at most once a minute. The report covers the last 10 samples (about
//! 10 minutes): CPU as a percentage of one core, averaged over that window and
//! its busiest minute, and the memory (working set / resident size) now.
//!
//! What counts as Kortix Capture: an executable whose name starts with
//! `kortix-capture` or `kortix-backend` (`.exe` on Windows), or `Kortix
//! Capture` (the macOS app). Only processes this user can read count:
//! - Windows: this session and session 0. A machine service that runs as
//!   SYSTEM is in session 0, but a normal user cannot open it, so it is left
//!   out. Other people's sessions are left out.
//! - Linux: processes of this user.
//! - macOS: processes of this user (`proc_pidinfo` refuses the root daemon).
//!
//! CPU between two samples is the change of each process's CPU time. A
//! process that is new since the last sample counts with all of its CPU time
//! (it started in that minute). A process that exits between two samples
//! loses its last minute. A sample after a sleep, or after a gap longer than
//! the window, starts a new baseline: CPU time does not move while the
//! computer sleeps.

use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::time::Instant;

/// One sample a minute.
pub const SAMPLE_EVERY_MS: i64 = 60_000;
/// Samples in the report: 10 minutes.
pub const WINDOW: usize = 10;
/// At most this many process names in `processes`.
const MAX_NAMES: usize = 16;

/// One Kortix Capture process at one moment.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    /// The executable name: lower case, no `.exe` (`kortix-capture-engine`).
    pub name: String,
    /// User and kernel CPU time since the process started, in nanoseconds.
    pub cpu_ns: u64,
    /// Working set (Windows) or resident size (Linux, macOS), in bytes.
    pub memory_bytes: u64,
}

/// The Kortix Capture name of an executable (a path or a file name), or None
/// when it is not Kortix Capture.
pub fn capture_name(exe: &str) -> Option<String> {
    let base = exe.rsplit(['/', '\\']).next()?.trim();
    let lower = base.to_ascii_lowercase();
    let name = lower.strip_suffix(".exe").unwrap_or(&lower);
    (name.starts_with("kortix-capture")
        || name.starts_with("kortix-backend")
        || name == "kortix capture")
        .then(|| name.to_string())
}

#[derive(Debug, Clone, Default)]
struct Usage {
    count: u32,
    cpu_ns: u64,
    memory_bytes: u64,
}

/// The time between two samples.
#[derive(Debug, Clone)]
struct Interval {
    end_ms: i64,
    span_ms: i64,
    /// Per name: CPU used in the interval; process count and memory at its end.
    by_name: BTreeMap<String, Usage>,
}

impl Interval {
    fn cpu_ns(&self) -> u64 {
        self.by_name.values().map(|u| u.cpu_ns).sum()
    }
    fn memory_bytes(&self) -> u64 {
        self.by_name.values().map(|u| u.memory_bytes).sum()
    }
}

/// The samples of the last 10 minutes. Lives in the sync thread's runtime.
#[derive(Debug, Default)]
pub struct Sampler {
    /// The last sample: when, and pid → (name, CPU time).
    last: Option<(i64, HashMap<u32, (String, u64)>)>,
    window: VecDeque<Interval>,
    tried_ms: i64,
    /// Wall time of the last process table read, in microseconds.
    read_us: Option<u64>,
}

/// CPU nanoseconds over a span in milliseconds, as a percentage of one core, one decimal.
fn percent(cpu_ns: u64, span_ms: i64) -> f64 {
    if span_ms <= 0 {
        return 0.0;
    }
    (cpu_ns as f64 / (span_ms as f64 * 1e6) * 1000.0).round() / 10.0
}

impl Sampler {
    /// Read the process table when a minute has passed since the last read.
    /// `awake_since_ms`: when the computer last woke; an older baseline is dropped.
    pub fn tick(&mut self, now_ms: i64, awake_since_ms: i64) {
        if now_ms - self.tried_ms < SAMPLE_EVERY_MS {
            return;
        }
        self.tried_ms = now_ms;
        if self
            .last
            .as_ref()
            .is_some_and(|(at, _)| *at < awake_since_ms)
        {
            self.last = None;
        }
        let started = Instant::now();
        let procs = processes();
        self.read_us = Some(started.elapsed().as_micros() as u64);
        if let Some(procs) = procs {
            self.record(now_ms, procs);
        }
    }

    /// Add one sample of the Kortix Capture processes, taken at `now_ms`.
    pub fn record(&mut self, now_ms: i64, procs: Vec<Proc>) {
        let current: HashMap<u32, (String, u64)> = procs
            .iter()
            .map(|p| (p.pid, (p.name.clone(), p.cpu_ns)))
            .collect();
        // A gap longer than the window (the thread stalled) starts a new baseline.
        let fresh = |at: &i64| now_ms > *at && now_ms - *at <= WINDOW as i64 * SAMPLE_EVERY_MS;
        if let Some((at, before)) = self.last.take().filter(|(at, _)| fresh(at)) {
            let mut by_name: BTreeMap<String, Usage> = BTreeMap::new();
            for p in &procs {
                let used = match before.get(&p.pid) {
                    Some((name, cpu)) if *name == p.name => p.cpu_ns.saturating_sub(*cpu),
                    // New since the last sample (or a reused pid): it started in this interval.
                    _ => p.cpu_ns,
                };
                let u = by_name.entry(p.name.clone()).or_default();
                u.count += 1;
                u.cpu_ns += used;
                u.memory_bytes += p.memory_bytes;
            }
            self.window.push_back(Interval {
                end_ms: now_ms,
                span_ms: now_ms - at,
                by_name,
            });
        }
        // Keep 10 intervals, none older than 10 minutes plus one sample.
        let oldest = now_ms - (WINDOW as i64 + 1) * SAMPLE_EVERY_MS;
        while self.window.len() > WINDOW || self.window.front().is_some_and(|i| i.end_ms < oldest) {
            self.window.pop_front();
        }
        self.last = Some((now_ms, current));
    }

    /// status.json `resources`, or null before two samples (about the first minute).
    pub fn report(&self) -> Value {
        let Some(latest) = self.window.back() else {
            return Value::Null;
        };
        let span: i64 = self.window.iter().map(|i| i.span_ms).sum();
        let cpu: u64 = self.window.iter().map(Interval::cpu_ns).sum();
        let peak = self
            .window
            .iter()
            .map(|i| percent(i.cpu_ns(), i.span_ms))
            .fold(0.0, f64::max);
        let mut names: BTreeMap<&str, (u64, Usage)> = BTreeMap::new();
        for i in &self.window {
            for (name, u) in &i.by_name {
                names.entry(name).or_default().0 += u.cpu_ns;
            }
        }
        for (name, u) in &latest.by_name {
            names.entry(name).or_default().1 = u.clone();
        }
        let mut processes: Vec<(&str, u64, Usage)> = names
            .into_iter()
            .map(|(n, (cpu, now))| (n, cpu, now))
            .collect();
        processes.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.memory_bytes.cmp(&a.2.memory_bytes)));
        processes.truncate(MAX_NAMES);
        json!({
            "windowMs": span,
            "samples": self.window.len(),
            "cpuPercentAvg": percent(cpu, span),
            "cpuPercentPeak": peak,
            "memoryBytes": latest.memory_bytes(),
            "memoryBytesPeak": self.window.iter().map(Interval::memory_bytes).max().unwrap_or(0),
            "processCount": latest.by_name.values().map(|u| u.count).sum::<u32>(),
            "processes": processes.iter().map(|(name, cpu, now)| json!({
                "name": name,
                "count": now.count,
                "cpuPercentAvg": percent(*cpu, span),
                "memoryBytes": now.memory_bytes,
            })).collect::<Vec<_>>(),
            "sampledAtMs": latest.end_ms,
            "readMicros": self.read_us,
        })
    }
}

/// Linux: pids that are not Kortix Capture (another program, or another
/// user's), so a sample reads only the `/proc` listing and the Capture
/// processes. The list is dropped every 10 minutes: a pid that the OS gave to
/// a new process, or a process that ran another program, is read again then.
#[cfg(target_os = "linux")]
static OTHERS: std::sync::Mutex<Option<(Instant, std::collections::HashSet<u32>)>> =
    std::sync::Mutex::new(None);

/// Every Kortix Capture process this user can read, or None where the OS has
/// no reader here.
#[cfg(target_os = "linux")]
pub fn processes() -> Option<Vec<Proc>> {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: plain libc calls without pointers.
    let (uid, ticks, page) = unsafe {
        (
            libc::geteuid(),
            libc::sysconf(libc::_SC_CLK_TCK),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    if ticks <= 0 || page <= 0 {
        return None;
    }
    let ns_per_tick = 1_000_000_000 / ticks as u64;
    let mut others = OTHERS.lock().unwrap_or_else(|e| e.into_inner());
    if others
        .as_ref()
        .is_none_or(|(at, _)| at.elapsed().as_millis() as i64 > WINDOW as i64 * SAMPLE_EVERY_MS)
    {
        *others = Some((Instant::now(), Default::default()));
    }
    let skip = &mut others.as_mut()?.1;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        seen.insert(pid);
        if skip.contains(&pid) {
            continue;
        }
        let dir = entry.path();
        // `comm` holds at most 15 characters: `kortix-capture-engine` reads `kortix-capture-`.
        let Ok(comm) = std::fs::read_to_string(dir.join("comm")) else {
            continue;
        };
        if !(comm.starts_with("kortix-captur") || comm.starts_with("kortix-backend"))
            || entry.metadata().ok().map(|m| m.uid()) != Some(uid)
        {
            skip.insert(pid);
            continue;
        }
        let exe = std::fs::read_link(dir.join("exe")).ok();
        let exe = exe
            .as_ref()
            .and_then(|p| p.to_str())
            .map(|p| p.trim_end_matches(" (deleted)").to_string());
        let Some(name) = capture_name(exe.as_deref().unwrap_or(comm.trim())) else {
            continue;
        };
        let (Ok(stat), Ok(statm)) = (
            std::fs::read_to_string(dir.join("stat")),
            std::fs::read_to_string(dir.join("statm")),
        ) else {
            continue;
        };
        // Fields after the `(comm)`: state is 3, utime 14, stime 15 (proc(5)).
        let rest: Vec<&str> = stat
            .rsplit_once(')')
            .map(|(_, r)| r.split_whitespace().collect())
            .unwrap_or_default();
        let field = |n: usize| rest.get(n - 3).and_then(|v| v.parse::<u64>().ok());
        let (Some(utime), Some(stime)) = (field(14), field(15)) else {
            continue;
        };
        let resident = statm
            .split_whitespace()
            .nth(1)
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        out.push(Proc {
            pid,
            name,
            cpu_ns: (utime + stime) * ns_per_tick,
            memory_bytes: resident * page as u64,
        });
    }
    skip.retain(|pid| seen.contains(pid));
    Some(out)
}

#[cfg(target_os = "macos")]
#[allow(deprecated)] // libc's `mach_timebase_info` points to the `mach2` crate; the call is the same.
pub fn processes() -> Option<Vec<Proc>> {
    use std::ffi::c_void;
    // SAFETY: the buffers are sized as the calls are told; the OS writes no more.
    unsafe {
        let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
        if libc::mach_timebase_info(&mut timebase) != 0 || timebase.denom == 0 {
            return None;
        }
        let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
        if n <= 0 {
            return None;
        }
        let mut pids = vec![0 as libc::pid_t; n as usize + 64];
        let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        let n = libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), bytes);
        if n <= 0 {
            return None;
        }
        pids.truncate(n as usize);
        let mut out = Vec::new();
        for pid in pids {
            let mut buf = [0u8; 64];
            let len = libc::proc_name(pid, buf.as_mut_ptr().cast::<c_void>(), buf.len() as u32);
            if len <= 0 {
                continue;
            }
            let Some(name) = std::str::from_utf8(&buf[..len as usize])
                .ok()
                .and_then(capture_name)
            else {
                continue;
            };
            let mut info: libc::proc_taskinfo = std::mem::zeroed();
            let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
            // Another user's process (the root daemon) answers 0: left out.
            if libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTASKINFO,
                0,
                (&mut info as *mut libc::proc_taskinfo).cast(),
                size,
            ) != size
            {
                continue;
            }
            // The CPU times are in Mach time units (not nanoseconds on Apple silicon).
            let ticks = info.pti_total_user + info.pti_total_system;
            out.push(Proc {
                pid: pid as u32,
                name,
                cpu_ns: (ticks as u128 * timebase.numer as u128 / timebase.denom as u128) as u64,
                memory_bytes: info.pti_resident_size,
            });
        }
        Some(out)
    }
}

#[cfg(windows)]
pub fn processes() -> Option<Vec<Proc>> {
    const TH32CS_SNAPPROCESS: u32 = 0x2;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    // SAFETY: every struct carries its size; each handle is closed once.
    unsafe {
        let mut own_session = 0u32;
        if win::ProcessIdToSessionId(win::GetCurrentProcessId(), &mut own_session) == 0 {
            return None;
        }
        let snap = win::CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap as isize == -1 {
            return None;
        }
        let mut out = Vec::new();
        let mut entry: win::ProcessEntry = std::mem::zeroed();
        entry.size = std::mem::size_of::<win::ProcessEntry>() as u32;
        let mut more = win::Process32FirstW(snap, &mut entry) != 0;
        while more {
            let len = entry
                .exe
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.exe.len());
            let pid = entry.pid;
            let name = capture_name(&String::from_utf16_lossy(&entry.exe[..len]));
            more = win::Process32NextW(snap, &mut entry) != 0;
            let Some(name) = name else { continue };
            let mut session = 0u32;
            if win::ProcessIdToSessionId(pid, &mut session) == 0
                || (session != own_session && session != 0)
            {
                continue;
            }
            let h = win::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                continue; // SYSTEM's machine service, or the process exited.
            }
            // FILETIMEs in 100 ns units.
            let (mut created, mut exited, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
            let mut mem: win::MemoryCounters = std::mem::zeroed();
            mem.size = std::mem::size_of::<win::MemoryCounters>() as u32;
            let times =
                win::GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) != 0;
            let memory = win::K32GetProcessMemoryInfo(h, &mut mem, mem.size) != 0;
            win::CloseHandle(h);
            if times {
                out.push(Proc {
                    pid,
                    name,
                    cpu_ns: (kernel + user) * 100,
                    memory_bytes: if memory {
                        mem.working_set_size as u64
                    } else {
                        0
                    },
                });
            }
        }
        win::CloseHandle(snap);
        Some(out)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub fn processes() -> Option<Vec<Proc>> {
    None
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod win {
    use std::ffi::c_void;

    /// PROCESSENTRY32W.
    #[repr(C)]
    pub struct ProcessEntry {
        pub size: u32,
        pub usage: u32,
        pub pid: u32,
        pub default_heap_id: usize,
        pub module_id: u32,
        pub threads: u32,
        pub parent_pid: u32,
        pub priority_base: i32,
        pub flags: u32,
        pub exe: [u16; 260],
    }

    /// PROCESS_MEMORY_COUNTERS.
    #[repr(C)]
    pub struct MemoryCounters {
        pub size: u32,
        pub page_faults: u32,
        pub peak_working_set_size: usize,
        pub working_set_size: usize,
        pub quota_peak_paged_pool: usize,
        pub quota_paged_pool: usize,
        pub quota_peak_non_paged_pool: usize,
        pub quota_non_paged_pool: usize,
        pub pagefile_usage: usize,
        pub peak_pagefile_usage: usize,
    }

    // The Windows SDK sizes on x64: 568 and 72 bytes.
    #[cfg(target_pointer_width = "64")]
    const _: () = assert!(
        std::mem::size_of::<ProcessEntry>() == 568 && std::mem::size_of::<MemoryCounters>() == 72
    );

    #[link(name = "kernel32")]
    extern "system" {
        pub fn GetCurrentProcessId() -> u32;
        pub fn ProcessIdToSessionId(pid: u32, session: *mut u32) -> i32;
        pub fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut c_void;
        pub fn Process32FirstW(snap: *mut c_void, entry: *mut ProcessEntry) -> i32;
        pub fn Process32NextW(snap: *mut c_void, entry: *mut ProcessEntry) -> i32;
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        pub fn GetProcessTimes(
            h: *mut c_void,
            created: *mut u64,
            exited: *mut u64,
            kernel: *mut u64,
            user: *mut u64,
        ) -> i32;
        pub fn K32GetProcessMemoryInfo(
            h: *mut c_void,
            counters: *mut MemoryCounters,
            size: u32,
        ) -> i32;
        pub fn CloseHandle(h: *mut c_void) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(pid: u32, name: &str, cpu_ms: u64, mb: u64) -> Proc {
        Proc {
            pid,
            name: name.into(),
            cpu_ns: cpu_ms * 1_000_000,
            memory_bytes: mb << 20,
        }
    }

    #[test]
    fn capture_names() {
        assert_eq!(
            capture_name(r"C:\Program Files\Kortix Capture\kortix-capture-engine.exe").as_deref(),
            Some("kortix-capture-engine")
        );
        assert_eq!(
            capture_name("KORTIX-BACKEND.EXE").as_deref(),
            Some("kortix-backend")
        );
        assert_eq!(
            capture_name("/Applications/Kortix Capture.app/Contents/MacOS/Kortix Capture")
                .as_deref(),
            Some("kortix capture")
        );
        assert_eq!(
            capture_name("/usr/bin/kortix-capture").as_deref(),
            Some("kortix-capture")
        );
        assert_eq!(capture_name("explorer.exe"), None);
        assert_eq!(capture_name("kortix"), None);
    }

    #[test]
    fn the_report_averages_the_window_and_names_its_busiest_minute() {
        let mut s = Sampler::default();
        assert!(s.report().is_null());
        s.record(
            0,
            vec![
                p(1, "kortix-capture", 1_000, 100),
                p(2, "kortix-capture-engine", 5_000, 200),
            ],
        );
        assert!(s.report().is_null(), "one sample has no interval");
        // Minute 1: 600 ms + 3 000 ms of CPU = 6 % of one core.
        s.record(
            60_000,
            vec![
                p(1, "kortix-capture", 1_600, 110),
                p(2, "kortix-capture-engine", 8_000, 210),
            ],
        );
        // Minute 2: the engine restarted (new pid 3, 1 200 ms); pid 2 exited.
        s.record(
            120_000,
            vec![
                p(1, "kortix-capture", 2_200, 120),
                p(3, "kortix-capture-engine", 1_200, 150),
                p(4, "kortix-backend", 0, 30),
            ],
        );
        let r = s.report();
        assert_eq!(r["samples"], 2);
        assert_eq!(r["windowMs"], 120_000);
        assert_eq!(r["cpuPercentPeak"], 6.0);
        // (3 600 + 1 800) ms over 120 s = 4.5 %.
        assert_eq!(r["cpuPercentAvg"], 4.5);
        assert_eq!(r["processCount"], 3);
        assert_eq!(r["memoryBytes"], 300u64 << 20);
        assert_eq!(r["memoryBytesPeak"], 320u64 << 20);
        assert_eq!(r["sampledAtMs"], 120_000);
        let procs = r["processes"].as_array().unwrap();
        assert_eq!(
            procs[0],
            json!({"name": "kortix-capture-engine", "count": 1, "cpuPercentAvg": 3.5, "memoryBytes": 150u64 << 20})
        );
        assert_eq!(procs[1]["name"], "kortix-capture");
        assert_eq!(procs[1]["cpuPercentAvg"], 1.0);
        assert_eq!(procs[2]["name"], "kortix-backend");
    }

    #[test]
    fn the_window_keeps_ten_minutes_and_a_wake_starts_a_new_baseline() {
        let mut s = Sampler::default();
        for minute in 0..=15 {
            s.record(
                minute * 60_000,
                vec![p(1, "kortix-capture", minute as u64 * 600, 10)],
            );
        }
        assert_eq!(s.report()["samples"], WINDOW);
        assert_eq!(s.report()["cpuPercentAvg"], 1.0);
        // A sleep: the next tick after a wake drops the baseline from before it.
        s.tried_ms = 15 * 60_000;
        s.tick(16 * 60_000, 16 * 60_000 - 1);
        assert!(s.last.as_ref().is_none_or(|(at, _)| *at == 16 * 60_000));
        // After a gap longer than the window, only new intervals count.
        s.record(90 * 60_000, vec![p(1, "kortix-capture", 10_000, 10)]);
        s.record(91 * 60_000, vec![p(1, "kortix-capture", 10_600, 10)]);
        assert_eq!(s.report()["samples"], 1);
    }

    /// The reader finds this computer's Kortix Capture processes and costs
    /// well under a millisecond (Linux; the test binary itself does not count).
    #[cfg(target_os = "linux")]
    #[test]
    fn reading_the_process_table_is_cheap() {
        // The first read after start (and every 10 minutes) reads every process once.
        let started = Instant::now();
        processes().unwrap();
        eprintln!("full process table read: {:?}", started.elapsed());
        let started = Instant::now();
        for _ in 0..10 {
            processes().unwrap();
        }
        let each = started.elapsed() / 10;
        eprintln!("one process table read: {each:?}");
        assert!(each.as_millis() < 20, "{each:?}");
    }
}
