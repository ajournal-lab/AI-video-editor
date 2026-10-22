"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkPlus, Captions, Check, Clapperboard, Clock, Images, Loader2, Mic, Palette, Scissors, Send, Square, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAgentJob, type AgentJobDTO } from "@/lib/client/agent";
import { fmtTime, parseFixes } from "@/lib/chat/fixes";
import { AgentLog, JobStatus } from "@/components/agent/AgentLog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useEditor } from "@/components/editor/store";
import { applyMessageOps, busyJobs, useChat, type ChatMsg } from "./store";
import { StillsReview, ConflictList } from "./StillsReview";
import { RenderDoneCard, RuleCheckCard, RuleConflictCard, RuleNotesCard } from "./RuleCards";
import { useVoiceNote } from "./voice";

const TOPICS = ["captions", "text", "hook", "pacing", "zooms", "transitions", "layout", "grade", "color", "sound", "music", "quality", "delivery", "workflow", "other"];
const SOURCE_LABEL: Record<string, string> = { voice: "🎙 voice note", render: "notes on a render", stills: "notes on the stills", cut: "notes on the cut", ai_edit: "AI edit" };

type Chip = { id: "cut_pauses" | "captions" | "creator_style" | "stills" | "render"; label: string; icon: typeof Scissors };
const CHIPS: Chip[] = [
  { id: "cut_pauses", label: "Cut pauses", icon: Scissors },
  { id: "captions", label: "Add captions", icon: Captions },
  { id: "creator_style", label: "Apply creator style", icon: Palette },
  { id: "stills", label: "Show stills", icon: Images },
  { id: "render", label: "Render", icon: Clapperboard },
];

/**
 * The project chat. In the editor it sends the current timeline with every message; on the plan screen it sends
 * the plan with the user's table edits (getPlan). Chat replies' edits land on the timeline automatically.
 */
export function ChatPanel({ projectId, context, getPlan, onSent, className }: { projectId: string; context: "editor" | "plan"; getPlan?: () => unknown; onSent?: () => void; className?: string }) {
  const state = useChat((s) => s.state);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [picker, setPicker] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const fixes = useMemo(() => parseFixes(text).fixes, [text]);
  const jobs = useMemo(() => new Map((state?.jobs ?? []).map((j) => [j.id, j])), [state?.jobs]);
  const running = busyJobs(state);
  const live = running.find((j) => j.status === "running") ?? running[0] ?? null;
  const voice = useVoiceNote(projectId);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [state?.messages.length]);

  const send = async (msg: string, chip?: Chip["id"], creator?: string | null) => {
    if (!msg.trim() || sending) return;
    setSending(true);
    try {
      const json = context === "editor" ? useEditor.getState().timeline : undefined;
      await api(`/api/projects/${projectId}/chat`, { method: "POST", json: { text: msg, chip: chip ?? null, creator: creator ?? null, json, plan: getPlan?.() } });
      if (!chip) setText("");
      await useChat.getState().refresh();
      onSent?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const chip = (c: Chip) => {
    if (c.id === "creator_style") return setPicker((v) => !v);
    send(c.label, c.id);
  };

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {state?.stageLabel && (
        <div className="border-b px-3 py-2 text-xs">
          <span className="font-medium text-violet-300">{state.stageLabel}</span>
          {state.pipeline?.creator && <span className="text-muted-foreground"> · @{state.pipeline.creator}</span>}
          {state.pipeline?.pendingStyle && <span className="text-muted-foreground"> · style pass queued for after the cut</span>}
          {state.pipeline?.error && <p className="mt-1 text-red-400">{state.pipeline.error}</p>}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {!state && <Loader2 className="mx-auto animate-spin text-muted-foreground" />}
        {state && state.messages.length === 0 && (
          <div className="space-y-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            <p>Tell Claude what you want, e.g.</p>
            <p className="italic">“make a 30s reel in the style of @creator, cut the pauses, add captions, punchy zooms”</p>
            <p>Corrections with timestamps are applied together as one rebuild:</p>
            <p className="font-mono text-[11px]">Around 0:18, cut the breath<br />Around 0:31, bigger zoom on “never”</p>
          </div>
        )}
        {/* the workflow's current cards stay at the top; the conversation flows below them */}
        {state?.pipeline && (state.pipeline.stage === "stills_review" || state.pipeline.stage === "approved") && <StillsReview projectId={projectId} context={context} />}
        {state?.pipeline?.conflicts?.length ? <ConflictList conflicts={state.pipeline.conflicts} /> : null}
        {state?.messages.map((m) => <Message key={m.id} m={m} jobs={jobs} projectId={projectId} context={context} />)}
        {live && <LiveJob job={live} />}
        <div ref={bottom} />
      </div>

      <div className="space-y-2 border-t p-2">
        <div className="flex flex-wrap gap-1">
          {CHIPS.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={sending}
              onClick={() => chip(c)}
              className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:border-primary hover:text-foreground", picker && c.id === "creator_style" && "border-primary text-foreground")}
            >
              <c.icon className="size-3" /> {c.label}
            </button>
          ))}
        </div>
        {picker && (
          <div className="flex flex-wrap items-center gap-1 rounded-md bg-muted/40 p-2 text-[11px]">
            {state?.creators.length ? (
              state.creators.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="rounded-full border px-2 py-0.5 hover:border-primary"
                  onClick={() => {
                    setPicker(false);
                    send(`Apply @${h}'s style`, "creator_style", h);
                  }}
                >
                  @{h}
                </button>
              ))
            ) : (
              <span className="text-muted-foreground">No creator profiles yet. Ask in the chat, e.g. “style of @handle on TikTok”, to run a teardown.</span>
            )}
            <button type="button" className="rounded-full border px-2 py-0.5 hover:border-primary" onClick={() => (setPicker(false), send("Style pass with my taste rules only", "creator_style", null))}>
              no creator
            </button>
          </div>
        )}
        {fixes.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-amber-200">
            <Clock className="size-3" /> {fixes.length} timestamped fix{fixes.length > 1 ? "es" : ""} → one rebuild:
            {fixes.map((f, i) => (
              <span key={i} className="rounded bg-amber-400/10 px-1 font-mono">
                {fmtTime(f.at)}
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-1">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(text);
              }
            }}
            rows={3}
            placeholder={context === "plan" ? "Change the cut… (Around 0:18, …)" : "What should change? (Shift+Enter for a new line)"}
            className="min-h-0 text-sm"
            disabled={sending}
          />
          <div className="flex flex-col justify-end gap-1">
            <Button
              size="icon"
              variant={voice.recording ? "destructive" : "secondary"}
              onClick={() => (voice.recording ? voice.stop() : voice.start())}
              disabled={sending || voice.uploading}
              aria-label={voice.recording ? "Stop and send the voice note" : "Record a voice note"}
              title={voice.recording ? `Recording ${voice.seconds}s: click to send` : "Voice note (transcribed on this computer)"}
            >
              {voice.uploading ? <Loader2 className="animate-spin" /> : voice.recording ? <Square /> : <Mic />}
            </Button>
            <Button size="icon" onClick={() => send(text)} disabled={sending || !text.trim()} aria-label="Send">
              {sending ? <Loader2 className="animate-spin" /> : <Send />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function LiveJob({ job }: { job: AgentJobDTO }) {
  const live = useAgentJob(job.id);
  return <AgentLog job={live.job ?? job} events={live.events} onCancel={() => live.cancel().catch((e) => toast.error(e.message))} compact />;
}

function Message({ m, jobs, projectId, context }: { m: ChatMsg; jobs: Map<string, AgentJobDTO>; projectId: string; context: "editor" | "plan" }) {
  const job = m.jobId ? jobs.get(m.jobId) : undefined;
  if (m.role === "user") {
    return (
      <div className="ml-6 rounded-lg bg-primary/15 px-3 py-2 text-sm whitespace-pre-wrap">
        {m.text}
        {m.data?.fixes?.length ? <p className="mt-1 text-[10px] text-amber-200">{m.data.fixes.length} timestamped fix{m.data.fixes.length > 1 ? "es" : ""} · one rebuild</p> : null}
        {m.data?.source && m.data.source !== "chat" && <p className="mt-1 text-[10px] text-muted-foreground">{SOURCE_LABEL[m.data.source] ?? m.data.source}</p>}
      </div>
    );
  }
  if (m.role === "system") return <p className="px-1 text-xs text-amber-200/90">{m.text}</p>;
  if (m.role === "step") {
    return (
      <div className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate">{m.text}</span>
        {job && <JobStatus status={job.status} />}
      </div>
    );
  }
  return <Assistant m={m} projectId={projectId} context={context} />;
}

function Assistant({ m, projectId, context }: { m: ChatMsg; projectId: string; context: "editor" | "plan" }) {
  const d = m.data ?? {};
  return (
    <div className="mr-4 space-y-2 rounded-lg border bg-card/40 px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap">{m.text}</p>
      </div>
      {d.ops?.length ? <OpsRow m={m} projectId={projectId} context={context} /> : null}
      {d.ruleProposal && <RuleProposal m={m} projectId={projectId} />}
      {d.ruleNotes && <RuleNotesCard d={d.ruleNotes} />}
      {d.ruleConflict && <RuleConflictCard m={m} projectId={projectId} context={context} />}
      {d.ruleCheck && <RuleCheckCard r={d.ruleCheck} />}
      {d.renderDone && <RenderDoneCard d={d.renderDone} />}
    </div>
  );
}

function OpsRow({ m, projectId, context }: { m: ChatMsg; projectId: string; context: "editor" | "plan" }) {
  const d = m.data!;
  const ops = d.ops!;
  return (
    <div className="space-y-1 rounded-md bg-muted/30 p-2 text-[11px]">
      <ul className="space-y-0.5 text-muted-foreground">
        {ops.slice(0, 8).map((o, i) => (
          <li key={i}>
            <span className="font-mono text-foreground">{o.op}</span>
            {o.why ? ` · ${o.why}` : ""}
          </li>
        ))}
        {ops.length > 8 && <li>…and {ops.length - 8} more</li>}
      </ul>
      {d.applied ? (
        <p className="flex items-center gap-2 text-emerald-300">
          <Check className="size-3" /> On the timeline
          {context === "editor" && (
            <button type="button" className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => useEditor.getState().undo()}>
              <Undo2 className="size-3" /> Undo last change
            </button>
          )}
        </p>
      ) : d.dismissed ? (
        <p className="text-muted-foreground">Dismissed</p>
      ) : context === "editor" ? (
        <div className="flex gap-1">
          <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => applyMessageOps(projectId, m).then(() => useChat.getState().refresh())}>
            <Check /> Apply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            onClick={() => api(`/api/projects/${projectId}/chat`, { method: "PATCH", json: { messageId: m.id, dismissed: true } }).then(() => useChat.getState().refresh())}
          >
            <X /> Dismiss
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground">Applied when you open the editor.</p>
      )}
    </div>
  );
}

/** Legacy "Save as taste rule" proposals (older chat turns): the user can reword it before it goes into the taste checklist. */
export function RuleProposal({ m, projectId }: { m: ChatMsg; projectId: string }) {
  const p = m.data!.ruleProposal!;
  const [rule, setRule] = useState(p.rule);
  const [topic, setTopic] = useState(p.topic);
  if (p.saved) return <p className="text-[11px] text-emerald-300">Saved to the taste checklist as {p.saved}.</p>;
  if (m.data?.dismissed) return <p className="text-[11px] text-muted-foreground">Not saved.</p>;
  const save = async () => {
    try {
      const r = await api<{ rule: { id: string } }>("/api/taste-rules", { method: "POST", json: { rule, topic } });
      await api(`/api/projects/${projectId}/chat`, { method: "PATCH", json: { messageId: m.id, ruleSaved: r.rule.id } });
      toast.success(`Taste rule ${r.rule.id} saved: it now beats creator styles and the brand kit`);
      await useChat.getState().refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="space-y-1 rounded-md border border-violet-400/30 p-2">
      <Textarea value={rule} onChange={(e) => setRule(e.target.value)} rows={2} className="min-h-0 text-xs" />
      <div className="flex items-center gap-1">
        <select value={topic} onChange={(e) => setTopic(e.target.value)} className="h-6 rounded border bg-transparent px-1 text-[11px]">
          {TOPICS.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <Button size="sm" className="h-6 px-2 text-[11px]" onClick={save} disabled={rule.trim().length < 5}>
          <BookmarkPlus /> Save as taste rule
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px]"
          onClick={() => api(`/api/projects/${projectId}/chat`, { method: "PATCH", json: { messageId: m.id, dismissed: true } }).then(() => useChat.getState().refresh())}
        >
          No
        </Button>
      </div>
    </div>
  );
}
