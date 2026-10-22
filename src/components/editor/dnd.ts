"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { findClip, SFX_MAX_SECONDS, timelineDuration } from "@/lib/timeline/derive";
import { newAudioClip, newTextClip, newVisualClip, TEXT_PRESETS } from "@/lib/timeline/factory";
import { addClip, updateClip } from "@/lib/timeline/ops";
import type { AnyClip, TrackKind, VisualClip } from "@/lib/timeline/types";
import { uploadAsset, type AssetDTO } from "@/lib/client/upload";
import { useEditor } from "./store";

export const DRAG_MIME = "application/x-reelsmith";

export type DragPayload =
  | { kind: "asset"; asset: AssetDTO }
  | { kind: "text"; preset: keyof typeof TEXT_PRESETS };

export function dragProps(payload: DragPayload) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
      e.dataTransfer.effectAllowed = "copy";
    },
  };
}

export function clipForAsset(a: AssetDTO, start: number): { clip: AnyClip; kind: TrackKind } {
  const tl = useEditor.getState().timeline;
  if (a.type === "video" || a.type === "image") {
    return {
      kind: "video",
      clip: newVisualClip({
        type: a.type,
        start,
        duration: a.type === "video" ? Math.min(a.duration ?? 5, 8) : 4,
        assetId: a.id,
        src: a.url,
        thumb: a.thumbUrl ?? (a.type === "image" ? a.url : null),
        name: a.name,
        srcDuration: a.duration,
        srcWidth: a.width,
        srcHeight: a.height,
        hasAudio: a.meta?.hasAudio ?? a.type === "video",
        muted: a.source === "pexels",
        keywords: a.tags,
      }),
    };
  }
  const isMusic = a.type === "music";
  // a short sound (or one tagged sfx) is a sound effect: never ducked, kept 6 dB under the voice (audio safety)
  const sfx = isMusic && ((a.duration ?? Infinity) <= SFX_MAX_SECONDS || a.tags?.includes("sfx"));
  const remaining = Math.max(5, timelineDuration(tl) - start);
  return {
    kind: isMusic ? "music" : "voice",
    clip: newAudioClip({
      src: a.url,
      assetId: a.id,
      name: a.name,
      start,
      duration: Math.min(a.duration ?? remaining, isMusic ? remaining : Infinity),
      srcDuration: a.duration,
      volume: sfx ? 0.6 : isMusic ? 0.5 : 1,
      duck: sfx ? false : isMusic,
      sfx: sfx || undefined,
      fadeOut: isMusic && !sfx ? 1.5 : 0,
    }),
  };
}

export async function addPayload(p: DragPayload, trackId: string | null, time: number) {
  const s = useEditor.getState();
  let clip: AnyClip;
  let kind: TrackKind;
  if (p.kind === "text") {
    clip = newTextClip(p.preset, time, s.timeline.aspect);
    kind = "text";
  } else {
    ({ clip, kind } = clipForAsset(p.asset, time));
  }
  // Drop onto an incompatible lane -> first track of the right kind.
  const target = trackId ? s.timeline.tracks.find((t) => t.id === trackId) : null;
  const st = useEditor.getState();
  st.commit(addClip(st.timeline, target && target.kind === kind ? target.id : null, clip, kind), "Add clip");
  st.select([clip.id]);
}

export function useDropHandler() {
  return useCallback((p: DragPayload, trackId: string | null, time: number) => {
    addPayload(p, trackId, time).catch((err) => toast.error((err as Error).message));
  }, []);
}

/** Swap the media of a visual clip, keeping its timing, transition and effects. */
export function replaceClipMedia(clipId: string, asset: AssetDTO) {
  const s = useEditor.getState();
  const hit = findClip(s.timeline, clipId);
  if (!hit || hit.clip.type === "text" || hit.clip.type === "audio") return false;
  if (asset.type !== "video" && asset.type !== "image") {
    toast.error("Pick a video or photo");
    return false;
  }
  const c = hit.clip as VisualClip;
  const patch: Partial<VisualClip> = {
    type: asset.type,
    assetId: asset.id,
    src: asset.url,
    thumb: asset.thumbUrl ?? asset.url,
    srcDuration: asset.duration,
    srcWidth: asset.width,
    srcHeight: asset.height,
    hasAudio: asset.meta?.hasAudio ?? asset.type === "video",
    muted: asset.source === "pexels" ? true : c.muted,
    in: 0,
    colors: null,
    keywords: asset.tags,
    name: c.scene ? `Scene ${c.scene} · ${asset.source === "ai" ? "AI" : asset.name}` : asset.name,
    kenBurns: asset.type === "image" ? (c.kenBurns ?? { direction: "in", amount: 0.12 }) : null,
  };
  if (asset.type === "video" && asset.duration) patch.duration = Math.min(c.duration, asset.duration);
  s.commit(updateClip(s.timeline, c.id, patch as Partial<AnyClip>), "Replace media");
  return true;
}

/** Files dropped from the computer: upload to the library, then place on the timeline. */
export async function uploadAndAdd(files: FileList | File[], trackId: string | null, time: number) {
  const list = [...files].filter((f) => /^(image|video|audio)\//.test(f.type));
  if (!list.length) return toast.error("Drop photos, videos or audio files");
  const id = toast.loading(`Uploading ${list.length} file${list.length > 1 ? "s" : ""}…`);
  let t = time;
  try {
    for (const f of list) {
      const asset = await uploadAsset(f, "auto");
      const s = useEditor.getState();
      s.setAssets([asset, ...Object.values(s.assets)]);
      await addPayload({ kind: "asset", asset }, trackId, t);
      const added = useEditor.getState().selection[0];
      const clip = added ? findClip(useEditor.getState().timeline, added)?.clip : null;
      if (clip) t = clip.start + clip.duration; // place several files back to back
    }
    toast.success(`Added ${list.length} file${list.length > 1 ? "s" : ""}`, { id });
  } catch (e) {
    toast.error((e as Error).message, { id });
  }
}
