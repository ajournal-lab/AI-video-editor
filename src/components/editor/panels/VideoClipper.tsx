"use client";

// Manual video clipping: pick in/out points on any library video (filmstrip + player), collect as many segments as
// you like, then place them back to back at the playhead (one undo step). Keys: I = in, O = out, Space = play/pause,
// Enter = add the segment.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListPlus, Pause, Play, Plus, Scissors, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { AssetDTO } from "@/lib/client/upload";
import { clamp } from "@/lib/timeline/derive";
import { addClip } from "@/lib/timeline/ops";
import type { VisualClip } from "@/lib/timeline/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useEditor } from "../store";
import { clipForAsset } from "../dnd";
import { fmtTime } from "./AudioClipper";

const STRIP = 14; // filmstrip frames
const MIN_LEN = 0.2;

export interface Segment {
  in: number;
  out: number;
}

/** Filmstrip thumbnails from a hidden <video> (seek, draw, next). */
function useFilmstrip(url: string, dur: number, open: boolean) {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    if (!open || !dur) return;
    let alive = true;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = url;
    const c = document.createElement("canvas");
    const out: string[] = [];
    const grab = async () => {
      for (let i = 0; i < STRIP && alive; i++) {
        await new Promise<void>((res) => {
          const done = () => {
            v.removeEventListener("seeked", done);
            res();
          };
          v.addEventListener("seeked", done);
          v.currentTime = Math.min(dur - 0.05, ((i + 0.5) / STRIP) * dur);
        });
        const h = 72;
        c.width = Math.max(1, Math.round((v.videoWidth / Math.max(1, v.videoHeight)) * h));
        c.height = h;
        c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
        out.push(c.toDataURL("image/jpeg", 0.6));
        if (alive) setFrames([...out]);
      }
    };
    v.addEventListener("loadeddata", () => grab().catch(() => {}), { once: true });
    return () => {
      alive = false;
      v.removeAttribute("src");
      v.load();
    };
  }, [url, dur, open]);
  return frames;
}

export function VideoClipper({ asset, open, onOpenChange }: { asset: AssetDTO; open: boolean; onOpenChange: (v: boolean) => void }) {
  const dur = asset.duration ?? 0;
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sel, setSel] = useState<Segment>(() => ({ in: 0, out: Math.min(dur, 5) }));
  const [segments, setSegments] = useState<Segment[]>([]);
  const frames = useFilmstrip(asset.url, dur, open);
  const selRef = useRef(sel);
  selRef.current = sel;
  const stopAt = useRef<number | null>(null);

  const seek = useCallback((s: number) => {
    const v = videoRef.current;
    const x = clamp(s, 0, Math.max(0, dur - 0.02));
    if (v) v.currentTime = x;
    setT(x);
  }, [dur]);

  // the new point wins; the other end moves out of the way (3 s away) when it would cross it
  const setIn = useCallback(() => setSel((s) => ({ in: Math.min(t, Math.max(0, dur - MIN_LEN)), out: s.out > t + MIN_LEN ? s.out : Math.min(dur, t + 3) })), [t, dur]);
  const setOut = useCallback(() => setSel((s) => ({ in: s.in < t - MIN_LEN ? s.in : Math.max(0, t - 3), out: Math.max(t, MIN_LEN) })), [t]);
  const playSel = () => {
    const v = videoRef.current;
    if (!v) return;
    stopAt.current = selRef.current.out;
    v.currentTime = selRef.current.in;
    v.play().catch(() => {});
  };
  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      stopAt.current = null;
      v.play().catch(() => {});
    } else v.pause();
  };
  const addSegment = useCallback(() => {
    const s = selRef.current;
    if (s.out - s.in < MIN_LEN) return;
    setSegments((list) => [...list, { ...s }].sort((a, b) => a.in - b.in));
    // the next selection starts where this one ended
    setSel({ in: s.out, out: Math.min(dur, s.out + (s.out - s.in)) });
    seek(s.out);
  }, [dur, seek]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (k === "i") setIn();
      else if (k === "o") setOut();
      else if (k === " ") (e.preventDefault(), toggle());
      else if (k === "enter") (e.preventDefault(), addSegment());
      else return;
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setIn, setOut, addSegment]);

  // drag a handle or the bar (seek)
  const drag = (what: "in" | "out" | "seek") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const bar = barRef.current!.getBoundingClientRect();
    const at = (x: number) => clamp(((x - bar.left) / bar.width) * dur, 0, dur);
    const apply = (x: number) => {
      const v = at(x);
      if (what === "seek") seek(v);
      else if (what === "in") setSel((s) => ({ ...s, in: Math.min(v, s.out - MIN_LEN) }));
      else setSel((s) => ({ ...s, out: Math.max(v, s.in + MIN_LEN) }));
      if (what !== "seek") seek(v);
    };
    apply(e.clientX);
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const place = () => {
    const list = segments.length ? segments : [sel];
    const s = useEditor.getState();
    let tl = s.timeline;
    let at = s.playhead;
    const ids: string[] = [];
    for (const seg of list) {
      const { clip, kind } = clipForAsset(asset, at);
      const c = { ...(clip as VisualClip), in: Math.round(seg.in * 1000) / 1000, duration: Math.round((seg.out - seg.in) * 1000) / 1000, name: `${asset.name} (${fmtTime(seg.in)}–${fmtTime(seg.out)})` };
      tl = addClip(tl, null, c, kind);
      ids.push(c.id);
      at += c.duration;
    }
    s.commit(tl, `Add ${list.length} clip${list.length > 1 ? "s" : ""} from ${asset.name}`);
    s.select(ids);
    toast.success(`Placed ${list.length} clip${list.length > 1 ? "s" : ""} (${list.reduce((n, g) => n + g.out - g.in, 0).toFixed(1)}s) at ${fmtTime(s.playhead)}`);
    setSegments([]);
    onOpenChange(false);
  };

  const pct = (x: number) => `${(x / Math.max(dur, 1e-3)) * 100}%`;
  const total = useMemo(() => segments.reduce((n, g) => n + g.out - g.in, 0), [segments]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">{asset.name}</DialogTitle>
          <DialogDescription>
            Set the in and out points (I / O), add as many segments as you like (Enter), then place them on the timeline. {fmtTime(dur)} long.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-center rounded-md bg-black">
          <video
            ref={videoRef}
            src={asset.url}
            playsInline
            className="max-h-[42vh]"
            onTimeUpdate={(e) => {
              const v = e.currentTarget;
              setT(v.currentTime);
              if (stopAt.current !== null && v.currentTime >= stopAt.current) {
                v.pause();
                stopAt.current = null;
              }
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          />
        </div>
        <div ref={barRef} className="relative h-16 cursor-pointer overflow-hidden rounded-md bg-muted select-none" onPointerDown={drag("seek")}>
          <div className="absolute inset-0 flex">
            {frames.map((f, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={f} alt="" className="h-full min-w-0 flex-1 object-cover opacity-80" draggable={false} />
            ))}
          </div>
          {segments.map((g, i) => (
            <div key={i} className="pointer-events-none absolute inset-y-0 border-x border-emerald-300 bg-emerald-400/30" style={{ left: pct(g.in), width: pct(g.out - g.in) }} title={`Segment ${i + 1}`} />
          ))}
          <div className="pointer-events-none absolute inset-y-0 bg-violet-500/35 ring-2 ring-violet-400 ring-inset" style={{ left: pct(sel.in), width: pct(sel.out - sel.in) }} />
          <div className="absolute inset-y-0 w-2 -translate-x-1 cursor-ew-resize bg-violet-400" style={{ left: pct(sel.in) }} onPointerDown={drag("in")} title="In point (I)" />
          <div className="absolute inset-y-0 w-2 -translate-x-1 cursor-ew-resize bg-violet-400" style={{ left: pct(sel.out) }} onPointerDown={drag("out")} title="Out point (O)" />
          <div className="pointer-events-none absolute inset-y-0 w-px bg-red-500" style={{ left: pct(t) }} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button size="sm" variant="secondary" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause /> : <Play />}
          </Button>
          <span className="w-24 font-mono tabular-nums">{fmtTime(t)}</span>
          <Button size="sm" variant="secondary" onClick={setIn}>
            In (I)
          </Button>
          <Button size="sm" variant="secondary" onClick={setOut}>
            Out (O)
          </Button>
          <span className="font-mono tabular-nums text-muted-foreground">
            {fmtTime(sel.in)} → {fmtTime(sel.out)} · {(sel.out - sel.in).toFixed(2)}s
          </span>
          <Button size="sm" variant="ghost" onClick={playSel}>
            <Play /> Play selection
          </Button>
          <Button size="sm" className="ml-auto" onClick={addSegment} disabled={sel.out - sel.in < MIN_LEN}>
            <ListPlus /> Add segment (Enter)
          </Button>
        </div>
        {segments.length > 0 && (
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {segments.map((g, i) => (
              <div key={i} className={cn("flex items-center gap-2 rounded border px-2 py-1 text-xs")}>
                <Scissors className="size-3 text-emerald-400" />
                <button type="button" className="font-mono tabular-nums hover:underline" onClick={() => (setSel(g), seek(g.in))}>
                  {i + 1}. {fmtTime(g.in)} → {fmtTime(g.out)} ({(g.out - g.in).toFixed(1)}s)
                </button>
                <button type="button" className="ml-auto text-muted-foreground hover:text-destructive" aria-label={`Remove segment ${i + 1}`} onClick={() => setSegments((l) => l.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">{segments.length ? `${segments.length} segments · ${total.toFixed(1)}s, placed back to back` : "No segments yet: places the current selection"}</span>
          <Button onClick={place}>
            <Plus /> Place at playhead
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
