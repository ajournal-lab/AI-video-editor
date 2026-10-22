// Helpers for claude runs. ReelSmith always runs Claude Code on the user's Claude subscription (no other engine).
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Claude Code's messages when the subscription's usage limit is hit. */
export function usageLimitHit(text: string | null | undefined): { hit: boolean; resetsAt: number | null } {
  const t = String(text ?? "");
  if (!/usage limit|hit your limit|limit reached|limit will reset|out of (?:extra )?usage|rate[_ ]limit/i.test(t)) return { hit: false, resetsAt: null };
  const epoch = /\|(\d{10})\b/.exec(t); // "Claude AI usage limit reached|1760000000"
  return { hit: true, resetsAt: epoch ? Number(epoch[1]) * 1000 : null };
}

/** Does Claude Code have a transcript for this session id (so --resume works)? */
export function sessionExists(sessionId: string): boolean {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");
  try {
    return readdirSync(root).some((d) => existsSync(path.join(root, d, `${sessionId}.jsonl`)));
  } catch {
    return false;
  }
}
