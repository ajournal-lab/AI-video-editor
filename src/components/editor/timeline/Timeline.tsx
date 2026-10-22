"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Captions,
  ClipboardCopy,
  Copy,
  Eye,
  EyeOff,
  Film,
  Lock,
  Magnet,
  Mic,
  Music,
  Plus,
  Scissors,
  Trash2,
  Type,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  X,
  Maximize2,
  ArrowLeftToLine,
} from "lucide-react";
import { clipEnd, keyframeGain, timelineDuration } from "@/lib/timeline/derive";
import { addTrack, duplicateClip, deleteClips, moveClip, removeTrack, rippleDelete, snap, snapPoints, splitAt, trimClip, updateTrack } from "@/lib/timeline/ops";
import type { AnyClip, AudioClip, TextClip, Timeline as TL, Track, TrackKind, VisualClip } from "@/lib/timeline/types";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useEditor } from "../store";
import { formatTime } from "../format";
import { cachedCaptionLines } from "../preview/draw";
import { loadPeaks } from "./peaks";
import { LooksLane } from "./LooksLane";
import { DRAG_MIME, uploadAndAdd, useDropHandler, type DragPayload } from "../dnd";
import { copyScenePrompt, dropImageAt, dropImageOnScene, droppedImages, hasDroppableImage } from "../quickimport";

const HEADER_W = 132;
const RULER_H = 24;
const ROW_H: Record<TrackKind, number> = { video: 58, voice: 50, music: 42, text: 34, captions: 30 };
const ICON: Record<TrackKind, typeof Film> = { video: Film, voice: Mic, music: Music, text: Type, captions: Captions };

export function Timeline() {
  const timeline = useEditor((s) => s.timeline);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const scrollRef = useRef<HTMLDivElement>(null);
  const duration = timelineDuration(timeline);
  const contentW = Math.max((duration + 10) * zoom, 800);
  const selected = useMemo(() => new Set(selection), [selection]);
  const onDrop = useDropHandler();

  const fit = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const d = timelineDuration(useEditor.getState().timeline) || 10;
    useEditor.getState().setZoom((el.clientWidth - HEADER_W - 40) / d);
    el.scrollLeft = 0;
  }, []);

  // Fit once on mount.
  useEffect(() => {
    fit();
  }, [fit]);

  // Ctrl/Cmd + wheel zooms around the cursor.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const s = useEditor.getState();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - HEADER_W + el.scrollLeft;
      const tAt = x / s.zoom;
      const nz = Math.min(800, Math.max(4, s.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
      s.setZoom(nz);
      el.scrollLeft = tAt * nz - (e.clientX - rect.left - HEADER_W);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the playhead in view while playing.
  useEffect(
    () =>
      useEditor.subscribe((s) => {
        const el = scrollRef.current;
        if (!el || !s.playing) return;
        const x = s.playhead * s.zoom;
        const view = el.clientWidth - HEADER_W;
        if (x < el.scrollLeft || x > el.scrollLeft + view - 40) el.scrollLeft = Math.max(0, x - 40);
      }),
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950/60">
      <Toolbar fit={fit} />
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto select-none">
        <div className="relative" style={{ width: HEADER_W + contentW }}>
          <div className="sticky top-0 z-30 flex" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-b bg-zinc-950" style={{ width: HEADER_W }} />
            <Ruler width={contentW} zoom={zoom} />
          </div>
          <LooksLane zoom={zoom} headerW={HEADER_W} />
          {timeline.tracks.map((track) => (
            <TrackRow key={track.id} track={track} zoom={zoom} selected={selected} onDrop={onDrop} timeline={timeline} />
          ))}
          <AddTrackRow />
          <Playhead />
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toolbar

function Toolbar({ fit }: { fit: () => void }) {
  const zoom = useEditor((s) => s.zoom);
  const snapping = useEditor((s) => s.snapping);
  const hasSel = useEditor((s) => s.selection.length > 0);
  const s = useEditor.getState;
  const act = (fn: () => void) => () => fn();
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
      <Tip label="Split at playhead (S)">
        <Button variant="ghost" size="icon" onClick={act(() => splitSelected())}>
          <Scissors />
        </Button>
      </Tip>
      <Tip label="Duplicate (Ctrl/⌘ D)">
        <Button variant="ghost" size="icon" disabled={!hasSel} onClick={act(() => duplicateSelected())}>
          <Copy />
        </Button>
      </Tip>
      <Tip label="Delete (Del)">
        <Button variant="ghost" size="icon" disabled={!hasSel} onClick={act(() => deleteSelected(false))}>
          <Trash2 />
        </Button>
      </Tip>
      <Tip label="Ripple delete (Shift+Del) — closes the gap; on the voice track it cuts that time from the whole video">
        <Button variant="ghost" size="icon" disabled={!hasSel} onClick={act(() => deleteSelected(true))}>
          <ArrowLeftToLine />
        </Button>
      </Tip>
      <div className="mx-1 h-5 w-px bg-border" />
      <Tip label={snapping ? "Snapping on (clips, playhead, words)" : "Snapping off"}>
        <Button variant="ghost" size="icon" className={cn(snapping && "text-primary")} onClick={() => s().toggleSnapping()}>
          <Magnet />
        </Button>
      </Tip>
      <div className="ml-auto flex items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={() => s().setZoom(zoom / 1.4)}>
          <ZoomOut />
        </Button>
        <Slider className="w-28" min={0} max={100} step={1} value={[zoomToSlider(zoom)]} onValueChange={([v]) => s().setZoom(sliderToZoom(v))} />
        <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={() => s().setZoom(zoom * 1.4)}>
          <ZoomIn />
        </Button>
        <Tip label="Fit timeline">
          <Button variant="ghost" size="icon" onClick={fit}>
            <Maximize2 />
          </Button>
        </Tip>
      </div>
    </div>
  );
}

const zoomToSlider = (z: number) => (Math.log(z / 4) / Math.log(200)) * 100;
const sliderToZoom = (v: number) => 4 * Math.pow(200, v / 100);

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-64">{label}</TooltipContent>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ editing helpers (also used by shortcuts)

export function splitSelected() {
  const s = useEditor.getState();
  const next = splitAt(s.timeline, s.playhead, s.selection.length ? s.selection : undefined);
  if (next === s.timeline || JSON.stringify(next) === JSON.stringify(s.timeline)) return;
  s.commit(next, "Split");
}

export function deleteSelected(ripple: boolean) {
  const s = useEditor.getState();
  if (!s.selection.length) return;
  let tl = s.timeline;
  if (ripple) for (const id of s.selection) tl = rippleDelete(tl, id);
  else tl = deleteClips(tl, s.selection);
  s.commit(tl, ripple ? "Ripple delete" : "Delete");
  s.select([]);
}

export function duplicateSelected() {
  const s = useEditor.getState();
  let tl = s.timeline;
  const ids: string[] = [];
  for (const id of s.selection) {
    const r = duplicateClip(tl, id);
    tl = r.timeline;
    if (r.newId) ids.push(r.newId);
  }
  s.commit(tl, "Duplicate");
  s.select(ids);
}

// ------------------------------------------------------------------ ruler & playhead

function Ruler({ width, zoom }: { width: number; zoom: number }) {
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((st) => st * zoom >= 64) ?? 300;
  const ticks = [];
  for (let t = 0; t * zoom < width; t += step) ticks.push(t);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const setAt = (x: number) => useEditor.getState().setPlayhead(Math.max(0, (x - rect.left) / zoom));
    setAt(e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setAt(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="relative cursor-ew-resize border-b bg-zinc-950" style={{ width }} onPointerDown={onDown}>
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 h-full border-l border-white/15 pl-1 text-[10px] text-muted-foreground" style={{ left: t * zoom }}>
          {formatTime(t)}
        </div>
      ))}
    </div>
  );
}

function Playhead() {
  const x = useEditor((s) => s.playhead * s.zoom);
  return (
    <div className="pointer-events-none absolute top-0 bottom-0 z-40" style={{ left: HEADER_W + x }}>
      <div className="absolute -left-[5px] top-0 h-3 w-[11px] rounded-b-sm bg-red-500" />
      <div className="h-full w-px bg-red-500" />
    </div>
  );
}

// ------------------------------------------------------------------ tracks

function TrackRow({
  track,
  zoom,
  selected,
  onDrop,
  timeline,
}: {
  track: Track;
  zoom: number;
  selected: Set<string>;
  onDrop: (p: DragPayload, trackId: string | null, time: number) => void;
  timeline: TL;
}) {
  const [over, setOver] = useState(false);
  const Icon = ICON[track.kind];
  const h = ROW_H[track.kind];
  const s = useEditor.getState;
  const toggle = (patch: Partial<Pick<Track, "muted" | "hidden" | "locked">>) => s().commit(updateTrack(s().timeline, track.id, patch), "Track");
  const canRemove = track.kind !== "captions" && (track.clips.length === 0 || timeline.tracks.filter((t) => t.kind === track.kind).length > 1);

  const onLaneDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const rect = e.currentTarget.getBoundingClientRect();
    s().select([]);
    s().setPlayhead((e.clientX - rect.left) / zoom);
  };

  return (
    <div className="group/track flex border-b border-white/5" style={{ height: h }}>
      <div className="sticky left-0 z-20 flex shrink-0 items-center gap-1 border-r bg-zinc-950 px-2" style={{ width: HEADER_W }}>
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs">{track.name}</span>
        {(track.kind === "voice" || track.kind === "music" || track.kind === "video") && (
          <HeaderBtn label={track.muted ? "Unmute" : "Mute"} onClick={() => toggle({ muted: !track.muted })} active={track.muted}>
            {track.muted ? <VolumeX /> : <Volume2 />}
          </HeaderBtn>
        )}
        {(track.kind === "video" || track.kind === "text" || track.kind === "captions") && (
          <HeaderBtn label={track.hidden ? "Show" : "Hide"} onClick={() => toggle({ hidden: !track.hidden })} active={track.hidden}>
            {track.hidden ? <EyeOff /> : <Eye />}
          </HeaderBtn>
        )}
        {track.kind !== "captions" && (
          <HeaderBtn label={track.locked ? "Unlock" : "Lock"} onClick={() => toggle({ locked: !track.locked })} active={track.locked}>
            {track.locked ? <Lock /> : <Unlock />}
          </HeaderBtn>
        )}
        {canRemove && track.clips.length === 0 && (
          <HeaderBtn label="Remove track" onClick={() => s().commit(removeTrack(s().timeline, track.id), "Remove track")}>
            <X />
          </HeaderBtn>
        )}
      </div>
      <div
        data-track-id={track.id}
        data-track-kind={track.kind}
        className={cn("relative flex-1", over && "bg-primary/10", track.hidden && "opacity-50", track.locked && "bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,rgba(255,255,255,0.03)_6px,rgba(255,255,255,0.03)_12px)]")}
        onPointerDown={onLaneDown}
        onDragOver={(e) => {
          const types = e.dataTransfer.types;
          if ((!types.includes(DRAG_MIME) && !hasDroppableImage(e.dataTransfer)) || track.kind === "captions") return;
          e.preventDefault();
          e.stopPropagation();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const rect = e.currentTarget.getBoundingClientRect();
          const time = Math.max(0, (e.clientX - rect.left) / zoom);
          const raw = e.dataTransfer.getData(DRAG_MIME);
          if (!raw) {
            const dropped = droppedImages(e.dataTransfer);
            e.preventDefault();
            e.stopPropagation();
            // Desktop files (any media) upload as before; images dragged from a web page (e.g. Gemini) are imported.
            if (e.dataTransfer.files.length && !dropped.fromBrowser) uploadAndAdd(e.dataTransfer.files, track.id, time);
            else if (dropped.files.length || dropped.urls.length) dropImageAt(e.dataTransfer, track.id, time);
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          onDrop(JSON.parse(raw) as DragPayload, track.id, time);
        }}
      >
        {track.kind === "captions" ? (
          <CaptionBlocks timeline={timeline} zoom={zoom} hidden={Boolean(track.hidden) || !timeline.captions.enabled} />
        ) : (
          (track.clips as AnyClip[]).map((c) => <ClipView key={c.id} clip={c} track={track} zoom={zoom} selected={selected.has(c.id)} />)
        )}
      </div>
    </div>
  );
}

function HeaderBtn({ label, onClick, children, active }: { label: string; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn("rounded p-0.5 text-muted-foreground hover:bg-white/10 hover:text-foreground [&_svg]:size-3.5", active && "text-amber-400")}
    >
      {children}
    </button>
  );
}

function AddTrackRow() {
  const s = useEditor.getState;
  return (
    <div className="sticky left-0 flex h-9 items-center px-2" style={{ width: HEADER_W }}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground">
            <Plus /> Track
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => s().commit(addTrack(s().timeline, "video"), "Add track")}>
            <Film /> Video / overlay track
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => s().commit(addTrack(s().timeline, "text"), "Add track")}>
            <Type /> Text track
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => s().commit(addTrack(s().timeline, "music"), "Add track")}>
            <Music /> Music track
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => s().commit(addTrack(s().timeline, "voice"), "Add track")}>
            <Mic /> Voice track
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function CaptionBlocks({ timeline, zoom, hidden }: { timeline: TL; zoom: number; hidden: boolean }) {
  const lines = cachedCaptionLines(timeline);
  return (
    <>
      {lines.map((l, i) => (
        <button
          type="button"
          key={i}
          className={cn(
            "absolute top-1 bottom-1 overflow-hidden rounded-sm border border-amber-300/30 bg-amber-400/15 px-1 text-left text-[10px] leading-5 whitespace-nowrap text-amber-100 hover:bg-amber-400/25",
            hidden && "opacity-40",
          )}
          style={{ left: l.start * zoom, width: Math.max(2, (l.end - l.start) * zoom - 1) }}
          title="Edit caption words"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => {
            const s = useEditor.getState();
            s.setPlayhead(l.start);
            s.setPanel("captions");
          }}
        >
          {l.words.map((w) => w.text).join(" ")}
        </button>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ clips

const ClipView = memo(function ClipView({ clip, track, zoom, selected }: { clip: AnyClip; track: Track; zoom: number; selected: boolean }) {
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const [imageOver, setImageOver] = useState(false);
  const isScene = clip.type === "video" || clip.type === "image" || clip.type === "color";
  const left = clip.start * zoom;
  const width = Math.max(4, clip.duration * zoom);

  const onBodyDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = useEditor.getState();
    if (!s.selection.includes(clip.id) || e.shiftKey || e.metaKey || e.ctrlKey) s.select([clip.id], e.shiftKey || e.metaKey || e.ctrlKey);
    if (track.locked) return;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const points = s.snapping ? snapPoints(s.timeline, new Set([clip.id]), s.playhead) : [];
    const thr = 8 / s.zoom;
    let moved = false;
    let result = { start: clip.start, trackId: track.id };
    const laneTop = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().top;

    const move = (ev: PointerEvent) => {
      const dxPx = ev.clientX - x0;
      if (!moved && Math.abs(dxPx) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      moved = true;
      let start = Math.max(0, clip.start + dxPx / s.zoom);
      if (points.length) {
        const a = snap(start, points, thr);
        const b = snap(start + clip.duration, points, thr);
        if (a.snapped && (!b.snapped || Math.abs(a.value - start) <= Math.abs(b.value - start - clip.duration))) start = a.value;
        else if (b.snapped) start = b.value - clip.duration;
      }
      // Which lane is under the pointer?
      let trackId = track.id;
      let dy = 0;
      for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
        const id = (el as HTMLElement).dataset?.trackId;
        const kind = (el as HTMLElement).dataset?.trackKind;
        if (id && kind && compatible(kind as TrackKind, clip)) {
          trackId = id;
          dy = el.getBoundingClientRect().top - laneTop;
          break;
        }
      }
      result = { start, trackId };
      setDrag({ dx: (start - clip.start) * s.zoom, dy });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      if (moved) {
        const st = useEditor.getState();
        st.commit(moveClip(st.timeline, clip.id, result.start, result.trackId), "Move");
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onEdgeDown = (edge: "left" | "right") => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (track.locked) return;
    const s = useEditor.getState();
    s.select([clip.id]);
    s.begin();
    const base = s.timeline;
    const x0 = e.clientX;
    const edgeT = edge === "left" ? clip.start : clipEnd(clip);
    const points = s.snapping ? snapPoints(base, new Set([clip.id]), s.playhead) : [];
    const thr = 8 / s.zoom;
    const move = (ev: PointerEvent) => {
      let t = edgeT + (ev.clientX - x0) / s.zoom;
      if (points.length) t = snap(t, points, thr).value;
      useEditor.getState().live(trimClip(base, clip.id, edge, t));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      useEditor.getState().end("Trim");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={cn(
        "group/clip absolute top-1 bottom-1 overflow-hidden rounded-md border text-[11px] shadow-sm",
        clipColor(clip),
        selected ? "z-10 border-white ring-2 ring-white/70" : "border-black/40",
        drag && "z-50 opacity-80 shadow-xl",
        imageOver && "z-20 ring-2 ring-primary",
        track.locked ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing",
      )}
      style={{ left, width, transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined }}
      onPointerDown={onBodyDown}
      onDoubleClick={() => useEditor.getState().setPlayhead(clip.start)}
      data-scene-clip={isScene ? clip.id : undefined}
      // Drop an image (from the desktop or a Gemini tab) onto a scene to replace its visual.
      onDragOver={(e) => {
        if (!isScene || track.locked || e.dataTransfer.types.includes(DRAG_MIME) || !hasDroppableImage(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        setImageOver(true);
      }}
      onDragLeave={() => setImageOver(false)}
      onDrop={(e) => {
        setImageOver(false);
        if (!isScene || track.locked || e.dataTransfer.types.includes(DRAG_MIME)) return;
        const d = droppedImages(e.dataTransfer);
        if (!d.files.length && !d.urls.length) return;
        e.preventDefault();
        e.stopPropagation();
        dropImageOnScene(e.dataTransfer, clip.id);
      }}
    >
      <ClipBody clip={clip} width={width} zoom={zoom} />
      {isScene && width > 70 && (
        <button
          type="button"
          title="Copy an image prompt for this scene (paste it into Gemini)"
          aria-label="Copy prompt"
          className="absolute top-0.5 right-2.5 z-10 rounded bg-black/60 p-0.5 text-white opacity-0 group-hover/clip:opacity-100 hover:bg-black/80 [&_svg]:size-3"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => copyScenePrompt(clip as VisualClip)}
        >
          <ClipboardCopy />
        </button>
      )}
      {"transition" in clip && clip.transition && clip.transition.type !== "cut" && (
        <div
          className="pointer-events-none absolute top-0 bottom-0 left-0 bg-gradient-to-r from-white/40 to-transparent"
          style={{ width: clip.transition.duration * zoom }}
          title={clip.transition.type}
        />
      )}
      <FadeMarks clip={clip} zoom={zoom} />
      {!track.locked && (
        <>
          <div className="absolute top-0 bottom-0 left-0 w-2 cursor-ew-resize hover:bg-white/40" onPointerDown={onEdgeDown("left")} />
          <div className="absolute top-0 right-0 bottom-0 w-2 cursor-ew-resize hover:bg-white/40" onPointerDown={onEdgeDown("right")} />
        </>
      )}
    </div>
  );
});

const compatible = (kind: TrackKind, clip: AnyClip) =>
  (kind === "video" && (clip.type === "video" || clip.type === "image" || clip.type === "color")) ||
  ((kind === "voice" || kind === "music") && clip.type === "audio") ||
  (kind === "text" && clip.type === "text");

function clipColor(c: AnyClip) {
  switch (c.type) {
    case "video":
      return "bg-sky-900";
    case "image":
      return "bg-indigo-900";
    case "color":
      return "bg-violet-900";
    case "text":
      return "bg-fuchsia-700";
    case "audio":
      return "bg-emerald-900";
  }
}

function FadeMarks({ clip, zoom }: { clip: AnyClip; zoom: number }) {
  if (clip.type === "text") return null;
  const fi = clip.fadeIn * zoom;
  const fo = clip.fadeOut * zoom;
  return (
    <>
      {fi > 1 && <div className="pointer-events-none absolute top-0 bottom-0 left-0 bg-black/45" style={{ width: fi, clipPath: "polygon(0 0, 100% 0, 0 100%)" }} />}
      {fo > 1 && <div className="pointer-events-none absolute top-0 right-0 bottom-0 bg-black/45" style={{ width: fo, clipPath: "polygon(0 0, 100% 0, 100% 100%)" }} />}
    </>
  );
}

function ClipBody({ clip, width, zoom }: { clip: AnyClip; width: number; zoom: number }) {
  if (clip.type === "text") return <TextBody clip={clip} />;
  if (clip.type === "audio") return <AudioBody clip={clip} width={width} zoom={zoom} />;
  return <VisualBody clip={clip} />;
}

function VisualBody({ clip }: { clip: VisualClip }) {
  const bg =
    clip.type === "color"
      ? { backgroundImage: `linear-gradient(135deg, ${clip.colors?.[0] ?? "#111"}, ${clip.colors?.[1] ?? "#555"})` }
      : clip.thumb
        ? { backgroundImage: `url("${clip.thumb}")`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }
        : {};
  return (
    <div className="absolute inset-0" style={bg}>
      <div className="absolute inset-x-0 top-0 flex items-center gap-1 truncate bg-gradient-to-b from-black/70 to-transparent px-2 py-0.5 text-white">
        {clip.scene ? <span className="rounded bg-black/50 px-1 text-[9px]">S{clip.scene}</span> : null}
        <span className="truncate">{clip.name}</span>
        {clip.speed !== 1 && <span className="rounded bg-black/50 px-1 text-[9px]">{clip.speed}×</span>}
      </div>
    </div>
  );
}

function TextBody({ clip }: { clip: TextClip }) {
  return <div className="truncate px-2 leading-7 font-medium text-white">{clip.text.replace(/\n/g, " · ") || "Text"}</div>;
}

function AudioBody({ clip, width, zoom }: { clip: AudioClip; width: number; zoom: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const asset = useEditor((s) => (clip.assetId ? s.assets[clip.assetId] : undefined));
  const [peaks, setPeaks] = useState<{ peaks: number[]; perSec: number } | null>(null);
  useEffect(() => {
    let alive = true;
    loadPeaks(clip.src, asset?.meta).then((p) => alive && setPeaks(p));
    return () => {
      alive = false;
    };
  }, [clip.src, asset?.meta]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !peaks) return;
    const w = Math.min(Math.round(width), 8000);
    const h = c.clientHeight || 30;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(167, 243, 208, 0.75)";
    const pxPerPeak = (zoom / peaks.perSec) * (w / width) / clip.speed;
    const i0 = clip.in * peaks.perSec;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(i0 + x / pxPerPeak);
      const b = Math.max(a + 1, Math.floor(i0 + (x + 1) / pxPerPeak));
      let m = 0;
      for (let i = a; i < b && i < peaks.peaks.length; i++) m = Math.max(m, peaks.peaks[i]);
      const bh = Math.max(1, m * (h - 2));
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [peaks, width, zoom, clip.in, clip.speed]);

  const kf = clip.keyframes?.length ? clip.keyframes : null;
  return (
    <div className="absolute inset-0">
      <canvas ref={canvasRef} className="absolute inset-x-0 top-3 bottom-0 h-[calc(100%-12px)] w-full" />
      <div className="absolute inset-x-0 top-0 truncate px-2 text-[10px] leading-4 text-emerald-100">
        {clip.name}
        {clip.sfx ? " · SFX" : clip.duck ? " · ducked" : ""}
        {clip.muted ? " · muted" : ""}
      </div>
      {kf && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
          <polyline
            fill="none"
            stroke="#fbbf24"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            points={Array.from({ length: 41 }, (_, i) => {
              const tt = (i / 40) * clip.duration;
              const g = Math.min(2, keyframeGain(clip, tt));
              return `${tt * zoom},${100 - g * 45}`;
            }).join(" ")}
          />
        </svg>
      )}
    </div>
  );
}

