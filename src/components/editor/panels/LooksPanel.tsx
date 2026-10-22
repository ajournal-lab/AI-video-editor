"use client";

// Looks panel: the project's default look (initialised from the client's brand kit), look sections (also dragged on
// the timeline's Looks lane, said in the script or asked in the chat), and the per-look options. Changing anything here
// only changes tl.looks; the editor rebuilds the look content (looks-hook.ts).
import { CheckCircle2, Loader2, Mic, Plus, Sparkles, Trash2 } from "lucide-react";
import { clipEnd, lookSegments, timelineDuration } from "@/lib/timeline/derive";
import { LOOK_IDS, LOOKS } from "@/lib/timeline/lookdefs";
import { EMPTY_LOOKS, looksStale, sectionText, withLooks } from "@/lib/timeline/looks";
import { uid } from "@/lib/timeline/factory";
import type { LookId, LookSection, Looks } from "@/lib/timeline/types";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useEditor } from "../store";
import { useLooksInfo } from "../looks-hook";
import { formatTime } from "../format";
import { NumberField, Section } from "./fields";

const SOURCE_LABEL: Record<LookSection["source"], string> = { timeline: "dragged", chat: "chat", script: "said" };

export function LooksPanel() {
  const tl = useEditor((s) => s.timeline);
  const L: Looks = tl.looks ?? EMPTY_LOOKS;
  const info = useLooksInfo();
  const T = timelineDuration(tl);
  const set = (patch: Partial<Looks>, label: string) => {
    const s = useEditor.getState();
    s.commit(withLooks(s.timeline, patch), label);
  };
  const setSection = (id: string, patch: Partial<LookSection>) => set({ sections: L.sections.map((x) => (x.id === id ? { ...x, ...patch } : x)) }, "Look section");
  const addAtPlayhead = (look: LookId) => {
    const t = useEditor.getState().playhead;
    set({ sections: [...L.sections, { id: uid("ls"), start: Math.round(t * 100) / 100, end: Math.round(Math.min(T, t + 5) * 100) / 100, look, source: "timeline" }] }, `${LOOKS[look].label} section`);
  };
  const cut = tl.tracks.find((t) => t.role === "cutout");
  const cutClips = cut?.kind === "video" ? cut.clips : [];
  const matteWaiting = cutClips.filter((c) => !c.matte?.on).length;
  const stale = tl.looks ? looksStale(tl) : false;
  const segs = lookSegments(tl);
  const orbitChosen = L.orbitSources ?? null;

  return (
    <div>
      <Section
        title="Default look"
        action={
          stale ? (
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Building
            </span>
          ) : tl.looks?.default || L.sections.length ? (
            <span className="flex items-center gap-1 text-[11px] text-emerald-400">
              <CheckCircle2 className="size-3" /> Built
            </span>
          ) : null
        }
      >
        <div className="grid gap-1.5">
          {([null, ...LOOK_IDS] as (LookId | null)[]).map((id) => (
            <button
              key={id ?? "none"}
              type="button"
              onClick={() => set({ default: id }, id ? `Look: ${LOOKS[id].label}` : "No default look")}
              className={cn("rounded-md border p-2 text-left transition-colors hover:border-primary/60", L.default === id && "border-primary bg-primary/10")}
            >
              <span className="flex items-center gap-2 text-xs font-medium">
                <span className="size-2.5 rounded-full" style={{ background: id ? LOOKS[id].swatch : "transparent", boxShadow: id ? undefined : "inset 0 0 0 1px #888" }} />
                {id ? LOOKS[id].label : "None"}
                {id && info.clientLook === id && <span className="rounded bg-muted px-1 text-[9px] font-normal text-muted-foreground">client default</span>}
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{id ? LOOKS[id].blurb : "Your own captions, grade and crops."}</span>
            </button>
          ))}
        </div>
        {info.clientLook && L.default !== info.clientLook && (
          <Button size="sm" variant="ghost" className="mt-1 h-7 w-full text-xs" onClick={() => set({ default: info.clientLook }, "Client default look")}>
            Use the client default ({LOOKS[info.clientLook].label})
          </Button>
        )}
      </Section>

      <Section title="Sections">
        <p className="text-[11px] text-muted-foreground">
          Drag on the <b>Looks</b> lane above the timeline tracks, say it in the script (“cool girl aesthetic”), or ask the chat (“cool girl when I say boring, bold everywhere else”). Dragged sections win over the chat, the chat over the script.
        </p>
        <div className="space-y-1.5">
          {[...L.sections].sort((a, b) => a.start - b.start).map((s) => (
            <div key={s.id} className="space-y-1.5 rounded-md border p-2">
              <div className="flex items-center gap-1.5">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: LOOKS[s.look].swatch }} />
                <select
                  value={s.look}
                  onChange={(e) => setSection(s.id, { look: e.target.value as LookId })}
                  className="h-7 min-w-0 flex-1 rounded border bg-background px-1 text-xs"
                  aria-label="Look of this section"
                >
                  {LOOK_IDS.map((id) => (
                    <option key={id} value={id}>
                      {LOOKS[id].label}
                    </option>
                  ))}
                </select>
                <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground" title={s.cue ? `“${s.cue}”` : undefined}>
                  {s.source === "script" && <Mic className="mr-0.5 inline size-2.5" />}
                  {SOURCE_LABEL[s.source]}
                </span>
                {s.source !== "script" && (
                  <button type="button" className="text-muted-foreground hover:text-destructive" aria-label="Delete section" onClick={() => set({ sections: L.sections.filter((x) => x.id !== s.id) }, "Delete look section")}>
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              {s.source !== "script" ? (
                <div className="grid grid-cols-2 gap-1.5">
                  <NumberField label="From" value={s.start} min={0} max={s.end - 0.2} suffix="s" onCommit={(v) => setSection(s.id, { start: v })} />
                  <NumberField label="To" value={s.end} min={s.start + 0.2} max={T + 1} suffix="s" onCommit={(v) => setSection(s.id, { end: v })} />
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {formatTime(s.start)}–{formatTime(Math.min(s.end, T))} · said “{s.cue}”
                </p>
              )}
              <p className="truncate text-[10px] text-muted-foreground">{sectionText(tl, s)}</p>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-1">
          {LOOK_IDS.map((id) => (
            <Button key={id} size="sm" variant="secondary" className="h-7 px-1 text-[11px]" onClick={() => addAtPlayhead(id)} title={`Add a ${LOOKS[id].label} section at the playhead (5 s)`}>
              <Plus className="size-3" /> {LOOKS[id].label}
            </Button>
          ))}
        </div>
        <label className="flex items-center justify-between gap-2 pt-1 text-xs">
          <span>
            Switch when I say it in the script
            <span className="block text-[11px] text-muted-foreground">“cool girl aesthetic”, “bold look”, “cool dude”</span>
          </span>
          <Switch checked={L.autoScript} onCheckedChange={(v) => set({ autoScript: v }, v ? "Script cues on" : "Script cues off")} />
        </label>
        {segs.length > 0 && (
          <div className="flex h-3 overflow-hidden rounded" title="The look over time">
            {segs.map((g, i) => (
              <div key={i} style={{ width: `${((g.end - g.start) / Math.max(T, 0.01)) * 100}%`, background: g.look ? LOOKS[g.look].swatch : "transparent" }} title={`${g.look ? LOOKS[g.look].label : "No look"} ${formatTime(g.start)}–${formatTime(g.end)}`} />
            ))}
          </div>
        )}
      </Section>

      {(L.default === "cool_girl" || L.sections.some((s) => s.look === "cool_girl")) && (
        <Section title="Cool girl · your reels orbiting you">
          {info.reels.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No reels of yours yet: render another project first, and it shows up here.</p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">{orbitChosen ? `${orbitChosen.length} picked` : "Your latest 4 reels"} (up to 6). Built in the background while you edit.</p>
              <div className="grid grid-cols-4 gap-1">
                {info.reels.map((r) => {
                  const on = orbitChosen ? orbitChosen.includes(r.url) : info.reels.slice(0, 4).some((x) => x.url === r.url);
                  return (
                    <button
                      key={r.url}
                      type="button"
                      title={r.title}
                      onClick={() => {
                        const cur = orbitChosen ?? info.reels.slice(0, 4).map((x) => x.url);
                        const next = on ? cur.filter((u) => u !== r.url) : [...cur, r.url].slice(0, 6);
                        set({ orbitSources: next }, "Orbit reels");
                      }}
                      className={cn("relative aspect-[9/16] overflow-hidden rounded border-2", on ? "border-pink-400" : "border-transparent opacity-50")}
                    >
                      {r.thumb ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.thumb} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <Sparkles className="m-auto size-4" />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </Section>
      )}

      {(L.default === "cool_dude" || L.sections.some((s) => s.look === "cool_dude")) && (
        <Section title="Cool dude · crops">
          <label className="flex items-center justify-between gap-2 text-xs">
            <span>
              Soft close-ups
              <span className="block text-[11px] text-muted-foreground">Crop in even when the source is too small (upscales; slightly softer).</span>
            </span>
            <Switch checked={Boolean(L.softCloseups)} onCheckedChange={(v) => set({ softCloseups: v }, "Soft close-ups")} />
          </label>
        </Section>
      )}

      {(tl.looks?.notes?.length || cutClips.length > 0) && (
        <Section title="Status">
          {cutClips.length > 0 && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {matteWaiting ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3 text-emerald-400" />}
              {matteWaiting ? `Cutting the speaker out (${matteWaiting} of ${cutClips.length} clips), on the agent runner` : `Speaker cut out (${cutClips.length} clips, ${cutClips.reduce((n, c) => n + (clipEnd(c) - c.start), 0).toFixed(1)}s)`}
            </p>
          )}
          {tl.looks?.notes?.filter((n) => !n.startsWith("Cutting the speaker")).map((n, i) => (
            <p key={i} className="text-[11px] text-amber-300">
              {n}
            </p>
          ))}
        </Section>
      )}
    </div>
  );
}
