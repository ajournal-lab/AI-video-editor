"""Cinematic looks for talking-head footage (clip.grade = {"look", "intensity"}).

Cinematic Warm:
- gentle S contrast curve with soft (lifted, not crushed) blacks and a soft highlight roll-off
- split tone: teal/neutral shadows, warm highlights
- background colours slightly desaturated; skin hues (orange/red, mid saturation) protected from the
  desaturation and from most of the split tone, so skin stays natural
- subtle vignette (on the placed frame, so it stays centred whatever the crop)

The colour part is one 3D LUT (.cube, 33^3) applied with ffmpeg lut3d after scaling; the vignette is a
multiply mask. Intensity 0..1 blends from the original (0) to the full look (1).
src/lib/timeline/derive.ts (gradeTone / GRADE_LOOKS / gradeVignetteStops) mirrors the per-channel tone curve
and the vignette for the canvas preview; keep the numbers in sync.

CLI (for checks): python grade.py frame --src IMG --out OUT.jpg --intensity 0.8 [--t S]
"""
from __future__ import annotations

import argparse
import math
import subprocess
from pathlib import Path

import numpy as np

LOOKS = {
    "cinematic_warm": {
        "contrast": 0.25,      # S-curve amount (slope 1.25 at mid grey, 0.75 at the ends)
        "lift": 0.035,         # black level: soft, never crushed
        "roll": 0.975,         # white level: soft highlight roll-off
        "shadows": (-0.025, 0.008, 0.03),     # R, G, B offsets weighted by (1-x)^2: teal/neutral shadows
        "highlights": (0.045, 0.012, -0.04),  # weighted by x^2: warm highlights
        "bg_desat": 0.25,      # saturation cut for non-skin colours
        "skin_protect": 0.85,  # how much of the split tone skin is shielded from
        "vignette": 0.3,       # corner darkening at intensity 1
    },
    # Cool girl look: warm, soft and lifted (low contrast, creamy highlights), gentle vignette
    "warm_soft": {
        "contrast": 0.08, "lift": 0.05, "roll": 0.97,
        "shadows": (0.02, 0.008, -0.012), "highlights": (0.05, 0.02, -0.045),
        "bg_desat": 0.08, "skin_protect": 0.6, "vignette": 0.15,
    },
    # Cool dude look: dark editorial. The room falls back (darker, cooler, desaturated, heavy vignette) ...
    "dark_editorial": {
        "contrast": 0.3, "lift": 0.012, "roll": 0.8,
        "shadows": (-0.012, 0.0, 0.012), "highlights": (0.0, 0.0, -0.012),
        "bg_desat": 0.35, "skin_protect": 0.7, "vignette": 0.6,
    },
    # ... while the speaker (the Cut-out copy on top) stays lit: punchy but bright, no vignette
    "editorial_subject": {
        "contrast": 0.22, "lift": 0.02, "roll": 0.99,
        "shadows": (0.0, 0.0, 0.01), "highlights": (0.02, 0.01, -0.01),
        "bg_desat": 0.15, "skin_protect": 0.85, "vignette": 0.0,
    },
}
VIGNETTE_R0, VIGNETTE_R1 = 0.45, 1.05  # radius (fraction of the half-diagonal) where darkening starts / is full


def tone(x: np.ndarray, ch: int, look: dict) -> np.ndarray:
    """Per-channel tone curve at full intensity (mirrored in derive.ts gradeTone)."""
    s = x - look["contrast"] * np.sin(2 * np.pi * x) / (2 * np.pi)
    y = look["lift"] + (look["roll"] - look["lift"]) * s
    y = y + look["shadows"][ch] * (1 - x) ** 2 + look["highlights"][ch] * x ** 2
    return np.clip(y, 0, 1)


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def skin_weight(rgb: np.ndarray) -> np.ndarray:
    """0..1: how much a colour looks like skin (hue ~5-50 deg, moderate saturation, not too dark)."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    with np.errstate(invalid="ignore", divide="ignore"):
        h = np.where(mx == r, ((g - b) / np.maximum(d, 1e-6)) % 6,
                     np.where(mx == g, (b - r) / np.maximum(d, 1e-6) + 2, (r - g) / np.maximum(d, 1e-6) + 4)) * 60
    h = np.where(d > 1e-6, h, 0)
    hue_w = _smooth(0, 12, h) * (1 - _smooth(42, 58, h))
    return hue_w * _smooth(0.08, 0.2, s) * (1 - _smooth(0.75, 0.95, s)) * _smooth(0.1, 0.25, mx)


def apply(rgb: np.ndarray, look_id: str, k: float) -> np.ndarray:
    """The full colour transform on float RGB (…,3) in 0..1."""
    look = LOOKS[look_id]
    k = float(np.clip(k, 0, 1))
    toned = np.stack([tone(rgb[..., c], c, look) for c in range(3)], -1)
    base = look["lift"] + (look["roll"] - look["lift"]) * (rgb - look["contrast"] * np.sin(2 * np.pi * rgb) / (2 * np.pi))
    w = skin_weight(rgb)[..., None]
    out = toned + (base - toned) * look["skin_protect"] * w
    y = (out * np.array([0.2126, 0.7152, 0.0722])).sum(-1, keepdims=True)
    out = y + (out - y) * (1 - look["bg_desat"] * (1 - w))
    return np.clip(rgb + k * (out - rgb), 0, 1)


def write_cube(path: Path, look_id: str, k: float, n: int = 33):
    g = np.linspace(0, 1, n)
    # .cube order: red changes fastest, then green, then blue
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")
    rgb = np.stack([r, gg, b], -1).reshape(-1, 3)
    out = apply(rgb, look_id, k)
    lines = [f'TITLE "{look_id} {k:.2f}"', f"LUT_3D_SIZE {n}", "DOMAIN_MIN 0 0 0", "DOMAIN_MAX 1 1 1"]
    lines += [f"{v[0]:.6f} {v[1]:.6f} {v[2]:.6f}" for v in out]
    path.write_text("\n".join(lines) + "\n", encoding="ascii")


def _key(grade) -> tuple[str, float] | None:
    if not grade or grade.get("look") not in LOOKS:
        return None
    k = round(float(np.clip(grade.get("intensity", 0.7), 0, 1)), 2)
    return (grade["look"], k) if k > 0 else None


def lut_filter(grade, workdir: Path) -> str | None:
    """lut3d filter for the colour part (file written into workdir; ffmpeg runs with cwd=workdir)."""
    key = _key(grade)
    if not key:
        return None
    name = f"grade_{key[0]}_{int(key[1] * 100)}.cube"
    if not (workdir / name).exists():
        write_cube(workdir / name, *key)
    return f"lut3d=file={name}:interp=tetrahedral"


def vignette_alpha(W: int, H: int, strength: float) -> np.ndarray:
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    r = np.hypot((xx + 0.5 - W / 2) / (W / 2), (yy + 0.5 - H / 2) / (H / 2)) / math.sqrt(2)
    return strength * _smooth(VIGNETTE_R0, VIGNETTE_R1, r)


def vignette_mask(grade, W: int, H: int, workdir: Path) -> str | None:
    """A W x H RGBA PNG to multiply onto the placed frame (rgb = 1 - darkening, alpha = opaque)."""
    key = _key(grade)
    if not key:
        return None
    strength = LOOKS[key[0]]["vignette"] * key[1]
    if strength <= 0.005:
        return None
    name = f"vig_{key[0]}_{int(key[1] * 100)}_{W}x{H}.png"
    if not (workdir / name).exists():
        m = np.round((1 - vignette_alpha(W, H, strength)) * 255).astype(np.uint8)
        rgba = np.dstack([m, m, m, np.full_like(m, 255)])
        _write_png(rgba, workdir / name)
    return name


def _write_png(rgba: np.ndarray, out: Path):
    from media import ffmpeg_bin
    H, W = rgba.shape[:2]
    subprocess.run([ffmpeg_bin(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{H}",
                    "-i", "-", "-frames:v", "1", str(out)], input=rgba.tobytes(), check=True)


def main():
    ap = argparse.ArgumentParser(description="Preview a grade on one frame")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("frame")
    p.add_argument("--src", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--t", type=float, default=0.0)
    p.add_argument("--look", default="cinematic_warm")
    p.add_argument("--intensity", type=float, default=0.7)
    p.add_argument("--width", type=int, default=720)
    a = ap.parse_args()
    from media import ffmpeg_bin
    out = Path(a.out).resolve()
    work = out.parent
    g = {"look": a.look, "intensity": a.intensity}
    lut = lut_filter(g, work)
    chain = f"scale={a.width}:-2:flags=lanczos,format=rgb24" + (f",{lut}" if lut else "")
    subprocess.run([ffmpeg_bin(), "-y", "-loglevel", "error", "-ss", str(a.t), "-i", a.src, "-frames:v", "1",
                    "-vf", chain, str(out)], check=True, cwd=work)


if __name__ == "__main__":
    main()
