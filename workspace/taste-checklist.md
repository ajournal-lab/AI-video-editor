# Taste checklist

Every ReelSmith edit is held to these rules. Claude reads this file **and `gotchas.md`** before every edit (the cut, the style
pass, chat turns, revisions, Enhance, renders) and a fresh checker checks every draft against it before you see the draft.
It replaces the old `rules.md` (migrated 2026-10-21; your original words were kept wherever they were on record).

How a rule is written (keep this shape: the Rules page in ReelSmith reads and edits it):

```
### R<n> · <short rule>
- Added: <date> · Topic: <topic> · Type: taste|default|hard|process · Status: active|disabled
- Your words: "<exactly what you said or picked>"
- In practice: <what it means for an edit, with numbers>
- Also said: <date> "<later words that back the same rule>"        (optional, any number)
- Added in: <project>                                               (optional)
- Replaced by: R<n> (<date>, <why>)                                 (optional, set only when you chose a newer rule)
```

**Type** decides priority. `taste` = your own preference: it beats the brand kit, the creator's style.json, the looks and the
defaults. `default` = a house default: a taste rule, the brand kit, a creator style or a look may change it. `hard` = a quality or
safety limit that always applies. `process` = how Claude works on an edit (checked on the work, not on the video).
A **disabled** rule is kept for history but not applied. Rules are never deleted without asking you.

## How Claude works on every edit

### R1 · Read the taste checklist and the gotchas before every edit
- Added: 2026-10-21 · Topic: workflow · Type: process · Status: active
- Your words: "Read taste-checklist.md and gotchas.md before every edit."
- In practice: both files are part of every headless run's instructions (ReelSmith inserts the active rules and every gotcha).
  Interactive /edit-reel sessions read both files at the start. Apply each rule's intent even when its wording is loose.

### R2 · Every piece of feedback becomes a rule in your words before anything changes
- Added: 2026-10-21 · Topic: workflow · Type: process · Status: active
- Your words: "When I give feedback (typed, voice, storyboard notes or draft notes), turn each note into a rule in my words before changing anything."
- In practice: chat messages, voice notes, notes on the key stills, notes on the cut and notes on a render all go through the
  same step: each note that says how an edit should look, sound or feel is written down as a rule (your exact words quoted, plus
  what it means in practice) BEFORE the edit is changed. A note that repeats an existing rule adds an "Also said" line to that rule.
  Pure requests to run a step ("render", "show stills") or one-off content ("make the hook say X", "use clip 3") are not rules.

### R3 · Something broke and got fixed: write it in gotchas.md before moving on
- Added: 2026-10-21 · Topic: workflow · Type: process · Status: active
- Your words: "When something breaks and gets fixed, add it to gotchas.md before moving on."
- In practice: every error that gets solved (a failing command, an invalid result file, a render bug, a setup problem) is added to
  gotchas.md as Problem / Why it happened / Fix. Headless runs write `jobs/<job id>.gotchas.json` and ReelSmith files it; result
  files that failed validation and were fixed are filed automatically. A gotcha that happens again gets its "Seen" count raised.

### R4 · Fix the cause, then check the whole video for the same problem
- Added: 2026-10-21 · Topic: workflow · Type: process · Status: active
- Your words: "Fix the cause, not just the shot I mentioned: check the whole video for the same problem."
- In practice: a note about one moment ("text over my face at 0:04") is fixed at the cause (the caption y, the text placement
  rule), then every other moment with the same problem is fixed in the same pass. The reply says how many places were fixed.

### R5 · A fresh checker checks every draft against every rule before you see it
- Added: 2026-10-21 · Topic: workflow · Type: process · Status: active
- Your words: "Before showing any draft, a fresh subagent checks it against every rule; tell me what it found and what you fixed."
- In practice: the spoken cut (stage 1) and the key stills (stage 2) are each checked by a new Claude session that has not seen
  the edit being made. It checks every active rule (process rules are about the work, so they are listed as not applicable). The
  editing session fixes what failed, then the draft is shown with "checked N rules: found …, fixed …, left …".

### R6 · A new note that contradicts a rule: ask which wins. Never delete a rule without asking
- Added: 2026-10-21 · Topic: workflow · Type: process · Status: active
- Your words: "If a new note contradicts an old rule, ask me which wins. Never delete a rule without asking."
- In practice: the conflicting part of the note is not applied. The chat asks: the new note wins (the old rule is disabled and
  marked "Replaced by"), the old rule wins, or the note applies to this video only. Deleting a rule on the Rules page asks first.

### R7 · When a video is finished, show the rules added while making it
- Added: 2026-10-21 · Topic: workflow · Type: process · Status: active
- Your words: "When a video is finished, show me the rules added this time."
- In practice: when a render finishes, the chat and the Export dialog list the rules added during this project.

### R8 · Never overwrite an earlier video: every render is a new numbered version
- Added: 2026-10-02 · Topic: delivery · Type: hard · Status: active
- Your words: "i can still old one, create a new name and and save a separate video, dont overwrite"
- Also said: 2026-10-12 "Versions: save every render as a numbered version with its notes; a version list with preview, compare and "restore this version"."
- In practice: every render is v1, v2, … with notes (what changed since the previous version + what was asked in the chat).
  Restore always snapshots the current timeline first. /edit-reel saves new file names (reel_v2_…), never the old ones.

## Story, cuts and framing

### R9 · Cut on the beat; never mid-rep or mid-word
- Added: 2026-10-02 · Topic: pacing · Type: hard · Status: active
- Your words: "Cuts on the beat. Never cut mid-rep or mid-word."
- In practice: with music, every cut sits on a beat or strong onset. Lift shots start and end on a movement boundary (lockout or
  bottom). Speech cuts snap to the quietest 10 ms next to a word boundary (speech_cuts.py), padded 30-200 ms.

### R10 · Clean speech: last take wins, no fillers, no pauses over 0.3 s
- Added: 2026-10-01 · Topic: pacing · Type: default · Status: active
- Your words: "Speaking clips: remove retakes (keep my LAST take), false starts, stutters, filler words (um, uh, like, you know), and pauses longer than 0.3 seconds. Snap every cut to the quietest spot in the audio waveform near the word boundary, never mid-word."
- In practice: stage 1 of every talking edit. speech_cuts.py --max-gap 0.3 --phrases, then --drop for earlier takes of a
  repeated line. Never change what is said otherwise.

### R11 · Silent workout clips: trim the dead time, keep the cleanest, most intense reps
- Added: 2026-10-01 · Topic: pacing · Type: default · Status: active
- Your words: "Silent workout clips: trim dead time at the start and end (setting up the phone, walking into frame, stopping the recording, resting). Keep the cleanest, most intense reps."
- In practice: no phone setup, walking in, re-racking, resting or walking off on screen. Pick the strongest reps.

### R12 · Hook → grind → reveal; the first 2 seconds get the strongest moment and the boldest text
- Added: 2026-10-01 · Topic: hook · Type: default · Status: active
- Your words: "Hook: the first 2 seconds get the strongest clip and the boldest text."
- Also said: 2026-10-02 "Hook: the first 2 seconds get the strongest moment and the boldest text."
- In practice: multi-clip workout reels open on the strongest, already-moving clip with the hook text, build through the grind
  with cuts getting faster, and land the payoff (reveal) on the drop. Talking heads open on the first spoken line with no intro.

### R13 · Punch-ins only where the source resolution allows; never upscale past the source
- Added: 2026-10-02 · Topic: zooms · Type: hard · Status: active
- Your words: "Punch-in zooms (alternating 100% and about 110%) only where the source resolution allows it without visible softness. Keep me fully in frame."
- Also said: 2026-10-02 "never upscale beyond the source unless I ask."
- In practice: zooms are capped at maxZoom (the scale where the source fills the frame 1:1). The only exception is when the frame
  size forces it (a horizontal clip cropped to vertical): the quality check then warns. Push-ins never crop the head, fists or feet.

### R14 · Horizontal clips: crop to vertical, not a blurred background
- Added: 2026-10-01 · Topic: layout · Type: taste · Status: active
- Your words: "Crop to vertical" (picked over "Blurred background (Recommended)" for the horizontal row-machine clip)
- In practice: still ask each time, but preselect crop and pick the most readable crop centre from a crop test.

### R15 · Fit the reel to a sound that is shorter than the target
- Added: 2026-10-01 · Topic: music · Type: taste · Status: active
- Your words: "Fit, but 21.5s long" (picked over keeping 30 s: "Song from 0:00, reveal on the drop at 10.4s, then extend the payoff: flex + 2nd flex angle + physique turn over the loud chorus until ~21s.")
- In practice: when the sound is shorter than the target length, play the song from 0:00, land the reveal on the drop and extend
  the payoff over the loud section until the sound ends. Ask when it happens.

### R16 · Fast pacing for watch time: 1-2 beats per shot, cut on the drop, keep the payoff moving
- Added: 2026-10-02 · Topic: pacing · Type: taste · Status: active
- Your words: "the video that i creating is monotonous, add more cuts and add more video effects and transitions syncing to the audio. I dont feel the video will get watch times as of now"
- In practice: music edits cut every 1-2 beats in the build (max 4 beats per shot), cut ON the drop and keep changing every 2-4
  beats after it (no shot over ~3 s), 12-25 shots in 15-20 s. Beat effects on top: zoom punches on beats, shake + white flash on
  the drop, flash/zoom transitions, beat cuts where the resolution allows a punch-in. `energy` subtle | punchy (default) | hype.
  Text and captions stay still.

## Text and captions

### R17 · Text stays out of the safe zones and never covers your face or body
- Added: 2026-10-01 · Topic: text · Type: hard · Status: active
- Your words: "Check that no text covers my face or body mid-rep, nothing gets cut off at the edges, … and nothing breaks Instagram's safe zones (keep text out of the top 250px and bottom 400px)."
- Also said: 2026-10-02 "Text: bold, readable, never over my face or body mid-rep."
- In practice: on 1080x1920, text and captions sit between y 250 and y 1520 (y 0.14-0.79 as a fraction of the height), never over
  the face, never over the body during a lift, never cut off at the edges, on screen at least 1.2 s.

### R18 · Speech gets word-timed captions with the active word highlighted
- Added: 2026-10-01 · Topic: captions · Type: default · Status: active
- Your words: "For any speaking clip, burn in word-timed captions via an ASS subtitle file through ffmpeg, active word highlighted."
- In practice: every clip with speech gets word-timed captions (ASS, libass with fontsdir=C:/Windows/Fonts). A creator style, the
  brand kit or a look may change the caption style; a taste rule beats them all.

### R19 · House text style when the reference is unclear
- Added: 2026-10-01 · Topic: text · Type: default · Status: active
- Your words: "Where the reference is unclear, default to: bold white sans-serif text with a dark outline, one accent colour, lower third, never over my face or body during a lift; a new visual every 2 to 4 seconds."
- In practice: white bold sans with a dark outline, one accent colour (#FFD60A), lower third. In the grind, at most 1-3 short sassy
  pop-ups ("no days off", "rep after rep"), only where they don't clutter the frame.

### R20 · Tone: sassy, emotional, motivational; default niche fitness / gym
- Added: 2026-10-02 · Topic: hook · Type: default · Status: active
- Your words: "Tone: sassy, emotional, motivational, something that makes people stop scrolling, feel something, and share it"
- In practice: hooks, on-screen text, alternative hooks and captions are written fresh in that tone (never copied). Hand-off: 3
  alternative hooks and a short caption with up to 5 hashtags.

## Colour and grade

### R21 · Grade: grey grind → colour reveal
- Added: 2026-10-01 · Topic: grade · Type: taste · Status: active
- Your words: "Grey grind → colour reveal (Recommended)" (picked when asked about the colour grade)
- In practice: the recommended default for hook → grind → reveal reels: grind shots `grey`, the reveal in untouched natural colour.

### R22 · Natural skin tones; ask before any grade
- Added: 2026-10-01 · Topic: grade · Type: hard · Status: active
- Your words: "Never change my colours or skin tone beyond what STYLE.md's grade calls for, and ask before applying any grade."
- Also said: 2026-10-02 "Grade as planned. Keep skin tones natural."
- In practice: skin hue may move at most 3° (Enhance proposes at most 2°). Looks and grades are applied only when chosen (plan,
  look picker, chat).

### R23 · Cinematic Warm look (talking head / best take, when picked)
- Added: 2026-10-02 · Topic: grade · Type: default · Status: active
- Your words: not on record (the look was added on 2026-10-02 together with audio-from-link).
- In practice: warm highlights, teal/neutral shadows, soft blacks, calmer background colours, subtle vignette, skin protected.
  Default intensity 70%. Skin hue may move at most 3°.

## Sound and music

### R24 · Loudness -14 LUFS, true peak at most -1 dBTP
- Added: 2026-10-01 · Topic: sound · Type: hard · Status: active
- Your words: "Normalise loudness to -14 LUFS."
- In practice: two-pass loudnorm, then a 4x-oversampled limiter (worker/audio_master.py); clipping sources are flagged.

### R25 · Music deliverables: a no-music file to post and a preview with the song, plus the song start second
- Added: 2026-10-01 · Topic: delivery · Type: taste · Status: active
- Your words: "Sync cuts to the beat and land the reveal on the drop. Export final_nomusic.mp4 (to post; I'll add the sound in Instagram) and final_preview.mp4 (with music, to check the sync). Tell me which second of the song the edit starts from."
- In practice: /edit-reel exports `final_nomusic.mp4` (ambience bed) and `final_preview.mp4`; ReelSmith's Export dialog shows the
  link and "start the sound at 0:xx". Always give the second of the sound the edit starts from.

### R26 · Instagram sounds: only /reel/ links
- Added: 2026-10-02 · Topic: music · Type: hard · Status: active
- Your words: "An Instagram reel link (it must contain /reel/, not /audio/) … If I give you an /audio/ link, tell me to send a /reel/ link instead."
- In practice: yt-dlp can't read `/reels/audio/` pages. Reject them with that message and ask for a `/reel/` link that uses the sound.

### R27 · Sound from a link is for timing only unless you have the rights
- Added: 2026-10-02 · Topic: music · Type: default · Status: active
- Your words: "download it with yt-dlp as edit/music.mp3 for timing only. I'll add the same sound in Instagram when posting."
- In practice: link-sourced audio is "timing only / personal use" until you tick "I have the rights"; Export warns before rendering it.

### R28 · Duck music under your voice; sound effects at least 6 dB under the voice
- Added: 2026-10-12 · Topic: sound · Type: hard · Status: active
- Your words: "Audio safety: auto-duck music and keep every sound effect at least 6 dB below my voice; flag any SFX that's louder."
- In practice: music ducks under the voice by default (duck level from the Music panel, default 20%). Sound effects (≤ 8 s or
  marked SFX) never duck and stay ≥ 6 dB under the voice: voice = integrated loudness of the voice clips, SFX = its loudest 400 ms
  momentary loudness. Louder ones are turned down in the export and flagged in the render report.

## Video quality

### R29 · Grain counts as "low quality": clean noisy clips first, sharpen gently, check every shot
- Added: 2026-10-02 · Topic: quality · Type: taste · Status: active
- Your words: "the quality is low" … "its still the same quality" (then picked "Grainy / noisy", watching on both the laptop and the phone)
- In practice: night/low-light iPhone footage (HDR → SDR tone-map and a grey grade lift the sensor noise) and low-res/compressed
  clips must be denoised. Denoise BEFORE any upscale; never sharpen an un-denoised low-res clip. Measure the noise of every shot,
  not just the worst one. Mention that WhatsApp recompresses video (send as a document or via Drive to check it).

### R30 · Every source goes to SDR bt709; HDR is tone-mapped properly
- Added: 2026-10-02 · Topic: quality · Type: hard · Status: active
- Your words: "HDR: detect HLG/PQ/Dolby Vision 10-bit bt2020 sources and tone-map to SDR bt709 properly (zscale + tonemap, hable or mobius). Tag outputs bt709 (primaries, transfer, matrix)."
- In practice: HLG/PQ, bt2020 and iPhone Dolby Vision 8.4 are linearised, gamut-mapped and tone-mapped with mobius (transition
  0.15) at nominal peak 100. Display P3, bt601/smpte170m and full-range ("yuvj") sources are converted with zimg. Never let a
  bt2020/HLG frame reach the encoder untouched.

### R31 · Scale once, keep the source frame rate
- Added: 2026-10-02 · Topic: quality · Type: hard · Status: active
- Your words: "Scaling and fps: lanczos, scale once, keep source fps, conform mixed fps once, no dropped or duplicated frames, never upscale beyond the source unless I ask."
- In practice: the colour conversion and the one scale to the placed size are one zscale call (lanczos, linear light for HDR).
  Stabilised clips: convert at the source size, stabilise, then the one scale. The timeline keeps the sources' own rate
  (duration-weighted, snapped to 24/25/30/48/50/60, max 60; iPhone variable-rate slow-mo counts as 30), conformed once (fps filter).

### R32 · One lossy encode, from the originals
- Added: 2026-10-02 · Topic: quality · Type: hard · Status: active
- Your words: "Single encode: trim, enhance, grade, graphics, motion and captions all composed into ONE final encode from the originals. Intermediates lossless or none."
- Also said: 2026-10-02 "Do all edits in ONE encode from the original files. Never re-encode an already-encoded output."
- In practice: the filter graph writes a lossless master (x264 -qp 0) + a float WAV; the export is ONE x264 encode from that
  master. Intermediates are lossless (edit-reel shot files and the upscale intermediate too) or don't exist.

### R33 · Export settings
- Added: 2026-10-02 · Topic: quality · Type: hard · Status: active
- Your words: "Export: 1080x1920, H.264 high, yuv420p, bt709, CRF 17 preset slow (or 2-pass ~15–20 Mbps if VMAF scores better), AAC 192k 48kHz, +faststart."
- In practice: 1080x1920, H.264 High, yuv420p, bt709 primaries/transfer/matrix, tv range, CRF 17 preset slow, keyframe every 2 s,
  AAC 192k 48 kHz, +faststart.

### R34 · Every render passes the quality check
- Added: 2026-10-02 · Topic: quality · Type: hard · Status: active
- Your words: "Add a Quality check to the self-check: VMAF/SSIM vs source, HDR handled, encode count, bitrate, colour tags. Pass/fail in the app."
- In practice: VMAF ≥ 93 (min frame ≥ 80) and SSIM ≥ 0.985 of the export against the lossless render of the same edit, bt709 tags,
  H.264 High yuv420p at the frame size, HDR handled, exact frame count, no duplicated frames at normal speed, upscale warnings,
  1 lossy encode, bitrate, AAC 48 kHz, faststart.

### R35 · Every render also writes a phone preview
- Added: 2026-10-12 · Topic: delivery · Type: default · Status: active
- Your words: "Phone preview: after each render, a small fast preview (720p, low bitrate) for quick review in the UI and on my phone, separate from the full-quality final."
- In practice: 720p (short side), ~1.4 Mbit/s H.264, AAC 96k, faststart, ready before the quality check. The full-quality export
  is unchanged.

## Enhance

### R36 · Enhance: fix only what needs fixing, never degrade a clean clip
- Added: 2026-10-02 · Topic: quality · Type: default · Status: active
- Your words: "Enhance: stabilise (vidstab 2-pass), denoise only noisy clips, light sharpening, exposure/white balance correction, colour-match all clips. Verify with VMAF that clean clips aren't degraded."
- Also said: 2026-10-02 "Light denoise only if a clip is visibly noisy in low light; never smear detail."
- In practice: CPU only, applied per clip before the single final encode. Engine: `python {{REEL_STUDIO_DIR}}/tools/enhance.py`
  (the same code ReelSmith renders with: {{REELSMITH_DIR}}/worker/enhance.py, where the numbers live in `D`).
  - Order: stabilise → denoise → exposure/contrast/white balance → match across clips → scale → sharpen.
  - Stabilise only when camera jitter is over 0.3% of the frame width (measured on the frame corners, so a moving body is not
    "shake"). Two-pass vidstab with optzoom=1, the gentlest setting that cuts the jitter by at least 35%: smoothing 10/16/24 with max
    shift 2/3/4% and max angle 0.5–0.7°, so the crop stays at or under about 10%. Off if it cuts the jitter by less than 25%
    (usually subject motion), or if it warps or shows borders.
  - Denoise only when luma noise sigma is over 2.0: hqdn3d (spatial luma 1–3, low so skin keeps its texture); nlmeans (s 1–3) only
    in low light (median luma under 0.22) with sigma over 4. Phone/WhatsApp clips are usually already clean: leave them alone.
  - Sharpen: light unsharp, luma only, 5×5, amount at most 0.6, after scaling; at most 0.35 when the source is smaller than the frame.
  - Exposure/WB: levels only when the blacks are lifted (p0.5 over 0.04) or the whites are dull (p99.5 under 0.94). Gamma toward a
    median of 0.42 at 60% strength. White balance 60% toward neutral, at most ±8% per channel (±5% with skin in frame).
  - Match: pull every clip 80% toward the group's median brightness and neutral balance (gamma ±14%, gains ±4%).
  - Skin: a correction that moves the skin hue by more than 2° is scaled back before it is proposed.
  - Self-check (must pass): halo pixels ≤ 6% of edges, texture detail kept ≥ 80%, skin detail kept ≥ 85%, skin hue shift ≤ 3°, new
    clipped highlights ≤ 0.6%, stabilisation shake reduction ≥ 25% with no black borders and a crop ≤ 10.5%. A failing fix is
    stepped down automatically. Then look at the before/after sheets: no crunchy edges, no plastic skin, no wobble.
  - Enhance skips generated copies (speaker cut-outs, inserts).

### R37 · AI upscale only with your yes after a time estimate
- Added: 2026-10-02 · Topic: quality · Type: hard · Status: active
- Your words: "never upscale beyond the source unless I ask."
- In practice: Real-ESRGAN x4 (ncnn on any Vulkan GPU, integrated graphics included; there is no CPU mode) only for clips under
  1080 wide. Never start it without showing the time estimate and getting a yes (~4 min per frame on this laptop: very short shots
  only). Headless runs never upscale; they list the candidates.

## Looks, inserts and credits

### R38 · Bold look
- Added: 2026-10-12 · Topic: captions · Type: default · Status: active
- Your words: "Bold: kinetic lowercase words around me, big words behind my head (cut-out), punch word in yellow."
- In practice: kinetic lowercase captions (≤ 3 words, popping in beside the speaker, words appear as spoken), big words behind the
  head (speaker cut out on top), the punch word in yellow (#FFD60A). No grade change.

### R39 · Cool girl look
- Added: 2026-10-12 · Topic: captions · Type: default · Status: active
- Your words: "Cool girl: warm grade, calm lowercase text, one punch line in a yellow serif italic with sparkles, my own reels orbiting me."
- In practice: Warm Soft 80% grade, calm lowercase captions (lower third, fade in), ONE punch line per section in a yellow serif
  italic (Playfair Italic) with twinkling sparkles (captions step aside while it shows), your own reels orbiting you (passing
  behind and in front).

### R40 · Cool dude look
- Added: 2026-10-12 · Topic: captions · Type: default · Status: active
- Your words: "Cool dude: dark editorial grade (room falls back, I stay lit), tiny spaced capitals + big serif words, alternating wide and close-up crops like a studio interview."
- In practice: Dark Editorial 85% (the room falls back) with the speaker lit on the cut-out (Editorial speaker grade), tiny spaced
  capitals for captions + big serif words, alternating wide / close-up crops. Close-ups only where the source resolution allows
  (no upscaling) unless "soft close-ups" is on.

### R41 · Looks: a default per project, switched per section
- Added: 2026-10-12 · Topic: layout · Type: default · Status: active
- Your words: "Pick a default per project/client, and switch looks per section: by saying it in the script (detect "cool girl aesthetic" etc. in the transcript), by chat ("cool girl when I say X, bold everywhere else"), or by dragging on the timeline."
- In practice: the default comes from the Looks panel (initialised from the brand kit look; no look = the plain defaults). A
  dragged timeline section beats a chat instruction, which beats a spoken cue. A spoken cue switches from its sentence onward until
  the next cue; cue words stay in the edit unless you ask to cut them. Look content is generated (`gen: "look"`) and regenerated
  when the looks change, so change the look settings rather than the generated clips. Taste rules beat the look.

### R42 · Animated inserts build in the background
- Added: 2026-10-12 · Topic: layout · Type: default · Status: active
- Your words: "Parallel inserts: build animated inserts (app screen behind me, profile-follow CTA, scrolling file, UI demos) as separate background jobs while the main edit renders, one at a time if CPU is busy. Show their status in the UI."
- In practice: transparent full-frame layers built by the worker insert pool, 2 at a time, 1 while a render runs or the CPU is over
  70%. Behind-the-speaker inserts need the speaker cut out on top. Defaults: app screen 4 s, CTA 3.5 s, file 4 s, UI demo 5 s,
  orbit 6 s. The CTA uses the brand kit's @handle.

### R43 · Credit other creators on screen
- Added: 2026-10-12 · Topic: text · Type: hard · Status: active
- Your words: "Creator credits: whenever another creator's video or reel appears on screen, auto-add their @handle on screen."
- In practice: any clip from another creator (a link import, an orbiting reel that isn't yours) shows their @handle while it is on
  screen, inside the safe zone.

## Workflow and priorities

### R44 · Your taste rules beat the brand kit, which beats the creator style, which beats the defaults
- Added: 2026-10-12 · Topic: workflow · Type: process · Status: active
- Your words: "Priority: my taste rules > client brand kit > creator style.json > defaults. Show which rule won when they conflict."
- In practice: taste rules (Type: taste), then the client's brand kit (Settings), then the creator's style.json
  ({{REEL_STUDIO_DIR}}/creator-profiles/<handle>/), then the defaults. Report every conflict and which layer won. Creator topics marked
  MISMATCH (or "varied") aren't a reliable trait of that creator: treat them as optional. Teardowns use measured numbers only
  (measurements.json); an unmeasured value is null.

### R45 · Two-stage approval: the spoken cut first, then the style pass and its key stills
- Added: 2026-10-12 · Topic: workflow · Type: process · Status: active
- Your words: "Stage 1: the spoken cut only (last-take-wins, pauses/fillers removed). I approve or send timestamped fixes in the UI. Stage 2: style pass from the creator profile + my taste rules. Generate key stills (hook, caption moments, visual cards, transitions) and show them in the UI. Render only after I approve the stills."
- In practice: stage 1 has no styling. Stage 2 never changes what is said, its order or the cut points; it picks 4-8 key stills (hook,
  caption moments, text cards, transitions, a zoom hit). Nothing renders until the stills are approved.

### R46 · Chat: one conversation per project, the cheapest step that does what was asked
- Added: 2026-10-12 · Topic: workflow · Type: process · Status: active
- Your words: "Each instruction resumes the same Claude session, shows progress live, and every change lands on the timeline as editable tracks."
- In practice: chat turns, the cut, its revisions and the style pass all resume the project's session. A small change gets edit ops,
  not a new cut or style pass.

### R47 · Timestamped fixes are one rebuild
- Added: 2026-10-12 · Topic: workflow · Type: process · Status: active
- Your words: "Timestamped corrections: one message with several "Around 0:18, …" lines is applied as one rebuild."
- In practice: times are REEL times of the cut or timeline you are looking at. Every fix in one message goes into ONE action.

### R48 · No paid APIs; every AI step runs on the Claude subscription
- Added: 2026-10-02 · Topic: workflow · Type: hard · Status: active
- Your words: "All AI features run through the Claude Code CLI in headless mode (claude -p) using my Claude subscription … No API keys and no paid APIs anywhere."
- In practice: never call ElevenLabs, Gemini, OpenAI, Pexels or any keyed service. Transcription is local (faster-whisper).
  ANTHROPIC_API_KEY is removed from every claude child process. OmniRoute was removed on 2026-10-12.

### R49 · Cloud render only after your click and confirmation, to a private repo
- Added: 2026-10-12 · Topic: workflow · Type: hard · Status: active
- Your words: "Build the "Render in cloud" feature (item 5) but keep it switched off, and never let it run without my explicit click and confirmation." … "Never use a public repo for footage."
- In practice: off by default. It only runs after you click it and confirm the upload, to a PRIVATE repo you own. Headless and chat
  runs never start it: a chat "render" is always a local render.

### R50 · Never modify or move your original clips
- Added: 2026-10-01 · Topic: workflow · Type: hard · Status: active
- Your words: "Never modify or move my original clips."
- In practice: sources are read-only. Everything is written to the project's edit/ and render/ folders.

## Rules from your feedback

New rules from your notes are added here (newest last), each with your words and the project it came from.
