"""Cloud render entry point (GitHub Actions, "Render in cloud"). Runs inside the uploaded render bundle:

  bundle/
    timeline.json        the exact timeline version, media URLs rewritten to media/<file>
    media/               every file the timeline uses
    fonts/               the caption/text fonts
    reelsmith/           this engine (worker/*.py)
    .github/workflows/reelsmith-render.yml

  python reelsmith/cloud_entry.py --bundle . --quality 1080p --out out

Writes out/video.mp4, out/thumb.jpg and out/report.json (the same export pipeline and checks as a local render).
Also runs locally for a dry run of a bundle.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=".")
    ap.add_argument("--quality", default="1080p", choices=["720p", "1080p"])
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    bundle = Path(a.bundle).resolve()
    out = Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("FONTS_DIR", str(bundle / "fonts"))

    import render  # noqa: E402  (after FONTS_DIR is set)

    tl = json.loads((bundle / "timeline.json").read_text(encoding="utf-8"))

    def resolve(u: str) -> str:
        p = (bundle / u).resolve()
        if not str(p).startswith(str(bundle)) or not p.exists():
            raise FileNotFoundError(f"{u} is not in the bundle")
        return str(p)

    last = [-1.0]
    t0 = time.time()

    def progress(p: float):
        if p - last[0] >= 0.05:
            last[0] = p
            print(f"progress {p * 100:.0f}% ({time.time() - t0:.0f}s)", flush=True)

    work = Path(tempfile.mkdtemp(prefix="rs-cloud-"))
    try:
        video, thumb, duration, report = render.run(tl, a.quality, resolve, work, progress)
        shutil.copyfile(video, out / "video.mp4")
        if thumb:
            shutil.copyfile(thumb, out / "thumb.jpg")
        (out / "report.json").write_text(json.dumps({"duration": duration, "report": report, "seconds": round(time.time() - t0)}, indent=1), encoding="utf-8")
        print(f"done: {duration:.1f}s video in {time.time() - t0:.0f}s", flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
