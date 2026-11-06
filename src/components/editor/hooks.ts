"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/client/api";
import type { Timeline } from "@/lib/timeline/types";
import { useEditor } from "./store";
import { deleteSelected, duplicateSelected, splitSelected } from "./timeline/Timeline";
import { WORKSPACES, useWorkspace } from "@/lib/workspace";

/** Debounced autosave of the timeline JSON (every change, ~1.5 s after the last one). */
export function useAutosave() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inflight = false;

    const save = async (force = false) => {
      const s = useEditor.getState();
      if (inflight) return schedule();
      if (s.save !== "dirty" && !force) return;
      inflight = true;
      const version = s.version;
      s.setSave("saving");
      try {
        const r = await api<{ revision: number }>(`/api/projects/${s.projectId}/timeline`, {
          method: "PUT",
          json: { json: s.timeline, revision: s.revision, force },
        });
        const now = useEditor.getState();
        now.setSave(now.version === version ? "saved" : "dirty", r.revision);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          useEditor.getState().setSave("conflict");
          toast.error("This project was changed in another tab.", {
            duration: Infinity,
            action: { label: "Keep mine", onClick: () => save(true) },
          });
        } else {
          useEditor.getState().setSave("error");
          toast.error(`Autosave failed: ${(e as Error).message}`);
        }
      } finally {
        inflight = false;
        if (useEditor.getState().save === "dirty") schedule();
      }
    };
    const schedule = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => save(), 1500);
    };
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.version !== prev.version && s.save !== "conflict") schedule();
    });
    const warn = (e: BeforeUnloadEvent) => {
      const st = useEditor.getState().save;
      if (st === "dirty" || st === "saving") {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      unsub();
      if (timer) clearTimeout(timer);
      window.removeEventListener("beforeunload", warn);
    };
  }, []);
}

/** Save now (used before render / versioning). */
export async function saveNow() {
  const s = useEditor.getState();
  if (s.save === "saved") return;
  const r = await api<{ revision: number }>(`/api/projects/${s.projectId}/timeline`, {
    method: "PUT",
    json: { json: s.timeline, revision: s.revision, force: true },
  });
  s.setSave("saved", r.revision);
}

const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.getAttribute("role") === "slider");

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      const s = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      // Premiere-style keys (workspace setting): C or Ctrl/Cmd+K splits, J/K/L step back / pause / play.
      if (WORKSPACES[useWorkspace.getState().id]?.premiereKeys) {
        if ((mod && k === "k") || (!mod && k === "c")) {
          e.preventDefault();
          splitSelected();
          return;
        }
        if (!mod && (k === "j" || k === "k" || k === "l")) {
          e.preventDefault();
          if (k === "j") {
            s.setPlaying(false);
            s.setPlayhead(s.playhead - 1);
          } else s.setPlaying(k === "l");
          return;
        }
      }
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        s.redo();
      } else if (mod && k === "d") {
        e.preventDefault();
        duplicateSelected();
      } else if (mod && k === "a") {
        e.preventDefault();
        s.select(s.timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      } else if (k === " ") {
        e.preventDefault();
        s.setPlaying(!s.playing);
      } else if (k === "s" && !mod) {
        e.preventDefault();
        splitSelected();
      } else if (k === "delete" || k === "backspace") {
        e.preventDefault();
        deleteSelected(e.shiftKey);
      } else if (k === "arrowleft" || k === "arrowright") {
        e.preventDefault();
        const step = e.shiftKey ? 1 : 1 / s.timeline.fps;
        s.setPlaying(false);
        s.setPlayhead(s.playhead + (k === "arrowleft" ? -step : step));
      } else if (k === "home") {
        s.setPlayhead(0);
      } else if (k === "escape") {
        s.select([]);
        s.setReplaceTarget(null);
      } else if (k === "=" || k === "+") {
        s.setZoom(s.zoom * 1.25);
      } else if (k === "-") {
        s.setZoom(s.zoom / 1.25);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function cloneTimeline(tl: Timeline) {
  return structuredClone(tl);
}
