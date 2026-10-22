"""Transcribe a chat voice note locally (faster-whisper, CPU) -> {"text": "..."}.

    python worker/voice_note.py <audio file> <out.json>

Run by the agent runner as a local command job (kind "voice_note"); the chat then treats the words like a typed message,
so a spoken note becomes a taste-checklist rule in the user's words (R2) before anything changes.
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from transcribe import transcribe  # noqa: E402


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    src, out = sys.argv[1], sys.argv[2]
    res = transcribe(src, "voice")
    words = [w for w in res.get("words", []) if str(w.get("text", w.get("word", ""))).strip()]
    # Whisper invents "you" / "thank you" on silence (gotchas G24): fewer than 3 words that are all unsure = no speech
    unsure = all(float(w.get("prob", w.get("probability", 1.0)) or 0) < 0.5 for w in words)
    text = "" if len(words) < 3 and unsure else " ".join(str(w.get("text", w.get("word", ""))).strip() for w in words)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"text": text, "words": len(words)}, f, ensure_ascii=False)
    print(f"[voice] {len(words)} words", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
