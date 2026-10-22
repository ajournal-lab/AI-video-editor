"use client";

import { useEffect, useRef } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { applyLooks, detectScriptCues, looksStale } from "@/lib/timeline/looks";
import { matteWindows } from "@/lib/timeline/matte";
import type { Timeline, VisualClip } from "@/lib/timeline/types";
import { api } from "@/lib/client/api";
import { useEditor } from "./store";

// Keeps the looks built: whenever the edit or the look settings change, applyLooks() rebuilds the generated content
// (no undo step of its own: undo/redo just rebuild again), cut-out copies without a matte get one queued (reused when
// the same source window was cut out before), and finished matte jobs switch their cut-outs on.

export interface LooksInfo {
  reels: { url: string; thumb: string | null; title: string; renderId: string }[];
  clientLook: "bold" | "cool_girl" | "cool_dude" | null;
  handle: string | null;
  loaded: boolean;
  mattes: Record<string, "queued" | "running" | "done" | "failed">;
}
export const useLooksInfo = create<LooksInfo & { set(p: Partial<LooksInfo>): void }>((set) => ({
  reels: [],
  clientLook: null,
  handle: null,
  loaded: false,
  mattes: {},
  set: (p) => set(p),
}));

/** Sources whose cut-out failed this session: not re-queued in a loop (re-open the project to try again). */
const failedSrc = new Set<string>();

const cutoutClips = (tl: Timeline) => tl.tracks.flatMap((t) => (t.kind === "video" && t.role === "cutout" ? t.clips : [])) as VisualClip[];

function mapCutouts(tl: Timeline, fn: (c: VisualClip) => VisualClip): Timeline {
  let changed = false;
  const tracks = tl.tracks.map((t) => {
    if (t.kind !== "video" || t.role !== "cutout") return t;
    return {
      ...t,
      clips: t.clips.map((c) => {
        const n = fn(c);
        if (n !== c) changed = true;
        return n;
      }),
    };
  });
  return changed ? ({ ...tl, tracks } as Timeline) : tl;
}

export function useLooksSync(projectId: string) {
  const timeline = useEditor((s) => s.timeline);
  const queuing = useRef(false);

  useEffect(() => {
    if (!projectId) return;
    api<{ reels: LooksInfo["reels"]; clientLook: LooksInfo["clientLook"]; handle: string | null }>(`/api/projects/${projectId}/looks`)
      .then((r) => useLooksInfo.getState().set({ ...r, loaded: true }))
      .catch(() => useLooksInfo.getState().set({ loaded: true }));
  }, [projectId]);

  // rebuild (debounced; never mid-drag, never on an AI preview)
  useEffect(() => {
    const t = setTimeout(() => {
      const s = useEditor.getState();
      if (s.gestureBase || s.preview) return;
      const tl = s.timeline;
      const needs = tl.looks ? looksStale(tl) : detectScriptCues(tl).length > 0;
      if (!needs || !useLooksInfo.getState().loaded) return;
      const r = applyLooks(tl, { defaultOrbitSources: useLooksInfo.getState().reels.slice(0, 4).map((x) => x.url) });
      useEditor.getState().patch(r.tl);
      if (!tl.looks && r.tl.looks) toast.info("Look switch found in your script: the looks are on (Looks panel).");
    }, 350);
    return () => clearTimeout(t);
  }, [timeline]);

  // queue a matte for cut-out copies that have none
  useEffect(() => {
    if (queuing.current) return;
    const missing = cutoutClips(timeline).filter((c) => !c.matte && c.src && !failedSrc.has(c.src));
    if (!missing.length) return;
    queuing.current = true;
    api<{ queued: { src: string; job: { id: string; status: string }; url: string; srcIn: number; srcLen: number }[] }>(`/api/projects/${projectId}/matte`, {
      method: "POST",
      json: { windows: matteWindows(missing), run: true },
    })
      .then(({ queued }) => {
        const by = new Map(queued.map((q) => [q.src, q]));
        const s = useEditor.getState();
        s.patch(
          mapCutouts(s.timeline, (c) => {
            const q = c.src ? by.get(c.src) : undefined;
            if (c.matte || !q) return c;
            const done = q.job.status === "done";
            return { ...c, matte: { on: done, url: q.url, srcIn: q.srcIn, srcLen: q.srcLen, fps: 0, jobId: done ? null : q.job.id } };
          }),
        );
      })
      .catch((e) => toast.error(`Couldn't queue the cut-out: ${(e as Error).message}`))
      .finally(() => (queuing.current = false));
  }, [timeline, projectId]);

  // follow the matte jobs; switch cut-outs on when done
  const pending = [...new Set(cutoutClips(timeline).map((c) => c.matte?.jobId).filter((x): x is string => !!x))].sort().join(",");
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const tick = async () => {
      for (const id of pending.split(",")) {
        try {
          const { job } = await api<{ job: { status: string; error: string | null } }>(`/api/agent/jobs/${id}`);
          if (!alive) return;
          useLooksInfo.getState().set({ mattes: { ...useLooksInfo.getState().mattes, [id]: job.status as LooksInfo["mattes"][string] } });
          if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
            const ok = job.status === "done";
            const s = useEditor.getState();
            if (!ok) for (const c of cutoutClips(s.timeline)) if (c.matte?.jobId === id && c.src) failedSrc.add(c.src);
            s.patch(mapCutouts(s.timeline, (c) => (c.matte?.jobId === id ? { ...c, matte: ok ? { ...c.matte, on: true, jobId: null } : null } : c)));
            if (ok) toast.success("Speaker cut out: words behind the head are live.");
            else toast.error(`Cutting the speaker out failed: ${job.error ?? job.status}`);
          }
        } catch {
          /* keep polling */
        }
      }
    };
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pending]);
}
