"""Audio safety: every sound effect stays at least `sfxHeadroomDb` (default 6 dB) below the voice.

Voice level  = integrated loudness (EBU R128, gated) of all voice clips at their clip volume.
SFX level    = the loudest momentary loudness (400 ms window) of each sound-effect clip at its clip volume.
A sound effect louder than voice - headroom is flagged, and the render turns it down by the difference (+0.5 dB margin).
Music is handled by ducking (timeline.clip_ducks), not here.

The render calls measure() before building the mix; the Audio panel's "Check" runs the CLI:
  python audio_safety.py check --timeline TL.json      -> JSON report on stdout
"""
from __future__ import annotations

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from media import ffmpeg_bin  # noqa: E402
from timeline import audio_safety, clip_end  # noqa: E402

MARGIN_DB = 0.5


def _num(v: float) -> str:
    return f"{v:.4f}".rstrip("0").rstrip(".")


def _chain(clip) -> str:
    ch = []
    if abs(float(clip.get("speed", 1)) - 1) > 1e-3:
        ch.append(f"atempo={_num(float(clip['speed']))}")
    ch.append("aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo")
    ch.append(f"volume={_num(float(clip.get('volume', 1)))}")
    return ",".join(ch)


def _input(clip, resolve) -> list[str]:
    return ["-ss", _num(float(clip["in"])), "-t", _num(clip["duration"] * float(clip.get("speed", 1))), "-i", resolve(clip["src"])]


def _run(args: list[str]) -> str:
    r = subprocess.run([ffmpeg_bin(), "-hide_banner", "-nostats", "-loglevel", "verbose", *args, "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return r.stderr


def voice_level(clips, resolve) -> float | None:
    """Integrated loudness of the voice clips back to back (LUFS), None when there is no voice."""
    if not clips:
        return None
    args = []
    for c in clips:
        args += _input(c, resolve)
    graph = ";".join(f"[{i}:a]{_chain(c)}[v{i}]" for i, c in enumerate(clips))
    graph += ";" + "".join(f"[v{i}]" for i in range(len(clips))) + f"concat=n={len(clips)}:v=0:a=1,ebur128[out]"
    err = _run([*args, "-filter_complex", graph, "-map", "[out]"])
    summary = err[err.rfind("Summary:"):]
    m = re.search(r"I:\s+(-?[\d.]+)\s+LUFS", summary)
    v = float(m.group(1)) if m else None
    return v if v is not None and v > -69 else None


def sfx_level(clip, resolve) -> float | None:
    """The loudest momentary loudness of one clip (LUFS). Short sounds are padded so the 400 ms window fills."""
    err = _run([*_input(clip, resolve), "-af", f"{_chain(clip)},apad=pad_dur=0.4,ebur128"])
    vals = [float(x) for x in re.findall(r"\sM:\s*(-?[\d.]+)", err)]
    vals = [v for v in vals if v > -70]
    return max(vals) if vals else None


def measure(tl, resolve) -> dict:
    """Flags + the gain (dB) to apply per sound-effect clip id."""
    cfg = audio_safety(tl)
    head = float(cfg["sfxHeadroomDb"])
    voice, sfx = [], []
    for t in tl["tracks"]:
        if t.get("muted") or t["kind"] not in ("voice", "music"):
            continue
        for c in t["clips"]:
            if c.get("muted") or c["duration"] <= 0.01 or not c.get("src") or float(c.get("volume", 1)) <= 0:
                continue
            if t["kind"] == "voice":
                voice.append(c)
            elif c.get("sfx"):
                sfx.append(c)
    out = {"headroomDb": head, "voice": None, "sfx": [], "pass": True, "fixed": False, "note": None}
    if not sfx:
        return out
    v = voice_level(voice, resolve)
    out["voice"] = round(v, 1) if v is not None else None
    if v is None:
        out["note"] = "No voice to compare the sound effects with"
        return out
    limit = v - head
    for c in sfx:
        lvl = sfx_level(c, resolve)
        row = {"id": c["id"], "name": c.get("name") or "Sound effect", "start": round(c["start"], 2),
               "end": round(clip_end(c), 2), "level": round(lvl, 1) if lvl is not None else None,
               "limit": round(limit, 1), "overDb": 0.0, "gainDb": 0.0}
        if lvl is not None and lvl > limit:
            row["overDb"] = round(lvl - limit, 1)
            row["gainDb"] = round(-(lvl - limit) - MARGIN_DB, 1)
            out["pass"] = False
        out["sfx"].append(row)
    return out


def gains(report: dict) -> dict[str, float]:
    """clip id -> linear gain that brings each too-loud sound effect under the limit."""
    return {r["id"]: math.pow(10, r["gainDb"] / 20) for r in report.get("sfx", []) if r.get("gainDb", 0) < 0}


def _load_env():
    """../.env for standalone runs (the worker passes its environment on)."""
    import os
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["check"])
    ap.add_argument("--timeline", required=True)
    a = ap.parse_args()
    _load_env()
    import storage  # noqa: E402  (reads STORAGE_DIR from the environment)
    tl = json.loads(Path(a.timeline).read_text(encoding="utf-8"))
    work = Path(tempfile.mkdtemp(prefix="rs-audiosafe-"))
    print(json.dumps(measure(tl, lambda u: storage.fetch(u, work / "media"))))


if __name__ == "__main__":
    main()
