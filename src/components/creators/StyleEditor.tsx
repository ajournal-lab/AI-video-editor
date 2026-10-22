"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { CreatorStyle } from "./types";

type Path = [keyof CreatorStyle, string];

function get(s: CreatorStyle, [a, b]: Path): unknown {
  return ((s[a] ?? {}) as Record<string, unknown>)[b];
}
function set(s: CreatorStyle, [a, b]: Path, v: unknown): CreatorStyle {
  return { ...s, [a]: { ...((s[a] ?? {}) as object), [b]: v } } as CreatorStyle;
}

function Num({ s, measured, p, label, min, max, step, unit, onChange, hint }: { s: CreatorStyle; measured: CreatorStyle | null; p: Path; label: string; min: number; max: number; step: number; unit?: string; hint?: string; onChange: (s: CreatorStyle) => void }) {
  const v = get(s, p) as number | null | undefined;
  const m = measured ? (get(measured, p) as number | null | undefined) : undefined;
  const changed = measured && m !== undefined && v !== m;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <Label className="text-sm">{label}</Label>
        <span className={cn("font-mono text-xs", changed ? "text-amber-300" : "text-muted-foreground")}>
          {v == null ? "not set" : `${Math.round(v * 100) / 100}${unit ?? ""}`}
          {changed && m != null ? ` (measured ${Math.round(m * 100) / 100}${unit ?? ""})` : ""}
        </span>
      </div>
      <Slider value={[v ?? min]} min={min} max={max} step={step} onValueChange={(x) => onChange(set(s, p, x[0]))} aria-label={label} />
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Pick({ s, p, label, options, onChange }: { s: CreatorStyle; p: Path; label: string; options: string[]; onChange: (s: CreatorStyle) => void }) {
  const v = (get(s, p) as string | null | undefined) ?? "";
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      <select value={v} onChange={(e) => onChange(set(s, p, e.target.value || null))} className="h-9 w-full rounded-md border bg-transparent px-2 text-sm">
        <option value="">(not set)</option>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </div>
  );
}

function Color({ s, p, label, onChange }: { s: CreatorStyle; p: Path; label: string; onChange: (s: CreatorStyle) => void }) {
  const v = (get(s, p) as string | null | undefined) ?? "";
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : "#ffffff"} onChange={(e) => onChange(set(s, p, e.target.value))} className="h-9 w-12 rounded border bg-transparent" />
        <span className="font-mono text-xs text-muted-foreground">{v || "not set"}</span>
      </div>
    </div>
  );
}

/** The measured style.json as a form: tweak pace, zooms, captions and sound cues without editing files. */
export function StyleEditor({ handle, style, measured, onSaved }: { handle: string; style: CreatorStyle; measured: CreatorStyle | null; onSaved: () => void }) {
  const [s, setS] = useState(style);
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(style), [style]);
  const base = measured ?? style; // what the analysis measured (to show what you changed)
  const dirty = JSON.stringify(s) !== JSON.stringify(style);

  const save = async () => {
    setBusy(true);
    try {
      await api(`/api/creators/${encodeURIComponent(handle)}/style`, { method: "POST", json: { style: s } });
      toast.success("Style saved: the next style pass uses these values");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!window.confirm("Put every value back to what the analysis measured?")) return;
    try {
      await api(`/api/creators/${encodeURIComponent(handle)}/reset`, { method: "POST" });
      toast.success("Back to the measured style");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const F = { s, measured: base, onChange: setS };
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="space-y-4 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">Pace</h3>
          <Num {...F} p={["pacing", "avgShotSec"]} label="Seconds between cuts" min={0.3} max={6} step={0.1} unit=" s" hint="Lower = faster edit" />
          <Num {...F} p={["pacing", "cutsFirst3s"]} label="Cuts in the first 3 s" min={0} max={8} step={1} />
          <Num {...F} p={["pacing", "wordsPerMin"]} label="Words per minute (speech pace)" min={80} max={260} step={5} />
          <label className="flex items-center justify-between text-sm">
            Remove pauses
            <Switch checked={Boolean(s.pacing.pausesRemoved)} onCheckedChange={(v) => setS(set(s, ["pacing", "pausesRemoved"], v))} />
          </label>
        </section>
        <section className="space-y-4 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">Zooms</h3>
          <Pick {...F} p={["zooms", "style"]} label="Zoom style" options={["punch", "smooth", "mixed", "none"]} />
          <Num {...F} p={["zooms", "typicalScale"]} label="Zoom strength" min={1} max={1.4} step={0.01} unit="×" hint="1.10 = a 10% punch-in. Capped at what each clip's resolution allows." />
          <Num {...F} p={["zooms", "perMinute"]} label="Zooms per minute" min={0} max={40} step={1} />
          <label className="flex items-center justify-between text-sm">
            Zoom on emphasis words
            <Switch checked={Boolean(s.zooms.onEmphasis)} onCheckedChange={(v) => setS(set(s, ["zooms", "onEmphasis"], v))} />
          </label>
        </section>
        <section className="space-y-4 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">Captions</h3>
          <label className="flex items-center justify-between text-sm">
            Captions on
            <Switch checked={s.captions.present} onCheckedChange={(v) => setS(set(s, ["captions", "present"], v))} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Pick {...F} p={["captions", "style"]} label="Style" options={["bold", "karaoke", "minimal", "boxed"]} />
            <Pick {...F} p={["captions", "font"]} label="Font" options={["inter", "montserrat", "bebas", "playfair", "marker"]} />
            <Pick {...F} p={["captions", "case"]} label="Case" options={["upper", "lower", "sentence", "mixed"]} />
            <Pick {...F} p={["captions", "position"]} label="Position" options={["top", "upper-middle", "middle", "lower-middle", "bottom"]} />
          </div>
          <Num {...F} p={["captions", "sizePx"]} label="Size" min={30} max={200} step={2} unit=" px" hint="In 1080×1920 pixels" />
          <Num {...F} p={["captions", "y"]} label="Height on screen" min={0.14} max={0.79} step={0.01} hint="Caption centre: 0.14 = top of the safe zone, 0.79 = bottom" />
          <Num {...F} p={["captions", "wordsOnScreen"]} label="Words on screen" min={1} max={8} step={1} />
          <div className="grid grid-cols-2 gap-3">
            <Color {...F} p={["captions", "color"]} label="Text colour" />
            <Color {...F} p={["captions", "highlight"]} label="Highlight colour" />
          </div>
        </section>
        <section className="space-y-4 rounded-xl border p-4">
          <h3 className="text-sm font-semibold">Sound & hook</h3>
          <Num {...F} p={["sound", "sfxPerMin"]} label="Sound effects per minute" min={0} max={40} step={1} hint="Whooshes / hits on cuts and zooms" />
          <label className="flex items-center justify-between text-sm">
            Background music
            <Switch checked={Boolean(s.sound.music)} onCheckedChange={(v) => setS(set(s, ["sound", "music"], v))} />
          </label>
          <label className="flex items-center justify-between text-sm">
            On-screen hook text
            <Switch checked={Boolean(s.hooks.textOnScreen)} onCheckedChange={(v) => setS(set(s, ["hooks", "textOnScreen"], v))} />
          </label>
          <div className="space-y-1.5">
            <Label className="text-sm">Hook pattern</Label>
            <Textarea rows={2} value={s.hooks.pattern} onChange={(e) => setS(set(s, ["hooks", "pattern"], e.target.value))} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Summary</Label>
            <Textarea rows={3} value={s.summary} onChange={(e) => setS({ ...s, summary: e.target.value })} />
          </div>
        </section>
      </div>
      <div className="sticky bottom-3 flex flex-wrap items-center gap-2 rounded-xl border bg-background/90 p-3 backdrop-blur">
        <Button onClick={save} disabled={!dirty || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Save />} Save style
        </Button>
        <Button variant="ghost" onClick={() => setS(style)} disabled={!dirty}>
          Discard changes
        </Button>
        {measured && (
          <Button variant="ghost" onClick={reset}>
            <RotateCcw /> Reset to measured
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {style.edited?.fields.length ? `Edited by you: ${style.edited.fields.join(", ")}` : "Values as measured from the 5 videos."}
        </span>
      </div>
    </div>
  );
}
