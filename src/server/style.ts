import "server-only";
// The style layers on disk: the taste checklist's taste rules (in the reel-studio workspace), creator profiles
// (<creatorDir>/<handle>/style.json) and the brand kit (Settings). See src/lib/style/layers.ts for the priority.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { creatorDir } from "@/agent/config";
import { activeRules, addRule } from "@/agent/rulesfile";
import { ruleLine } from "@/lib/rules/md";
import { resolveStyle, TASTE_TOPICS, type CreatorStyleLite, type TasteRule } from "@/lib/style/layers";
import { HttpError } from "./http";
import { getSettings } from "./settings";

/** "@Some.Creator" -> "some.creator" (folder-safe). */
export function normHandle(h: string) {
  const v = h.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9._-]{1,60}$/.test(v)) throw new HttpError(400, `"${h}" is not a valid handle`);
  return v;
}

/** The active "Type: taste" rules of the taste checklist: they beat the brand kit, creator styles and defaults. */
export const tasteRules = (): TasteRule[] =>
  activeRules()
    .filter((r) => r.type === "taste")
    .map((r) => ({ id: r.id, date: r.added, topic: r.topic, text: ruleLine(r).replace(/^R\d+ \[[\w-]+\] /, "") }));

/** A taste rule typed by the user (Rules page / API): their words are the rule. */
export function appendTasteRule(rule: string, topic: string): TasteRule {
  const text = rule.replace(/\s+/g, " ").trim();
  if (text.length < 5) throw new HttpError(400, "The rule is too short");
  const t = (TASTE_TOPICS as readonly string[]).includes(topic) ? topic : "other";
  const r = addRule({ title: text.slice(0, 160), words: text, inPractice: text, topic: t, type: "taste" });
  return { id: r.id, date: r.added, topic: r.topic, text: r.title };
}

// ---------------------------------------------------------------- creators

export const creatorFolder = (handle: string) => path.join(creatorDir(), normHandle(handle));

export function readCreatorStyle(handle: string): (CreatorStyleLite & Record<string, unknown>) | null {
  try {
    const f = path.join(creatorFolder(handle), "style.json");
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")) : null;
  } catch {
    return null;
  }
}

/** Profiles that have a style.json (finished teardowns), newest first. */
export function listCreatorHandles(): { handle: string; updatedAt: string }[] {
  const root = creatorDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(root, d.name, "style.json")))
    .map((d) => ({ handle: d.name, updatedAt: statSync(path.join(root, d.name, "style.json")).mtime.toISOString() }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Everything a style pass needs to know about priority, for one user and creator. */
export async function styleLayers(userId: string, creator: string | null) {
  const settings = await getSettings(userId);
  const taste = tasteRules();
  const style = creator ? readCreatorStyle(creator) : null;
  const brand = settings.brandKit?.enabled ? settings.brandKit : null;
  return { taste, brand, creator: style, creatorHandle: creator ? normHandle(creator) : null, ...resolveStyle({ taste, brand, creator: style }) };
}
