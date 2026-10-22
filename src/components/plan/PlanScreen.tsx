"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, Loader2, Play, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAgentJob, type AgentJobDTO } from "@/lib/client/agent";
import type { AutoClipPlan, BestTakePlan, MusicPlan, TalkingHeadPlan, VoiceoverPlan } from "@/agent/schemas";
import { AgentLog } from "@/components/agent/AgentLog";
import { RunnerLine } from "@/components/agent/AgentPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useChatSync } from "@/components/chat/store";
import { cn } from "@/lib/utils";

type Asset = { id: string; type: string; url: string; thumbUrl: string | null; name: string; duration: number | null; width: number | null; height: number | null };
type PlanState = {
  project: { id: string; title: string; mode: string; modeLabel: string; status: string; statusMessage: string | null; aspect: string };
  plan: unknown;
  job: AgentJobDTO | null;
  assets: Asset[];
  children: { id: string; title: string; thumbnailUrl: string | null; duration: number }[];
};
type Preview = { src: string; in: number; out: number; label: string } | null;

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Plays one source span (in → out) and stops; used to check any row of the plan before approving. */
function SpanPlayer({ preview }: { preview: Preview }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !preview) return;
    v.currentTime = preview.in;
    v.play().catch(() => {});
    const stop = () => v.currentTime >= preview.out && v.pause();
    v.addEventListener("timeupdate", stop);
    return () => v.removeEventListener("timeupdate", stop);
  }, [preview]);
  if (!preview) return <div className="flex aspect-[9/16] items-center justify-center rounded-lg border text-xs text-muted-foreground">Click ▶ on a row to preview it</div>;
  return (
    <div className="space-y-1">
      <video ref={ref} src={preview.src} className="aspect-[9/16] w-full rounded-lg bg-black object-contain" controls playsInline />
      <p className="text-[11px] text-muted-foreground">
        {preview.label} · {fmt(preview.in)}–{fmt(preview.out)}
      </p>
    </div>
  );
}

function PlayBtn({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Preview">
      <Play className="size-3.5" />
    </button>
  );
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={cn("px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground", className)}>{children}</th>;
}

export function PlanScreen({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [state, setState] = useState<PlanState | null>(null);
  const [plan, setPlan] = useState<unknown>(null); // the user's working copy
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const live = useAgentJob(state?.project.status === "planning" ? (state.job?.id ?? null) : null);
  useChatSync(projectId, "plan");

  const load = useCallback(async () => {
    const r = await api<PlanState>(`/api/projects/${projectId}/plan`);
    setState(r);
    if (r.project.status === "ready" || r.project.status === "rendered") {
      if (r.project.mode !== "auto_clip" || !r.children.length) router.refresh();
    }
    setPlan((cur: unknown) => (dirtyRef.current && cur ? cur : r.plan)); // keep the user's table edits
  }, [projectId, router]);

  useEffect(() => {
    load().catch((e) => toast.error((e as Error).message));
  }, [load]);
  // poll while Claude is planning (the status flips when its job finishes)
  useEffect(() => {
    if (state?.project.status !== "planning") return;
    const t = setInterval(() => load().catch(() => {}), live.finished ? 1000 : 4000);
    return () => clearInterval(t);
  }, [state?.project.status, live.finished, load]);

  const update = (p: unknown) => {
    setPlan(p);
    setDirty(true);
  };
  const assets = new Map((state?.assets ?? []).map((a) => [a.id, a]));
  const show = (sourceId: string, i: number, o: number, label: string) => {
    const a = assets.get(sourceId);
    if (a) setPreview({ src: a.url, in: i, out: o, label: `${label} · ${a.name}` });
  };

  const approve = async () => {
    setBusy("Building the timeline…");
    try {
      const r = await api<{ children: string[] }>(`/api/projects/${projectId}/plan/approve`, { method: "POST", json: { plan } });
      if (r.children.length) {
        toast.success(`Created ${r.children.length} short${r.children.length > 1 ? "s" : ""}`);
        await load();
      } else router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const retry = async () => {
    setBusy("Restarting…");
    try {
      await api(`/api/projects/${projectId}/plan`, { method: "POST", json: { retry: true } });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!state) return <div className="flex h-dvh items-center justify-center"><Loader2 className="animate-spin text-muted-foreground" /></div>;
  const { project } = state;
  const done = project.mode === "auto_clip" && state.children.length > 0 && (project.status === "ready" || project.status === "rendered");

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard" className="rounded-md p-1.5 hover:bg-muted" aria-label="Back">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{project.title}</h1>
          <p className="text-xs text-muted-foreground">
            {project.modeLabel} ·{" "}
            {project.status === "draft"
              ? "Describe the reel in the chat: your first message starts the spoken cut"
              : project.status === "planning"
                ? "Claude is planning the edit"
                : project.status === "review"
                  ? "Review the plan, then approve"
                  : project.status === "plan_failed"
                    ? "Planning failed"
                    : "Built"}
          </p>
        </div>
      </div>

      {(project.status === "planning" || project.status === "draft") && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 space-y-3">
            <RunnerLine />
            {project.status === "planning" ? (
              <AgentLog job={live.job ?? state.job} events={live.events} onCancel={() => live.cancel().catch((e) => toast.error(e.message))} className="h-[65dvh]" />
            ) : (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-sm font-medium">Your clips</p>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {state.assets.map((a) => (
                    <button key={a.id} type="button" onClick={() => show(a.id, 0, a.duration ?? 5, "Input")} className="space-y-1 text-left">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {a.thumbUrl ? <img src={a.thumbUrl} alt="" className="aspect-[9/16] w-full rounded object-cover" /> : <div className="aspect-[9/16] rounded bg-muted" />}
                      <span className="line-clamp-1 text-[11px] text-muted-foreground">{a.name}</span>
                    </button>
                  ))}
                </div>
                <div className="max-w-56">
                  <SpanPlayer preview={preview} />
                </div>
              </div>
            )}
          </div>
          <div className="overflow-hidden rounded-lg border lg:sticky lg:top-4 lg:self-start">
            <ChatPanel projectId={projectId} context="plan" onSent={() => load().catch(() => {})} className="h-[70dvh]" />
          </div>
        </div>
      )}

      {project.status === "plan_failed" && (
        <div className="space-y-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm">
          <p className="text-red-300">{project.statusMessage ?? "Planning failed."}</p>
          <p className="text-xs text-muted-foreground">The full log is on the Jobs page.</p>
          <Button size="sm" onClick={retry} disabled={Boolean(busy)}>
            <RotateCcw /> Try again
          </Button>
        </div>
      )}

      {done && (
        <div className="space-y-3">
          <p className="text-sm">Your shorts are ready to edit:</p>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {state.children.map((c) => (
              <Link key={c.id} href={`/projects/${c.id}`} className="overflow-hidden rounded-lg border hover:border-primary">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {c.thumbnailUrl ? <img src={c.thumbnailUrl} alt="" className="aspect-[9/16] w-full object-cover" /> : <div className="aspect-[9/16] bg-muted" />}
                <div className="p-2 text-xs">
                  {c.title} · {Math.round(c.duration)}s
                </div>
              </Link>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => router.refresh()}>
            Open the full source timeline
          </Button>
        </div>
      )}

      {project.status === "review" && plan != null && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            <div className="rounded-lg border bg-card/40 p-3 text-sm whitespace-pre-wrap">{(plan as { summary: string }).summary}</div>
            {project.mode === "talking_head" && <TalkingHeadReview plan={plan as TalkingHeadPlan} onChange={update} assets={assets} show={show} />}
            {project.mode === "best_take" && <BestTakeReview plan={plan as BestTakePlan} onChange={update} assets={assets} show={show} />}
            {project.mode === "voiceover_broll" && <VoiceoverReview plan={plan as VoiceoverPlan} onChange={update} assets={assets} show={show} />}
            {project.mode === "music" && <MusicReview plan={plan as MusicPlan} onChange={update} assets={assets} show={show} />}
            {project.mode === "auto_clip" && <AutoClipReview plan={plan as AutoClipPlan} onChange={update} assets={assets} show={show} />}
          </div>
          <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
            <SpanPlayer preview={preview} />
            <Button className="w-full" onClick={approve} disabled={Boolean(busy)}>
              {busy === "Building the timeline…" ? <Loader2 className="animate-spin" /> : <Check />} Approve &amp; build
            </Button>
            {dirty && <p className="text-[11px] text-amber-300">You changed the plan. Approve to build it as shown (your edits are also sent with chat messages).</p>}
            <div className="overflow-hidden rounded-lg border">
              <p className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">Stage 1 of 2: the spoken cut. Approve it, or tell Claude what to change.</p>
              <ChatPanel
                projectId={projectId}
                context="plan"
                getPlan={() => plan}
                onSent={() => {
                  setDirty(false);
                  load().catch(() => {});
                }}
                className="h-[460px]"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type ReviewProps<P> = { plan: P; onChange: (p: P) => void; assets: Map<string, Asset>; show: (sourceId: string, i: number, o: number, label: string) => void };
const nameOf = (assets: Map<string, Asset>, id: string) => assets.get(id)?.name ?? id;

function TalkingHeadReview({ plan, onChange, assets, show }: ReviewProps<TalkingHeadPlan>) {
  const kept = plan.segments.filter((s) => s.include !== false);
  const total = kept.reduce((a, s) => a + s.out - s.in, 0);
  // where each kept segment starts in the finished reel (timestamped fixes refer to these times)
  const reelStart = plan.segments.reduce<number[]>((acc, s, i) => {
    const prev = i ? acc[i - 1] + (plan.segments[i - 1].include === false ? 0 : plan.segments[i - 1].out - plan.segments[i - 1].in) : 0;
    acc.push(prev);
    return acc;
  }, []);
  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h3 className="text-sm font-medium">Cleaned script</h3>
        <p className="rounded-lg border p-3 text-sm leading-relaxed">{plan.script}</p>
      </section>
      <section className="space-y-1">
        <h3 className="text-sm font-medium">
          Cut list · {kept.length} segments · {total.toFixed(1)} s
        </h3>
        <table className="w-full overflow-hidden rounded-lg border text-sm">
          <thead className="bg-muted/40">
            <tr>
              <Th>Keep</Th>
              <Th>#</Th>
              <Th>Reel</Th>
              <Th>Source</Th>
              <Th>In → out</Th>
              <Th>Words</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {plan.segments.map((s, i) => (
              <tr key={i} className={cn("border-t", s.include === false && "opacity-40")}>
                <td className="px-2 py-1">
                  <Switch checked={s.include !== false} onCheckedChange={(v) => onChange({ ...plan, segments: plan.segments.map((x, j) => (j === i ? { ...x, include: v } : x)) })} />
                </td>
                <td className="px-2 py-1 text-xs text-muted-foreground">{i + 1}</td>
                <td className="px-2 py-1 font-mono text-[11px] whitespace-nowrap text-violet-300" title="Time in the finished reel: use it for “Around 0:18, …” fixes">
                  {s.include === false ? "–" : fmt(reelStart[i])}
                </td>
                <td className="max-w-32 truncate px-2 py-1 text-xs">{nameOf(assets, s.sourceId)}</td>
                <td className="px-2 py-1 font-mono text-xs whitespace-nowrap">
                  {s.in.toFixed(2)} → {s.out.toFixed(2)}
                </td>
                <td className="px-2 py-1 text-xs">{s.text}</td>
                <td className="px-1">
                  <PlayBtn onClick={() => show(s.sourceId, s.in, s.out, `Segment ${i + 1}`)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <details className="rounded-lg border p-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Removed ({plan.removed.length})</summary>
        <ul className="mt-2 space-y-1 text-xs">
          {plan.removed.map((r, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-muted-foreground">{r.reason}</span>
              <span className="flex-1 line-through">{r.text}</span>
              <PlayBtn onClick={() => show(r.sourceId, Math.max(0, r.start - 0.3), r.end + 0.3, `Removed: ${r.reason}`)} />
            </li>
          ))}
        </ul>
      </details>
      <CaptionAndHook plan={plan} onChange={onChange} />
    </div>
  );
}

function CaptionAndHook({ plan, onChange }: { plan: TalkingHeadPlan; onChange: (p: TalkingHeadPlan) => void }) {
  return (
    <section className="grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-2">
      <div>
        <div className="text-xs text-muted-foreground">Captions</div>
        {plan.captions.style}, {Math.round(plan.captions.y * 100)}% down{plan.captions.why ? ` · ${plan.captions.why}` : ""}
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">Hook text (first seconds, empty = none)</div>
        <Input
          value={plan.hook?.text ?? ""}
          onChange={(e) => onChange({ ...plan, hook: e.target.value.trim() ? { text: e.target.value, duration: plan.hook?.duration ?? 2.5 } : null })}
          placeholder="no hook"
        />
      </div>
    </section>
  );
}

function BestTakeReview({ plan, onChange, assets, show }: ReviewProps<BestTakePlan>) {
  const swap = (li: number, ai: number) => {
    const lines = plan.lines.map((l, i) => {
      if (i !== li) return l;
      const alt = l.alternatives[ai];
      return { ...l, chosen: alt, alternatives: l.alternatives.map((a, j) => (j === ai ? l.chosen : a)), why: `${l.why} (swapped by you)` };
    });
    onChange({ ...plan, lines });
  };
  return (
    <div className="space-y-4">
      <table className="w-full overflow-hidden rounded-lg border text-sm">
        <thead className="bg-muted/40">
          <tr>
            <Th>#</Th>
            <Th>Line</Th>
            <Th>Chosen take</Th>
            <Th>Alternatives (click to swap)</Th>
            <Th>Why</Th>
          </tr>
        </thead>
        <tbody>
          {plan.lines.map((l, i) => (
            <tr key={i} className="border-t align-top">
              <td className="px-2 py-1.5 text-xs text-muted-foreground">{i + 1}</td>
              <td className="px-2 py-1.5 text-xs">{l.text}</td>
              <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                <span className="flex items-center gap-1">
                  <PlayBtn onClick={() => show(l.chosen.sourceId, l.chosen.in, l.chosen.out, `Line ${i + 1}`)} />
                  <span className="max-w-28 truncate">{nameOf(assets, l.chosen.sourceId)}</span>
                  <span className="rounded bg-emerald-500/15 px-1 text-emerald-300">{l.chosen.score.toFixed(1)}</span>
                </span>
              </td>
              <td className="px-2 py-1.5 text-xs">
                <div className="flex flex-wrap gap-1">
                  {l.alternatives.map((a, j) => (
                    <span key={j} className="inline-flex items-center rounded border">
                      <PlayBtn onClick={() => show(a.sourceId, a.in, a.out, `Line ${i + 1} alt`)} />
                      <button type="button" onClick={() => swap(i, j)} className="px-1 hover:text-primary" title={a.note}>
                        {nameOf(assets, a.sourceId).slice(0, 14)} · {a.score.toFixed(1)}
                      </button>
                    </span>
                  ))}
                </div>
              </td>
              <td className="px-2 py-1.5 text-xs text-muted-foreground">{l.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <section className="rounded-lg border p-3 text-xs">
        <div className="mb-1 text-muted-foreground">Loudness matching per take</div>
        {plan.sources.map((s) => (
          <div key={s.id}>
            {nameOf(assets, s.id)}: {s.gainDb >= 0 ? "+" : ""}
            {s.gainDb.toFixed(1)} dB{s.notes ? ` · ${s.notes}` : ""}
          </div>
        ))}
        <div className="mt-1 text-muted-foreground">Colour is matched across takes with Enhance ({Object.keys(plan.enhance ?? {}).length} takes analysed).</div>
      </section>
    </div>
  );
}

function VoiceoverReview({ plan, onChange, assets, show }: ReviewProps<VoiceoverPlan>) {
  const options = [...plan.broll.map((b) => ({ id: b.id, label: `${nameOf(assets, b.id)} — ${b.shows}` })), ...(plan.face ? [{ id: plan.voiceId, label: "My face (voice video)" }] : [])];
  const reassign = (i: number, id: string) => {
    const b = plan.broll.find((x) => x.id === id);
    const segments = plan.segments.map((s, j) => (j === i ? { ...s, sourceId: id, in: id === plan.voiceId ? s.start : (b?.best[0]?.in ?? 0), why: "reassigned by you" } : s));
    onChange({ ...plan, segments });
  };
  return (
    <div className="space-y-4">
      <table className="w-full overflow-hidden rounded-lg border text-sm">
        <thead className="bg-muted/40">
          <tr>
            <Th>Time</Th>
            <Th>What you say</Th>
            <Th>Clip</Th>
            <Th>Why</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {plan.segments.map((s, i) => (
            <tr key={i} className="border-t align-top">
              <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">
                {s.start.toFixed(1)}–{s.end.toFixed(1)}
              </td>
              <td className="px-2 py-1.5 text-xs">{s.text}</td>
              <td className="px-2 py-1.5">
                <select value={s.sourceId} onChange={(e) => reassign(i, e.target.value)} className="max-w-56 rounded border bg-background px-1 py-0.5 text-xs">
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="px-2 py-1.5 text-xs text-muted-foreground">{s.why}</td>
              <td className="px-1">
                <PlayBtn onClick={() => show(s.sourceId, s.in, s.in + (s.end - s.start), `“${s.text.slice(0, 30)}”`)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="rounded-lg border p-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">B-roll analysis</summary>
        <ul className="mt-2 space-y-1">
          {plan.broll.map((b) => (
            <li key={b.id}>
              <span className="font-medium">{nameOf(assets, b.id)}</span>: {b.shows} · {b.quality}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function MusicReview({ plan, onChange, assets, show }: ReviewProps<MusicPlan>) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Song starts at {plan.musicStart.toFixed(1)} s {plan.musicFile ? `(downloaded: ${plan.musicFile})` : plan.musicId ? `(${nameOf(assets, plan.musicId)})` : "(no track)"}
      </p>
      <table className="w-full overflow-hidden rounded-lg border text-sm">
        <thead className="bg-muted/40">
          <tr>
            <Th>Reel time</Th>
            <Th>Clip</Th>
            <Th>Source</Th>
            <Th>Zoom</Th>
            <Th>Grade</Th>
            <Th>Why</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {plan.shots.map((s, i) => (
            <tr key={i} className="border-t align-top">
              <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">
                {s.start.toFixed(2)}–{s.end.toFixed(2)}
              </td>
              <td className="max-w-28 truncate px-2 py-1.5 text-xs">{nameOf(assets, s.sourceId)}</td>
              <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">
                {s.in.toFixed(2)}–{s.out.toFixed(2)}
              </td>
              <td className="px-2 py-1.5 text-xs">{Math.round(s.zoom * 100)}%</td>
              <td className="px-2 py-1.5">
                <select
                  value={s.grade ?? ""}
                  onChange={(e) => onChange({ ...plan, shots: plan.shots.map((x, j) => (j === i ? { ...x, grade: (e.target.value || null) as MusicPlan["shots"][number]["grade"] } : x)) })}
                  className="rounded border bg-background px-1 py-0.5 text-xs"
                >
                  <option value="">natural</option>
                  <option value="grey">grey</option>
                  <option value="bw">b&amp;w</option>
                  <option value="warm">warm</option>
                </select>
              </td>
              <td className="px-2 py-1.5 text-xs text-muted-foreground">{s.why}</td>
              <td className="px-1">
                <PlayBtn onClick={() => show(s.sourceId, s.in, s.out, `Shot ${i + 1}`)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {plan.texts.length > 0 && (
        <section className="space-y-1 rounded-lg border p-3 text-xs">
          <div className="text-muted-foreground">Text</div>
          {plan.texts.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-24 font-mono text-muted-foreground">
                {t.start.toFixed(1)}–{t.end.toFixed(1)}
              </span>
              <Input value={t.text} onChange={(e) => onChange({ ...plan, texts: plan.texts.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })} className="h-7 text-xs" />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function AutoClipReview({ plan, onChange, assets, show }: ReviewProps<AutoClipPlan>) {
  const set = (i: number, patch: Partial<AutoClipPlan["clips"][number]>) => onChange({ ...plan, clips: plan.clips.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <table className="w-full overflow-hidden rounded-lg border text-sm">
      <thead className="bg-muted/40">
        <tr>
          <Th>Make</Th>
          <Th>Title</Th>
          <Th>Time</Th>
          <Th>Score</Th>
          <Th>Hook</Th>
          <Th>Why</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {plan.clips.map((c, i) => (
          <tr key={i} className={cn("border-t align-top", c.include === false && "opacity-50")}>
            <td className="px-2 py-1.5">
              <Switch checked={c.include !== false} onCheckedChange={(v) => set(i, { include: v })} />
            </td>
            <td className="px-2 py-1.5">
              <Input value={c.title} onChange={(e) => set(i, { title: e.target.value })} className="h-7 min-w-40 text-xs" />
            </td>
            <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap">
              {fmt(c.start)}–{fmt(c.end)} ({Math.round(c.end - c.start)}s)
            </td>
            <td className="px-2 py-1.5 text-xs">{c.score.toFixed(1)}</td>
            <td className="px-2 py-1.5">
              <Input value={c.hook} onChange={(e) => set(i, { hook: e.target.value })} className="h-7 min-w-32 text-xs" />
            </td>
            <td className="px-2 py-1.5 text-xs text-muted-foreground">{c.why}</td>
            <td className="px-1">
              <PlayBtn onClick={() => show(plan.sourceId, c.start, c.end, c.title)} />
            </td>
          </tr>
        ))}
      </tbody>
      <caption className="caption-bottom pt-2 text-left text-xs text-muted-foreground">Source: {nameOf(assets, plan.sourceId)}</caption>
    </table>
  );
}
