"use client";

import { useCallback, useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";

type Node = { id: string; name: string; host: string; status: string; job: string | null; startedAt: string; lastSeen: string; online: boolean };
type Pool = { nodes: Node[]; queued: { renders: number; voices: number; inserts: number } };

function ago(iso: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

/** Which team PCs are online in the render pool, what each is doing, and the queue they share. */
export function PoolPage() {
  const [pool, setPool] = useState<Pool | null>(null);
  const load = useCallback(() => api<Pool>("/api/pool").then(setPool), []);
  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load]);

  const online = pool?.nodes.filter((n) => n.online) ?? [];
  const offline = pool?.nodes.filter((n) => !n.online) ?? [];
  const q = pool?.queued;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Render pool</h1>
        <p className="text-sm text-muted-foreground">
          Team PCs that run exports, transcription and animated inserts. Any PC that is online picks up the next job in the queue.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="PCs online" value={pool ? online.length : "…"} />
        <Stat label="Exports waiting" value={q?.renders ?? "…"} />
        <Stat label="Voiceovers waiting" value={q?.voices ?? "…"} />
        <Stat label="Inserts waiting" value={q?.inserts ?? "…"} />
      </div>
      {pool && online.length === 0 && (q?.renders || q?.voices || q?.inserts) ? (
        <p className="rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-200">No PC is online, so queued work waits until someone joins the pool.</p>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">Online</h2>
        {pool && online.length === 0 && <p className="text-sm text-muted-foreground">Nobody is online right now.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          {online.map((n) => (
            <div key={n.id} className="flex items-start gap-3 rounded-lg border bg-card p-3">
              <Cpu className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{n.name}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", n.status === "busy" ? "bg-primary text-primary-foreground" : "bg-emerald-500/15 text-emerald-300")}>
                    {n.status === "busy" ? "Busy" : "Ready"}
                  </span>
                </div>
                <p className="truncate text-sm text-muted-foreground">{n.job ?? "Waiting for work"}</p>
                <p className="text-xs text-muted-foreground">Online for {ago(n.startedAt)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {offline.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">Offline</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {offline.map((n) => (
              <li key={n.id} className="flex justify-between gap-3 px-3 py-2 text-muted-foreground">
                <span className="truncate">{n.name}</span>
                <span className="shrink-0">last seen {ago(n.lastSeen)} ago</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2 rounded-lg border p-4 text-sm">
        <h2 className="font-medium">Add a PC to the pool</h2>
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>On that PC, install the app once with <code className="font-mono">setup.bat</code>.</li>
          <li>Ask the owner for a join code (they run <code className="font-mono">npm run pool:code</code>).</li>
          <li>Double-click <code className="font-mono">join-pool.bat</code> and paste the code. Close the window to leave the pool.</li>
        </ol>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
