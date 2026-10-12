# ReelSmith progress

Resume notes for the next session (after `/clear`). Nothing here is committed or pushed: **never commit or push unless the
user asks.** Last update: 2026-10-12, end of Phase A.

## How to run / test

- Postgres 18 runs as a Windows service on :5432. Web: `npm run dev -- -p 3100`. Worker: `worker\.venv\Scripts\python worker\main.py`.
  Agent runner: `npm run agent`.
- E2E: puppeteer-core + installed Chrome, test user `e2e-audio@reelsmith.local` / `e2e-demo-2026`. The scripts used in Phase A
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
