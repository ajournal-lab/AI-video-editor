"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useChat } from "./store";

const MAX_SECONDS = 180;

/**
 * Chat voice notes: record with the browser's MediaRecorder, upload, and the server transcribes them locally
 * (faster-whisper in the worker venv) before they go through the chat like a typed note.
 */
export function useVoiceNote(projectId: string) {
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    rec.current?.stream.getTracks().forEach((t) => t.stop());
    rec.current = null;
    setRecording(false);
  };
  useEffect(() => cleanup, []);

  const upload = async (blob: Blob) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.append("audio", blob, "voice-note.webm");
      const res = await fetch(`/api/projects/${projectId}/chat/voice`, { method: "POST", body: form });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Upload failed (${res.status})`);
      await useChat.getState().refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        const blob = new Blob(chunks.current, { type: (r.mimeType || "audio/webm").split(";")[0] });
        cleanup();
        if (blob.size > 1000) upload(blob);
      };
      rec.current = r;
      r.start(1000);
      setSeconds(0);
      setRecording(true);
      timer.current = setInterval(() => {
        setSeconds((s) => {
          if (s + 1 >= MAX_SECONDS) rec.current?.stop();
          return s + 1;
        });
      }, 1000);
    } catch {
      toast.error("No microphone access: allow it for this site and try again");
      cleanup();
    }
  };

  return { recording, uploading, seconds, start, stop: () => rec.current?.stop() };
}
