"use client";

import { useState } from "react";
import { Copy, Loader2, RefreshCw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Info {
  url: string;
  qr: string;
  local: string;
  lan: { name: string; address: string }[];
}

/** "On my phone": the /m/<token> link to this PC on the Wi-Fi, as a QR code. */
export function PhoneLink() {
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (reset = false) => {
    setBusy(true);
    api<Info>("/api/phone", { method: "POST", json: { reset } })
      .then(setInfo)
      .catch((e) => toast.error(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <Popover onOpenChange={(o) => o && !info && load()}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" title="Watch the previews on your phone">
          <Smartphone /> Phone
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2 text-xs" align="end">
        <div className="font-medium">Previews on your phone</div>
        {!info ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <>
            {/* the SVG comes from our own server (qrcode package), not from user input */}
            <div className="mx-auto w-[220px] overflow-hidden rounded bg-white" dangerouslySetInnerHTML={{ __html: info.qr }} />
            <p className="text-muted-foreground">Scan with the phone camera (same Wi-Fi as this PC). Every render adds a 720p preview there.</p>
            <div className="flex items-center gap-1">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1">{info.url}</code>
              <Button size="icon" variant="ghost" className="size-7" onClick={() => navigator.clipboard.writeText(info.url).then(() => toast.success("Copied"))} aria-label="Copy link">
                <Copy />
              </Button>
            </div>
            {!info.lan.length && <p className="text-amber-300">No Wi-Fi/LAN address found: the link only works on this PC.</p>}
            <p className="text-muted-foreground">Doesn&apos;t open? Allow Node.js through Windows Firewall on private networks. Anyone with the link on your network can watch.</p>
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => load(true)}>
              <RefreshCw className="size-3" /> New link (old one stops working)
            </Button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
