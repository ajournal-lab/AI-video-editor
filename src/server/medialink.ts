import "server-only";
// Media from a link (Media library / new-edit drop zones → "Paste a link"): YouTube (incl. Shorts), TikTok, Instagram
// reels, Vimeo, X/Twitter and Google Drive files are fetched with yt-dlp (worker venv; TikTok needs --impersonate,
// i.e. curl_cffi), other http(s) links with a guarded direct download. The file is probed (video / image / audio),
// thumbnailed, hashed and stored like an upload. Same file (sha256) or same link already in the library = that asset.
// Link-sourced media is "personal use / timing only" (meta.rights = false) until the user says they have the rights.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MediaAsset, Prisma } from "@prisma/client";
import { nanoid } from "nanoid";
import { workerPython } from "@/agent/config";
import { prisma } from "./db";
import { HttpError } from "./http";
import { safeDownload } from "./safefetch";
import { deleteObject, driver, keyFromUrl, localPath, publicUrl } from "./storage";
import { nameTags } from "./tagging";

export type MediaLinkKind = "youtube" | "tiktok" | "instagram" | "vimeo" | "x" | "drive" | "direct";
const MAX_SECONDS = 30 * 60;
const MAX_DIRECT = 1024 * 1024 * 1024;

/** Which downloader a link needs (readable 400 for links that can't work). */
export function classifyMediaLink(raw: string): { kind: MediaLinkKind; url: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "That doesn't look like a link");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Only http(s) links work");
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|vm|vt)\./, "");
  const p = u.pathname;
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (host === "youtu.be" || /^\/(watch|shorts\/|live\/)/.test(p)) return { kind: "youtube", url: u.toString() };
    throw new HttpError(400, "Use a YouTube video or Shorts link (not a channel or playlist)");
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return { kind: "tiktok", url: u.toString() };
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    if (/^\/(reels?|p|tv)\/[\w-]+/.test(p)) return { kind: "instagram", url: `https://www.instagram.com${p}` };
    throw new HttpError(400, "Use an Instagram /reel/ or /p/ link");
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") return { kind: "vimeo", url: u.toString() };
  if (host === "x.com" || host === "twitter.com") {
    if (/\/status\/\d+/.test(p)) return { kind: "x", url: u.toString() };
    throw new HttpError(400, "Use a link to a post (…/status/…) that has a video");
  }
  if (host === "drive.google.com" || host === "docs.google.com") {
    const id = /\/d\/([\w-]{10,})/.exec(p)?.[1] ?? u.searchParams.get("id");
    if (!id || /\/folders\//.test(p)) throw new HttpError(400, "Use a Google Drive *file* link shared as “Anyone with the link” (folders aren't supported)");
    return { kind: "drive", url: `https://drive.google.com/file/d/${id}/view` };
  }
  return { kind: "direct", url: u.toString() };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`Could not run ${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, out, err });
    });
  });
}

const ffmpeg = () => process.env.FFMPEG_BIN || "ffmpeg";

interface Fetched {
  file: string;
  title: string;
  uploader: string | null;
}

function ytdlpMessage(err: string, kind: MediaLinkKind) {
  const line = err.split(/\r?\n/).filter((l) => l.includes("ERROR")).pop() ?? err.trim().split(/\r?\n/).pop() ?? "";
  if (/No module named yt_dlp/i.test(err)) return "yt-dlp isn't installed in the worker venv (pip install -U yt-dlp)";
  if (/does not pass filter/i.test(err)) return "That video is a live stream or longer than 30 minutes";
  if (/DRM protected/i.test(line)) return "That video is DRM-protected, so it can't be downloaded";
  if (kind === "vimeo" && /logged-in|401/i.test(line)) return "Vimeo only allows downloads when logged in: export your browser cookies to a cookies.txt and set YTDLP_COOKIES in .env (see README)";
  if (/logged-in|login|cookies|private|sign in|confirm your age/i.test(line))
    return `${kind === "drive" ? "Google Drive" : "The site"} wants a login for this one. Use a public link (Drive: share as “Anyone with the link”).`;
  if (/No video could be found/i.test(line)) return "There's no video in that post";
  if (/unavailable|not available|removed|404/i.test(line)) return "That video is unavailable (removed, private or region-locked)";
  return `Couldn't download it: ${line.replace(/^.*ERROR:\s*(\[[^\]]+\]\s*)?/, "").slice(0, 240)}`;
}

async function ytdlp(url: string, kind: MediaLinkKind, dir: string): Promise<Fetched> {
  const attempt = async (u: string, impersonate: boolean) =>
    run(
      workerPython(),
      [
        "-m", "yt_dlp", "--no-playlist", "--no-progress", "--restrict-filenames", "--js-runtimes", "node",
        // optional: a cookies.txt exported from your browser, for sites that want a login (Vimeo, private posts)
        ...(process.env.YTDLP_COOKIES ? ["--cookies", process.env.YTDLP_COOKIES] : []),
        ...(impersonate ? ["--impersonate", "chrome"] : []),
        // H.264 + AAC first (plays in every browser, no conversion), at most the reel's 1920 px
        "-S", "vcodec:h264,res:1920,acodec:m4a", "-f", "bv*+ba/b", "--merge-output-format", "mp4",
        "--match-filter", `!is_live & duration <? ${MAX_SECONDS}`,
        "--print", "after_move:%(title)s\t%(uploader_id|)s\t%(uploader|)s\t%(channel|)s",
        "-o", path.join(dir, "src.%(ext)s"), u,
      ],
      20 * 60_000,
    );
  let r = await attempt(url, kind === "tiktok");
  const file = () => readdirSync(dir).find((f) => f.startsWith("src.") && !f.endsWith(".part"));
  // TikTok and others sometimes need a browser fingerprint; vimeo.com/<id> pages may need the player URL
  if ((r.code !== 0 || !file()) && kind !== "tiktok") r = await attempt(url, true);
  const vimeoId = kind === "vimeo" ? /vimeo\.com\/(?:.*\/)?(\d+)/.exec(url)?.[1] : null;
  if ((r.code !== 0 || !file()) && vimeoId) r = await attempt(`https://player.vimeo.com/video/${vimeoId}`, false);
  const f = file();
  if (r.code !== 0 || !f) throw new HttpError(502, ytdlpMessage(r.err || r.out, kind));
  const [title, uploaderId, uploaderName, channel] = (r.out.trim().split(/\r?\n/).pop() ?? "").split("\t");
  // the @handle: YouTube's uploader_id is "@name"; TikTok's is numeric and its handle is `uploader`; X gives it as uploader_id
  const handleish = (v?: string) => (v && v !== "NA" && /^@?[\w.-]{2,40}$/.test(v) && !/^\d+$/.test(v) ? v : null);
  const uploader = handleish(uploaderId) ?? handleish(uploaderName) ?? (channel && channel !== "NA" ? channel : null);
  return { file: path.join(dir, f), title: title || "Imported video", uploader };
}

const MEDIA_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|jpg|jpeg|png|webp|gif|mp3|wav|m4a|aac|ogg|opus|flac)$/i;

async function direct(url: string, dir: string): Promise<Fetched> {
  const { buf, url: final } = await safeDownload(url, {
    maxBytes: MAX_DIRECT,
    what: "media file",
    timeoutMs: 10 * 60_000,
    accept: (type, u) => /^(video|image|audio)\//.test(type) || (["application/octet-stream", "binary/octet-stream", ""].includes(type) && MEDIA_EXT.test(u.pathname)),
  });
  const ext = (path.extname(final.pathname) || ".bin").slice(0, 6).toLowerCase();
  const file = path.join(dir, `src${ext}`);
  writeFileSync(file, buf);
  return { file, title: decodeURIComponent(path.basename(final.pathname, ext)).replace(/[_-]+/g, " ").trim() || "Imported media", uploader: null };
}

/** Google Drive: yt-dlp handles shared videos; other shared files (images, audio) via the public download URL. */
async function drive(url: string, dir: string): Promise<Fetched> {
  try {
    return await ytdlp(url, "drive", dir);
  } catch (err) {
    const id = /\/d\/([\w-]+)/.exec(url)![1];
    try {
      return await direct(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, dir);
    } catch {
      throw err;
    }
  }
}

interface Probe {
  type: "video" | "image" | "music";
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

async function probeFile(file: string): Promise<Probe> {
  const r = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height:stream_side_data=rotation", "-of", "json", file], 60_000);
  const j = JSON.parse(r.out || "{}") as { format?: { duration?: string; format_name?: string }; streams?: { codec_type: string; codec_name?: string; width?: number; height?: number; side_data_list?: { rotation?: number }[] }[] };
  const v = (j.streams ?? []).find((s) => s.codec_type === "video");
  const hasAudio = (j.streams ?? []).some((s) => s.codec_type === "audio");
  const dur = Number(j.format?.duration ?? 0) || null;
  const still = !!v && (/image2|png_pipe|jpeg_pipe|webp_pipe|gif/.test(j.format?.format_name ?? "") || /^(png|mjpeg|webp|bmp)$/.test(v.codec_name ?? "")) && !(dur && dur > 1);
  if (!v && !hasAudio) throw new HttpError(400, "That link isn't a video, image or audio file");
  const rot = Math.abs(v?.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0) % 180 === 90;
  return {
    type: !v ? "music" : still ? "image" : "video",
    duration: still ? null : dur,
    width: (rot ? v?.height : v?.width) ?? null,
    height: (rot ? v?.width : v?.height) ?? null,
    hasAudio,
  };
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/** Hash the user's stored files that have no hash yet (older uploads), so duplicates are found among them too. */
export async function backfillHashes(userId: string, limit = 200) {
  if (driver() !== "local") return;
  const rows = await prisma.mediaAsset.findMany({ where: { userId, hash: null, key: { not: null } }, select: { id: true, key: true }, take: limit });
  for (const r of rows) {
    try {
      const f = localPath(r.key!);
      if (existsSync(f)) await prisma.mediaAsset.update({ where: { id: r.id }, data: { hash: await sha256File(f) } });
    } catch {
      /* unreadable: leave it */
    }
  }
}

export async function findByHash(userId: string, hash: string): Promise<MediaAsset | null> {
  await backfillHashes(userId);
  return prisma.mediaAsset.findFirst({ where: { userId, hash }, orderBy: { createdAt: "asc" } });
}

/**
 * After a browser upload is registered: hash the stored file; if the same bytes are already in the library, delete
 * the new copy and return the existing asset instead.
 */
export async function dedupeUpload(userId: string, key: string, thumbKey: string | null): Promise<{ hash: string | null; existing: MediaAsset | null }> {
  if (driver() !== "local") return { hash: null, existing: null };
  const file = localPath(key);
  if (!existsSync(file)) return { hash: null, existing: null };
  const hash = await sha256File(file);
  const existing = await findByHash(userId, hash);
  if (existing && existing.key !== key) {
    await deleteObject(key);
    if (thumbKey) await deleteObject(thumbKey);
  }
  return { hash, existing: existing && existing.key !== key ? existing : null };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "media";

/** Download + probe + hash + store + register. Returns the asset and whether it was already in the library. */
export async function importMediaLink(userId: string, raw: string): Promise<{ asset: MediaAsset; duplicate: boolean }> {
  if (driver() !== "local") throw new HttpError(400, "Importing from a link needs local storage");
  const link = classifyMediaLink(raw);
  // the same link imported as media before (a "Music from a link" import of it is a different, audio-only asset)
  const same = await prisma.mediaAsset.findFirst({ where: { userId, AND: [{ meta: { path: ["link", "url"], equals: link.url } }, { meta: { path: ["importedAs"], equals: "media" } }] } });
  if (same) return { asset: same, duplicate: true };
  const tmp = mkdtempSync(path.join(os.tmpdir(), "rs-media-link-"));
  try {
    const got = link.kind === "direct" ? await direct(link.url, tmp) : link.kind === "drive" ? await drive(link.url, tmp) : await ytdlp(link.url, link.kind, tmp);
    const info = await probeFile(got.file);
    const hash = await sha256File(got.file);
    const dup = await findByHash(userId, hash);
    if (dup) return { asset: dup, duplicate: true };
    const ext = path.extname(got.file).toLowerCase() || (info.type === "image" ? ".jpg" : ".mp4");
    const folder = info.type === "music" ? "music" : info.type;
    const key = `u/${userId}/${folder}/${nanoid(10)}-${slug(got.title)}${ext}`;
    const dst = localPath(key);
    mkdirSync(path.dirname(dst), { recursive: true });
    renameSync(got.file, dst);
    let thumbUrl: string | null = info.type === "image" ? publicUrl(key) : null;
    if (info.type === "video") {
      const tk = `u/${userId}/thumb/${nanoid(10)}.jpg`;
      mkdirSync(path.dirname(localPath(tk)), { recursive: true });
      const t = await run(ffmpeg(), ["-y", "-loglevel", "error", "-ss", String(Math.min(1, (info.duration ?? 2) / 2)), "-i", dst, "-frames:v", "1", "-vf", "scale=360:-2", localPath(tk)], 60_000);
      if (t.code === 0 && existsSync(localPath(tk))) thumbUrl = publicUrl(tk);
    }
    const handle = !got.uploader ? null : /^@?[\w.-]+$/.test(got.uploader) ? `@${got.uploader.replace(/^@/, "")}` : got.uploader;
    const asset = await prisma.mediaAsset.create({
      data: {
        userId,
        type: info.type,
        source: "link",
        key,
        url: publicUrl(key),
        thumbUrl,
        name: got.title.slice(0, 120),
        mime: info.type === "video" ? "video/mp4" : null,
        duration: info.duration,
        width: info.width,
        height: info.height,
        hash,
        tags: [...new Set([...nameTags(got.title), link.kind === "direct" ? "link" : link.kind])].slice(0, 20),
        meta: {
          hasAudio: info.hasAudio,
          link: { url: link.url, kind: link.kind, fetchedAt: new Date().toISOString() },
          uploader: handle,
          importedAs: "media",
          rights: false,
          size: statSync(dst).size,
        } as Prisma.InputJsonValue,
      },
    });
    return { asset, duplicate: false };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export { keyFromUrl };
