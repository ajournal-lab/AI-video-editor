"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { findClip } from "@/lib/timeline/derive";
import type { AssetDTO } from "@/lib/client/upload";
import { MediaLibrary } from "@/components/media/MediaLibrary";
import { Button } from "@/components/ui/button";
import { useEditor } from "../store";
import { addPayload, dragProps, replaceClipMedia } from "../dnd";
import { VideoClipper } from "./VideoClipper";

function replaceWith(asset: AssetDTO) {
  const s = useEditor.getState();
  if (s.replaceTarget && replaceClipMedia(s.replaceTarget, asset)) {
    s.setReplaceTarget(null);
    toast.success("Media replaced");
  }
}

export function MediaPanel() {
  const assetsMap = useEditor((s) => s.assets);
  const replaceTarget = useEditor((s) => s.replaceTarget);
  const targetName = useEditor((s) => (s.replaceTarget ? findClip(s.timeline, s.replaceTarget)?.clip : null));
  const assets = Object.values(assetsMap).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const setAssets = (fn: (a: AssetDTO[] | null) => AssetDTO[] | null) => useEditor.getState().setAssets(fn(assets) ?? []);
  // Uploads made inside the editor go straight onto the timeline (or into the clip being replaced).
  const onUploaded = (a: AssetDTO) => {
    const s = useEditor.getState();
    if (s.replaceTarget) return replaceWith(a);
    if (a.type === "audio") return toast.success(`${a.name} saved to your library`);
    const at = a.type === "music" ? 0 : s.playhead;
    addPayload({ kind: "asset", asset: a }, null, at)
      .then(() => toast.success(`${a.name} added to the timeline at ${at.toFixed(1)}s`, { description: "Drag it to move, or undo with Ctrl+Z" }))
      .catch((e) => toast.error(e.message));
  };
  const add = (a: AssetDTO) => addPayload({ kind: "asset", asset: a }, null, useEditor.getState().playhead).catch((e) => toast.error(e.message));
  const [clipping, setClipping] = useState<AssetDTO | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {replaceTarget && (
        <div className="m-3 mb-0 flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 p-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            Pick new media for <b>{targetName && "name" in targetName ? targetName.name : "clip"}</b>
          </span>
          <Button variant="ghost" size="icon" className="size-6" onClick={() => useEditor.getState().setReplaceTarget(null)} aria-label="Cancel">
            <X />
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <MediaLibrary
          compact
          assets={assets}
          setAssets={setAssets}
          onAdd={replaceTarget ? undefined : add}
          onClip={replaceTarget ? undefined : setClipping}
          highlight={replaceTarget ?? undefined}
          onUploaded={onUploaded}
          itemProps={(a) =>
            replaceTarget ? { onClick: () => replaceWith(a) } : a.type === "audio" && a.source === "sample" ? {} : dragProps({ kind: "asset", asset: a })
          }
        />
      </div>
      {clipping && <VideoClipper key={clipping.id} asset={clipping} open onOpenChange={(v) => !v && setClipping(null)} />}
    </div>
  );
}
