import { gotchasPath } from "@/agent/config";
import { listGotchas } from "@/agent/rulesfile";
import { requireUserId, route } from "@/server/http";

/** gotchas.md for the Gotchas page: every technical problem as Problem / Why it happened / Fix. */
export const GET = route(async () => {
  await requireUserId();
  return { file: gotchasPath(), gotchas: listGotchas() };
});
