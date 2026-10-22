"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clapperboard, FileAudio, ImagePlus, Loader2, Mic, Music2, Scissors, Sparkles, Upload, Users, X, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { uploadAsset, uploadFile, type AssetDTO } from "@/lib/client/upload";
import { LinkImport } from "@/components/media/LinkImport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_GRADE_INTENSITY } from "@/lib/timeline/factory";
import { cn } from "@/lib/utils";
import { Recorder } from "./Recorder";

const ASPECTS = [
  { id: "9:16", label: "Vertical", hint: "TikTok · Reels · Shorts", w: 9, h: 16 },
  { id: "16:9", label: "Landscape", hint: "YouTube", w: 16, h: 9 },
  { id: "1:1", label: "Square", hint: "Feed posts", w: 1, h: 1 },
] as const;

type Mode = "music" | "talking_head" | "best_take" | "voiceover_broll" | "auto_clip";
type Role = { id: string; label: string; hint: string; accept: string; many: boolean; required: boolean };

const MODES: { id: Mode; label: string; icon: LucideIcon; body: string; roles: Role[]; next: string }[] = [
  {
    id: "music",
    label: "Music edit",
    icon: Music2,
    body: "Silent clips cut to a track: hook → grind → reveal, every cut on the beat.",
    roles: [
      { id: "clips", label: "Clips", hint: "Your workout / b-roll clips", accept: "video/*", many: true, required: true },
      { id: "music", label: "Track (optional)", hint: "MP3/M4A, or paste a link below", accept: "audio/*", many: false, required: false },
    ],
    next: "Claude learns the style, sorts the clips, finds the beats and the drop, then shows you the shot list.",
  },
  {
    id: "talking_head",
    label: "Talking head",
    icon: Mic,
    body: "Removes retakes, false starts, stutters, fillers and pauses. Punch-ins on jump cuts, word-timed captions.",
    roles: [
      { id: "clips", label: "Clips of you talking", hint: "One or more videos, in order", accept: "video/*", many: true, required: true },
      { id: "background", label: "Background image (optional)", hint: "Replaces the background behind you (you are cut out on the CPU after you approve)", accept: "image/*", many: false, required: false },
    ],
    next: "Claude transcribes locally and shows you the cut list and the cleaned script before anything is edited.",
  },
  {
    id: "best_take",
    label: "Best take",
    icon: Users,
    body: "Several takes of the same script: the best take of every line, with colour and loudness matched.",
    roles: [{ id: "takes", label: "Takes", hint: "Every take of the script", accept: "video/*", many: true, required: true }],
    next: "Claude scores every take of every line. You see the table and can swap any line before approving.",
  },
  {
    id: "voiceover_broll",
    label: "Voiceover + b-roll",
    icon: Clapperboard,
    body: "Your voice plus b-roll: show the squat clip when you say “squats”. Optional cut-backs to your face.",
    roles: [
      { id: "voice", label: "Voice recording", hint: "Audio, or a video of you speaking", accept: "audio/*,video/*", many: false, required: true },
      { id: "broll", label: "B-roll", hint: "Clips and photos", accept: "video/*,image/*", many: true, required: true },
      { id: "music", label: "Background music (optional)", hint: "Ducked under your voice", accept: "audio/*", many: false, required: false },
      { id: "background", label: "Background image (optional)", hint: "Behind you in the face cut-backs (voice must be a video of you)", accept: "image/*", many: false, required: false },
    ],
    next: "Claude matches b-roll to your words. You see the word → clip mapping and can reassign any segment.",
  },
  {
    id: "auto_clip",
    label: "Auto-clip",
    icon: Scissors,
    body: "One long video in, several vertical shorts out, each with a hook and captions.",
    roles: [{ id: "source", label: "Long video", hint: "A talk, podcast, vlog…", accept: "video/*", many: false, required: true }],
    next: "Claude finds the strongest self-contained moments. You pick which shorts to make.",
  },
];

type Upload = { key: number; name: string; progress: number; asset?: AssetDTO; preview?: string };

function useUploads() {
  const [byRole, setByRole] = useState<Record<string, Upload[]>>({});
  const add = (role: string, files: File[], many: boolean, music = false) => {
    for (const f of many ? files : files.slice(0, 1)) {
      const key = Math.random();
      const preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
      setByRole((m) => ({ ...m, [role]: [...(many ? (m[role] ?? []) : []), { key, name: f.name, progress: 0, preview }] }));
      const patch = (fn: (u: Upload) => Upload) => setByRole((m) => ({ ...m, [role]: (m[role] ?? []).map((u) => (u.key === key ? fn(u) : u)) }));
      uploadAsset(f, music ? "music" : "auto", (p) => patch((u) => ({ ...u, progress: p })))
        .then((asset) => {
          if (asset.duplicate) toast.info(`${f.name}: already in your library, using “${asset.name}”`);
          patch((u) => ({ ...u, asset, progress: 1 }));
        })
        .catch((e) => {
          toast.error(`${f.name}: ${(e as Error).message}`);
          setByRole((m) => ({ ...m, [role]: (m[role] ?? []).filter((u) => u.key !== key) }));
        });
    }
  };
  /** A library asset (e.g. imported from a link) straight into a role; the same asset is never listed twice. */
  const addAsset = (role: string, asset: AssetDTO, many: boolean) =>
    setByRole((m) => {
      const cur = (many ? (m[role] ?? []) : []).filter((u) => u.asset?.id !== asset.id);
      return { ...m, [role]: [...cur, { key: Math.random(), name: asset.name, progress: 1, asset }] };
    });
  const remove = (role: string, key: number) => setByRole((m) => ({ ...m, [role]: (m[role] ?? []).filter((u) => u.key !== key) }));
  const ids = (role: string) => (byRole[role] ?? []).map((u) => u.asset?.id).filter(Boolean) as string[];
  const uploading = Object.values(byRole).some((l) => l.some((u) => !u.asset));
  return { byRole, add, addAsset, remove, ids, uploading, reset: () => setByRole({}) };
}

function DropZone({ role, uploads, onAdd, onAddAsset, onRemove }: { role: Role; uploads: Upload[]; onAdd: (files: File[]) => void; onAddAsset: (a: AssetDTO) => void; onRemove: (key: number) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <Label>
        {role.label} {role.required && <span className="text-muted-foreground">*</span>}
      </Label>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onAdd([...e.dataTransfer.files]);
        }}
        className="rounded-xl border border-dashed p-3"
      >
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {uploads.map((a) => (
            <div key={a.key} className="relative aspect-square overflow-hidden rounded-lg border bg-muted">
              {a.preview || a.asset?.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.preview ?? a.asset!.thumbUrl!} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-1 p-1 text-center text-[10px] text-muted-foreground">
                  <FileAudio className="size-4" />
                  <span className="line-clamp-2 break-all">{a.name}</span>
                </div>
              )}
              {!a.asset && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">
                  <Loader2 className="mr-1 size-3 animate-spin" /> {Math.round(a.progress * 100)}%
                </div>
              )}
              <button type="button" aria-label="Remove" onClick={() => onRemove(a.key)} className="absolute top-1 right-1 rounded-full bg-black/70 p-0.5 text-white">
                <X className="size-3" />
              </button>
            </div>
          ))}
          {(role.many || uploads.length === 0) && (
            <button
              type="button"
              onClick={() => ref.current?.click()}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-xs text-muted-foreground hover:border-primary hover:text-foreground"
            >
              <ImagePlus className="size-5" /> Add
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{role.hint}. Drop files here, click Add, or paste a link.</p>
        {(role.many || uploads.length === 0) && <LinkImport compact className="mt-2" onImported={onAddAsset} />}
        <input ref={ref} type="file" multiple={role.many} accept={role.accept} className="hidden" onChange={(e) => (onAdd([...(e.target.files ?? [])]), (e.target.value = ""))} />
      </div>
    </div>
  );
}

export function NewProject() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("talking_head");
  const [title, setTitle] = useState("");
  const [aspect, setAspect] = useState<(typeof ASPECTS)[number]["id"]>("9:16");
  const [notes, setNotes] = useState("");
  const [script, setScript] = useState("");
  const [musicUrl, setMusicUrl] = useState("");
  const [faceCutbacks, setFaceCutbacks] = useState(true);
  const [look, setLook] = useState<"none" | "cinematic_warm">("none"); // talking head / best take
  const [lookIntensity, setLookIntensity] = useState(DEFAULT_GRADE_INTENSITY);
  const [count, setCount] = useState(3);
  const [quick, setQuick] = useState(false); // voiceover: the instant first cut without Claude
  const [inChat, setInChat] = useState(false); // open on the chat; the first message starts the cut
  const [creator, setCreator] = useState(""); // a creator profile's style (Creators page)
  const [creators, setCreators] = useState<{ handle: string; status: string; summary: string | null }[]>([]);
  useEffect(() => {
    api<{ creators: { handle: string; status: string; summary: string | null }[] }>("/api/creators")
      .then((r) => setCreators(r.creators.filter((c) => c.status === "ready")))
      .catch(() => {});
  }, []);
  const [voiceTab, setVoiceTab] = useState("upload");
  const [recording, setRecording] = useState<Blob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const up = useUploads();
  const m = MODES.find((x) => x.id === mode)!;
  const hasMusic = m.roles.some((r) => r.id === "music") && !(mode === "voiceover_broll" && quick);

  const recordedFile = recording ? new File([recording], `recording.${recording.type.includes("mp4") ? "m4a" : "webm"}`, { type: recording.type }) : null;
  const missing = m.roles.filter((r) => r.required && !(r.id === "voice" && voiceTab === "record" ? recording : up.ids(r.id).length));
  const ready = !busy && !up.uploading && missing.length === 0;

  const create = async () => {
    try {
      if (mode === "voiceover_broll" && quick) return await createQuick();
      let voice = up.ids("voice");
      if (mode === "voiceover_broll" && voiceTab === "record" && recordedFile) {
        setBusy("Uploading the recording…");
        voice = [(await uploadAsset(recordedFile, "music")).id];
      }
      setBusy(hasMusic && musicUrl.trim() && !up.ids("music").length ? "Downloading the sound…" : inChat ? "Creating…" : "Starting Claude…");
      const assets = Object.fromEntries(m.roles.map((r) => [r.id, r.id === "voice" ? voice : up.ids(r.id)]));
      const { project } = await api<{ project: { id: string } }>("/api/projects", {
        method: "POST",
        json: {
          title: title.trim() || undefined,
          aspect,
          mode,
          startInChat: inChat,
          inputs: {
            assets,
            notes: notes.trim() || undefined,
            script: mode === "best_take" && script.trim() ? script.trim() : undefined,
            musicUrl: hasMusic && musicUrl.trim() ? musicUrl.trim() : undefined,
            faceCutbacks: mode === "voiceover_broll" ? faceCutbacks : undefined,
            count: mode === "auto_clip" ? count : undefined,
            grade: (mode === "talking_head" || mode === "best_take") && look !== "none" ? { look, intensity: lookIntensity } : undefined,
            creator: creator || undefined,
          },
        },
      });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  /** The original voice-first flow: transcribe in the worker, scene split, match the library by file name. */
  const createQuick = async () => {
    setBusy("Creating project…");
    const { project } = await api<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      json: { title: title.trim() || undefined, aspect, mode: "voice", assetIds: up.ids("broll") },
    });
    const voiceAsset = up.byRole.voice?.[0]?.asset;
    let url: string;
    let name: string;
    let mime: string;
    if (voiceTab === "record" && recording) {
      name = recordedFile!.name;
      mime = recording.type;
      url = await uploadFile(recording, name, "voice", (p) => setBusy(`Uploading ${Math.round(p * 100)}%`));
    } else {
      url = voiceAsset!.url;
      name = voiceAsset!.name;
      mime = voiceAsset!.type === "video" ? "video/mp4" : "audio/mpeg";
    }
    await api(`/api/projects/${project.id}/voice`, { method: "POST", json: { url, name, mime, source: voiceTab === "record" ? "recording" : "upload" } });
    router.push(`/projects/${project.id}`);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New edit</h1>
        <p className="text-sm text-muted-foreground">Pick how you want to edit. Claude plans the edit on your machine and shows it to you for approval; then everything is editable on the timeline.</p>
      </div>

      {/* ------------------------------------------------ mode */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {MODES.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => {
              setMode(x.id);
              up.reset();
            }}
            className={cn("rounded-xl border p-3 text-left transition", mode === x.id ? "border-primary bg-primary/10" : "hover:border-white/25")}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <x.icon className="size-4 text-primary" /> {x.label}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{x.body}</div>
          </button>
        ))}
      </div>

      {/* ------------------------------------------------ inputs */}
      <div className="space-y-5">
        {m.roles.map((r) =>
          r.id === "voice" ? (
            <div key={r.id} className="space-y-2">
              <Label>{r.label} *</Label>
              <Tabs value={voiceTab} onValueChange={setVoiceTab}>
                <TabsList className="w-full">
                  <TabsTrigger value="upload">
                    <Upload /> Upload
                  </TabsTrigger>
                  <TabsTrigger value="record">
                    <Mic /> Record now
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="upload">
                  <DropZone role={r} uploads={up.byRole[r.id] ?? []} onAdd={(f) => up.add(r.id, f, false, f[0]?.type.startsWith("audio/"))} onAddAsset={(a) => up.addAsset(r.id, a, false)} onRemove={(k) => up.remove(r.id, k)} />
                </TabsContent>
                <TabsContent value="record">
                  <Recorder onRecorded={setRecording} />
                </TabsContent>
              </Tabs>
            </div>
          ) : (
            <DropZone key={r.id} role={r} uploads={up.byRole[r.id] ?? []} onAdd={(f) => up.add(r.id, f, r.many, r.accept === "audio/*")} onAddAsset={(a) => up.addAsset(r.id, a, r.many)} onRemove={(k) => up.remove(r.id, k)} />
          ),
        )}

        {hasMusic && (
          <div className="space-y-2">
            <Label htmlFor="musicUrl">…or a link to the sound (optional)</Label>
            <Input id="musicUrl" value={musicUrl} onChange={(e) => setMusicUrl(e.target.value)} placeholder="YouTube / Shorts link, Instagram /reel/ link, or an .mp3 URL" />
            <p className="text-xs text-muted-foreground">
              {up.ids("music").length ? "An uploaded track wins over the link. " : ""}Downloaded with yt-dlp when you start (timing only / personal use until you confirm the rights). Instagram /reels/audio/ pages can&apos;t be downloaded; use a /reel/ link that uses the sound.
            </p>
          </div>
        )}
        {mode === "best_take" && (
          <div className="space-y-2">
            <Label htmlFor="script">Script (optional)</Label>
            <Textarea id="script" value={script} onChange={(e) => setScript(e.target.value)} rows={6} placeholder="Paste the script to align the takes line by line. Without it, the takes are aligned to each other." />
          </div>
        )}
        {(mode === "talking_head" || mode === "best_take") && (
          <div className="space-y-3 rounded-xl border p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">
                Look
                <span className="block text-xs text-muted-foreground">Applied to every clip when you approve the plan; change it per clip later</span>
              </span>
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
                {(["none", "cinematic_warm"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setLook(v)}
                    className={cn("rounded-md px-2.5 py-1 text-xs transition", look === v ? "bg-background text-foreground shadow" : "text-muted-foreground hover:text-foreground")}
                  >
                    {v === "none" ? "Natural" : "Cinematic Warm"}
                  </button>
                ))}
              </div>
            </div>
            {look !== "none" && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Intensity</span>
                  <span>{Math.round(lookIntensity * 100)}%</span>
                </div>
                <Slider value={[lookIntensity]} min={0} max={1} step={0.05} onValueChange={(v) => setLookIntensity(v[0])} aria-label="Look intensity" />
                <p className="text-xs text-muted-foreground">Warm highlights, teal shadows, soft blacks, calmer background colours, subtle vignette. Skin tones are protected.</p>
              </div>
            )}
          </div>
        )}
        {mode === "voiceover_broll" && (
          <div className="space-y-3 rounded-xl border p-3">
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Cut back to my face for key lines
                <span className="block text-xs text-muted-foreground">Only when the voice recording is a video of you</span>
              </span>
              <Switch checked={faceCutbacks} onCheckedChange={setFaceCutbacks} disabled={quick} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                Quick cut (no Claude)
                <span className="block text-xs text-muted-foreground">Instant first cut that matches b-roll by file name, without the review step</span>
              </span>
              <Switch checked={quick} onCheckedChange={setQuick} />
            </label>
          </div>
        )}
        {mode === "auto_clip" && (
          <div className="space-y-2">
            <Label htmlFor="count">How many shorts</Label>
            <Input id="count" type="number" min={1} max={10} value={count} onChange={(e) => setCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} className="w-24" />
          </div>
        )}
        {!(mode === "voiceover_broll" && quick) && (
          <div className="space-y-2 rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
              <span>
                Creator style
                <span className="block text-xs text-muted-foreground">Edit in the style of a creator you analysed on the Creators page. Your taste rules still win.</span>
              </span>
              <select value={creator} onChange={(e) => setCreator(e.target.value)} className="h-9 min-w-44 rounded-md border bg-transparent px-2 text-sm">
                <option value="">None</option>
                {creators.map((c) => (
                  <option key={c.handle} value={c.handle}>
                    @{c.handle}
                  </option>
                ))}
              </select>
            </div>
            {creator && <p className="text-xs text-muted-foreground">{creators.find((c) => c.handle === creator)?.summary}</p>}
            {!creators.length && (
              <p className="text-xs text-muted-foreground">
                No profiles yet: <Link href="/creators/new" className="underline">analyse a creator</Link>.
              </p>
            )}
          </div>
        )}
        {!(mode === "voiceover_broll" && quick) && (
          <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
            <span>
              Start in the chat
              <span className="block text-xs text-muted-foreground">Open the project on its chat and describe the reel (“30s, style of @creator, cut the pauses, punchy zooms”). Your first message starts the cut.</span>
            </span>
            <Switch checked={inChat} onCheckedChange={setInChat} />
          </label>
        )}
        {!(mode === "voiceover_broll" && quick) && !inChat && (
          <div className="space-y-2">
            <Label htmlFor="notes">Brief for Claude (optional)</Label>
            <Textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={mode === "music" ? "Quote / hook text, target length, the vibe…" : "Audience, tone, target length, anything to keep or cut…"}
            />
          </div>
        )}
      </div>

      {/* ------------------------------------------------ format + title */}
      <div className="grid gap-6 sm:grid-cols-[1fr_1.3fr]">
        <div className="space-y-2">
          <Label htmlFor="title">Title (optional)</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled video" maxLength={100} />
        </div>
        <div className="space-y-2">
          <Label>Format</Label>
          <div className="grid grid-cols-3 gap-2">
            {ASPECTS.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => setAspect(a.id)}
                title={a.hint}
                className={cn("flex items-center justify-center gap-2 rounded-lg border px-2 py-2 text-sm transition", aspect === a.id ? "border-primary bg-primary/10" : "hover:border-white/25")}
              >
                <span className={cn("block rounded-[3px] border-2", aspect === a.id ? "border-primary" : "border-muted-foreground")} style={{ width: a.w >= a.h ? 20 : (20 * a.w) / a.h, height: a.h >= a.w ? 20 : (20 * a.h) / a.w }} />
                {a.id}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="space-y-2 pb-10">
        <Button size="lg" className="brand-gradient w-full text-white" disabled={!ready} onClick={create}>
          {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {busy ?? (up.uploading ? "Waiting for uploads…" : missing.length ? `Add ${missing[0].label.toLowerCase()}` : mode === "voiceover_broll" && quick ? "Create video" : "Plan the edit")}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          {mode === "voiceover_broll" && quick ? "Next: transcription with word timings, scene split, visuals and captions, then the editor." : m.next}
        </p>
      </div>
    </div>
  );
}
