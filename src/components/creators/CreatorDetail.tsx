"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Captions,
  CheckCircle2,
  Clapperboard,
  Copy,
  Download,
  Gauge,
  Layers,
  LayoutTemplate,
  Loader2,
  Pencil,
  RefreshCw,
  Repeat,
  Sparkles,
  Timer,
  Trash2,
  Volume2,
  XCircle,
  ZoomIn,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAgentJob } from "@/lib/client/agent";
import { AgentLog, JobStatus } from "@/components/agent/AgentLog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { CreatorForm } from "./CreatorForm";
import { deleteProfile, promptHandle, STATUS } from "./CreatorsPage";
import { Markdown } from "./Markdown";
import { StyleEditor } from "./StyleEditor";
import { fileUrl, type ConsistencyRow, type CreatorDetail as Detail, type CreatorStyle, type Measured } from "./types";

const STAGES = ["downloading", "transcribing", "measuring", "done"];
const CATS: { id: string; label: string }[] = [
  { id: "hook", label: "Hook (first frame)" },
  { id: "captions", label: "Captions" },
  { id: "zoom", label: "Zoom" },
  { id: "cut", label: "Cut / transition" },
  { id: "layout", label: "Layout" },
  { id: "ending", label: "Ending / CTA" },
];
const r = (v: unknown, d = 1) => (typeof v === "number" ? String(Math.round(v * 10 ** d) / 10 ** d) : "–");

export function CreatorDetail({ handle }: { handle: string }) {
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [rerun, setRerun] = useState(false);
  const load = useCallback(
    () =>
      api<Detail>(`/api/creators/${encodeURIComponent(handle)}`)
        .then((x) => {
          setD(x);
          setErr(null);
        })
        .catch((e) => setErr(e.message)),
    [handle],
  );
  useEffect(() => {
    load();
  }, [load]);
  const running = d?.meta?.status === "measuring" || d?.meta?.status === "analysing";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [running, load]);

  if (err) return <p className="text-sm text-red-400">{err}</p>;
  if (!d) return <Loader2 className="mx-auto animate-spin text-muted-foreground" />;
  const st = d.meta?.status ?? (d.style ? "ready" : "failed");
  const videos = d.measurements?.videos ?? [];

  const act = async (action: string, body: object = {}, msg?: string) => {
    try {
      await api(`/api/creators/${encodeURIComponent(handle)}/${action}`, { method: "POST", json: body });
      if (msg) toast.success(msg);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3">
        <Link href="/creators" className="mt-1 rounded-md p-1.5 hover:bg-muted" aria-label="Back to creators">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">@{d.handle}</h1>
          <p className={cn("text-sm", STATUS[st]?.cls)}>
            {STATUS[st]?.label}
            <span className="text-muted-foreground">
              {d.meta?.platform ? ` · ${d.meta.platform}` : ""}
              {videos.length ? ` · ${videos.length} videos measured` : ""}
              {d.style?.edited?.fields.length ? ` · ${d.style.edited.fields.length} values edited by you` : ""}
              {d.meta?.source === "import" ? " · imported" : ""}
            </span>
          </p>
          {d.meta?.notes && <p className="mt-1 text-xs text-muted-foreground">Your notes: “{d.meta.notes}”</p>}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="secondary" onClick={() => setRerun((v) => !v)} disabled={running}>
            <RefreshCw /> Re-analyse
          </Button>
          <Button size="sm" variant="ghost" onClick={async () => { const h = await promptHandle("rename", handle); if (h) router.replace(`/creators/${h}`); }} disabled={running}>
            <Pencil /> Rename
          </Button>
          <Button size="sm" variant="ghost" onClick={async () => { const h = await promptHandle("duplicate", handle); if (h) router.push(`/creators/${h}`); }}>
            <Copy /> Duplicate
          </Button>
          <Button size="sm" variant="ghost" asChild disabled={!d.style}>
            <a href={`/api/creators/${encodeURIComponent(handle)}/export`}>
              <Download /> Export
            </a>
          </Button>
          <Button size="sm" variant="ghost" className="text-red-400" onClick={async () => (await deleteProfile(handle)) && router.push("/creators")}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>

      {rerun && !running && (
        <div className="rounded-xl border p-4">
          <h2 className="mb-3 text-sm font-semibold">Re-analyse @{handle}: same links, or paste new ones</h2>
          <CreatorForm handle={handle} initialUrls={d.meta?.urls} initialNotes={d.meta?.notes} />
        </div>
      )}

      {(running || st === "failed") && <ProgressView d={d} onCancel={() => act("cancel", {}, "Cancelled")} />}

      {!running && d.style && <FailedVideos d={d} onAdd={(url) => act("replace", { videoId: "", url }, "Measuring it, then Claude re-analyses the profile")} />}

      {d.style && (
        <Tabs defaultValue="summary">
          <TabsList className="flex h-auto w-full flex-wrap justify-start">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="consistency">
              Consistency
              {d.verdicts.some((v) => v.verdict === "MISMATCH") && <AlertTriangle className="size-3 text-amber-300" />}
            </TabsTrigger>
            <TabsTrigger value="frames">Side by side</TabsTrigger>
            <TabsTrigger value="edit">Edit style</TabsTrigger>
            <TabsTrigger value="teardown">Teardown</TabsTrigger>
            <TabsTrigger value="overrides">Your overrides{d.overrides.replaced.length ? ` (${d.overrides.replaced.length})` : ""}</TabsTrigger>
          </TabsList>
          <TabsContent value="summary" className="pt-3">
            <SummaryCards style={d.style} />
          </TabsContent>
          <TabsContent value="consistency" className="pt-3">
            <Consistency d={d} videos={videos} onReplace={(videoId, url) => act("replace", { videoId, url }, "Replacing the video: only it is re-measured, then Claude re-analyses")} running={running} />
          </TabsContent>
          <TabsContent value="frames" className="pt-3">
            <SideBySide handle={handle} videos={videos} />
          </TabsContent>
          <TabsContent value="edit" className="pt-3">
            <StyleEditor handle={handle} style={d.style} measured={d.measuredStyle} onSaved={load} />
          </TabsContent>
          <TabsContent value="teardown" className="pt-3">
            {d.teardownMd ? <Markdown text={d.teardownMd} className="mx-auto max-w-3xl rounded-xl border p-5" /> : <p className="text-sm text-muted-foreground">No teardown.md yet.</p>}
          </TabsContent>
          <TabsContent value="overrides" className="pt-3">
            <Overrides d={d} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- progress

function ProgressView({ d, onCancel }: { d: Detail; onCancel: () => void }) {
  const analysis = d.jobs.find((j) => j.id === d.meta?.analysisJobId) ?? null;
  const measure = d.jobs.find((j) => j.id === d.meta?.measureJobId) ?? null;
  const running = d.meta?.status === "measuring" || d.meta?.status === "analysing";
  const live = useAgentJob(analysis?.status === "running" ? analysis.id : null);
  const rows = d.progress?.videos ?? [];
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-semibold">{running ? "Analysing…" : "The analysis stopped"}</h2>
        {running && (
          <Button size="sm" variant="destructive" onClick={onCancel}>
            <Ban /> Cancel
          </Button>
        )}
      </div>
      {d.meta?.error && <p className="text-sm text-red-400">{d.meta.error}</p>}
      <div className="space-y-1.5">
        {measure?.status === "queued" && !rows.length && <p className="text-xs text-muted-foreground">Waiting for the agent runner…</p>}
        {rows.map((v) => (
          <div key={v.index} className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
            <span className="w-5 text-muted-foreground">{v.index + 1}</span>
            <span className="min-w-0 flex-1 truncate" title={v.url}>
              {v.title || v.url}
            </span>
            <span className="flex items-center gap-1">
              {STAGES.map((s, i) => {
                const cur = STAGES.indexOf(v.stage);
                const state = v.stage === "failed" ? "fail" : cur > i || v.stage === "done" ? "done" : cur === i ? "now" : "todo";
                return (
                  <span
                    key={s}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                      state === "done" && "bg-emerald-500/10 text-emerald-300",
                      state === "now" && "bg-sky-500/15 text-sky-300",
                      state === "todo" && "text-muted-foreground",
                      state === "fail" && "text-red-400/70",
                    )}
                  >
                    {state === "now" && <Loader2 className="size-3 animate-spin" />}
                    {state === "done" && <CheckCircle2 className="size-3" />}
                    {s === "done" ? "done" : s}
                  </span>
                );
              })}
              {v.stage === "failed" && (
                <span className="inline-flex items-center gap-1 text-red-400" title={v.error ?? ""}>
                  <XCircle className="size-3" /> {v.error?.slice(0, 80)}
                </span>
              )}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <Sparkles className="size-3.5 text-violet-300" />
          <span className="flex-1">Style analysis (Claude reads the measurements and contact sheets, writes style.json + teardown.md)</span>
          {analysis && <JobStatus status={analysis.status} />}
        </div>
      </div>
      {analysis?.status === "running" && <AgentLog job={live.job ?? analysis} events={live.events} compact />}
    </div>
  );
}

/** Links that failed to download (e.g. a YouTube 403): retry the same link or paste another. */
function FailedVideos({ d, onAdd }: { d: Detail; onAdd: (url: string) => void }) {
  const failed = (d.progress?.videos ?? []).filter((v) => v.stage === "failed");
  const [urls, setUrls] = useState<Record<number, string>>({});
  if (!failed.length) return null;
  return (
    <div className="space-y-2 rounded-xl border border-amber-400/40 p-3">
      <p className="text-sm">
        <AlertTriangle className="mr-1 inline size-4 text-amber-300" />
        {failed.length} of {d.progress!.videos.length} videos couldn&apos;t be measured, so the profile is based on {(d.measurements?.videos ?? []).length}. Retry, or use another video:
      </p>
      {failed.map((v) => (
        <div key={v.index} className="flex flex-wrap items-center gap-2 text-xs">
          <Input value={urls[v.index] ?? v.url} onChange={(e) => setUrls({ ...urls, [v.index]: e.target.value })} className="h-8 max-w-md flex-1 font-mono text-xs" />
          <Button size="sm" variant="secondary" className="h-8" onClick={() => onAdd((urls[v.index] ?? v.url).trim())}>
            <RefreshCw /> Measure it
          </Button>
          <span className="text-red-400">{v.error}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- summary

function Card({ icon: Icon, title, big, children }: { icon: typeof Gauge; title: string; big?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 rounded-xl border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" /> {title}
      </div>
      {big && <div className="text-2xl font-semibold tracking-tight">{big}</div>}
      <div className="space-y-1 text-sm">{children}</div>
    </div>
  );
}
const Note = ({ children }: { children?: React.ReactNode }) => (children ? <p className="text-xs text-muted-foreground">{children}</p> : null);
const Swatch = ({ c }: { c?: string | null }) =>
  c && /^#[0-9a-f]{6}$/i.test(c) ? <span className="inline-block size-3 rounded-sm border align-middle" style={{ background: c }} title={c} /> : null;

export function SummaryCards({ style: s }: { style: CreatorStyle }) {
  const c = s.captions;
  return (
    <div className="space-y-3">
      <p className="rounded-xl border bg-card/40 p-3 text-sm">{s.summary}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card icon={Sparkles} title="Hook style">
          <p>{s.hooks.pattern}</p>
          {s.hooks.examples.slice(0, 2).map((e, i) => (
            <p key={i} className="text-xs text-muted-foreground italic">“{e}”</p>
          ))}
          <Note>{s.hooks.textOnScreen ? "On-screen hook text" : s.hooks.textOnScreen === false ? "No on-screen hook text" : ""}{s.hooks.firstWordSec != null ? ` · first word at ${r(s.hooks.firstWordSec)} s` : ""}</Note>
        </Card>
        <Card icon={Timer} title="Seconds between cuts" big={s.pacing.avgShotSec != null ? `${r(s.pacing.avgShotSec)} s` : "–"}>
          <Note>
            median {r(s.pacing.medianShotSec)} s · {r(s.pacing.cutsPerSec, 2)} cuts/s{s.pacing.wordsPerMin ? ` · ${r(s.pacing.wordsPerMin, 0)} words/min` : ""}
          </Note>
          <Note>{s.pacing.notes}</Note>
        </Card>
        <Card icon={Gauge} title="First 2 seconds" big={s.pacing.first2s?.cuts != null ? `${r(s.pacing.first2s.cuts, 1)} cuts` : s.pacing.cutsFirst3s != null ? `${r(s.pacing.cutsFirst3s, 1)} cuts / 3 s` : "–"}>
          <Note>{s.pacing.first2s?.words != null ? `${r(s.pacing.first2s.words, 0)} words said` : ""}</Note>
          <Note>{s.pacing.first2s?.notes}</Note>
        </Card>
        <Card icon={Captions} title="Captions">
          {c.present ? (
            <>
              <p>
                {c.style ?? "?"} · {c.case ?? "?"} case · {c.fontFeel ?? c.font ?? "?"}
              </p>
              <Note>
                {c.size ?? ""}
                {c.sizePx ? ` (${r(c.sizePx, 0)} px)` : ""} · {c.position ?? "?"}
                {c.y != null ? ` (${Math.round(c.y * 100)}% down)` : ""} · {c.wordsOnScreen ?? c.wordsPerLine ?? "?"} words on screen
              </Note>
              <p className="flex items-center gap-1 text-xs">
                text <Swatch c={c.color} /> highlight <Swatch c={c.highlight} />
              </p>
            </>
          ) : (
            <p>No captions</p>
          )}
          <Note>{c.notes}</Note>
        </Card>
        <Card icon={ZoomIn} title="Zoom pattern" big={s.zooms.perMinute != null ? `${r(s.zooms.perMinute)}/min` : "–"}>
          <p>
            {s.zooms.style ?? "?"}
            {s.zooms.typicalScale ? ` · ${r(s.zooms.typicalScale, 2)}×` : ""}
            {s.zooms.onEmphasis ? " · on emphasis words" : ""}
          </p>
          <Note>{s.zooms.notes}</Note>
        </Card>
        <Card icon={Layers} title="Visuals / overlays">
          <p>{s.visuals?.overlays?.length ? s.visuals.overlays.join(", ") : "None seen"}</p>
          <Note>
            {[s.visuals?.emojis && "emoji", s.visuals?.broll && "b-roll cutaways", s.visuals?.progressBar && "progress bar"].filter(Boolean).join(" · ")}
          </Note>
          <Note>{s.visuals?.notes}</Note>
        </Card>
        <Card icon={Volume2} title="Sound cues" big={s.sound.sfxPerMin != null ? `${r(s.sound.sfxPerMin)}/min` : undefined}>
          <p>{s.sound.sfx.length ? s.sound.sfx.join(", ") : "No distinct sound effects"}</p>
          <Note>
            {s.sound.music ? `Music ${s.sound.musicLevel ?? ""}` : s.sound.music === false ? "No music" : ""}
            {s.sound.cutsOnSoundCue != null ? ` · ${Math.round(s.sound.cutsOnSoundCue * 100)}% of cuts on a sound cue` : ""}
          </Note>
          <Note>{s.sound.notes}</Note>
        </Card>
        <Card icon={LayoutTemplate} title="Layout">
          <p>{s.layout.framing ?? "?"}</p>
          <Note>{[s.layout.textCards && "text cards", s.layout.splitScreen && "split screen", s.layout.broll && "b-roll"].filter(Boolean).join(" · ")}</Note>
          <Note>{s.layout.notes}</Note>
        </Card>
      </div>
      {s.structure.beats.length > 0 && (
        <Card icon={Clapperboard} title="Structure">
          <p>{s.structure.beats.join(" → ")}</p>
          <Note>{s.structure.cta ? `CTA: ${s.structure.cta}` : ""}</Note>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- consistency

function Consistency({ d, videos, onReplace, running }: { d: Detail; videos: Measured[]; onReplace: (videoId: string, url: string) => void; running: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const rows = (d.style?.consistency ?? []) as ConsistencyRow[];
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {videos.map((v, i) => {
          const verdict = d.verdicts.find((x) => x.id === v.id);
          const bad = verdict?.verdict === "MISMATCH";
          const thumb = v.frames?.layout?.file ?? v.frames?.hook?.file ?? v.sheets?.hook; // mid-video: many videos fade in from black
          return (
            <div key={v.id} className={cn("space-y-2 rounded-xl border p-2", bad ? "border-amber-400/50" : "border-emerald-500/30")}>
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {thumb ? <img src={fileUrl(d.handle, thumb)} alt="" className="aspect-[9/16] w-full rounded-md bg-black object-cover" /> : <div className="aspect-[9/16] rounded-md bg-muted" />}
                <span className={cn("absolute top-1 left-1 rounded-full px-2 py-0.5 text-[11px] font-medium", bad ? "bg-amber-400 text-black" : "bg-emerald-500 text-black")}>
                  {bad ? "⚠️ MISMATCH" : "✅ match"}
                </span>
              </div>
              <p className="line-clamp-2 text-xs" title={v.title ?? ""}>
                V{i + 1} · {v.title || v.id}
              </p>
              {bad && (
                <ul className="space-y-0.5 text-[11px] text-amber-200">
                  {verdict!.reasons.map((r, j) => (
                    <li key={j}>{r}</li>
                  ))}
                </ul>
              )}
              {bad &&
                (open === v.id ? (
                  <div className="space-y-1">
                    <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="New TikTok / Shorts link" className="h-7 text-[11px]" />
                    <div className="flex gap-1">
                      <Button size="sm" className="h-6 flex-1 px-2 text-[11px]" disabled={!url.trim() || running} onClick={() => (onReplace(v.id, url), setOpen(null), setUrl(""))}>
                        Replace
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setOpen(null)}>
                        ✕
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="secondary" className="h-7 w-full text-xs" disabled={running} onClick={() => setOpen(v.id)}>
                    <Repeat /> Replace video
                  </Button>
                ))}
            </div>
          );
        })}
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-2 py-1.5 font-medium">Topic</th>
                <th className="px-2 py-1.5 font-medium">Most videos</th>
                {videos.map((_, i) => (
                  <th key={i} className="px-2 py-1.5 font-medium">
                    V{i + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.metric} className="border-t">
                  <td className="px-2 py-1.5">{row.label}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{row.reference}</td>
                  {videos.map((v) => {
                    const x = row.values.find((y) => y.id === v.id);
                    return (
                      <td key={v.id} className={cn("px-2 py-1.5", x?.verdict === "MISMATCH" && "text-amber-300")}>
                        {x ? `${x.value}${x.verdict === "MISMATCH" ? " ⚠️" : ""}` : "–"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        A video is a MISMATCH when a measured number is far from the other videos&apos; median, or a category (caption style, layout, hook type…) differs from most of them. Style passes treat mismatched topics as optional.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- side by side

function SideBySide({ handle, videos }: { handle: string; videos: Measured[] }) {
  return (
    <div className="space-y-4">
      {CATS.map((c) => (
        <div key={c.id} className="space-y-1.5">
          <h3 className="text-sm font-medium">{c.label}</h3>
          <div className="grid grid-cols-5 gap-2">
            {videos.map((v, i) => {
              const f = v.frames?.[c.id];
              return (
                <figure key={v.id} className="space-y-0.5">
                  {f ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={fileUrl(handle, f.file)} alt="" loading="lazy" className="aspect-[9/16] w-full rounded-md bg-black object-cover" />
                  ) : (
                    <div className="flex aspect-[9/16] items-center justify-center rounded-md bg-muted text-[10px] text-muted-foreground">none</div>
                  )}
                  <figcaption className="text-[10px] text-muted-foreground">
                    V{i + 1}
                    {f ? ` · ${f.t}s` : ""}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- overrides

function Overrides({ d }: { d: Detail }) {
  const { rules, replaced } = d.overrides;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Your taste rules (the taste checklist) beat any creator style. Here is what they replace in @{d.handle}&apos;s style:</p>
      {replaced.length ? (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="px-3 py-2 font-medium">Topic</th>
                <th className="px-3 py-2 font-medium">@{d.handle}</th>
                <th className="px-3 py-2 font-medium">Your rule (wins)</th>
              </tr>
            </thead>
            <tbody>
              {replaced.map((x, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-3 py-2">{x.topic}</td>
                  <td className="px-3 py-2 text-muted-foreground line-through">{x.creatorValue ?? "(not set)"}</td>
                  <td className="px-3 py-2 text-emerald-300">{x.ruleText}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">None of your taste rules touch this creator&apos;s values.</p>
      )}
      <div className="space-y-1">
        <h3 className="text-sm font-medium">All your taste rules</h3>
        {rules.length ? (
          <ul className="space-y-1 text-sm">
            {rules.map((t) => (
              <li key={t.id} className="rounded-md border px-3 py-1.5">
                <span className="font-mono text-xs text-violet-300">{t.id}</span> <span className="rounded bg-muted px-1 text-[10px]">{t.topic}</span> {t.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No taste rules yet. Save one after a render (“Save as taste rule”) or from the chat.</p>
        )}
      </div>
    </div>
  );
}
