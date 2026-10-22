"use client";

import { api } from "./api";

export type UploadKind = "voice" | "video" | "image" | "music" | "audio" | "thumb";

/** Presign + direct PUT (R2 or the local dev route), with progress. Returns the public URL. */
export async function uploadFile(file: Blob, name: string, kind: UploadKind, onProgress?: (p: number) => void) {
  const contentType = file.type || "application/octet-stream";
  const { uploadUrl, url } = await api<{ uploadUrl: string; url: string; key: string }>("/api/uploads", {
    method: "POST",
    json: { name, contentType, kind },
  });
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Upload failed — check your connection (and R2 CORS if using R2)"));
    xhr.send(file);
  });
  onProgress?.(1);
  return url;
}

export interface MediaInfo {
  type: "video" | "image" | "audio";
  duration: number | null;
  width: number | null;
  height: number | null;
  thumb: Blob | null;
  hasAudio: boolean;
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.82));
}

function thumbFrom(source: CanvasImageSource, w: number, h: number) {
  const scale = Math.min(1, 480 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(2, Math.round(w * scale));
  c.height = Math.max(2, Math.round(h * scale));
  c.getContext("2d")!.drawImage(source, 0, 0, c.width, c.height);
  return canvasToBlob(c);
}

/** Read duration/size and grab a thumbnail in the browser (no server-side probing needed). */
export async function inspectFile(file: File): Promise<MediaInfo> {
  const url = URL.createObjectURL(file);
  try {
    if (file.type.startsWith("image/")) {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { type: "image", duration: null, width: img.naturalWidth, height: img.naturalHeight, thumb: await thumbFrom(img, img.naturalWidth, img.naturalHeight), hasAudio: false };
    }
    if (file.type.startsWith("video/")) {
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "auto";
      v.playsInline = true;
      v.src = url;
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error("This video format can't be read by your browser"));
      });
      const duration = Number.isFinite(v.duration) ? v.duration : null;
      v.currentTime = Math.min(1, (duration ?? 2) / 3);
      await new Promise((r) => (v.onseeked = r));
      const anyV = v as HTMLVideoElement & { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; audioTracks?: { length: number } };
      const hasAudio = anyV.mozHasAudio ?? (anyV.audioTracks ? anyV.audioTracks.length > 0 : true);
      return { type: "video", duration, width: v.videoWidth, height: v.videoHeight, thumb: await thumbFrom(v, v.videoWidth, v.videoHeight), hasAudio };
    }
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.src = url;
    await new Promise<void>((res) => {
      a.onloadedmetadata = () => res();
      a.onerror = () => res();
    });
    return { type: "audio", duration: Number.isFinite(a.duration) ? a.duration : null, width: null, height: null, thumb: null, hasAudio: true };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export interface LinkAudioAnalysis {
  duration: number;
  tempo: number | null;
  beatPeriod: number | null;
  beats: number[];
  strongOnsets: number[];
  drops: { t: number; score: number }[]; // best first
  lufs: number | null;
  truePeak: number | null; // dBTP
}

export interface AssetDTO {
  id: string;
  type: "video" | "image" | "audio" | "music";
  source: string;
  url: string;
  thumbUrl: string | null;
  name: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  tags: string[];
  meta: {
    peaks?: number[];
    peaksPerSec?: number;
    hasAudio?: boolean;
    author?: string;
    // link-sourced music (Music panel → Paste link)
    link?: { url: string; kind: "instagram" | "youtube" | "tiktok" | "vimeo" | "x" | "drive" | "direct"; fetchedAt: string };
    uploader?: string | null;
    rights?: boolean; // false = timing only / personal use
    analysis?: LinkAudioAnalysis;
  } | null;
  createdAt: string;
  duplicate?: boolean; // the upload / link was already in the library: this is the existing asset
}

/** SHA-256 of a file in the browser (hex), or null when it's too big to hash in memory / no WebCrypto. */
export async function fileHash(file: Blob): Promise<string | null> {
  if (!globalThis.crypto?.subtle || file.size > 1.5 * 1024 ** 3) return null;
  try {
    const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

/** Full library upload: inspect, upload file + thumbnail, register (server auto-tags). A file that is already in the
 *  library (same bytes) isn't uploaded again: the existing asset comes back with duplicate = true. */
export async function uploadAsset(
  file: File,
  as: "auto" | "music",
  onProgress?: (p: number) => void,
  source: "upload" | "gemini_manual" = "upload",
): Promise<AssetDTO> {
  const hash = await fileHash(file);
  if (hash) {
    const { asset: known } = await api<{ asset: AssetDTO | null }>("/api/media/exists", { method: "POST", json: { hash } });
    if (known) {
      onProgress?.(1);
      return { ...known, duplicate: true };
    }
  }
  const info = await inspectFile(file);
  const type = as === "music" || (info.type === "audio" && as === "auto") ? "music" : info.type;
  const url = await uploadFile(file, file.name, type === "music" ? "music" : info.type, (p) => onProgress?.(p * 0.95));
  const thumbUrl = info.thumb ? await uploadFile(info.thumb, "thumb.jpg", "thumb") : null;
  const { asset, duplicate } = await api<{ asset: AssetDTO; duplicate?: boolean }>("/api/media", {
    method: "POST",
    json: {
      source,
      type,
      url,
      thumbUrl,
      name: file.name,
      mime: file.type,
      duration: info.duration,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
    },
  });
  onProgress?.(1);
  return duplicate ? { ...asset, duplicate: true } : asset;
}

/** Import from a link (YouTube, Shorts, TikTok, Instagram, Vimeo, X, Google Drive, direct file). */
export async function importLink(url: string): Promise<AssetDTO> {
  const { asset, duplicate } = await api<{ asset: AssetDTO; duplicate: boolean }>("/api/media/link", { method: "POST", json: { url } });
  return duplicate ? { ...asset, duplicate: true } : asset;
}
