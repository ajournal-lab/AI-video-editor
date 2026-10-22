"use client";

// Chat + two-stage workflow state for one project, shared by the chat panel, the stills review and the export gate.
// useChatSync() (mounted once per page) polls /api/projects/<id>/chat, and in the editor it also:
//   - applies the edit ops of new chat replies to the timeline as ONE undoable step each ("Chat: ..."),
//   - applies a finished style pass the same way and hands the result back so its key stills are rendered.
import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import { applyAiOps, type AiOp } from "@/lib/timeline/ai";
import type { Timeline } from "@/lib/timeline/types";
import { api } from "@/lib/client/api";
import type { AgentJobDTO } from "@/lib/client/agent";
import { useEditor } from "@/components/editor/store";

export interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "step" | "system";
  text: string;
  jobId: string | null;
  createdAt: string;
  data: {
    fixes?: { at: number; end: number | null; label: string; text: string }[];
    chip?: string;
    steps?: { type: string; label: string; jobId?: string | null; note?: string }[];
    ops?: (AiOp & { why?: string })[];
    opsSummary?: string;
    applied?: boolean;
    dismissed?: boolean;
    ruleProposal?: { rule: string; topic: string; saved?: string | null };
    engine?: string | null;
    source?: "chat" | "voice" | "stills" | "cut" | "render" | "ai_edit";
    ruleNotes?: RuleNotesDTO;
    ruleConflict?: RuleConflictDTO;
    ruleCheck?: RuleCheckDTO;
    renderDone?: { renderId: string; version: string; rules: { id: string; title: string; words: string }[] };
    voice?: { jobId: string; consumed?: boolean };
  } | null;
}
/** Notes filed as taste-checklist rules before the change (src/server/rules.ts). */
export interface RuleNotesDTO {
  source: string;
  added: { id: string; title: string; words: string }[];
  reinforced: { id: string; title: string; words: string }[];
  oneOff: string[];
}
/** Notes that contradict a rule: the user picks the winner. */
export interface RuleConflictDTO {
  jobId: string;
  source: string;
  resolved?: boolean;
  items: {
    words: string;
    rule: { title: string; inPractice: string; topic: string; type: string } | null;
    conflictsWith: { id: string; title: string; words: string }[];
    why: string | null;
    choice?: "new" | "old" | "once";
    newRuleId?: string | null;
  }[];
}
/** The fresh checker's report on a draft (src/server/rulecheck.ts). */
export interface RuleCheckDTO {
  id: string;
  target: "cut" | "stills";
  status: string;
  checked: number;
  summary: string;
  found: { rule: string; title: string; severity: "fail" | "warn"; where: string; problem: string }[];
  fixed: { rule: string; title: string; what: string }[];
  left: { rule: string; title: string; problem: string }[];
  note: string | null;
}
export interface Still {
  t: number;
  kind: string;
  label: string;
  why?: string;
  file: string | null;
}
export interface PipelineDTO {
  stage: "cut" | "cut_review" | "cut_approved" | "style" | "style_ready" | "stills" | "check" | "stills_review" | "approved";
  creator: string | null;
  brief: string;
  pendingStyle: boolean;
  styleJobId: string | null;
  style: { jobId: string; summary: string; ops: (AiOp & { why?: string })[]; picks: Omit<Still, "file">[]; applied: boolean } | null;
  conflicts: { topic: string; winner: "taste" | "brand" | "creator" | "default"; chosen: string; overridden: { layer: string; value: string }[]; rule?: string }[];
  stillsJobId: string | null;
  stills: Still[];
  stillsHash: string | null;
  approvedHash: string | null;
  approvedAt: string | null;
  error: string | null;
  checkId?: string | null;
  checkRound?: number;
}
export interface ChatStateDTO {
  project: { id: string; status: string; mode: string; title: string };
  pipeline: PipelineDTO | null;
  stageLabel: string | null;
  messages: ChatMsg[];
  jobs: AgentJobDTO[];
  creators: string[];
}

interface ChatStore {
  projectId: string | null;
  state: ChatStateDTO | null;
  loading: boolean;
  set(s: ChatStateDTO): void;
  refresh(): Promise<ChatStateDTO | null>;
}

export const useChat = create<ChatStore>((set, get) => ({
  projectId: null,
  state: null,
  loading: false,
  set: (s) => set({ state: s }),
  refresh: async () => {
    const id = get().projectId;
    if (!id) return null;
    try {
      const s = await api<ChatStateDTO>(`/api/projects/${id}/chat`);
      if (get().projectId === id) set({ state: s });
      return s;
    } catch {
      return null;
    }
  },
}));

export const ACTIVE = ["queued", "running"];
export const busyJobs = (s: ChatStateDTO | null) => (s?.jobs ?? []).filter((j) => ACTIVE.includes(j.status));

const applying = new Set<string>();

/** Apply one message's ops in the editor (one undo step) and tell the server. */
export async function applyMessageOps(projectId: string, m: ChatMsg) {
  if (!m.data?.ops?.length || applying.has(m.id)) return;
  applying.add(m.id);
  try {
    const ed = useEditor.getState();
    if (ed.projectId !== projectId) return;
    const next = applyAiOps(ed.timeline, m.data.ops);
    ed.commit(next, `Chat: ${m.data.opsSummary ?? m.text}`.slice(0, 80));
    await api(`/api/projects/${projectId}/chat`, { method: "PATCH", json: { messageId: m.id, applied: true } });
    toast.success(`${m.data.opsSummary ?? "Applied"}: on the timeline (undo with Ctrl+Z)`);
  } catch (e) {
    toast.error((e as Error).message);
  } finally {
    applying.delete(m.id);
  }
}

/** Poll the chat; in the editor, apply chat ops and style passes as they arrive. */
export function useChatSync(projectId: string, context: "editor" | "plan") {
  useEffect(() => {
    useChat.setState({ projectId, state: null });
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const seen = new Set<string>();
    let first = true;
    const tick = async () => {
      const s = await useChat.getState().refresh();
      if (stop) return;
      if (s && context === "editor") {
        // new chat replies with ops (not on the first load: old unapplied ones wait for a click)
        for (const m of s.messages) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          if (!first && m.data?.ops?.length && !m.data.applied && !m.data.dismissed) await applyMessageOps(projectId, m);
        }
        await driveStyle(projectId, s.pipeline);
      }
      first = false;
      const active = busyJobs(s).length > 0 || s?.pipeline?.stage === "style_ready";
      timer = setTimeout(tick, active ? 2000 : 8000);
    };
    tick();
    const onFocus = () => useChat.getState().refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [projectId, context]);
}

let driving: string | null = null;

/** A finished style pass: apply its ops (one undo step), then send the timeline back to render the key stills. */
async function driveStyle(projectId: string, p: PipelineDTO | null) {
  if (!p || p.stage !== "style_ready" || !p.style || p.style.applied || driving === p.style.jobId) return;
  const ed = useEditor.getState();
  if (ed.projectId !== projectId) return;
  driving = p.style.jobId;
  try {
    const next: Timeline = applyAiOps(ed.timeline, p.style.ops);
    ed.commit(next, `Style pass${p.creator ? ` · @${p.creator}` : ""}`);
    await api(`/api/projects/${projectId}/pipeline`, { method: "POST", json: { action: "style_applied", jobId: p.style.jobId, json: next } });
    toast.success("Style pass applied to the timeline (undo with Ctrl+Z). Rendering the key stills…");
    await useChat.getState().refresh();
  } catch (e) {
    toast.error((e as Error).message);
    driving = null;
  }
}
