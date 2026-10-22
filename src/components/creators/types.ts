import type { CreatorStyle } from "@/agent/schemas";
import type { AgentJobDTO } from "@/lib/client/agent";

export type { CreatorStyle };

export interface CreatorListItem {
  handle: string;
  platform: string | null;
  status: "measuring" | "analysing" | "ready" | "failed";
  error: string | null;
  summary: string | null;
  videos: number;
  mismatches: number | null;
  thumb: string | null;
  updatedAt: string | null;
}

export interface Measured {
  id: string;
  url?: string | null;
  title?: string | null;
  uploader?: string | null;
  durationSec?: number;
  avgShotSec?: number;
  cutsPerSec?: number;
  cutsFirst2s?: number;
  cutsFirst3s?: number;
  wordsPerMin?: number;
  hook?: string;
  punchInsPerMin?: number;
  smoothZoomsPerMin?: number;
  soundCuesPerMin?: number;
  frames?: Record<string, { file: string; t: number }>;
  sheets?: { hook: string; all: string };
  [k: string]: unknown;
}

export interface ConsistencyRow {
  metric: string;
  label: string;
  kind: "numeric" | "categorical";
  reference: string;
  values: { id: string; value: string; verdict: "OK" | "MISMATCH" }[];
  verdict: "CONSISTENT" | "MISMATCH";
  note: string;
}

export interface CreatorDetail {
  handle: string;
  meta: {
    handle: string;
    platform: "tiktok" | "youtube";
    urls: string[] | null;
    notes: string;
    status: CreatorListItem["status"];
    error: string | null;
    replacing?: string | null;
    source?: string;
    createdAt: string;
    updatedAt: string;
    measureJobId: string | null;
    analysisJobId: string | null;
  } | null;
  jobs: AgentJobDTO[];
  progress: { updatedAt: string; videos: { index: number; url: string; id: string | null; title: string | null; stage: string; error: string | null }[] } | null;
  verdicts: { id: string; verdict: "MATCH" | "MISMATCH"; reasons: string[] }[];
  overrides: { rules: { id: string; topic: string; text: string; date: string | null }[]; replaced: { topic: string; rule: string; ruleText: string; creatorValue: string | null }[] };
  measuredStyle: CreatorStyle | null;
  style: (CreatorStyle & { consistency?: ConsistencyRow[] }) | null;
  teardownMd: string | null;
  measurements: { videos: Measured[]; aggregate: Record<string, { median: number; mean: number }> } | null;
}

export const fileUrl = (handle: string, rel: string) => `/api/creators/${encodeURIComponent(handle)}/file?path=${encodeURIComponent(rel)}`;
