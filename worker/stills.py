"""Key stills of a timeline (two-stage approval, stage 2): render the edit once at low resolution with the
same engine as the export (render.build: grade, enhance, text, captions, beat effects, transitions) and grab a
JPEG at each requested moment, so the user approves what the export will look like before rendering it.

  python worker/stills.py --timeline tl.json --picks picks.json --out <dir> [--quality 540p]

picks.json: [{"t": 0.5, "kind": "hook", "label": "...", "why": "..."}]   ->   <dir>/still_00.jpg ... + <dir>/manifest.json
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))


def _load_env():
    env = Path(__file__).resolve().parent.parent / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env()

import render  # noqa: E402
import storage  # noqa: E402
from media import ffmpeg_bin  # noqa: E402
from timeline import timeline_duration  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--picks", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--quality", default="540p")
    a = ap.parse_args()

    tl = json.loads(Path(a.timeline).read_text(encoding="utf-8"))
    picks = json.loads(Path(a.picks).read_text(encoding="utf-8"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    T = max(0.5, timeline_duration(tl))
    work = Path(tempfile.mkdtemp(prefix="rs-stills-"))
    t0 = time.time()
    try:
        print(f"Rendering a {a.quality} preview of the {T:.1f}s edit for {len(picks)} stills…", flush=True)
        args, T, _audio, _ctx = render.build(tl, a.quality, lambda u: storage.fetch(u, work / "media"), work)
        proc = subprocess.run(args, cwd=work, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if proc.returncode != 0:
            raise RuntimeError("preview render failed: " + proc.stderr[-1500:])
        print(f"Preview rendered in {time.time() - t0:.0f}s, grabbing frames…", flush=True)
        manifest = []
        for i, p in enumerate(picks):
            t = min(max(0.0, float(p["t"])), max(0.0, T - 0.05))
            name = f"still_{i:02d}.jpg"
            subprocess.run([ffmpeg_bin(), "-y", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(work / "master.mkv"),
                            "-frames:v", "1", "-q:v", "3", str(out / name)], check=True)
            manifest.append({**p, "t": round(t, 3), "file": name})
            print(f"  {name}  {t:6.2f}s  {p.get('kind', '')}: {p.get('label', '')}", flush=True)
        (out / "manifest.json").write_text(json.dumps({"duration": T, "stills": manifest}, indent=1), encoding="utf-8")
        print(f"Done: {len(manifest)} stills in {time.time() - t0:.0f}s", flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
