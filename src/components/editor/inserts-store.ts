"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { insertSpecs, type InsertStatus } from "@/lib/timeline/inserts";
import { api } from "@/lib/client/api";
import { useEditor } from "./store";

// Insert build status (InsertJob rows), keyed by spec hash. The player draws a placeholder until an insert is built.
interface InsertsState {
  by: Record<string, InsertStatus>;
  set(list: InsertStatus[]): void;
}

export const useInserts = create<InsertsState>((set) => ({
  by: {},
  set: (list) => set({ by: Object.fromEntries(list.map((s) => [s.hash, s])) }),
}));

const active = (s?: InsertStatus) => !s || s.status === "queued" || s.status === "processing";

/** Queue any insert on the timeline that has no job yet, and poll while some are building. */
export function useInsertSync(projectId: string) {
  const specs = useEditor((s) => JSON.stringify(insertSpecs(s.timeline).map((x) => x.hash)));
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const want = insertSpecs(useEditor.getState().timeline);
        const r = await api<{ inserts: InsertStatus[] }>(`/api/projects/${projectId}/inserts`);
        const by = Object.fromEntries(r.inserts.map((s) => [s.hash, s]));
        const missing = want.filter((w) => !by[w.hash]);
        let list = r.inserts;
        if (missing.length) list = (await api<{ inserts: InsertStatus[] }>(`/api/projects/${projectId}/inserts`, { method: "POST", json: { specs: missing.map((m) => m.spec) } })).inserts;
        if (!alive) return;
        const prev = useInserts.getState().by;
        for (const s of list) {
          if (prev[s.hash] && prev[s.hash].status !== "done" && s.status === "done") toast.success(`Insert ready: ${s.kind.replace("_", " ")}`);
          if (prev[s.hash] && prev[s.hash].status !== "failed" && s.status === "failed") toast.error(`Insert failed: ${s.error ?? s.kind}`);
        }
        useInserts.getState().set(list);
        const now = Object.fromEntries(list.map((s) => [s.hash, s]));
        if (want.some((w) => active(now[w.hash]))) timer = setTimeout(tick, 2000);
      } catch (e) {
        if (alive) toast.error((e as Error).message);
      }
    };
    tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, specs]);
}
