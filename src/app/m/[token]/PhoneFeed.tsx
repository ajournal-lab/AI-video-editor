"use client";

import { useEffect, useState } from "react";

interface Row {
  id: string;
  previewUrl: string;
  thumbUrl: string | null;
  duration: number | null;
  finishedAt: string | null;
  project: { id: string; title: string };
  version: { number: number | null; name: string; notes: string | null };
}

export function PhoneFeed({ token }: { token: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/m/${token}`, { cache: "no-store" })
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error ?? "Link not found"))))
        .then((j) => alive && setRows(j.renders))
        .catch((e) => alive && setError(e.message));
    load();
    const t = setInterval(load, 15000); // new renders show up while the page is open
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);

  return (
    <main className="mx-auto min-h-dvh max-w-md bg-background px-3 py-4 text-foreground">
      <h1 className="mb-1 text-lg font-semibold">AJOURNALLAB Studio previews</h1>
      <p className="mb-4 text-xs text-muted-foreground">Quick-review copies (720p). The full-quality export is in the app.</p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!rows && !error && <p className="text-sm text-muted-foreground">Loading…</p>}
      {rows?.length === 0 && <p className="text-sm text-muted-foreground">No previews yet. Render an edit and it appears here.</p>}
      <div className="space-y-6">
        {rows?.map((r) => (
          <article key={r.id} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="truncate text-sm font-medium">{r.project.title}</h2>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {r.version.number ? `v${r.version.number}` : r.version.name}
                {r.finishedAt ? ` · ${new Date(r.finishedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
              </span>
            </div>
            <video src={r.previewUrl} poster={r.thumbUrl ?? undefined} controls playsInline preload="metadata" className="aspect-[9/16] w-full rounded-lg bg-black object-contain" />
            {r.version.notes && (
              <details className="text-xs text-muted-foreground">
                <summary>What changed</summary>
                <ul className="mt-1 space-y-0.5">
                  {r.version.notes.split("\n").filter(Boolean).map((n, i) => (
                    <li key={i}>• {n}</li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
      </div>
    </main>
  );
}
