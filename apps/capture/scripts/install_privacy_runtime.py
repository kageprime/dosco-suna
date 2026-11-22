#!/usr/bin/env python3
"""Build/package helper: fetch a checksum-pinned official ONNX Runtime library.
No model, user data, credentials, or inference requests. Python is build-only.

The source is Microsoft's NuGet package Microsoft.ML.OnnxRuntime 1.23.2: one
archive with the native library of every platform, its LICENSE and its
ThirdPartyNotices.txt. github.com/microsoft/onnxruntime answers 404 since
2026-11-17, so its release archives are gone. NuGet never replaces a
published version's file, and the pinned SHA-256 rejects any other bytes.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import time
import urllib.request
import zipfile

ARCHIVE = "microsoft.ml.onnxruntime.1.23.2.nupkg"
ARCHIVE_SHA256 = "25fe172f7fcdf34f2b5b02c8b997f6b88abc282956849d4af4335af23d0c4e4a"
ARCHIVE_URL = f"https://api.nuget.org/v3-flatcontainer/microsoft.ml.onnxruntime/1.23.2/{ARCHIVE}"
NOTICES = ("LICENSE", "ThirdPartyNotices.txt")
# platform -> (library inside the package, file name the app loads)
ASSETS = {
    "macos-arm64": ("runtimes/osx-arm64/native/libonnxruntime.dylib", "libonnxruntime.1.23.2.dylib"),
    "macos-x86_64": ("runtimes/osx-x64/native/libonnxruntime.dylib", "libonnxruntime.1.23.2.dylib"),
    "windows-x86_64": ("runtimes/win-x64/native/onnxruntime.dll", "onnxruntime.dll"),
    "linux-x86_64": ("runtimes/linux-x64/native/libonnxruntime.so", "libonnxruntime.so.1.23.2"),
}

def digest(path):
    with path.open("rb") as file:
        hash = hashlib.sha256()
        while chunk := file.read(128 * 1024): hash.update(chunk)
        return hash.hexdigest()

def fetch(target):
    # 4 attempts, 10/30/90 s apart: a first read from the CDN can stall for
    # over 60 s (seen 2026-11-21); the next attempt took 4-7 s.
    for attempt, pause in enumerate((10, 30, 90, None), start=1):
        try:
            with urllib.request.urlopen(ARCHIVE_URL, timeout=60) as source, target.open("wb") as file:
                shutil.copyfileobj(source, file, 128 * 1024)
            return
        except OSError as error:
            if pause is None:
                raise SystemExit(f"ONNX Runtime download failed after {attempt} attempts: {error}")
            print(f"ONNX Runtime download attempt {attempt} failed ({error}); retrying in {pause} s", flush=True)
            time.sleep(pause)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=ASSETS, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    destination = args.destination.resolve()
    destination.mkdir(parents=True, exist_ok=True)
    member, library = ASSETS[args.platform]
    cache = destination / ".privacy-runtime-cache"
    cache.mkdir(exist_ok=True)
    archive = cache / ARCHIVE
    if not archive.exists() or digest(archive) != ARCHIVE_SHA256:
        temporary = archive.with_suffix(".download")
        fetch(temporary)
        if digest(temporary) != ARCHIVE_SHA256:
            temporary.unlink()
            raise SystemExit("ONNX Runtime archive checksum mismatch")
        temporary.replace(archive)
    with zipfile.ZipFile(archive) as bundle:
        names = set(bundle.namelist())
        if member not in names or not all(name in names for name in NOTICES):
            raise SystemExit("Pinned archive lacks runtime or license notices")
        with bundle.open(member) as source, (destination / library).open("wb") as target:
            shutil.copyfileobj(source, target, 128 * 1024)
        notices = [bundle.read(name).decode("utf-8", errors="replace") for name in NOTICES]
    (destination / "privacy-runtime-notices.txt").write_text("\n\n".join(notices))
    print(f"PRIVACY_RUNTIME_OK platform={args.platform} library={library} sha256={digest(destination / library)}")

if __name__ == "__main__":
    main()
