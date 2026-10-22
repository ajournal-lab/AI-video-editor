"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

interface Check {
  ok: boolean;
  level: "ok" | "warn" | "error";
  site: string | null;
  message: string;
  title?: string;
  uploader?: string | null;
  thumbnail?: string | null;
}
type FieldState = { url: string; checking: boolean; check: Check | null };

const blank = (): FieldState => ({ url: "", checking: false, check: null });

/** Quick local check before asking the server (which asks yt-dlp whether the video is public and reachable). */
function localCheck(url: string): Check | null {
  const u = url.trim();
  if (!u) return null;
  if (/instagram\.com/i.test(u)) return { ok: false, level: "warn", site: "Instagram", message: "Instagram links usually fail (login wall). Use the creator's TikTok or YouTube Shorts version of this video." };
  if (!/^https:\/\//i.test(u)) return { ok: false, level: "error", site: null, message: "Links must start with https://" };
  if (!/(tiktok\.com|youtube\.com|youtu\.be)/i.test(u)) return { ok: false, level: "error", site: null, message: "Only TikTok and YouTube Shorts links are supported" };
  return null;
}

/**
 * New creator profile (or "Re-analyse with new links" when `handle` is fixed): a handle, 5 links checked live,
 * optional notes. "Analyse" queues the teardown on the agent runner.
 */
export function CreatorForm({ handle: fixed, initialUrls, initialNotes }: { handle?: string; initialUrls?: string[] | null; initialNotes?: string }) {
  const router = useRouter();
  const [handle, setHandle] = useState(fixed ?? "");
  const [fields, setFields] = useState<FieldState[]>(() => Array.from({ length: 5 }, (_, i) => ({ ...blank(), url: initialUrls?.[i] ?? "" })));
  const [notes, setNotes] = useState(initialNotes ?? "");
  const [latest, setLatest] = useState(false); // fallback: the creator's latest 5 from their profile page
  const [platform, setPlatform] = useState<"tiktok" | "youtube">("tiktok");
  const [busy, setBusy] = useState(false);
  const timers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});
  const seq = useRef<Record<number, number>>({});

  const validate = (i: number, url: string) => {
    clearTimeout(timers.current[i]);
    const local = localCheck(url);
    if (!url.trim() || local) {
      setFields((f) => f.map((x, j) => (j === i ? { ...x, checking: false, check: local } : x)));
      return;
    }
    setFields((f) => f.map((x, j) => (j === i ? { ...x, checking: true, check: null } : x)));
    const n = (seq.current[i] = (seq.current[i] ?? 0) + 1);
    timers.current[i] = setTimeout(async () => {
      try {
        const r = await api<Check>("/api/creators/validate", { method: "POST", json: { url } });
        if (seq.current[i] === n) setFields((f) => f.map((x, j) => (j === i ? { ...x, checking: false, check: r } : x)));
      } catch (e) {
        if (seq.current[i] === n) setFields((f) => f.map((x, j) => (j === i ? { ...x, checking: false, check: { ok: false, level: "error", site: null, message: (e as Error).message } } : x)));
      }
    }, 600);
  };

  useEffect(() => {
    fields.forEach((f, i) => f.url && validate(i, f.url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setUrl = (i: number, url: string) => {
    setFields((f) => f.map((x, j) => (j === i ? { ...x, url } : x)));
    validate(i, url);
  };
  const filled = fields.filter((f) => f.url.trim());
  const good = fields.filter((f) => f.check?.ok);
  const dupes = new Set(filled.map((f) => f.url.trim())).size !== filled.length;
  const handleOk = /^@?[a-zA-Z0-9._-]{1,60}$/.test(handle.trim());
  const canRun = !busy && handleOk && (latest || (good.length === 5 && !dupes && !fields.some((f) => f.checking)));

  const analyse = async () => {
    setBusy(true);
    try {
      const urls = latest ? null : fields.map((f) => f.url.trim());
      const r = fixed
        ? await api<{ handle: string }>(`/api/creators/${encodeURIComponent(fixed)}/rerun`, { method: "POST", json: { urls, notes, platform: latest ? platform : undefined } })
        : await api<{ handle: string }>("/api/creators", { method: "POST", json: { handle: handle.trim(), urls, notes, platform: latest ? platform : undefined } });
      toast.success(`Analysing @${r.handle ?? fixed}`);
      router.push(`/creators/${r.handle ?? fixed}`);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {!fixed && (
        <div className="space-y-2">
          <Label htmlFor="handle">Creator handle</Label>
          <Input id="handle" value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@creator" className="max-w-xs" />
          {handle && !handleOk && <p className="text-xs text-red-400">Letters, numbers, dots, dashes and underscores only.</p>}
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label>5 videos (TikTok or YouTube Shorts)</Label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={latest} onCheckedChange={setLatest} /> Use their latest 5 instead
          </label>
        </div>
        {latest ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm">
            Take the latest 5 from
            <select value={platform} onChange={(e) => setPlatform(e.target.value as "tiktok" | "youtube")} className="h-8 rounded-md border bg-transparent px-2">
              <option value="tiktok">tiktok.com/@{handle.replace(/^@/, "") || "handle"}</option>
              <option value="youtube">youtube.com/@{handle.replace(/^@/, "") || "handle"}/shorts</option>
            </select>
            <span className="text-xs text-muted-foreground">Profile pages are sometimes blocked: links are more reliable.</span>
          </div>
        ) : (
          fields.map((f, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
                <Input
                  value={f.url}
                  onChange={(e) => setUrl(i, e.target.value)}
                  placeholder={i % 2 ? "https://www.youtube.com/shorts/…" : "https://www.tiktok.com/@creator/video/…"}
                  className={cn("font-mono text-xs", f.check?.level === "error" && "border-red-500/60", f.check?.level === "warn" && "border-amber-400/60", f.check?.ok && "border-emerald-500/50")}
                />
                <span className="w-5">
                  {f.checking ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : f.check?.ok && f.check.level === "ok" ? (
                    <CheckCircle2 className="size-4 text-emerald-400" />
                  ) : f.check?.level === "warn" ? (
                    <AlertTriangle className="size-4 text-amber-300" />
                  ) : f.check ? (
                    <XCircle className="size-4 text-red-400" />
                  ) : null}
                </span>
              </div>
              {(f.check || f.checking) && (
                <p className={cn("pl-7 text-[11px]", f.check?.level === "error" ? "text-red-400" : f.check?.level === "warn" ? "text-amber-300" : "text-muted-foreground")}>
                  {f.checking ? "Checking that it's public and reachable…" : f.check?.ok && f.check.title ? `${f.check.message} · “${f.check.title}”${f.check.uploader ? ` by ${f.check.uploader}` : ""}` : f.check?.message}
                </p>
              )}
            </div>
          ))
        )}
        {dupes && !latest && <p className="text-xs text-red-400">The same link is in two fields.</p>}
      </div>

      <div className="space-y-2">
        <Label htmlFor="notes">Notes (optional)</Label>
        <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="I like their captions and pacing" />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={analyse} disabled={!canRun}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Analyse
        </Button>
        <p className="text-xs text-muted-foreground">
          {latest ? "" : `${good.length}/5 links ready. `}Downloads with yt-dlp, transcribes on your machine (faster-whisper), measures cuts, zooms and sound cues, then Claude writes the style profile. About 1-2 min per video.
        </p>
      </div>
    </div>
  );
}
