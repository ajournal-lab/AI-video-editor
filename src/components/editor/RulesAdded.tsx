"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ListChecks } from "lucide-react";
import { api } from "@/lib/client/api";

interface Added {
  id: string;
  title: string;
  words: string;
  status: string;
}

/** Taste checklist R7: the rules this video added, shown once it is rendered. */
export function RulesAdded({ projectId }: { projectId: string }) {
  const [added, setAdded] = useState<Added[] | null>(null);
  useEffect(() => {
    api<{ added: Added[] }>(`/api/projects/${projectId}/rules`)
      .then((r) => setAdded(r.added.filter((a) => a.status !== "deleted")))
      .catch(() => setAdded(null));
  }, [projectId]);
  if (!added) return null;
  return (
    <div className="mt-3 rounded-lg border p-3 text-xs">
      <div className="mb-1.5 flex items-center gap-1.5 font-medium">
        <ListChecks className="size-3.5 text-violet-300" /> Rules added while making this video
      </div>
      {added.length ? (
        <ul className="space-y-1.5">
          {added.map((a) => (
            <li key={a.id}>
              <span className="font-mono text-violet-300">{a.id}</span> {a.title}
              {a.status === "disabled" && <span className="ml-1 text-muted-foreground">(disabled)</span>}
              {a.words && <div className="text-muted-foreground">“{a.words.length > 160 ? `${a.words.slice(0, 159)}…` : a.words}”</div>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">None this time.</p>
      )}
      <Link href="/rules" className="mt-2 inline-block text-violet-300 hover:text-violet-200">
        Open the taste checklist →
      </Link>
    </div>
  );
}
