"use client";

import { useEffect, useMemo, useState } from "react";
import { Bug, Loader2, Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

interface Gotcha {
  id: string;
  n: number;
  title: string;
  date: string | null;
  area: string;
  status: "fixed" | "workaround" | "open";
  seen: number;
  problem: string;
  why: string;
  fix: string;
  section: string;
}

const TONE: Record<Gotcha["status"], string> = { fixed: "text-emerald-300", workaround: "text-amber-200", open: "text-red-300" };

/** gotchas.md: every technical problem hit so far, as Problem / Why it happened / Fix. Claude reads it before every edit. */
export function GotchasPage() {
  const [data, setData] = useState<{ file: string; gotchas: Gotcha[] } | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [area, setArea] = useState("all");

  useEffect(() => {
    api<{ file: string; gotchas: Gotcha[] }>("/api/gotchas").then(setData).catch((e) => toast.error(e.message));
  }, []);

  const areas = useMemo(() => [...new Set((data?.gotchas ?? []).map((g) => g.area))].sort(), [data]);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.gotchas ?? [])
      .filter((g) => (status === "all" || g.status === status) && (area === "all" || g.area === area))
      .filter((g) => {
        const hay = [g.id, g.title, g.problem, g.why, g.fix, g.area, g.section].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => (a.status === "open" ? 0 : 1) - (b.status === "open" ? 0 : 1) || b.n - a.n);
  }, [data, q, status, area]);
  const open = data?.gotchas.filter((g) => g.status === "open").length ?? 0;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Bug className="size-6 text-amber-300" /> Gotchas
        </h1>
        <p className="text-sm text-muted-foreground">
          Every technical problem hit so far and how it was fixed. Claude reads this before every edit; anything that breaks and gets fixed is added
          here before moving on. {data && `${data.gotchas.length} problems, ${open} still open.`}
        </p>
        {data && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{data.file}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search problems, causes, fixes…" className="pl-8" />
        </div>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm text-foreground">
            {["all", "open", "workaround", "fixed"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">
          Area
          <select value={area} onChange={(e) => setArea(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm text-foreground">
            {["all", ...areas].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      {!data && <Loader2 className="mx-auto animate-spin text-muted-foreground" />}
      {data && !list.length && <p className="text-sm text-muted-foreground">Nothing matches.</p>}
      <div className="space-y-2">
        {list.map((g) => (
          <div key={g.id} className={cn("rounded-lg border p-3", g.status === "open" && "border-red-400/40")}>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 font-mono text-sm text-amber-300">{g.id}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{g.title}</div>
                <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
                  <span>{g.date ?? "date unknown"}</span>
                  <span>{g.area}</span>
                  <span className={TONE[g.status]}>{g.status}</span>
                  {g.seen > 1 && <span>seen {g.seen}×</span>}
                </div>
              </div>
            </div>
            <dl className="mt-2 grid gap-1.5 pl-9 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-xs text-muted-foreground">Problem</dt>
              <dd className="whitespace-pre-wrap">{g.problem}</dd>
              <dt className="text-xs text-muted-foreground">Why it happened</dt>
              <dd className="whitespace-pre-wrap text-muted-foreground">{g.why}</dd>
              <dt className="text-xs text-muted-foreground">Fix</dt>
              <dd className="whitespace-pre-wrap">{g.fix}</dd>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}
