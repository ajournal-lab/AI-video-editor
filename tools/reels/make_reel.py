"""Reel B ("event poster") pipeline: stitch one or more clips into a 9:16 reel.

Format (as approved for the Diwali invite reel):
  - 1080x1920, 30 fps, H.264 CRF 20 + AAC 160k, loudness -14 LUFS
  - leading/trailing silence trimmed per clip (from word timings)
  - warm festive grade + soft vignette
  - persistent top banner (Bebas Neue, yellow) + small tag line under it
  - sentence subtitles (Montserrat ExtraBold, white on translucent box)
  - last frame held and darkened with a 3-line end card

Usage:
  python make_reel.py config.json
config.json:
  {
    "clips": ["clip1.mov", "clip2.mov"],          # in story order
    "out": "out/reel.mp4",
    "banner": "DIWALI PARTY  |  1 NOV  |  7 PM",
    "tag": "invite only",
    "end_big": "INVITE ONLY",
    "end_small": "DM me to get in",
    "end_accent": "1 Nov  |  7 PM",
    "captions": "captions.json",                  # optional: [{"clip":0,"start":2.1,"end":3.7,"text":"..."}]
    "language": null                              # whisper language hint, e.g. "hi"
  }
Needs ffmpeg with libass and faster-whisper; fonts come from public/fonts.
"""
import json
import os
import subprocess
import sys
import wave

W, H, FPS = 1080, 1920, 30
HOLD = 2.6
YELLOW = "&H00D4FF&"
HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "..", "..", "public", "fonts")
# fc-scan reports the bundled Montserrat file under this family name.
MONT = "Montserrat Thin ExtraBold"


def run(cmd, **kw):
    print("+", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def transcribe(path, language):
    import numpy as np
    from faster_whisper import WhisperModel
    wav = path + ".16k.wav"
    run(["ffmpeg", "-v", "error", "-y", "-i", path, "-vn", "-ac", "1", "-ar", "16000", wav])
    w = wave.open(wav)
    audio = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    model = transcribe.model = getattr(transcribe, "model", None) or WhisperModel("large-v3", device="cpu", compute_type="int8")
    segs, _ = model.transcribe(audio, language=language, word_timestamps=True, beam_size=5)
    return [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in segs]


def ts(t):
    h, r = divmod(max(t, 0), 3600)
    m, s = divmod(r, 60)
    return f"{int(h)}:{int(m):02d}:{s:05.2f}"


def style(name, font, size, primary, outline, back, border, outl, shadow, align, mv, spacing=0):
    return (f"Style: {name},{font},{size},{primary},&H000000FF,{outline},{back},0,0,0,0,100,100,"
            f"{spacing},0,{border},{outl},{shadow},{align},60,60,{mv},1")


def build_ass(cfg, subs, clip_total, total):
    styles = "\n".join([
        style("Sub", MONT, 60, "&H00FFFFFF", "&H00000000", "&H99000000", 3, 16, 0, 2, 430),
        style("Banner", "Bebas Neue", 92, "&H0000D4FF", "&H00000000", "&H00000000", 1, 6, 2, 8, 200, 4),
        style("Small", MONT, 44, "&H00FFFFFF", "&H00000000", "&H00000000", 1, 4, 0, 8, 310),
        style("EndBig", "Bebas Neue", 190, "&H0000D4FF", "&H00000000", "&H00000000", 1, 8, 4, 5, 0, 4),
        style("EndSmall", MONT, 66, "&H00FFFFFF", "&H00000000", "&H00000000", 1, 5, 0, 5, 0),
    ])
    lines = ["[Script Info]", "ScriptType: v4.00+", f"PlayResX: {W}", f"PlayResY: {H}", "WrapStyle: 0",
             "ScaledBorderAndShadow: yes", "", "[V4+ Styles]",
             "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, "
             "Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
             "Alignment, MarginL, MarginR, MarginV, Encoding", styles, "", "[Events]",
             "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]

    def ev(a, b, st, text):
        lines.append(f"Dialogue: 0,{ts(a)},{ts(b)},{st},,0,0,0,,{text}")

    if cfg.get("banner"):
        ev(0, clip_total, "Banner", r"{\fad(200,200)}" + cfg["banner"])
    if cfg.get("tag"):
        ev(0, clip_total, "Small", r"{\fad(200,200)}" + cfg["tag"])
    for s in subs:
        ev(s["start"], s["end"], "Sub", r"{\fad(80,80)}" + s["text"])
    if cfg.get("end_big"):
        ev(clip_total, total, "EndBig", r"{\fad(150,0)\fscx80\fscy80\t(0,220,\fscx100\fscy100)\pos(540,830)}" + cfg["end_big"])
    if cfg.get("end_small"):
        ev(clip_total + 0.25, total, "EndSmall", r"{\fad(150,0)\pos(540,1010)}" + cfg["end_small"])
    if cfg.get("end_accent"):
        ev(clip_total + 0.45, total, "EndSmall", r"{\fad(150,0)\pos(540,1110)\c" + YELLOW + r"}" + cfg["end_accent"])
    return "\n".join(lines) + "\n"


def main(cfg_path):
    cfg = json.load(open(cfg_path))
    clips = cfg["clips"]
    manual = json.load(open(cfg["captions"])) if cfg.get("captions") else None

    # 1. Transcribe each clip and pick its trim window (speech start/end with a little air).
    plan, subs, cursor = [], [], 0.0
    for i, path in enumerate(clips):
        segs = [s for s in (manual or []) if s["clip"] == i] if manual else transcribe(path, cfg.get("language"))
        dur = duration(path)
        start = max(0.0, segs[0]["start"] - 0.15) if segs else 0.0
        end = min(dur, segs[-1]["end"] + 0.35) if segs else dur
        plan.append((path, start, end))
        for s in segs:
            subs.append({"start": cursor + s["start"] - start, "end": cursor + min(s["end"], end) - start, "text": s["text"]})
        cursor += end - start
    clip_total, total = cursor, cursor + HOLD

    # 2. Normalise, trim and concatenate.
    inputs, chains = [], []
    for i, (path, a, b) in enumerate(plan):
        inputs += ["-ss", f"{a:.2f}", "-t", f"{b - a:.2f}", "-i", path]
        chains.append(f"[{i}:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},fps={FPS},setsar=1[v{i}];"
                      f"[{i}:a]aresample=48000,aformat=channel_layouts=stereo[a{i}]")
    concat = "".join(f"[v{i}][a{i}]" for i in range(len(plan))) + f"concat=n={len(plan)}:v=1:a=1[vc][ac]"

    ass = os.path.splitext(cfg["out"])[0] + ".ass"
    os.makedirs(os.path.dirname(cfg["out"]) or ".", exist_ok=True)
    open(ass, "w").write(build_ass(cfg, subs, clip_total, total))

    # 3. Grade, hold the last frame, overlay text, level the audio.
    look = ("eq=saturation=1.25:contrast=1.06:gamma=0.98,"
            "colorbalance=rs=0.06:gs=0.01:bs=-0.07:rm=0.07:bm=-0.06,vignette=PI/5,"
            f"tpad=stop_mode=clone:stop_duration={HOLD},"
            f"drawbox=x=0:y=0:w=iw:h=ih:color=black@0.62:t=fill:enable='gte(t,{clip_total:.2f})',"
            f"ass={ass}:fontsdir={FONTS}")
    audio = (f"highpass=f=80,loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=out:st={clip_total - 0.4:.2f}:d=0.4,"
             f"apad=whole_dur={total:.2f}")
    graph = ";".join(chains + [concat, f"[vc]{look}[vo]", f"[ac]{audio}[ao]"])
    run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", graph, "-map", "[vo]", "-map", "[ao]",
         "-t", f"{total:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", cfg["out"]])
    json.dump({"plan": plan, "subtitles": subs, "duration": total}, open(cfg["out"] + ".json", "w"), indent=1)
    print("done", cfg["out"], f"{total:.1f}s")


if __name__ == "__main__":
    main(sys.argv[1])
