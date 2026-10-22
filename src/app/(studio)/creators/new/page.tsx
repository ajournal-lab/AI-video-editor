import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CreatorForm } from "@/components/creators/CreatorForm";

export const metadata = { title: "New creator profile · ReelSmith" };

export default function Page() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start gap-3">
        <Link href="/creators" className="mt-1 rounded-md p-1.5 hover:bg-muted" aria-label="Back to creators">
          <ArrowLeft className="size-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New creator profile</h1>
          <p className="text-sm text-muted-foreground">Paste 5 public videos. ReelSmith measures their hooks, cut rhythm, captions, zooms, sound cues and layout, then checks how consistent they are.</p>
        </div>
      </div>
      <CreatorForm />
    </div>
  );
}
