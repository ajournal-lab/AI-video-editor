"""Animated inserts: full-frame transparent VP9 webm layers drawn with Pillow, CPU only.

Kinds (spec = InsertSpec in src/lib/timeline/types.ts):
  app_screen   an app screenshot / screen recording in a phone, sliding up behind the speaker (placed under the Cut-out)
  follow_cta   a profile card: avatar, name, @handle and a Follow button a cursor taps ("Following")
  scroll_file  a document / long screenshot in a page card that scrolls top to bottom
  ui_demo      a UI screenshot with a cursor moving between taps, click ripples and a gentle zoom toward each tap
  orbit        the user's own reels orbiting the speaker: two layers, back.webm (behind the speaker) + front.webm

  python inserts.py build --spec SPEC.json --out DIR      -> DIR/out.webm (+ DIR/front.webm for orbit)
Prints "PROGRESS 0.42" lines for the worker's insert pool (worker/main.py) and "DONE {json}" at the end.
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter, ImageFont  # noqa: E402

from media import ffmpeg_bin  # noqa: E402

FONTS = Path(__file__).resolve().parent.parent / "public" / "fonts"
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}


def font(px: int, bold=True):
    return ImageFont.truetype(str(FONTS / ("Inter-ExtraBold.ttf" if bold else "Inter-Bold.ttf")), px)


# ------------------------------------------------------------------ easing

def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def ease_out(t):
    t = clamp(t)
    return 1 - (1 - t) ** 3


def ease_in_out(t):
    t = clamp(t)
    return 4 * t ** 3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def ease_out_back(t, s=1.6):
    t = clamp(t)
    return 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2


def envelope(t, dur, a=0.45, b=0.35):
    """0 -> 1 entrance over a s, 1 -> 0 exit over the last b s."""
    return clamp(t / a) if t < a else clamp((dur - t) / b) if t > dur - b else 1.0


# ------------------------------------------------------------------ media

def load_image(path: str) -> Image.Image:
    return Image.open(path).convert("RGBA")


def video_frames(path: str, w: int, h: int, fps: int, n: int, fit="cover") -> list[Image.Image]:
    """n frames of a video scaled to w x h (cover crop), looping a short source."""
    vf = (f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}" if fit == "cover"
          else f"scale={w}:-2")
    r = subprocess.run([ffmpeg_bin(), "-v", "error", "-stream_loop", "-1", "-i", path, "-t", f"{n / fps + 0.2:.3f}",
                        "-vf", f"fps={fps},{vf},format=rgb24", "-f", "rawvideo", "-"], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"can't read {path}: {r.stderr.decode(errors='replace')[-300:]}")
    hh = h if fit == "cover" else len(r.stdout) // (w * 3) // max(1, n)
    size = w * hh * 3
    frames = [Image.frombuffer("RGB", (w, hh), r.stdout[i * size:(i + 1) * size]).convert("RGBA")
              for i in range(min(n, len(r.stdout) // size))]
    if not frames:
        raise RuntimeError(f"no frames in {path}")
    while len(frames) < n:
        frames.append(frames[len(frames) % len(frames)])
    return frames


def cover(img: Image.Image, w: int, h: int, top=True) -> Image.Image:
    s = max(w / img.width, h / img.height)
    im = img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)
    x = (im.width - w) // 2
    y = 0 if top else (im.height - h) // 2
    return im.crop((x, y, x + w, y + h))


def fit_width(img: Image.Image, w: int) -> Image.Image:
    return img.resize((w, max(1, round(img.height * w / img.width))), Image.LANCZOS)


def rounded_mask(w: int, h: int, r: int) -> Image.Image:
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), r, fill=255)
    return m


def shadow(w: int, h: int, r: int, blur=28, alpha=150, pad=60) -> Image.Image:
    s = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    ImageDraw.Draw(s).rounded_rectangle((pad, pad + 18, pad + w, pad + h + 18), r, fill=(0, 0, 0, alpha))
    return s.filter(ImageFilter.GaussianBlur(blur))


def paste_scaled(canvas: Image.Image, layer: Image.Image, cx: float, cy: float, scale=1.0, opacity=1.0):
    """Composite `layer` centred at (cx, cy) with a scale and opacity."""
    if opacity <= 0.003 or scale <= 0.01:
        return
    if abs(scale - 1) > 1e-3:
        layer = layer.resize((max(1, round(layer.width * scale)), max(1, round(layer.height * scale))), Image.BILINEAR)
    if opacity < 0.999:
        a = layer.getchannel("A").point(lambda v: int(v * opacity))
        layer = layer.copy()
        layer.putalpha(a)
    canvas.alpha_composite(layer, (round(cx - layer.width / 2), round(cy - layer.height / 2)))


def cursor_icon(size=64) -> Image.Image:
    """A white arrow cursor with a dark outline and soft shadow (tip at the top-left corner + 8 px)."""
    s = Image.new("RGBA", (size + 16, size + 16), (0, 0, 0, 0))
    pts = [(8, 8), (8, 8 + size * 0.78), (8 + size * 0.22, 8 + size * 0.6), (8 + size * 0.36, 8 + size * 0.9),
           (8 + size * 0.47, 8 + size * 0.85), (8 + size * 0.33, 8 + size * 0.56), (8 + size * 0.6, 8 + size * 0.56)]
    sh = Image.new("RGBA", s.size, (0, 0, 0, 0))
    ImageDraw.Draw(sh).polygon([(x + 3, y + 4) for x, y in pts], fill=(0, 0, 0, 110))
    s.alpha_composite(sh.filter(ImageFilter.GaussianBlur(3)))
    d = ImageDraw.Draw(s)
    d.polygon(pts, fill=(255, 255, 255, 255), outline=(20, 20, 20, 255))
    d.line(pts + [pts[0]], fill=(20, 20, 20, 255), width=3)
    return s


# ------------------------------------------------------------------ encoder

class Writer:
    """RGBA frames -> VP9 with alpha (yuva420p): plays transparent in Chrome; the render decodes it with libvpx."""

    def __init__(self, path: Path, w: int, h: int, fps: int):
        self.p = subprocess.Popen(
            [ffmpeg_bin(), "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps),
             "-i", "-", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30", "-deadline", "realtime",
             "-cpu-used", "8", "-row-mt", "1", "-auto-alt-ref", "0", "-metadata:s:v:0", "alpha_mode=1", str(path)],
            stdin=subprocess.PIPE, stderr=subprocess.PIPE)

    def add(self, img: Image.Image):
        assert self.p.stdin
        self.p.stdin.write(img.tobytes())

    def close(self):
        assert self.p.stdin
        self.p.stdin.close()
        err = self.p.stderr.read().decode(errors="replace") if self.p.stderr else ""
        if self.p.wait() != 0:
            raise RuntimeError("encode failed: " + err[-500:])


def progress(p: float):
    print(f"PROGRESS {p:.3f}", flush=True)


# ------------------------------------------------------------------ kinds

def app_screen(spec, src, W, H, fps, n, out: Path):
    """The app in a phone behind the speaker: slides up with a little overshoot, floats, slides back down."""
    pw, ph = int(W * 0.56), int(W * 0.56 * 2.08)
    bez = 18
    sw, sh = pw - bez * 2, ph - bez * 2
    phone = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    ImageDraw.Draw(phone).rounded_rectangle((0, 0, pw - 1, ph - 1), 74, fill=(14, 14, 16, 255), outline=(70, 70, 76, 255), width=4)
    smask = rounded_mask(sw, sh, 58)
    shad = shadow(pw, ph, 74)
    if spec.get("srcType") == "video" or Path(src).suffix.lower() not in IMAGE_EXT:
        screens = video_frames(src, sw, sh, fps, n)
        scroll = None
    else:
        img = fit_width(load_image(src), sw)
        screens, scroll = None, img if img.height > sh * 1.15 else None
        still = cover(img, sw, sh)
    island = Image.new("RGBA", (int(sw * 0.3), 34), (0, 0, 0, 0))
    ImageDraw.Draw(island).rounded_rectangle((0, 0, island.width - 1, 33), 17, fill=(0, 0, 0, 255))
    dur = n / fps
    w = Writer(out, W, H, fps)
    for i in range(n):
        t = i / fps
        if screens:
            scr = screens[i]
        elif scroll is not None:  # a long screenshot scrolls while it is on screen
            y = int((scroll.height - sh) * ease_in_out((t - 0.6) / max(0.5, dur - 1.2)))
            scr = scroll.crop((0, y, sw, y + sh))
        else:
            scr = still
        dev = phone.copy()
        dev.paste(scr.convert("RGBA"), (bez, bez), smask)
        dev.alpha_composite(island, ((pw - island.width) // 2, bez + 16))
        a_in = ease_out_back(t / 0.55, 1.2)
        a_out = ease_in_out((t - (dur - 0.4)) / 0.4)
        rise = (1 - a_in) * H * 0.55 + a_out * H * 0.55
        float_y = math.sin(t * 2 * math.pi / 3.2) * 10
        cx, cy = W * 0.5, H * 0.42 + rise + float_y
        frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        paste_scaled(frame, shad, cx, cy + 10, 1.0, 0.85 * clamp(t / 0.3))
        paste_scaled(frame, dev, cx, cy, 0.94 + 0.06 * clamp(a_in))
        w.add(frame)
        if i % 10 == 0:
            progress(i / n)
    w.close()


def follow_cta(spec, avatar, W, H, fps, n, out: Path):
    """Profile card: pops in, a cursor glides to Follow and taps it, the button turns into Following."""
    cw, ch = int(W * 0.78), 230
    handle = "@" + str(spec.get("handle") or "yourhandle").lstrip("@")
    name = str(spec.get("name") or handle.lstrip("@"))
    card = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
    ImageDraw.Draw(card).rounded_rectangle((0, 0, cw - 1, ch - 1), 44, fill=(255, 255, 255, 250))
    av = 150
    if avatar:
        a = cover(load_image(avatar), av, av, top=False)
    else:
        a = Image.new("RGBA", (av, av), (0, 0, 0, 0))
        g = np.zeros((av, av, 4), np.uint8)
        yy, xx = np.mgrid[0:av, 0:av]
        k = (xx + yy) / (2 * av)
        g[..., 0] = (124 + (236 - 124) * k).astype(np.uint8)
        g[..., 1] = (58 + (72 - 58) * k).astype(np.uint8)
        g[..., 2] = (237 + (153 - 237) * k).astype(np.uint8)
        g[..., 3] = 255
        a = Image.fromarray(g, "RGBA")
        d = ImageDraw.Draw(a)
        d.text((av / 2, av / 2), handle[1:2].upper(), font=font(70), fill="white", anchor="mm")
    ring = Image.new("RGBA", (av + 12, av + 12), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse((0, 0, av + 11, av + 11), fill=(236, 72, 153, 255))
    m = Image.new("L", (av, av), 0)
    ImageDraw.Draw(m).ellipse((0, 0, av - 1, av - 1), fill=255)
    ring.paste(a, (6, 6), m)
    card.alpha_composite(ring, (40, (ch - ring.height) // 2))
    d = ImageDraw.Draw(card)
    tx = 40 + ring.width + 28
    d.text((tx, 70), name[:22], font=font(46), fill=(17, 17, 17), anchor="lm")
    d.text((tx, 128), handle[:26], font=font(36, bold=False), fill=(110, 110, 118), anchor="lm")
    bw, bh = 250, 92
    bx, by = cw - bw - 36, (ch - bh) // 2

    def button(following: bool, press: float):
        b = Image.new("RGBA", (bw, bh), (0, 0, 0, 0))
        bd = ImageDraw.Draw(b)
        bd.rounded_rectangle((0, 0, bw - 1, bh - 1), 26, fill=(239, 239, 242, 255) if following else (0, 149, 246, 255))
        bd.text((bw / 2, bh / 2), "Following" if following else "Follow", font=font(38),
                fill=(17, 17, 17) if following else (255, 255, 255), anchor="mm")
        return b.resize((round(bw * press), round(bh * press)), Image.BILINEAR) if press != 1 else b

    cur = cursor_icon(70)
    dur = n / fps
    tap = min(max(1.4, dur * 0.45), dur - 0.8)
    cx, cy = W / 2, H * 0.6
    btn_c = (cx - cw / 2 + bx + bw / 2, cy - ch / 2 + by + bh / 2)
    w = Writer(out, W, H, fps)
    for i in range(n):
        t = i / fps
        frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        env = envelope(t, dur, 0.4, 0.35)
        sc = ease_out_back(t / 0.45) if t < 0.45 else 1.0
        c = card.copy()
        press = 1 - 0.12 * math.sin(math.pi * clamp((t - tap + 0.08) / 0.24)) if tap - 0.08 < t < tap + 0.16 else 1.0
        bimg = button(t >= tap, press)
        c.alpha_composite(bimg, (bx + (bw - bimg.width) // 2, by + (bh - bimg.height) // 2))
        paste_scaled(frame, shadow(cw, ch, 44, 22, 120), cx, cy + 8, sc, env * 0.8)
        paste_scaled(frame, c, cx, cy, sc, env)
        # cursor: glides in from the lower right, taps, drifts away
        p = ease_in_out((t - (tap - 0.9)) / 0.85)
        x = btn_c[0] + (1 - p) * W * 0.35 + 24 * clamp((t - tap - 0.25) / 0.6)
        y = btn_c[1] + (1 - p) * H * 0.12 + 18 * clamp((t - tap - 0.25) / 0.6)
        if t > tap - 1.0:
            ripple = clamp((t - tap) / 0.45)
            if 0 < ripple < 1:
                rr = int(20 + 70 * ripple)
                rl = Image.new("RGBA", (rr * 2 + 4, rr * 2 + 4), (0, 0, 0, 0))
                ImageDraw.Draw(rl).ellipse((2, 2, rr * 2 + 2, rr * 2 + 2), outline=(255, 255, 255, int(220 * (1 - ripple))), width=6)
                frame.alpha_composite(rl, (int(btn_c[0] - rr - 2), int(btn_c[1] - rr - 2)))
            k = 0.88 if tap - 0.06 < t < tap + 0.12 else 1.0
            ci = cur if k == 1 else cur.resize((int(cur.width * k), int(cur.height * k)))
            a = env * clamp((t - (tap - 1.0)) / 0.25)
            if a > 0.01:
                if a < 1:
                    ci = ci.copy()
                    ci.putalpha(ci.getchannel("A").point(lambda v: int(v * a)))
                frame.alpha_composite(ci, (int(x - 8), int(y - 8)))
        w.add(frame)
        if i % 10 == 0:
            progress(i / n)
    w.close()


def page_card(W, title: str):
    pw = int(W * 0.8)
    ph = int(pw * 1.3)
    bar = 92
    card = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    d = ImageDraw.Draw(card)
    d.rounded_rectangle((0, 0, pw - 1, ph - 1), 36, fill=(255, 255, 255, 255))
    d.rounded_rectangle((0, 0, pw - 1, bar + 36), 36, fill=(245, 245, 247, 255))
    d.rectangle((0, bar, pw - 1, bar + 36), fill=(255, 255, 255, 255))
    for k, col in enumerate([(255, 95, 87), (255, 189, 46), (40, 200, 64)]):
        d.ellipse((34 + k * 40, bar / 2 - 12, 58 + k * 40, bar / 2 + 12), fill=col)
    d.text((pw / 2, bar / 2), title[:34], font=font(32, bold=False), fill=(80, 80, 88), anchor="mm")
    d.line((0, bar, pw, bar), fill=(225, 225, 230), width=2)
    return card, pw, ph, bar


def scroll_file(spec, src, W, H, fps, n, out: Path):
    """A long document scrolling inside a page card (top -> bottom, eased), card pops in and fades out."""
    card, pw, ph, bar = page_card(W, spec.get("title") or "Document")
    vw, vh = pw - 48, ph - bar - 24
    doc = fit_width(load_image(src), vw)
    if doc.height < vh:
        pad = Image.new("RGBA", (vw, vh), (255, 255, 255, 255))
        pad.alpha_composite(doc, (0, 0))
        doc = pad
    vmask = rounded_mask(vw, vh, 20)
    dur = n / fps
    w = Writer(out, W, H, fps)
    for i in range(n):
        t = i / fps
        y = int((doc.height - vh) * ease_in_out((t - 0.7) / max(0.5, dur - 1.4)))
        c = card.copy()
        c.paste(doc.crop((0, y, vw, y + vh)), (24, bar + 6), vmask)
        # scrollbar
        if doc.height > vh:
            d = ImageDraw.Draw(c)
            th = max(60, int(vh * vh / doc.height))
            ty = bar + 6 + int((vh - th) * y / max(1, doc.height - vh))
            d.rounded_rectangle((pw - 18, ty, pw - 10, ty + th), 4, fill=(0, 0, 0, 90))
        env = envelope(t, dur, 0.4, 0.35)
        frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sc = 0.9 + 0.1 * ease_out(t / 0.4)
        paste_scaled(frame, shadow(pw, ph, 36), W / 2, H * 0.46 + 10, sc, env * 0.8)
        paste_scaled(frame, c, W / 2, H * 0.46, sc, env)
        w.add(frame)
        if i % 10 == 0:
            progress(i / n)
    w.close()


def ui_demo(spec, src, W, H, fps, n, out: Path):
    """A UI screenshot: the cursor moves to each tap, clicks (ripple) while the view zooms gently toward it."""
    img = load_image(src)
    vw = int(W * 0.84)
    vh = min(int(H * 0.62), round(img.height * vw / img.width))
    shot = cover(fit_width(img, vw), vw, vh) if img.height * vw / img.width > vh else fit_width(img, vw)
    vh = shot.height
    mask = rounded_mask(vw, vh, 34)
    dur = n / fps
    taps = sorted(spec.get("taps") or [], key=lambda p: p["t"])
    if not taps:
        taps = [{"t": dur * 0.3, "x": 0.3, "y": 0.35}, {"t": dur * 0.55, "x": 0.7, "y": 0.55}, {"t": dur * 0.8, "x": 0.45, "y": 0.8}]
    cur = cursor_icon(64)
    cx, cy = W / 2, H * 0.45
    w = Writer(out, W, H, fps)
    for i in range(n):
        t = i / fps
        # cursor position: glide between taps (eased), parked at the first tap's start before it
        prev = {"t": 0.0, "x": 0.85, "y": 0.95}
        nxt = taps[0]
        for tp in taps:
            if tp["t"] <= t:
                prev = tp
            else:
                nxt = tp
                break
        else:
            nxt = prev
        span = max(0.01, nxt["t"] - prev["t"])
        p = ease_in_out((t - prev["t"]) / min(span, 0.8)) if nxt is not prev else 1.0
        px = prev["x"] + (nxt["x"] - prev["x"]) * p
        py = prev["y"] + (nxt["y"] - prev["y"]) * p
        # zoom toward the latest tap, easing back out between taps
        z = 1.0
        for tp in taps:
            u = (t - tp["t"]) / 0.9
            if -0.4 < u < 1:
                z = max(z, 1 + 0.12 * math.sin(math.pi * clamp((u + 0.4) / 1.4)))
        view = Image.new("RGBA", (vw, vh), (0, 0, 0, 0))
        if z > 1.001:
            zw, zh = vw / z, vh / z
            fx = clamp(px * vw - zw / 2, 0, vw - zw)
            fy = clamp(py * vh - zh / 2, 0, vh - zh)
            view.paste(shot.crop((int(fx), int(fy), int(fx + zw), int(fy + zh))).resize((vw, vh), Image.BILINEAR), (0, 0))
            sx, sy = (px * vw - fx) * z, (py * vh - fy) * z
        else:
            view.paste(shot, (0, 0))
            sx, sy = px * vw, py * vh
        framed = Image.new("RGBA", (vw, vh), (0, 0, 0, 0))
        framed.paste(view, (0, 0), mask)
        d = ImageDraw.Draw(framed)
        for tp in taps:
            r = (t - tp["t"]) / 0.5
            if 0 <= r < 1:
                rr = int(18 + 60 * r)
                tx = sx if tp is prev else tp["x"] * vw
                ty = sy if tp is prev else tp["y"] * vh
                d.ellipse((tx - rr, ty - rr, tx + rr, ty + rr), outline=(124, 58, 237, int(230 * (1 - r))), width=7)
        env = envelope(t, dur, 0.4, 0.35)
        frame = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        sc = 0.92 + 0.08 * ease_out(t / 0.4)
        paste_scaled(frame, shadow(vw, vh, 34), cx, cy + 10, sc, env * 0.8)
        paste_scaled(frame, framed, cx, cy, sc, env)
        if env > 0.01:
            ox = cx - vw * sc / 2 + sx * sc
            oy = cy - vh * sc / 2 + sy * sc
            k = 0.88 if any(abs(t - tp["t"]) < 0.08 for tp in taps) else 1.0
            ci = cur if k == 1 else cur.resize((int(cur.width * k), int(cur.height * k)))
            if env < 1:
                ci = ci.copy()
                ci.putalpha(ci.getchannel("A").point(lambda v: int(v * env)))
            frame.alpha_composite(ci, (int(ox - 8), int(oy - 8)))
        w.add(frame)
        if i % 10 == 0:
            progress(i / n)
    w.close()


def orbit(spec, sources, W, H, fps, n, out: Path, front_out: Path):
    """The user's reels as rounded 9:16 tiles on a tilted ellipse around the speaker. Tiles on the far side go to
    back.webm (under the Cut-out, smaller and dimmer), the near side to front.webm (over the speaker)."""
    k = len(sources)
    tw, th = 210, 374
    tiles = []
    for i, src in enumerate(sources):
        if Path(src).suffix.lower() in IMAGE_EXT:
            frames = [cover(load_image(src), tw, th)] * n
        else:
            frames = video_frames(src, tw, th, fps, n)
        tiles.append(frames)
        progress(0.3 * (i + 1) / k)
    mask = rounded_mask(tw, th, 26)
    border = Image.new("RGBA", (tw + 12, th + 12), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle((0, 0, tw + 11, th + 11), 32, fill=(255, 255, 255, 235))
    dur = n / fps
    period = 7.0
    cx, cy, rx, ry, tilt = W * 0.5, H * 0.45, W * 0.36, H * 0.08, -0.12
    back = Writer(out, W, H, fps)
    front = Writer(front_out, W, H, fps)
    for i in range(n):
        t = i / fps
        env = envelope(t, dur, 0.6, 0.5)
        fb = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ff = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        items = []
        for j in range(k):
            ang = 2 * math.pi * (t / period + j / k) + (1 - ease_out(t / 0.8)) * 1.2
            x = math.cos(ang) * rx
            y = math.sin(ang) * ry
            depth = math.sin(ang)  # +1 nearest the camera
            items.append((depth, j, cx + x * math.cos(tilt) - y * math.sin(tilt), cy + x * math.sin(tilt) + y * math.cos(tilt)))
        for depth, j, x, y in sorted(items):
            tile = border.copy()
            tile.paste(tiles[j][i], (6, 6), mask)
            sc = 0.72 + 0.28 * (depth + 1) / 2
            if depth < 0:
                dim = Image.new("RGBA", tile.size, (0, 0, 0, int(90 * -depth)))
                tile = Image.alpha_composite(tile, Image.composite(dim, Image.new("RGBA", tile.size, (0, 0, 0, 0)), tile.getchannel("A")))
            paste_scaled(ff if depth >= 0 else fb, tile, x, y, sc * (0.6 + 0.4 * ease_out(t / 0.6)), env)
        back.add(fb)
        front.add(ff)
        if i % 10 == 0:
            progress(0.3 + 0.7 * i / n)
    back.close()
    front.close()


def build(spec: dict, out_dir: Path, resolve) -> dict:
    W, H, fps = int(spec.get("width", 1080)), int(spec.get("height", 1920)), int(spec.get("fps", 30))
    n = max(2, round(float(spec["duration"]) * fps))
    kind = spec["kind"]
    out = out_dir / "out.webm"
    res = {"out": str(out)}
    if kind == "app_screen":
        app_screen(spec, resolve(spec["src"]), W, H, fps, n, out)
    elif kind == "follow_cta":
        follow_cta(spec, resolve(spec["avatar"]) if spec.get("avatar") else None, W, H, fps, n, out)
    elif kind == "scroll_file":
        scroll_file(spec, resolve(spec["src"]), W, H, fps, n, out)
    elif kind == "ui_demo":
        ui_demo(spec, resolve(spec["src"]), W, H, fps, n, out)
    elif kind == "orbit":
        srcs = [resolve(u) for u in (spec.get("sources") or [])][:6]
        if not srcs:
            raise RuntimeError("no reels to orbit")
        front = out_dir / "front.webm"
        orbit(spec, srcs, W, H, fps, n, out, front)
        res["front"] = str(front)
    else:
        raise RuntimeError(f"unknown insert kind {kind}")
    progress(1)
    return res


def _load_env():
    """../.env for standalone runs (the worker passes its environment on)."""
    import os
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["build"])
    ap.add_argument("--spec", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    _load_env()
    import storage  # noqa: E402
    spec = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    cache = Path(tempfile.mkdtemp(prefix="rs-insert-media-"))
    res = build(spec, out, lambda u: storage.fetch(u, cache))
    print("DONE " + json.dumps(res), flush=True)


if __name__ == "__main__":
    main()
