import { open, stat } from "node:fs/promises";
import { prisma } from "@/server/db";
import { jobDTO } from "@/server/agent";
import { HttpError, requireUserId, type Ctx } from "@/server/http";
import { toEvents } from "@/agent/events";

export const dynamic = "force-dynamic";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/**
 * Server-sent events for one job: tails its stream-json log and sends condensed
 * events ({k: "text" | "tool" | ...}) plus status updates. Resumable: the event id
 * is the byte offset, so EventSource reconnects with Last-Event-ID and skips what it saw.
 */
export async function GET(req: Request, ctx: Ctx<{ id: string }>) {
  let userId: string;
  try {
    userId = await requireUserId();
  } catch (e) {
    return new Response((e as Error).message, { status: (e as HttpError).status ?? 401 });
  }
  const { id } = await ctx.params;
  const job = await prisma.agentJob.findFirst({ where: { id, userId } });
  if (!job) return new Response("Job not found", { status: 404 });

  let offset = Number(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("offset") ?? 0) || 0;
  const enc = new TextEncoder();
  let closed = false;
  req.signal.addEventListener("abort", () => (closed = true));

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown, eventId?: number) => {
        if (closed) return;
        controller.enqueue(enc.encode(`${eventId !== undefined ? `id: ${eventId}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      let lastStatus = "";
      let pending = "";
      let idle = 0;
      try {
        while (!closed) {
          const row = await prisma.agentJob.findUnique({ where: { id } });
          if (!row) break;
          const key = row.status;
          if (key !== lastStatus) {
            send("status", jobDTO(row));
            lastStatus = key;
          }
          // read new complete lines from the log
          let grew = false;
          const size = await stat(row.logPath).then((s) => s.size).catch(() => 0);
          if (size > offset) {
            const fh = await open(row.logPath, "r");
            try {
              const buf = Buffer.alloc(Math.min(size - offset, 4 * 1024 * 1024));
              const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
              pending += buf.subarray(0, bytesRead).toString("utf8");
              offset += bytesRead;
              grew = true;
            } finally {
              await fh.close();
            }
            let nl: number;
            let consumed = offset - Buffer.byteLength(pending, "utf8");
            while ((nl = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, nl);
              pending = pending.slice(nl + 1);
              consumed += Buffer.byteLength(line, "utf8") + 1;
              const events = toEvents(line);
              if (events.length) send("events", events, consumed);
            }
          }
          if (TERMINAL.has(row.status) && !grew) {
            send("end", jobDTO(row));
            break;
          }
          idle = grew ? 0 : idle + 1;
          if (idle % 30 === 29) controller.enqueue(enc.encode(": ping\n\n")); // keep proxies from closing the connection
          await new Promise((r) => setTimeout(r, grew ? 150 : 500));
        }
      } catch (err) {
        send("error", { message: (err as Error).message });
      } finally {
        if (!closed) controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" },
  });
}
