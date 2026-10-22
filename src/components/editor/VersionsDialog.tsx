"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Columns2, Copy, Download, History, Loader2, Pause, Pencil, Play, RotateCcw, Save, Smartphone, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { Timeline } from "@/lib/timeline/types";
import { describeChanges } from "@/lib/timeline/changes";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useEditor } from "./store";
import { PhoneLink } from "./PhoneLink";

interface RenderLite {
  id: string;
  status: string;
  progress: number;
  step: string | null;
  quality: string;
  outputUrl: string | null;
  previewUrl: string | null;
  thumbUrl: string | null;
  duration: number | null;
  finishedAt: string | null;
}

export interface VersionRow {
  id: string;
  name: string;
  kind: string;
  number: number | null;
  notes: string | null;
  createdAt: string;
  _count?: { renders: number };
  renders?: RenderLite[];
}

const videoOf = (v: VersionRow) => v.renders?.[0]?.previewUrl ?? v.renders?.[0]?.outputUrl ?? null;

export function VersionsDialog() {
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [compare, setCompare] = useState<[VersionRow, VersionRow] | null>(null);
  const projectId = useEditor((s) => s.projectId);
  const router = useRouter();

  const load = () =>
    api<{ versions: VersionRow[] }>(`/api/projects/${projectId}/versions`)
      .then((r) => setVersions(r.versions))
      .catch((e) => toast.error(e.message));

  useEffect(() => {
    if (!open) return;
    load();
    const t = setInterval(load, 4000); // renders in progress: previews appear as they finish
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const snapshot = async (n: string, kind: "manual" | "before-restore" = "manual") =>
    api(`/api/projects/${projectId}/versions`, { method: "POST", json: { name: n, json: useEditor.getState().timeline, kind } });

  const save = async () => {
    const n = name.trim() || `Snapshot · ${new Date().toLocaleString()}`;
    setBusy("save");
    try {
      await snapshot(n);
      setName("");
      toast.success(`Saved “${n}”`);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const restore = async (v: VersionRow) => {
    setBusy(v.id);
    try {
      const { version } = await api<{ version: { json: Timeline } }>(`/api/projects/${projectId}/versions/${v.id}`);
      await snapshot(`Before restoring “${v.name}”`, "before-restore");
      const s = useEditor.getState();
      s.commit(version.json, `Restore ${v.number ? `v${v.number}` : v.name}`);
      s.select([]);
      toast.success(`Restored ${v.number ? `v${v.number}` : `“${v.name}”`} into the editor (undo to go back)`);
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async (v: VersionRow) => {
    setBusy(v.id);
    try {
      const r = await api<{ projectId: string }>(`/api/projects/${projectId}/versions/${v.id}`, { method: "POST", json: { action: "duplicate" } });
      toast.success("Duplicated as a new project");
      router.push(`/projects/${r.projectId}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (v: VersionRow) => {
    if (!confirm(`Delete version “${v.name}”?`)) return;
    try {
      await api(`/api/projects/${projectId}/versions/${v.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const saveNotes = async (v: VersionRow, notes: string) => {
    try {
      await api(`/api/projects/${projectId}/versions/${v.id}`, { method: "POST", json: { action: "notes", notes } });
      setVersions((list) => list?.map((x) => (x.id === v.id ? { ...x, notes } : x)) ?? null);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const togglePick = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  const numbered = (versions ?? []).filter((v) => v.number != null);
  const snapshots = (versions ?? []).filter((v) => v.number == null);
  const startCompare = () => {
    const [a, b] = picked.map((id) => numbered.find((v) => v.id === id)!).sort((x, y) => (x.number ?? 0) - (y.number ?? 0));
    if (a && b) setCompare([a, b]);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setCompare(null);
          setPlaying(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <History /> <span className="hidden lg:inline">Versions</span>
        </Button>
      </DialogTrigger>
      <DialogContent className={cn("max-h-[92vh] overflow-y-auto", compare ? "max-w-4xl" : "max-w-2xl")}>
        <DialogHeader>
          <DialogTitle>{compare ? `Compare v${compare[0].number} and v${compare[1].number}` : "Versions"}</DialogTitle>
          <DialogDescription>
            {compare ? "Both play in sync (phone previews). What changed between them is listed under the players." : "Every render is saved as a numbered version with notes on what changed. Preview, compare, or restore one into the editor."}
          </DialogDescription>
        </DialogHeader>
        {compare ? (
          <Compare projectId={projectId} a={compare[0]} b={compare[1]} onBack={() => setCompare(null)} onRestore={restore} />
        ) : (
          <Tabs defaultValue="renders">
            <div className="flex items-center gap-2">
              <TabsList>
                <TabsTrigger value="renders">Renders{numbered.length ? ` (${numbered.length})` : ""}</TabsTrigger>
                <TabsTrigger value="snapshots">Snapshots{snapshots.length ? ` (${snapshots.length})` : ""}</TabsTrigger>
              </TabsList>
              <div className="ml-auto flex items-center gap-1">
                <PhoneLink />
                <Button size="sm" variant="secondary" disabled={picked.length !== 2} onClick={startCompare} title="Tick two versions to compare">
                  <Columns2 /> Compare{picked.length ? ` (${picked.length}/2)` : ""}
                </Button>
              </div>
            </div>
            <TabsContent value="renders" className="space-y-2">
              {versions === null ? (
                <Spinner />
              ) : !numbered.length ? (
                <p className="py-6 text-center text-sm text-muted-foreground">No renders yet. Each export becomes v1, v2, … here.</p>
              ) : (
                numbered.map((v) => (
                  <RenderVersion
                    key={v.id}
                    v={v}
                    busy={busy === v.id}
                    picked={picked.includes(v.id)}
                    playing={playing === v.id}
                    onPick={() => togglePick(v.id)}
                    onPlay={() => setPlaying(playing === v.id ? null : v.id)}
                    onRestore={() => restore(v)}
                    onDuplicate={() => duplicate(v)}
                    onNotes={(n) => saveNotes(v, n)}
                  />
                ))
              )}
            </TabsContent>
            <TabsContent value="snapshots" className="space-y-2">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
              >
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name a snapshot (e.g. Tighter intro)" />
                <Button type="submit" disabled={busy === "save"}>
                  {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save
                </Button>
              </form>
              <div className="space-y-1">
                {snapshots.map((v) => (
                  <div key={v.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{v.name}</div>
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {new Date(v.createdAt).toLocaleString()}
                        {v.kind !== "manual" && <Badge variant="secondary" className="h-4 px-1 text-[10px]">{v.kind}</Badge>}
                      </div>
                    </div>
                    <Button size="sm" variant="secondary" disabled={busy === v.id} onClick={() => restore(v)} title="Restore into the editor">
                      {busy === v.id ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === v.id} onClick={() => duplicate(v)} title="Duplicate as a new project">
                      <Copy />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => remove(v)} title="Delete" disabled={Boolean(v._count?.renders)}>
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-6">
      <Loader2 className="animate-spin text-muted-foreground" />
    </div>
  );
}

function RenderVersion(p: {
  v: VersionRow;
  busy: boolean;
  picked: boolean;
  playing: boolean;
  onPick: () => void;
  onPlay: () => void;
  onRestore: () => void;
  onDuplicate: () => void;
  onNotes: (n: string) => void;
}) {
  const { v } = p;
  const r = v.renders?.[0];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(v.notes ?? "");
  const video = videoOf(v);
  const notes = (v.notes ?? "").split("\n").filter(Boolean);
  return (
    <div className={cn("rounded-lg border p-2", p.picked && "border-primary bg-primary/5")}>
      <div className="flex gap-3">
        <button type="button" onClick={video ? p.onPlay : undefined} className="relative flex h-24 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-black" title={video ? "Play the phone preview" : undefined}>
          {r?.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.thumbUrl} alt="" className="h-full w-full object-cover" />
          ) : r && r.status !== "failed" ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : null}
          {video && <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition-opacity hover:opacity-100">{p.playing ? <Pause className="size-5" /> : <Play className="size-5" />}</span>}
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={p.picked} onChange={p.onPick} className="accent-violet-500" aria-label="Pick to compare" />
              <span className="font-mono text-sm font-semibold">v{v.number}</span>
            </label>
            <span className="truncate text-xs text-muted-foreground">{new Date(v.createdAt).toLocaleString()}</span>
            {r && <RenderBadge r={r} />}
          </div>
          {editing ? (
            <div className="space-y-1">
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} className="text-xs" />
              <div className="flex gap-1">
                <Button
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => {
                    p.onNotes(draft);
                    setEditing(false);
                  }}
                >
                  Save notes
                </Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <ul className="group/notes relative space-y-0.5 pr-5 text-[11px] text-muted-foreground">
              {notes.length ? notes.slice(0, 6).map((n, i) => <li key={i} className="truncate">• {n}</li>) : <li className="italic">No notes</li>}
              <button
                type="button"
                className="absolute top-0 right-0 rounded p-0.5 opacity-0 group-hover/notes:opacity-100 hover:bg-muted"
                onClick={() => {
                  setDraft(v.notes ?? "");
                  setEditing(true);
                }}
                title="Edit notes"
              >
                <Pencil className="size-3" />
              </button>
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Button size="sm" variant="secondary" disabled={p.busy} onClick={p.onRestore} title="Restore this version into the editor">
            {p.busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Restore
          </Button>
          {r?.outputUrl && (
            <Button size="sm" variant="ghost" asChild title="Full-quality MP4">
              <a href={r.outputUrl} download target="_blank" rel="noreferrer">
                <Download /> MP4
              </a>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={p.onDuplicate} title="Duplicate as a new project">
            <Copy />
          </Button>
        </div>
      </div>
      {p.playing && video && (
        <div className="mt-2 flex justify-center">
          <video src={video} controls autoPlay playsInline className="max-h-[60vh] rounded bg-black" />
        </div>
      )}
    </div>
  );
}

function RenderBadge({ r }: { r: RenderLite }) {
  if (r.status === "done")
    return (
      <Badge variant="outline" className="h-4 gap-1 px-1 text-[10px]">
        {r.previewUrl && <Smartphone className="size-2.5" />} {r.quality}
      </Badge>
    );
  if (r.status === "failed") return <Badge variant="destructive" className="h-4 px-1 text-[10px]">failed</Badge>;
  return (
    <Badge variant="secondary" className="h-4 px-1 text-[10px]" title={r.step ?? undefined}>
      {r.status === "queued" ? "queued" : r.step ? "waiting for inserts" : `${Math.round(r.progress * 100)}%`}
    </Badge>
  );
}

/** Two versions side by side: one play/pause/seek drives both players; the notes and a fresh diff below. */
function Compare({ projectId, a, b, onBack, onRestore }: { projectId: string; a: VersionRow; b: VersionRow; onBack: () => void; onRestore: (v: VersionRow) => void }) {
  const refs = [useRef<HTMLVideoElement>(null), useRef<HTMLVideoElement>(null)];
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [diff, setDiff] = useState<string[] | null>(null);
  useEffect(() => {
    Promise.all([a, b].map((v) => api<{ version: { json: Timeline } }>(`/api/projects/${projectId}/versions/${v.id}`)))
      .then(([x, y]) => setDiff(describeChanges(x.version.json, y.version.json)))
      .catch(() => setDiff([]));
  }, [projectId, a, b]);
  const each = (fn: (v: HTMLVideoElement) => void) => refs.forEach((r) => r.current && fn(r.current));
  const toggle = () => {
    if (playing) each((v) => v.pause());
    else each((v) => v.play().catch(() => {}));
    setPlaying(!playing);
  };
  const seek = (s: number) => {
    each((v) => (v.currentTime = Math.min(s, Math.max(0, (v.duration || s) - 0.05))));
    setT(s);
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {[a, b].map((v, i) => (
          <div key={v.id} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-semibold">v{v.number}</span>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => onRestore(v)}>
                <RotateCcw className="size-3" /> Restore v{v.number}
              </Button>
            </div>
            {videoOf(v) ? (
              <video
                ref={refs[i]}
                src={videoOf(v)!}
                playsInline
                muted={i === 1}
                className="aspect-[9/16] max-h-[52vh] w-full rounded bg-black object-contain"
                onLoadedMetadata={(e) => {
                  const len = e.currentTarget.duration || 0; // read now: the event's target is gone inside the updater
                  setDur((d) => Math.max(d, len));
                }}
                onTimeUpdate={(e) => i === 0 && setT(e.currentTarget.currentTime)}
                onEnded={() => setPlaying(false)}
              />
            ) : (
              <div className="flex aspect-[9/16] max-h-[52vh] items-center justify-center rounded bg-muted text-xs text-muted-foreground">Not rendered yet</div>
            )}
            <ul className="space-y-0.5 text-[11px] text-muted-foreground">
              {(v.notes ?? "").split("\n").filter(Boolean).slice(0, 5).map((n, j) => (
                <li key={j}>• {n}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button size="icon" className="rounded-full" onClick={toggle} aria-label={playing ? "Pause both" : "Play both"}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <input type="range" min={0} max={dur || 1} step={0.01} value={t} onChange={(e) => seek(Number(e.target.value))} className="flex-1 accent-violet-500" aria-label="Seek both" />
        <span className="w-20 text-right font-mono text-xs tabular-nums">
          {t.toFixed(1)} / {dur.toFixed(1)}s
        </span>
        <span className="text-[11px] text-muted-foreground">sound: v{a.number}</span>
      </div>
      <div className="rounded-lg border p-2.5 text-xs">
        <div className="mb-1 font-medium">
          v{a.number} → v{b.number}
        </div>
        {diff === null ? <Loader2 className="size-3 animate-spin" /> : diff.length ? diff.map((d, i) => <div key={i}>• {d}</div>) : <div className="text-muted-foreground">No differences in the timeline</div>}
      </div>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <X /> Back to versions
      </Button>
    </div>
  );
}
