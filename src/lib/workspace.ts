"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Editor workspaces: per-person UI presets (theme, layout, shortcuts, quick AI actions), kept in this browser.
 * "mani" comes from Mani's editor brief: chat-first, phone-friendly, black & white, Premiere keys,
 * and one-tap prompts for the jobs he wants the AI to do.
 */
export type WorkspaceId = "default" | "mani";

export type QuickPrompt = { label: string; prompt: string };

export type Workspace = {
  id: WorkspaceId;
  label: string;
  mono: boolean; // black & white accent instead of the violet brand
  chatFirst: boolean; // open on the chat and give it a wider column
  premiereKeys: boolean; // C / Ctrl+K split, J K L transport
  quickPrompts: QuickPrompt[];
};

export const WORKSPACES: Record<WorkspaceId, Workspace> = {
  default: { id: "default", label: "Default", mono: false, chatFirst: false, premiereKeys: false, quickPrompts: [] },
  mani: {
    id: "mani",
    label: "Mani",
    mono: true,
    chatFirst: true,
    premiereKeys: true,
    quickPrompts: [
      { label: "Cut silences", prompt: "Cut every silence and dead pause longer than 0.4 s across the whole edit." },
      { label: "Cut to the beat", prompt: "Re-time the visual cuts so they land on the beats of the music track." },
      { label: "Grade & match", prompt: "Colour-grade the edit and match the colour of every clip so phone and camera footage look like one shoot." },
      { label: "Best takes", prompt: "Where I have several takes of the same moment, keep only the best one and drop the rest." },
      { label: "Stitch series", prompt: "Stitch all my clips into one continuous series in story order, with matching pacing." },
      { label: "Stabilise", prompt: "Stabilise the shaky clips." },
      { label: "Smooth transitions", prompt: "Make the transitions between clips smoother: match motion and direction across cuts and use short whip or blur transitions where a hard cut jars." },
      { label: "Speed ramp", prompt: "Add speed ramps on the action moments: ramp into slow motion on the peak, then back to normal speed, eased in and out." },
    ],
  },
};

export const useWorkspace = create<{ id: WorkspaceId; set(id: WorkspaceId): void }>()(
  persist((set) => ({ id: "default", set: (id) => set({ id }) }), { name: "reelsmith-workspace" }),
);

export const useWorkspaceConfig = () => WORKSPACES[useWorkspace((s) => s.id)] ?? WORKSPACES.default;
