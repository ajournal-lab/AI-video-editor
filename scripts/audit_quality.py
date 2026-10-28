"""Phase 2 quality audit: where does quality drop between the source and the export?

For every mode timeline (scripts/audit-timelines.ts) it renders with the worker's render.py twice:
a lossless master (same filter graph, x264 -qp 0) and the real export. Then, per video clip, it builds a reference
straight from the source (color.source_chain: correct HDR/colour conversion + one lanczos scale, crop to the frame,
same retiming) and measures VMAF / SSIM / PSNR(Y, Cb, Cr):
  processing = master vs reference   (filter graph: scaling, colour handling, RGB round trips)
  encode     = export vs master      (the lossy encode)
  total      = export vs reference
Text, captions, grades and Enhance are stripped for the measurement (they are intended changes).

usage: python scripts/audit_quality.py <timeline dir> <out dir> [--label before|after] [--modes a,b]
"""
from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "worker"))
import color  # noqa: E402
import quality  # noqa: E402
import render  # noqa: E402
from media import ffmpeg_bin  # noqa: E402
from timeline import placement  # noqa: E402


def measurement_variant(tl):
    t = copy.deepcopy(tl)
    t["captions"]["enabled"] = False
    for tr in t["tracks"]:
        if tr["kind"] == "text":
            tr["clips"] = []
        if tr["kind"] == "video":
            for c in tr["clips"]:
                c["filters"] = {"brightness": 1, "contrast": 1, "saturation": 1, "preset": "none"}
                c["grade"] = None
                c["enhance"] = None
    return t


def run_render(tl, work: Path):
    """The worker's render: filter graph -> lossless master.mkv, then encode_final -> final.mp4."""
    work.mkdir(parents=True, exist_ok=True)
    args, T, _, ctx = render.build(tl, "1080p", lambda u: u, work)
    t0 = time.time()
    r = subprocess.run(args, cwd=work, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-1500:])
    tm = time.time() - t0
    enc = render.encode_final(work / "master.mkv", work / "final.mp4", int(tl["fps"]), T=T)
    return work / "master.mkv", work / "final.mp4", tm, time.time() - t0 - tm, enc, ctx, T


def clip_reference(clip, tl, fps, out: Path):
    src = clip["src"]
    c = color.probe_color(src)
    W, H = tl["width"], tl["height"]
    tr = clip["transform"]
    p = placement(c["width"], c["height"], W, H, tr)
    w = max(2, int(round(p["w"] / 2) * 2))
    h = max(2, int(round(p["h"] / 2) * 2))
    X = int((W - w) / 2 + tr["x"] * W)  # overlay position as render.py places it (rgba: no chroma alignment)
    Y = int((H - h) / 2 + tr["y"] * H)
    n = max(1, round((clip["start"] + clip["duration"]) * fps) - round(clip["start"] * fps))
    speed = float(clip.get("speed", 1))
    chain = color.source_chain(c, w, h) + [f"setpts=(PTS-STARTPTS)/{speed}", f"fps={fps}",
                                           f"pad=w=max(iw\\,{W}+{max(0, X)}):h=max(ih\\,{H}+{max(0, Y)}):x={max(0, X)}:y={max(0, Y)}",
                                           f"crop={W}:{H}:{max(0, -X)}:{max(0, -Y)}", f"tpad=stop_mode=clone:stop={n}",
                                           f"trim=end_frame={n}", "format=yuv420p"]
    r = subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-ss", str(clip["in"]), "-t", str(clip["duration"] * speed + 0.5),
                        "-i", src, "-vf", ",".join(chain), "-c:v", "libx264", "-qp", "0", "-preset", "ultrafast", str(out)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr[-800:])
    return round(clip["start"] * fps), n, {"src": color.describe(c), "scale": round(w / c["width"], 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tldir")
    ap.add_argument("out")
    ap.add_argument("--label", default="before")
    ap.add_argument("--modes")
    a = ap.parse_args()
    out = Path(a.out) / a.label
    out.mkdir(parents=True, exist_ok=True)
    rf = out / "results.json"
    results = json.loads(rf.read_text(encoding="utf-8")) if rf.exists() else {}
    for f in sorted(Path(a.tldir).glob("*.json")):
        mode = f.stem
        if a.modes and mode not in a.modes.split(","):
            continue
        tl = measurement_variant(json.loads(f.read_text(encoding="utf-8")))
        fps = int(tl["fps"])
        work = out / mode
        master, final, tm, tf, enc, ctx, T = run_render(tl, work)
        info = quality.stream_info(str(final))
        res = {"render_s": round(tf + tm, 1), "graph_s": round(tm, 1), "encode_s": round(tf, 1), "export": info["video"],
               "dupes": quality.duplicate_frames(str(final)), "clips": [], "encode_settings": enc}
        enc = quality.compare(str(final), str(master))
        res["encode"] = enc
        clips = [c for t in tl["tracks"] if t["kind"] == "video" for c in t["clips"] if c["type"] == "video"]
        for i, c in enumerate(clips):
            ref = work / f"ref_{i}.mp4"
            sf, n, meta = clip_reference(c, tl, fps, ref)
            proc = quality.compare(str(master), str(ref), dist_trim=(sf, n))
            total = quality.compare(str(final), str(ref), dist_trim=(sf, n))
            res["clips"].append({"clip": i, "start": c["start"], "dur": c["duration"], "speed": c.get("speed", 1),
                                 "zoom": c["transform"]["scale"], **meta, "processing": proc, "total": total})
            # a frame for the eye: reference | master | export at the clip middle
            mid = sf + n // 2
            subprocess.run([ffmpeg_bin(), "-v", "error", "-y", "-i", str(ref), "-i", str(master), "-i", str(final), "-filter_complex",
                            f"[0]select=eq(n\\,{n // 2}),scale=360:-2[a];[1]select=eq(n\\,{mid}),scale=360:-2[b];"
                            f"[2]select=eq(n\\,{mid}),scale=360:-2[c];[a][b][c]hstack=3", "-frames:v", "1",
                            str(work / f"frames_{i}.png")])
        results[mode] = res
        print(f"== {mode}: export {info['video']['codec']} {info['video']['profile']} {info['video']['pix_fmt']} "
              f"{info['video']['matrix']}/{info['video']['transfer']}/{info['video']['primaries']} {info['video']['kbps']} kbps "
              f"{info['video']['fps']} fps, render {tm:.0f}s + encode {tf:.0f}s, dupes {res['dupes']['duplicates']}")
        print(f"   encode (export vs master): VMAF {enc['vmaf']} SSIM {enc['ssim']}")
        for c in res["clips"]:
            pr, to = c["processing"], c["total"]
            print(f"   clip {c['clip']} ({c['src']}, scale {c['scale']}, zoom {c['zoom']}, speed {c['speed']}): "
                  f"processing VMAF {pr['vmaf']} SSIM {pr['ssim']} PSNR Y/Cb/Cr {pr['psnr_y']:.1f}/{pr['psnr_cb']:.1f}/{pr['psnr_cr']:.1f} | "
                  f"total VMAF {to['vmaf']} (min {to['vmaf_min']}) SSIM {to['ssim']}")
        (out / "results.json").write_text(json.dumps(results, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
