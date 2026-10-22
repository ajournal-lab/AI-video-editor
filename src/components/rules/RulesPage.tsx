"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ListChecks, Loader2, Pencil, Power, PowerOff, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface Video {
  id: string;
  title: string;
  thumbnailUrl: string | null;
  kinds: Record<string, number>;
  last: string;
  notes: string[];
}
interface Rule {
  id: string;
  n: number;
  title: string;
  added: string | null;
  topic: string;
  type: "taste" | "default" | "hard" | "process";
  status: "active" | "disabled";
  words: string;
  inPractice: string;
  also: string[];
  addedIn: string | null;
  replacedBy: string | null;
  section: string;
  videos: Video[];
}
interface Data {
  file: string;
  topics: string[];
  types: Rule["type"][];
  rules: Rule[];
}

const TYPE_HELP: Record<Rule["type"], string> = {
  taste: "yours: beats the brand kit, creator styles and looks",
  default: "house default: a taste rule, brand kit, creator style or look may change it",
  hard: "a quality or safety limit that always applies",
  process: "how Claude works on an edit",
};
const KIND_LABEL: Record<string, string> = {
  added: "added here",
  reinforced: "repeated here",
  violated: "broken in a draft",
  warned: "borderline in a draft",
  fixed: "fixed",
  conflict: "a note contradicted it",
  replaced: "replaced here",
};
const KIND_TONE: Record<string, string> = {
  added: "text-violet-300",
  reinforced: "text-violet-300",
  violated: "text-red-300",
  warned: "text-amber-200",
  fixed: "text-emerald-300",
  conflict: "text-amber-200",
  replaced: "text-muted-foreground",
};

/** The taste checklist (REEL_STUDIO_DIR/taste-checklist.md): search, edit, disable, and which videos each rule affected. */
export function RulesPage() {
  const [data, setData] = useState<Data | null>(null);
  const [q, setQ] = useState("");
  const [type, setType] = useState<string>("all");
  const [topic, setTopic] = useState<string>("all");
  const [status, setStatus] = useState<"all" | "active" | "disabled">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [del, setDel] = useState<Rule | null>(null);

  const load = useCallback(() => api<Data>("/api/rules").then(setData).catch((e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);

  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.rules ?? []).filter((r) => {
      if (type !== "all" && r.type !== type) return false;
      if (topic !== "all" && r.topic !== topic) return false;
      if (status !== "all" && r.status !== status) return false;
      if (!words.length) return true;
      const hay = [r.id, r.title, r.words, r.inPractice, r.topic, r.type, r.section, r.addedIn ?? "", ...r.also, ...r.videos.map((v) => v.title)].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [data, q, type, topic, status]);

  const sections = useMemo(() => {
    const m = new Map<string, Rule[]>();
    for (const r of list) m.set(r.section || "Rules", [...(m.get(r.section || "Rules") ?? []), r]);
    return [...m.entries()];
  }, [list]);

  const patch = async (id: string, body: Partial<Rule>) => {
    try {
      await api(`/api/rules/${id}`, { method: "PATCH", json: body });
      await load();
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
  const remove = async (r: Rule) => {
    try {
      await api(`/api/rules/${r.id}?confirm=yes`, { method: "DELETE" });
      toast.success(`${r.id} deleted from the taste checklist`);
      setDel(null);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const counts = data ? { all: data.rules.length, active: data.rules.filter((r) => r.status === "active").length } : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ListChecks className="size-6 text-violet-300" /> Taste checklist
        </h1>
        <p className="text-sm text-muted-foreground">
          Every edit is held to these rules, and a fresh checker checks each draft against them before you see it. Your notes become new rules here, in
          your own words. {counts && `${counts.active} active of ${counts.all}.`}
        </p>
        {data && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{data.file}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules, your words, videos…" className="pl-8" />
        </div>
        <Select value={type} onChange={setType} options={["all", ...(data?.types ?? [])]} label="Type" />
        <Select value={topic} onChange={setTopic} options={["all", ...(data?.topics ?? [])]} label="Topic" />
        <Select value={status} onChange={(v) => setStatus(v as typeof status)} options={["all", "active", "disabled"]} label="Status" />
      </div>

      {!data && <Loader2 className="mx-auto animate-spin text-muted-foreground" />}
      {data && !list.length && <p className="text-sm text-muted-foreground">No rule matches.</p>}

      {sections.map(([section, rules]) => (
        <section key={section} className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">{section}</h2>
          {rules.map((r) =>
            editing === r.id ? (
              <RuleEditor key={r.id} rule={r} topics={data!.topics} types={data!.types} onCancel={() => setEditing(null)} onSave={async (b) => (await patch(r.id, b)) && setEditing(null)} />
            ) : (
              <RuleCard
                key={r.id}
                rule={r}
                onEdit={() => setEditing(r.id)}
                onToggle={() => patch(r.id, { status: r.status === "active" ? "disabled" : "active" })}
                onDelete={() => setDel(r)}
              />
            ),
          )}
        </section>
      ))}

      <AlertDialog open={Boolean(del)} onOpenChange={(v) => !v && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {del?.id}?</AlertDialogTitle>
            <AlertDialogDescription>
              “{del?.title}” is removed from the taste checklist for good, with its history on the videos it affected. Disabling keeps it for history
              and stops applying it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            {del?.status === "active" && (
              <Button variant="secondary" onClick={() => del && patch(del.id, { status: "disabled" }).then(() => setDel(null))}>
                Disable instead
              </Button>
            )}
            <AlertDialogAction onClick={() => del && remove(del)} className="bg-destructive text-white hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Select({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: string[]; label: string }) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted-foreground">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-md border bg-transparent px-2 text-sm text-foreground">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function RuleCard({ rule: r, onEdit, onToggle, onDelete }: { rule: Rule; onEdit: () => void; onToggle: () => void; onDelete: () => void }) {
  const [showVideos, setShowVideos] = useState(false);
  const off = r.status === "disabled";
  return (
    <div className={cn("rounded-lg border p-3", off && "opacity-60")}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 font-mono text-sm text-violet-300">{r.id}</span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">{r.title}</div>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-muted-foreground">
            <span>{r.added ?? "date unknown"}</span>
            <span title={TYPE_HELP[r.type]}>{r.type}</span>
            <span>{r.topic}</span>
            {off && <span className="text-amber-200">disabled</span>}
            {r.addedIn && <span>from “{r.addedIn}”</span>}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" className="size-7" onClick={onEdit} title="Edit">
            <Pencil className="size-3.5" />
          </Button>
          <Button size="icon" variant="ghost" className="size-7" onClick={onToggle} title={off ? "Enable" : "Disable (kept, not applied)"}>
            {off ? <Power className="size-3.5" /> : <PowerOff className="size-3.5" />}
          </Button>
          <Button size="icon" variant="ghost" className="size-7 text-muted-foreground hover:text-destructive" onClick={onDelete} title="Delete (asks first)">
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <div className="mt-2 space-y-1.5 pl-9 text-sm">
        <p>
          <span className="text-xs text-muted-foreground">Your words: </span>
          {r.words ? <span className="italic">{r.words}</span> : <span className="text-muted-foreground">not on record</span>}
        </p>
        {r.also.map((a, i) => (
          <p key={i} className="text-xs text-muted-foreground">
            Also said {a}
          </p>
        ))}
        <p className="whitespace-pre-wrap text-muted-foreground">
          <span className="text-xs">In practice: </span>
          {r.inPractice}
        </p>
        {r.replacedBy && <p className="text-xs text-amber-200">Replaced by {r.replacedBy}</p>}
        <button type="button" onClick={() => setShowVideos((v) => !v)} className="text-xs text-violet-300 hover:text-violet-200">
          {r.videos.length ? `Affected ${r.videos.length} video${r.videos.length > 1 ? "s" : ""} ${showVideos ? "▴" : "▾"}` : "No videos affected yet"}
        </button>
        {showVideos && r.videos.length > 0 && (
          <ul className="space-y-1">
            {r.videos.map((v) => (
              <li key={v.id} className="flex items-start gap-2 rounded-md bg-muted/30 p-1.5 text-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" className="h-10 w-6 rounded object-cover" /> : <div className="h-10 w-6 rounded bg-muted" />}
                <div className="min-w-0">
                  <Link href={`/projects/${v.id}`} className="font-medium hover:underline">
                    {v.title}
                  </Link>
                  <div className="flex flex-wrap gap-x-2">
                    {Object.entries(v.kinds).map(([k, n]) => (
                      <span key={k} className={KIND_TONE[k] ?? ""}>
                        {KIND_LABEL[k] ?? k}
                        {n > 1 ? ` ×${n}` : ""}
                      </span>
                    ))}
                  </div>
                  {v.notes.map((n, i) => (
                    <div key={i} className="truncate text-muted-foreground" title={n}>
                      {n}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RuleEditor({ rule, topics, types, onCancel, onSave }: { rule: Rule; topics: string[]; types: Rule["type"][]; onCancel: () => void; onSave: (b: Partial<Rule>) => void }) {
  const [title, setTitle] = useState(rule.title);
  const [words, setWords] = useState(rule.words);
  const [inPractice, setInPractice] = useState(rule.inPractice);
  const [topic, setTopic] = useState(rule.topic);
  const [type, setType] = useState(rule.type);
  return (
    <div className="space-y-2 rounded-lg border border-violet-400/40 p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-violet-300">{rule.id}</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1" />
        <Button size="icon" variant="ghost" onClick={onCancel} aria-label="Cancel">
          <X />
        </Button>
      </div>
      <label className="block text-xs text-muted-foreground">
        Your words (keep them as you said them)
        <Textarea value={words} onChange={(e) => setWords(e.target.value)} rows={2} className="mt-1 text-sm" />
      </label>
      <label className="block text-xs text-muted-foreground">
        In practice
        <Textarea value={inPractice} onChange={(e) => setInPractice(e.target.value)} rows={4} className="mt-1 text-sm" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={topic} onChange={setTopic} options={topics} label="Topic" />
        <Select value={type} onChange={(v) => setType(v as Rule["type"])} options={types} label="Type" />
        <span className="text-[11px] text-muted-foreground">{TYPE_HELP[type]}</span>
        <Button className="ml-auto" onClick={() => onSave({ title, words, inPractice, topic, type })} disabled={title.trim().length < 3 || inPractice.trim().length < 3}>
          Save
        </Button>
      </div>
    </div>
  );
}
