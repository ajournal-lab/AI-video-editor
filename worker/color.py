"""Source colour handling: every source -> SDR bt709 (tv range, 8-bit 4:2:0), scaled once.

- HDR (HLG / PQ, bt2020, iPhone Dolby Vision 8.4 whose base layer is HLG): linearise, gamut-map bt2020 -> bt709,
  tone-map with mobius (transition 0.15: keeps mid-tones and skin, rolls off highlights), back to bt709.
- SDR in other spaces (Display P3 primaries, bt601/smpte170m matrix, full-range "yuvj"): converted with zimg.
- Untagged sources: bt709 matrix at HD and above, smpte170m below; yuvj = full range.
- The scale to the placed size happens inside the same zscale call (lanczos; in linear light for HDR), so a clip is
  resampled exactly once. Error-diffusion dither on the way down to 8 bit (no banding in skies and walls).
- Output frames are tagged bt709/tv (setparams) so later automatic RGB<->YUV conversions use the right matrix.

render.py, enhance.py (analysis + previews) and the quality audit all use source_chain(), so what Enhance
measures is exactly what the render encodes.
"""
from __future__ import annotations

import json
import subprocess
from functools import lru_cache

HDR_TRC = {"arib-std-b67", "smpte2084"}
TONEMAP = "mobius:param=0.15:desat=0"
NPL = 100
TAG_709 = "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv"

# ffprobe names -> zscale (zimg) names
_PRIM = {"bt709": "709", "bt2020": "2020", "smpte432": "smpte432", "smpte431": "smpte431", "bt470bg": "bt470bg",
         "smpte170m": "170m", "smpte240m": "240m"}
_TRC = {"bt709": "709", "arib-std-b67": "arib-std-b67", "smpte2084": "smpte2084", "smpte170m": "601",
        "bt2020-10": "2020_10", "iec61966-2-1": "iec61966-2-1", "linear": "linear", "gamma22": "709", "gamma28": "709"}
_MAT = {"bt709": "709", "bt2020nc": "2020_ncl", "bt2020c": "2020_cl", "smpte170m": "170m", "bt470bg": "470bg",
        "fcc": "fcc", "smpte240m": "240m"}


@lru_cache(maxsize=256)
def probe_color(path: str) -> dict:
    """Colour + timing facts of the first video stream (display orientation)."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=codec_name,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,"
                          "r_frame_rate,avg_frame_rate,nb_frames,bit_rate:stream_tags=alpha_mode:stream_side_data=rotation,dv_profile:format=duration",
                          "-of", "json", path], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
    try:
        j = json.loads(out)
        s = j["streams"][0]
    except Exception:
        return {"video": False}
    rot = 0
    dv = None
    for sd in s.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(float(sd["rotation"]))
        if "dv_profile" in sd:
            dv = int(sd["dv_profile"])
    w, h = int(s.get("width") or 0), int(s.get("height") or 0)
    if abs(rot) % 180 == 90:
        w, h = h, w
    fr = lambda v: (lambda a, b: a / b if b else 0.0)(*map(float, (v or "0/1").split("/")))  # noqa: E731
    pix = s.get("pix_fmt") or ""
    # VP9 with alpha (inserts, ReelSmith graphics) reports yuv420p: the alpha is a side stream that only the libvpx
    # decoder reads (render.py puts -c:v libvpx-vp9 before the input)
    tags = {k.lower(): v for k, v in (s.get("tags") or {}).items()}  # webm writes ALPHA_MODE, others alpha_mode
    vp9_alpha = s.get("codec_name") == "vp9" and str(tags.get("alpha_mode", "")) == "1"
    if vp9_alpha:
        pix = "yuva420p"
    trc = s.get("color_transfer") or ""
    return {
        "video": True, "codec": s.get("codec_name"), "width": w, "height": h, "rotation": rot, "pix_fmt": pix,
        "bit_depth": 10 if "10" in pix else 12 if "12" in pix else 8,
        "range": s.get("color_range") or ("pc" if pix.startswith("yuvj") else "unknown"),
        "matrix": s.get("color_space") or "unknown", "transfer": trc or "unknown",
        "primaries": s.get("color_primaries") or "unknown",
        "fps": fr(s.get("r_frame_rate")), "avg_fps": fr(s.get("avg_frame_rate")),
        "frames": int(s["nb_frames"]) if str(s.get("nb_frames", "")).isdigit() else None,
        "bit_rate": int(s["bit_rate"]) if str(s.get("bit_rate", "")).isdigit() else None,
        "duration": float(j.get("format", {}).get("duration") or 0), "dolby_vision": dv,
        "hdr": trc in HDR_TRC, "vp9_alpha": vp9_alpha,
    }


def _src_space(c: dict) -> dict:
    """zscale input parameters, with sensible guesses for untagged sources."""
    hd = max(c.get("width", 0), c.get("height", 0)) >= 1200 or min(c.get("width", 0), c.get("height", 0)) >= 720
    mat = _MAT.get(c["matrix"]) or ("709" if hd else "170m")
    prim = _PRIM.get(c["primaries"]) or ("709" if hd else "170m")
    trc = _TRC.get(c["transfer"]) or "709"
    rng = "full" if c["range"] == "pc" or c["pix_fmt"].startswith("yuvj") else "limited"
    return {"min": mat, "pin": prim, "tin": trc, "rin": rng}


def needs_conversion(c: dict) -> bool:
    s = _src_space(c)
    return c.get("hdr") or s != {"min": "709", "pin": "709", "tin": "709", "rin": "limited"} or c.get("bit_depth", 8) > 8


def describe(c: dict) -> str:
    if not c.get("video"):
        return "image"
    if c.get("hdr"):
        kind = "HLG" if c["transfer"] == "arib-std-b67" else "PQ"
        return f"HDR {kind} {c['bit_depth']}-bit {c['primaries']}" + (f" (Dolby Vision {c['dolby_vision']})" if c.get("dolby_vision") else "")
    s = _src_space(c)
    bits = []
    if s["pin"] not in ("709",):
        bits.append({"smpte432": "Display P3"}.get(c["primaries"], c["primaries"]))
    if s["min"] != "709":
        bits.append(f"{c['matrix'] if c['matrix'] != 'unknown' else 'untagged'} matrix")
    if s["rin"] == "full":
        bits.append("full range")
    return "SDR " + (", ".join(bits) if bits else "bt709")


def source_chain(c: dict, w: int | None = None, h: int | None = None, *, dither=True) -> list[str]:
    """Filters right after decoding: -> SDR bt709 tv 8-bit yuv420p, scaled to w x h (lanczos) when given."""
    size = f"w={w}:h={h}:f=lanczos:" if w and h else ""
    d = ":d=error_diffusion" if dither else ""
    if not c.get("video"):
        return [f"zscale={size.rstrip(':')}" if size else "null", TAG_709]
    s = _src_space(c)
    src = f"min={s['min']}:pin={s['pin']}:tin={s['tin']}:rin={s['rin']}"
    if c.get("hdr"):
        return [f"zscale={size}{src}:t=linear:npl={NPL}", "format=gbrpf32le", "zscale=p=709",
                f"tonemap=tonemap={TONEMAP}", f"zscale=t=709:m=709:r=limited{d}", "format=yuv420p", TAG_709]
    if needs_conversion(c):
        return [f"zscale={size}{src}:m=709:p=709:t=709:r=limited{d}", "format=yuv420p", TAG_709]
    if size:
        return [f"zscale={size.rstrip(':')}", "format=yuv420p", TAG_709]
    return ["format=yuv420p", TAG_709]


def has_alpha(c: dict) -> bool:
    pix = c.get("pix_fmt") or ""
    return pix.startswith(("yuva", "rgba", "bgra", "argb", "abgr", "gbrap", "ya", "pal8")) or pix in ("rgba64le", "rgba64be")


def output_tags() -> list[str]:
    """Encoder flags: tag the stream bt709 / tv range."""
    return ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"]
