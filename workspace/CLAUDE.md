# reel-studio workspace

Claude Code workspace that ReelSmith ({{REELSMITH_DIR}}) drives headlessly with `claude -p`.
Skills: `.claude/skills/video-use` (editing engine, cloned from github.com/browser-use/video-use) and
`.claude/skills/edit-reel` (gym/fitness reel workflow).

## Hard constraints
- **No paid APIs, no API keys.** Never call ElevenLabs, Gemini, OpenAI, Pexels or any other keyed service.
- **Transcription is local:** use `python {{REEL_STUDIO_DIR}}/tools/transcribe_local.py <video> --edit-dir <edit>`
  (faster-whisper, CPU, int8, `small`). It writes Scribe-shaped JSON to `<edit>/transcripts/<stem>.json`, so
  video-use's `pack_transcripts.py` and `render.py --build-subtitles` work as-is. **Never run video-use's
  `helpers/transcribe.py` or `transcribe_batch.py`** — they upload audio to ElevenLabs.
- Set `PYTHONIOENCODING=utf-8` when running Python helpers (the Windows console codepage crashes on `→` etc.).
- Whisper hallucinates short words ("You", "Thank you") on silent workout clips — treat a clip with <3 words
  and low logprob as no-speech.
- CPU only (no GPU). ffmpeg (gyan.dev full build) is on PATH. Always pass `fontfile=` to drawtext; use `fontsdir=C\:/Windows/Fonts` for libass.
- Never modify or move source media. Never write inside `.claude/skills/`.
- **Before every edit, read `{{REEL_STUDIO_DIR}}/taste-checklist.md` and `{{REEL_STUDIO_DIR}}/gotchas.md`** and apply every
  active rule (R1-R7 describe how to work: feedback → rule in the user's words first, gotchas filed before moving on, fix the
  cause across the whole video, a fresh subagent checks every draft, ask when a note contradicts a rule, never delete a rule
  without asking, list the rules added when a video is finished).
- Interactive sessions write the files themselves: a new rule goes under "## Rules from your feedback" in the checklist's
  `### R<n> · title` shape (next free number, never renumber); a solved problem goes into gotchas.md as
  `### G<n> · title` with Problem / Why it happened / Fix. Headless ReelSmith runs don't edit them: ReelSmith files for them.
