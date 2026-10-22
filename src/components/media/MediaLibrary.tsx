"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Film, ImageIcon, Loader2, Music, Mic, Plus, Scissors, Search, Tag, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { uploadAsset, type AssetDTO } from "@/lib/client/upload";
import { LinkImport } from "./LinkImport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Filter = "all" | "video" | "image" | "music" | "audio";
type SourceFilter = "all" | "upload" | "gemini_manual";
const SOURCES: { id: SourceFilter; label: string }[] = [
  { id: "all", label: "Any source" },
  { id: "upload", label: "Uploads" },
  { id: "gemini_manual", label: "Gemini (manual)" },
];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Videos" },
  { id: "image", label: "Photos" },
  { id: "music", label: "Music" },
  { id: "audio", label: "Voice" },
];

export function useAssets(onLoad?: (a: AssetDTO[]) => void) {
  const [assets, setAssets] = useState<AssetDTO[] | null>(null);
  const cb = useRef(onLoad);
  cb.current = onLoad;
  useEffect(() => {
    api<{ assets: AssetDTO[] }>("/api/media")
      .then((r) => {
        setAssets(r.assets);
        cb.current?.(r.assets);
      })
      .catch((e) => toast.error(e.message));
  }, []);
  return [assets, setAssets] as const;
}

export function MediaLibrary({
  assets,
  setAssets,
  onAdd,
  onClip,
  itemProps,
  compact,
  highlight,
  onUploaded,
}: {
  assets: AssetDTO[] | null;
  setAssets: (fn: (a: AssetDTO[] | null) => AssetDTO[] | null) => void;
  onAdd?: (a: AssetDTO) => void;
  onClip?: (a: AssetDTO) => void; // videos: open the in/out picker
  itemProps?: (a: AssetDTO) => Record<string, unknown>;
  compact?: boolean;
  highlight?: string;
  onUploaded?: (a: AssetDTO) => void; // e.g. the editor puts new uploads on the timeline
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [q, setQ] = useState("");
  const [uploads, setUploads] = useState<{ id: number; name: string; p: number }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const musicRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (assets ?? []).filter(
      (a) =>
        (filter === "all" || a.type === filter) &&
        (source === "all" || a.source === source) &&
        words.every((w) => a.name.toLowerCase().includes(w) || a.tags.some((t) => t.includes(w))),
    );
  }, [assets, filter, source, q]);

  const upload = async (files: FileList | null, as: "auto" | "music") => {
    if (!files) return;
    await Promise.all(
      [...files].map(async (file) => {
        const id = Math.random();
        setUploads((u) => [...u, { id, name: file.name, p: 0 }]);
        try {
          const asset = await uploadAsset(file, as, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, p } : x))));
          added(asset, file.name);
        } catch (e) {
          toast.error(`${file.name}: ${(e as Error).message}`);
        } finally {
          setUploads((u) => u.filter((x) => x.id !== id));
        }
      }),
    );
  };

  /** A new upload / import (or the existing asset it duplicates) goes to the top of the list, never twice. */
  const added = (asset: AssetDTO, label: string) => {
    setAssets((a) => [asset, ...(a ?? []).filter((x) => x.id !== asset.id)]);
    if (asset.duplicate) toast.info(`${label}: already in your library as “${asset.name}”, not uploaded again`);
    if (onUploaded) onUploaded(asset);
    else if (!asset.duplicate) toast.success(`${label} added${asset.tags.length ? ` · tagged ${asset.tags.slice(0, 3).join(", ")}` : ""}`);
  };

  const remove = async (a: AssetDTO) => {
    if (!confirm(`Delete “${a.name}” from your library?`)) return;
    try {
      await api(`/api/media/${a.id}`, { method: "DELETE" });
      setAssets((list) => (list ?? []).filter((x) => x.id !== a.id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const saveTags = async (a: AssetDTO, text: string) => {
    const tags = [...new Set(text.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean))];
    try {
      const { asset } = await api<{ asset: AssetDTO }>(`/api/media/${a.id}`, { method: "PATCH", json: { tags } });
      setAssets((list) => (list ?? []).map((x) => (x.id === a.id ? asset : x)));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-col gap-3"
      onDragOver={(e) => e.dataTransfer.types.includes("Files") && e.preventDefault()}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        upload(e.dataTransfer.files, "auto");
      }}
    >
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={() => fileRef.current?.click()}>
          <Upload /> Upload media
        </Button>
        <Button size="sm" variant="secondary" onClick={() => musicRef.current?.click()}>
          <Music /> Music
        </Button>
        <input ref={fileRef} type="file" multiple accept="video/*,image/*,audio/*" className="hidden" onChange={(e) => (upload(e.target.files, "auto"), (e.target.value = ""))} />
        <input ref={musicRef} type="file" multiple accept="audio/*" className="hidden" onChange={(e) => (upload(e.target.files, "music"), (e.target.value = ""))} />
      </div>
      <LinkImport onImported={(a) => onUploaded ? (setAssets((l) => [a, ...(l ?? []).filter((x) => x.id !== a.id)]), onUploaded(a)) : setAssets((l) => [a, ...(l ?? []).filter((x) => x.id !== a.id)])} />
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names and tags" className="h-8 pl-8 text-xs" />
      </div>
      <div className="no-scrollbar flex gap-1 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={cn("shrink-0 rounded-full border px-2.5 py-1 text-[11px]", filter === f.id ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="no-scrollbar flex gap-1 overflow-x-auto" aria-label="Filter by source">
        {SOURCES.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setSource(f.id)}
            className={cn("shrink-0 rounded-full border px-2.5 py-1 text-[11px]", source === f.id ? "border-primary bg-primary/15 text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {f.label}
          </button>
        ))}
      </div>
      {uploads.map((u) => (
        <div key={u.id} className="rounded-md border p-2 text-xs">
          <div className="flex items-center gap-2 truncate">
            <Loader2 className="size-3 animate-spin" /> {u.name}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${Math.round(u.p * 100)}%` }} />
          </div>
        </div>
      ))}
      {assets === null ? (
        <div className="flex justify-center py-8 text-muted-foreground">
          <Loader2 className="animate-spin" />
        </div>
      ) : shown.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          {assets.length ? "Nothing matches." : "Drop videos, photos or music here. Tagged uploads are matched to scenes automatically."}
        </div>
      ) : (
        <div className={cn("grid gap-2", compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5")}>
          {shown.map((a) => (
            <div
              key={a.id}
              {...(itemProps?.(a) ?? {})}
              className={cn("group relative overflow-hidden rounded-md border bg-muted/40", highlight && "cursor-pointer hover:ring-2 hover:ring-primary")}
            >
              <Thumb a={a} />
              <div className="flex items-center gap-1 p-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px]" title={a.name}>
                  {a.name}
                </span>
                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Edit tags" onClick={(e) => e.stopPropagation()}>
                      <Tag className="size-3" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-64 space-y-2 p-3" onClick={(e) => e.stopPropagation()}>
                    <p className="text-xs font-medium">Tags (comma separated)</p>
                    <Input defaultValue={a.tags.join(", ")} className="h-8 text-xs" onBlur={(e) => saveTags(a, e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
                    <Button variant="ghost" size="sm" className="w-full text-destructive" onClick={() => remove(a)}>
                      <Trash2 /> Delete from library
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
              {a.tags.length > 0 && !compact && <div className="truncate px-1.5 pb-1.5 text-[10px] text-muted-foreground">{a.tags.slice(0, 4).join(" · ")}</div>}
              {onClip && a.type === "video" && (
                <Button
                  size="icon"
                  variant="secondary"
                  className="absolute top-1 right-8 size-6 opacity-0 shadow group-hover:opacity-100"
                  aria-label="Pick in and out points"
                  title="Clip: pick in/out points (several segments)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClip(a);
                  }}
                >
                  <Scissors />
                </Button>
              )}
              {onAdd && (
                <Button
                  size="icon"
                  className="absolute top-1 right-1 size-6 opacity-0 shadow group-hover:opacity-100"
                  aria-label="Add at playhead"
                  title="Add at playhead"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd(a);
                  }}
                >
                  <Plus />
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Thumb({ a }: { a: AssetDTO }) {
  const Icon = a.type === "video" ? Film : a.type === "image" ? ImageIcon : a.type === "music" ? Music : Mic;
  const src = a.thumbUrl ?? (a.type === "image" ? a.url : null);
  return (
    <div className="relative aspect-video bg-black/40">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
      ) : (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <Icon className="size-6" />
        </div>
      )}
      <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/60 px-1 text-[10px] text-white">
        <Icon className="size-2.5" />
        {a.duration ? `${a.duration.toFixed(1)}s` : ""}
        {a.source === "pexels" ? " · Pexels" : a.source === "ai" ? " · AI" : a.source === "gemini_manual" ? " · Gemini" : ""}
      </span>
    </div>
  );
}
