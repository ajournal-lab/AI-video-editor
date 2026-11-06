// Prints a render pool join code for a teammate's PC: `npm run pool:code`.
// The code carries the shared database and file storage logins, so send it only to people you trust, privately.
import { readFileSync } from "node:fs";

const env = {};
for (const raw of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("=");
  env[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
}
const pick = (k) => (env[k] ?? process.env[k] ?? "").trim();
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const db = pick("DATABASE_URL");
if (!db) fail("DATABASE_URL is not set in .env.");
if (/@(localhost|127\.0\.0\.1)[:/]/.test(db)) fail("DATABASE_URL points at this computer. Use the shared (hosted) database, e.g. Neon, so other PCs can reach it.");
if (!pick("R2_BUCKET") || !pick("R2_ACCESS_KEY_ID")) fail("Set the R2_* storage settings in .env first: pool PCs need shared file storage to fetch uploads and return exports.");

const payload = { STORAGE_DRIVER: "r2" };
for (const k of ["DATABASE_URL", "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL", "R2_ENDPOINT", "WEB_URL"]) {
  if (pick(k)) payload[k] = pick(k);
}
console.log("Render pool join code (keep it private; it contains your database and storage logins):\n");
console.log("RSPOOL1:" + Buffer.from(JSON.stringify(payload)).toString("base64url"));
