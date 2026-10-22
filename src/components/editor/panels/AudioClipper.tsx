"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, Magnet, Pause, Play, Plus, Repeat, ShieldAlert, ShieldCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import type { AssetDTO, LinkAudioAnalysis } from "@/lib/client/upload";
import { clamp, SFX_MAX_SECONDS } from "@/lib/timeline/derive";
import { newAudioClip } from "@/lib/timeline/factory";
import { addClip } from "@/lib/timeline/ops";
import type { AudioClip } from "@/lib/timeline/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { loadPeaks } from "../timeline/peaks";
import { useEditor } from "../store";
import { NumberField } from "./fields";

// Clip a section out of a link-sourced (or any) music asset: waveform with the beat grid and detected drop,
// drag the start/end handles (snap to beat), play/loop the selection with its fades, then "Use this clip"
// puts exactly that section on the music track and records the link + start/end on the clip.

const H = 150;
const HANDLE_PX = 7;
export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

export function linkInfo(a: AssetDTO | undefined) {
  const m = a?.meta;
  return m?.link ? { link: m.link, rights: !!m.rights, analysis: m.analysis ?? null } : null;
}

function defaultSelection(an: LinkAudioAnalysis | null, dur: number) {
  // around the strongest drop: 4 beats before it, ~8 s total; else the first 15 s
  const drop = an?.drops[0]?.t;
  const bp = an?.beatPeriod ?? 0.5;
  if (drop != null) {
    const start = clamp(drop - 4 * bp, 0, Math.max(0, dur - 1));
    return { start, end: clamp(start + Math.max(8, 16 * bp), start + 0.5, dur) };
  }
  return { start: 0, end: Math.min(dur, 15) };
}

export function AudioClipper({ asset, open, onOpenChange, onAssetChange }: { asset: AssetDTO; open: boolean; onOpenChange: (v: boolean) => void; onAssetChange: (a: AssetDTO) => void }) {
  const info = linkInfo(asset);
  // beat grid + drop: link imports have it already; uploaded tracks are analysed the first time they're clipped
  const an = (info?.analysis ?? (asset.meta?.analysis as LinkAudioAnalysis | undefined) ?? null) as LinkAudioAnalysis | null;
  const dur = an?.duration ?? asset.duration ?? 0;
  const [sel, setSel] = useState(() => defaultSelection(an, dur));
  const [analysing, setAnalysing] = useState(false);
  const short = (asset.duration ?? Infinity) <= SFX_MAX_SECONDS;
  useEffect(() => {
    if (!open || an || short) return;
    let alive = true;
    setAnalysing(true);
    api<{ asset: AssetDTO; analysis: LinkAudioAnalysis }>(`/api/media/${asset.id}/beats`, { method: "POST" })
      .then((r) => {
        if (!alive) return;
        onAssetChange(r.asset);
        setSel(defaultSelection(r.analysis, r.analysis.duration || dur));
      })
      .catch(() => {}) // no beat (speech, ambience): the clipper still works without the grid
      .finally(() => alive && setAnalysing(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset.id]);
  const [snapOn, setSnapOn] = useState(true);
  const [loop, setLoop] = useState(true);
  const [fadeIn, setFadeIn] = useState(0.05);
  const [fadeOut, setFadeOut] = useState(0.5);
  const [zoom, setZoom] = useState(1);
  const [peaks, setPeaks] = useState<{ peaks: number[]; perSec: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [head, setHead] = useState<number | null>(null);
  const [savingRights, setSavingRights] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [width, setWidth] = useState(800);
  const selRef = useRef(sel);
  selRef.current = sel;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    loadPeaks(asset.url).then((p) => alive && setPeaks(p));
    return () => {
      alive = false;
    };
  }, [open, asset.url]);

  useEffect(() => {
    if (!open || !wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [open]);

  const W = Math.max(200, Math.round(width * zoom));
  const x2t = useCallback((x: number) => clamp((x / W) * dur, 0, dur), [W, dur]);
  const t2x = useCallback((t: number) => (t / Math.max(dur, 1e-3)) * W, [W, dur]);

  const snapPts = useMemo(() => [...(an?.beats ?? []), ...(an?.drops.map((d) => d.t) ?? [])].sort((a, b) => a - b), [an]);
  const snap = useCallback(
    (t: number) => {
      if (!snapOn || !snapPts.length) return t;
      let best = snapPts[0];
      for (const p of snapPts) if (Math.abs(p - t) < Math.abs(best - t)) best = p;
      return best;
    },
    [snapOn, snapPts],
  );

  // ---------------------------------------------------------------- drawing
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !open) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = `${W}px`;
    cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const mid = H / 2 + 8;
    // selection
    const sx = t2x(sel.start);
    const ex = t2x(sel.end);
    ctx.fillStyle = "rgba(124,58,237,0.18)";
    ctx.fillRect(sx, 0, ex - sx, H);
    // beats (every 4th brighter = bar), drops
    if (an) {
      an.beats.forEach((b, i) => {
        const x = t2x(b);
        ctx.fillStyle = i % 4 === 0 ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.1)";
        ctx.fillRect(Math.round(x), 16, 1, H - 16);
      });
    }
    // waveform (mirrored bars)
    if (peaks) {
      const n = peaks.peaks.length;
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor((x / W) * n);
        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / W) * n));
        let m = 0;
        for (let i = i0; i < i1 && i < n; i++) m = Math.max(m, peaks.peaks[i]);
        const t = x2t(x);
        const inSel = t >= sel.start && t <= sel.end;
        const h = Math.max(1, m * (H / 2 - 14));
        ctx.fillStyle = inSel ? "#c4b5fd" : "rgba(255,255,255,0.45)";
        ctx.fillRect(x, mid - h, 1, h * 2);
      }
    }
    if (an) {
      an.drops.slice(0, 3).forEach((d, i) => {
        const x = t2x(d.t);
        ctx.fillStyle = i === 0 ? "#f43f5e" : "rgba(244,63,94,0.5)";
        ctx.fillRect(Math.round(x) - 1, 0, 2, H);
        ctx.font = "10px ui-sans-serif, system-ui";
        ctx.fillText(i === 0 ? "DROP" : "drop?", x + 4, 11);
      });
    }
    // handles
    for (const x of [sx, ex]) {
      ctx.fillStyle = "#a78bfa";
      ctx.fillRect(x - 1.5, 0, 3, H);
      ctx.fillRect(x - 5, mid - 14, 10, 28);
    }
    if (head != null) {
      ctx.fillStyle = "#fde047";
      ctx.fillRect(t2x(head) - 0.5, 0, 1.5, H);
    }
  }, [open, W, peaks, an, sel, head, t2x, x2t]);

  // ---------------------------------------------------------------- dragging
  const drag = useRef<{ kind: "start" | "end" | "move" | "new"; t0: number; s0: typeof sel } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const t = x2t(x);
    const sx = t2x(sel.start);
    const ex = t2x(sel.end);
    let kind: "start" | "end" | "move" | "new" = "new";
    if (Math.abs(x - sx) <= HANDLE_PX) kind = "start";
    else if (Math.abs(x - ex) <= HANDLE_PX) kind = "end";
    else if (x > sx && x < ex && e.altKey) kind = "move";
    else if (x > sx && x < ex) {
      // click inside: just move the playhead there
      seek(t);
      return;
    }
    drag.current = { kind, t0: t, s0: sel };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (kind === "new") setSel({ start: snap(t), end: Math.min(dur, snap(t) + 0.5) });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (!d) {
      const sx = t2x(sel.start);
      const ex = t2x(sel.end);
      e.currentTarget.style.cursor = Math.abs(x - sx) <= HANDLE_PX || Math.abs(x - ex) <= HANDLE_PX ? "ew-resize" : "crosshair";
      return;
    }
    const t = snap(x2t(x));
    if (d.kind === "start") setSel((s) => ({ start: Math.min(t, s.end - 0.2), end: s.end }));
    else if (d.kind === "end") setSel((s) => ({ start: s.start, end: Math.max(t, s.start + 0.2) }));
    else if (d.kind === "move") {
      const len = d.s0.end - d.s0.start;
      const st = clamp(snap(d.s0.start + (x2t(x) - d.t0)), 0, dur - len);
      setSel({ start: st, end: st + len });
    } else {
      const a = snap(d.t0);
      setSel(t >= a ? { start: a, end: Math.max(t, a + 0.2) } : { start: t, end: a });
    }
  };
  const onUp = () => {
    drag.current = null;
  };

  // ---------------------------------------------------------------- playback (selection, with fades)
  const raf = useRef(0);
  const stop = useCallback(() => {
    audioRef.current?.pause();
    cancelAnimationFrame(raf.current);
    setPlaying(false);
  }, []);
  const tick = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    const { start, end } = selRef.current;
    const t = a.currentTime;
    if (t >= end || t < start - 0.05) {
      if (loop && t >= end) a.currentTime = start;
      else if (t >= end) return stop();
    }
    const fi = Math.max(1e-3, fadeIn);
    const fo = Math.max(1e-3, fadeOut);
    a.volume = clamp(Math.min(fadeIn > 0 ? (t - start) / fi : 1, fadeOut > 0 ? (end - t) / fo : 1), 0, 1);
    setHead(a.currentTime);
    raf.current = requestAnimationFrame(tick);
  }, [loop, fadeIn, fadeOut, stop]);
  const play = useCallback(
    (from?: number) => {
      let a = audioRef.current;
      if (!a) {
        a = new Audio(asset.url);
        a.preload = "auto";
        audioRef.current = a;
      }
      a.currentTime = from ?? selRef.current.start;
      a.play()
        .then(() => {
          setPlaying(true);
          cancelAnimationFrame(raf.current);
          raf.current = requestAnimationFrame(tick);
        })
        .catch((e) => toast.error(`Can't play: ${e.message}`));
    },
    [asset.url, tick],
  );
  const seek = (t: number) => {
    setHead(t);
    if (playing) play(t);
  };
  useEffect(() => {
    if (!playing) return;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  }, [tick, playing]);
  useEffect(() => {
    if (!open) stop();
    return () => cancelAnimationFrame(raf.current);
  }, [open, stop]);
  useEffect(() => () => audioRef.current?.pause(), []);

  // keep the selection in view when zoomed
  useEffect(() => {
    const el = wrapRef.current;
    if (el && zoom > 1) el.scrollLeft = Math.max(0, t2x(sel.start) - el.clientWidth * 0.15);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  const len = sel.end - sel.start;
  const beatsIn = an ? an.beats.filter((b) => b >= sel.start - 1e-3 && b <= sel.end + 1e-3).length : 0;

  const setRights = async (v: boolean) => {
    setSavingRights(true);
    try {
      const { asset: a } = await api<{ asset: AssetDTO }>(`/api/media/${asset.id}`, { method: "PATCH", json: { rights: v } });
      onAssetChange(a);
      toast.success(v ? "Marked: you have the rights to this audio" : "Marked: timing only / personal use");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingRights(false);
    }
  };

  const use = () => {
    const s = useEditor.getState();
    const hasVoice = s.timeline.tracks.some((t) => t.kind === "voice" && t.clips.length > 0);
    const clip: AudioClip = newAudioClip({
      src: asset.url,
      assetId: asset.id,
      name: `${asset.name} (${fmtTime(sel.start)}–${fmtTime(sel.end)})`,
      start: 0,
      in: Math.round(sel.start * 1000) / 1000,
      duration: Math.round(len * 1000) / 1000,
      srcDuration: dur,
      volume: short ? 0.6 : hasVoice ? 0.5 : 1,
      duck: short ? false : hasVoice,
      sfx: short || undefined, // a short sound is a sound effect (audio safety: never ducked, kept under the voice)
      fadeIn: Math.min(fadeIn, len / 2),
      fadeOut: Math.min(fadeOut, len / 2),
      link: info ? { url: info.link.url, kind: info.link.kind, start: Math.round(sel.start * 1000) / 1000, end: Math.round(sel.end * 1000) / 1000 } : null,
    });
    s.commit(addClip(s.timeline, null, clip, "music"), "Add music clip");
    s.select([clip.id]);
    stop();
    onOpenChange(false);
    toast.success(`Added ${len.toFixed(1)}s of “${asset.name}” to the music track`, {
      description: info ? `Sound starts at ${fmtTime(sel.start)} (${sel.start.toFixed(1)}s): use the same start in Instagram.` : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
            <span className="truncate">{asset.name}</span>
            {info &&
              (info.rights ? (
                <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-300">
                  <ShieldCheck className="size-3" /> Rights confirmed
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 border-amber-500/40 text-amber-300">
                  <ShieldAlert className="size-3" /> Timing only / personal use
                </Badge>
              ))}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{fmtTime(dur)}</span>
            {an?.tempo ? <span>{an.tempo.toFixed(0)} BPM</span> : null}
            {an?.drops[0] ? <span>drop at {fmtTime(an.drops[0].t)}</span> : null}
            {an?.lufs != null ? <span>{an.lufs.toFixed(1)} LUFS</span> : null}
            {an?.truePeak != null ? (
              <span className={cn(an.truePeak > -1 && "text-amber-300")} title="Peaks above -1 dBTP are fixed by the true-peak limiter on export">
                peak {an.truePeak.toFixed(1)} dBTP{an.truePeak > -1 ? " (clips: limited on export)" : ""}
              </span>
            ) : null}
            {info && (
              <a href={info.link.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                {info.link.kind === "instagram" ? "Instagram reel" : info.link.kind === "youtube" ? "YouTube" : "Source"} <ExternalLink className="size-3" />
              </a>
            )}
          </DialogDescription>
        </DialogHeader>

        <div ref={wrapRef} className="overflow-x-auto rounded-lg border bg-black/40">
          {peaks === null ? (
            <div className="flex h-[150px] items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Reading the waveform…
            </div>
          ) : (
            <canvas ref={canvasRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} className="block touch-none" aria-label="Waveform: drag the handles to pick the section" />
          )}
        </div>
        <p className="-mt-2 text-[11px] text-muted-foreground">Drag the purple handles, or drag on the waveform for a new selection. Alt + drag inside moves it. Click inside to play from there. Light lines are beats (brighter = bar), red is the drop.</p>

        <div className="grid gap-4 sm:grid-cols-[1.2fr_1fr]">
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <NumberField label="Start" value={Math.round(sel.start * 100) / 100} min={0} suffix="s" onCommit={(v) => setSel((s) => ({ start: clamp(v, 0, s.end - 0.2), end: s.end }))} />
              <NumberField label="End" value={Math.round(sel.end * 100) / 100} min={0} suffix="s" onCommit={(v) => setSel((s) => ({ start: s.start, end: clamp(v, s.start + 0.2, dur) }))} />
              <div className="flex flex-col justify-end pb-1 text-[11px] text-muted-foreground">
                {len.toFixed(2)}s{an ? ` · ${beatsIn} beats` : analysing ? " · finding the beat…" : ""}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" onClick={() => (playing ? stop() : play())}>
                {playing ? <Pause /> : <Play />} {playing ? "Stop" : "Play selection"}
              </Button>
              <Button size="sm" variant={loop ? "secondary" : "ghost"} onClick={() => setLoop((v) => !v)} aria-pressed={loop}>
                <Repeat /> Loop
              </Button>
              <Button size="sm" variant={snapOn ? "secondary" : "ghost"} onClick={() => setSnapOn((v) => !v)} aria-pressed={snapOn} disabled={!snapPts.length} title="Snap the handles to beats and the drop">
                <Magnet /> Snap to beat
              </Button>
              {an?.drops[0] && (
                <Button size="sm" variant="ghost" onClick={() => setSel(defaultSelection(an, dur))} title="4 beats before the drop, about 8 seconds">
                  <Zap /> Around the drop
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="w-12 text-xs text-muted-foreground">Zoom</span>
              <Slider value={[zoom]} min={1} max={10} step={0.5} onValueChange={(v) => setZoom(v[0])} className="flex-1" aria-label="Zoom" />
              <span className="w-8 text-right text-xs text-muted-foreground">{zoom}×</span>
            </div>
          </div>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Fade in</span>
                <span>{fadeIn.toFixed(2)}s</span>
              </div>
              <Slider value={[fadeIn]} min={0} max={Math.min(3, len / 2)} step={0.05} onValueChange={(v) => setFadeIn(v[0])} aria-label="Fade in" />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Fade out</span>
                <span>{fadeOut.toFixed(2)}s</span>
              </div>
              <Slider value={[fadeOut]} min={0} max={Math.min(3, len / 2)} step={0.05} onValueChange={(v) => setFadeOut(v[0])} aria-label="Fade out" />
            </div>
            {info && (
              <label className="flex items-start justify-between gap-3 rounded-lg border p-2 text-xs">
                <span>
                  I have the rights to use this audio
                  <span className="block text-muted-foreground">Unticked, it&apos;s for timing only / personal use, and exports that include it ask first. Usually you add the sound in Instagram instead.</span>
                </span>
                <Switch checked={info.rights} disabled={savingRights} onCheckedChange={setRights} />
              </label>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <span className="text-xs text-muted-foreground">
            In Instagram, start the sound at <strong className="text-foreground">{fmtTime(sel.start)}</strong> ({sel.start.toFixed(1)}s)
          </span>
          <Button onClick={use} disabled={len < 0.2}>
            <Plus /> Use this clip
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
