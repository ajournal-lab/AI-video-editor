"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAgentJob, type AgentJobDTO } from "@/lib/client/agent";
import { cn } from "@/lib/utils";
import { AgentLog, JobStatus } from "./AgentLog";
import { RunnerLine } from "./AgentPanel";

type Row = AgentJobDTO & { projectTitle: string | null };

/** Every Claude job across projects, with the live log of the selected one. */
export function JobsPage() {
  const [jobs, setJobs] = useState<Row[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const live = useAgentJob(selected);
  const load = useCallback(() => api<{ jobs: Row[] }>("/api/agent/jobs").then((r) => setJobs(r.jobs)), []);
  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Claude jobs</h1>
        <p className="text-sm text-muted-foreground">Every AI step runs as a headless Claude Code job on your subscription. Full logs are saved in each project folder (storage/studio/&lt;project&gt;/jobs).</p>
      </div>
      <RunnerLine />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {jobs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No jobs yet. Open a project and use Claude in the editor.
                  </td>
                </tr>
              )}
              {jobs.map((j) => (
                <tr key={j.id} onClick={() => setSelected(j.id)} className={cn("cursor-pointer border-t hover:bg-muted/40", selected === j.id && "bg-primary/10")}>
                  <td className="max-w-64 truncate px-3 py-2">{j.title}</td>
                  <td className="max-w-40 truncate px-3 py-2 text-xs">
                    {j.projectId ? (
                      <Link href={`/projects/${j.projectId}`} onClick={(e) => e.stopPropagation()} className="underline-offset-2 hover:underline">
                        {j.projectTitle}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <JobStatus status={j.status} />
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(j.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected ? (
          <AgentLog job={live.job} events={live.events} onCancel={() => live.cancel().catch((e) => toast.error(e.message))} className="h-[70dvh]" />
        ) : (
          <div className="flex h-40 items-center justify-center rounded-lg border text-sm text-muted-foreground">Select a job to see its log.</div>
        )}
      </div>
    </div>
  );
}
