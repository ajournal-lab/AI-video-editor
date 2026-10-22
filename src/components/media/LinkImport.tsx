"use client";

import { useState } from "react";
import { Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { importLink, type AssetDTO } from "@/lib/client/upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "Paste a link": YouTube / Shorts, TikTok, Instagram reels, Vimeo, X posts, Google Drive files ("Anyone with the
 * link") or a direct media URL. The server downloads it (yt-dlp), and a file already in the library comes back as is.
 */
export function LinkImport({ onImported, className, compact }: { onImported: (a: AssetDTO) => void; className?: string; compact?: boolean }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    const v = url.trim();
    if (!v || busy) return;
    setBusy(true);
    const t = toast.loading("Downloading… (long videos take a minute)");
    try {
      const a = await importLink(v);
      toast.success(a.duplicate ? `Already in your library: “${a.name}”` : `Imported “${a.name}”${a.meta?.uploader ? ` by ${a.meta.uploader}` : ""}`, { id: t });
      setUrl("");
      onImported(a);
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={cn("flex gap-1.5", className)}
      onSubmit={(e) => {
        e.preventDefault();
        go();
      }}
    >
      <Input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={compact ? "…or paste a link" : "Paste a link: YouTube, TikTok, Instagram, Vimeo, X, Google Drive"}
        className="h-8 text-xs"
        disabled={busy}
        aria-label="Import from a link"
      />
      <Button type="submit" size="sm" variant="secondary" className="h-8" disabled={busy || !url.trim()} title="Import from the link">
        {busy ? <Loader2 className="animate-spin" /> : <Link2 />}
      </Button>
    </form>
  );
}
