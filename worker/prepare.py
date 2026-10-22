"""Deterministic prep for an edit: probe every input, transcribe the clips that have speech, detect beats on the track.

Runs as a plain command before the Claude plan job, so the agent never has to find or run these steps itself.
Writes <dir>/edit/prep.json (per-file facts, step timings) and <dir>/edit/transcript.json (the combined transcript that
speech_cuts.py and the captions read). Results are cached by the file's SHA-256:
  - transcripts: <REEL_STUDIO_DIR>/tools/transcribe_local.py (cached there per edit folder)
  - beats:       <storage cache>/beats/<sha256>.json

usage: prepare.py --dir <project folder> [--clip FILE ...] [--audio FILE ...]
Exits 1 with one clear line on stderr when a step fails. No retries.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = Path(os.environ.get("REEL_STUDIO_DIR", "D:/reel-studio"))
TRANSCRIBER = STUDIO / "tools" / "transcribe_local.py"
BEATS = STUDIO / ".claude" / "skills" / "edit-reel" / "scripts" / "beats.py"
CACHE = Path(os.environ.get("REELSMITH_CACHE", HERE.parent / "storage" / "cache")) / "beats"
timings: list[dict] = []


def fail(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def step(name: str, cached: bool = False):
    class _Timer:
        def __enter__(self):
            self.t0 = time.time()
            return self

        def __exit__(self, *exc):
            secs = round(time.time() - self.t0, 2)
            timings.append({"step": name, "seconds": secs, "cached": cached})
            print(f"[prep] {name}: {secs:.2f}s{' (cached)' if cached else ''}", flush=True)
            return False

    return _Timer()


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
                         capture_output=True, text=True)
    if out.returncode != 0:
        fail(f"ffprobe failed on {path.name}: {out.stderr.strip()[:200]}")
    data = json.loads(out.stdout)
    v = next((s for s in data["streams"] if s.get("codec_type") == "video"), None)
    a = next((s for s in data["streams"] if s.get("codec_type") == "audio"), None)
    fps = None
    if v and v.get("avg_frame_rate") not in (None, "0/0"):
        num, den = v["avg_frame_rate"].split("/")
        fps = round(float(num) / float(den), 3) if float(den) else None
    return {
        "file": str(path),
        "name": path.name,
        "kind": "video" if v else "audio",
        "duration": round(float(data["format"].get("duration", 0)), 3),
        "width": v.get("width") if v else None,
        "height": v.get("height") if v else None,
        "fps": fps,
        "hasAudio": a is not None,
        # low resolution: a WhatsApp copy or a re-encode. The UI warns and suggests the original file.
        "lowRes": bool(v and v.get("width", 0) < 720),
    }


def transcribe(clips: list[Path], edit_dir: Path) -> dict[str, dict]:
    """One transcriber call for all clips (the model loads once). Returns clip name -> Scribe-shaped JSON."""
    if not clips:
        return {}
    if not TRANSCRIBER.exists():
        fail(f"transcriber not found: {TRANSCRIBER}")
    t0 = time.time()
    cmd = [sys.executable, str(TRANSCRIBER), *map(str, clips), "--edit-dir", str(edit_dir)]
    run = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if run.returncode != 0:
        fail((run.stderr or run.stdout).strip().splitlines()[-1][:300] if (run.stderr or run.stdout).strip() else "transcription failed")
    cached_all = all("cached:" in line for line in run.stdout.splitlines() if line.strip())
    timings.append({"step": "transcribe", "seconds": round(time.time() - t0, 2), "cached": cached_all})
    print(f"[prep] transcribe: {time.time() - t0:.2f}s{' (cached)' if cached_all else ''}", flush=True)
    out = {}
    for c in clips:
        p = edit_dir / "transcripts" / f"{c.stem}.json"
        if p.exists():
            out[c.name] = json.loads(p.read_text(encoding="utf-8"))
    return out


def beats_for(audio: Path, sha: str, dest: Path) -> dict:
    """Beat grid for a track, cached by hash in the shared cache."""
    CACHE.mkdir(parents=True, exist_ok=True)
    cached_file = CACHE / f"{sha}.json"
    if cached_file.exists():
        with step("beats", cached=True):
            shutil.copyfile(cached_file, dest)
    else:
        if not BEATS.exists():
            fail(f"beat detector not found: {BEATS}")
        with step("beats"):
            run = subprocess.run([sys.executable, str(BEATS), str(audio), "--json", str(dest)], capture_output=True,
                                 text=True, encoding="utf-8", errors="replace")
            if run.returncode != 0 or not dest.exists():
                fail(f"beat detection failed for {audio.name}: {(run.stderr or run.stdout).strip()[-300:]}")
            shutil.copyfile(dest, cached_file)
    return json.loads(dest.read_text(encoding="utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--clip", action="append", default=[])
    ap.add_argument("--audio", action="append", default=[])
    a = ap.parse_args()

    t_all = time.time()
    edit = Path(a.dir) / "edit"
    edit.mkdir(parents=True, exist_ok=True)
    files = [Path(p) for p in a.clip + a.audio]
    for f in files:
        if not f.exists():
            fail(f"input not found: {f}")

    facts: list[dict] = []
    with step("probe"):
        for f in files:
            facts.append(probe(f))
    by_name = {x["name"]: x for x in facts}

    # clips with audio are candidates; the transcriber's energy check skips the silent ones without loading Whisper
    speech_candidates = [Path(x["file"]) for x in facts if x["hasAudio"] and Path(x["file"]) in map(Path, a.clip)]
    transcripts = transcribe(speech_candidates, edit)

    combined = []
    for name, data in transcripts.items():
        words = [{"word": w["text"], "start": w["start"], "end": w["end"], "prob": w.get("logprob")}
                 for w in data.get("words", []) if w.get("type") == "word"]
        by_name[name]["speech"] = len(words) > 0
        by_name[name]["words"] = len(words)
        by_name[name]["language"] = data.get("language_code")
        combined.append({"clip": name, "language": data.get("language_code"), "words": words})
    for x in facts:
        x.setdefault("speech", False)
        x.setdefault("words", 0)
        x.setdefault("language", None)
    (edit / "transcript.json").write_text(json.dumps(combined, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = []
    for c in combined:
        lines.append(f"## {c['clip']} ({c['language']})")
        lines.append(" ".join(w["word"] for w in c["words"]))
    (edit / "transcript.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    beats = None
    for audio in a.audio:
        p = Path(audio)
        sha = sha256(p)
        beats = beats_for(p, sha, edit / "music.json")
        by_name[p.name]["beats"] = {"count": len(beats.get("beats", [])), "period": beats.get("beat_period")}

    total = round(time.time() - t_all, 2)
    prep = {"files": facts, "steps": timings, "totalSeconds": total, "music": "edit/music.json" if beats else None}
    (edit / "prep.json").write_text(json.dumps(prep, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[prep] done in {total:.2f}s: {len(facts)} files, {sum(1 for x in facts if x['speech'])} with speech", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
