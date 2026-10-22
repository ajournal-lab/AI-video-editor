"use client";

// The Looks lane under the ruler: the look over time (faint band) with the look sections on top. Drag on the lane to
// paint a section with the brush look; drag a section's edges to resize it, its body to move it; click it to change its
// look or delete it. Sections said in the script are shown but edited in the Looks panel.
import { useState } from "react";
import { Palette, Trash2 } from "lucide-react";
import { lookSegments, timelineDuration } from "@/lib/timeline/derive";
import { LOOK_IDS, LOOKS } from "@/lib/timeline/lookdefs";
import { EMPTY_LOOKS, withLooks } from "@/lib/timeline/looks";
import { uid } from "@/lib/timeline/factory";
import type { LookId, LookSection } from "@/lib/timeline/types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useEditor } from "../store";

export const LOOKS_LANE_H = 22;
const r2 = (n: number) => Math.round(n * 100) / 100;

export function LooksLane({ zoom, headerW }: { zoom: number; headerW: number }) {
  const tl = useEditor((s) => s.timeline);
  const [brush, setBrush] = useState<LookId>("bold");
  const [draft, setDraft] = useState<{ a: number; b: number } | null>(null);
  const [live, setLive] = useState<LookSection[] | null>(null);
  const L = tl.looks ?? EMPTY_LOOKS;
  const sections = live ?? L.sections;
  const T = timelineDuration(tl);
  const segs = lookSegments(tl);

  const commit = (next: LookSection[], label: string) => {
    const s = useEditor.getState();
    s.commit(withLooks(s.timeline, { sections: next }), label);
  };

  const timeAt = (e: { clientX: number }, el: HTMLElement) => Math.max(0, Math.min(T + 2, (e.clientX - el.getBoundingClientRect().left) / zoom));

  const onLaneDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const lane = e.currentTarget;
    const a = timeAt(e, lane);
    setDraft({ a, b: a });
    const move = (ev: PointerEvent) => setDraft({ a, b: timeAt(ev, lane) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      const b = timeAt(ev, lane);
      const [s, en] = [Math.min(a, b), Math.max(a, b)];
      if (en - s < 0.3) return useEditor.getState().setPlayhead(a); // a click moves the playhead
      commit([...L.sections, { id: uid("ls"), start: r2(s), end: r2(en), look: brush, source: "timeline" }], `${LOOKS[brush].label} section`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onSectionDown = (sec: LookSection, mode: "move" | "left" | "right") => (e: React.PointerEvent) => {
    if (sec.source === "script" || e.button !== 0) return;
    e.stopPropagation();
    const lane = (e.currentTarget as HTMLElement).closest("[data-looks-lane]") as HTMLElement;
    const t0 = timeAt(e, lane);
    let moved = false;
    const at = (ev: PointerEvent) => {
      const d = timeAt(ev, lane) - t0;
      if (Math.abs(d * zoom) > 3) moved = true;
      const s =
        mode === "move"
          ? { ...sec, start: r2(Math.max(0, sec.start + d)), end: r2(Math.max(0, sec.start + d) + (sec.end - sec.start)) }
          : mode === "left"
            ? { ...sec, start: r2(Math.min(sec.end - 0.3, Math.max(0, sec.start + d))) }
            : { ...sec, end: r2(Math.max(sec.start + 0.3, sec.end + d)) };
      return L.sections.map((x) => (x.id === sec.id ? { ...s, source: "timeline" as const } : x));
    };
    const move = (ev: PointerEvent) => setLive(at(ev));
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setLive(null);
      if (moved) commit(at(ev), mode === "move" ? "Move look section" : "Resize look section");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex border-b border-white/5" style={{ height: LOOKS_LANE_H }}>
      <div className="sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r bg-zinc-950 px-2" style={{ width: headerW }}>
        <Palette className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs">Looks</span>
        <select
          value={brush}
          onChange={(e) => setBrush(e.target.value as LookId)}
          className="ml-auto h-5 max-w-[66px] rounded border bg-zinc-900 px-0.5 text-[10px]"
          title="Drag on the lane to paint a section with this look"
          aria-label="Look to paint"
        >
          {LOOK_IDS.map((id) => (
            <option key={id} value={id}>
              {LOOKS[id].label}
            </option>
          ))}
        </select>
      </div>
      <div data-looks-lane className="relative flex-1 cursor-crosshair" onPointerDown={onLaneDown} title="Drag to paint a look section">
        {/* the look over time (default + sections) */}
        {segs.map((g, i) =>
          g.look ? <div key={i} className="pointer-events-none absolute top-[9px] bottom-[9px] opacity-60" style={{ left: g.start * zoom, width: (g.end - g.start) * zoom, background: LOOKS[g.look].swatch }} /> : null,
        )}
        {sections.map((s) => (
          <Popover key={s.id}>
            <PopoverTrigger asChild>
              <div
                className={cn("absolute top-0.5 bottom-0.5 flex items-center overflow-hidden rounded-sm border border-black/40 px-1 text-[9px] font-semibold whitespace-nowrap text-black shadow", s.source === "script" ? "cursor-default opacity-90" : "cursor-grab")}
                style={{ left: s.start * zoom, width: Math.max(4, (s.end - s.start) * zoom), background: LOOKS[s.look].swatch }}
                onPointerDown={onSectionDown(s, "move")}
                title={`${LOOKS[s.look].label} (${s.source === "script" ? `said “${s.cue}”` : s.source === "chat" ? "from the chat" : "dragged"})`}
              >
                {LOOKS[s.look].label}
                {s.source !== "script" && (
                  <>
                    <span className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-black/30" onPointerDown={onSectionDown(s, "left")} />
                    <span className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-black/30" onPointerDown={onSectionDown(s, "right")} />
                  </>
                )}
              </div>
            </PopoverTrigger>
            <PopoverContent className="w-44 space-y-1 p-2" onPointerDown={(e) => e.stopPropagation()}>
              {s.source === "script" ? (
                <p className="text-[11px] text-muted-foreground">Said in the script: “{s.cue}”. Turn script cues off in the Looks panel to ignore it.</p>
              ) : (
                <>
                  {LOOK_IDS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted", s.look === id && "bg-muted")}
                      onClick={() => commit(L.sections.map((x) => (x.id === s.id ? { ...x, look: id } : x)), `${LOOKS[id].label} section`)}
                    >
                      <span className="size-2 rounded-full" style={{ background: LOOKS[id].swatch }} /> {LOOKS[id].label}
                    </button>
                  ))}
                  <button type="button" className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-destructive hover:bg-muted" onClick={() => commit(L.sections.filter((x) => x.id !== s.id), "Delete look section")}>
                    <Trash2 className="size-3" /> Delete
                  </button>
                </>
              )}
            </PopoverContent>
          </Popover>
        ))}
        {draft && (
          <div className="pointer-events-none absolute top-0.5 bottom-0.5 rounded-sm opacity-70 ring-1 ring-white" style={{ left: Math.min(draft.a, draft.b) * zoom, width: Math.abs(draft.b - draft.a) * zoom, background: LOOKS[brush].swatch }} />
        )}
      </div>
    </div>
  );
}
