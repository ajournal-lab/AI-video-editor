"""Per-clip enhancement: analyse -> propose -> self-check -> ffmpeg filters (CPU only).

One engine for three callers:
  - worker/render.py applies clip["enhance"] inside the single final encode (clip_filters()),
  - the web app spawns `enhance.py frame` for before/after previews,
  - Claude runs `enhance.py analyze|check` (via <REEL_STUDIO_DIR>/tools/enhance.py) and edit-reel's build.py
    applies the same settings per shot.

Per-clip order (render and previews alike):
  [vidstabtransform] -> setpts/fps -> [denoise] -> [exposure/WB + match curve] -> user filters -> scale -> [unsharp]

Settings (clip["enhance"], all optional; a fix is applied only when "on"):
  stabilize {on, smoothing, maxShift (fraction of width), maxAngle (rad)}   two-pass vidstab, optzoom=1 (minimal crop)
  denoise   {on, method: hqdn3d|nlmeans, strength 0..1}
  sharpen   {on, amount 0..1}                                             unsharp, luma only, after scaling
  color     {on, lo, hi, gamma, gains[r,g,b]}                             levels -> gamma -> per-channel gain
  match     {on, gamma, gains[r,g,b]}                                     on top of color, toward the group look
  upscale   {on, url, srcIn, srcLen, width, height}                       Real-ESRGAN intermediate of the clip window

CLI:
  enhance.py analyze  --spec SPEC.json --out ANALYSIS.json [--clip ID ...]
  enhance.py check    --spec SPEC.json --analysis ANALYSIS.json --overrides OVERRIDES.json
  enhance.py frame    --src FILE --in S --len S --t S --settings JSON|@file --width W --out OUT.jpg [--before]
  enhance.py upscale-estimate --src FILE --in S --len S [--width 1080]
  enhance.py upscale  --src FILE --in S --len S --out OUT.mp4 [--width 1080]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from media import ffmpeg_bin, probe  # noqa: E402
import color  # noqa: E402

# ------------------------------------------------------------------ defaults
# Keep in sync with rule R36 (Enhance) of workspace/taste-checklist.md (copied to REEL_STUDIO_DIR by setup).
D = {
    "fps": 30,
    "shake_on": 0.30,          # stabilise when high-frequency jitter RMS > this % of frame width
    "stab_smoothing": 12,      # vidstab smoothing (frames each side)
    "stab_max_shift": 0.025,   # max correction, fraction of width ...
    "stab_max_angle": 0.012,   # ... and rad (~0.7 deg): worst-case crop = 2*shift + (H/W)*angle (~7% on 9:16)
    "stab_crop_max": 0.105,
    # tried in order; the gentlest (least crop) rung that cuts jitter enough wins:
    # (smoothing, maxShift, maxAngle) -> worst-case crop on 9:16 ~5.4%, 7.8%, 10.1%
    "stab_ladder": [(10, 0.02, 0.008), (16, 0.03, 0.010), (24, 0.04, 0.012)],
    "stab_gain_want": 0.35,
    "noise_on": 2.0,           # denoise when luma noise sigma (0-255) > this
    "noise_nlmeans": 4.0,      # ... nlmeans instead of hqdn3d above this sigma when the clip is dark
    "dark_median": 0.22,       # median luma below this = low light
    "soft_acutance": 0.075,    # sharpen when edge acutance below this
    "sharpen_max": 0.6,
    "target_mid": 0.42,        # exposure target for median luma after levels
    "exposure_strength": 0.6,
    "wb_strength": 0.6,
    "wb_max": 0.08,            # max per-channel gain change (0.05 with skin in frame)
    "wb_max_skin": 0.05,
    "match_strength": 0.8,
    "match_gamma_max": 0.14,
    "match_wb_max": 0.04,
    # self-check limits
    "halo_max": 0.06,          # fraction of edge pixels overshooting the unsharpened local range
    "detail_min": 0.80,        # textured-area detail kept by denoise (enhanced / original)
    "skin_detail_min": 0.85,
    "skin_hue_max": 3.0,       # degrees of skin hue shift (proposals aim for <= 2)
    "skin_hue_target": 2.0,
    "clip_hi_max": 0.006,      # extra fraction of clipped highlights
    "stab_gain_min": 0.25,     # stabilisation must cut jitter by at least 25 %
    "upscale_below": 1080,
}


def run_ff(args, **kw):
    return subprocess.run([ffmpeg_bin(), "-hide_banner", "-nostdin", "-loglevel", "error", *args], **kw)


def _num(v: float) -> str:
    return f"{v:.5f}".rstrip("0").rstrip(".")


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def src_size(path: str):
    info = probe(path)
    return info.get("width") or 0, info.get("height") or 0, info


# ------------------------------------------------------------------ filters (shared with render.py)

def on(enh, key):
    v = (enh or {}).get(key)
    return v if isinstance(v, dict) and v.get("on") else None


def curve(enh):
    """Combined color+match curve {lo, hi, gamma, gains} or None. Mirrors enhanceCurve() in derive.ts."""
    c, m = on(enh, "color"), on(enh, "match")
    if not c and not m:
        return None
    lo, hi = (c["lo"], c["hi"]) if c else (0.0, 1.0)
    gc, kc = (c["gamma"], c["gains"]) if c else (1.0, [1.0, 1.0, 1.0])
    gm, km = (m["gamma"], m["gains"]) if m else (1.0, [1.0, 1.0, 1.0])
    # (k1 * x^(1/g1))^(1/g2) * k2 = k1^(1/g2) * k2 * x^(1/(g1 g2))
    gains = [kc[i] ** (1 / gm) * km[i] for i in range(3)]
    return {"lo": lo, "hi": max(hi, lo + 0.05), "gamma": gc * gm, "gains": gains}


def curve_np(x: np.ndarray, cv) -> np.ndarray:
    """Apply a curve to float RGB (H,W,3) in 0..1."""
    if not cv:
        return x
    y = np.clip((x - cv["lo"]) / (cv["hi"] - cv["lo"]), 0, 1) ** (1 / cv["gamma"])
    return np.clip(y * np.array(cv["gains"], dtype=np.float32), 0, 1)


def curve_filter(cv) -> str | None:
    if not cv:
        return None
    lo, rng, inv = cv["lo"], cv["hi"] - cv["lo"], 1 / cv["gamma"]
    e = [f"clip(pow(clip((val/255-{_num(lo)})/{_num(rng)},0,1),{_num(inv)})*{_num(k)}*255,0,255)" for k in cv["gains"]]
    return f"lutrgb=r='{e[0]}':g='{e[1]}':b='{e[2]}'"


def denoise_filter(dn, image=False) -> str | None:
    if not dn:
        return None
    s = float(np.clip(dn.get("strength", 0.5), 0, 1))
    if dn.get("method") == "nlmeans":
        return f"nlmeans=s={_num(1 + 2 * s)}:p=7:pc=5:r=9:rc=7"
    ls = 1 + 2 * s            # luma spatial 1..3: low enough not to smear skin texture
    lt = 0 if image else 2 + 2.5 * s
    return f"hqdn3d={_num(ls)}:{_num(ls * 1.5)}:{_num(lt)}:{_num(lt * 1.5)}"


def sharpen_filter(sh) -> str | None:
    if not sh:
        return None
    a = float(np.clip(sh.get("amount", 0.4), 0, 1.0))
    return f"unsharp=5:5:{_num(a)}:5:5:0" if a > 0.01 else None   # small radius, luma only: no halos/colour fringes


def trf_cache_dir() -> Path:
    base = os.environ.get("ENHANCE_CACHE") or os.path.join(
        os.environ.get("STORAGE_DIR") or str(Path(__file__).resolve().parent.parent / "storage"), "cache", "vidstab")
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def stab_trf(path: str, t_in: float, t_len: float) -> Path:
    """vidstab pass 1 over exactly the window render reads (-ss in -t len), cached by file+window."""
    st = os.stat(path)
    key = hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|{t_in:.3f}|{t_len:.3f}".encode()).hexdigest()[:20]
    out = trf_cache_dir() / f"{key}.trf"
    if out.exists() and out.stat().st_size > 0:
        return out
    tmp = out.with_suffix(".tmp")
    run_ff(["-ss", _num(t_in), "-t", _num(t_len), "-i", path,
            "-vf", f"vidstabdetect=shakiness=6:accuracy=15:stepsize=6:result={tmp.name}", "-f", "null", "-"],
           cwd=out.parent, check=True)
    tmp.replace(out)
    return out


def stab_crop(st, w=9, h=16) -> float:
    """Worst-case crop of the static optzoom: vidstab clamps every correction to maxshift/maxangle."""
    return 2 * float(st.get("maxShift", D["stab_max_shift"])) + (h / w) * math.sin(float(st.get("maxAngle", D["stab_max_angle"])))


def stab_filter(st, trf_name: str, src_w: int) -> str:
    shift = max(4, int(round(float(st.get("maxShift", D["stab_max_shift"])) * (src_w or 1080))))
    return (f"vidstabtransform=input={trf_name}:smoothing={int(st.get('smoothing', D['stab_smoothing']))}"
            f":optzoom=1:maxshift={shift}:maxangle={_num(float(st.get('maxAngle', D['stab_max_angle'])))}"
            f":interpol=bicubic:crop=black")


def clip_filters(enh, *, path: str, t_in: float, t_len: float, src_w: int, workdir: Path, image=False):
    """Filter pieces for render.py: (pre_speed, post_fps, post_scale). Copies the trf into workdir."""
    pre, post_fps, post_scale = [], [], []
    st = on(enh, "stabilize")
    if st and not image:
        trf = stab_trf(path, t_in, t_len)
        name = f"stab_{trf.stem}.trf"
        if not (workdir / name).exists():
            shutil.copy(trf, workdir / name)
        pre.append(stab_filter(st, name, src_w))
    dn = denoise_filter(on(enh, "denoise"), image)
    if dn:
        post_fps.append(dn)
    cf = curve_filter(curve(enh))
    if cf:
        post_fps.append(cf)
    sh = sharpen_filter(on(enh, "sharpen"))
    if sh:
        post_scale.append(sh)
    return pre, post_fps, post_scale


def upscaled_source(enh, path: str, t_in: float, resolve):
    """(path, in) to read: the Real-ESRGAN intermediate when upscale is on and covers the clip window."""
    up = on(enh, "upscale")
    if not up or not up.get("url"):
        return path, t_in
    rel = t_in - float(up.get("srcIn", 0))
    if rel < -0.05:
        return path, t_in
    return resolve(up["url"]), max(0.0, rel)


# ------------------------------------------------------------------ frame decoding

def _size_for(sw, sh, width):
    width = min(width, sw) if sw else width
    return _even(width), _even(width * sh / sw) if sw else _even(width * 16 / 9)


def grab(path: str, t: float, width: int, chain: list[str] | None = None, *, win=None, cwd=None, size=None) -> np.ndarray:
    """One RGB float frame (H,W,3) at source time t. With win=(in,len) the input is read exactly like
    render does (needed for vidstab) and the frame at t is selected."""
    sw, sh, _ = src_size(path)
    W, H = size or _size_for(sw, sh, width)
    chain = list(chain or [])
    # same order as render.py: colour conversion (HDR tone-map, P3, 601, full range) + the one scale first;
    # with stabilisation the transform runs at the source size and the scale comes after it
    col = color.probe_color(path)
    stab = any(x.startswith("vidstabtransform") for x in chain)
    head = color.source_chain(col) if stab else color.source_chain(col, W, H)
    tail = [f"zscale=w={W}:h={H}:f=lanczos"] if stab else []
    if win:
        t_in, t_len = win
        args = ["-ss", _num(t_in), "-t", _num(t_len), "-i", path]
        chain = chain + [f"trim=start={_num(max(0.0, t - t_in))}", "setpts=PTS-STARTPTS"]
    else:
        args = ["-ss", _num(max(0.0, t)), "-i", path]
    vf = ",".join(head + chain + tail + ["format=rgb24"])
    p = run_ff([*args, "-vf", vf, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
               capture_output=True, cwd=cwd)
    raw = p.stdout
    if len(raw) < W * H * 3:
        raise RuntimeError(f"could not decode a frame at {t:.2f}s from {path}: {p.stderr.decode(errors='replace')[-400:]}")
    return np.frombuffer(raw[: W * H * 3], np.uint8).reshape(H, W, 3).astype(np.float32) / 255


def grab_gray_seq(path: str, t_in: float, t_len: float, width=320, chain=None, cwd=None) -> np.ndarray:
    sw, sh, _ = src_size(path)
    W, H = _size_for(sw, sh, width)
    vf = ",".join(list(chain or []) + [f"fps={D['fps']}", f"scale={W}:{H}:flags=area", "format=gray"])
    p = run_ff(["-ss", _num(t_in), "-t", _num(t_len), "-i", path, "-vf", vf, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
               capture_output=True, cwd=cwd)
    n = len(p.stdout) // (W * H)
    return np.frombuffer(p.stdout[: n * W * H], np.uint8).reshape(n, H, W).astype(np.float32)


def write_jpg(img: np.ndarray, out: Path, q=3):
    h, w = img.shape[:2]
    data = (np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8).tobytes()
    out.parent.mkdir(parents=True, exist_ok=True)
    run_ff(["-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-", "-frames:v", "1",
            "-q:v", str(q), str(out)], input=data, check=True)


# ------------------------------------------------------------------ measurements

def luma(x):
    return x[..., 0] * 0.2126 + x[..., 1] * 0.7152 + x[..., 2] * 0.0722


def _conv3(a, k):
    out = np.zeros((a.shape[0] - 2, a.shape[1] - 2), np.float32)
    for dy in range(3):
        for dx in range(3):
            if k[dy][dx]:
                out += k[dy][dx] * a[dy: dy + a.shape[0] - 2, dx: dx + a.shape[1] - 2]
    return out


def grad_mag(y):
    gx = _conv3(y, [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]])
    gy = _conv3(y, [[-1, -2, -1], [0, 0, 0], [1, 2, 1]])
    return np.sqrt(gx * gx + gy * gy)


def laplacian_abs(y):
    return np.abs(_conv3(y, [[0, 1, 0], [1, -4, 1], [0, 1, 0]]))


def noise_sigma(y255: np.ndarray) -> float:
    """Immerkaer's fast noise estimate on flat areas (luma 0..255)."""
    m = _conv3(y255, [[1, -2, 1], [-2, 4, -2], [1, -2, 1]])
    g = grad_mag(y255)
    flat = g < np.percentile(g, 50)
    # exclude crushed/clipped pixels, where noise is invisible anyway
    yc = y255[1:-1, 1:-1]
    flat &= (yc > 12) & (yc < 243)
    if flat.sum() < 500:
        return 0.0
    return float(math.sqrt(math.pi / 2) * np.abs(m[flat]).mean() / 6)


def acutance(y: np.ndarray) -> float:
    """Mean gradient of the strongest 5% edges (luma 0..1, ~1080-wide frames)."""
    g = grad_mag(y)
    thr = np.percentile(g, 95)
    return float(g[g >= thr].mean() / 4)


def skin_mask(x: np.ndarray) -> np.ndarray:
    r, g, b = x[..., 0] * 255, x[..., 1] * 255, x[..., 2] * 255
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    return (y > 45) & (y < 235) & (cb > 77) & (cb < 127) & (cr > 135) & (cr < 173) & (r > g) & (r > b)


def skin_hue(x: np.ndarray, mask: np.ndarray):
    if mask.sum() < 200:
        return None
    r, g, b = (x[..., i][mask] * 255 for i in range(3))
    cb = (128 - 0.168736 * r - 0.331264 * g + 0.5 * b).mean() - 128
    cr = (128 + 0.5 * r - 0.418688 * g - 0.081312 * b).mean() - 128
    return math.degrees(math.atan2(cr, cb)), math.hypot(cr, cb)


def neutral_cast(x: np.ndarray, skin: np.ndarray):
    """Mean R/G and B/G over near-neutral midtone pixels (grey-world fallback). None if too few."""
    mx, mn = x.max(axis=2), x.min(axis=2)
    sat = (mx - mn) / (mx + 1e-4)
    y = luma(x)
    sel = (y > 0.15) & (y < 0.9) & (sat < 0.22) & ~skin
    weak = False
    if sel.mean() < 0.02:
        sel = (y > 0.1) & (y < 0.92) & ~skin
        weak = True
    if sel.sum() < 500:
        return None
    m = x[sel].mean(axis=0)
    return {"rg": float(m[0] / max(m[1], 1e-4)), "bg": float(m[2] / max(m[1], 1e-4)), "weak": weak}


def _phase_shift(a, b, win):
    A, B = np.fft.fft2((a - a.mean()) * win), np.fft.fft2((b - b.mean()) * win)
    R = A * np.conj(B)
    r = np.fft.ifft2(R / (np.abs(R) + 1e-6)).real
    H, W = r.shape
    iy, ix = np.unravel_index(np.argmax(r), r.shape)

    def sub(axis):  # parabolic sub-pixel peak
        m, p = ((iy, (ix - 1) % W), (iy, (ix + 1) % W)) if axis else (((iy - 1) % H, ix), ((iy + 1) % H, ix))
        den = r[m] - 2 * r[iy, ix] + r[p]
        return (r[m] - r[p]) / (2 * den) if abs(den) > 1e-9 else 0.0

    return (ix if ix <= W // 2 else ix - W) + sub(1), (iy if iy <= H // 2 else iy - H) + sub(0)


def jitter_pct(seq: np.ndarray) -> float:
    """Camera jitter: RMS of (trajectory - 0.5 s moving average) in % of frame width. Motion is measured on the
    four corner tiles (usually background) and the median taken, so a moving subject doesn't count as shake."""
    n = len(seq)
    if n < 8:
        return 0.0
    H, W = seq.shape[1:]
    th, tw = int(H * 0.4), int(W * 0.45)
    tiles = [(0, 0), (0, W - tw), (H - th, 0), (H - th, W - tw)]
    win = np.outer(np.hanning(th), np.hanning(tw)).astype(np.float32)
    steps = []
    for a, b in zip(seq[:-1], seq[1:]):
        m = np.array([_phase_shift(a[y: y + th, x: x + tw], b[y: y + th, x: x + tw], win) for y, x in tiles])
        steps.append(np.median(m, axis=0))
    traj = np.cumsum(np.array(steps, np.float32), axis=0)
    k = max(3, D["fps"] // 2) | 1
    pad = np.pad(traj, ((k // 2, k // 2), (0, 0)), mode="edge")
    smooth = np.stack([np.convolve(pad[:, i], np.ones(k) / k, mode="valid") for i in range(2)], 1)
    resid = traj - smooth
    return float(np.sqrt((resid ** 2).sum(1).mean()) / W * 100)


# ------------------------------------------------------------------ analysis + proposal

def sample_times(t_in, t_len, n):
    if t_len <= 0.2:
        return [t_in]
    return [t_in + t_len * (i + 0.5) / n for i in range(n)]


def analyze_clip(c, aw=1080) -> dict:
    path, t_in, t_len, image = c["path"], float(c.get("in", 0)), float(c.get("len", 3)), c.get("type") == "image"
    sw, sh, _ = src_size(path)
    frames = [grab(path, t, aw) for t in ([0.0] if image else sample_times(t_in, t_len, 6))]
    stack = np.stack(frames)
    y = luma(stack)
    skin = np.stack([skin_mask(f) for f in frames])
    cast = neutral_cast(stack.reshape(-1, stack.shape[2], 3), skin.reshape(-1, stack.shape[2]))
    sh_ = skin_hue(stack.reshape(-1, stack.shape[2], 3), skin.reshape(-1, stack.shape[2]))
    jit = 0.0
    if not image and t_len > 0.6:
        jit = jitter_pct(grab_gray_seq(path, t_in + max(0, t_len - 8) / 2, min(t_len, 8)))
    small = np.stack([f[::3, ::3] for f in frames[:4]])
    return {
        "_sample": small,
        "srcWidth": sw, "srcHeight": sh,
        "exposure": {
            "p01": float(np.percentile(y, 0.5)), "p50": float(np.median(y)), "p99": float(np.percentile(y, 99.5)),
            "clipHi": float((stack.max(axis=3) > 0.985).mean()), "clipLo": float((y < 0.02).mean()),
        },
        "cast": cast,
        "skin": {"frac": float(skin.mean()), "hue": sh_[0] if sh_ else None, "chroma": sh_[1] if sh_ else None},
        "noise": float(np.median([noise_sigma(luma(f) * 255) for f in frames])),
        "acutance": float(np.median([acutance(luma(f)) for f in frames])),
        "jitter": jit,
    }


def propose(m: dict, c: dict) -> dict:
    image = c.get("type") == "image"
    e = m["exposure"]
    s: dict = {}
    flags = []
    # stabilise
    if not image and m["jitter"] > D["shake_on"]:
        flags.append("shaky")
        s["stabilize"] = {"on": True, "smoothing": D["stab_smoothing"], "maxShift": D["stab_max_shift"],
                          "maxAngle": D["stab_max_angle"]}
    # denoise
    dark = e["p50"] < D["dark_median"]
    if dark:
        flags.append("low light")
    if m["noise"] > D["noise_on"]:
        flags.append("noisy")
        nl = dark and m["noise"] > D["noise_nlmeans"]
        strength = float(np.clip((m["noise"] - D["noise_on"]) / 4, 0.15, 1 if nl else 0.8))
        s["denoise"] = {"on": True, "method": "nlmeans" if nl else "hqdn3d", "strength": round(strength, 2)}
    # sharpen (after scaling); sources smaller than the frame get less, unsharp can't recover detail
    placed = float(c.get("placedWidth") or 1080)
    if m["acutance"] < D["soft_acutance"]:
        flags.append("soft")
        amt = D["sharpen_max"] * float(np.clip((D["soft_acutance"] - m["acutance"]) / 0.04 + 0.4, 0.35, 1))
        if m["srcWidth"] and m["srcWidth"] < placed * 0.9:
            amt = min(amt, 0.35)
        s["sharpen"] = {"on": True, "amount": round(amt, 2)}
    # exposure / contrast / white balance
    lo = min(0.08, max(0.0, e["p01"] - 0.01)) if e["p01"] > 0.04 else 0.0
    hi = max(0.82, min(1.0, e["p99"] + 0.01)) if e["p99"] < 0.94 else 1.0
    mid = (e["p50"] - lo) / max(hi - lo, 0.05)
    gamma = 1.0
    if abs(mid - D["target_mid"]) > 0.05 and 0.02 < mid < 0.98:
        tgt = mid + (D["target_mid"] - mid) * D["exposure_strength"]
        gamma = float(np.clip(math.log(mid) / math.log(tgt), 0.8, 1.4 if dark else 1.3))
        flags.append("dark" if mid < D["target_mid"] else "bright")
    gains = [1.0, 1.0, 1.0]
    cast = m.get("cast")
    if cast:
        lim = D["wb_max_skin"] if m["skin"]["frac"] > 0.02 else D["wb_max"]
        st = D["wb_strength"] * (0.5 if cast["weak"] else 1)
        kr = 1 + float(np.clip((1 / cast["rg"] - 1) * st, -lim, lim))
        kb = 1 + float(np.clip((1 / cast["bg"] - 1) * st, -lim, lim))
        norm = 0.2126 * kr + 0.7152 + 0.0722 * kb
        gains = [kr / norm, 1 / norm, kb / norm]
        if max(abs(g - 1) for g in gains) < 0.015:
            gains = [1.0, 1.0, 1.0]
        else:
            flags.append("colour cast")
    lo, hi, gamma, gains = fit_to_limits(m.get("_sample"), lo, hi, gamma, gains)
    if lo or hi < 1 or gamma != 1 or gains != [1.0, 1.0, 1.0]:
        if lo or hi < 1:
            flags.append("flat contrast")
        s["color"] = {"on": True, "lo": round(lo, 4), "hi": round(hi, 4), "gamma": round(gamma, 4),
                      "gains": [round(g, 4) for g in gains]}
    return {"settings": s, "flags": sorted(set(flags))}


def predict(sample, cv):
    """(skin hue shift in degrees, extra clipped-highlight fraction) of a curve on sample frames."""
    if sample is None or not cv:
        return 0.0, 0.0
    x = sample.reshape(-1, sample.shape[2], 3)
    y = curve_np(x, cv)
    sk = skin_mask(x)
    h0, h1 = skin_hue(x, sk), skin_hue(y, sk)
    shift = abs(h1[0] - h0[0]) if h0 and h1 else 0.0
    return shift, float((y.max(axis=2) > 0.985).mean() - (x.max(axis=2) > 0.985).mean())


def _scaled(v, f):
    return 1 + (v - 1) * f


def fit_to_limits(sample, lo, hi, gamma, gains, base=None):
    """Shrink the colour correction until skin hue and highlights stay natural. base = curve applied first."""
    for _ in range(8):
        cv = {"lo": lo, "hi": hi, "gamma": gamma, "gains": gains}
        if base:
            cv = curve({"color": {"on": True, **base}, "match": {"on": True, "gamma": gamma, "gains": gains}})
        shift, clip = predict(sample, cv)
        if shift <= D["skin_hue_target"] and clip <= D["clip_hi_max"] * 0.6:
            break
        if shift > D["skin_hue_target"]:
            gains = [_scaled(g, 0.7) for g in gains]
        if clip > D["clip_hi_max"] * 0.6:
            gamma = _scaled(gamma, 0.7) if gamma < 1 else gamma
            hi = min(1.0, hi + 0.03) if not base else hi
            gains = [_scaled(g, 0.85) for g in gains]
    if max(abs(g - 1) for g in gains) < 0.01:
        gains = [1.0, 1.0, 1.0]
    return lo, hi, round(gamma, 4) if abs(gamma - 1) > 0.005 else 1.0, gains


def corrected_stats(c, settings, sample):
    """Median luma + neutral cast after the color curve (for matching)."""
    stack = curve_np(sample, curve({"color": settings.get("color")}))
    skin = np.stack([skin_mask(f) for f in stack])
    cast = neutral_cast(stack.reshape(-1, stack.shape[2], 3), skin.reshape(-1, stack.shape[2]))
    return {"mid": float(np.median(luma(stack))), "cast": cast}


def propose_match(clips, results):
    """Pull every clip toward the group's median brightness and neutral balance (one-shoot look)."""
    stats = {c["id"]: corrected_stats(c, results[c["id"]]["settings"], results[c["id"]]["metrics"]["_sample"])
             for c in clips if c.get("type") != "color" and results[c["id"]]["metrics"].get("_sample") is not None}
    if len(stats) < 2:
        return None
    mids = [s["mid"] for s in stats.values()]
    casts = [s["cast"] for s in stats.values() if s["cast"]]
    target = {"mid": float(np.median(mids)),
              "rg": float(np.median([c["rg"] for c in casts])) if casts else 1.0,
              "bg": float(np.median([c["bg"] for c in casts])) if casts else 1.0}
    for cid, s in stats.items():
        r = results[cid]
        g = 1.0
        if 0.03 < s["mid"] < 0.97 and abs(s["mid"] - target["mid"]) > 0.02:
            t = s["mid"] + (target["mid"] - s["mid"]) * D["match_strength"]
            g = float(np.clip(math.log(s["mid"]) / math.log(t), 1 - D["match_gamma_max"], 1 + D["match_gamma_max"]))
        gains = [1.0, 1.0, 1.0]
        if s["cast"] and casts:
            lim = D["match_wb_max"]
            kr = 1 + float(np.clip((target["rg"] / s["cast"]["rg"] - 1) * D["match_strength"], -lim, lim))
            kb = 1 + float(np.clip((target["bg"] / s["cast"]["bg"] - 1) * D["match_strength"], -lim, lim))
            norm = 0.2126 * kr + 0.7152 + 0.0722 * kb
            gains = [kr / norm, 1 / norm, kb / norm]
        col = r["settings"].get("color")
        base = {k: col[k] for k in ("lo", "hi", "gamma", "gains")} if col else {"lo": 0.0, "hi": 1.0, "gamma": 1.0, "gains": [1.0, 1.0, 1.0]}
        _, _, g, gains = fit_to_limits(r["metrics"]["_sample"], 0, 1, g, gains, base=base)
        if abs(g - 1) > 0.01 or max(abs(x - 1) for x in gains) > 0.01:
            r["settings"]["match"] = {"on": True, "gamma": round(g, 4), "gains": [round(x, 4) for x in gains]}
    return target


# ------------------------------------------------------------------ self-check

def chain_for(settings, *, image, src_w, cwd: Path, path, win, stages=("stabilize", "denoise", "color", "match")):
    """Pre-scale filter chain for a frame grab with the given stages enabled."""
    sel = {k: v for k, v in (settings or {}).items() if k in stages}
    pre, post_fps, _ = clip_filters(sel, path=path, t_in=win[0], t_len=win[1], src_w=src_w, workdir=cwd, image=image)
    return pre + [f"fps={D['fps']}"] + post_fps


def frame_set(c, settings, t, cwd: Path, width):
    """before / processed-without-sharpen / full, all at the same size, at source time t, WITHOUT stabilisation
    (so pixels line up for the halo/smear/colour checks)."""
    settings = {k: v for k, v in (settings or {}).items() if k != "stabilize"}
    path, image = c["path"], c.get("type") == "image"
    win = (float(c.get("in", 0)), float(c.get("len", 3)))
    sw, sh, _ = src_size(path)
    size = _size_for(sw, sh, width)
    before = grab(path, t, width, [f"fps={D['fps']}"], win=None if image else win, size=size)
    mid_chain = chain_for(settings, image=image, src_w=sw, cwd=cwd, path=path, win=win)
    mid = grab(path, t, width, mid_chain, win=None if image else win, cwd=cwd, size=size)
    sh_f = sharpen_filter(on(settings, "sharpen"))
    if sh_f:
        full = grab(path, t, width, mid_chain + [f"scale={size[0]}:{size[1]}:flags=lanczos", sh_f],
                    win=None if image else win, cwd=cwd, size=size)
    else:
        full = mid
    return before, mid, full


def self_check(c, settings, m, cwd: Path, width=1080):
    image = c.get("type") == "image"
    t_in, t_len = float(c.get("in", 0)), float(c.get("len", 3))
    t = 0.0 if image else t_in + t_len * 0.5
    before, mid, full = frame_set(c, settings, t, cwd, width)
    r: dict = {}
    yb, ym, yf = luma(before), luma(mid), luma(full)
    # over-sharpening: edge pixels pushed outside the unsharpened local 3x3 range
    if on(settings, "sharpen"):
        stack = np.stack([ym[dy: dy + ym.shape[0] - 2, dx: dx + ym.shape[1] - 2] for dy in range(3) for dx in range(3)])
        lo, hi = stack.min(0), stack.max(0)
        g = grad_mag(ym)
        edges = g > np.percentile(g, 90)
        yc = yf[1:-1, 1:-1]
        over = ((yc > hi + 6 / 255) | (yc < lo - 6 / 255)) & edges
        r["halo"] = float(over.sum() / max(edges.sum(), 1))
    # noise smear: detail kept in textured areas and on skin (before sharpening)
    if on(settings, "denoise"):
        gb = grad_mag(yb)
        tex = gb > np.percentile(gb, 70)
        lb, lm = laplacian_abs(yb)[...], laplacian_abs(ym)
        lb = lb[1:-1, 1:-1] if lb.shape != lm.shape else lb
        tex = tex[: lm.shape[0], : lm.shape[1]]
        r["detail"] = float(lm[tex].mean() / max(lb[tex].mean(), 1e-6))
        skin = skin_mask(before)[1:-1, 1:-1][: lm.shape[0], : lm.shape[1]]
        if skin.sum() > 2000:
            r["skinDetail"] = float(lm[skin].mean() / max(lb[skin].mean(), 1e-6))
    # colour: skin hue shift and new highlight clipping
    if on(settings, "color") or on(settings, "match"):
        sk = skin_mask(before)
        h0, h1 = skin_hue(before, sk), skin_hue(full, sk)
        if h0 and h1:
            r["skinHueShift"] = abs(h1[0] - h0[0])
        r["clipHi"] = float((full.max(axis=2) > 0.985).mean() - (before.max(axis=2) > 0.985).mean())
    # stabilisation: jitter must drop, and no black borders (warping beyond the optzoom crop)
    if on(settings, "stabilize") and not image:
        st_ = on(settings, "stabilize")
        after = stab_jitter_after(c, st_, cwd)  # also copies the trf into cwd
        r["jitterAfter"] = after
        r["stabGain"] = 1 - after / max(m["jitter"], 1e-6)
        # black corners in the first 3 s = warping beyond the optzoom crop (trf frames line up from t_in)
        trf = stab_trf(c["path"], t_in, t_len)
        seq = grab_gray_seq(c["path"], t_in, min(t_len, 3), cwd=cwd,
                            chain=[stab_filter(st_, f"stab_{trf.stem}.trf", src_size(c["path"])[0])])
        corners = np.concatenate([seq[:, :6, :6].ravel(), seq[:, :6, -6:].ravel(), seq[:, -6:, :6].ravel(), seq[:, -6:, -6:].ravel()])
        r["border"] = float((corners < 4).mean()) if len(corners) else 0.0
        sw_, sh_ = src_size(c["path"])[:2]
        r["cropMax"] = round(stab_crop(on(settings, "stabilize"), sw_ or 9, sh_ or 16), 4)
    return r, (before, full)


def check_failures(r: dict) -> list[str]:
    f = []
    if r.get("halo", 0) > D["halo_max"]:
        f.append("sharpen:halos")
    if r.get("detail", 1) < D["detail_min"]:
        f.append("denoise:detail smear")
    if r.get("skinDetail", 1) < D["skin_detail_min"]:
        f.append("denoise:skin smear")
    if r.get("skinHueShift", 0) > D["skin_hue_max"]:
        f.append("color:skin tone shift")
    if r.get("clipHi", 0) > D["clip_hi_max"]:
        f.append("color:clipped highlights")
    if "stabGain" in r and r["stabGain"] < D["stab_gain_min"]:
        f.append("stabilize:no gain / warping")
    if r.get("border", 0) > 0.2:
        f.append("stabilize:black borders")
    if r.get("cropMax", 0) > D["stab_crop_max"]:
        f.append("stabilize:too much crop")
    return f


def step_down(settings: dict, failures: list[str]) -> list[str]:
    """Weaken whatever failed. Returns human-readable notes."""
    notes = []
    for fl in failures:
        key, why = fl.split(":", 1)
        s = settings.get(key)
        if not s:
            continue
        if key == "sharpen":
            s["amount"] = round(s["amount"] * 0.6, 2)
            if s["amount"] < 0.12:
                s["on"] = False
        elif key == "denoise":
            if s.get("method") == "nlmeans" and s["strength"] <= 0.3:
                s["method"] = "hqdn3d"
            s["strength"] = round(s["strength"] * 0.6, 2)
            if s["strength"] < 0.1:
                s["on"] = False
        elif key == "color":
            s["gains"] = [round(1 + (g - 1) * 0.5, 4) for g in s["gains"]]
            if "highlights" in why:
                s["hi"] = min(1.0, round(s["hi"] + 0.04, 4))
                s["gamma"] = round(1 + (s["gamma"] - 1) * 0.6, 4)
            m = settings.get("match")
            if m and "skin" in why:
                m["gains"] = [round(1 + (g - 1) * 0.5, 4) for g in m["gains"]]
        elif key == "stabilize":
            if s.get("maxShift", D["stab_max_shift"]) > 0.02:
                s["maxShift"] = round(s.get("maxShift", D["stab_max_shift"]) * 0.6, 3)
                s["smoothing"] = max(6, int(s.get("smoothing", D["stab_smoothing"]) * 0.7))
            else:
                s["on"] = False
        notes.append(f"{why} -> {key} {'off' if not s.get('on') else 'reduced'}")
    return notes


def make_sheet(before, after, out: Path, top_after=None):
    """Before | after at display size (top_after: the stabilised frame), plus aligned 1:1 crops of the
    most detailed area underneath (without stabilisation, so they line up)."""
    h, w = before.shape[:2]
    scale = max(1, int(math.ceil(w / 540)))
    small = lambda x: x[::scale, ::scale]  # noqa: E731
    ta = top_after if top_after is not None and top_after.shape == before.shape else after
    top = np.concatenate([small(before), np.ones((small(before).shape[0], 8, 3), np.float32), small(ta)], 1)
    cs = min(320, h // 2, w // 2)
    g = grad_mag(luma(before))
    ii = np.unravel_index(np.argmax(np.add.reduceat(np.add.reduceat(g, np.arange(0, g.shape[0], cs), 0),
                                                    np.arange(0, g.shape[1], cs), 1)), (len(range(0, g.shape[0], cs)), len(range(0, g.shape[1], cs))))
    y0, x0 = min(ii[0] * cs, h - cs), min(ii[1] * cs, w - cs)
    crop = lambda x: x[y0: y0 + cs, x0: x0 + cs]  # noqa: E731
    bottom = np.concatenate([crop(before), np.ones((cs, 8, 3), np.float32), crop(after)], 1)
    W = max(top.shape[1], bottom.shape[1])
    pad = lambda x: np.pad(x, ((0, 0), (0, W - x.shape[1]), (0, 0)), constant_values=1)  # noqa: E731
    write_jpg(np.concatenate([pad(top), np.ones((8, W, 3), np.float32), pad(bottom)], 0), out)


def stab_jitter_after(c, st, cwd: Path) -> float:
    t_in, t_len = float(c.get("in", 0)), float(c.get("len", 3))
    sw = src_size(c["path"])[0]
    trf = stab_trf(c["path"], t_in, t_len)
    name = f"stab_{trf.stem}.trf"
    if not (cwd / name).exists():
        shutil.copy(trf, cwd / name)
    seq_len = min(t_len, 8)
    seq = grab_gray_seq(c["path"], t_in, t_len, chain=[stab_filter(st, name, sw)], cwd=cwd)
    start = int(max(0, t_len - seq_len) / 2 * D["fps"])
    seq = seq[start: start + int(seq_len * D["fps"])]
    return jitter_pct(seq) if len(seq) > 8 else 1e9


def tune_stab(c, settings, metrics, cwd: Path) -> list[str]:
    """Pick the gentlest ladder rung (least crop) that cuts jitter by stab_gain_want; off if none helps."""
    st = settings.get("stabilize")
    if not st or not st.get("on") or c.get("type") == "image":
        return []
    best = None
    for sm, ms, ma in D["stab_ladder"]:
        cand = {"on": True, "smoothing": sm, "maxShift": ms, "maxAngle": ma}
        gain = 1 - stab_jitter_after(c, cand, cwd) / max(metrics["jitter"], 1e-6)
        if gain >= D["stab_gain_min"] and (best is None or gain > best[1] + 0.1):
            best = (cand, gain)
        if gain >= D["stab_gain_want"]:
            break
    if not best:
        st["on"] = False
        return ["stabilisation did not reduce shake (subject motion?) -> stabilize off"]
    settings["stabilize"] = best[0]
    return [f"stabilize: smoothing {best[0]['smoothing']}, max shift {best[0]['maxShift']:.0%} (jitter -{best[1]:.0%})"]


def check_clip(c, settings, metrics, cwd: Path, sheet: Path | None, rounds=2):
    adjusted = tune_stab(c, settings, metrics, cwd) if rounds else []
    for _ in range(rounds + 1):
        r, (before, after) = self_check(c, settings, metrics, cwd)
        fails = check_failures(r)
        if not fails:
            break
        if len(adjusted) >= rounds * 4:
            break
        notes = step_down(settings, fails)
        if not notes:
            break
        adjusted += notes
    r["failures"] = check_failures(r)
    r["ok"] = not r["failures"]
    r["adjusted"] = adjusted
    if sheet:
        top = None
        if on(settings, "stabilize") and c.get("type") != "image":
            t_in, t_len = float(c.get("in", 0)), float(c.get("len", 3))
            sw, sh_, _ = src_size(c["path"])
            chain = chain_for(settings, image=False, src_w=sw, cwd=cwd, path=c["path"], win=(t_in, t_len))
            sf = sharpen_filter(on(settings, "sharpen"))
            size = (before.shape[1], before.shape[0])
            if sf:
                chain += [f"scale={size[0]}:{size[1]}:flags=lanczos", sf]
            top = grab(c["path"], t_in + t_len * 0.5, size[0], chain, win=(t_in, t_len), cwd=cwd, size=size)
        make_sheet(before, after, sheet, top)
    return r


# ------------------------------------------------------------------ upscale (Real-ESRGAN, ncnn)

def esrgan_bin() -> str | None:
    env = os.environ.get("REALESRGAN_BIN")
    if env and Path(env).exists():
        return env
    studio = os.environ.get("REEL_STUDIO_DIR") or str(Path.home() / "ReelSmith" / "studio")
    for p in [Path(studio) / "tools" / "realesrgan" / "realesrgan-ncnn-vulkan.exe",
              Path(studio) / "tools" / "realesrgan" / "realesrgan-ncnn-vulkan"]:
        if p.exists():
            return str(p)
    return shutil.which("realesrgan-ncnn-vulkan")


def _esrgan(src_dir: Path, dst_dir: Path):
    exe = esrgan_bin()
    if not exe:
        raise RuntimeError("Real-ESRGAN not found. Run setup.bat (it installs realesrgan-ncnn-vulkan into <REEL_STUDIO_DIR>/tools/realesrgan) "
                           "(see README) or set REALESRGAN_BIN.")
    # The official realesrgan-ncnn-vulkan build has no CPU mode ("-g -1" is rejected as an invalid device): it runs on
    # whatever Vulkan device it finds (an integrated Intel/AMD GPU is enough). REALESRGAN_GPU picks a device id.
    gpu = os.environ.get("REALESRGAN_GPU")
    args = [exe, "-i", str(src_dir), "-o", str(dst_dir), "-n", os.environ.get("REALESRGAN_MODEL", "realesrgan-x4plus"),
            "-s", "4", "-f", "png", *(["-g", gpu] if gpu else []), "-j", "1:2:2"]
    p = subprocess.run(args, capture_output=True, text=True, cwd=str(Path(exe).parent))
    if p.returncode != 0:
        raise RuntimeError(f"Real-ESRGAN failed: {(p.stderr or p.stdout)[-600:]}")


def upscale_estimate(path, t_in, t_len, width=1080):
    sw, sh, _ = src_size(path)
    frames = max(1, int(round(t_len * D["fps"])))
    with tempfile.TemporaryDirectory(prefix="rs-esr-") as d:
        d = Path(d)
        # time 1 and then 2 centre-quarter crops: the difference is the per-crop cost without model loading
        cw, ch = _even(sw / 2), _even(sh / 2)
        times = []
        for n in (1, 2):
            src, dst = d / f"in{n}", d / f"out{n}"
            src.mkdir()
            dst.mkdir()
            for k in range(n):
                run_ff(["-y", "-ss", _num(t_in + t_len * (k + 1) / 3), "-i", path, "-frames:v", "1",
                        "-vf", f"crop={cw}:{ch}", str(src / f"f{k}.png")], check=True)
            t0 = time.time()
            _esrgan(src, dst)
            times.append(time.time() - t0)
        per = max(times[1] - times[0], times[0] / 2) * 4
        overhead = max(0.0, times[0] - per / 4)
    chunks = math.ceil(frames / 24)
    total = per * frames + overhead * chunks + t_len * 2   # + model load per chunk, extraction/encode
    return {"frames": frames, "secondsPerFrame": round(per, 2), "estimateSeconds": round(total), "srcWidth": sw,
            "srcHeight": sh, "outWidth": width, "outHeight": _even(width * sh / sw)}


def upscale(path, t_in, t_len, out: Path, width=1080, chunk=24, progress=print):
    sw, sh, info = src_size(path)
    W, H = width, _even(width * sh / sw)
    frames = max(1, int(round(t_len * D["fps"])))
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="rs-esr-") as d:
        d = Path(d)
        parts = []
        t0 = time.time()
        for i in range(0, frames, chunk):
            n = min(chunk, frames - i)
            src, dst = d / f"in{i}", d / f"out{i}"
            src.mkdir()
            dst.mkdir()
            # lossless all the way: colour-converted (HDR/P3 -> bt709 SDR) PNG frames in, PNG out, x264 -qp 0
            run_ff(["-y", "-ss", _num(t_in), "-t", _num(t_len), "-i", path, "-vf",
                    ",".join(color.source_chain(color.probe_color(path)) +
                             [f"fps={D['fps']},trim=start_frame={i}:end_frame={i + n},setpts=PTS-STARTPTS", "format=rgb24"]),
                    str(src / "%05d.png")], check=True)
            _esrgan(src, dst)
            part = d / f"part{i:06d}.mp4"
            run_ff(["-y", "-framerate", str(D["fps"]), "-i", str(dst / "%05d.png"), "-vf",
                    f"scale={W}:{H}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p,{color.TAG_709}",
                    "-c:v", "libx264", "-preset", "medium", "-qp", "0", *color.output_tags(), str(part)], check=True)
            parts.append(part)
            shutil.rmtree(src)
            shutil.rmtree(dst)
            done = i + n
            el = time.time() - t0
            progress(f"PROGRESS {done / frames:.3f} frames {done}/{frames} eta {int(el / done * (frames - done))}s")
        lst = d / "parts.txt"
        lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts), encoding="utf-8")
        video = d / "video.mp4"
        run_ff(["-y", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(video)], check=True)
        args = ["-y", "-i", str(video)]
        if info.get("has_audio"):
            args += ["-ss", _num(t_in), "-t", _num(t_len), "-i", path, "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "192k"]
        run_ff([*args, "-c:v", "copy", "-movflags", "+faststart", "-shortest", str(out)], check=True)
    return {"width": W, "height": H, "frames": frames}


# ------------------------------------------------------------------ CLI

def _load(p):
    return json.loads(Path(p).read_text(encoding="utf-8-sig"))


def _settings_arg(v: str) -> dict:
    return _load(v[1:]) if v.startswith("@") else json.loads(v)


def cmd_analyze(a):
    spec = _load(a.spec)
    out = Path(a.out)
    work = out.parent
    work.mkdir(parents=True, exist_ok=True)
    prev = _load(out) if out.exists() else {}
    clips = [c for c in spec["clips"] if c.get("type") in ("video", "image")]
    only = set(a.clip or [])
    results = {c["id"]: r for c in (prev.get("clips") or []) for r in [c]} if only else {}
    t0 = time.time()
    for c in clips:
        if only and c["id"] not in only:
            continue
        print(f"analyse {c['id']} {c.get('name', '')[:40]}", flush=True)
        m = analyze_clip(c)
        p = propose(m, c)
        results[c["id"]] = {"id": c["id"], "name": c.get("name"), "type": c.get("type"), "metrics": m, **p}
        sw = m["srcWidth"]
        results[c["id"]]["upscaleCandidate"] = bool(sw and sw < D["upscale_below"] and c.get("type") == "video")
    present = [c for c in clips if c["id"] in results]
    target = propose_match(present, results) if len(present) >= 2 else None
    for c in present:
        r = results[c["id"]]
        print(f"self-check {c['id']}", flush=True)
        r["check"] = check_clip(c, r["settings"], r["metrics"], work, work / f"sheet_{c['id']}.jpg")
        r["sheet"] = (work / f"sheet_{c['id']}.jpg").as_posix()
    for r in results.values():
        r["metrics"].pop("_sample", None)
    doc = {"version": 1, "defaults": D, "matchTarget": target, "seconds": round(time.time() - t0, 1),
           "clips": [results[c["id"]] for c in present]}
    out.write_text(json.dumps(doc, indent=1), encoding="utf-8")
    for r in doc["clips"]:
        ch = r["check"]
        print(f"{r['id']}: {', '.join(r['flags']) or 'clean'} | fixes: {', '.join(k for k, v in r['settings'].items() if v.get('on')) or 'none'}"
              f" | check {'OK' if ch['ok'] else 'FAIL ' + '; '.join(ch['failures'])}{' | adjusted: ' + '; '.join(ch['adjusted']) if ch['adjusted'] else ''}")
    print(f"wrote {out}")


def cmd_check(a):
    spec = _load(a.spec)
    out = Path(a.analysis)
    doc = _load(out)
    over = _load(a.overrides)  # {clipId: {stabilize: {...}, ...}} partial settings, merged per fix
    by_id = {c["id"]: c for c in spec["clips"]}
    for r in doc["clips"]:
        o = over.get(r["id"])
        if not o:
            continue
        for k, v in o.items():
            if v is None:
                r["settings"].pop(k, None)
            else:
                r["settings"][k] = {**(r["settings"].get(k) or {}), **v}
        r["check"] = check_clip(by_id[r["id"]], r["settings"], r["metrics"], out.parent, out.parent / f"sheet_{r['id']}.jpg", rounds=0)
        ch = r["check"]
        print(f"{r['id']}: check {'OK' if ch['ok'] else 'FAIL ' + '; '.join(ch['failures'])} {json.dumps({k: v for k, v in ch.items() if isinstance(v, float)})}")
    out.write_text(json.dumps(doc, indent=1), encoding="utf-8")


def cmd_frame(a):
    settings = {} if a.before else _settings_arg(a.settings)
    c = {"path": a.src, "in": a.t_in, "len": a.t_len, "type": "image" if a.image else "video"}
    with tempfile.TemporaryDirectory(prefix="rs-frame-") as d:
        d = Path(d)
        sw, sh, _ = src_size(a.src)
        # the placed width, like render (small sources are scaled up before unsharp), not capped at the source
        size = (_even(a.width), _even(a.width * sh / sw)) if sw else _size_for(sw, sh, a.width)
        win = None if a.image else (a.t_in, a.t_len)
        chain = chain_for(settings, image=a.image, src_w=sw, cwd=d, path=a.src, win=(a.t_in, a.t_len))
        sh_f = sharpen_filter(on(settings, "sharpen"))
        if sh_f:
            chain += [f"scale={size[0]}:{size[1]}:flags=lanczos", sh_f]
        img = grab(a.src, a.t, a.width, chain, win=win, cwd=d, size=size)
    write_jpg(img, Path(a.out), q=2)
    print(json.dumps({"width": size[0], "height": size[1]}))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("analyze")
    p.add_argument("--spec", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--clip", action="append")
    p = sub.add_parser("check")
    p.add_argument("--spec", required=True)
    p.add_argument("--analysis", required=True)
    p.add_argument("--overrides", required=True)
    p = sub.add_parser("frame")
    p.add_argument("--src", required=True)
    p.add_argument("--in", dest="t_in", type=float, default=0.0)
    p.add_argument("--len", dest="t_len", type=float, default=3.0)
    p.add_argument("--t", type=float, required=True)
    p.add_argument("--settings", default="{}")
    p.add_argument("--width", type=int, default=1080)
    p.add_argument("--out", required=True)
    p.add_argument("--before", action="store_true")
    p.add_argument("--image", action="store_true")
    for name in ("upscale-estimate", "upscale"):
        p = sub.add_parser(name)
        p.add_argument("--src", required=True)
        p.add_argument("--in", dest="t_in", type=float, default=0.0)
        p.add_argument("--len", dest="t_len", type=float, required=True)
        p.add_argument("--width", type=int, default=1080)
        if name == "upscale":
            p.add_argument("--out", required=True)
    a = ap.parse_args()
    if a.cmd == "analyze":
        cmd_analyze(a)
    elif a.cmd == "check":
        cmd_check(a)
    elif a.cmd == "frame":
        cmd_frame(a)
    elif a.cmd == "upscale-estimate":
        print(json.dumps(upscale_estimate(a.src, a.t_in, a.t_len, a.width)))
    elif a.cmd == "upscale":
        r = upscale(a.src, a.t_in, a.t_len, Path(a.out), a.width, progress=lambda s: print(s, flush=True))
        print(json.dumps(r))


if __name__ == "__main__":
    main()
