# ReelSmith progress

Resume notes for the next session (after `/clear`). Nothing here is committed or pushed: **never commit or push unless the
user asks.** Last update: 2026-10-21, recovery after an interrupted session (see "Session recovery" below).

## Transcription + deterministic prep (2026-10-21, in progress)

- **Cause of the 15-minute Music edit:** the agent ran video-use's `helpers/transcribe.py` (ElevenLabs; exits 1 without a key)
  and then searched for alternatives. Gotcha G49 in `D:\reel-studio\gotchas.md`.
- **Done:** `D:\reel-studio\tools\transcribe_local.py` is the only transcriber (faster-whisper CPU int8; `small`, `medium` for
  Hindi; skips no-audio and no-speech clips; cache by SHA-256; fails fast). The old edit-reel `transcribe.py` and the two
  ElevenLabs helpers moved to `D:\reel-studio\archive\2026-10-21-transcribers\`. edit-reel SKILL.md points at the new one.
  Tested: sample speech clip 107 words in 24 s (cold), silent clips skipped in 0.3 s, cached re-run < 0.1 s per clip.
- **Done:** `worker/prepare.py` runs before every plan job (`startPlan` queues it as a `prep` exec job; the plan job has
  `afterJobId` set to it). It probes files, transcribes clips with speech, writes `edit/transcript.json` (old format kept),
  `edit/transcript.txt`, `edit/music.json` (beats cached by hash in `storage/cache/beats`) and `edit/prep.json` with step
  timings and `lowRes` per file. Tested: cold 39.6 s, cached rerun 3.1 s. `modes.ts` prompts now read the precomputed files
  and no longer tell the agent to transcribe or run beats. `tsc --noEmit` passes.
- **Not done:** the UI warning for low-resolution clips (< 720 wide; `prep.json` has the flag); the timed re-run of the 9-second
  Music edit (needs a real edit run in the app); the agent-side guard against searching for scripts (the prompt forbids it, but
  nothing enforces it); a clearer error in the UI when prep fails (the plan job says "Skipped", the prep job holds the error).
- **Next (orchestrator plan, phase a):** orchestrator + agent framework + resource queue (max 3 Claude calls, 1 heavy job,
  pause heavy jobs below 1.5 GB free RAM) + agents panel. Whisper: faster-whisper installed in the worker venv (1.2.1),
  `small` and `medium` models cached; one Whisper job at a time. Then phases (b)–(d) as listed in the request.
- Production run: the user wants `next build` + `next start` when only using the app (not developing). Needs more free RAM than
  the dev server; not switched yet (0.86 GB free at the time).

## Session recovery (2026-10-21)

- Interrupted state found: a large uncommitted rework (rules page, chat, creators, cloud render, inserts, phone, workspace
  `taste-checklist.md` + `gotchas.md` replacing `rules.md`). The last edits (14:38–14:49) were the chat, rules-file and README
  updates, and all of them are complete. `tsc --noEmit` passes and all worker Python files compile.
- Fixed: `scripts/test-rules-files.ts` expected unquoted "Your words"; the writer quotes them on purpose. Test now passes.
- Studio (`D:\reel-studio`): `taste-checklist.md` and `gotchas.md` are present, `rules.md` is gone (archived).
- Services restarted: web on **:3001** (`.env` `APP_URL`), agent runner, worker. Postgres was already up on :5432.
- Phase B1 (import from a link + Google Drive + duplicate detection) was the interrupted work. Code is in place and compiles:
  `src/server/medialink.ts` (yt-dlp for YouTube/TikTok/Instagram/Vimeo/X/Drive, direct URLs), `api/media/link`, `api/media/exists`,
  sha256 dedupe in `api/media` upload, `components/media/LinkImport.tsx`. **Not tested yet** (next step: real link import
  through the UI and a re-import of the same link and file, which should return the existing asset).
- Cold start: the first `next dev` compile of `/` took about 150 s; API calls made before it finishes time out.
- The database has no Prisma migrations (schema is pushed, not migrated). `MediaAsset.hash` exists in the DB (checked 2026-10-21).
  From Git Bash, Prisma can't reach `localhost:5432`; `127.0.0.1` works. Watch for this if the web app shows DB errors.
- Still uncommitted: everything above. Nothing committed or pushed.

## How to run / test

- Postgres 18 runs as a Windows service on :5432. Web: `npx next dev -p 3001` (matches `.env` `APP_URL`; `start.bat` uses :3000).
  Worker: `worker\.venv\Scripts\python worker\main.py`. Agent runner: `npm run agent`.
- E2E: puppeteer-core + installed Chrome, test user `e2e-audio@reelsmith.local` (password is in your password manager, not in this file). The scripts used in Phase A
  live in the session scratchpad (`e2e/rs.mjs` = login + API helper + upload). Test media: 5–10 s cuts of `D:\my-project` clips.
- Phase A test projects (user e2e): "PhaseA · Best take / Voiceover + b-roll / Auto-clip" (+ 2 auto-clip shorts),
  "Chat demo: boring days (Render #…)" = versions/looks/background test (v1–v3).

## Plan

- **Phase A (done):** test what's built, fix failures. OmniRoute removed at the user's request.
- **Phase B (next, in order):** 1 import from any link (video) + Google Drive + duplicate detection by hash · 2 manual video
  clipping (in/out picker, several clips per video) · 3 look presets: apply step, picker, per-section switching from script
  and chat · 4 motion graphics with HyperFrames (kinetic hook, counters, lower-thirds, callouts, word-pop captions) as
  transparent overlays on their own track, previewed in the stills review · 5 Idea → Script (idea → trends → hook, script,
  shot list, on-screen text; uses Project.prompt) · 6 pre-render gate (media exists, graphics present, safe zones) ·
  7 background blur and fill modes.
- **Phase C (wait for the user):** templates, SFX library, split-screen, hand tracking, voice-cued effects, inserts UI,
  director notes, studio features, cloud render test.
- After each phase: update this table, README, LICENSES.md, rules.md (workspace/ and D:/reel-studio/), then this file.

## Phase A results (tested 2026-10-12)

| Test | Result | Notes / fixes made |
|---|---|---|
| Regression: re-render old versions with the new render code | **Pass** | Music + talking head pixel-identical (PSNR ∞). **Fixed** a regression I had introduced (gradient "color" clips rendered black) and an old bug: ffmpeg `gradients` was random per run (now `seed=1`) |
| Best take | **Pass** | 3 × 8 s takes → plan in 3 min → 15.7 s render, quality pass |
| Voiceover + b-roll | **Pass** | 10 s voice + 4 b-roll → plan → 10 s render |
| Auto-clip | **Pass** | 2:43 video → 4 candidates, 2 shorts (23 s, 25 s) rendered with hook text |
| Quick-action chips | **Pass** | Cut pauses + Captions (instant ops), Stills (job done), Creator style @jeffnippard (style job done, ops auto-applied on open), Render |
| Timestamped corrections | **Pass** | 3 fixes in one message → parsed (0:02, 0:09, 13s) → one Claude turn → one edit (zoom punch, LAST REP card, fade) → Apply in the editor saved all three |
| Waveform trim | **Pass after fix** | Uploaded tracks never got a beat grid in the clipper: now analysed on open (6 s). Short sounds clipped there are now marked SFX |
| style.json save | **Pass** | Edit → saved on disk with the consistency check kept → reloads (restored afterwards) |
| Background replace | **Pass** | Matte (RVM, 28.8 s source in ~5 min on CPU) + image background → v3 render |
| Enhance | **Pass after fix** | Analysis job proposed gamma lifts, stabilise off (subject motion); render with settings OK. **Fixed:** it analysed the looks' cut-out copies too (now skipped) |
| AI upscale | **Works, impractical here** | Real-ESRGAN wasn't installed (installed now). **Fixed:** `-g -1` (CPU) is rejected by the official build, which has no CPU mode; it now picks the Vulkan device (Intel UHD 620). Estimate: 247 s/frame; one real frame 576×1024 → 2304×4096 in 3 min 48 s. The 2 s run (60 frames ≈ 4 h) was cancelled so it wouldn't block the agent queue |
| Versions | **Pass after fix** | v1→v3 numbered with notes; Compare plays both in sync with a diff; Restore v1 brings back its tracks, undoable. **Fixed** a crash in Compare (React event read inside a state updater) |
| Phone preview | **Pass after fix** | 720p 1.4 Mbit/s (2 MB vs 23 MB) ready before the quality check; `/m/<token>` plays on a phone-size viewport over the Wi-Fi IP without login; wrong token = 404. **Fixed** an old bug: the worker wrote local time into UTC columns (times 7 h off) |
| Auto-duck | **Pass** | Music with no duck setting ducks to 20% under speech; SFX not ducked |
| SFX level check | **Pass** | A 0.6 s boom 17.4 dB over the limit (voice −20 LUFS − 6) was flagged and turned down 17.9 dB; no spike in the export |
| 3 new caption styles | **Pass** | Kinetic (lowercase, beside the speaker, words appear), calm (lowercase, lower third, steps aside for the punch line), editorial (tiny spaced capitals). Preview canvas matches the render |
| Words behind the head | **Pass** | "BORING" behind the speaker via a cut-out copy track over a "behind" text track |
| OmniRoute engine switch | **Removed** | Settings section, spawn/health code, `engine`/`engineNote`/`weight` columns, README/rules mentions. Every AI step uses the Claude subscription |

## Audit table (after Phase A)

| Feature | Status | Where in the UI | Notes |
|---|---|---|---|
| Music edit / Talking head | Working and tested | New edit | |
| Best take / Voiceover + b-roll / Auto-clip | Working and tested (Phase A) | New edit | |
| Chat, chips, timestamped corrections | Working and tested | Editor → Chat | Ops that arrive while the editor is closed wait for a click on Apply |
| Idea → Script | Not started (removed in the rebuild) | – | Phase B5 |
| Import: local files | Working and tested | Media | |
| Import: video links, Google Drive, duplicate detection | Not started | – | Phase B1 |
| Manual video clipping | Partly built | Timeline trim/split | Phase B2 |
| Audio upload, link download, beats/drop | Working and tested | Audio panel | |
| Waveform trim | Working and tested (fixed) | Audio panel → ✂ | |
| Plan approval two-stage (cut, style, stills) | Working and tested | Chat / plan screen | |
| Creator teardown + style.json editor | Working and tested | Creators | Only @jeffnippard profile |
| Look presets | Partly built | – | Engine + captions + grades + cut-out + behind text tested; apply step / picker / switching = Phase B3 |
| Templates | Not started | – | Phase C |
| Motion graphics (HyperFrames) | Not started | – | Phase B4 |
| Transitions, captions (7 styles) | Working and tested | Inspector, Captions | |
| Cut-out effects (words behind head) | Working (manual timeline only) | – | Generated by looks in B3 |
| Voice-cued effects, hand tracking, SFX library, split-screen | Not started | – | Phase C |
| Background replace | Working and tested | Backdrop panel | |
| Background blur / fill | Not started | – | Phase B7 |
| HDR tone-map, single encode, VMAF | Working and tested | Export report | |
| Enhance | Working and tested (fixed) | Enhance panel | |
| AI upscale | Works; ~4 min/frame on this laptop | Enhance panel | Use for very short shots only |
| Pre-render gate | Partly built | Export | Stills approval only; Phase B6 |
| Post-render quality check | Working and tested | Export report | |
| Versions (numbered, notes, compare, restore) | Working and tested | Versions | |
| Phone preview + phone page | Working and tested | Export, Versions → Phone | Needs same Wi-Fi; firewall may prompt |
| Parallel inserts | Engine built, standalone-tested | – (no UI: Phase C "inserts UI") | Insert pool + two-stage render not yet exercised by a real render with inserts |
| Audio ducking + SFX safety | Working and tested | Inspector, Export report | No pre-render check button yet |
| Taste rules, rules.md | Working and tested | Render → Save as taste rule | |
| Director notes | Not started | – | Phase C |
| Studio: brand kit | Partly built | Settings | One kit per user; kit has look + @handle fields (no UI yet) |
| Studio: clients, onboarding, content plan, board, review, delivery, reports | Not started | – | Phase C |
| Cloud render | Built but untested | Export | Phase C |
| OmniRoute | Removed | – | |
| Setup script, README, LICENSES.md | Done; setup untested on a 2nd laptop | – | |

## Known issues / notes

- The agent runner is one queue: matte, upscale and Claude jobs wait for each other.
- Old worker-written timestamps (before 2026-10-12) are 7 h early in the UI.
- `worker/.venv` got Pillow (added to requirements.txt); `D:/reel-studio/tools/realesrgan` installed by hand (same as setup).
