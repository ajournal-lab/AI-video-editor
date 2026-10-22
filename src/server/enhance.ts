import "server-only";
// Enhance: per-clip stabilise / denoise / sharpen / exposure + white balance / colour match / upscale.
// The engine is worker/enhance.py (CPU only). The analysis runs as a Claude job (Claude runs the tool, looks
// at the before/after sheets and writes enhance.json); previews and the upscale estimate spawn the tool directly;
// the upscale itself is a local command job on the agent runner. Settings live on each clip (clip.enhance)
// and the render worker applies them inside the single final encode.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { enhanceScript, fwd, pythonBin, studioDir } from "@/agent/config";
import { placement } from "@/lib/timeline/derive";
import type { Timeline, VisualClip } from "@/lib/timeline/types";
import { ensureProjectDir, localMediaPath } from "./agent";

export interface SpecClip {
  id: string;
  type: "video" | "image";
  path: string;
  in: number;
  len: number;
  speed: number;
  placedWidth: number;
  name: string;
}

export function visualClips(tl: Timeline): VisualClip[] {
  return tl.tracks
    .filter((t) => t.kind === "video")
    .flatMap((t) => t.clips as VisualClip[])
    .filter((c) => c.type === "video" || c.type === "image")
    .sort((a, b) => a.start - b.start);
}

/** The analysis input: every local video/image clip with the source window it actually uses. */
export function enhanceSpec(tl: Timeline): SpecClip[] {
  const out: SpecClip[] = [];
  for (const c of visualClips(tl)) {
    // cut-out copies (looks) take their main clip's settings; inserts are graphics
    if (c.cutout || c.insert || c.gen) continue;
    const p = localMediaPath(c.src);
    if (!p) continue;
    const len = c.type === "video" ? c.duration * c.speed : 0;
    const w = c.srcWidth && c.srcHeight ? placement(c.srcWidth, c.srcHeight, tl.width, tl.height, c.transform).w : tl.width;
    out.push({
      id: c.id,
      type: c.type as "video" | "image",
      path: fwd(p),
      in: c.type === "video" ? c.in : 0,
      len: Math.max(0.2, len),
      speed: c.speed,
      placedWidth: Math.round(Math.min(w, tl.width * 2)),
      name: c.name,
    });
  }
  return out;
}

export function writeSpec(projectId: string, tl: Timeline) {
  const dir = path.join(ensureProjectDir(projectId), "edit", "enhance");
  mkdirSync(dir, { recursive: true });
  const clips = enhanceSpec(tl);
  writeFileSync(path.join(dir, "spec.json"), JSON.stringify({ width: tl.width, height: tl.height, fps: tl.fps, clips }, null, 1));
  return { dir, clips };
}

export function enhancePrompt(projectDir: string) {
  const d = `${fwd(projectDir)}/edit/enhance`;
  const tool = `${fwd(studioDir())}/tools/enhance.py`;
  return `Enhance pass for this project's clips: stabilise, denoise, sharpen, exposure/contrast/white balance, colour match. CPU only.

1. Run (one Bash call; it can take several minutes):
   python ${tool} analyze --spec ${d}/spec.json --out ${d}/analysis.json
   It measures every clip (exposure, white balance, noise, shake, sharpness), proposes settings, matches colour and
   brightness across clips, runs the numeric self-check (halos, detail/skin smear, skin hue, clipping, stabilisation
   gain/borders/crop) and steps a setting down when a check fails. It prints one line per clip.
2. Read ${d}/analysis.json, then look at every ${d}/sheet_<clipId>.jpg
   (top row: before | after full frame, incl. stabilisation; bottom row: aligned 1:1 crops before | after).
   Judge like a picky colourist: no halos or crunchy over-sharpening, no smeared skin, hair or fabric texture,
   no stabilisation warping, wobble or obvious crop, natural skin tones, and all clips look like one shoot.
3. Only if something looks wrong: write ${d}/overrides.json as {"<clipId>": {"<fix>": {partial settings}}}
   (a fix set to null is removed), then run
   python ${tool} check --spec ${d}/spec.json --analysis ${d}/analysis.json --overrides ${d}/overrides.json
   and look at the regenerated sheets. At most 2 rounds. Prefer turning a fix down or off over pushing it.
4. Write enhance.json:
   {"summary": "2-4 sentences: what was fixed overall, anything to watch, which clips are upscale candidates",
    "clips": [{"clipId": "...", "settings": {final settings from analysis.json incl. your changes},
               "review": {"ok": true|false, "notes": "what you saw in the sheet and what you changed"}}]}
   One entry per clip in analysis.json. Settings keys: stabilize, denoise, sharpen, color, match (same shapes as in
   analysis.json). Never add "upscale": the user decides about AI upscaling after seeing a time estimate.

Apply taste checklist rule R36 (Enhance) and every other active rule that touches picture quality (R29-R37).`;
}

/** Run worker/enhance.py and return stdout (throws with stderr on failure). */
export function runEnhanceTool(args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [enhanceScript(), ...args], {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`Could not run ${pythonBin()}: ${e.message}. Set PYTHON_BIN to a Python with numpy.`));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error((err.trim().split(/\r?\n/).slice(-3).join(" ") || `enhance.py exited with ${code}`).slice(0, 600)));
    });
  });
}

/** Cached before/after preview frame at the clip's placed width. Returns the JPEG path. */
export async function previewFrame(opts: {
  projectId: string;
  src: string;
  isImage: boolean;
  tIn: number;
  tLen: number;
  t: number;
  width: number;
  settings: object | null; // null = before
}) {
  const dir = path.join(ensureProjectDir(opts.projectId), "edit", "enhance", "frames");
  mkdirSync(dir, { recursive: true });
  const key = crypto
    .createHash("sha1")
    .update(JSON.stringify([opts.src, opts.isImage, opts.tIn.toFixed(3), opts.tLen.toFixed(3), opts.t.toFixed(3), opts.width, opts.settings]))
    .digest("hex")
    .slice(0, 20);
  const file = path.join(dir, `${key}.jpg`);
  if (existsSync(file)) return file;
  const args = ["frame", "--src", opts.src, "--in", String(opts.tIn), "--len", String(opts.tLen), "--t", String(opts.t), "--width", String(opts.width), "--out", file];
  if (opts.isImage) args.push("--image");
  if (opts.settings) args.push("--settings", JSON.stringify(opts.settings));
  else args.push("--before");
  await runEnhanceTool(args, 180_000);
  return file;
}
