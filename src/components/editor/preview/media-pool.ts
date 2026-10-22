"use client";

import { adjacentPrev, clamp, clipDucks, clipEnd, duckGain, fadeGain, keyframeGain, speechIntervals } from "@/lib/timeline/derive";
import type { AudioClip, Timeline, VisualClip } from "@/lib/timeline/types";
import type { FrameSource } from "./draw";

// Keeps one media element per clip near the playhead, seeked/playing in sync with
// the timeline clock. Elements far from the playhead are released.

const LOOKBEHIND = 1.5;
const LOOKAHEAD = 5;

const intervalsCache = new WeakMap<Timeline, [number, number][]>();
function intervals(tl: Timeline) {
  let v = intervalsCache.get(tl);
  if (!v) {
    v = speechIntervals(tl);
    intervalsCache.set(tl, v);
  }
  return v;
}

export class MediaPool implements FrameSource {
  private videos = new Map<string, HTMLVideoElement>();
  private audios = new Map<string, HTMLAudioElement>();
  private images = new Map<string, HTMLImageElement>();
  onFrame: () => void = () => {};

  source(clip: VisualClip) {
    if (!clip.src) return null;
    if (clip.type === "image") {
      const img = this.image(clip.src);
      return img.complete && img.naturalWidth ? { el: img, w: img.naturalWidth, h: img.naturalHeight } : null;
    }
    const v = this.videos.get(clip.id);
    if (!v || v.readyState < 2) return null;
    return { el: v, w: v.videoWidth, h: v.videoHeight };
  }

  /** The clip's person matte, synced with its video (draw.ts masks the frame with it). */
  matte(clip: VisualClip) {
    if (!clip.matte?.on) return null;
    const m = this.videos.get(`${clip.id}:matte`);
    if (!m || m.readyState < 2) return null;
    return { el: m, w: m.videoWidth, h: m.videoHeight };
  }

  private image(src: string) {
    let img = this.images.get(src);
    if (!img) {
      img = new Image();
      img.decoding = "async";
      img.onload = () => this.onFrame();
      img.src = src;
      this.images.set(src, img);
    }
    return img;
  }

  private video(clip: VisualClip, key = clip.id, src = clip.src!) {
    let v = this.videos.get(key);
    if (!v || v.dataset.src !== src) {
      v?.pause();
      v = document.createElement("video");
      v.dataset.src = src;
      v.playsInline = true;
      v.preload = "auto";
      v.muted = true;
      v.src = src;
      v.addEventListener("seeked", () => this.onFrame());
      v.addEventListener("loadeddata", () => this.onFrame());
      this.videos.set(key, v);
    }
    return v;
  }

  private audio(clip: AudioClip) {
    let a = this.audios.get(clip.id);
    if (!a || a.dataset.src !== clip.src) {
      a?.pause();
      a = new Audio();
      a.dataset.src = clip.src;
      a.preload = "auto";
      a.src = clip.src;
      this.audios.set(clip.id, a);
    }
    return a;
  }

  /** Bring every element in line with time t. Called every animation frame. */
  sync(tl: Timeline, t: number, playing: boolean) {
    const keepV = new Set<string>();
    const keepA = new Set<string>();
    const near = (c: { start: number; duration: number }) => c.start < t + LOOKAHEAD && clipEnd(c) > t - LOOKBEHIND;

    for (const track of tl.tracks) {
      if (track.kind === "video") {
        if (track.hidden) continue;
        for (const c of track.clips) {
          if (c.type === "image" && c.src && near(c)) this.image(c.src);
          if (c.type !== "video" || !c.src || !near(c)) continue;
          keepV.add(c.id);
          const v = this.video(c);
          const active = t >= c.start && t < clipEnd(c);
          const next = track.clips.find((n) => n.transition && n.transition.type !== "cut" && t >= n.start && t < n.start + n.transition.duration);
          const holding = !active && next && adjacentPrev(track.clips, next)?.id === c.id;
          const srcDur = Number.isFinite(v.duration) ? v.duration : (c.srcDuration ?? Infinity);
          const outPoint = c.in + c.duration * c.speed;
          let target = active ? c.in + (t - c.start) * c.speed : holding ? outPoint - 0.04 : c.in;
          target = clamp(target, 0, Math.max(0, srcDur - 0.04));
          const audible = playing && active && !track.muted && !c.muted && c.volume > 0;
          v.muted = !audible;
          if (audible) v.volume = clamp(c.volume * fadeGain(c, t), 0, 1);
          this.drive(v, target, playing && active && target < srcDur - 0.05, c.speed);
          if (c.matte?.on && c.matte.url) {
            const key = `${c.id}:matte`;
            keepV.add(key);
            const m = this.video(c, key, c.matte.url);
            const mt = clamp(target - c.matte.srcIn, 0, Math.max(0, c.matte.srcLen - 0.02));
            this.drive(m, mt, playing && active && target < srcDur - 0.05, c.speed);
          }
        }
      } else if (track.kind === "voice" || track.kind === "music") {
        for (const c of track.clips) {
          if (!near(c)) continue;
          keepA.add(c.id);
          const a = this.audio(c);
          const active = t >= c.start && t < clipEnd(c);
          let gain = c.volume * fadeGain(c, t);
          if (track.kind === "music") {
            gain *= keyframeGain(c, t - c.start);
            if (clipDucks(tl, c)) gain *= duckGain(intervals(tl), tl.duckLevel, t);
          }
          a.volume = clamp(gain, 0, 1);
          a.muted = Boolean(track.muted || c.muted);
          const target = c.in + clamp(t - c.start, 0, c.duration) * c.speed;
          this.drive(a, target, playing && active, c.speed);
        }
      }
    }
    for (const [id, v] of this.videos) if (!keepV.has(id)) this.release(v, () => this.videos.delete(id));
    for (const [id, a] of this.audios) if (!keepA.has(id)) this.release(a, () => this.audios.delete(id));
  }

  private drive(el: HTMLMediaElement, target: number, play: boolean, speed: number) {
    if (play) {
      if (el.playbackRate !== speed) el.playbackRate = speed;
      if (el.paused) {
        if (Math.abs(el.currentTime - target) > 0.05) el.currentTime = target;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - target) > 0.3) {
        el.currentTime = target;
      }
    } else {
      if (!el.paused) el.pause();
      if (!el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - target) > 0.02) el.currentTime = target;
    }
  }

  private release(el: HTMLMediaElement, drop: () => void) {
    el.pause();
    el.removeAttribute("src");
    el.load();
    drop();
  }

  pauseAll() {
    for (const v of this.videos.values()) v.pause();
    for (const a of this.audios.values()) a.pause();
  }

  dispose() {
    for (const v of this.videos.values()) this.release(v, () => {});
    for (const a of this.audios.values()) this.release(a, () => {});
    this.videos.clear();
    this.audios.clear();
    this.images.clear();
  }
}
