"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Copy, Download, Loader2, MoreHorizontal, Pencil, Plus, Trash2, Upload, Users, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { fileUrl, type CreatorListItem } from "./types";

export const STATUS: Record<string, { label: string; cls: string }> = {
  measuring: { label: "Measuring videos", cls: "text-sky-300" },
  analysing: { label: "Claude is analysing", cls: "text-violet-300" },
  ready: { label: "Ready", cls: "text-emerald-400" },
  failed: { label: "Failed", cls: "text-red-400" },
};

/** Ask for a new handle and run a profile action (rename / duplicate). */
export async function promptHandle(action: "rename" | "duplicate", handle: string): Promise<string | null> {
  const to = window.prompt(action === "rename" ? `Rename @${handle} to:` : `Duplicate @${handle} as:`, action === "duplicate" ? `${handle}-copy` : handle);
  if (!to || to.replace(/^@/, "") === handle) return null;
  try {
    const r = await api<{ handle: string }>(`/api/creators/${encodeURIComponent(handle)}/${action}`, { method: "POST", json: { to } });
    toast.success(action === "rename" ? `Renamed to @${r.handle}` : `Duplicated as @${r.handle}`);
    return r.handle;
  } catch (e) {
    toast.error((e as Error).message);
    return null;
  }
}

export async function deleteProfile(handle: string) {
  if (!window.confirm(`Delete @${handle}? This removes its downloads, measurements, style.json and teardown.md.`)) return false;
  try {
    await api(`/api/creators/${encodeURIComponent(handle)}`, { method: "DELETE" });
    toast.success(`Deleted @${handle}`);
    return true;
  } catch (e) {
    toast.error((e as Error).message);
    return false;
  }
}

export function CreatorsPage() {
  const router = useRouter();
  const [list, setList] = useState<CreatorListItem[] | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const load = useCallback(() => api<{ creators: CreatorListItem[] }>("/api/creators").then((r) => setList(r.creators)), []);

  useEffect(() => {
    load().catch((e) => toast.error(e.message));
  }, [load]);
  useEffect(() => {
    if (!list?.some((c) => c.status === "measuring" || c.status === "analysing")) return;
    const t = setInterval(() => load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [list, load]);

  const importZip = async (f: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch("/api/creators/import", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Import failed");
      toast.success(`Imported @${j.handle}`);
      router.push(`/creators/${j.handle}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Creators</h1>
          <p className="text-sm text-muted-foreground">Measure 5 videos of a creator once, then edit any reel in their style. Your taste rules always win over theirs.</p>
        </div>
        <div className="flex gap-2">
          <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(e) => e.target.files?.[0] && importZip(e.target.files[0])} />
          <Button variant="secondary" onClick={() => fileRef.current?.click()} disabled={importing}>
            {importing ? <Loader2 className="animate-spin" /> : <Upload />} Import .zip
          </Button>
          <Button asChild>
            <Link href="/creators/new">
              <Plus /> New creator profile
            </Link>
          </Button>
        </div>
      </div>

      {!list && <Loader2 className="mx-auto animate-spin text-muted-foreground" />}
      {list && list.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed p-10 text-center">
          <Users className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No creator profiles yet. Paste 5 TikTok or YouTube Shorts links of a creator whose editing you like.</p>
          <Button asChild>
            <Link href="/creators/new">
              <Plus /> New creator profile
            </Link>
          </Button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list?.map((c) => (
          <div key={c.handle} className="group relative flex gap-3 rounded-xl border p-3 transition hover:border-primary/60">
            <Link href={`/creators/${c.handle}`} className="absolute inset-0" aria-label={`Open @${c.handle}`} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {c.thumb ? <img src={fileUrl(c.handle, c.thumb)} alt="" className="h-28 w-20 shrink-0 rounded-md bg-black object-cover" /> : <div className="h-28 w-20 shrink-0 rounded-md bg-muted" />}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">@{c.handle}</span>
                {c.platform && <span className="rounded-full border px-1.5 text-[10px] text-muted-foreground">{c.platform}</span>}
              </div>
              <p className={cn("flex items-center gap-1 text-xs", STATUS[c.status]?.cls)}>
                {c.status === "ready" ? <CheckCircle2 className="size-3" /> : c.status === "failed" ? <XCircle className="size-3" /> : <Loader2 className="size-3 animate-spin" />}
                {STATUS[c.status]?.label}
                {c.status === "ready" && ` · ${c.videos} videos`}
                {c.mismatches ? (
                  <span className="ml-1 inline-flex items-center gap-0.5 text-amber-300">
                    <AlertTriangle className="size-3" /> {c.mismatches} mismatch{c.mismatches > 1 ? "es" : ""}
                  </span>
                ) : null}
              </p>
              <p className="line-clamp-3 text-xs text-muted-foreground">{c.summary ?? c.error ?? ""}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="relative z-10 size-7 shrink-0" aria-label="Profile actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={async () => (await promptHandle("rename", c.handle)) && load()}>
                  <Pencil /> Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={async () => (await promptHandle("duplicate", c.handle)) && load()}>
                  <Copy /> Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem asChild disabled={c.status !== "ready"}>
                  <a href={`/api/creators/${encodeURIComponent(c.handle)}/export`}>
                    <Download /> Export .zip
                  </a>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-400" onClick={async () => (await deleteProfile(c.handle)) && load()}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
    </div>
  );
}
