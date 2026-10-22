"""Text overlays + word-highlight captions -> one ASS subtitle file burned in by libass.

PlayRes equals the timeline design size, so every px value in the timeline maps 1:1
and libass scales the result to the render size. Layout mirrors the canvas preview
(src/components/editor/preview/draw.ts): line height = (asc+desc)*px, centered on (x,y).
"""
from __future__ import annotations

from timeline import (CAPTION_POP, CAPTION_POP_FROM, CAPTION_REVEAL, FONTS, PUNCH_COLOR, SPARKLE_COLOR, SPARKLE_HALF,
                      SPARKLES, STAR_PATH, TEXT_ANIM, TEXT_POP_FROM, TEXT_SLIDE_PX, caption_lines, caption_look,
                      caption_style_at, clip_end, est_text_width, kinetic_place, look_segments)


def _ts(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def _color(hex_color: str) -> str:
    h = (hex_color or "#FFFFFF").lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H{b}{g}{r}&".upper()


def _alpha(opacity: float) -> str:
    return f"&H{int(round((1 - max(0.0, min(1.0, opacity))) * 255)):02X}&"


def _escape(text: str) -> str:
    return (text.replace("\\", "⧵").replace("{", "(").replace("}", ")")
            .replace("\r", "").replace("\n", "\\N"))


def _font_tags(font_id: str, px: float) -> str:
    f = FONTS[font_id]
    size = px * (f["asc"] + f["desc"])
    return f"\\fn{f['ass']}\\fs{size:.1f}\\b{1 if f['bold'] else 0}\\i{1 if f.get('italic') else 0}"


HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Text,Inter ExtraBold,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1
Style: Box,Inter ExtraBold,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _text_events(clip, W, H, layer):
    st = clip["style"]
    text = clip["text"].upper() if st.get("uppercase") else clip["text"]
    if not text.strip():
        return []
    x, y = st["x"] * W, st["y"] * H
    boxed = bool(st.get("background"))
    base = _font_tags(st["font"], st["size"]) + f"\\1c{_color(st['color'])}"
    if st.get("letterSpacing"):
        base += f"\\fsp{float(st['letterSpacing']):.1f}"
    if boxed:
        base += f"\\bord{max(4, round(st['size'] * 0.25))}\\3c{_color(st['background'])}\\3a{_alpha(0.85)}\\shad0"
    else:
        base += (f"\\bord{st.get('outline', 0)}\\3c{_color(st.get('outlineColor', '#000000'))}"
                 f"\\shad{st.get('shadow', 0)}\\4c&H000000&\\4a&H80&")
    style = "Box" if boxed else "Text"
    body = _escape(text)
    start, end = clip["start"], clip_end(clip)
    d = min(TEXT_ANIM, clip["duration"] / 3)
    a_in, a_out = clip.get("animIn", "none"), clip.get("animOut", "none")
    in_end = start + d if a_in != "none" else start
    out_start = end - d if a_out != "none" else end
    ms = int(round(d * 1000))
    events = []

    def ev(s, e, tags):
        if e - s > 0.005:
            events.append(f"Dialogue: {layer},{_ts(s)},{_ts(e)},{style},,0,0,0,,{{\\an5{base}{tags}}}{body}")

    if a_in != "none":
        tags = f"\\fad({ms},0)"
        if a_in == "slide-up":
            tags += f"\\move({x:.1f},{y + TEXT_SLIDE_PX:.1f},{x:.1f},{y:.1f},0,{ms})"
        else:
            tags += f"\\pos({x:.1f},{y:.1f})"
        if a_in == "pop":
            p = int(TEXT_POP_FROM * 100)
            tags += f"\\fscx{p}\\fscy{p}\\t(0,{ms},\\fscx100\\fscy100)"
        ev(start, in_end, tags)
    ev(in_end, out_start, f"\\pos({x:.1f},{y:.1f})")
    if a_out != "none":
        tags = f"\\fad(0,{ms})"
        if a_out == "slide-down":
            tags += f"\\move({x:.1f},{y:.1f},{x:.1f},{y + TEXT_SLIDE_PX:.1f},0,{ms})"
        else:
            tags += f"\\pos({x:.1f},{y:.1f})"
        if a_out == "pop":
            p = int(TEXT_POP_FROM * 100)
            tags += f"\\t(0,{ms},\\fscx{p}\\fscy{p})"
        ev(out_start, end, tags)
    if st.get("sparkles"):
        events += _sparkle_events(clip, text, W, H, layer, ms if a_in != "none" else 0, ms if a_out != "none" else 0)
    return events


def _sparkle_events(clip, text, W, H, layer, fade_in_ms, fade_out_ms):
    """Twinkling four-point stars at the corners of the estimated text box (draw.ts drawSparkles)."""
    st = clip["style"]
    f = FONTS[st["font"]]
    lines = text.split("\n")
    hw = max(est_text_width(ln, st["font"], st["size"], st.get("letterSpacing", 0), st.get("uppercase", False))
             for ln in lines) / 2
    hh = len(lines) * (f["asc"] + f["desc"]) * st["size"] / 2
    cx, cy = st["x"] * W, st["y"] * H
    start, end = clip["start"], clip_end(clip)
    dur = end - start
    out = []
    for dx, dy, ox, oy, size, phase in SPARKLES:
        x, y = cx + dx * hw + ox, cy + dy * hh + oy

        def tags_at(v):
            sc = size / 40 * (0.6 + 0.4 * v) * 100
            return f"\\1a{_alpha(0.25 + 0.75 * v)}\\fscx{sc:.1f}\\fscy{sc:.1f}"

        level = lambda m: 1.0 if (m + phase) % 2 == 0 else 0.0  # noqa: E731  boundary m = start + m * SPARKLE_HALF
        seq = tags_at(level(0))
        m = 0
        while m * SPARKLE_HALF < dur:
            a, b = m * SPARKLE_HALF, min(dur, (m + 1) * SPARKLE_HALF)
            v = level(m) + (level(m + 1) - level(m)) * (b - a) / SPARKLE_HALF
            seq += f"\\t({int(a * 1000)},{int(b * 1000)},{tags_at(v)})"
            m += 1
        fad = f"\\fad({fade_in_ms},{fade_out_ms})" if fade_in_ms or fade_out_ms else ""
        out.append(f"Dialogue: {layer},{_ts(start)},{_ts(end)},Text,,0,0,0,,"
                   f"{{\\an5\\pos({x:.1f},{y:.1f})\\bord0\\shad0\\1c{_color(SPARKLE_COLOR)}{fad}{seq}\\p1}}{STAR_PATH}{{\\p0}}")
    return out


def _word_alpha(ent: float, opacity: float) -> str:
    """Fill / outline / shadow alpha of a caption word: the entrance fades all three, the opacity the fill only."""
    return f"\\1a{_alpha(ent * opacity)}\\3a{_alpha(ent)}\\4a{_alpha(ent * 0.5)}"


def _caption_events(tl, W, H, layer):
    cap = tl["captions"]
    if not cap.get("enabled"):
        return []
    segs = look_segments(tl)
    punch = set((tl.get("looks") or {}).get("punchWords") or [])
    lines = caption_lines(tl)
    kin = 0
    events = []
    for line in lines:
        look = caption_look(caption_style_at(tl, segs, line["start"]), cap["size"])
        px = look["size"]
        x, y = W / 2, look.get("y", cap["y"]) * H
        if look.get("layout") == "kinetic":
            kx, ky, scale = kinetic_place(line, kin, look, W)
            kin += 1
            x, y, px = kx * W, ky * H, look["size"] * scale
        base = _font_tags(look["font"], px)
        if look.get("letterSpacing"):
            base += f"\\fsp{float(look['letterSpacing']):.1f}"
        if look["box"]:
            style = "Box"
            base += (f"\\bord{look['box']['pad']}\\3c{_color(look['box']['color'])}"
                     f"\\3a{_alpha(look['box']['opacity'])}\\shad0")
        else:
            style = "Text"
            base += (f"\\bord{look['outline']}\\3c{_color(look['outlineColor'])}"
                     f"\\shad{look['shadow']}\\4c&H000000&\\4a&H80&")
        fade = look.get("lineFade") or 0
        words = line["words"]
        for i, w in enumerate(words):
            s0 = w["start"] if i > 0 else line["start"]
            e0 = words[i + 1]["start"] if i + 1 < len(words) else line["end"]
            if e0 - s0 <= 0.005:
                continue
            ev_tags = ""
            if look.get("pop"):  # the line pops in (draw.ts: scale around the line centre)
                p0 = min(1.0, max(0.0, (s0 - line["start"]) / CAPTION_POP))
                if p0 < 1:
                    sc = (CAPTION_POP_FROM + (1 - CAPTION_POP_FROM) * p0) * 100
                    ev_tags += f"\\fscx{sc:.1f}\\fscy{sc:.1f}\\t(0,{int((1 - p0) * CAPTION_POP * 1000)},\\fscx100\\fscy100)"
            # entrance of the whole line (lineFade) at this event's start, animated to fully in
            lf0 = min(1.0, max(0.0, (s0 - line["start"]) / fade)) if fade else 1.0
            lf_ms = int(max(0.0, line["start"] + fade - s0) * 1000) if fade else 0
            parts = []
            for j, ww in enumerate(words):
                state = "past" if j < i else "active" if j == i else "future"
                color, opacity = look["word"][state]
                if ww["id"] in punch:
                    color = PUNCH_COLOR
                txt = ww["text"].upper() if look["uppercase"] else ww["text"].lower() if look.get("lowercase") else ww["text"]
                if look.get("reveal"):
                    if state == "future":
                        tags = _word_alpha(0, opacity)
                    elif state == "active":  # fades in over CAPTION_REVEAL from the event start
                        tags = _word_alpha(0, opacity) + f"\\t(0,{int(CAPTION_REVEAL * 1000)},{_word_alpha(1, opacity)})"
                    else:
                        tags = _word_alpha(1, opacity)
                elif lf0 < 1:
                    tags = _word_alpha(lf0, opacity) + f"\\t(0,{lf_ms},{_word_alpha(1, opacity)})"
                elif look["box"] or opacity != 1 or look.get("lineFade"):
                    tags = f"\\1a{_alpha(opacity)}" if look["box"] else _word_alpha(1, opacity)
                else:
                    tags = f"\\1a{_alpha(opacity)}"
                parts.append(f"{{\\1c{_color(color)}{tags}}}{_escape(txt)}")
            events.append(f"Dialogue: {layer},{_ts(s0)},{_ts(e0)},{style},,0,0,0,,"
                          f"{{\\an5\\pos({x:.1f},{y:.1f}){base}{ev_tags}}}" + " ".join(parts))
    return events


def build_ass(tl, behind_track=None) -> str:
    """The front layer (text tracks + captions), or with behind_track only that "behind" text track."""
    W, H = tl["width"], tl["height"]
    events = []
    n = len(tl["tracks"])
    for idx, track in enumerate(tl["tracks"]):
        if track.get("hidden"):
            continue
        if behind_track is not None:
            if track is behind_track:
                for clip in sorted(track["clips"], key=lambda c: c["start"]):
                    events += _text_events(clip, W, H, 1)
            continue
        layer = n - idx  # tracks listed higher in the editor draw on top
        if track["kind"] == "text" and not track.get("behind"):
            for clip in sorted(track["clips"], key=lambda c: c["start"]):
                events += _text_events(clip, W, H, layer)
        elif track["kind"] == "captions":
            events += _caption_events(tl, W, H, layer)
    return HEADER.format(W=W, H=H) + "\n".join(events) + "\n"
