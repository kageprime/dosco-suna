'use client';

import { Footage, Shot, useFrame, type Cue, type FilmDef } from '../../engine/film';
import { bars, ease, fall, interp, rise } from '../../engine/time';

/**
 * "The Company / Product Ad" — 60s, Apple-grammar product film for Dosco Tek.
 * Seamless, zero-pause presentation: every video clip is mounted in its own
 * pre-buffered Shot, ending on the official Dosco Tek animated logo and fiery crest.
 *
 * Visual assets: 1280×720 master clips staged at `/media/ad/*`.
 * Grid: 30 bars at 120 BPM = 60s at 60 fps (3600 frames).
 */

const AD_MEDIA = '/media/ad';

/* ── Scene 1: The Void (0:00–0:04 · Bars 0–2 · 240 frames) ──────────────── */
function SceneCursor() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/cursor.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div
        className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
        style={rise(f, 60, { dist: 16 })}
      >
        <p className="text-muted-foreground/80 font-mono text-xs uppercase tracking-[0.25em]">
          CompanyOS
        </p>
      </div>
    </div>
  );
}

/* ── Scene 2: The Clock (0:04–0:07 · Bars 2–3.5 · 180 frames) ────────────── */
function SceneClock() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/clock.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-black/40" />
      <div className="absolute inset-0 flex flex-col justify-end p-16 pointer-events-none">
        <div style={rise(f, 20, { dist: 24 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block mb-3">
            02 · Decisions
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white max-w-2xl leading-[1.1]">
            Every business runs on decisions.
          </h2>
          <p className="text-xl text-white/60 mt-3 font-normal max-w-xl">
            Who does the work. What tools they touch.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 3: The Coffee (0:07–0:10 · Bars 3.5–5 · 180 frames) ──────────── */
function SceneCoffee() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/coffee.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-black/40" />
      <div className="absolute inset-0 flex flex-col justify-end p-16 pointer-events-none">
        <div style={rise(f, 20, { dist: 24 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block mb-3">
            03 · The Late Night
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white max-w-2xl leading-[1.1]">
            Most of it lives in people&apos;s heads.
          </h2>
          <p className="text-xl text-white/60 mt-3 font-normal max-w-xl">
            The rest lives in software you rent.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 4: Closed Laptop (0:10–0:14 · Bars 5–7 · 240 frames) ─────────── */
function SceneLaptopClosed() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/laptop-closed.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <div className="absolute inset-0 flex flex-col justify-end p-16 pointer-events-none">
        <div style={rise(f, 20, { dist: 24 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block mb-3">
            04 · The Shift
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white leading-[1.1]">
            Close the laptop.
          </h2>
          <p className="text-2xl text-white/70 font-normal mt-2">
            The work keeps going.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 5: Finger Press (0:14–0:18 · Bars 7–9 · 240 frames) ──────────── */
function SceneFingerPress() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/finger-press.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-transparent" />
      <div className="absolute inset-0 flex flex-col justify-end p-16 pointer-events-none">
        <div style={rise(f, 20, { dist: 24 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block mb-3">
            05 · Autonomous
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white leading-[1.1]">
            Work that starts without asking.
          </h2>
          <p className="text-xl text-white/70 font-normal mt-2">
            Your laptop is not invited.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 6: Company As Code (0:18–0:28 · Bars 9–14 · 600 frames) ───────── */
function SceneCompanyAsCode() {
  const f = useFrame();
  const lift = interp(f, 0, 80, 0, 1, ease.outCubic);
  return (
    <div className="absolute inset-0 bg-black overflow-hidden">
      <Footage
        src={`${AD_MEDIA}/light-waking.mp4`}
        className="absolute inset-0 size-full object-cover opacity-60"
      />
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />

      <div className="absolute inset-0 grid grid-cols-12 items-center gap-12 px-16 pointer-events-none">
        <div className="col-span-6 space-y-6" style={rise(f, 20, { dist: 30 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block">
            06 · Company As Code
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white leading-tight">
            A company, <br />
            <span className="text-white/60">written down.</span>
          </h2>
          <p className="text-lg text-white/70 font-normal leading-relaxed">
            Not another empty chat box. Your agents, their skills, company memory, and access rules
            — structured, versioned, and owned outright.
          </p>
          <div className="flex items-center gap-3 font-mono text-xs text-white/50 pt-2">
            <span className="px-2.5 py-1 rounded bg-white/10 border border-white/10">agents/</span>
            <span className="px-2.5 py-1 rounded bg-white/10 border border-white/10">skills/</span>
            <span className="px-2.5 py-1 rounded bg-white/10 border border-white/10">memory/</span>
            <span className="px-2.5 py-1 rounded bg-white/10 border border-white/10 text-white/80">kortix.yaml</span>
          </div>
        </div>

        <div
          className="col-span-6 flex justify-center"
          style={{
            opacity: interp(f, 30, 90, 0, 1, ease.outQuad),
            transform: `translateY(${(1 - lift) * 40}px)`,
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-neutral-950/90 shadow-2xl p-6 font-mono text-xs leading-relaxed text-neutral-300">
            <div className="flex items-center gap-2 pb-4 mb-4 border-b border-white/10 text-neutral-500">
              <span className="size-2.5 rounded-full bg-neutral-700" />
              <span className="size-2.5 rounded-full bg-neutral-700" />
              <span className="size-2.5 rounded-full bg-neutral-700" />
              <span className="ml-2 text-neutral-400">northwind / kortix.yaml</span>
            </div>
            <div className="space-y-1">
              <div><span className="text-neutral-500">agents:</span></div>
              <div className="pl-4"><span className="text-neutral-400">operations-lead:</span></div>
              <div className="pl-8"><span className="text-neutral-500">connectors:</span> <span className="text-white">[gmail, stripe, slack]</span></div>
              <div className="pl-8"><span className="text-neutral-500">skills:</span> <span className="text-white">[reconcile-ledger, sync-crm]</span></div>
              <div><span className="text-neutral-500">triggers:</span></div>
              <div className="pl-4"><span className="text-neutral-400">- type:</span> <span className="text-white">cron (&quot;0 3 * * *&quot;)</span></div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 7: Keys Drawer (0:28–0:34 · Bars 14–17 · 360 frames) ──────────── */
function SceneKeys() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/keys-drawer.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-black/50" />
      <div className="absolute inset-0 flex flex-col justify-end p-16 pointer-events-none">
        <div style={rise(f, 20, { dist: 24 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block mb-3">
            07 · Connectors
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white leading-tight">
            Every tool your company runs on. <br />
            <span className="text-white/60">None of the keys.</span>
          </h2>
          <p className="text-xl text-white/70 font-normal mt-3 max-w-2xl leading-relaxed">
            Gmail, Stripe, Slack, Notion. Connected directly through scoped tokens.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 8: Cloud Compute Grid (0:34–0:40 · Bars 17–20 · 360 frames) ────── */
function SceneComputeGrid() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/vertical-lights.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-black/45" />
      <div className="absolute inset-0 flex flex-col justify-end p-16 pointer-events-none">
        <div style={rise(f, 20, { dist: 24 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block mb-3">
            08 · Cloud Workstations
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white leading-tight">
            Thousands of computers. One main.
          </h2>
          <p className="text-xl text-white/70 font-normal mt-3 max-w-2xl leading-relaxed">
            Isolated cloud microVMs with persistent Drives. The credential never travels.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 9: Hand on Button (0:40–0:46 · Bars 20–23 · 360 frames) ───────── */
function SceneHandButton() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black flex items-center justify-center">
      <Footage
        src={`${AD_MEDIA}/hand-button.mp4`}
        className="absolute inset-0 size-full object-cover opacity-45"
      />
      <div className="absolute inset-0 bg-black/60" />

      <div className="relative z-10 w-full max-w-3xl space-y-8 px-8 pointer-events-none">
        <div className="text-center space-y-3" style={rise(f, 15, { dist: 20 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block">
            09 · The Gate
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white">
            Nothing merges itself.
          </h2>
          <p className="text-lg text-white/70 font-normal">
            It can propose. It cannot decide. Every change is a diff you review.
          </p>
        </div>

        {/* Diff card */}
        <div
          className="rounded-2xl border border-white/20 bg-neutral-950/95 p-6 shadow-2xl font-mono text-sm space-y-4"
          style={rise(f, 40, { dist: 24 })}
        >
          <div className="flex items-center justify-between pb-3 border-b border-white/10 text-xs text-neutral-400">
            <span>change-request #418 · invoice-reconciliation</span>
            <span className="px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              verified 24 items
            </span>
          </div>

          <div className="space-y-1.5 text-xs py-2">
            <div className="text-neutral-500 font-sans text-xs pb-1">reconciliation.yml</div>
            <div className="bg-rose-950/40 text-rose-300 px-3 py-1 rounded">
              - reconcile_status: manual_review
            </div>
            <div className="bg-emerald-950/40 text-emerald-300 px-3 py-1 rounded">
              + reconcile_status: auto_approved
            </div>
          </div>

          <div className="pt-3 border-t border-white/10 flex items-center justify-between">
            <span className="text-xs text-neutral-400 font-sans">
              Author: <strong className="text-white font-mono">invoice-clerk</strong>
            </span>
            <div className="px-6 py-2 rounded-lg font-sans text-sm font-medium bg-white text-black">
              Approve & Merge
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 10: Green Payoff (0:46–0:50 · Bars 23–25 · 240 frames) ────────── */
function SceneGreenPayoff() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black flex items-center justify-center">
      <Footage
        src={`${AD_MEDIA}/green-line.mp4`}
        className="absolute inset-0 size-full object-cover opacity-60"
      />
      <div className="absolute inset-0 bg-black/55" />

      <div className="relative z-10 w-full max-w-3xl space-y-8 px-8 pointer-events-none">
        <div className="text-center space-y-3" style={rise(f, 10, { dist: 16 })}>
          <span className="font-mono text-xs text-emerald-400 uppercase tracking-widest block">
            10 · Governed Outcome
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white">
            Approved &amp; Merged.
          </h2>
          <p className="text-lg text-white/70 font-normal">
            Zero hallucinations in production.
          </p>
        </div>

        <div
          className="rounded-2xl border border-emerald-500/30 bg-neutral-950/95 p-6 shadow-[0_0_50px_rgba(123,227,164,0.15)] font-mono text-sm space-y-4"
          style={rise(f, 20, { dist: 20 })}
        >
          <div className="flex items-center justify-between pb-3 border-b border-white/10 text-xs text-neutral-400">
            <span>change-request #418 · merged to main</span>
            <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-medium">
              ✓ main updated
            </span>
          </div>

          <div className="pt-3 flex items-center justify-between">
            <span className="text-xs text-neutral-400 font-sans">
              Merged by: <strong className="text-white font-sans">You</strong>
            </span>
            <div className="px-6 py-2 rounded-lg font-sans text-sm font-medium bg-emerald-400 text-black shadow-[0_0_30px_rgba(123,227,164,0.6)]">
              ✓ Merged
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 11: Morning Relief (0:50–0:55 · Bars 25–27.5 · 300 frames) ────── */
function SceneMorningRelief() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black">
      <Footage
        src={`${AD_MEDIA}/morning-light.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-black/45" />
      <div className="absolute inset-0 flex flex-col justify-end p-16 pointer-events-none">
        <div style={rise(f, 20, { dist: 24 })}>
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-widest block mb-3">
            11 · Morning Relief
          </span>
          <h2 className="text-5xl font-medium tracking-tight text-white leading-tight">
            Wake up to finished work.
          </h2>
          <p className="text-xl text-white/70 font-normal mt-3 max-w-xl">
            It works while you sleep. It answers when you ask. You start your day with results, not backlogs.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ── Scene 12: End Card Featuring Official Logo Animation (0:55–1:00 · Bars 27.5–30 · 300 frames) ── */
function SceneEndCard() {
  const f = useFrame();
  return (
    <div className="absolute inset-0 bg-black flex items-center justify-center overflow-hidden">
      <Footage
        src={`${AD_MEDIA}/dosco-logo-animation.mp4`}
        className="absolute inset-0 size-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-transparent pointer-events-none" />

      <div
        className="relative z-10 flex flex-col items-center justify-end h-full pb-14 text-center select-none pointer-events-none"
        style={rise(f, 20, { dist: 20 })}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`${AD_MEDIA}/dosco-crest.png`}
          alt="Dosco Crest"
          className="size-16 object-contain mb-3 drop-shadow-[0_0_24px_rgba(255,60,0,0.65)]"
        />
        <h1 className="text-5xl font-medium tracking-tight text-white">
          Dosco Tek
        </h1>
        <p className="text-lg text-neutral-300 font-normal mt-2 max-w-lg leading-relaxed">
          The harness that powers companies that run agents.
        </p>
        <span className="font-mono text-sm text-neutral-400 tracking-wider mt-3">
          dosco.live
        </span>
      </div>
    </div>
  );
}

/* ── Main Film Root: All Shots Pre-Buffered ───────────────────────────────── */
function ProductAdFilm() {
  return (
    <>
      <Shot from={bars(0)} dur={bars(2)} enter="cut" exit="push">
        <SceneCursor />
      </Shot>
      <Shot from={bars(2)} dur={bars(1.5)} enter="push" exit="push">
        <SceneClock />
      </Shot>
      <Shot from={bars(3.5)} dur={bars(1.5)} enter="push" exit="push">
        <SceneCoffee />
      </Shot>
      <Shot from={bars(5)} dur={bars(2)} enter="push" exit="push">
        <SceneLaptopClosed />
      </Shot>
      <Shot from={bars(7)} dur={bars(2)} enter="push" exit="push">
        <SceneFingerPress />
      </Shot>
      <Shot from={bars(9)} dur={bars(5)} enter="settle" exit="push">
        <SceneCompanyAsCode />
      </Shot>
      <Shot from={bars(14)} dur={bars(3)} enter="push" exit="push">
        <SceneKeys />
      </Shot>
      <Shot from={bars(17)} dur={bars(3)} enter="push" exit="push">
        <SceneComputeGrid />
      </Shot>
      <Shot from={bars(20)} dur={bars(3)} enter="settle" exit="push">
        <SceneHandButton />
      </Shot>
      <Shot from={bars(23)} dur={bars(2)} enter="push" exit="push">
        <SceneGreenPayoff />
      </Shot>
      <Shot from={bars(25)} dur={bars(2.5)} enter="push" exit="settle">
        <SceneMorningRelief />
      </Shot>
      <Shot from={bars(27.5)} dur={bars(2.5)} enter="settle" exit="cut">
        <SceneEndCard />
      </Shot>
    </>
  );
}

/* ── Frame-Exact Cues ────────────────────────────────────────────────────── */
const cues: Cue[] = [
  { frame: 10, sfx: 'tick', gain: 0.4 },
  { frame: bars(2), sfx: 'tick', gain: 0.45 },
  { frame: bars(3.5), sfx: 'tick', gain: 0.4 },
  { frame: bars(5), sfx: 'whoosh', gain: 0.5 },
  { frame: bars(7), sfx: 'click', gain: 0.6 },
  { frame: bars(9), sfx: 'impact', gain: 0.8 },
  { frame: bars(9) + 40, sfx: 'typing', gain: 0.35 },
  { frame: bars(14), sfx: 'whoosh', gain: 0.5 },
  { frame: bars(17), sfx: 'tick', gain: 0.45 },
  { frame: bars(20), sfx: 'whoosh', gain: 0.45 },
  { frame: bars(23), sfx: 'click', gain: 0.9 },
  { frame: bars(23) + 6, sfx: 'chime', gain: 0.85 },
  { frame: bars(25), sfx: 'whoosh', gain: 0.4 },
  { frame: bars(27.5), sfx: 'impact', gain: 0.7 },
];

export const productAdFilm: FilmDef = {
  slug: 'product-ad',
  title: 'Dosco Tek — Product Ad',
  description:
    'Dosco Tek: the harness that powers companies that run agents. A 60-second commercial crafted for businesses seeking autonomous agent execution with full human governance.',
  frames: bars(30), // 30 bars = 60 seconds
  Film: ProductAdFilm,
  cues,
  score: {
    bars: 30,
    sections: [
      [0, 'intro'],
      [5, 'groove'],
      [9, 'reveal'],
      [20, 'break'],
      [25, 'lift'],
      [27.5, 'end'],
    ],
    cycle_from: 5,
    risers: [[9, 2], [20, 2], [27.5, 1.5]],
    impacts: [[9, 0.8], [27.5, 0.7]],
  },
  audio: '/media/ad/audio.m4a',
  chapters: [
    { frame: bars(0), label: '01 The Void' },
    { frame: bars(2), label: '02 Decisions' },
    { frame: bars(3.5), label: '03 Late Night' },
    { frame: bars(5), label: '04 Close The Laptop' },
    { frame: bars(7), label: '05 Autonomous' },
    { frame: bars(9), label: '06 Company As Code' },
    { frame: bars(14), label: '07 None Of The Keys' },
    { frame: bars(17), label: '08 Cloud Compute' },
    { frame: bars(20), label: '09 The Gate' },
    { frame: bars(23), label: '10 Approved & Merged' },
    { frame: bars(25), label: '11 Morning Relief' },
    { frame: bars(27.5), label: '12 Dosco Tek Logo' },
  ],
};
