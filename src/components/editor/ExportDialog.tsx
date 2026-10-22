"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, BookmarkPlus, CheckCircle2, Download, ExternalLink, Images, Loader2, Lock, Music2, Smartphone, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { clipEnd } from "@/lib/timeline/derive";
import type { AudioClip, Timeline } from "@/lib/timeline/types";
import type { AssetDTO } from "@/lib/client/upload";
import { fmtTime } from "./panels/AudioClipper";
import { QualityReport, type QualityReportData } from "./QualityReport";
import { cn } from "@/lib/utils";
import { useEditor } from "./store";
import { saveNow } from "./hooks";
import { RenderNotesDialog } from "./RenderNotesDialog";
import { RulesAdded } from "./RulesAdded";
import { CloudRender } from "./CloudRender";
import { useChat } from "@/components/chat/store";

export interface RenderRow {
  id: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  quality: string;
  outputUrl: string | null;
  previewUrl?: string | null;
  step?: string | null;
  thumbUrl: string | null;
  error: string | null;
  duration: number | null;
  createdAt: string;
  finishedAt: string | null;
  version: { id: string; name: string; number?: number | null; notes?: string | null };
  report?: RenderReport | null;
}

export interface RenderReport {
  quality?: QualityReportData;
  audio?: {
    target: { lufs: number; truePeak: number };
    mix: { lufs: number | null; truePeak: number | null };
    output: { lufs: number | null; truePeak: number | null };
    sourcesOverPeak: { name: string; truePeak: number }[];
    clippingDetected: boolean;
    fixed: boolean;
    pass: boolean;
  };
  audioSafety?: AudioSafetyReport;
}

export interface AudioSafetyReport {
  headroomDb: number;
  voice: number | null;
  sfx: { id: string; name: string; start: number; end: number; level: number | null; limit: number; overDb: number; gainDb: number }[];
  pass: boolean;
  fixed: boolean;
  note: string | null;
}

/** Sound effects vs the voice (worker/audio_safety.py): every SFX at least headroom dB under the voice. */
export function SfxCheck({ report }: { report?: AudioSafetyReport | null }) {
  if (!report || !report.sfx.length) return null;
  const loud = report.sfx.filter((s) => s.overDb > 0);
  return (
    <div className={cn("text-[11px]", loud.length ? "text-amber-300" : "text-emerald-400")}>
      <div className="flex items-center gap-1">
        {loud.length ? <AlertTriangle className="size-3" /> : <CheckCircle2 className="size-3" />}
        {loud.length
          ? `${loud.length} sound effect${loud.length > 1 ? "s" : ""} louder than voice − ${report.headroomDb} dB${report.fixed ? " · turned down in this export" : ""}`
          : report.note ?? `Sound effects ≥ ${report.headroomDb} dB under the voice`}
      </div>
      {loud.map((s) => (
        <div key={s.id} className="pl-4">
          {s.name} at {s.start.toFixed(1)}s: {s.level?.toFixed(1)} LUFS vs limit {s.limit.toFixed(1)} (+{s.overDb.toFixed(1)} dB)
        </div>
      ))}
    </div>
  );
}

/** Music on the timeline that came from a pasted link: what to pick in Instagram, and whether it's cleared. */
export function linkMusic(tl: Timeline, assets: Record<string, AssetDTO>) {
  const out: { clip: AudioClip; start: number; end: number; rights: boolean; active: boolean }[] = [];
  for (const t of tl.tracks) {
    if (t.kind !== "music") continue;
    for (const c of t.clips) {
      if (!c.link) continue;
      const a = c.assetId ? assets[c.assetId] : undefined;
      // derived from the clip, so later trims on the timeline are reflected
      out.push({ clip: c, start: c.in, end: c.in + c.duration * c.speed, rights: !!a?.meta?.rights, active: !t.muted && !c.muted && c.volume > 0 });
    }
  }
  return out.sort((a, b) => a.clip.start - b.clip.start);
}

export function MusicHandoff({ tl, assets }: { tl: Timeline; assets: Record<string, AssetDTO> }) {
  const items = linkMusic(tl, assets);
  if (!items.length) return null;
  return (
    <div className="space-y-1.5 rounded-lg border p-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium">
        <Music2 className="size-3.5" /> Sound hand-off
      </div>
      {items.map(({ clip, start, end, rights }) => (
        <div key={clip.id} className="space-y-0.5">
          <div>
            Start the sound at <strong className="text-sm">{fmtTime(start)}</strong> <span className="text-muted-foreground">({start.toFixed(1)}s → {end.toFixed(1)}s, plays from {fmtTime(clip.start)} to {fmtTime(clipEnd(clip))} in the reel)</span>
          </div>
          <a href={clip.link!.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-muted-foreground hover:text-foreground">
            <ExternalLink className="size-3 shrink-0" /> <span className="truncate">{clip.link!.url}</span>
          </a>
          {!rights && <div className="text-amber-300">Timing only / personal use: add this sound in Instagram rather than posting it baked in.</div>}
        </div>
      ))}
    </div>
  );
}

function AudioCheck({ report }: { report?: RenderReport | null }) {
  const a = report?.audio;
  if (!a) return null;
  const tp = a.output.truePeak;
  const lufs = a.output.lufs;
  return (
    <div className={cn("flex items-center gap-1 text-[11px]", a.pass ? "text-emerald-400" : "text-amber-300")} title={a.sourcesOverPeak.length ? `Sources over -1 dBTP: ${a.sourcesOverPeak.map((s) => `${s.name} (${s.truePeak.toFixed(1)})`).join(", ")}` : undefined}>
      {a.pass ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
      Audio {lufs != null ? `${lufs.toFixed(1)} LUFS` : "silent"}
      {tp != null ? ` · peak ${tp.toFixed(1)} dBTP` : ""}
      {a.clippingDetected ? (a.fixed ? " · clipping fixed" : " · clipping!") : ""}
    </div>
  );
}

export function RenderList({ projectId, renders, onChange, onTasteRule }: { projectId: string; renders: RenderRow[]; onChange: (r: RenderRow[]) => void; onTasteRule?: (render: RenderRow) => void }) {
  const latest = useRef(renders);
  latest.current = renders;
  const [ahead, setAhead] = useState<Record<string, number>>({});
  const [watch, setWatch] = useState<string | null>(null);

  // Poll active renders.
  const active = renders.filter((r) => r.status === "queued" || r.status === "processing").map((r) => r.id).join(",");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      for (const id of active.split(",")) {
        try {
          const { render, ahead: a } = await api<{ render: RenderRow; ahead: number }>(`/api/renders/${id}`);
          setAhead((m) => ({ ...m, [id]: a }));
          onChange(latest.current.map((r) => (r.id === id ? render : r)));
          if (render.status === "done") toast.success("Your video is ready");
          if (render.status === "failed") toast.error("Render failed");
        } catch {
          /* keep polling */
        }
      }
    }, 1500);
    return () => clearInterval(t);
  }, [active, onChange]);

  const remove = async (id: string) => {
    try {
      await api(`/api/renders/${id}`, { method: "DELETE" });
      onChange(latest.current.filter((r) => r.id !== id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!renders.length) return <p className="py-4 text-center text-sm text-muted-foreground">No renders yet.</p>;
  return (
    <div className="space-y-2">
      {renders.map((r) => (
        <div key={r.id} className="flex flex-wrap gap-3 rounded-lg border p-2">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-black">
            {r.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={r.thumbUrl} alt="" className="h-full w-full object-cover" />
            ) : r.status === "failed" ? (
              <span className="text-xs text-destructive">!</span>
            ) : (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm">{r.version.name}</span>
              <Badge variant="outline" className="h-4 px-1 text-[10px]">
                {r.quality}
              </Badge>
            </div>
            {r.status === "done" ? (
              <>
                <div className="text-[11px] text-muted-foreground">
                  {r.duration ? `${r.duration.toFixed(1)}s · ` : ""}
                  {new Date(r.finishedAt ?? r.createdAt).toLocaleString()}
                </div>
                <AudioCheck report={r.report} />
                <SfxCheck report={r.report?.audioSafety} />
                <QualityReport q={r.report?.quality} />
                {onTasteRule && (
                  <button type="button" onClick={() => onTasteRule(r)} className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-200">
                    <BookmarkPlus className="size-3" /> Notes on this render
                  </button>
                )}
              </>
            ) : r.status === "failed" ? (
              <div className="line-clamp-2 text-[11px] text-destructive" title={r.error ?? ""}>
                {r.error ?? "Failed"}
              </div>
            ) : (
              <>
                <div className="h-1.5 overflow-hidden rounded bg-muted">
                  <div className={cn("h-full bg-primary transition-all", r.status === "queued" && "animate-pulse")} style={{ width: `${Math.max(3, r.progress * 100)}%` }} />
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {r.status === "queued" ? (ahead[r.id] ? `Queued · ${ahead[r.id]} ahead` : "Queued · waiting for the render worker") : r.step ?? `Rendering ${Math.round(r.progress * 100)}%`}
                </div>
                {r.previewUrl && (
                  <button type="button" className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-200" onClick={() => setWatch(watch === r.id ? null : r.id)}>
                    <Smartphone className="size-3" /> Phone preview ready (quality check still running)
                  </button>
                )}
              </>
            )}
          </div>
          <div className="flex flex-col gap-1">
            {r.previewUrl && (
              <Button size="sm" variant="secondary" onClick={() => setWatch(watch === r.id ? null : r.id)} title="Quick 720p preview">
                <Smartphone /> {watch === r.id ? "Hide" : "Preview"}
              </Button>
            )}
            {r.status === "done" && r.outputUrl && (
              <Button size="sm" asChild>
                <a href={r.outputUrl} download={`reelsmith-${projectId}-${r.id}.mp4`} target="_blank" rel="noreferrer">
                  <Download /> MP4
                </a>
              </Button>
            )}
            {r.status !== "processing" && (
              <Button size="sm" variant="ghost" onClick={() => remove(r.id)} aria-label="Delete render">
                <Trash2 />
              </Button>
            )}
          </div>
          {watch === r.id && r.previewUrl && <video src={r.previewUrl} controls autoPlay playsInline className="mx-auto max-h-[55vh] basis-full rounded bg-black" />}
        </div>
      ))}
    </div>
  );
}

export function ExportDialog() {
  const [open, setOpen] = useState(false);
  const [quality, setQuality] = useState<"720p" | "1080p">("1080p");
  const [renders, setRenders] = useState<RenderRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const projectId = useEditor((s) => s.projectId);
  const timeline = useEditor((s) => s.timeline);
  const assets = useEditor((s) => s.assets);
  const uncleared = linkMusic(timeline, assets).filter((m) => m.active && !m.rights);
  const [ruleFor, setRuleFor] = useState<RenderRow | null>(null);
  // two-stage approval: projects that went through the style pass render only after their stills are approved
  const pipeline = useChat((s) => s.state?.pipeline);
  const [gate, setGate] = useState<{ ok: boolean; reason?: string; changed: boolean } | null>(null);
  useEffect(() => {
    if (!open || !pipeline) return setGate(null);
    api<{ ok: boolean; reason?: string; changed: boolean }>(`/api/projects/${projectId}/pipeline`, { method: "POST", json: { action: "gate", json: useEditor.getState().timeline } })
      .then(setGate)
      .catch(() => setGate(null));
  }, [open, projectId, pipeline, timeline]);
  const blocked = gate ? !gate.ok : false;
  const reviewStills = () => {
    setOpen(false);
    useEditor.getState().setPanel("chat");
  };

  useEffect(() => {
    if (!open) return;
    api<{ renders: RenderRow[] }>(`/api/projects/${projectId}/renders`)
      .then((r) => setRenders(r.renders))
      .catch((e) => toast.error(e.message));
  }, [open, projectId]);

  const render = async (confirmed = false) => {
    if (uncleared.length && !confirmed) return setConfirm(true);
    setBusy(true);
    try {
      await saveNow().catch(() => {});
      const { render } = await api<{ render: RenderRow }>(`/api/projects/${projectId}/renders`, {
        method: "POST",
        json: { quality, json: useEditor.getState().timeline },
      });
      setRenders((r) => [render, ...(r ?? [])]);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="brand-gradient text-white">
          <Upload /> Export
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Export MP4</DialogTitle>
          <DialogDescription>Rendered by the worker from a snapshot of this exact timeline, with captions burned in. Re-render as often as you like.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          {(["720p", "1080p"] as const).map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuality(q)}
              className={cn("rounded-lg border p-3 text-left", quality === q ? "border-primary bg-primary/10" : "hover:border-white/30")}
            >
              <div className="text-sm font-medium">{q}</div>
              <div className="text-xs text-muted-foreground">{q === "720p" ? "Faster, smaller file" : "Best quality"}</div>
            </button>
          ))}
        </div>
        <MusicHandoff tl={timeline} assets={assets} />
        {uncleared.length > 0 && (
          <p className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> This export includes link-sourced audio marked timing only / personal use. Mute that clip to export without it, or tick “I have the rights” in the Music panel.
          </p>
        )}
        {blocked && (
          <div className="flex items-start gap-2 rounded-lg border border-violet-400/50 bg-violet-500/5 p-2.5 text-xs">
            <Lock className="mt-0.5 size-3.5 shrink-0 text-violet-300" />
            <div className="flex-1 space-y-1.5">
              <p>{gate?.reason}</p>
              <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={reviewStills}>
                <Images /> Review the stills
              </Button>
            </div>
          </div>
        )}
        {gate?.ok && gate.changed && (
          <p className="flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> The timeline changed after you approved the stills. Render anyway, or re-render the stills from the chat panel first.
          </p>
        )}
        <Button onClick={() => render()} disabled={busy || blocked}>
          {busy ? <Loader2 className="animate-spin" /> : blocked ? <Lock /> : <Upload />} Render {quality}
        </Button>
        <CloudRender projectId={projectId} quality={quality} blocked={blocked} onRendered={(r) => setRenders((x) => [r, ...(x ?? []).filter((y) => y.id !== r.id)])} />
        <AlertDialog open={confirm} onOpenChange={setConfirm}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Export with timing-only audio?</AlertDialogTitle>
              <AlertDialogDescription>
                {uncleared.map((m) => m.clip.name).join(", ")} came from a link and is marked timing only / personal use. Posting it baked into the video can get the reel muted or taken down. Usually you mute it here and add the same sound in
                Instagram (see the hand-off for the start second).
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirm(false);
                  render(true);
                }}
              >
                Export anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <div className="max-h-[45vh] overflow-y-auto">
          {renders === null ? (
            <div className="flex justify-center py-4">
              <Loader2 className="animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <RenderList projectId={projectId} renders={renders} onChange={setRenders} onTasteRule={setRuleFor} />
              {renders.some((r) => r.status === "done") && <RulesAdded projectId={projectId} />}
            </>
          )}
        </div>
        <RenderNotesDialog projectId={projectId} version={ruleFor?.version?.name ?? null} open={Boolean(ruleFor)} onOpenChange={(v) => !v && setRuleFor(null)} />
      </DialogContent>
    </Dialog>
  );
}
