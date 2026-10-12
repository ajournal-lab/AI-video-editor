# ReelSmith

Local, voice-first video editor driven by Claude. Upload or record a voiceover → **faster-whisper** transcribes it with word timings → scenes are split and matched to **your own clips and photos** → you get a first cut in a **multi-track timeline editor** with captions, transitions, text, music ducking, **Enhance** (stabilise, denoise, sharpen, exposure/white balance, colour match), AI edit commands and versions → export an MP4 from a **Python/ffmpeg worker** that matches the in-browser preview.

Everything runs on your machine, CPU only. There are no paid APIs and no API keys: every AI step is a headless **Claude Code** job (`claude -p`) on your Claude subscription, run by the **agent runner**.

```
browser ──upload──► ./storage                                        ┌──────────── worker (Python) ───────────┐
   │                                                                  │ polls Postgres (FOR UPDATE SKIP LOCKED)│
   ├─ POST /api/projects/:id/voice ─► VoiceTrack(status=queued) ─────►│ faster-whisper → words + timings       │
   ├─ GET /api/projects/:id (poll) ◄─ transcribed → first cut         │                                        │
   ├─ editor: timeline JSON ⇄ autosave, versions                      │                                        │
   └─ POST /renders ─► TimelineVersion + RenderJob(queued) ──────────►│ timeline JSON → ffmpeg filter graph    │
                                                                      │ (+ per-clip Enhance) → MP4             │
   AI edit / Enhance / self-check                                     └────────────────────────────────────────┘
   └─ AgentJob(queued) ─────► agent runner (npm run agent) ─► claude -p in REEL_STUDIO_DIR (skills + rules.md)
          ▲ SSE log tail          one job at a time, tool allowlist, writes JSON results into storage/studio/<project>/
          └───────────────────── results validated (zod), resumed with the errors if invalid
```

## Stack

| Piece | What |
|---|---|
| Web | Next.js 15 (App Router), Tailwind v4, shadcn/ui (Radix), zustand |
| DB | Postgres via Prisma |
| Auth | Auth.js v5, email + password (bcrypt), JWT sessions |
| AI | Claude Code, headless (`claude -p --output-format stream-json`) on your subscription, via `agent/runner.ts` |
| Transcription | faster-whisper in the worker (word-level timestamps) |
| Visuals | your uploads (matched by file-name tags) → gradient card; manual Gemini quick-import for images |
| Enhance | `worker/enhance.py`: numpy analysis + ffmpeg vidstab / hqdn3d / nlmeans / unsharp / colour curve |
| Preview | `<canvas>` compositor driven by the timeline JSON (`src/components/editor/preview`) |
| Render | Python worker builds an ffmpeg filter graph from the same JSON (`worker/render.py`), captions/text via ASS + libass |
| Storage | local `./storage` folder (the R2 driver is still in the code but unused in local-only mode) |

## Requirements

- **Windows 10 or 11**, 64-bit, 8 GB RAM or more, about 6 GB free disk (plus space for your media). No GPU needed: everything runs on the CPU.
- **A Claude Pro or Max subscription**, logged in to **Claude Code**. ReelSmith never uses an API key.
- Installed by `setup.bat` if missing (through winget): **Node.js 22+**, **Python 3.11+**, **ffmpeg** (gyan.dev *full* build: it needs vid.stab, libvmaf, zscale and libass), **Git**.
- **PostgreSQL** 14+: a local install (the [EDB installer](https://www.postgresql.org/download/windows/) or `winget install PostgreSQL.PostgreSQL.17`), Docker Desktop, or any hosted Postgres URL.
- Downloaded by `setup.bat`: npm and Python packages, the [video-use](https://github.com/browser-use/video-use) skill, HyperFrames, the Whisper `base` model (~140 MB), the background-matte model (~15 MB) and Real-ESRGAN (~45 MB, optional).

## Install (Windows)

1. **Get the code** into a folder whose path has no spaces, for example `C:\ReelSmith\app`:
   ```powershell
   git clone https://github.com/anagha0601/AI-video-editor.git C:\ReelSmith\app
   ```
   (Or download the ZIP from GitHub and extract it there.)
2. **Install Claude Code and log in with your subscription** (skip this if `claude` already works):
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   claude            # then type /login and pick "Claude account with subscription"
   ```
   Don't set `ANTHROPIC_API_KEY`. If you do, Claude Code bills the API instead of your subscription.
3. **Database.** Pick one:
   - **Local PostgreSQL.** Install it, then run this once in an **Administrator** PowerShell from the ReelSmith folder:
     `powershell -ExecutionPolicy Bypass -File .\scripts\setup-local-db.ps1`. It creates the `reelsmith` role and database that the default `DATABASE_URL` expects.
   - **Docker Desktop.** Start Docker. Setup runs `docker compose up -d db` (port 5433) when it can't reach the default database.
   - **Hosted Postgres** (Neon, Supabase, …). Run setup once so it creates `.env`, paste your URL into `DATABASE_URL`, then run setup again.
4. **Run `setup.bat`** (double-click it, or run it in a terminal). It:
   - creates `.env` from `.env.example` with this computer's paths and a fresh `AUTH_SECRET`
   - installs whatever is missing (Node, Python, ffmpeg, Git) and adds ffmpeg to your PATH
   - creates `worker\.venv` and installs the Python packages
   - runs `npm ci`
   - creates the data folders (default `%USERPROFILE%\ReelSmith\studio`, `\style` and `\storage`; `C:\ReelSmith\…` if your user folder has a space in it)
   - sets up the Claude workspace: `rules.md`, `CLAUDE.md`, `tools\`, the `edit-reel` skill, and the `video-use` skill (cloned at a pinned commit)
   - caches HyperFrames, downloads the Whisper, matte and Real-ESRGAN models
   - checks the database and runs `prisma db push`
   - checks that Claude Code is installed and logged in with a subscription

   It ends with a **PASS / WARN / FAIL checklist**, which is also saved to `logs\setup.log`. Fix any FAIL items and run it again: it's safe to re-run, and it keeps your `.env` values and your `rules.md`.

   Options: `setup.bat -DataDir D:\ReelSmith` (data somewhere else), `-SkipUpscaler` (no Real-ESRGAN download), `-CheckOnly` (report only, change nothing).

## First run

1. Double-click **`start.bat`**. It opens three windows and then http://localhost:3000:
   - **web**: `npm run dev`
   - **agent runner**: `npm run agent`, which runs every Claude job
   - **worker**: `worker\.venv\Scripts\python worker\main.py`, which handles transcription and renders
2. **Sign up** with any email and password. The account only exists in your local database.
3. Dashboard → **Try a sample project**. It opens a bundled narration in the editor. Press **Export** to check that the worker renders.
4. Open **Claude** in the editor's top bar → **Run self-check**. It checks that the runner can start Claude Code, stream its log, stay inside the tool allowlist and validate the result.
5. Put a few reels whose style you like in the `STYLE_DIR` folder. Claude reads them when it plans an edit.
6. Start a real project: upload clips or a voiceover, pick a mode and approve the plan.

To stop ReelSmith, close the three windows.

## Troubleshooting

| Problem | Fix |
|---|---|
| `setup.bat` closes immediately or says scripts are disabled | Run it from a terminal: `powershell -ExecutionPolicy Bypass -File setup.ps1` |
| `node`, `python` or `ffmpeg` "not recognized" right after setup installed it | Open a **new** terminal (winget's PATH change only reaches new windows), then run setup again |
| `python` opens the Microsoft Store | Settings → Apps → Advanced app settings → App execution aliases → turn off `python.exe` and `python3.exe`, then run setup again |
| ffmpeg FAIL: "lacks vidstabdetect/libvmaf/zscale" | You have an "essentials" or other build. `winget uninstall Gyan.FFmpeg.Essentials`, then `winget install Gyan.FFmpeg` (the full build) |
| PostgreSQL connection FAIL | Check that the PostgreSQL service is running (`services.msc`), run `scripts\setup-local-db.ps1` as Administrator, or set `DATABASE_URL` in `.env` |
| `prisma db push` warns about data loss | An update changed the schema. Back up first, then run `npx prisma db push` yourself and confirm |
| Banner "Claude Code is not logged in" / "not a Claude subscription" | In a terminal, run `claude`, then `/login`, and choose the subscription account. If it says `authMethod` is an API key: `claude auth logout`, then log in again |
| Banner "ANTHROPIC_API_KEY is set" | Remove it from Windows environment variables (and from `.env`). ReelSmith strips it from its own runs anyway |
| "Agent runner offline" banner | The **agent runner** window isn't running. Start it with `npm run agent` |
| Uploads never transcribe / exports stay queued | The **worker** window isn't running, or it crashed. Read its window, then start it again: `worker\.venv\Scripts\python worker\main.py` |
| Claude job fails with "permission denied" on a path | A data folder path contains spaces. Re-run `setup.bat -DataDir C:\ReelSmith` and move your data |
| Whisper download fails with 401 | A stale Hugging Face token is cached. Delete `%USERPROFILE%\.cache\huggingface\token` (ReelSmith already sets `HF_HUB_DISABLE_IMPLICIT_TOKEN=1`) |
| "Music from a link" fails | `worker\.venv\Scripts\python -m pip install -U yt-dlp` (sites change often). Instagram `/reels/audio/` pages don't work: use a `/reel/` link that uses the sound |
| AI upscale is very slow | Real-ESRGAN runs on any Vulkan GPU, including integrated graphics; the official build has no CPU mode. On an Intel UHD 620 it takes about 4 min per frame at 4x, so the app shows an estimate first. Skip it for long clips |
| Background removal says the model is missing | Run setup again, or download `rvm_mobilenetv3_fp32.onnx` (see LICENSES.md) into `worker\models\` |
| Port 3000 in use | Close the other app, or run `npx next dev -p 3001` and open that port |

The full log of the last setup run is `logs\setup.log`. Claude job logs are in `STORAGE_DIR\studio\<project>\jobs\`.

## Running without the scripts (any OS)

```bash
npm ci
cp .env.example .env              # set DATABASE_URL, AUTH_SECRET, REEL_STUDIO_DIR, STYLE_DIR, STORAGE_DIR
npx prisma db push
python -m venv worker/.venv && worker/.venv/bin/pip install -r worker/requirements.txt
# copy workspace/ to REEL_STUDIO_DIR (replace {{REELSMITH_DIR}} and {{REEL_STUDIO_DIR}}), then clone
# https://github.com/browser-use/video-use into REEL_STUDIO_DIR/.claude/skills/video-use
npm run dev                               # terminal 1
npm run agent                             # terminal 2
worker/.venv/bin/python worker/main.py    # terminal 3
```

**Claude workspace.** Headless runs start in `REEL_STUDIO_DIR`. Its template is `workspace/` in this repo, and it holds:
- `rules.md`, applied on every run, and `CLAUDE.md`
- `tools/`: `transcribe_local.py`, `enhance.py` and the optional `realesrgan/` upscaler
- the skills in `.claude/skills/`: `video-use` (cloned from github.com/browser-use/video-use) and `edit-reel`

On startup the runner checks that Claude Code is installed, that it's logged in with a subscription (`claude auth status`), and that the skills are present. The app shows a banner when any of these fails.

## Environment variables

| Variable | Needed by | Description |
|---|---|---|
| `DATABASE_URL` | web, worker, runner | Postgres URL, e.g. `postgresql://user:pass@localhost:5432/reelsmith` |
| `AUTH_SECRET` | web | Auth.js secret (`npx auth secret`); also signs local upload URLs |
| `REELSMITH_DIR` | runner, tools | This checkout (set by setup) |
| `REEL_STUDIO_DIR` | web, runner, worker | Claude Code workspace (skills, `rules.md`, tools). Set by setup; fallback `%USERPROFILE%/ReelSmith/studio` |
| `STYLE_DIR` | runner | Reference reels Claude may read for style. Set by setup; fallback `%USERPROFILE%/ReelSmith/style` |
| `CLAUDE_MODEL`, `CLAUDE_BIN` | runner | Optional model override; path to `claude.exe` if auto-detection fails |
| `PYTHON_BIN` | web, runner | Python that runs `worker/enhance.py` and yt-dlp. Setup sets it to the worker venv |
| `REALESRGAN_BIN`, `REALESRGAN_MODEL`, `REALESRGAN_GPU` | enhance | AI upscale backend (see Enhance). Default: `REEL_STUDIO_DIR/tools/realesrgan`, the first Vulkan device (`REALESRGAN_GPU` picks another) |
| `ANTHROPIC_API_KEY` | — | **Leave unset.** It would bill the API instead of your subscription; the runner strips it and warns |
| `STORAGE_DIR` | web, worker, runner | Uploads, projects, renders, caches. Set by setup; fallback `./storage` |
| `MATTE_MODEL` | worker | RobustVideoMatting ONNX model (default `worker/models/rvm_mobilenetv3_fp32.onnx`) |
| `WHISPER_MODEL` | worker | `tiny`, `base` (default), `small`, `medium`, `large-v3` |
| `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE` | worker | Default `auto` / `int8` |
| `WEB_URL` | worker | Where to fetch relative media URLs (e.g. `/sample/voice.m4a`) when not on local disk |
| `FFMPEG_BIN`, `FONTS_DIR`, `X264_PRESET`, `WORKER_POLL_SECONDS` | worker | Optional overrides |
| `X264_PRESET`, `EXPORT_CRF`, `EXPORT_RC`, `EXPORT_KBPS` | worker | Export encode: preset `slow`, CRF `17`; `EXPORT_RC=2pass` uses two-pass at `EXPORT_KBPS` (default 17000) |
| `CREATOR_DIR` | web, runner | Creator profiles (teardowns). Default `REEL_STUDIO_DIR/creator-profiles` |
| `CLOUD_RENDER_TOKEN` | runner, web | Fine-grained GitHub token for "Render in cloud" (the private render repo only). Optional; the feature is off by default |
| `TEARDOWN_SCENE` | teardown | ffmpeg scene score that counts as a cut (default 0.22) |
| `PREVIEW_SHORT`, `PREVIEW_KBPS`, `PREVIEW_AUDIO` | worker | Phone preview encode: 720 px short side, 1400 kbit/s, AAC 96k |
| `INSERT_PARALLEL`, `INSERT_CPU_BUSY` | worker | Animated inserts built at once (default 2), and the CPU % above which they build one at a time (default 70) |

## Using the editor

- **Timeline**: video/overlay tracks, voice, music, text and captions. Drag to move (across tracks too), drag edges to trim, snapping to clip edges, the playhead and word boundaries (magnet button), Ctrl/⌘ + wheel to zoom.
- **Shortcuts**: Space play/pause · S split (selected clips, or everything under the playhead) · Del delete · Shift+Del ripple delete · ⌘/Ctrl+Z undo · ⌘/Ctrl+Shift+Z (or Ctrl+Y) redo · ⌘/Ctrl+D duplicate · ←/→ step one frame (Shift: 1 s).
- **Ripple delete** closes the gap on that track. On the **voice** track it removes that time range from the whole video, so visuals and captions stay in sync.
- **Trim silences** (Audio tab) removes every pause longer than 0.7 s (adjustable) from the whole timeline.
- **Captions** are derived from the voice clips + transcript, so they follow every trim, split, speed change and silence cut. Word edits are stored per word id.
- **Chat** (first tab): see *Chat* below. **AI edits** (AI edit tab): your command becomes a Claude job, and you see its live log. Claude reads a summary of the timeline and writes `ai-edit.json` with high-level operations, which are validated. `replace_visual` is resolved to clips from your library. The browser applies the ops to a copy, shows a summary + JSON-patch diff and previews it in the player. Apply = one undoable step. Follow-up commands resume the same Claude session.
- **Enhance** (Enhance tab): see below.
- **Versions**: named snapshots, restore (as an undoable change, with an automatic "before restore" snapshot), duplicate as a new project. Every render snapshots its exact timeline as a version, so the render history always shows what was exported.

## Claude jobs

Every AI step is an `AgentJob` row. The agent runner (`npm run agent`, `agent/runner.ts`) executes them one at a time.

**How a job runs**
- It runs `claude -p --output-format stream-json` in `REEL_STUDIO_DIR` with `--permission-mode dontAsk` and an explicit tool allowlist:
  - read anywhere
  - write only in the project folder, `storage/studio/<project>/`
  - Bash only for ffmpeg/ffprobe, the workspace's tools and skills, and scripts Claude writes in `edit/scripts/`
- `--setting-sources project` and `--strict-mcp-config` keep your global settings and connectors out of headless runs.
- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and the Bedrock/Vertex/base-URL variables are removed from the child environment, so runs use your subscription. The runner shows the login method and plan.

**Results and logs**
- Claude writes its answer to a JSON file in the project folder. The runner validates it against `src/agent/schemas.ts`. If it doesn't match, the runner resumes the same session with the errors, up to 2 times. The app reads only that file, never the chat.
- The full stream-json log is saved to `storage/studio/<project>/jobs/<job>.ndjson` and streamed to the browser over SSE.
- **Jobs** in the header lists every job. Cancel kills the whole process tree.
- Local command jobs (`exec`, e.g. an AI upscale) use the same queue, log and cancel.

**Self-check:** **Claude** in the editor's top bar → *Run self-check* tests the runner end to end (spawn, streaming, allowlist, schema validation, cancel). It probes every media file in the project with ffprobe.

## Chat (prompt-driven editing)

Every project has a **Chat** panel: the first tab in the editor, and the sidebar on the plan screen. Type what you want, e.g. "make a 30s reel in the style of @creator, cut the pauses, add captions, punchy zooms". ReelSmith turns it into workflow steps:

| Step | What runs | Where it lands |
|---|---|---|
| `edit` | timeline ops (captions, zooms, text, transitions, cut pauses, …) | applied in the editor as **one undoable step** ("Chat: …"), on editable tracks |
| `cut` | stage 1, the spoken cut (a plan job) | the plan screen to review |
| `style` | stage 2, the style pass + key stills | applied to the timeline, then the stills to approve |
| `stills` / `render` | key stills / a local export | the chat and the export list; renders only after the stills are approved |
| `teardown` | a creator profile (see Creators) | the Creators page |
| `taste_rule` | a proposed rule ("always…", "never…") | a **Save as taste rule** button in the reply |

- **One conversation per project.** The chat turn, the cut, its revisions, the style pass and taste-rule wording all resume the project's single Claude session (`projectSession()` in `src/server/agent.ts`), so later instructions build on earlier ones. Progress streams live in the panel.
- **Quick chips:** Cut pauses · Add captions · Apply creator style (pick a profile) · Show stills · Render. Cut pauses, Add captions, Show stills and Render run without Claude. Add captions still goes to Claude when a taste rule about captions applies.
- **Timestamped corrections:** a message with several lines like `Around 0:18, cut the breath` is parsed (`src/lib/chat/fixes.ts`), shown as "N timestamped fixes → one rebuild", and applied as **one** revision. Times are reel times: the cut table on the plan screen has a **Reel** column. On a cut under review, fixes alone skip the chat turn and go straight to one plan revision.
- **Start in the chat:** on the New edit page, turn on *Start in the chat*. The project opens on its chat, and your first message starts the cut.
- Server: `src/server/chat.ts` (`chat/<job>.json` = `{reply, actions}`, schema `chat`). API: `GET/POST/PATCH /api/projects/:id/chat`.

## Two-stage approval

1. **Stage 1 · the spoken cut only.** Last take wins on repeated lines, and pauses and fillers are removed (the talking-head/best-take plan modes). Approve it on the plan screen, or send changes and timestamped fixes in the chat.
2. **Stage 2 · the style pass.** It combines the creator's `style.json`, your taste rules, the brand kit and the defaults into timeline ops (job kind `style`, schema `style-pass`). The editor applies them as one undoable step. Then `worker/stills.py` renders **key stills** with the export engine: the hook, caption moments, text cards, transitions and a zoom hit. They appear in the chat panel. **Approve stills** unlocks rendering. A note under a still sends all the notes as one style revision.
3. **Render gate:** after a style pass, `POST /renders` (and the chat's Render) return 409 until the stills are approved. If the timeline changed after approval, the export dialog warns but lets you render. Projects that never had a style pass render as before.

A style pass requested before the cut is approved, or picked on the New edit page as a Creator style, starts on its own once the cut is approved. If its creator's teardown is still running, it waits for that too. State: `Project.pipeline` (`src/server/pipeline.ts`). API: `GET/POST /api/projects/:id/pipeline` (actions `style`, `style_applied`, `stills`, `approve_stills`, `fix_stills`, `gate`), `GET /api/projects/:id/stills?file=`.

## Creators (creator teardown)

**Creators** in the header. *New creator profile* takes a handle and 5 TikTok / YouTube Shorts links, checked live: supported site, public and reachable (yt-dlp metadata only). Instagram links get a warning and a suggestion to use the TikTok/Shorts version. You can also take the creator's latest 5. Notes are optional ("I like their captions and pacing"). **Analyse** queues two runner jobs:

1. `worker/teardown.py` (local command, free): it downloads each video with yt-dlp, transcribes it with faster-whisper, finds cuts (ffmpeg scene detection, plus frame-difference jump cuts), measures shot lengths, the first 2 and 3 s, words per minute, the hook words, pauses, punch-in cuts and smooth zooms (frame-scale matching), audio onsets and cuts on a sound cue, and estimates whether there's a music bed. It also writes contact sheets and one key frame per category (hook, captions, zoom, cut, layout, ending). Progress per video (downloading → transcribing → measuring → done) goes to `progress.json`. One bad link doesn't sink the others. A failed download retries with a progressive format and can be retried or swapped from the page.
2. A Claude job (heavy) reads the measurements and sheets and writes `style.json` (schema `creator-style`) and `teardown.md`. ReelSmith then adds the **consistency check** across the videos to both files. A number outside the tolerance around the median, or a category that differs from most videos, is labelled **MISMATCH**. "Varied" means no two videos agree.

The results page has these tabs:
- **Summary** cards: hook style, seconds between cuts, the first 2 seconds, captions (font feel, size, position, words on screen, colours), zoom pattern, visuals/overlays, sound cues, layout, structure.
- **Consistency:** each video with a ✅ match / ⚠️ MISMATCH badge and the reasons. **Replace video** re-measures only that video, then re-analyses.
- **Side by side:** the key frames of every video per category.
- **Edit style:** sliders and dropdowns for pace, zoom strength, caption size/position, SFX frequency and so on. The measured version is kept as `style.measured.json`, and *Reset to measured* restores it.
- **Teardown:** `teardown.md`, rendered.
- **Your overrides:** your taste rules and the creator values they replace.

**Manage profiles:** rename (projects that use the profile follow), duplicate, delete, re-analyse with new links, export/import as a `.zip` of `teardown.md` + `style.json`.

**Use a profile:** the *Creator style* dropdown on the New edit page (every mode; it guides the plan and runs the stage-2 style pass after approval), the chat's *Apply creator style* chip, or "in the style of @handle" in the chat. Edits show the creator they use: a badge on the project card and "Style: @handle" in the editor.

Files: `<CREATOR_DIR>/<handle>/` (default `REEL_STUDIO_DIR/creator-profiles`). Every Claude run can read this folder.

API (`src/server/creators.ts`):

| Method | Path | |
|---|---|---|
| GET | `/api/creators` | profiles with status, summary, video count, mismatches |
| POST | `/api/creators` | `{handle, urls: 5 links \| null (latest 5), platform?, notes?}` → starts the teardown |
| POST | `/api/creators/validate` | `{url}` → `{ok, level: ok\|warn\|error, site, message, title, uploader, durationSec}` |
| POST | `/api/creators/import` | multipart `file` (.zip), optional `handle` |
| GET / DELETE | `/api/creators/:handle` | detail (meta, jobs, progress, verdicts, overrides, style, measured style, teardown.md, measurements) / delete |
| POST | `/api/creators/:handle/{rerun,cancel,replace,rename,duplicate,style,reset}` | re-analyse `{urls?, notes?}` · stop · `{videoId \| "", url}` replace or add one video · `{to}` · `{to}` · `{style}` save edits · back to measured |
| GET | `/api/creators/:handle/export` | the zip |
| GET | `/api/creators/:handle/file?path=` | sheets, frames, videos, transcripts inside the profile |

No third-party teardown plugin is used. I couldn't find the ai-editor@nextwork plugin in any marketplace or repo, so I couldn't check its licence, and this feature is built from ReelSmith's own tools.

## Taste rules and style priority

**Priority when rules conflict: your taste rules > the client's brand kit (Settings) > the creator's style.json > defaults.**

- **Taste rules** live in `rules.md` under `## Taste rules (override creator style)` as `T<n>. (date) [topic] rule`. Every Claude run reads them.
- **Save as taste rule:**
  - in the export dialog, under each finished render: write what you liked or disliked, and Claude (a light step) turns it into one reusable rule. You edit it, then save it to rules.md.
  - from a chat reply that proposes one ("always…", "never…").
- `src/lib/style/layers.ts` resolves every topic (caption style/case/font/colours/position, pacing, zooms, hook, sound effects) across the layers and lists each conflict with the winning layer. The style pass gets this table and reports its own conflicts. The chat panel shows **Which rule won**, and a creator page shows **Your overrides**.

## AI engine

Every AI step (chat, planning, the style pass, teardowns, taste-rule wording) runs `claude -p` on your **Claude subscription**. There is no other engine and no engine setting. If a run hits the subscription's usage limit, it fails with the reset time and the runner holds further Claude jobs until then. Local command jobs (matte, upscale, teardown measuring) are unaffected.

## Render in cloud (GitHub Actions)

**Off by default**, and it never runs without your click and confirmation. Turn it on in Settings, set an **existing private** repo (`owner/name`), and add `CLOUD_RENDER_TOKEN` to `.env`. Use a fine-grained token for that repo only, with Contents, Actions and Workflows read/write and Metadata read; billing read is optional and shows your free minutes. ReelSmith never creates repos and refuses public or internal ones.

1. Export dialog → **Render in cloud…** prepares the bundle **locally**: the timeline version with its media paths rewritten, the media it uses, the render engine (`worker/*.py`), the fonts, and a workflow file. It also checks the repo is private. Nothing has left the machine yet.
2. A confirmation dialog lists the repo (verified private), every media file and its size, the total, and your remaining free Actions minutes when GitHub reports them, plus a **Keep uploads** switch (default off). **Upload and render** is the only way forward; the start call needs a one-time token from step 1 (15 min).
3. The runner job (`agent/cloud-render.ts`) checks the repo is private once more, then:
   - uploads the bundle as one commit on a temporary branch `reelsmith-render/<id>`, whose own workflow runs `worker/cloud_entry.py` on `ubuntu-24.04` with apt ffmpeg
   - follows the run (steps, progress)
   - downloads the artifact into the project as a normal export with its quality report
   - deletes the branch, the run (with its logs), the artifact (retention 1 day anyway) and the local bundle. Keep uploads skips the GitHub deletions.
4. If it is cancelled or fails mid-way, the export dialog offers **Clean up leftovers on GitHub**. Deleted branches leave unreachable git objects until GitHub's own garbage collection.

Files over 95 MB, or bundles over 900 MB, are refused (GitHub's blob limit): render those locally. A chat "render" is always local.

## Enhance

Per-clip fixes, applied before the single final encode. CPU only.

The engine is `worker/enhance.py`. The render worker, the editor previews and the edit-reel skill all use it (`REEL_STUDIO_DIR/tools/enhance.py` is a wrapper). The defaults and limits are listed in `rules.md` → "Enhance defaults", and in `D` at the top of `enhance.py`.

1. **Analyse clips** (Enhance tab) queues a Claude job. Claude runs `enhance.py analyze`, which:
   - measures every clip:
     - exposure percentiles
     - white balance from neutral pixels
     - noise (Immerkaer sigma)
     - sharpness (edge acutance)
     - camera jitter, by phase correlation on the four corner tiles, so a moving body isn't counted as shake
   - proposes fixes:
     - stabilise: two-pass vidstab with optzoom, using the gentlest setting (least crop) that cuts the jitter
     - denoise: noisy clips only, hqdn3d, or nlmeans in low light
     - sharpen: light luma unsharp after scaling
     - exposure/contrast/white balance: levels, then gamma, then per-channel gains, shrunk until skin hue moves less than 2°
     - match: pulls every clip toward the group's brightness and balance
   - runs the self-check on enhanced frames and steps down any fix that fails it:
     - halo pixels around edges
     - texture and skin detail kept (no smear)
     - skin hue shift and new clipped highlights
     - stabilisation shake reduction, black borders and crop

   Claude then looks at each before/after sheet (full frame plus aligned 1:1 crops), adjusts any fix that looks wrong, and writes `enhance.json`.
2. **Review each clip.**
   - Pick a clip to see a **before/after split preview** (drag the line, or enlarge it). `enhance.py frame` renders it at the placed size with exactly the render's filters.
   - Each fix has a **toggle**, plus a strength or amount slider where it applies.
   - Use *Apply all proposals*, or apply clip by clip. Every change is one undoable step.
3. **The render applies `clip.enhance` in this order:**
   1. vidstabtransform (pass 1 runs on the exact trimmed input and is cached in `storage/cache/vidstab`)
   2. retiming
   3. denoise
   4. colour curve (`lutrgb`)
   5. the clip's own filters
   6. scale
   7. unsharp

   The canvas preview shows the colour fixes live (as an SVG table). The other fixes only show in the before/after preview.
4. **AI upscale** (sources under 1080 wide) uses Real-ESRGAN.
   - *Estimate upscale time* benchmarks the backend on part of one frame, then asks before running.
   - The upscale runs as a local job on the agent runner, chunk by chunk, into an intermediate file. The render reads that file instead of the source.
   - `setup.bat` installs `realesrgan-ncnn-vulkan` into `REEL_STUDIO_DIR/tools/realesrgan/` (or set `REALESRGAN_BIN`). The official build needs a Vulkan device (integrated graphics work); it has no CPU mode, so ReelSmith lets it pick the device. Measured on an Intel UHD 620 laptop: about 230 s per frame for 576×1024 → 4x, so 2 s of video ≈ 4 hours. Use it for short shots only.

## Music from a link

Audio panel → **Music from a link**:

1. **Paste a link**:
   - an Instagram `/reel/` link
   - a YouTube or Shorts link
   - a direct audio file URL (mp3, wav, m4a, ogg, …)

   Instagram `/audio/` pages are rejected with a hint: open a reel that uses the sound and copy its `/reel/` link.
2. The server downloads it:
   - links go through yt-dlp
   - direct files go through a guarded download (public addresses only, 80 MB cap)
   - nothing over 15 minutes, and no live streams
3. It converts the audio to a 48 kHz stereo WAV and analyses it:
   - beat grid and drop with edit-reel's `beats.py`
   - loudness and true peak with ffmpeg `ebur128`
4. The **clipper** opens. It shows the waveform with beat markers (brighter on each bar) and the detected drop in red. In it you can:
   - drag the start/end handles (snap to beat on by default), or type start/end
   - play or loop the selection with its fade-in/fade-out
   - use *Around the drop* to select 4 beats before the drop
5. **Use this clip** puts exactly that section on the music track. The clip keeps `link: {url, kind, start, end}`.
6. **Rights:** link-sourced audio is **timing only / personal use** until you tick *I have the rights* (`MediaAsset.meta.rights`). Export warns and asks before rendering a timeline that includes uncleared link audio.
7. **Hand-off:** the Export dialog shows the source link and the second the sound starts at, so you can trim the same sound in Instagram.

The panel also has **Gemini** (opens gemini.google.com in a new tab) and **Copy prompt**, which copies a "suggest 5 trending Instagram audios" prompt with your niche, mood, title and length. The main navigation has the same two buttons. Niche and mood are remembered in the browser.

## Audio master (every export)

The render writes the mix as a 32-bit float WAV, so nothing clips before mastering. `worker/audio_master.py` then:

1. measures the mix and every source (`ebur128`, true peak)
2. normalises with two-pass `loudnorm` to **-14 LUFS**
3. runs a 4× oversampled limiter so the true peak stays **≤ -1 dBTP** (it re-runs with more headroom if the AAC encode overshoots)
4. encodes AAC 192k / 48 kHz once and muxes it with the untouched video stream

The result is saved on the render (`RenderJob.report.audio`). The Export dialog shows LUFS, true peak and "clipping fixed" when a source or the mix went over -1 dBTP.

## Video quality (export pipeline)

`worker/render.py` + `worker/color.py`, defaults in `rules.md` → "Render defaults".

1. **Colour.** Every source is converted to SDR bt709 (tv range) right after decoding (`color.source_chain`):
   - HDR (HLG/PQ, bt2020, iPhone Dolby Vision 8.4): linearised, gamut-mapped and tone-mapped with mobius (transition 0.15)
   - Display P3, bt601/smpte170m and full-range sources: converted with zimg
   - untagged sources: guessed by size

   Enhance analysis, its before/after previews and the edit-reel skill's `build.py` use the same function, so what Enhance measures is what gets encoded.
2. **One scale.** The conversion and the scale to the placed size are one `zscale` call (lanczos; in linear light for HDR).
   - Stabilised clips are converted at the source size, stabilised, then scaled once.
   - Clips are placed on the frame with pad/crop in YUV. Overlays blend in YUV, and RGB-only filters (Enhance curve, colour filters, looks) convert with explicit bt709 matrices.
   - Punch-ins are capped at what the source resolution allows.
3. **Frame rate.** A timeline built from a plan uses the sources' own rate (`src/server/probe.ts`):
   - duration-weighted and snapped to a standard rate, max 60
   - iPhone variable-rate slow-mo counts as 30
   - mixed rates are conformed once by the `fps` filter
4. **One lossy encode.**
   - The filter graph writes a lossless master (`master.mkv`, x264 -qp 0) and a float WAV.
   - `encode_final()` makes the export from the master: H.264 High, yuv420p, bt709 tags, CRF 17 preset slow, keyframe every 2 s, `+faststart`. `EXPORT_RC=2pass EXPORT_KBPS=17000` switches to two-pass.
   - The audio is mastered and encoded once (see Audio master).
   - Real-ESRGAN upscale intermediates are lossless too.
5. **Quality check** (`worker/quality.py render_check`, saved on `RenderJob.report.quality`). It runs on every render and shows pass/fail in the Export dialog and in Claude → self-check. It checks:
   - VMAF ≥ 93 (min frame ≥ 80) and SSIM ≥ 0.985 of the export vs the lossless render of the same edit
   - H.264 High yuv420p at the frame size
   - bt709 tags
   - HDR sources tone-mapped
   - fps and exact frame count
   - duplicated frames at normal speed (variable-frame-rate sources and slow-mo are named)
   - upscaled clips
   - encode count
   - bitrate, AAC 48 kHz and faststart

**Audit tools** (CPU, local):
- `npx tsx --require ./scripts/lib/no-server-only.cjs scripts/audit-timelines.ts <source> <dir> [music]` builds every mode's timeline from one source with the real mode builders.
- `python scripts/audit_quality.py <dir> <out> --label after` renders them. Per clip it reports VMAF/SSIM/PSNR(Y,Cb,Cr) for processing (master vs a source reference), encode (export vs master) and total, plus frame sheets.
- `python scripts/audit_enhance.py <out> <videos…>` checks that Enhance doesn't degrade clean clips.

## Looks (Cinematic Warm)

Talking head and Best take have a **Look** picker on the new-edit page (Natural / Cinematic Warm, intensity slider). On approve the look is set on every clip (`clip.grade = {look, intensity}`). Per clip, the Inspector → Look changes it, and *Apply to all clips* copies it everywhere.

Cinematic Warm (`worker/grade.py`) is:
- a gentle S-curve with soft, lifted blacks and a soft highlight roll-off
- teal/neutral shadows and warm highlights
- background colours desaturated by up to 25%
- skin hues protected from the desaturation and most of the split tone (measured skin hue shift: 1.6° at 100%)
- a subtle vignette

How it is applied:
- **Render:** a 33³ 3D LUT (`lut3d`) at the placed size, after Enhance and the clip's colour filters, plus a frame-fixed vignette mask.
- **Preview:** the canvas mirrors the tone curve and the vignette. It approximates the skin protection with a global saturation cut.

## Versions and phone preview

- **Every render is a numbered version** (`v1`, `v2`, …, `TimelineVersion.number`) with **notes**: what changed since the previous version (`src/lib/timeline/changes.ts`: length, added/removed/moved/trimmed clips, captions, looks, inserts, effects) plus what you asked in the chat meanwhile. Notes are editable.
- Top bar → **Versions** → *Renders*: each version's thumbnail, notes, status; play its phone preview inline; **Restore** (saves a "before restore" snapshot first, undoable); **MP4**; duplicate as a new project. Tick two versions → **Compare**: both play in sync (one play/seek control), each with its notes, plus a fresh diff between them. *Snapshots* holds the named manual versions.
- **Phone preview:** after the export is mastered, the worker writes a 720p, ~1.4 Mbit/s copy (`RenderJob.previewUrl`) before the slower quality check finishes, so it shows up first. The Export dialog has *Preview*; Versions → **Phone** shows a QR code of `http://<this PC's Wi-Fi address>:<port>/m/<token>`, a page (no login, the token is the key; *New link* revokes it) listing your latest previews with their version and notes. The phone must be on the same Wi-Fi; allow Node.js through Windows Firewall on private networks if it doesn't open.

## Audio safety

- **Auto-duck:** every music clip ducks under the voice (`timeline.audio.autoDuck`, on by default) unless its *Lower under the voice* switch is off. The level is the Music panel's "Music level under voice".
- **Sound effects** (short sounds: ≤ 8 s, or marked *Sound effect* in the Inspector) never duck. Each one stays at least **6 dB under the voice** (`audio.sfxHeadroomDb`). Every render measures the voice (integrated loudness of the voice clips) and each SFX (loudest 400 ms momentary loudness at its clip volume) with `worker/audio_safety.py`. A louder SFX is turned down by the difference + 0.5 dB in that export and **flagged** in the render report ("1 sound effect louder than voice − 6 dB · turned down").

## Animated inserts (engine; the Inserts panel comes later)

`worker/inserts.py` draws full-frame transparent VP9 layers with Pillow: an app screen in a phone sliding up behind you, a Follow CTA a cursor taps, a scrolling document, a UI demo with cursor and click ripples, and your reels orbiting you (a layer behind and a layer in front of you). They build as `InsertJob`s in the worker's **insert pool** (`worker/insert_pool.py`), in parallel with renders: 2 at a time, 1 while a render runs or the CPU is over 70%. Each status (queued with the reason, building %, done, failed) is in `/api/projects/<id>/inserts`. A render whose inserts are still building first renders the layers under them (lossless `under.mkv`), waits for them ("waiting for N inserts"), then composites the rest.

## Gemini quick-import (manual, no API cost)

Generate images in your personal Gemini account and bring them into the editor:

1. **Open Gemini** (editor top bar) opens gemini.google.com in a window beside the editor.
2. **Copy prompt**, on a selected scene in the Inspector or the copy icon on a timeline clip, copies that scene's visual hint as an image prompt with the aspect ratio added (e.g. "vertical 9:16").
3. **Ctrl+V** anywhere in the editor: an image on the clipboard is uploaded (source `gemini_manual`) and replaces the selected scene's visual (or the scene under the playhead). You'll see "Image added to scene N".
4. **Drag and drop** images from a browser tab or the desktop:
   - onto a timeline clip: replaces that scene's visual
   - onto an empty spot on a track: adds a clip there
   - onto the preview: replaces the scene under the playhead

   Images dragged from a web page are downloaded by the server (`/api/media/import`: public http(s) addresses only, images only, 20 MB max).
5. Images placed on scenes get Ken Burns motion. The media library can filter by source: uploads or Gemini (manual).

## Timeline JSON schema

One JSON document per project (`Timeline.json`) is the source of truth for both the preview and the render. Types: `src/lib/timeline/types.ts`; derived math: `src/lib/timeline/derive.ts`, mirrored in `worker/timeline.py`.

```jsonc
{
  "version": 1,
  "aspect": "9:16",               // "9:16" | "16:9" | "1:1"
  "width": 1080, "height": 1920,  // design resolution; all px values use it. 720p renders scale uniformly
  "fps": 30,
  "background": "#000000",
  "duckLevel": 0.2,               // music gain while the voice speaks
  "captions": {
    "enabled": true,
    "style": "bold",              // bold | karaoke | minimal | boxed
    "y": 0.72,                    // center, fraction of frame height
    "size": 76,                   // px
    "maxWords": 4,
    "edits": { "ab12cd_7": "PRODUCTIVITY" }   // word id -> replacement ("" hides the word)
  },
  "transcripts": {                // voice asset id -> whisper words, in SOURCE seconds
    "ab12cd…": { "words": [{ "id": "ab12cd_0", "text": "Most", "start": 0.12, "end": 0.38 }] }
  },
  "tracks": [                     // listed top -> bottom; upper video tracks draw on top
    { "id": "t_…", "kind": "captions", "name": "Captions", "clips": [] },
    { "id": "t_…", "kind": "text", "name": "Text", "clips": [
      { "id": "c_…", "type": "text", "start": 0, "duration": 3, "text": "Do less,\non purpose",
        "preset": "title", "animIn": "pop", "animOut": "fade",        // none|fade|slide-up|pop / none|fade|slide-down|pop
        "style": { "font": "montserrat", "size": 120, "color": "#FFFFFF", "background": null,
                   "outline": 8, "outlineColor": "#000000", "shadow": 0, "uppercase": true, "x": 0.5, "y": 0.2 } }
    ]},
    { "id": "t_…", "kind": "video", "name": "Video", "clips": [
      { "id": "c_…", "type": "video",            // video | image | color
        "start": 0, "duration": 3.2,              // timeline seconds
        "in": 1.5, "speed": 1,                    // source in-point; source out = in + duration*speed
        "src": "https://…mp4", "assetId": "…", "thumb": "…", "name": "Scene 1 · city night",
        "srcDuration": 12.4, "srcWidth": 1080, "srcHeight": 1920, "hasAudio": true,
        "volume": 1, "muted": true, "fadeIn": 0, "fadeOut": 0,
        "transition": { "type": "crossfade", "duration": 0.5 },  // cut|crossfade|slide|zoom|flash; enters from the adjacent previous clip
        "transform": { "fit": "cover", "scale": 1, "x": 0, "y": 0 }, // cover|contain, extra zoom, center offset (fraction of frame)
        "filters": { "brightness": 1, "contrast": 1, "saturation": 1, "preset": "none" }, // none|warm|cool|bw
        "kenBurns": null,                          // images: { "direction": "in|out|left|right|up|down", "amount": 0.15 }
        "colors": null,                            // color clips: ["#from", "#to"] diagonal gradient
        "keywords": ["city", "night"], "scene": 1,
        "enhance": {                             // optional, see Enhance; each fix applies only when on
          "stabilize": { "on": true, "smoothing": 16, "maxShift": 0.03, "maxAngle": 0.01 },
          "denoise": { "on": false, "method": "hqdn3d", "strength": 0.4 },
          "sharpen": { "on": true, "amount": 0.3 },
          "color": { "on": true, "lo": 0.05, "hi": 0.95, "gamma": 1.1, "gains": [0.99, 1, 1.01] },
          "match": { "on": true, "gamma": 0.97, "gains": [1, 1, 1.02] },
          "upscale": null } }
    ]},
    { "id": "t_…", "kind": "voice", "name": "Voice", "clips": [
      { "id": "c_…", "type": "audio", "src": "…/voice.m4a", "assetId": "ab12cd…", "name": "Voiceover",
        "start": 0, "duration": 48.1, "in": 0, "speed": 1, "volume": 1, "muted": false, "fadeIn": 0, "fadeOut": 0 }
    ]},
    { "id": "t_…", "kind": "music", "name": "Music", "clips": [
      { "id": "c_…", "type": "audio", "src": "…/track.mp3", "start": 0, "duration": 48, "in": 0, "speed": 1,
        "volume": 0.5, "muted": false, "fadeIn": 0, "fadeOut": 1.5,
        "duck": true, "keyframes": [{ "t": 40, "gain": 1 }, { "t": 46, "gain": 0.2 }] }   // t relative to clip start
    ]}
  ],
  "fx": [                                         // optional beat effects on the composited picture (text stays still)
    { "type": "punch", "t": 1.602, "strength": 0.09, "duration": 0.3 },   // zoom bump: + strength * (1-u)^2
    { "type": "shake", "t": 7.523, "strength": 0.018, "duration": 0.45 }, // offset as a fraction of the frame
    { "type": "flash", "t": 7.523, "strength": 0.56, "duration": 0.28 }   // brightness added: strength * (1-u)^2
  ]
}
```

Rendering rules both sides follow:

- **Frames**: a clip covers frames `round(start*fps)` to `round(end*fps)`. Videos shorter than their clip hold the last frame.
- **Placement**: `cover` or `contain` fit × `scale`, centered, offset by `x*W`, `y*H`.
- **Color**: per channel `v*brightness*contrast + 0.5*(1-contrast)`, then a 3×3 matrix (CSS saturate × preset). Preview: SVG `feComponentTransfer` + `feColorMatrix`. Render: `lutrgb` + `colorchannelmixer`.
- **Ken Burns**: zoom window `z` at position `(fx, fy)` of the free space, from `kenBurnsAt()`. Render: `zoompan` on a 2× canvas.
- **Transitions**: the previous clip holds its last frame while the next one enters, matching ffmpeg `xfade` (`fade`, `slideleft`, `zoomin`, `fadewhite`).
- **Beat effects** (`fx`, from `src/lib/timeline/beatfx.ts`: Audio → Beat effects, and music-edit plans on approve): `fxAt()` gives zoom, offset and flash at time t (u = (t − fx.t) / duration). Preview: a canvas transform of the video layers + a `lighter` white fill. Render: after the track overlays, before the text, one `perspective` (zoom/shake, cubic, `eval=frame`, time = `(in−1)/fps`) and/or `eq=brightness` per group of overlapping effects, each `enable`d only inside its window.
- **Text**: line height = `(asc + desc) × px` from each font's OS/2 win metrics, block centered on `(x, y)`. The fonts in `public/fonts` are used by both the browser and libass.
- **Captions**: words mapped through voice clips → lines (≤ `maxWords`, ≤ N chars, break on pauses > 0.6 s and at sentence ends) → the active word is highlighted from its start until the next word starts.
- **Audio**: gain = volume × keyframes × linear fades × ducking. Ducking is the speech intervals (words, merged when gaps are < 0.6 s) with 0.25 s ramps.

## Deploy

ReelSmith is local-only. The agent runner drives Claude Code on your machine with your subscription, and the worker reads `./storage`. Run the web app, the runner and the worker on the same computer.

## Project layout

```
agent/runner.ts        Claude agent runner (npm run agent): claims AgentJobs, spawns claude -p (your subscription) / local commands, validates results
src/agent/             shared by runner + server: claude args & allowlist, binary lookup, config, result schemas, log events
src/lib/timeline/      types, derive (shared math), ops (edit operations), ai (AI ops), factory
src/components/editor/ Player (canvas preview), Timeline, panels (Media, Text, Captions, Audio, Enhance, AI, Inspector), store
src/components/agent/  job log, Claude jobs dialog, Jobs page
src/components/chat/   chat panel, stills review, "which rule won"; store.ts applies chat/style ops in the editor
src/components/creators/ Creators pages: list, form with live link checks, results (summary, consistency, side by side, style editor)
src/components/settings/ Settings: brand kit, cloud render
src/server/            prisma, storage, agent jobs, enhance, scenes, visuals, first cut, AI edit,
                       chat, pipeline (two-stage approval), style (taste rules + layers), creators, cloud, settings, renders
src/app/api/           projects (+ ai-edit, enhance), voice, timeline, versions, renders, media, uploads, agent, files
worker/                main loop, transcribe (faster-whisper), render (ffmpeg graph), enhance, ass (captions/text), timeline (mirror)
                       stills (key stills), teardown (creator measurements), cloud_entry (GitHub Actions render)
                       inserts + insert_pool (animated overlays, built in parallel), audio_safety (SFX vs voice)
src/app/m/[token]/     the phone preview page (no login)
agent/cloud-render.ts  upload -> Actions run -> download -> cleanup for "Render in cloud" (run by the runner)
workspace/             template for the Claude workspace (REEL_STUDIO_DIR): rules.md, CLAUDE.md, tools, edit-reel skill
setup.ps1, setup.bat   Windows installer with a pass/fail checklist; start.bat starts web, runner and worker
```

## License

Proprietary, all rights reserved: see [LICENSE](LICENSE). Third-party components and their licences are listed in [LICENSES.md](LICENSES.md).
