"use client";

import { useEffect, useState } from "react";
import { Cloud, Cpu, Loader2, Palette } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import type { UserSettings } from "@/agent/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Env = { cloud: { tokenSet: boolean } };

const FONTS = ["", "inter", "montserrat", "bebas", "playfair", "marker"] as const;
const CAPTIONS = ["", "bold", "karaoke", "minimal", "boxed"] as const;

function Section({ icon: Icon, title, children, desc }: { icon: typeof Cpu; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border p-4 sm:p-5">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Icon className="size-4 text-muted-foreground" /> {title}
        </h2>
        {desc && <p className="mt-1 text-sm text-muted-foreground">{desc}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingsPage() {
  const [s, setS] = useState<UserSettings | null>(null);
  const [env, setEnv] = useState<Env | null>(null);

  useEffect(() => {
    api<{ settings: UserSettings; env: Env }>("/api/settings")
      .then((r) => {
        setS(r.settings);
        setEnv(r.env);
      })
      .catch((e) => toast.error(e.message));
  }, []);

  const save = async (patch: Partial<UserSettings> | Record<string, unknown>, msg = "Saved") => {
    try {
      const r = await api<{ settings: UserSettings }>("/api/settings", { method: "PUT", json: patch });
      setS(r.settings);
      toast.success(msg);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  if (!s || !env) return <Loader2 className="mx-auto mt-10 animate-spin text-muted-foreground" />;
  const bk = s.brandKit ?? { enabled: false, name: "", notes: "" };

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Brand kit and cloud rendering. AI steps always run on your Claude subscription.</p>
      </div>


      <Section icon={Palette} title="Brand kit" desc="A client's look. Priority when rules conflict: your taste rules > this brand kit > the creator's style.json > defaults.">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">Use the brand kit in style passes</span>
          <Switch checked={Boolean(s.brandKit?.enabled)} onCheckedChange={(v) => save({ brandKit: { ...bk, enabled: v } })} />
        </label>
        <BrandKitForm value={bk} onSave={(v) => save({ brandKit: v }, "Brand kit saved")} />
      </Section>

      <Section icon={Cloud} title="Render in cloud (GitHub Actions)" desc="Off by default. When on, the export dialog shows a “Render in cloud” button; nothing is uploaded until you click it and confirm the upload.">
        <label className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <span>
            <span className="block text-sm font-medium">Enable “Render in cloud”</span>
            <span className="block text-xs text-muted-foreground">Uploads the render bundle (timeline, the media it uses, the render engine) to a PRIVATE repo you own, renders on GitHub Actions, downloads the video, then deletes the uploaded branch, run and artifact (unless you keep them).</span>
          </span>
          <Switch checked={s.cloud.enabled} onCheckedChange={(v) => save({ cloud: { enabled: v } }, v ? "Cloud render enabled (still asks before every upload)" : "Cloud render off")} />
        </label>
        <CloudForm repo={s.cloud.repo} keep={s.cloud.keep} tokenSet={env.cloud.tokenSet} onSave={(c) => save({ cloud: c })} />
      </Section>
    </div>
  );
}

function BrandKitForm({ value, onSave }: { value: NonNullable<UserSettings["brandKit"]>; onSave: (v: NonNullable<UserSettings["brandKit"]>) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const set = (k: string, x: unknown) => setV((o) => ({ ...o, [k]: x === "" ? null : x }));
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1">
        <Label className="text-xs">Client / brand name</Label>
        <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Font</Label>
        <select className="h-9 w-full rounded-md border bg-transparent px-2 text-sm" value={v.font ?? ""} onChange={(e) => set("font", e.target.value)}>
          {FONTS.map((f) => (
            <option key={f} value={f}>
              {f || "(no preference)"}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Text colour</Label>
        <div className="flex gap-2">
          <input type="color" value={v.primary ?? "#ffffff"} onChange={(e) => set("primary", e.target.value)} className="h-9 w-12 rounded border bg-transparent" />
          <Button size="sm" variant="ghost" onClick={() => set("primary", null)}>
            Clear
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Accent colour (highlighted words)</Label>
        <div className="flex gap-2">
          <input type="color" value={v.accent ?? "#ffd60a"} onChange={(e) => set("accent", e.target.value)} className="h-9 w-12 rounded border bg-transparent" />
          <Button size="sm" variant="ghost" onClick={() => set("accent", null)}>
            Clear
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Caption style</Label>
        <select className="h-9 w-full rounded-md border bg-transparent px-2 text-sm" value={v.captionStyle ?? ""} onChange={(e) => set("captionStyle", e.target.value)}>
          {CAPTIONS.map((f) => (
            <option key={f} value={f}>
              {f || "(no preference)"}
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <Switch checked={Boolean(v.uppercase)} onCheckedChange={(x) => setV({ ...v, uppercase: x })} /> Uppercase captions
      </label>
      <div className="space-y-1">
        <Label className="text-xs">Default look for new edits</Label>
        <select className="h-9 w-full rounded-md border bg-transparent px-2 text-sm" value={v.look ?? ""} onChange={(e) => set("look", e.target.value)}>
          <option value="">(none)</option>
          <option value="bold">Bold</option>
          <option value="cool_girl">Cool girl</option>
          <option value="cool_dude">Cool dude</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">@handle (Follow call-to-action)</Label>
        <Input value={v.handle ?? ""} placeholder="@yourhandle" onChange={(e) => setV({ ...v, handle: e.target.value.trim() || null })} />
      </div>
      <div className="space-y-1 sm:col-span-2">
        <Label className="text-xs">Notes (logo placement, banned words, tone…)</Label>
        <Textarea rows={3} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </div>
      <Button className="sm:col-span-2" onClick={() => onSave(v)}>
        Save brand kit
      </Button>
    </div>
  );
}

function CloudForm({ repo, keep, tokenSet, onSave }: { repo: string; keep: boolean; tokenSet: boolean; onSave: (c: { repo: string; keep: boolean }) => void }) {
  const [r, setR] = useState(repo);
  useEffect(() => setR(repo), [repo]);
  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={r} onChange={(e) => setR(e.target.value.trim())} placeholder="owner/private-render-repo" className="font-mono text-sm" />
        <Button variant="secondary" onClick={() => onSave({ repo: r, keep })}>
          Save repo
        </Button>
      </div>
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>Keep the uploaded media and artifact after downloading (default: delete)</span>
        <Switch checked={keep} onCheckedChange={(v) => onSave({ repo: r, keep: v })} />
      </label>
      <p className="text-xs text-muted-foreground">
        The repo must already exist and be <b>private</b>: AJOURNALLAB Studio never creates repos and refuses public ones. Token: {tokenSet ? "CLOUD_RENDER_TOKEN is set in .env." : <span className="text-amber-300">add CLOUD_RENDER_TOKEN (fine-grained, this repo only: Contents, Actions and Workflows read/write, Metadata read) to .env.</span>}
      </p>
    </div>
  );
}
