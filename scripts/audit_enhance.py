"""Does Enhance degrade clean clips? Runs enhance.py analyze on a few sources, then renders each clip
plain / with detail fixes only (denoise + sharpen) / with all proposed fixes except stabilise, and measures
VMAF + SSIM against the source reference (audit_quality.clip_reference). Colour fixes change the picture on purpose,
so the detail-only number is the one that says "no damage"; the all-fixes number is reported for completeness.

usage: python scripts/audit_enhance.py <out dir> <video> [<video> ...]
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
import audit_quality as aq  # noqa: E402
import color  # noqa: E402
import quality  # noqa: E402

ENGINE = Path(__file__).resolve().parent.parent / "worker" / "enhance.py"


def timeline_for(path, t_in, length, enh):
    c = color.probe_color(path)
    clip = {"id": "c0", "type": "video", "src": path, "name": Path(path).name, "start": 0, "duration": length, "in": t_in,
            "speed": 1, "volume": 0, "muted": True, "fadeIn": 0, "fadeOut": 0, "srcWidth": c["width"], "srcHeight": c["height"],
            "transform": {"fit": "cover", "scale": 1, "x": 0, "y": 0},
            "filters": {"brightness": 1, "contrast": 1, "saturation": 1, "preset": "none"}, "enhance": enh}
    return {"version": 1, "aspect": "9:16", "width": 1080, "height": 1920, "fps": 30, "background": "#000000", "duckLevel": 0.2,
            "captions": {"enabled": False, "style": "bold", "y": 0.7, "size": 76, "maxWords": 4, "edits": {}}, "transcripts": {},
            "tracks": [{"id": "v", "kind": "video", "name": "Video", "clips": [clip]}]}


def main():
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    vids = sys.argv[2:]
    spec = {"width": 1080, "height": 1920, "fps": 30, "clips": []}
    for i, v in enumerate(vids):
        d = color.probe_color(v)["duration"]
        t_in, ln = min(1.0, d / 4), min(5.0, d - 1.5)
        spec["clips"].append({"id": f"e{i}", "type": "video", "path": v, "in": t_in, "len": ln, "speed": 1, "placedWidth": 1080,
                              "name": Path(v).name})
    (out / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
    r = subprocess.run([sys.executable, str(ENGINE), "analyze", "--spec", str(out / "spec.json"), "--out", str(out / "analysis.json")],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(r.stdout[-3000:])
    if r.returncode != 0:
        sys.exit(r.stderr[-2000:])
    ana = json.loads((out / "analysis.json").read_text(encoding="utf-8"))
    rows = []
    for c in spec["clips"]:
        res = next(x for x in ana["clips"] if x["id"] == c["id"])
        settings = res["settings"]
        variants = {"plain": None,
                    "detail fixes (denoise+sharpen)": {k: v for k, v in settings.items() if k in ("denoise", "sharpen")},
                    "all fixes except stabilise": {k: v for k, v in settings.items() if k != "stabilize"}}
        ref = None
        row = {"clip": c["name"], "color": color.describe(color.probe_color(c["path"])),
               "proposed": {k: v for k, v in settings.items() if v and v.get("on")}}
        for name, enh in variants.items():
            tl = timeline_for(c["path"], c["in"], c["len"], enh)
            work = out / c["id"] / name.split()[0]
            master, final, *_ = aq.run_render(tl, work)
            if ref is None:
                ref = out / c["id"] / "ref.mp4"
                aq.clip_reference(tl["tracks"][0]["clips"][0], tl, 30, ref)
            row[name] = quality.compare(str(final), str(ref))
        rows.append(row)
        print(json.dumps(row, indent=1))
    (out / "enhance_results.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
