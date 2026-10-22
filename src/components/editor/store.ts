"use client";

import { create } from "zustand";
import { clamp, timelineDuration } from "@/lib/timeline/derive";
import type { Timeline } from "@/lib/timeline/types";
import type { AssetDTO } from "@/lib/client/upload";

// Editor state. The timeline is immutable: every edit produces a new object, and
// the previous one goes on the undo stack (unbounded — "unlimited undo"). Drags
// use begin/live/end so a whole gesture is one history step.

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";

interface EditorState {
  projectId: string;
  title: string;
  timeline: Timeline;
  past: { tl: Timeline; label: string }[];
  future: { tl: Timeline; label: string }[];
  gestureBase: Timeline | null;
  preview: Timeline | null; // AI edit preview shown in the player
  selection: string[];
  playhead: number;
  playing: boolean;
  zoom: number; // px per second
  snapping: boolean;
  save: SaveState;
  revision: number;
  version: number; // bumps on every timeline change (autosave trigger)
  assets: Record<string, AssetDTO>;
  panel: string;
  replaceTarget: string | null; // visual clip waiting for a media pick

  init(p: { projectId: string; title: string; timeline: Timeline; revision: number }): void;
  commit(next: Timeline, label?: string): void;
  /** Replace the timeline without an undo step (generated content, e.g. looks rebuilt from the edit); autosaved. */
  patch(next: Timeline): void;
  begin(): void;
  live(next: Timeline): void;
  end(label?: string): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  select(ids: string[], additive?: boolean): void;
  setPlayhead(t: number): void;
  setPlaying(p: boolean): void;
  setZoom(z: number): void;
  setPreview(tl: Timeline | null): void;
  setSave(s: SaveState, revision?: number): void;
  setAssets(list: AssetDTO[]): void;
  setPanel(p: string): void;
  setTitle(t: string): void;
  toggleSnapping(): void;
  setReplaceTarget(id: string | null): void;
}

export const useEditor = create<EditorState>((set, get) => ({
  projectId: "",
  title: "",
  timeline: null as unknown as Timeline,
  past: [],
  future: [],
  gestureBase: null,
  preview: null,
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 60,
  snapping: true,
  save: "saved",
  revision: 0,
  version: 0,
  assets: {},
  panel: "chat",
  replaceTarget: null,

  init: ({ projectId, title, timeline, revision }) =>
    set({ projectId, title, timeline, revision, past: [], future: [], selection: [], playhead: 0, playing: false, save: "saved", version: 0, preview: null }),

  commit: (next, label = "Edit") => {
    const { timeline, past, version } = get();
    if (next === timeline) return;
    set({ timeline: next, past: [...past, { tl: timeline, label }], future: [], version: version + 1, save: "dirty" });
  },

  patch: (next) => {
    const { timeline, version, gestureBase } = get();
    if (next === timeline || gestureBase) return;
    set({ timeline: next, version: version + 1, save: "dirty" });
  },

  begin: () => set({ gestureBase: get().timeline }),
  live: (next) => set({ timeline: next }),
  end: (label = "Edit") => {
    const { gestureBase, timeline, past, version } = get();
    if (!gestureBase) return;
    if (gestureBase === timeline) return set({ gestureBase: null });
    set({ gestureBase: null, past: [...past, { tl: gestureBase, label }], future: [], version: version + 1, save: "dirty" });
  },
  cancelGesture: () => {
    const { gestureBase } = get();
    if (gestureBase) set({ timeline: gestureBase, gestureBase: null });
  },

  undo: () => {
    const { past, future, timeline, version } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ timeline: prev.tl, past: past.slice(0, -1), future: [{ tl: timeline, label: prev.label }, ...future], version: version + 1, save: "dirty", preview: null });
  },
  redo: () => {
    const { past, future, timeline, version } = get();
    const next = future[0];
    if (!next) return;
    set({ timeline: next.tl, future: future.slice(1), past: [...past, { tl: timeline, label: next.label }], version: version + 1, save: "dirty", preview: null });
  },

  select: (ids, additive) => {
    if (!additive) return set({ selection: ids });
    const cur = new Set(get().selection);
    for (const id of ids) {
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
    }
    set({ selection: [...cur] });
  },
  setPlayhead: (t) => set({ playhead: clamp(t, 0, Math.max(0, timelineDuration(get().preview ?? get().timeline))) }),
  setPlaying: (p) => set({ playing: p }),
  setZoom: (z) => set({ zoom: clamp(z, 4, 800) }),
  setPreview: (tl) => set({ preview: tl }),
  setSave: (s, revision) => set(revision !== undefined ? { save: s, revision } : { save: s }),
  setAssets: (list) => set({ assets: Object.fromEntries(list.map((a) => [a.id, a])) }),
  setPanel: (panel) => set({ panel }),
  setTitle: (title) => set({ title }),
  toggleSnapping: () => set({ snapping: !get().snapping }),
  setReplaceTarget: (id) => set(id ? { replaceTarget: id, panel: "media" } : { replaceTarget: null }),
}));

/** The timeline the player shows: the AI preview when one is active. */
export const useShownTimeline = () => useEditor((s) => s.preview ?? s.timeline);
