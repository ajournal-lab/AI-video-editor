"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clapperboard, Loader2, Mic, MoreVertical, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ProjectCard {
  id: string;
  title: string;
  aspect: string;
  status: string;
  statusMessage: string | null;
  thumbnailUrl: string | null;
  duration: number;
  creator?: string | null; // the creator style the edit uses
  isSample: boolean;
  updatedAt: string;
  renders: number;
}

const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-zinc-700 text-zinc-100" },
  transcribing: { label: "Transcribing", cls: "bg-sky-500/20 text-sky-200" },
  transcribed: { label: "Building", cls: "bg-sky-500/20 text-sky-200" },
  building: { label: "Building", cls: "bg-sky-500/20 text-sky-200" },
  ready: { label: "Ready to edit", cls: "bg-emerald-500/20 text-emerald-200" },
  rendered: { label: "Exported", cls: "bg-violet-500/25 text-violet-200" },
  failed: { label: "Failed", cls: "bg-red-500/20 text-red-200" },
  planning: { label: "Claude is planning", cls: "bg-sky-500/20 text-sky-200" },
  review: { label: "Plan ready to review", cls: "bg-amber-500/20 text-amber-200" },
  plan_failed: { label: "Planning failed", cls: "bg-red-500/20 text-red-200" },
};

const FILTERS = [
  { id: "all", label: "All" },
  { id: "processing", label: "Processing" },
  { id: "ready", label: "Ready" },
  { id: "rendered", label: "Exported" },
  { id: "failed", label: "Failed" },
];

const group = (s: string) =>
  ["draft", "transcribing", "transcribed", "building", "planning", "review"].includes(s) ? "processing" : s === "plan_failed" ? "failed" : s;

export function ProjectGrid({ initial }: { initial: ProjectCard[] }) {
  const [projects, setProjects] = useState(initial);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [aspect, setAspect] = useState("all");
  const [sampleBusy, setSampleBusy] = useState(false);
  const router = useRouter();

  const shown = useMemo(
    () =>
      projects.filter(
        (p) =>
          (status === "all" || group(p.status) === status) &&
          (aspect === "all" || p.aspect === aspect) &&
          p.title.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [projects, q, status, aspect],
  );

  const sample = async () => {
    setSampleBusy(true);
    try {
      const r = await api<{ projectId: string }>("/api/projects/sample", { method: "POST", json: { aspect: "9:16" } });
      router.push(`/projects/${r.projectId}`);
    } catch (e) {
      toast.error((e as Error).message);
      setSampleBusy(false);
    }
  };

  const remove = async (p: ProjectCard) => {
    if (!confirm(`Delete “${p.title}”? Its versions and renders go too.`)) return;
    try {
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      setProjects((list) => list.filter((x) => x.id !== p.id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (!projects.length) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
        <div className="brand-gradient mb-5 flex size-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-primary/30">
          <Mic className="size-6" />
        </div>
        <h1 className="text-xl font-semibold">Upload a recording to start</h1>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          Record or upload your voiceover. We transcribe it, cut a first edit with visuals and captions, and open it in the editor.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button asChild>
            <Link href="/projects/new">
              <Plus /> New video
            </Link>
          </Button>
          <Button variant="secondary" onClick={sample} disabled={sampleBusy}>
            {sampleBusy ? <Loader2 className="animate-spin" /> : <Sparkles />} Try a sample project
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <div className="flex gap-2 sm:ml-auto">
          <Button variant="secondary" size="sm" onClick={sample} disabled={sampleBusy}>
            {sampleBusy ? <Loader2 className="animate-spin" /> : <Sparkles />} Sample
          </Button>
          <Button size="sm" asChild>
            <Link href="/projects/new">
              <Plus /> New video
            </Link>
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects" className="pl-8" />
        </div>
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          {FILTERS.map((f) => (
            <Chip key={f.id} active={status === f.id} onClick={() => setStatus(f.id)}>
              {f.label}
            </Chip>
          ))}
          <span className="mx-1 w-px shrink-0 bg-border" />
          {["all", "9:16", "16:9", "1:1"].map((a) => (
            <Chip key={a} active={aspect === a} onClick={() => setAspect(a)}>
              {a === "all" ? "Any size" : a}
            </Chip>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No projects match these filters.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {shown.map((p) => (
            <div key={p.id} className="group relative overflow-hidden rounded-xl border bg-card transition hover:border-white/25">
              <Link href={`/projects/${p.id}`} className="block">
                <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-gradient-to-br from-zinc-800 to-zinc-950">
                  {p.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      className={cn("object-cover shadow-lg", p.aspect === "9:16" ? "h-full w-auto" : p.aspect === "1:1" ? "aspect-square w-[85%]" : "aspect-video w-full")}
                      loading="lazy"
                    />
                  ) : (
                    <Clapperboard className="size-8 text-muted-foreground" />
                  )}
                  <span className={cn("absolute top-2 left-2 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur", STATUS[p.status]?.cls)}>
                    {group(p.status) === "processing" && <Loader2 className="mr-1 inline size-2.5 animate-spin" />}
                    {STATUS[p.status]?.label ?? p.status}
                  </span>
                  {p.creator && (
                    <span className="absolute bottom-2 left-2 max-w-[60%] truncate rounded-full bg-violet-600/80 px-2 py-0.5 text-[10px] font-medium text-white" title={`Edited in the style of @${p.creator}`}>
                      @{p.creator}
                    </span>
                  )}
                  <Badge variant="secondary" className="absolute right-2 bottom-2 h-5 bg-black/60 px-1.5 text-[10px] text-white">
                    {p.aspect}
                    {p.duration ? ` · ${Math.round(p.duration)}s` : ""}
                  </Badge>
                </div>
                <div className="p-3">
                  <div className="truncate text-sm font-medium">{p.title}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {new Date(p.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}
                    {p.renders ? ` · ${p.renders} render${p.renders > 1 ? "s" : ""}` : ""}
                    {p.isSample ? " · sample" : ""}
                  </div>
                </div>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="absolute top-1.5 right-1.5 size-7 bg-black/40 opacity-100 sm:opacity-0 sm:group-hover:opacity-100" aria-label="Project menu">
                    <MoreVertical />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="text-destructive" onClick={() => remove(p)}>
                    <Trash2 /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("shrink-0 rounded-full border px-3 py-1 text-xs", active ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
    >
      {children}
    </button>
  );
}
