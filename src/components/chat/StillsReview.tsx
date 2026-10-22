"use client";

import { useState } from "react";
import { Check, Loader2, MessageSquareWarning, RefreshCw, Trophy } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { fmtTime } from "@/lib/chat/fixes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEditor } from "@/components/editor/store";
import { useChat, type PipelineDTO } from "./store";

const KIND: Record<string, string> = { hook: "Hook", caption: "Caption", card: "Card", transition: "Transition", zoom: "Zoom", other: "Moment" };
const LAYER: Record<string, string> = { taste: "Your taste rule", brand: "Brand kit", creator: "Creator style", default: "Default" };

/** Stage 2: the key stills of the styled edit. Approve them to unlock rendering, or send notes = one style revision. */
export function StillsReview({ projectId, context }: { projectId: string; context: "editor" | "plan" }) {
  const p = useChat((s) => s.state?.pipeline);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  if (!p || !p.stills.length) return null;
  const approved = p.stage === "approved";
  const filled = Object.entries(notes).filter(([, v]) => v.trim());

  const act = async (label: string, body: Record<string, unknown>) => {
    setBusy(label);
    try {
      await api(`/api/projects/${projectId}/pipeline`, { method: "POST", json: body });
      await useChat.getState().refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const json = () => (context === "editor" ? useEditor.getState().timeline : undefined);

  if (approved)
    return (
      <details className="rounded-lg border border-emerald-500/40 p-2 text-xs">
        <summary className="flex cursor-pointer items-center gap-1 font-medium">
          <Check className="size-3.5 text-emerald-400" /> Stills approved: rendering is unlocked ({p.stills.length})
        </summary>
        <div className="mt-2 grid grid-cols-3 gap-1">
          {p.stills.map((s, i) =>
            s.file ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={`/api/projects/${projectId}/stills?file=${encodeURIComponent(s.file)}`} alt={s.label} title={`${fmtTime(s.t)} ${s.label}`} className="aspect-[9/16] w-full rounded bg-black object-cover" />
            ) : null,
          )}
        </div>
      </details>
    );
  return (
    <div className="space-y-2 rounded-lg border border-violet-400/50 bg-violet-500/5 p-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-medium">Key stills: approve before rendering</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {p.stills.map((s, i) => (
          <figure key={`${s.file}-${i}`} className="space-y-1">
            {s.file ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/projects/${projectId}/stills?file=${encodeURIComponent(s.file)}`}
                alt={s.label}
                className="aspect-[9/16] w-full cursor-pointer rounded-md bg-black object-cover"
                onClick={() => context === "editor" && useEditor.getState().setPlayhead(s.t)}
                title={context === "editor" ? "Jump to this moment" : undefined}
              />
            ) : (
              <div className="aspect-[9/16] rounded-md bg-muted" />
            )}
            <figcaption className="text-[10px] leading-tight">
              <span className="rounded bg-muted px-1 font-mono">{fmtTime(s.t)}</span> <span className="font-medium">{KIND[s.kind] ?? s.kind}</span>
              <span className="block truncate text-muted-foreground" title={s.why ?? s.label}>
                {s.label}
              </span>
            </figcaption>
            {!approved && (
              <Input value={notes[i] ?? ""} onChange={(e) => setNotes({ ...notes, [i]: e.target.value })} placeholder="fix…" className="h-6 px-1.5 text-[11px]" />
            )}
          </figure>
        ))}
      </div>
      {!approved && (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" className="h-7 flex-1 text-xs" disabled={Boolean(busy) || filled.length > 0} onClick={() => act("approve", { action: "approve_stills" })}>
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />} Approve stills
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 flex-1 text-xs"
            disabled={Boolean(busy) || !filled.length || context !== "editor"}
            onClick={() => act("fix", { action: "fix_stills", notes: filled.map(([i, text]) => ({ t: p.stills[Number(i)].t, text })), json: json() }).then(() => setNotes({}))}
          >
            {busy === "fix" ? <Loader2 className="animate-spin" /> : <MessageSquareWarning />} Send {filled.length || ""} fix{filled.length === 1 ? "" : "es"} (one revision)
          </Button>
        </div>
      )}
      {context === "editor" && (
        <button type="button" className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground" disabled={Boolean(busy)} onClick={() => act("stills", { action: "stills", json: json() })}>
          <RefreshCw className="size-3" /> Re-render stills from the current timeline
        </button>
      )}
    </div>
  );
}

/** Which layer won where taste rules, the brand kit and the creator style disagreed. */
export function ConflictList({ conflicts }: { conflicts: PipelineDTO["conflicts"] }) {
  return (
    <details className="rounded-lg border p-2 text-xs">
      <summary className="flex cursor-pointer items-center gap-1 font-medium">
        <Trophy className="size-3.5 text-amber-300" /> Which rule won ({conflicts.length})
      </summary>
      <p className="mt-1 text-[10px] text-muted-foreground">Priority: your taste rules &gt; brand kit &gt; creator style &gt; defaults.</p>
      <ul className="mt-2 space-y-1.5">
        {conflicts.map((c, i) => (
          <li key={i}>
            <span className="font-medium">{c.topic}</span>: <span className="text-emerald-300">{LAYER[c.winner] ?? c.winner}{c.rule ? ` ${c.rule}` : ""}</span> → {c.chosen}
            {c.overridden.length > 0 && (
              <span className="block text-[11px] text-muted-foreground">
                beat {c.overridden.map((o) => `${LAYER[o.layer] ?? o.layer} (${o.value})`).join(", ")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
