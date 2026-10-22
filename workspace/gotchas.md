# Gotchas

Every technical problem hit while building and using ReelSmith, as Problem / Why it happened / Fix. Claude reads this file
before every edit, so a problem that was solved once is not solved again from scratch. When something breaks and gets fixed,
it is added here before moving on (headless runs write `jobs/<job id>.gotchas.json` and ReelSmith files it; a result file that
failed validation and was fixed is filed automatically). The same problem again raises its "Seen" count instead of a new entry.

Shape (the Gotchas page in ReelSmith reads it):

```
### G<n> · <short title>
- Date: <first seen> · Area: <render|import|agent|setup|editor|audio|quality|machine|...> · Status: fixed|workaround|open · Seen: <n>
- Problem: <what you saw>
- Why it happened: <the cause>
- Fix: <what fixed it, and where it lives>
```

## Render

### G1 · Render stalls near the end when it starts while its inserts are still building
- Date: 2026-10-12 · Area: render · Status: open · Seen: 1
- Problem: the two-stage render (base layer `under.mkv` first, inserts composited in a second ffmpeg pass) sat at about 82% of the
  second stage with no progress for 20 minutes. Reproduced: it stalls at 9.2 s of 10.4 s. The same command finishes when run by
  hand outside the worker.
- Why it happened: not found yet. Already ruled out: reading ffmpeg's stdout pipe line by line (progress now goes to a polled
  file) and an inherited stdin (ffmpeg now gets stdin=DEVNULL). Neither fixed it.
- Fix: workaround only. worker/render.py has a stall watchdog: ffmpeg is killed and the job fails after `RENDER_STALL_SECONDS`
  (default 180 s) without progress, instead of hanging forever. Next things to try: run the second stage in a fresh process, or
  wait for the inserts before starting the render. Until then, wait for inserts to finish before rendering.

### G2 · iPhone HDR clips came out washed out and wrong (VMAF 59)
- Date: 2026-10-02 · Area: quality · Status: fixed · Seen: 1
- Problem: renders of 4K iPhone clips looked flat and grey, with wrong colours. VMAF was 59 against a correctly tone-mapped reference.
- Why it happened: many iPhone clips are HLG / Dolby Vision 8.4 10-bit bt2020 (some Display P3). The old render didn't tone-map
  them, forced 30 fps and encoded at CRF 20 on the fastest x264 preset.
- Fix: worker/color.py probes every source; HDR is linearised, gamut-mapped and tone-mapped with mobius (transition 0.15, peak
  100) in one zscale chain; outputs are tagged bt709. VMAF went to 99.5–99.8. Taste checklist R30–R33.

### G3 · Every render failed on ffmpeg 9
- Date: 2026-10-02 · Area: render · Status: fixed · Seen: 1
- Problem: all renders failed right after the ffmpeg upgrade.
- Why it happened: ffmpeg 9 removed `-filter_complex_script`.
- Fix: the worker passes the filter graph from a file in the form ffmpeg 9 accepts, with a fallback for older builds.

### G4 · Gradient ("color") clips rendered black
- Date: 2026-10-12 · Area: render · Status: fixed · Seen: 1
- Problem: in the regression render, voiceover projects with gradient backgrounds came out black (PSNR 11 against the old export).
- Why it happened: a new rule that skips clips without a source file also skipped colour clips, which never have one.
- Fix: colour clips are exempt from that check. Lesson: re-render existing versions and compare (PSNR) after changing shared
  render code.

### G5 · Gradient backgrounds came out different on every render
- Date: 2026-10-12 · Area: render · Status: fixed · Seen: 1
- Problem: the same version rendered twice gave different gradient frames.
- Why it happened: ffmpeg's `gradients` source is random unless it is given a seed.
- Fix: `seed=1` in worker/render.py.

### G6 · The vignette blend came out green
- Date: 2026-10-02 · Area: render · Status: fixed · Seen: 1
- Problem: the Cinematic Warm vignette tinted the frame green.
- Why it happened: not recorded (found and fixed during the 2026-10-02 grade test).
- Fix: fixed in the render's vignette blend; the rendered frame was checked against the preview.

### G7 · The duplicate-frame check counted 96 frames in a 90-frame clip
- Date: 2026-10-02 · Area: quality · Status: fixed · Seen: 1
- Problem: the quality audit reported duplicated frames that weren't there.
- Why it happened: writing rawvideo forces a constant frame rate, so a variable-rate iPhone file gets padded frames.
- Fix: the counter uses passthrough timing (each decoded frame counted once, no constant-rate padding).

### G8 · Two lossy encodes in edit-reel's build.py and the upscale intermediate
- Date: 2026-10-02 · Area: quality · Status: fixed · Seen: 1
- Problem: /edit-reel shots were encoded twice (per-shot files at CRF 12, then the final), and the Real-ESRGAN intermediate was lossy.
- Why it happened: the shot cache and the upscaler wrote lossy H.264.
- Fix: intermediates are lossless (x264 -qp 0) or don't exist; one lossy encode at the end. Taste checklist R32.

## Quality of the footage

### G9 · Grainy night clips ("the quality is low")
- Date: 2026-10-02 · Area: quality · Status: fixed · Seen: 2
- Problem: the boxing reel looked grainy on the laptop and the phone. The first fix missed the last clip, and its light sharpening
  made that clip's grain more visible.
- Why it happened: dark rooms push the iPhone sensor to its limit. The HDR → SDR tone-map and the grey grind grade lift that noise,
  and sharpening an un-denoised clip amplifies it. Only the worst shot had been measured.
- Fix: denoise every noisy shot (nlmeans for dark 4K/HDR, denoise BEFORE any upscale for low-res clips), sharpen gently after,
  measure noise on every shot. WhatsApp recompresses video: check it as a document or via Drive. Taste checklist R29.

### G10 · Low-resolution clips leave no room for punch-ins or beat cuts
- Date: 2026-10-02 · Area: quality · Status: workaround · Seen: 2
- Problem: beat cuts and zoom punches were skipped or looked soft on some edits.
- Why it happened: clips 478–540 px wide (WhatsApp/Drive copies) are already stretched about 2× to fill 1080 wide.
- Fix: maxZoom caps punch-ins at the source resolution (checklist R13). Use the phone originals, not WhatsApp copies.

## Import and links

### G11 · Vimeo wants a login for most videos
- Date: 2026-10-12 · Area: import · Status: workaround · Seen: 1
- Problem: link import from vimeo.com failed with a "logged-in" / 401 error.
- Why it happened: Vimeo blocks anonymous downloads for many videos.
- Fix: src/server/medialink.ts retries with the player.vimeo.com URL automatically, which works for embeddable videos. For the
  rest, export your browser cookies to cookies.txt and set `YTDLP_COOKIES` in .env (not tested yet).

### G12 · TikTok downloads failed, even yt-dlp's own test links
- Date: 2026-10-12 · Area: import · Status: fixed · Seen: 1
- Problem: every TikTok link failed, even after updating yt-dlp.
- Why it happened: TikTok blocks plain HTTP clients.
- Fix: browser impersonation (`--impersonate`, needs the `curl_cffi` package in the worker venv); medialink.ts retries with it.

### G13 · YouTube downloads need a JavaScript runtime
- Date: 2026-10-12 · Area: import · Status: fixed · Seen: 1
- Problem: YouTube links failed or picked the wrong format.
- Why it happened: current yt-dlp needs a JS runtime to solve YouTube's player challenges.
- Fix: `--js-runtimes node` (Node is installed anyway). Keep yt-dlp up to date (setup installs the latest).

### G14 · Instagram reels were silently skipped by the 15-minute limit
- Date: 2026-10-02 · Area: import · Status: fixed · Seen: 1
- Problem: pasting an Instagram /reel/ link downloaded nothing and showed no error.
- Why it happened: Instagram doesn't report a duration, and `--match-filter "duration < 900"` rejects a missing duration.
- Fix: `duration < 900?` (the `?` lets a missing duration through).

### G15 · Instagram /reels/audio/ links don't work
- Date: 2026-10-01 · Area: import · Status: workaround · Seen: 2
- Problem: yt-dlp can't read an Instagram audio page.
- Why it happened: the audio page is not a video post; yt-dlp has no extractor for it.
- Fix: ask for a /reel/ link that uses the sound; ReelSmith rejects /audio/ links with that message. Taste checklist R26.

### G16 · Wikimedia .ogg sounds were rejected
- Date: 2026-10-02 · Area: import · Status: fixed · Seen: 1
- Problem: a direct .ogg link failed the audio download check.
- Why it happened: the content-type allowlist didn't include Wikimedia's Ogg type.
- Fix: the guarded download helper accepts it.

### G17 · Google Drive: "Cannot retrieve the public link of the file"
- Date: 2026-10-02 · Area: import · Status: workaround · Seen: 1
- Problem: gdown fetched 32 of ~100 files from a Drive folder, then refused even files it had downloaded minutes earlier.
- Why it happened: files inside a shared folder keep their own sharing setting (the .MOV originals were private), and Google
  throttles a link after repeated downloads ("many accesses") for about an hour.
- Fix: set every FILE inside the folder to "Anyone with the link", wait about an hour, or download in the browser and drop the
  files into the project's raw folder.

## Agent runner and Claude

### G18 · Result files failed validation (wrong types or values in plan.json / style.json)
- Date: 2026-10-02 · Area: agent · Status: fixed · Seen: 7
- Problem: plan jobs wrote `texts[].accent` as a string instead of true/false (3 times, 2026-10-02), `captions.style` with a value
  outside bold|karaoke|minimal|boxed (3 times, 2026-10-12), and a teardown wrote `zoomStyle` and `hooks.textOnScreen` wrong.
- Why it happened: the prompt described those fields loosely, so Claude guessed a type or a value.
- Fix: the runner resumes the session with the exact errors and Claude fixes the file (up to 2 times); the prompts list the exact
  allowed values. Every fixed validation failure is now filed here automatically.

### G19 · Claude's permission rules can't match quoted paths
- Date: 2026-10-02 · Area: agent · Status: fixed · Seen: 1
- Problem: headless runs had commands denied that should have been allowed.
- Why it happened: `--allowedTools` Bash rules can't match a quoted path, a path with spaces, `cd … &&` chains or env-var prefixes.
- Fix: data folders without spaces (C:\ReelSmith when the profile path has one), forward-slash absolute paths, one command per
  Bash call, PYTHONIOENCODING set by the runner, own Python written to edit/scripts/ (`python -c` is denied).

### G20 · ANTHROPIC_API_KEY in .env would bill the API
- Date: 2026-10-02 · Area: agent · Status: fixed · Seen: 1
- Problem: .env contained a non-empty ANTHROPIC_API_KEY.
- Why it happened: left over from the old Gemini/API setup.
- Fix: the runner deletes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from every claude child process and the app shows a warning
  banner while the key is in .env.

### G21 · Claude's usage limit is reached mid-run
- Date: 2026-10-02 · Area: agent · Status: workaround · Seen: 3
- Problem: on the Pro plan, long sessions stop with "usage limit reached"; jobs failed without saying why.
- Why it happened: the subscription's 5-hour window ran out.
- Fix: the runner detects the limit, fails the job with the reset time and holds other Claude jobs until then. Keep frame reviews
  to contact sheets, not single frames.

### G22 · Claude Code refused to run a render script written in another session
- Date: 2026-10-02 · Area: agent · Status: workaround · Seen: 1
- Problem: an interactive session wouldn't run new-reel/edit/scripts/render.py.
- Why it happened: Claude Code's safety check treats a script it hasn't reviewed as untrusted code.
- Fix: run it yourself with `! <command>` in the prompt, or add an allow rule for that scripts folder.

### G23 · video-use's transcriber uploads audio to ElevenLabs
- Date: 2026-10-02 · Area: agent · Status: fixed · Seen: 1
- Problem: video-use's `helpers/transcribe.py` needs an ElevenLabs key (a paid API).
- Why it happened: that's how video-use ships.
- Fix: `{{REEL_STUDIO_DIR}}/tools/transcribe_local.py` (faster-whisper, CPU, int8) writes the same Scribe-shaped JSON. Never run
  video-use's transcribe.py or transcribe_batch.py.

### G24 · Whisper invents words on silent workout clips
- Date: 2026-10-01 · Area: agent · Status: workaround · Seen: 1
- Problem: silent clips got "You" / "Thank you" transcripts.
- Why it happened: Whisper hallucinates short phrases on silence.
- Fix: treat a clip with fewer than 3 low-probability words as no speech.

### G25 · Model downloads fail with 401, and faster-whisper's decoder crashes
- Date: 2026-10-01 · Area: setup · Status: fixed · Seen: 1
- Problem: Whisper model downloads returned 401; transcription crashed with `metadata_errors`.
- Why it happened: an expired Hugging Face token was cached; the installed PyAV build breaks faster-whisper's own decoder.
- Fix: `HF_HUB_DISABLE_IMPLICIT_TOKEN=1` (set in worker/transcribe.py); decode audio with ffmpeg instead of PyAV.

### G26 · Python crashes printing "→" in the Windows console
- Date: 2026-10-02 · Area: setup · Status: fixed · Seen: 2
- Problem: Python helpers died with UnicodeEncodeError (cp1252 can't encode '→').
- Why it happened: the Windows console codepage isn't UTF-8.
- Fix: `PYTHONIOENCODING=utf-8` (the runner sets it), or `sys.stdout.reconfigure(encoding="utf-8")` in a script.
  Hit again on 2026-10-21 in a session script: an `export` in one shell call doesn't carry to the next one.

## Machine, servers and setup

### G27 · Background servers stopped when memory ran low
- Date: 2026-09-29 · Area: machine · Status: workaround · Seen: 9
- Problem: the dev server, worker and agent runner kept stopping for no visible reason.
- Why it happened: this laptop has 8 GB of RAM; Claude Code stops its own background tasks when memory is critically low.
- Fix: start the web app, worker and runner in your own terminals (`start.bat`), close unused tabs, or start Claude Code with
  `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`.

### G28 · The app became unresponsive and uploads "failed" while measurements ran
- Date: 2026-10-02 · Area: machine · Status: fixed · Seen: 1
- Problem: the login page took 30 s, uploads failed and an existing edit wouldn't open.
- Why it happened: three CPU-heavy measurement jobs used every core and nearly all memory, so requests timed out; an orphaned dev
  server from earlier was also still serving.
- Fix: heavy background jobs run at Idle priority (their ffmpeg children inherit it), one at a time; restart a clean dev server.

### G29 · A new dev server exits because the old one still holds port 3100
- Date: 2026-10-02 · Area: machine · Status: workaround · Seen: 3
- Problem: restarting the app "worked" but the old code (or old .env) kept running.
- Why it happened: the earlier dev server never stopped and still owned the port, so the new one exited.
- Fix: stop the process on the port first (Task Manager → Node.js, or Stop-Process on its PID), then start one fresh server.

### G30 · Can't reach the database at localhost:5433
- Date: 2026-10-02 · Area: setup · Status: fixed · Seen: 1
- Problem: PrismaClientInitializationError: can't reach the database at localhost:5433.
- Why it happened: .env still pointed at the old Docker Postgres. The native PostgreSQL 18 runs on 5432, and its `postgres`
  password was unknown. The running dev servers kept the old address even after .env changed.
- Fix: scripts/setup-local-db.ps1 (run as administrator) briefly allows local passwordless logins, creates the reelsmith role and
  database, and restores pg_hba.conf. Then `prisma db push` and restart the servers.

### G31 · The first page compile is slow, so scripted tests time out
- Date: 2026-10-12 · Area: editor · Status: workaround · Seen: 3
- Problem: E2E logins landed back on /login, and the first API reads returned too early.
- Why it happened: the Next dev server compiles each route on its first request (10–30 s on this laptop).
- Fix: tests wait for the redirect / the element, and warm the routes first.

### G32 · ReelSmith moved to E:\reelsmith, but some paths still point at C:\Users\Admin\reelsmith
- Date: 2026-10-21 · Area: setup · Status: open · Seen: 1
- Problem: .env `STORAGE_DIR` is `C:/Users/Admin/reelsmith/storage` and D:/reel-studio/CLAUDE.md names C:\Users\Admin\reelsmith,
  but that folder no longer exists; the app is in E:\reelsmith (with its own storage\ folder).
- Why it happened: the project folder was moved without re-running setup.
- Fix: point `STORAGE_DIR` at the real storage folder (E:/reelsmith/storage if that is where your media is) and re-run
  `setup.bat` so the workspace files get the new path. Media URLs in the database are relative, so they keep working.

## Tools

### G33 · Real-ESRGAN: "invalid gpu device", then ~4 min per frame
- Date: 2026-10-12 · Area: quality · Status: workaround · Seen: 1
- Problem: AI upscale failed, and once it ran it took about 4 minutes per frame (a 2 s clip ≈ 4 h).
- Why it happened: the official realesrgan-ncnn-vulkan build has no CPU mode (`-g -1` is invalid); it runs on the Intel UHD 620
  over Vulkan, which is slow. It also wasn't installed.
- Fix: no `-g` flag (auto-picks the GPU) unless `REALESRGAN_GPU` is set; setup installs it. Use it only for very short shots, and
  never offer it for clips that are already 1080 wide (that estimate timed out).

### G34 · ffmpeg not found after `winget install ffmpeg`
- Date: 2026-10-01 · Area: setup · Status: fixed · Seen: 1
- Problem: ffmpeg was installed but commands couldn't find it.
- Why it happened: winget's install folder isn't on PATH until a new terminal is opened.
- Fix: the scripts look in winget's folder automatically; worker/media.py honours `FFMPEG_BIN` and falls back to imageio-ffmpeg.

## Editor and app

### G35 · Uploaded music tracks had no beat grid in the clipper
- Date: 2026-10-12 · Area: editor · Status: fixed · Seen: 1
- Problem: the waveform clipper showed beats only for tracks that came from a link.
- Why it happened: only link downloads ran beat analysis; short sounds weren't marked SFX either.
- Fix: tracks are analysed when the clipper opens (~6 s); short clipped sounds are marked SFX.

### G36 · Compare in Versions crashed
- Date: 2026-10-12 · Area: editor · Status: fixed · Seen: 1
- Problem: opening Compare threw an error.
- Why it happened: the video duration was read from a React event inside a deferred state update, after React had cleared it.
- Fix: read the value from the event first, then update state.

### G37 · Times in the app were 7 hours off
- Date: 2026-10-12 · Area: editor · Status: fixed · Seen: 1
- Problem: job and render times showed 7 h early.
- Why it happened: the Python worker wrote local time into UTC columns.
- Fix: worker/db.py writes UTC. Rows written before 2026-10-12 are still off.

### G38 · Enhance analysed the speaker cut-out copies and inserts too
- Date: 2026-10-12 · Area: quality · Status: fixed · Seen: 1
- Problem: Enhance proposed settings for generated layers.
- Why it happened: it took every video clip on the timeline.
- Fix: generated clips (cut-outs, inserts) are skipped.

### G39 · The orbit insert hung while building
- Date: 2026-10-12 · Area: render · Status: fixed · Seen: 1
- Problem: building the "reels orbiting me" insert never finished.
- Why it happened: a still image was looped as if it were a video.
- Fix: images are handled separately in worker/inserts.py.

### G40 · Orbiting reels could never pass in front of the speaker
- Date: 2026-10-12 · Area: editor · Status: fixed · Seen: 1
- Problem: the orbit's front layer was always behind the speaker.
- Why it happened: applyLooks put the Inserts track below the Cut-out track.
- Fix: the track order in applyLooks puts the front insert layer above the cut-out.

### G41 · New clips landed on the Inserts / Cut-out tracks
- Date: 2026-10-12 · Area: editor · Status: fixed · Seen: 1
- Problem: a dropped clip could go onto a generated track.
- Why it happened: addClip picks the first unlocked video track.
- Fix: managed tracks are skipped.

### G42 · A failing matte was queued again forever
- Date: 2026-10-12 · Area: editor · Status: fixed · Seen: 1
- Problem: a speaker cut-out that failed was re-queued immediately, again and again.
- Why it happened: the editor hook re-queued every missing matte.
- Fix: failed sources are remembered for the session.

### G43 · `npm run build` failed on the Background panel
- Date: 2026-10-09 · Area: editor · Status: fixed · Seen: 1
- Problem: a type error in BackgroundPanel.tsx, then a lint error, broke the production build.
- Why it happened: the brightness slider passed a value to a callback that takes none, and a click handler named `useImage` is
  treated as a React hook by the linter.
- Fix: the slider records one undo step on release; the handler is `applyImage`.

### G44 · Opening Gemini in a new window always showed a warning
- Date: 2026-10-02 · Area: editor · Status: fixed · Seen: 1
- Problem: a "popup blocked" toast fired every time.
- Why it happened: `window.open` with noopener returns null in Chrome even when the tab opens.
- Fix: plain links instead.

### G45 · Timeline hashes changed after saving
- Date: 2026-10-12 · Area: editor · Status: fixed · Seen: 1
- Problem: the "changed since the stills were approved" warning showed for unchanged timelines.
- Why it happened: Postgres jsonb reorders object keys.
- Fix: timelineHash sorts keys before hashing.

### G46 · Shell helpers hung or broke on quotes
- Date: 2026-10-12 · Area: setup · Status: workaround · Seen: 3
- Problem: a test step hung forever; an edit script didn't apply.
- Why it happened: a stray `cat` waited for input; heredocs with apostrophes broke the quoting.
- Fix: write scripts to a file and run the file; never leave a command reading stdin.

## Taste checklist and gotchas files

### G47 · A rule field with extra words before its colon is silently dropped
- Date: 2026-10-21 · Area: editor · Status: fixed · Seen: 1
- Problem: R36 (Enhance) came back from the parser with an empty "In practice" and its sub-bullets glued to the wrong field.
- Why it happened: the field was written as "- In practice (CPU only, …):". The reader only knows "- Key: value" bullets, where
  the key is plain words, so the line wasn't recognised as a field.
- Fix: the field is now "- In practice: CPU only, …". scripts/test-rules-files.ts checks every rule has a title, date and
  In practice (run it after editing the checklist by hand). Keep keys plain: Added, Topic, Type, Status, Your words,
  In practice, Also said, Added in, Replaced by.

### G48 · A finished chat turn ran its actions twice
- Date: 2026-10-21 · Area: agent · Status: fixed · Seen: 1
- Problem: one chat message ("the captions felt busy…") started two identical style passes, one after the other.
- Why it happened: the editor and a second client polled /api/projects/<id>/chat at the same moment. Both saw the finished chat
  turn as unanswered and both ran its actions; the check ("has a reply been posted?") and the reply weren't one step.
- Fix: settleChat claims each finished turn with an exclusive marker file (chat/<job id>.settled, created with the "wx" flag)
  before it posts the reply and runs the actions, the same way notes are filed once (rules/<job id>.json.filed).
