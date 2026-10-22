"""Creator teardown, step 1: download + measure (local and free: yt-dlp, ffmpeg, faster-whisper, numpy).

  python worker/teardown.py --out <creator-profiles/handle> --urls URL URL URL URL URL
  python worker/teardown.py --out <dir> --handle @someone --platform tiktok|youtube [--n 5]   (the latest 5)
  python worker/teardown.py --out <dir> --replace <video id> --urls NEW_URL                     (re-measure one video)

Progress per video (queued -> downloading -> transcribing -> measuring -> done | failed) is written to <out>/progress.json
for the Creators page. A video that fails is skipped (the others still count); fewer than 2 good videos is an error.

Writes <out>/videos/<id>.mp4 (+ .info.json), <out>/transcripts/<id>.json, <out>/sheets/<id>_*.jpg (contact sheets for
Claude to look at) and <out>/measurements.json:
  per video: duration, size, fps, cut times (ffmpeg scene detection), shot lengths, cuts in the first 3 s, words per
  minute, first spoken word, the hook (words in the first 3 s), pauses, punch-in cuts and in-shot zooms (frame-scale
  matching), audio onsets, cuts that land on a sound cue, a music-bed estimate.
Step 2 is a Claude job that reads this + the sheets and writes style.json and teardown.md; ReelSmith then adds the
consistency check across the videos (src/server/creators.ts).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

import numpy as np  # noqa: E402

from media import ffmpeg_bin, probe  # noqa: E402

SCENE = float(os.environ.get("TEARDOWN_SCENE", "0.22"))  # ffmpeg scene score that counts as a cut
FW, FH, FPS_S = 96, 170, 6.0  # frames sampled for zoom analysis (small, gray)


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- download

def listing_url(handle: str, platform: str) -> str:
    h = handle.lstrip("@")
    return f"https://www.tiktok.com/@{h}" if platform == "tiktok" else f"https://www.youtube.com/@{h}/shorts"


YTDLP = [sys.executable, "-m", "yt_dlp", "--no-progress", "--no-warnings", "--restrict-filenames"]


def list_latest(handle: str, platform: str, n: int) -> list[str]:
    """The creator's latest n video URLs (flat listing, nothing downloaded)."""
    url = listing_url(handle, platform)
    log(f"Listing the latest {n} videos of {url}…")
    proc = subprocess.run(YTDLP + ["--flat-playlist", "--playlist-end", str(n), "--print", "url", url],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    urls = [u.strip() for u in proc.stdout.splitlines() if u.strip().startswith("http")]
    if not urls:
        raise SystemExit(f"Could not list {url}: {proc.stderr.strip()[-300:] or 'no videos'}. TikTok/YouTube sometimes block "
                         "profile pages: paste 5 video links instead.")
    return urls[:n]


FORMATS = ["bv*[height<=1920][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b", "b[ext=mp4]/18/b"]  # the 2nd: a progressive file


def download_one(url: str, vids: Path) -> Path:
    """One video; YouTube sometimes answers 403 for a format, so a second try asks for a progressive file."""
    vids.mkdir(parents=True, exist_ok=True)
    err = "download failed"
    for attempt, fmt in enumerate(FORMATS):
        proc = subprocess.run(YTDLP + ["--no-playlist", "--write-info-json", "--retries", "3", "--fragment-retries", "3",
                                       "-f", fmt, "--merge-output-format", "mp4",
                                       "-o", str(vids / "%(id)s.%(ext)s"), "--print", "after_move:filepath", url],
                              capture_output=True, text=True, encoding="utf-8", errors="replace")
        lines = [l.strip() for l in proc.stdout.splitlines() if l.strip()]
        path = Path(lines[-1]) if lines else None
        if proc.returncode == 0 and path and path.exists():
            return path
        errs = [l for l in proc.stderr.splitlines() if "ERROR" in l]
        err = (errs[-1] if errs else proc.stderr.strip()[-300:] or err).replace("ERROR: ", "")
        if attempt == 0:
            log(f"  retrying with a progressive format ({err[:120]})")
            time.sleep(3)
    raise RuntimeError(err)


class Progress:
    """<out>/progress.json: one row per video, rewritten on every stage change."""

    def __init__(self, out: Path, urls: list[str], keep: list[dict] | None = None):
        self.file = out / "progress.json"
        self.rows = keep or [{"index": i, "url": u, "id": None, "title": None, "stage": "queued", "error": None} for i, u in enumerate(urls)]
        self.write()

    def set(self, i: int, **kw):
        self.rows[i].update(kw)
        self.write()

    def write(self):
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps({"updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "videos": self.rows}, indent=1), encoding="utf-8")
        os.replace(tmp, self.file)


# ---------------------------------------------------------------- measurements

def scene_cuts(path: Path) -> list[float]:
    proc = subprocess.run([ffmpeg_bin(), "-hide_banner", "-nostats", "-i", str(path), "-an", "-vf",
                           f"scale=270:-2,select='gt(scene,{SCENE})',showinfo", "-f", "null", "-"],
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    ts = [float(m.group(1)) for m in re.finditer(r"pts_time:([\d.]+)", proc.stderr)]
    out: list[float] = []
    for t in ts:  # a flash/whip can trigger several frames in a row: keep one cut per 0.2 s
        if not out or t - out[-1] > 0.2:
            out.append(round(t, 3))
    return out


def gray_frames(path: Path) -> np.ndarray:
    raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", str(path), "-an", "-vf",
                          f"fps={FPS_S},scale={FW}:{FH}:force_original_aspect_ratio=disable,format=gray",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, FH, FW).astype(np.float32)


def jump_cuts(frames: np.ndarray, scene: list[float]) -> list[float]:
    """Cuts ffmpeg's scene score misses: jump cuts / punch-ins inside one shot (same background, so a low scene
    score), found as spikes in the frame-to-frame difference of the sampled frames."""
    if len(frames) < 3:
        return []
    d = np.array([0.0] + [float(np.mean(np.abs(frames[i] - frames[i - 1]))) for i in range(1, len(frames))])
    out = []
    for i in range(1, len(d)):
        local = np.median(d[max(1, i - 6): i + 7])
        t = i / FPS_S
        if d[i] > max(5.0, 3.0 * local) and not any(abs(t - c) < 0.3 for c in scene):
            out.append(round(t - 0.5 / FPS_S, 3))  # the cut is between the two samples
    return out


def _zoomed(a: np.ndarray, s: float) -> np.ndarray:
    """Centre crop of a by 1/s, scaled back up (bilinear): what a zoom-in by s looks like."""
    h, w = a.shape
    ys = (np.arange(h) - (h - 1) / 2) / s + (h - 1) / 2
    xs = (np.arange(w) - (w - 1) / 2) / s + (w - 1) / 2
    y0 = np.clip(np.floor(ys).astype(int), 0, h - 2)
    x0 = np.clip(np.floor(xs).astype(int), 0, w - 2)
    fy = (ys - y0)[:, None]
    fx = (xs - x0)[None, :]
    a00 = a[y0][:, x0]
    a01 = a[y0][:, x0 + 1]
    a10 = a[y0 + 1][:, x0]
    a11 = a[y0 + 1][:, x0 + 1]
    return (a00 * (1 - fx) + a01 * fx) * (1 - fy) + (a10 * (1 - fx) + a11 * fx) * fy


def zoom_between(a: np.ndarray, b: np.ndarray, scales) -> tuple[float, float, float]:
    """Best zoom factor taking frame a to frame b: (scale, error at that scale, error without zoom)."""
    m = 8  # ignore the borders
    def err(x, y):
        return float(np.mean(np.abs(x[m:-m, m:-m] - y[m:-m, m:-m])))
    e1 = err(a, b)
    best = (1.0, e1)
    for s in scales:
        if s > 1:
            e = err(_zoomed(a, s), b)
        else:
            e = err(a, _zoomed(b, 1 / s))
        if e < best[1]:
            best = (s, e)
    return best[0], best[1], e1


def zoom_stats(frames: np.ndarray, cuts: list[float], duration: float):
    """Punch-in cuts (same framing, scaled) and smooth in-shot zooms."""
    punch, smooth = [], []
    cut_scales = [1.06, 1.1, 1.15, 1.2, 1.3, 1 / 1.06, 1 / 1.1, 1 / 1.15, 1 / 1.2, 1 / 1.3]
    for c in cuts:
        i = int(round(c * FPS_S))  # first sample after the cut
        if i < 1 or i >= len(frames):
            continue
        s, e, e1 = zoom_between(frames[i - 1], frames[i], cut_scales)
        if s != 1.0 and e < 0.6 * e1 and e < 14:
            punch.append({"t": c, "scale": round(s if s > 1 else 1 / s, 3), "dir": "in" if s > 1 else "out"})
    cutset = [int(c * FPS_S) for c in cuts]
    small = [1.015, 1.03, 1 / 1.015, 1 / 1.03]
    run, start = 0, None
    for i in range(1, len(frames)):
        if any(abs(i - k) <= 1 for k in cutset):
            run, start = 0, None
            continue
        s, e, e1 = zoom_between(frames[i - 1], frames[i], small)
        if s != 1.0 and e < 0.8 * e1:
            run += 1
            start = start if start is not None else i / FPS_S
            if run == 3:  # half a second of steady zooming
                smooth.append({"t": round(start, 2), "dir": "in" if s > 1 else "out"})
        else:
            run, start = 0, None
    mins = max(duration / 60, 1e-6)
    return {"punchInCuts": punch, "punchInsPerMin": round(len(punch) / mins, 1), "smoothZooms": smooth,
            "smoothZoomsPerMin": round(len(smooth) / mins, 1)}


def audio_stats(path: Path, cuts: list[float], words: list[dict]):
    raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
                         capture_output=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768.0
    if x.size < 1600:
        return {"hasAudio": False}
    hop = 160  # 10 ms
    frames = x[: x.size // hop * hop].reshape(-1, hop)
    rms = np.sqrt(np.mean(frames ** 2, axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    flux = np.maximum(0, np.diff(db, prepend=db[0]))
    thr = np.percentile(flux, 97)
    onsets = [i / 100 for i in range(1, len(flux) - 1) if flux[i] > max(thr, 6) and flux[i] >= flux[i - 1] and flux[i] >= flux[i + 1]]
    on = np.array(onsets) if onsets else np.array([-9.0])
    near = [c for c in cuts if np.min(np.abs(on - c)) <= 0.08]
    # music bed: sound in the gaps between words (speech pauses > 0.4 s) well above the noise floor
    gaps = [(a["end"], b["start"]) for a, b in zip(words, words[1:]) if b["start"] - a["end"] > 0.4]
    floor = float(np.percentile(db, 5))
    gap_db = [float(np.median(db[int(s * 100): int(e * 100)])) for s, e in gaps if int(e * 100) > int(s * 100)]
    bed = (np.median(gap_db) - floor) if gap_db else None
    T = len(db) / 100
    return {"hasAudio": True, "onsetsPerMin": round(len(onsets) / max(T / 60, 1e-6), 1),
            "cutsOnSoundCue": round(len(near) / len(cuts), 2) if cuts else None,
            "musicBedLikely": None if bed is None else bool(bed > 18), "gapAboveFloorDb": None if bed is None else round(bed, 1),
            "loudestMomentSec": round(float(np.argmax(db)) / 100, 2)}


def speech_stats(words: list[dict], duration: float):
    if len(words) < 3:
        return {"speech": False, "words": len(words)}
    gaps = [b["start"] - a["end"] for a, b in zip(words, words[1:])]
    spoken = words[-1]["end"] - words[0]["start"]
    return {"speech": True, "words": len(words), "wordsPerMin": round(len(words) / max(spoken / 60, 1e-6)),
            "firstWordSec": round(words[0]["start"], 2), "hook": " ".join(w["text"] for w in words if w["start"] < 3.0),
            "pausesOver0_3PerMin": round(sum(g > 0.3 for g in gaps) / max(duration / 60, 1e-6), 1),
            "longestPauseSec": round(max(gaps), 2), "lastWordSec": round(words[-1]["end"], 2)}


def shot_stats(cuts: list[float], duration: float):
    edges = [0.0, *cuts, duration]
    shots = np.diff(edges)
    shots = shots[shots > 0.05]
    return {"cuts": len(cuts), "cutsPerSec": round(len(cuts) / max(duration, 1e-6), 3),
            "cutsFirst3s": sum(c < 3.0 for c in cuts), "avgShotSec": round(float(np.mean(shots)), 2),
            "medianShotSec": round(float(np.median(shots)), 2), "p10ShotSec": round(float(np.percentile(shots, 10)), 2),
            "p90ShotSec": round(float(np.percentile(shots, 90)), 2), "longestShotSec": round(float(np.max(shots)), 2)}


def sheets(path: Path, vid: str, out: Path, duration: float):
    """Contact sheets for Claude: the hook (first 3 s at 4 fps) and the whole video (1 fps)."""
    out.mkdir(parents=True, exist_ok=True)
    every = max(1.0, duration / 30)
    for name, vf in ((f"{vid}_hook.jpg", "trim=0:3,fps=4,scale=180:-2,tile=6x2:padding=4"),
                     (f"{vid}_all.jpg", f"fps=1/{every:.3f},scale=150:-2,tile=6x5:padding=4")):
        subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-i", str(path), "-an", "-vf", vf, "-frames:v", "1", "-q:v", "4",
                        str(out / name)], check=False)


def key_frames(path: Path, vid: str, out: Path, duration: float, cuts: list[float], words: list[dict], zs: dict) -> dict:
    """One frame per category, for the side-by-side view: hook, captions, zoom, cut/transition, layout, ending."""
    out.mkdir(parents=True, exist_ok=True)
    mid_word = next((w["start"] + 0.1 for w in words if w["start"] > duration * 0.4), None)
    punch = zs["punchInCuts"][0]["t"] + 0.1 if zs["punchInCuts"] else (zs["smoothZooms"][0]["t"] + 0.4 if zs["smoothZooms"] else None)
    cut = next((c + 0.05 for c in cuts if c > 1.0), cuts[0] + 0.05 if cuts else None)
    picks = {"hook": 0.15, "captions": mid_word if mid_word is not None else duration * 0.45, "zoom": punch, "cut": cut,
             "layout": duration * 0.5, "ending": max(0.0, duration - 1.5)}
    frames = {}
    for cat, t in picks.items():
        if t is None or t >= duration:
            continue
        name = f"{vid}_{cat}.jpg"
        # fades and end cards are often black: step toward the middle until the frame shows something
        step = -0.8 if cat == "ending" else 0.5
        for _ in range(5):
            subprocess.run([ffmpeg_bin(), "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(path), "-frames:v", "1",
                            "-vf", "scale=360:-2", "-q:v", "4", str(out / name)], check=False)
            if not (out / name).exists() or not _dark(out / name) or not (0 < t + step < duration):
                break
            t += step
        if (out / name).exists():
            frames[cat] = {"file": f"frames/{name}", "t": round(t, 2)}
    return frames


def _dark(img: Path) -> bool:
    raw = subprocess.run([ffmpeg_bin(), "-v", "error", "-i", str(img), "-vf", "scale=32:32,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True).stdout
    return bool(raw) and float(np.frombuffer(raw, np.uint8).mean()) < 14


def measure(path: Path, out: Path, stage=lambda st: None) -> dict:
    vid = path.stem
    info_file = path.with_suffix(".info.json")
    info = json.loads(info_file.read_text(encoding="utf-8")) if info_file.exists() else {}
    pr = probe(str(path))
    duration = float(pr.get("duration") or info.get("duration") or 0)
    t0 = time.time()
    stage("transcribing")
    from transcribe import transcribe
    try:
        tr = transcribe(str(path), vid[-6:])
    except Exception as exc:  # no audio stream, or undecodable audio: measure the picture only
        log(f"  {vid}: no transcript ({type(exc).__name__})")
        tr = {"language": None, "duration": duration, "words": []}
    (out / "transcripts").mkdir(parents=True, exist_ok=True)
    (out / "transcripts" / f"{vid}.json").write_text(json.dumps(tr), encoding="utf-8")
    words = tr["words"]
    stage("measuring")
    cuts = scene_cuts(path)
    frames = gray_frames(path)
    jumps = jump_cuts(frames, cuts)
    cuts = sorted(cuts + jumps)
    sheets(path, vid, out / "sheets", duration)
    zs = zoom_stats(frames, cuts, duration)
    au = audio_stats(path, cuts, words)
    kf = key_frames(path, vid, out / "frames", duration, cuts, words, zs)
    m = {
        "id": vid, "file": f"videos/{path.name}", "url": info.get("webpage_url") or info.get("original_url"),
        "title": (info.get("title") or info.get("description") or "")[:200], "uploader": info.get("uploader"),
        "uploadDate": info.get("upload_date"), "views": info.get("view_count"), "likes": info.get("like_count"),
        "durationSec": round(duration, 2), "width": pr.get("width"), "height": pr.get("height"),
        "fps": info.get("fps"), "language": tr.get("language"),
        "cutTimes": cuts, "jumpCuts": len(jumps), **shot_stats(cuts, duration), **speech_stats(words, duration),
        **zs, **au,
        "cutsFirst2s": sum(c < 2.0 for c in cuts), "wordsFirst2s": sum(w["start"] < 2.0 for w in words),
        "soundCuesPerMin": round((au.get("cutsOnSoundCue") or 0) * len(cuts) / max(duration / 60, 1e-6), 1),
        "sheets": {"hook": f"sheets/{vid}_hook.jpg", "all": f"sheets/{vid}_all.jpg"},
        "frames": kf,
    }
    log(f"  {vid}: {duration:.1f}s, {m['cuts']} cuts (avg shot {m['avgShotSec']}s), "
        f"{m.get('wordsPerMin', '-')} wpm, {len(m['punchInCuts'])} punch-ins · {time.time() - t0:.0f}s")
    return m


NUMERIC = ["durationSec", "avgShotSec", "medianShotSec", "cutsPerSec", "cutsFirst3s", "cutsFirst2s", "wordsFirst2s", "wordsPerMin",
           "firstWordSec", "pausesOver0_3PerMin", "punchInsPerMin", "smoothZoomsPerMin", "onsetsPerMin", "cutsOnSoundCue", "soundCuesPerMin"]


def aggregate(videos: list[dict]) -> dict:
    agg = {}
    for k in NUMERIC:
        vals = [v[k] for v in videos if isinstance(v.get(k), (int, float))]
        if vals:
            a = np.array(vals, dtype=float)
            agg[k] = {"mean": round(float(a.mean()), 3), "median": round(float(np.median(a)), 3),
                      "min": round(float(a.min()), 3), "max": round(float(a.max()), 3),
                      "cv": round(float(a.std() / a.mean()), 3) if a.mean() else None}
    return agg


def run_one(url: str, i: int, out: Path, prog: Progress) -> dict | None:
    try:
        prog.set(i, stage="downloading", error=None)
        f = download_one(url, out / "videos")
        info = f.with_suffix(".info.json")
        title = json.loads(info.read_text(encoding="utf-8")).get("title") if info.exists() else None
        prog.set(i, id=f.stem, title=(title or "")[:120])
        m = measure(f, out, lambda st: prog.set(i, stage=st))
        m["url"] = m.get("url") or url
        prog.set(i, stage="done")
        return m
    except Exception as exc:  # one bad link doesn't sink the other four
        log(f"  video {i + 1} failed: {exc}")
        prog.set(i, stage="failed", error=str(exc)[:300])
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--handle")
    ap.add_argument("--platform", default="tiktok", choices=["tiktok", "youtube"])
    ap.add_argument("--urls", nargs="*")
    ap.add_argument("--n", type=int, default=5)
    ap.add_argument("--replace", help="video id to replace with the single --urls link (the other videos are kept)")
    ap.add_argument("--add", action="store_true", help="measure the single --urls link and add it (a video that failed before)")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    mfile = out / "measurements.json"

    if a.add:
        if not a.urls or len(a.urls) != 1 or not mfile.exists():
            raise SystemExit("--add needs one --urls link and an existing measurements.json")
        data = json.loads(mfile.read_text(encoding="utf-8"))
        old = out / "progress.json"
        rows = json.loads(old.read_text(encoding="utf-8"))["videos"] if old.exists() else []
        fi = next((k for k, r in enumerate(rows) if r.get("stage") == "failed"), None)  # take the failed row's place
        row = {"index": fi if fi is not None else len(rows), "url": a.urls[0], "id": None, "title": None, "stage": "queued", "error": None}
        if fi is None:
            rows.append(row)
        else:
            rows[fi] = row
        prog = Progress(out, [], keep=rows)
        m = run_one(a.urls[0], row["index"], out, prog)
        if not m:
            raise SystemExit("The video could not be measured")
        if any(v["id"] == m["id"] for v in data["videos"]):
            raise SystemExit(f"{m['id']} is already in this profile")
        data["videos"].append(m)
    elif a.replace:
        if not a.urls or len(a.urls) != 1 or not mfile.exists():
            raise SystemExit("--replace needs one --urls link and an existing measurements.json")
        data = json.loads(mfile.read_text(encoding="utf-8"))
        idx = next((k for k, v in enumerate(data["videos"]) if v["id"] == a.replace), None)
        if idx is None:
            raise SystemExit(f"video {a.replace} is not in measurements.json")
        old = (out / "progress.json")
        rows = json.loads(old.read_text(encoding="utf-8"))["videos"] if old.exists() else [
            {"index": k, "url": v.get("url"), "id": v["id"], "title": v.get("title"), "stage": "done", "error": None} for k, v in enumerate(data["videos"])]
        pi = next((k for k, r in enumerate(rows) if r.get("id") == a.replace), idx)
        rows[pi] = {"index": pi, "url": a.urls[0], "id": None, "title": None, "stage": "queued", "error": None}
        prog = Progress(out, [], keep=rows)
        m = run_one(a.urls[0], pi, out, prog)
        if not m:
            raise SystemExit("The replacement video could not be measured")
        for stale in list((out / "videos").glob(f"{a.replace}.*")) + list((out / "sheets").glob(f"{a.replace}_*")) + list((out / "frames").glob(f"{a.replace}_*")):
            stale.unlink(missing_ok=True)
        data["videos"][idx] = m
    else:
        urls = a.urls or list_latest(a.handle or "", a.platform, a.n)
        prog = Progress(out, urls)
        log(f"Measuring {len(urls)} video(s): download, transcript (faster-whisper, local), cuts, zooms, sound cues…")
        videos = [m for i, u in enumerate(urls) if (m := run_one(u, i, out, prog))]
        if len(videos) < 2:
            raise SystemExit(f"Only {len(videos)} of {len(urls)} videos could be measured: see the errors per video")
        data = {"handle": (a.handle or "").lstrip("@"), "platform": a.platform, "source": "urls" if a.urls else "profile", "videos": videos}
    data.update({"measuredAt": time.strftime("%Y-%m-%dT%H:%M:%S"), "sceneThreshold": SCENE, "aggregate": aggregate(data["videos"])})
    mfile.write_text(json.dumps(data, indent=1), encoding="utf-8")
    log(f"Wrote {mfile}")


if __name__ == "__main__":
    main()
