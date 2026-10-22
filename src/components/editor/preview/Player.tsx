"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, SkipBack, StepBack, StepForward } from "lucide-react";
import { timelineDuration } from "@/lib/timeline/derive";
import { FONT_IDS, cssFont } from "@/lib/timeline/fonts";
import { Button } from "@/components/ui/button";
import { withInsertSrc } from "@/lib/timeline/inserts";
import type { Timeline } from "@/lib/timeline/types";
import { useEditor } from "../store";
import { useInserts } from "../inserts-store";
import { drawFrame } from "./draw";
import { MediaPool } from "./media-pool";
import { formatTime } from "../format";

/**
 * In-browser composition driven by the timeline JSON. A requestAnimationFrame
 * loop advances the clock while playing, keeps media elements in sync, and draws
 * the frame; while paused it redraws the frame at the playhead.
 */
export function Player() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const aspect = useEditor((s) => s.timeline.width / s.timeline.height);
  const previewing = useEditor((s) => Boolean(s.preview));

  // Fit the canvas into the available area.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      let w = width;
      let h = w / aspect;
      if (h > height) {
        h = height;
        w = h * aspect;
      }
      setBox({ w: Math.floor(w), h: Math.floor(h) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const pool = new MediaPool();
    let raf = 0;
    let clock = { t0: useEditor.getState().playhead, wall0: performance.now() };
    let lastSet = clock.t0;
    let wasPlaying = false;

    // Canvas text needs the fonts loaded or the first frames use a fallback face.
    Promise.all(FONT_IDS.map((f) => document.fonts.load(cssFont(f, 48)))).catch(() => {});

    // built inserts get their src (InsertJob output) without touching the saved timeline
    let memo: { tl: Timeline | null; by: object | null; out: Timeline | null } = { tl: null, by: null, out: null };
    const shown = (tl: Timeline) => {
      const by = useInserts.getState().by;
      if (memo.tl !== tl || memo.by !== by) memo = { tl, by, out: withInsertSrc(tl, by) };
      return memo.out!;
    };

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const s = useEditor.getState();
      const raw = s.preview ?? s.timeline;
      if (!raw) return;
      const tl = shown(raw);
      const dur = timelineDuration(tl);
      let t = s.playhead;
      if (s.playing) {
        if (!wasPlaying || Math.abs(s.playhead - lastSet) > 1e-4) clock = { t0: s.playhead, wall0: performance.now() }; // started or scrubbed
        t = clock.t0 + (performance.now() - clock.wall0) / 1000;
        if (t >= dur) {
          t = dur;
          s.setPlaying(false);
        }
        lastSet = t;
        s.setPlayhead(t);
      } else if (wasPlaying) {
        pool.pauseAll();
      }
      wasPlaying = s.playing && t < dur;
      pool.sync(tl, t, s.playing);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(2, Math.round(canvas.clientWidth * dpr));
      const ch = Math.max(2, Math.round(canvas.clientHeight * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.setTransform(cw / tl.width, 0, 0, ch / tl.height, 0, 0);
      drawFrame(ctx, tl, Math.min(t, Math.max(0, dur - 1e-3)), pool);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      pool.dispose();
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center">
        <canvas
          ref={canvasRef}
          style={{ width: box.w, height: box.h }}
          className="rounded-md bg-black shadow-2xl ring-1 ring-white/10"
          onClick={() => useEditor.getState().setPlaying(!useEditor.getState().playing)}
        />
        {previewing && (
          <div className="pointer-events-none absolute top-2 left-1/2 -translate-x-1/2 rounded-full bg-amber-400 px-3 py-1 text-xs font-semibold text-black shadow">
            Previewing AI edit
          </div>
        )}
      </div>
      <Transport />
    </div>
  );
}

function Transport() {
  const playing = useEditor((s) => s.playing);
  const playhead = useEditor((s) => s.playhead);
  const duration = useEditor((s) => timelineDuration(s.preview ?? s.timeline));
  const { setPlaying, setPlayhead } = useEditor.getState();
  const fps = useEditor((s) => s.timeline.fps);
  return (
    <div className="flex items-center justify-center gap-1 pt-2">
      <Button variant="ghost" size="icon" aria-label="Go to start" onClick={() => setPlayhead(0)}>
        <SkipBack />
      </Button>
      <Button variant="ghost" size="icon" aria-label="Previous frame" onClick={() => setPlayhead(playhead - 1 / fps)}>
        <StepBack />
      </Button>
      <Button size="icon" className="rounded-full" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)}>
        {playing ? <Pause /> : <Play />}
      </Button>
      <Button variant="ghost" size="icon" aria-label="Next frame" onClick={() => setPlayhead(playhead + 1 / fps)}>
        <StepForward />
      </Button>
      <span className="ml-2 font-mono text-xs text-muted-foreground tabular-nums">
        {formatTime(playhead, true)} / {formatTime(duration, true)}
      </span>
    </div>
  );
}
