// GitHub REST client for "Render in cloud" (shared by the server and agent/cloud-render.ts; no "server-only").
// Token: CLOUD_RENDER_TOKEN in .env (fine-grained, the render repo only: Contents, Actions, Workflows read/write,
// Metadata read). It never reaches a claude child process (src/agent/config.ts strips it).

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const cloudToken = () => process.env.CLOUD_RENDER_TOKEN || "";

export async function gh<T = unknown>(path: string, init: RequestInit & { json?: unknown; raw?: boolean } = {}): Promise<T> {
  const token = cloudToken();
  if (!token) throw new GitHubError(401, "CLOUD_RENDER_TOKEN is not set in .env");
  const { json, raw, ...rest } = init;
  const r = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    ...rest,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ReelSmith-cloud-render",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    signal: rest.signal ?? AbortSignal.timeout(120_000),
  });
  if (raw) return r as unknown as T;
  const text = await r.text();
  if (!r.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* not json */
    }
    throw new GitHubError(r.status, `GitHub ${r.status}: ${msg.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

export interface RepoInfo {
  full_name: string;
  private: boolean;
  visibility?: string;
  default_branch: string;
  html_url: string;
  owner: { login: string; type: string };
  permissions?: { push?: boolean; admin?: boolean };
}

/** The repo must exist, be PRIVATE and writable with the token. Footage never goes to a public repo. */
export async function verifyPrivateRepo(repo: string): Promise<RepoInfo> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new GitHubError(400, "Set the render repo (owner/name) in Settings");
  let info: RepoInfo;
  try {
    info = await gh<RepoInfo>(`/repos/${repo}`);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) throw new GitHubError(404, `${repo} doesn't exist or the token can't see it. ReelSmith never creates repos: create a private one first.`);
    throw e;
  }
  if (!info.private || (info.visibility && info.visibility !== "private"))
    throw new GitHubError(403, `${repo} is ${info.visibility ?? "public"}. Footage is only ever uploaded to a PRIVATE repo: make it private or pick another.`);
  if (info.permissions && info.permissions.push === false) throw new GitHubError(403, `The token can't push to ${repo}`);
  return info;
}

/**
 * Free Actions minutes this month, when GitHub reports them (the billing endpoints need extra token permissions and
 * differ between plans): { used, included, remaining } or null.
 */
export async function actionsMinutes(owner: string, ownerType: string): Promise<{ used: number; included: number | null; remaining: number | null } | null> {
  const base = ownerType === "Organization" ? `/orgs/${owner}` : `/users/${owner}`;
  try {
    const b = await gh<{ total_minutes_used: number; included_minutes: number }>(`${base}/settings/billing/actions`);
    return { used: b.total_minutes_used, included: b.included_minutes, remaining: Math.max(0, b.included_minutes - b.total_minutes_used) };
  } catch {
    /* older endpoint retired or no permission: try the usage report */
  }
  try {
    const now = new Date();
    const u = await gh<{ usageItems?: { product: string; unitType: string; quantity: number }[] }>(`${base}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
    const used = (u.usageItems ?? []).filter((i) => i.product.toLowerCase() === "actions" && /minute/i.test(i.unitType)).reduce((n, i) => n + i.quantity, 0);
    return { used: Math.round(used), included: null, remaining: null };
  } catch {
    return null;
  }
}
