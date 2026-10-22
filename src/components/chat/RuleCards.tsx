"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, BookmarkCheck, Check, ListChecks, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/components/editor/store";
import { cn } from "@/lib/utils";
import { useChat, type ChatMsg, type RuleCheckDTO, type RuleConflictDTO, type RuleNotesDTO } from "./store";

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const RuleId = ({ id }: { id: string }) => <span className="font-mono text-violet-300">{id}</span>;

/** Notes filed in the taste checklist before the change (R2). */
export function RuleNotesCard({ d }: { d: RuleNotesDTO }) {
  return (
    <div className="space-y-1 rounded-md border border-violet-400/30 bg-violet-400/5 p-2 text-[11px]">
      <div className="flex items-center gap-1 font-medium text-violet-200">
        <BookmarkCheck className="size-3" /> In your taste checklist
      </div>
      {d.added.map((a) => (
        <div key={a.id}>
          <RuleId id={a.id} /> {a.title}
          <div className="text-muted-foreground">your words: “{clip(a.words)}”</div>
        </div>
      ))}
      {d.reinforced.map((a) => (
        <div key={a.id} className="text-muted-foreground">
          <RuleId id={a.id} /> already a rule ({a.title}): your words were added to it
        </div>
      ))}
      <Link href="/rules" className="inline-block text-violet-300 hover:text-violet-200">
        Rules page →
      </Link>
    </div>
  );
}

/** A note contradicts a rule: which wins? (R6) Nothing is applied until this is answered. */
export function RuleConflictCard({ m, projectId, context }: { m: ChatMsg; projectId: string; context: "editor" | "plan" }) {
  const c = m.data!.ruleConflict as RuleConflictDTO;
  const [choices, setChoices] = useState<Record<number, "new" | "old" | "once">>({});
  const [busy, setBusy] = useState(false);
  const label = { new: "New note wins", old: "Keep the rule", once: "Only this video" } as const;
  const submit = async () => {
    setBusy(true);
    try {
      const json = context === "editor" ? useEditor.getState().timeline : undefined;
      const r = await api<{ applied: boolean }>(`/api/projects/${projectId}/rules`, { method: "POST", json: { messageId: m.id, choices, json } });
      toast.success(r.applied ? "Saved. Applying the note now" : "Kept your rule; nothing changed");
      await useChat.getState().refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border border-amber-400/40 bg-amber-400/5 p-2 text-[11px]">
      <div className="flex items-center gap-1 font-medium text-amber-200">
        <AlertTriangle className="size-3" /> Which wins?
      </div>
      {c.items.map((it, i) => (
        <div key={i} className="space-y-1">
          <div>
            New note: <span className="text-foreground">“{clip(it.words, 220)}”</span>
          </div>
          {it.conflictsWith.map((r) => (
            <div key={r.id} className="text-muted-foreground">
              vs <RuleId id={r.id} /> {r.title}
              {r.words && <> (you said: “{clip(r.words, 120)}”)</>}
            </div>
          ))}
          {it.why && <div className="text-muted-foreground italic">{it.why}</div>}
          {c.resolved ? (
            <div className="text-emerald-300">
              <Check className="mr-1 inline size-3" />
              {it.choice ? label[it.choice] : ""}
              {it.newRuleId ? ` (saved as ${it.newRuleId})` : ""}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1">
              {(["new", "old", "once"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setChoices({ ...choices, [i]: k })}
                  className={cn("rounded-full border px-2 py-0.5", choices[i] === k ? "border-amber-300 bg-amber-300/15 text-foreground" : "text-muted-foreground hover:border-amber-300")}
                >
                  {label[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      {!c.resolved && (
        <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy || Object.keys(choices).length < c.items.length} onClick={submit}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Confirm
        </Button>
      )}
      {!c.resolved && <p className="text-muted-foreground">“New note wins” disables the old rule (it is kept, marked as replaced). Nothing is deleted.</p>}
    </div>
  );
}

/** The fresh checker's report on a draft (R5): what it found and what was fixed. */
export function RuleCheckCard({ r }: { r: RuleCheckDTO }) {
  const [open, setOpen] = useState(r.left.length > 0);
  const fixed = new Set(r.fixed.map((f) => f.rule));
  return (
    <div className="space-y-1 rounded-md border border-emerald-400/30 bg-emerald-400/5 p-2 text-[11px]">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-1 text-left font-medium text-emerald-200">
        <ShieldCheck className="size-3" /> Rule check · {r.target === "cut" ? "spoken cut" : "key stills"} · {r.checked} rules · {r.found.length} found · {r.fixed.length} fixed
        {r.left.length ? ` · ${r.left.length} left` : ""}
      </button>
      {r.summary && <p className="text-muted-foreground">{r.summary}</p>}
      {open && (
        <ul className="space-y-1">
          {r.found.map((f, i) => (
            <li key={i}>
              <RuleId id={f.rule} /> <span className={f.severity === "fail" ? "text-red-300" : "text-amber-200"}>{f.severity}</span> · {f.where}: {f.problem}
              {fixed.has(f.rule) && <div className="text-emerald-300">fixed: {r.fixed.find((x) => x.rule === f.rule)?.what}</div>}
            </li>
          ))}
          {r.fixed
            .filter((f) => !r.found.some((x) => x.rule === f.rule))
            .map((f, i) => (
              <li key={`x${i}`} className="text-emerald-300">
                <RuleId id={f.rule} /> fixed: {f.what}
              </li>
            ))}
        </ul>
      )}
      {r.note && <p className="text-amber-200">{r.note}</p>}
    </div>
  );
}

/** R7: the rules this video added, posted when a render finishes. */
export function RenderDoneCard({ d }: { d: NonNullable<NonNullable<ChatMsg["data"]>["renderDone"]> }) {
  if (!d.rules.length) return null;
  return (
    <div className="space-y-1 rounded-md bg-muted/30 p-2 text-[11px]">
      <div className="flex items-center gap-1 font-medium">
        <ListChecks className="size-3 text-violet-300" /> Rules added while making this video
      </div>
      {d.rules.map((r) => (
        <div key={r.id}>
          <RuleId id={r.id} /> {r.title}
          {r.words && <div className="text-muted-foreground">“{clip(r.words)}”</div>}
        </div>
      ))}
    </div>
  );
}
