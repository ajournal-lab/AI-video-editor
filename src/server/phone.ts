import "server-only";
// Phone review: /m/<token> lists the user's latest phone previews (720p, low bitrate) without a login, so it opens on
// a phone on the same Wi-Fi (http://<this PC's LAN address>:<port>/m/<token>). The token is random and can be reset.
import crypto from "node:crypto";
import os from "node:os";
import { prisma } from "./db";
import { getSettings, saveSettings } from "./settings";

export async function phoneToken(userId: string, reset = false) {
  const s = await getSettings(userId);
  if (s.phoneToken && !reset) return s.phoneToken;
  const token = crypto.randomBytes(18).toString("base64url");
  await saveSettings(userId, { phoneToken: token });
  return token;
}

/** This machine's private IPv4 addresses (Wi-Fi / Ethernet first). */
export function lanAddresses() {
  const out: { name: string; address: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push({ name, address: a.address });
  const rank = (n: string) => (/wi-?fi|wlan|wireless/i.test(n) ? 0 : /ethernet|eth|en\d/i.test(n) ? 1 : /vethernet|virtual|vmware|vbox|wsl|docker|hyper-v/i.test(n) ? 3 : 2);
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}

export async function phoneFeed(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
  const users = await prisma.user.findMany({ where: { settings: { path: ["phoneToken"], equals: token } }, select: { id: true } });
  if (users.length !== 1) return null;
  const renders = await prisma.renderJob.findMany({
    where: { userId: users[0].id, status: "done", previewUrl: { not: null } },
    orderBy: { finishedAt: "desc" },
    take: 30,
    select: {
      id: true,
      previewUrl: true,
      thumbUrl: true,
      duration: true,
      finishedAt: true,
      project: { select: { id: true, title: true } },
      version: { select: { number: true, name: true, notes: true } },
    },
  });
  return renders;
}
