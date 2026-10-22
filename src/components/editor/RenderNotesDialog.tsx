"use client";

import { useEffect, useState } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useChat } from "@/components/chat/store";
import { useEditor } from "@/components/editor/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * After a render: notes on this draft. They go through the chat like any feedback (taste checklist R2): Claude first files
 * each note as a rule in your words, asks when a note contradicts a rule (R6), then fixes the edit at the cause (R4).
 */
export function RenderNotesDialog({ projectId, version, open, onOpenChange }: { projectId: string; version: string | null; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [notes, setNotes] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) setNotes("");
  }, [open]);

  const send = async () => {
    setSending(true);
    try {
      await api(`/api/projects/${projectId}/chat`, {
        method: "POST",
        json: { text: `Notes on ${version ?? "the latest render"}:\n${notes.trim()}`, source: "render", json: useEditor.getState().timeline },
      });
      await useChat.getState().refresh();
      toast.success("Sent to the chat: your notes become rules first, then Claude fixes the edit");
      onOpenChange(false);
      useEditor.getState().setPanel("chat");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Notes on {version ?? "this render"}</DialogTitle>
          <DialogDescription>
            What did you like or dislike? Each note is saved in your taste checklist in your own words before anything changes, then Claude
            fixes the cause everywhere in the video. Taste rules beat creator styles and the brand kit.
          </DialogDescription>
        </DialogHeader>
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="e.g. the captions were too busy, I want max 3 words and the highlight in yellow" />
        <Button onClick={send} disabled={notes.trim().length < 3 || sending}>
          {sending ? <Loader2 className="animate-spin" /> : <MessageSquarePlus />} Send notes
        </Button>
      </DialogContent>
    </Dialog>
  );
}
