"use client";

import { useCallback, useEffect, useState } from "react";
import { Cloud, ExternalLink, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useEditor } from "./store";
import { saveNow } from "./hooks";
import type { RenderRow } from "./ExportDialog";

type Minutes = { used: number; included: number | null; remaining: number | null } | null;
interface CloudRow {
  id: string;
  status: string;
  step: string | null;
  progress: number;
  repo: string;
  keep: boolean;
  runUrl: string | null;
  minutes: Minutes;
  renderJobId: string | null;
  cleanedUp: boolean;
  error: string | null;
  createdAt: string;
}
interface Prepared {
  cloudId: string;
  token: string;
  repo: { name: string; private: boolean; url: string };
  branch: string;
  keep: boolean;
  totalBytes: number;
  media: { name: string; bytes: number }[];
  fileCount: number;
  minutes: Minutes;
  changedSinceStills: boolean;
}
const ACTIVE = ["uploading", "queued", "running", "downloading", "cleaning"];
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
const minutesText = (m: Minutes) => (!m ? "GitHub didn't report your Actions minutes (the token needs billing read access)" : m.remaining != null ? `${m.remaining} of ${m.included} free Actions minutes left this month` : `${m.used} Actions minutes used this month`);

/**
 * "Render in cloud" (GitHub Actions). Hidden unless switched on in Settings. Nothing is uploaded until the user
 * reviews exactly what goes where in the confirmation dialog and clicks "Upload and render".
 */
export function CloudRender({ projectId, quality, blocked, onRendered }: { projectId: string; quality: "720p" | "1080p"; blocked: boolean; onRendered: (r: RenderRow) => void }) {
  const [cfg, setCfg] = useState<{ enabled: boolean; repo: string; keep: boolean; tokenSet: boolean; cloud: CloudRow[] } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [keep, setKeep] = useState(false);
  const [starting, setStarting] = useState(false);

  const load = useCallback(() => api<NonNullable<typeof cfg>>(`/api/projects/${projectId}/cloud`).then(setCfg), [projectId]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  // follow running cloud renders
  const active = cfg?.cloud.filter((c) => ACTIVE.includes(c.status)).map((c) => c.id).join(",") ?? "";
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      for (const id of active.split(",")) {
        const r = await api<{ cloud: CloudRow; render: RenderRow | null }>(`/api/cloud-renders/${id}`).catch(() => null);
        if (!r) continue;
        setCfg((c) => (c ? { ...c, cloud: c.cloud.map((x) => (x.id === id ? r.cloud : x)) } : c));
        if (r.render && r.cloud.status === "done") {
          onRendered(r.render);
          toast.success("Cloud render downloaded into the project");
        }
        if (r.cloud.status === "failed") toast.error(`Cloud render failed: ${r.cloud.error?.slice(0, 160)}`);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [active, onRendered]);

  if (!cfg) return null;
  if (!cfg.enabled)
    return <p className="text-center text-[11px] text-muted-foreground">Render in cloud (GitHub Actions) is off · Settings</p>;

  const prepare = async () => {
    setPreparing(true);
    try {
      await saveNow().catch(() => {});
      const p = await api<Prepared>(`/api/projects/${projectId}/cloud`, { method: "POST", json: { action: "prepare", quality, json: useEditor.getState().timeline } });
      setPrep(p);
      setKeep(p.keep);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPreparing(false);
    }
  };
  const cancelPrep = async () => {
    if (prep) await api(`/api/cloud-renders/${prep.cloudId}`, { method: "POST", json: { action: "discard" } }).catch(() => {});
    setPrep(null);
  };
  const start = async () => {
    if (!prep) return;
    setStarting(true);
    try {
      await api(`/api/projects/${projectId}/cloud`, { method: "POST", json: { action: "start", cloudId: prep.cloudId, token: prep.token, keep, confirm: true } });
      setPrep(null);
      toast.success("Uploading to your private repo…");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };
  const cleanup = async (id: string) => {
    try {
      const r = await api<{ done: string[]; errors: string[] }>(`/api/cloud-renders/${id}`, { method: "POST", json: { action: "cleanup" } });
      if (r.errors.length) toast.error(r.errors.join("; "));
      else toast.success(r.done.length ? `Deleted on GitHub: ${r.done.join(", ")}` : "Nothing left on GitHub");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-2">
      <Button variant="secondary" className="w-full" onClick={prepare} disabled={preparing || blocked || !cfg.tokenSet || !cfg.repo}>
        {preparing ? <Loader2 className="animate-spin" /> : <Cloud />} Render in cloud…
      </Button>
      {(!cfg.tokenSet || !cfg.repo) && <p className="text-[11px] text-amber-300">Set the private repo and CLOUD_RENDER_TOKEN first (Settings).</p>}

      {cfg.cloud.slice(0, 3).map((c) => (
        <div key={c.id} className="space-y-1 rounded-lg border p-2 text-[11px]">
          <div className="flex items-center gap-2">
            <Cloud className="size-3.5 text-sky-300" />
            <span className="flex-1 truncate">
              {c.repo} · {c.status}
              {c.step ? ` · ${c.step}` : ""}
            </span>
            {c.runUrl && (
              <a href={c.runUrl} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label="Open the Actions run">
                <ExternalLink className="size-3" />
              </a>
            )}
          </div>
          {ACTIVE.includes(c.status) && (
            <div className="h-1.5 overflow-hidden rounded bg-muted">
              <div className="h-full bg-sky-400 transition-all" style={{ width: `${Math.max(3, c.progress * 100)}%` }} />
            </div>
          )}
          <p className="text-muted-foreground">{minutesText(c.minutes)}</p>
          {c.error && <p className="text-red-400">{c.error}</p>}
          {!ACTIVE.includes(c.status) && !c.cleanedUp && c.status !== "cancelled" && (
            <button type="button" onClick={() => cleanup(c.id)} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
              <Trash2 className="size-3" /> {c.keep ? "Delete the kept uploads on GitHub" : "Clean up leftovers on GitHub"}
            </button>
          )}
        </div>
      ))}

      <AlertDialog open={Boolean(prep)} onOpenChange={(v) => !v && cancelPrep()}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Upload this render bundle to GitHub?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                {prep && (
                  <>
                    <p className="flex items-center gap-1.5 text-emerald-300">
                      <ShieldCheck className="size-4" /> {prep.repo.name} is private (checked just now, and again right before uploading).
                    </p>
                    <p>
                      {prep.fileCount} files, <b>{mb(prep.totalBytes)}</b>, go to a temporary branch <code>{prep.branch}</code>: the timeline, the render engine, fonts and these media files:
                    </p>
                    <ul className="max-h-32 overflow-y-auto rounded border p-2 font-mono text-[11px]">
                      {prep.media.map((m) => (
                        <li key={m.name}>
                          {m.name} · {mb(m.bytes)}
                        </li>
                      ))}
                    </ul>
                    <p>GitHub Actions renders {quality} with the same engine as a local export, then AJOURNALLAB Studio downloads the video into this project.</p>
                    <p className="text-muted-foreground">{minutesText(prep.minutes)}. A short reel usually takes 3-10 runner minutes.</p>
                    {prep.changedSinceStills && <p className="text-amber-300">The timeline changed after you approved the stills.</p>}
                    <label className="flex items-center justify-between gap-3 rounded-md border p-2">
                      <span className="text-xs">Keep the uploaded media and the artifact on GitHub afterwards (default: delete the branch, the run and the artifact)</span>
                      <Switch checked={keep} onCheckedChange={setKeep} />
                    </label>
                  </>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelPrep}>Don&apos;t upload</AlertDialogCancel>
            <Button onClick={start} disabled={starting}>
              {starting ? <Loader2 className="animate-spin" /> : <Cloud />} Upload and render
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
