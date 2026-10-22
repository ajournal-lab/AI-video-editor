"use client";

import { useMemo } from "react";
import { ClipboardCopy, ExternalLink, Film, ImageIcon, Music, Palette, Plus, RefreshCw, RotateCcw, Trash2, Type, X } from "lucide-react";
import { toast } from "sonner";
import { copyScenePrompt } from "../quickimport";
import { adjacentPrev, audioSafety, clipDucks, clipEnd, findClip, GRADE_LOOKS, keyframeGain } from "@/lib/timeline/derive";
import { DEFAULT_FILTERS, DEFAULT_GRADE_INTENSITY, DEFAULT_TRANSFORM } from "@/lib/timeline/factory";
import { FONTS, FONT_IDS } from "@/lib/timeline/fonts";
import { deleteClips, moveClip, trimClip, updateClip } from "@/lib/timeline/ops";
import type { AudioClip, FilterPreset, FontId, GradeLook, KenBurnsDirection, TextAnimIn, TextAnimOut, TextClip, TransitionType, VisualClip, VideoTrack } from "@/lib/timeline/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEditor } from "../store";
import { ColorField, NumberField, Section, Segmented, SliderField, useClipEdit, useTimelineEdit } from "./fields";

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const timeline = useEditor((s) => s.timeline);
  const hit = useMemo(() => (selection.length === 1 ? findClip(timeline, selection[0]) : null), [selection, timeline]);
  if (selection.length > 1) return <Multi ids={selection} />;
  if (!hit) return <ProjectSettings />;
  const { clip, track } = hit;
  if (clip.type === "text") return <TextInspector clip={clip} />;
  if (clip.type === "audio") return <AudioInspector clip={clip} isMusic={track.kind === "music"} />;
  return <VisualInspector clip={clip} track={track as VideoTrack} />;
}

function Header({ icon: Icon, title, id }: { icon: typeof Film; title: string; id: string }) {
  const s = useEditor.getState;
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Delete clip"
        onClick={() => {
          s().commit(deleteClips(s().timeline, [id]), "Delete");
          s().select([]);
        }}
      >
        <Trash2 />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={() => s().select([])}>
        <X />
      </Button>
    </div>
  );
}

function Timing({ clip }: { clip: VisualClip | AudioClip | TextClip }) {
  const s = useEditor.getState;
  return (
    <Section title="Timing">
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Start" value={clip.start} min={0} suffix="s" onCommit={(v) => s().commit(moveClip(s().timeline, clip.id, v), "Move")} />
        <NumberField label="Duration" value={clip.duration} min={0.1} suffix="s" onCommit={(v) => s().commit(trimClip(s().timeline, clip.id, "right", clip.start + v), "Trim")} />
        {(clip.type === "video" || clip.type === "audio") && (
          <NumberField
            label="Source in"
            value={clip.in}
            min={0}
            suffix="s"
            onCommit={(v) => s().commit(updateClip(s().timeline, clip.id, { in: Math.min(v, (clip.srcDuration ?? Infinity) - 0.1) }), "Trim in")}
          />
        )}
        {(clip.type === "video" || clip.type === "audio") && (
          <div className="flex flex-col justify-end pb-1 text-[11px] text-muted-foreground">
            Source out {(clip.in + clip.duration * clip.speed).toFixed(2)}s{clip.srcDuration ? ` / ${clip.srcDuration.toFixed(1)}s` : ""}
          </div>
        )}
      </div>
    </Section>
  );
}

function AudioControls({ clip }: { clip: VisualClip | AudioClip }) {
  const e = useClipEdit(clip.id);
  const media = clip.type === "video" || clip.type === "audio";
  return (
    <Section title="Speed & sound">
      {media && (
        <SliderField label="Speed" value={clip.speed} min={0.5} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`} onLive={(v) => e.live({ speed: v })} onDone={() => e.done("Speed")} />
      )}
      {(clip.type === "audio" || (clip.type === "video" && clip.hasAudio !== false)) && (
        <>
          <SliderField label="Volume" value={clip.volume} min={0} max={2} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onLive={(v) => e.live({ volume: v })} onDone={() => e.done("Volume")} />
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Mute</Label>
            <Switch checked={clip.muted} onCheckedChange={(v) => e.set({ muted: v }, v ? "Mute" : "Unmute")} />
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-3">
        <SliderField label="Fade in" value={clip.fadeIn} min={0} max={Math.min(3, clip.duration / 2)} step={0.05} format={(v) => `${v.toFixed(2)}s`} onLive={(v) => e.live({ fadeIn: v })} onDone={() => e.done("Fade")} />
        <SliderField label="Fade out" value={clip.fadeOut} min={0} max={Math.min(3, clip.duration / 2)} step={0.05} format={(v) => `${v.toFixed(2)}s`} onLive={(v) => e.live({ fadeOut: v })} onDone={() => e.done("Fade")} />
      </div>
    </Section>
  );
}

/** Cinematic look (worker/grade.py): per clip, with "apply to all" for a consistent look across the edit. */
function GradeSection({ clip }: { clip: VisualClip }) {
  const e = useClipEdit(clip.id);
  const g = clip.grade;
  const applyAll = () => {
    const s = useEditor.getState();
    let tl = s.timeline;
    for (const t of tl.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) if (c.type !== "color") tl = updateClip(tl, c.id, { grade: g ? { ...g } : null });
    }
    s.commit(tl, g ? `${GRADE_LOOKS[g.look].label} on all clips` : "Look off on all clips");
  };
  return (
    <Section title="Look">
      <Segmented<"none" | GradeLook>
        value={g?.look ?? "none"}
        options={[{ value: "none", label: "None" }, ...Object.entries(GRADE_LOOKS).map(([id, l]) => ({ value: id as GradeLook, label: l.label }))]}
        onChange={(v) => e.set({ grade: v === "none" ? null : { look: v, intensity: g?.intensity ?? DEFAULT_GRADE_INTENSITY } }, "Look")}
      />
      {g && (
        <>
          <SliderField label="Intensity" value={g.intensity} min={0} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onLive={(v) => e.live({ grade: { ...g, intensity: v } })} onDone={() => e.done("Look intensity")} />
          <p className="text-[11px] text-muted-foreground">Warm highlights, teal shadows, soft blacks, calmer background colours and a light vignette. Skin tones are protected in the export (the preview approximates that).</p>
        </>
      )}
      <Button variant="secondary" size="sm" className="w-full" onClick={applyAll}>
        Apply {g ? `${GRADE_LOOKS[g.look].label} ${Math.round(g.intensity * 100)}%` : "no look"} to all clips
      </Button>
    </Section>
  );
}

function VisualInspector({ clip, track }: { clip: VisualClip; track: VideoTrack }) {
  const e = useClipEdit(clip.id);
  const prev = adjacentPrev(track.clips, clip);
  const tr = clip.transition;
  const f = clip.filters;
  const t = clip.transform;
  const setReplace = useEditor.getState().setReplaceTarget;
  return (
    <div>
      <Header icon={clip.type === "image" ? ImageIcon : clip.type === "color" ? Palette : Film} title={clip.name} id={clip.id} />
      <div className="grid grid-cols-2 gap-2 px-4 pt-3">
        <Button variant="secondary" size="sm" onClick={() => setReplace(clip.id)}>
          <RefreshCw /> Replace
        </Button>
        <Button variant="secondary" size="sm" onClick={() => copyScenePrompt(clip)} title="Copy a ready-to-paste image prompt for Gemini">
          <ClipboardCopy /> Gemini prompt
        </Button>
      </div>
      <p className="px-4 pt-2 text-[11px] text-muted-foreground">Tip: paste an image with Ctrl+V to put it on this scene.</p>
      <Timing clip={clip} />
      <AudioControls clip={clip} />
      {clip.type === "image" && (
        <Section title="Ken Burns">
          <Select
            value={clip.kenBurns?.direction ?? "none"}
            onValueChange={(v) => e.set({ kenBurns: v === "none" ? null : { direction: v as KenBurnsDirection, amount: clip.kenBurns?.amount ?? 0.15 } }, "Ken Burns")}
          >
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["none", "in", "out", "left", "right", "up", "down"].map((d) => (
                <SelectItem key={d} value={d}>
                  {d === "none" ? "Off" : d === "in" ? "Zoom in" : d === "out" ? "Zoom out" : `Pan ${d}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {clip.kenBurns && (
            <SliderField
              label="Amount"
              value={clip.kenBurns.amount}
              min={0.02}
              max={0.5}
              format={(v) => `${Math.round(v * 100)}%`}
              onLive={(v) => e.live({ kenBurns: { ...clip.kenBurns!, amount: v } })}
              onDone={() => e.done("Ken Burns")}
            />
          )}
        </Section>
      )}
      {clip.type === "color" && (
        <Section title="Colors">
          <ColorField label="From" value={clip.colors?.[0] ?? "#111827"} onChange={(v) => e.set({ colors: [v, clip.colors?.[1] ?? "#6D28D9"] }, "Color")} />
          <ColorField label="To" value={clip.colors?.[1] ?? "#6D28D9"} onChange={(v) => e.set({ colors: [clip.colors?.[0] ?? "#111827", v] }, "Color")} />
        </Section>
      )}
      <Section title="Transition in">
        <Segmented<TransitionType>
          value={tr?.type ?? "cut"}
          options={[
            { value: "cut", label: "Cut" },
            { value: "crossfade", label: "Fade" },
            { value: "slide", label: "Slide" },
            { value: "zoom", label: "Zoom" },
            { value: "flash", label: "Flash" },
          ]}
          onChange={(v) => e.set({ transition: v === "cut" ? null : { type: v, duration: tr?.duration ?? 0.5 } }, "Transition")}
        />
        {!prev && tr && tr.type !== "cut" && <p className="text-[11px] text-amber-300">No clip directly before this one on the track, so the transition is skipped.</p>}
        {tr && tr.type !== "cut" && (
          <SliderField label="Duration" value={tr.duration} min={0.1} max={Math.min(2, clip.duration * 0.9)} step={0.05} format={(v) => `${v.toFixed(2)}s`} onLive={(v) => e.live({ transition: { ...tr, duration: v } })} onDone={() => e.done("Transition")} />
        )}
      </Section>
      {clip.type !== "color" && (
        <Section
          title="Crop & position"
          action={
            <Button variant="ghost" size="icon" className="size-6" aria-label="Reset" onClick={() => e.set({ transform: { ...DEFAULT_TRANSFORM } }, "Reset frame")}>
              <RotateCcw />
            </Button>
          }
        >
          <Segmented
            value={t.fit}
            options={[
              { value: "cover", label: "Fill frame" },
              { value: "contain", label: "Fit inside" },
            ]}
            onChange={(v) => e.set({ transform: { ...t, fit: v } }, "Fit")}
          />
          <SliderField label="Scale" value={t.scale} min={0.25} max={3} format={(v) => `${Math.round(v * 100)}%`} onLive={(v) => e.live({ transform: { ...t, scale: v } })} onDone={() => e.done("Scale")} />
          <SliderField label="Horizontal" value={t.x} min={-1} max={1} onLive={(v) => e.live({ transform: { ...t, x: v } })} onDone={() => e.done("Position")} />
          <SliderField label="Vertical" value={t.y} min={-1} max={1} onLive={(v) => e.live({ transform: { ...t, y: v } })} onDone={() => e.done("Position")} />
        </Section>
      )}
      {(
        <Section
          title="Color"
          action={
            <Button variant="ghost" size="icon" className="size-6" aria-label="Reset" onClick={() => e.set({ filters: { ...DEFAULT_FILTERS } }, "Reset color")}>
              <RotateCcw />
            </Button>
          }
        >
          <Segmented<FilterPreset>
            value={f.preset}
            options={[
              { value: "none", label: "None" },
              { value: "warm", label: "Warm" },
              { value: "cool", label: "Cool" },
              { value: "bw", label: "B&W" },
            ]}
            onChange={(v) => e.set({ filters: { ...f, preset: v } }, "Filter")}
          />
          <SliderField label="Brightness" value={f.brightness} min={0.5} max={1.5} onLive={(v) => e.live({ filters: { ...f, brightness: v } })} onDone={() => e.done("Brightness")} />
          <SliderField label="Contrast" value={f.contrast} min={0.5} max={1.5} onLive={(v) => e.live({ filters: { ...f, contrast: v } })} onDone={() => e.done("Contrast")} />
          <SliderField label="Saturation" value={f.saturation} min={0} max={2} onLive={(v) => e.live({ filters: { ...f, saturation: v } })} onDone={() => e.done("Saturation")} />
        </Section>
      )}
      {clip.type !== "color" && <GradeSection clip={clip} />}
      {clip.keywords?.length ? (
        <Section title="Keywords">
          <div className="flex flex-wrap gap-1">
            {clip.keywords.map((k) => (
              <span key={k} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
                {k}
              </span>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

const LINK_LABEL = { instagram: "Instagram reel", youtube: "YouTube", direct: "Source file" } as const;
const mmss = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Where a linked sound came from and which part of it this clip plays (live: follows trims), for Instagram. */
function SoundSource({ clip }: { clip: AudioClip }) {
  const asset = useEditor((s) => (clip.assetId ? s.assets[clip.assetId] : undefined));
  const link = clip.link ?? (asset?.meta?.link ? { url: asset.meta.link.url, kind: asset.meta.link.kind } : null);
  if (!link) return null;
  const start = clip.in;
  const end = clip.in + clip.duration * clip.speed;
  const rights = asset?.meta?.rights;
  return (
    <Section title="Sound source">
      <a href={link.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 truncate text-xs text-primary underline-offset-2 hover:underline" title={link.url}>
        <ExternalLink className="size-3 shrink-0" /> {LINK_LABEL[link.kind as keyof typeof LINK_LABEL] ?? "Source"} <span className="truncate text-muted-foreground">{link.url.replace(/^https?:\/\/(www\.)?/, "")}</span>
      </a>
      <p className="text-xs">
        Plays <b>{mmss(start)}</b> → {mmss(end)} of the sound. Start the sound at <b>{start.toFixed(1)}s</b> in Instagram.
      </p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="h-7 text-[11px]"
          onClick={() =>
            navigator.clipboard
              .writeText(`${link.url}\nStart the sound at ${mmss(start)} (${start.toFixed(1)}s), ends ${mmss(end)}`)
              .then(() => toast.success("Copied the link and start time"))
              .catch(() => toast.error("Couldn't copy"))
          }
        >
          <ClipboardCopy className="size-3" /> Copy link + start
        </Button>
        {rights === false && <span className="text-[11px] text-amber-300">Timing only / personal use</span>}
      </div>
    </Section>
  );
}

function AudioInspector({ clip, isMusic }: { clip: AudioClip; isMusic: boolean }) {
  const e = useClipEdit(clip.id);
  const tl = useEditor((s) => s.timeline);
  const playhead = useEditor((s) => s.playhead);
  const kfs = [...(clip.keyframes ?? [])].sort((a, b) => a.t - b.t);
  const local = Math.min(clip.duration, Math.max(0, playhead - clip.start));
  return (
    <div>
      <Header icon={Music} title={clip.name} id={clip.id} />
      {isMusic && <SoundSource clip={clip} />}
      <Timing clip={clip} />
      <AudioControls clip={clip} />
      {isMusic && (
        <Section title="Ducking">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Sound effect (never ducked, kept {audioSafety(tl).sfxHeadroomDb} dB under the voice)</Label>
            <Switch checked={Boolean(clip.sfx)} onCheckedChange={(v) => e.set({ sfx: v || undefined, duck: v ? false : clip.duck }, v ? "Mark as sound effect" : "Mark as music")} />
          </div>
          {!clip.sfx && (
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Lower under the voice{clip.duck === undefined ? " (auto)" : ""}</Label>
              <Switch checked={clipDucks(tl, clip)} onCheckedChange={(v) => e.set({ duck: v }, "Ducking")} />
            </div>
          )}
          <DuckLevel />
        </Section>
      )}
      <Section
        title="Volume keyframes"
        action={
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => e.set({ keyframes: [...kfs, { t: Number(local.toFixed(2)), gain: Number(keyframeGain(clip, local).toFixed(2)) }] }, "Keyframe")}
          >
            <Plus /> At playhead
          </Button>
        }
      >
        {kfs.length === 0 && <p className="text-xs text-muted-foreground">Add points to automate volume (fade the music up for the outro, dip it for a line…). The curve shows on the clip.</p>}
        {kfs.map((k, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <NumberField label="At" value={k.t} min={0} max={clip.duration} suffix="s" onCommit={(v) => e.set({ keyframes: kfs.map((x, j) => (j === i ? { ...x, t: v } : x)) }, "Keyframe")} />
            <NumberField label="Gain" value={k.gain} min={0} max={2} step={0.05} onCommit={(v) => e.set({ keyframes: kfs.map((x, j) => (j === i ? { ...x, gain: v } : x)) }, "Keyframe")} />
            <Button variant="ghost" size="icon" className="size-8" aria-label="Remove keyframe" onClick={() => e.set({ keyframes: kfs.filter((_, j) => j !== i) }, "Keyframe")}>
              <X />
            </Button>
          </div>
        ))}
      </Section>
    </div>
  );
}

export function DuckLevel() {
  const level = useEditor((s) => s.timeline.duckLevel);
  const t = useTimelineEdit();
  return (
    <SliderField
      label="Music level under voice"
      value={level}
      min={0}
      max={1}
      format={(v) => `${Math.round(v * 100)}%`}
      onLive={(v) => t.live((tl) => ({ ...tl, duckLevel: v }))}
      onDone={() => t.done("Duck level")}
    />
  );
}

const POSITIONS = [
  { label: "Top", y: 0.15 },
  { label: "Middle", y: 0.5 },
  { label: "Lower", y: 0.75 },
  { label: "Bottom", y: 0.88 },
];

function TextInspector({ clip }: { clip: TextClip }) {
  const e = useClipEdit(clip.id);
  const st = clip.style;
  const setStyle = (patch: Partial<TextClip["style"]>, label = "Text style") => e.set({ style: { ...st, ...patch } }, label);
  const liveStyle = (patch: Partial<TextClip["style"]>) => e.live({ style: { ...st, ...patch } });
  return (
    <div>
      <Header icon={Type} title={clip.text.split("\n")[0] || "Text"} id={clip.id} />
      <Section title="Text">
        <Textarea
          defaultValue={clip.text}
          key={clip.id}
          rows={3}
          onChange={(ev) => e.live({ text: ev.target.value })}
          onBlur={() => e.done("Edit text")}
          className="text-sm"
        />
        <div className="grid grid-cols-2 gap-2">
          <Select value={st.font} onValueChange={(v) => setStyle({ font: v as FontId }, "Font")}>
            <SelectTrigger className="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FONT_IDS.map((id) => (
                <SelectItem key={id} value={id} style={{ fontFamily: `"${FONTS[id].css}"` }}>
                  {FONTS[id].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center justify-between rounded-md border px-2">
            <Label className="text-xs text-muted-foreground">ABC</Label>
            <Switch checked={st.uppercase} onCheckedChange={(v) => setStyle({ uppercase: v })} />
          </div>
        </div>
        <SliderField label="Size" value={st.size} min={16} max={240} step={1} format={(v) => `${Math.round(v)}px`} onLive={(v) => liveStyle({ size: v })} onDone={() => e.done("Size")} />
        <ColorField label="Color" value={st.color} onChange={(v) => setStyle({ color: v })} />
      </Section>
      <Section title="Style">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Background box</Label>
          <Switch checked={Boolean(st.background)} onCheckedChange={(v) => setStyle({ background: v ? "#FFFFFF" : null })} />
        </div>
        {st.background ? (
          <ColorField label="Box color" value={st.background} onChange={(v) => setStyle({ background: v })} />
        ) : (
          <>
            <SliderField label="Outline" value={st.outline} min={0} max={20} step={1} format={(v) => `${v}px`} onLive={(v) => liveStyle({ outline: v })} onDone={() => e.done("Outline")} />
            {st.outline > 0 && <ColorField label="Outline color" value={st.outlineColor} onChange={(v) => setStyle({ outlineColor: v })} />}
            <SliderField label="Shadow" value={st.shadow} min={0} max={16} step={1} format={(v) => `${v}px`} onLive={(v) => liveStyle({ shadow: v })} onDone={() => e.done("Shadow")} />
          </>
        )}
      </Section>
      <Section title="Position">
        <div className="grid grid-cols-4 gap-1">
          {POSITIONS.map((p) => (
            <Button key={p.label} variant="secondary" size="sm" className="h-7 text-[11px]" onClick={() => setStyle({ y: p.y, x: 0.5 }, "Position")}>
              {p.label}
            </Button>
          ))}
        </div>
        <SliderField label="Horizontal" value={st.x} min={0} max={1} onLive={(v) => liveStyle({ x: v })} onDone={() => e.done("Position")} />
        <SliderField label="Vertical" value={st.y} min={0} max={1} onLive={(v) => liveStyle({ y: v })} onDone={() => e.done("Position")} />
      </Section>
      <Section title="Animation">
        <div className="grid grid-cols-2 gap-2">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">In</span>
            <Select value={clip.animIn} onValueChange={(v) => e.set({ animIn: v as TextAnimIn }, "Animation")}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["none", "fade", "slide-up", "pop"].map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">Out</span>
            <Select value={clip.animOut} onValueChange={(v) => e.set({ animOut: v as TextAnimOut }, "Animation")}>
              <SelectTrigger className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["none", "fade", "slide-down", "pop"].map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      </Section>
      <Timing clip={clip} />
    </div>
  );
}

function Multi({ ids }: { ids: string[] }) {
  const s = useEditor.getState;
  const applyPreset = (preset: FilterPreset) => {
    let tl = s().timeline;
    for (const id of ids) {
      const c = findClip(tl, id)?.clip;
      if (c && (c.type === "video" || c.type === "image")) tl = updateClip(tl, id, { filters: { ...c.filters, preset } });
    }
    s().commit(tl, "Filter");
  };
  const applyTransition = (type: TransitionType) => {
    let tl = s().timeline;
    for (const id of ids) {
      const c = findClip(tl, id)?.clip;
      if (c && (c.type === "video" || c.type === "image" || c.type === "color")) tl = updateClip(tl, id, { transition: type === "cut" ? null : { type, duration: 0.5 } });
    }
    s().commit(tl, "Transition");
  };
  return (
    <div>
      <div className="flex items-center justify-between border-b px-4 py-3 text-sm font-medium">
        {ids.length} clips selected
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            s().commit(deleteClips(s().timeline, ids), "Delete");
            s().select([]);
          }}
        >
          <Trash2 /> Delete
        </Button>
      </div>
      <Section title="Color preset for all">
        <Segmented<FilterPreset>
          value={"none" as FilterPreset}
          options={[
            { value: "none", label: "None" },
            { value: "warm", label: "Warm" },
            { value: "cool", label: "Cool" },
            { value: "bw", label: "B&W" },
          ]}
          onChange={applyPreset}
        />
      </Section>
      <Section title="Transition for all">
        <Segmented<TransitionType>
          value={"cut" as TransitionType}
          options={[
            { value: "cut", label: "Cut" },
            { value: "crossfade", label: "Fade" },
            { value: "slide", label: "Slide" },
            { value: "zoom", label: "Zoom" },
            { value: "flash", label: "Flash" },
          ]}
          onChange={applyTransition}
        />
      </Section>
    </div>
  );
}

function ProjectSettings() {
  const bg = useEditor((s) => s.timeline.background);
  const t = useTimelineEdit();
  const clips = useEditor((s) => s.timeline.tracks.reduce((n, tr) => n + tr.clips.length, 0));
  const end = useEditor((s) => Math.max(0, ...s.timeline.tracks.flatMap((tr) => tr.clips.map((c) => clipEnd(c)))));
  return (
    <div>
      <div className="border-b px-4 py-3 text-sm font-medium">Project</div>
      <Section title="Overview">
        <p className="text-xs text-muted-foreground">
          {clips} clips · {end.toFixed(1)}s. Select a clip on the timeline to edit it. Shortcuts: Space play, S split, Del delete, Shift+Del ripple, ⌘/Ctrl+Z undo, ⌘/Ctrl+Shift+Z redo, ←/→ frame step.
        </p>
      </Section>
      <Section title="Canvas">
        <ColorField label="Background" value={bg} onChange={(v) => t.set((tl) => ({ ...tl, background: v }), "Background")} />
      </Section>
      <Section title="Music">
        <DuckLevel />
      </Section>
      <Section title="Tip">
        <p className="text-xs text-muted-foreground">
          Try the <span className="text-foreground">AI</span> tab: “cut all pauses”, “make scene 3 moodier”, “add a title card at start”.
        </p>
      </Section>
    </div>
  );
}
