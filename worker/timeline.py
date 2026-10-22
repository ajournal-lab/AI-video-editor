"""Python mirror of src/lib/timeline/derive.ts + fonts.ts.

The browser preview and this worker must agree on every derived value (caption
lines, ducking, color math, Ken Burns, text animation), so keep the two in sync.
"""
from __future__ import annotations

import re

FONTS = {
    "inter": {"ass": "Inter ExtraBold", "bold": False, "asc": 1.1079, "desc": 0.3223},
    "montserrat": {"ass": "Montserrat Thin ExtraBold", "bold": False, "asc": 1.109, "desc": 0.453},
    "bebas": {"ass": "Bebas Neue", "bold": False, "asc": 0.95, "desc": 0.35},
    "playfair": {"ass": "Playfair Display", "bold": True, "asc": 1.159, "desc": 0.251},
    "playfair-italic": {"ass": "Playfair Display", "bold": False, "italic": True, "asc": 1.159, "desc": 0.251},
    "marker": {"ass": "Permanent Marker", "bold": False, "asc": 1.1094, "desc": 0.3174},
}

CAPTION_MAX_CHARS = {"9:16": 20, "1:1": 24, "16:9": 36}
DUCK_RAMP = 0.25
TEXT_ANIM = 0.4
TEXT_SLIDE_PX = 60
TEXT_POP_FROM = 0.6


def clamp(v, lo, hi):
    return min(hi, max(lo, v))


def clip_end(c) -> float:
    return c["start"] + c["duration"]


def source_out(c) -> float:
    return c["in"] + c["duration"] * c["speed"]


def timeline_duration(tl) -> float:
    end = 0.0
    for t in tl["tracks"]:
        for c in t["clips"]:
            end = max(end, clip_end(c))
    return end


# ------------------------------------------------------------------ captions

def mapped_words(tl, apply_edits=True, tracks=None):
    out = []
    edits = tl["captions"].get("edits", {})
    for track in tracks if tracks is not None else tl["tracks"]:
        if track["kind"] != "voice" or track.get("hidden"):
            continue
        for clip in track["clips"]:
            tr = tl["transcripts"].get(clip.get("assetId") or "")
            if not tr:
                continue
            src_end = source_out(clip)
            for w in tr["words"]:
                mid = (w["start"] + w["end"]) / 2
                if mid < clip["in"] or mid >= src_end:
                    continue
                text = edits.get(w["id"], w["text"]) if apply_edits else w["text"]
                out.append({
                    "id": w["id"],
                    "text": text.strip(),
                    "start": clip["start"] + (max(w["start"], clip["in"]) - clip["in"]) / clip["speed"],
                    "end": clip["start"] + (min(w["end"], src_end) - clip["in"]) / clip["speed"],
                })
    out.sort(key=lambda w: w["start"])
    return out


_SENTENCE_END = re.compile(r"[.!?][\"')\]]?$")


def caption_lines(tl):
    words = [w for w in mapped_words(tl) if w["text"]]
    max_chars = CAPTION_MAX_CHARS[tl["aspect"]]
    segs = look_segments(tl)
    lines, cur = [], []
    cur_look = None

    def push():
        nonlocal cur
        if cur:
            lines.append({"start": cur[0]["start"], "end": cur[-1]["end"], "words": cur})
        cur = []

    for w in words:
        look = seg_look_at(segs, w["start"])
        if cur:
            last = cur[-1]
            chars = sum(len(x["text"]) + 1 for x in cur) + len(w["text"])
            max_words = tl["captions"]["maxWords"]
            if look and LOOK_CAPTIONS[look] == "kinetic":
                max_words = min(3, max_words)  # kinetic captions: at most 3 words at a time
            if (w["start"] - last["end"] > 0.6 or len(cur) >= max_words or chars > max_chars
                    or look != cur_look or _SENTENCE_END.search(last["text"])):
                push()
        if not cur:
            cur_look = look
        cur.append(w)
    push()
    for i, line in enumerate(lines):
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        if nxt and nxt["start"] - line["end"] < 0.35:
            line["end"] = nxt["start"]
        else:
            line["end"] = min(line["end"] + 0.2, nxt["start"]) if nxt else line["end"] + 0.2
    punch = punch_clips(tl)  # a look's punch line replaces the captions while it shows
    if punch:
        lines = [ln for ln in lines
                 if not any(c["start"] <= (ln["start"] + ln["end"]) / 2 < clip_end(c) for c in punch)]
    return lines


def punch_clips(tl):
    return [c for t in tl["tracks"] if t["kind"] == "text" and not t.get("hidden")
            for c in t["clips"] if c.get("role") == "punch"]


# ------------------------------------------------------------------ looks (derive.ts lookSegments)

LOOK_CAPTIONS = {"bold": "kinetic", "cool_girl": "calm", "cool_dude": "editorial"}
PUNCH_COLOR = "#FFD60A"
_LOOK_PRIORITY = {"script": 1, "chat": 2, "timeline": 3}


def look_segments(tl):
    L = tl.get("looks")
    if not L or (not L.get("default") and not L.get("sections")):
        return []
    secs = L.get("sections") or []
    T = max([timeline_duration(tl), 0.001] + [s["end"] for s in secs])
    cuts = sorted({round(x, 3) for x in [0, T] + [v for s in secs for v in (s["start"], s["end"])] if 0 <= x <= T})
    out = []
    for a, b in zip(cuts, cuts[1:]):
        if b - a < 1e-4:
            continue
        mid = (a + b) / 2
        best, bp = None, 0
        for s in secs:
            if s["start"] <= mid < s["end"]:
                p = _LOOK_PRIORITY.get(s.get("source"), 1)
                if p >= bp:
                    best, bp = s["look"], p
        look = best or L.get("default") or None
        if out and out[-1]["look"] == look and abs(out[-1]["end"] - a) < 1e-6:
            out[-1]["end"] = b
        else:
            out.append({"start": a, "end": b, "look": look})
    return out


def seg_look_at(segs, t):
    for s in segs:
        if s["start"] <= t < s["end"]:
            return s["look"]
    return segs[-1]["look"] if segs and t >= segs[-1]["end"] else None


def caption_style_at(tl, segs, t):
    look = seg_look_at(segs, t)
    return LOOK_CAPTIONS[look] if look else tl["captions"]["style"]


KINETIC_ANCHORS = [(0.3, 0.36), (0.7, 0.47), (0.31, 0.58), (0.69, 0.33), (0.3, 0.48), (0.7, 0.6)]
KINETIC_MAX_W = 0.44
CAPTION_REVEAL = 0.1
CAPTION_POP = 0.15
CAPTION_POP_FROM = 0.8
_CHAR_W = {"inter": 0.56, "montserrat": 0.62, "bebas": 0.4, "playfair": 0.52, "playfair-italic": 0.48, "marker": 0.58}


def est_text_width(text, font, px, spacing=0.0, upper=False):
    return len(text) * (_CHAR_W[font] * (1.12 if upper else 1) * px + spacing)


def kinetic_place(line, index, look, W):
    x, y = KINETIC_ANCHORS[index % len(KINETIC_ANCHORS)]
    text = " ".join(w["text"] for w in line["words"])
    est = est_text_width(text, look["font"], look["size"], look.get("letterSpacing", 0), look["uppercase"])
    return x, y, min(1.0, KINETIC_MAX_W * W / max(1.0, est))


# ------------------------------------------------------------------ sparkles (derive.ts SPARKLES)

SPARKLE_HALF = 0.45
SPARKLE_COLOR = "#FFF3B0"
SPARKLES = [(-1, -1, -28, -6, 34, 0), (1, -1, 26, 2, 24, 1), (1, 1, 14, 10, 28, 0), (-1, 1, -10, 14, 20, 1)]
STAR_PATH = "m 0 -20 b 3 -3 3 -3 20 0 b 3 3 3 3 0 20 b -3 3 -3 3 -20 0 b -3 -3 -3 -3 0 -20"


def caption_look(style: str, size: float):
    if style == "kinetic":
        return {"font": "montserrat", "size": round(size * 0.95), "uppercase": False, "lowercase": True,
                "outline": round(size * 0.07), "outlineColor": "#000000", "shadow": 0, "box": None,
                "reveal": True, "pop": True, "layout": "kinetic",
                "word": {"past": ("#FFFFFF", 1), "active": ("#FFFFFF", 1), "future": ("#FFFFFF", 1)}}
    if style == "calm":
        return {"font": "inter", "size": round(size * 0.62), "uppercase": False, "lowercase": True, "outline": 0,
                "outlineColor": "#000000", "shadow": 3, "box": None, "lineFade": 0.25, "y": 0.7,
                "word": {"past": ("#FFFFFF", 1), "active": ("#FFFFFF", 1), "future": ("#FFFFFF", 1)}}
    if style == "editorial":
        return {"font": "inter", "size": round(size * 0.4), "uppercase": True, "letterSpacing": round(size * 0.4 * 0.32),
                "outline": 0, "outlineColor": "#000000", "shadow": 2, "box": None, "lineFade": 0.2, "y": 0.78,
                "word": {"past": ("#FFFFFF", 0.92), "active": ("#FFFFFF", 0.92), "future": ("#FFFFFF", 0.92)}}
    if style == "bold":
        return {"font": "montserrat", "size": size, "uppercase": True, "outline": round(size * 0.09),
                "outlineColor": "#000000", "shadow": 0, "box": None,
                "word": {"past": ("#FFFFFF", 1), "active": ("#FFE600", 1), "future": ("#FFFFFF", 1)}}
    if style == "karaoke":
        return {"font": "inter", "size": size, "uppercase": False, "outline": round(size * 0.07),
                "outlineColor": "#000000", "shadow": 3, "box": None,
                "word": {"past": ("#4ADE80", 1), "active": ("#4ADE80", 1), "future": ("#FFFFFF", 1)}}
    if style == "minimal":
        return {"font": "inter", "size": round(size * 0.8), "uppercase": False, "outline": 0,
                "outlineColor": "#000000", "shadow": 4, "box": None,
                "word": {"past": ("#FFFFFF", 0.55), "active": ("#FFFFFF", 1), "future": ("#FFFFFF", 0.55)}}
    # boxed
    return {"font": "bebas", "size": round(size * 1.15), "uppercase": True, "outline": 0,
            "outlineColor": "#000000", "shadow": 0,
            "box": {"color": "#000000", "opacity": 0.7, "pad": round(size * 0.22)},
            "word": {"past": ("#FFFFFF", 1), "active": ("#F43F5E", 1), "future": ("#FFFFFF", 1)}}


# ------------------------------------------------------------------ audio

AUDIO_DEFAULTS = {"autoDuck": True, "sfxHeadroomDb": 6}


def audio_safety(tl):
    return {**AUDIO_DEFAULTS, **(tl.get("audio") or {})}


def clip_ducks(tl, clip) -> bool:
    """derive.ts clipDucks: music ducks under the voice (auto unless duck is false); sound effects never do."""
    if clip.get("sfx"):
        return False
    d = clip.get("duck")
    return audio_safety(tl)["autoDuck"] if d is None else bool(d)


def speech_intervals(tl):
    tracks = []
    for t in tl["tracks"]:
        if t["kind"] != "voice" or t.get("muted"):
            continue
        tracks.append({**t, "hidden": False, "clips": [c for c in t["clips"] if not c.get("muted")]})
    out = []
    for w in mapped_words(tl, apply_edits=False, tracks=tracks):
        if out and w["start"] - out[-1][1] < 0.6:
            out[-1][1] = max(out[-1][1], w["end"])
        else:
            out.append([w["start"], w["end"]])
    return out


# ------------------------------------------------------------------ color

_PRESETS = {
    "none": [1, 0, 0, 0, 1, 0, 0, 0, 1],
    "warm": [1.06, 0.04, 0, 0.02, 1.0, 0, 0, 0, 0.84],
    "cool": [0.88, 0, 0.02, 0, 0.98, 0.04, 0, 0.04, 1.12],
    "bw": [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114],
}


def _mul(a, b):
    return [sum(a[i * 3 + k] * b[k * 3 + j] for k in range(3)) for i in range(3) for j in range(3)]


def color_ops(f):
    s = f["saturation"]
    sat = [
        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
    ]
    identity = (abs(f["brightness"] - 1) < 1e-3 and abs(f["contrast"] - 1) < 1e-3
                and abs(s - 1) < 1e-3 and f["preset"] == "none")
    return {
        "slope": f["brightness"] * f["contrast"],
        "intercept": 0.5 * (1 - f["contrast"]),
        "matrix": _mul(_PRESETS[f["preset"]], sat),
        "identity": identity,
    }


# ------------------------------------------------------------------ motion

def ken_burns_exprs(kb, p: str):
    """zoompan expressions (z, fx, fy) with p = progress expression 0..1."""
    a = kb["amount"]
    d = kb["direction"]
    if d == "in":
        return f"1+{a}*{p}", "0.5", "0.5"
    if d == "out":
        return f"1+{a}*(1-{p})", "0.5", "0.5"
    if d == "left":
        return f"{1 + a}", f"(1-{p})", "0.5"
    if d == "right":
        return f"{1 + a}", p, "0.5"
    if d == "up":
        return f"{1 + a}", "0.5", f"(1-{p})"
    return f"{1 + a}", "0.5", p


# ------------------------------------------------------------------ beat effects (derive.ts fxAt)

FX_SHAKE = {"zoom": 2.2, "fx": 17, "fy": 11, "ky": 0.7, "phase": 1.3}


def fx_groups(fx, fps: int):
    """Beat effects -> groups whose windows overlap, each [start, end) in timeline seconds with its effects."""
    evs = sorted((e for e in fx or [] if e.get("duration", 0) > 0 and e.get("strength", 0) > 0), key=lambda e: e["t"])
    groups = []
    for e in evs:
        a, b = float(e["t"]), float(e["t"]) + float(e["duration"])
        if groups and a < groups[-1]["end"]:
            groups[-1]["end"] = max(groups[-1]["end"], b)
            groups[-1]["fx"].append(e)
        else:
            groups.append({"start": a, "end": b, "fx": [e]})
    return groups


def fx_exprs(group, time: str):
    """ffmpeg expressions (zoom, dx, dy, brightness) of one group at time expression `time`.

    dx/dy are fractions of the frame, unclamped (the caller clamps them to the zoom's room)."""
    zs, dx, dy, br = [], [], [], []
    for e in group["fx"]:
        t0, d, s = float(e["t"]), float(e["duration"]), float(e["strength"])
        r = f"({time}-{t0:.5f})"
        v = f"if(between({r},0,{d:.5f}),1-{r}/{d:.5f},0)"  # 0 outside the window, like derive.ts
        if e["type"] == "punch":
            zs.append(f"{s:.5f}*pow({v},2)")
        elif e["type"] == "flash":
            br.append(f"{s:.5f}*pow({v},2)")
        else:
            k = FX_SHAKE
            zs.append(f"{k['zoom'] * s:.5f}*{v}")
            dx.append(f"{s:.5f}*{v}*sin({2 * 3.141592653589793 * k['fx']:.5f}*{r})")
            dy.append(f"{k['ky'] * s:.5f}*{v}*sin({2 * 3.141592653589793 * k['fy']:.5f}*{r}+{k['phase']})")
    join = lambda xs: "+".join(xs) if xs else "0"
    return f"(1+{join(zs)})", f"({join(dx)})", f"({join(dy)})", f"min(1,{join(br)})" if br else None


def adjacent_prev(clips, clip):
    best = None
    for c in clips:
        if c["id"] != clip["id"] and abs(clip_end(c) - clip["start"]) < 0.05:
            best = c
    return best


def placement(sw, sh, W, H, tr):
    base = max(W / sw, H / sh) if tr["fit"] == "cover" else min(W / sw, H / sh)
    w = sw * base * tr["scale"]
    h = sh * base * tr["scale"]
    return {"w": w, "h": h, "x": W / 2 + tr["x"] * W - w / 2, "y": H / 2 + tr["y"] * H - h / 2}
