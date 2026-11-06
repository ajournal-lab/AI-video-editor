import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import type { Timeline } from "@/lib/timeline/types";
import { prisma } from "@/server/db";
import { settleMattes } from "@/server/matte";
import { Editor } from "@/components/editor/Editor";
import { Processing } from "@/components/dashboard/Processing";
import { AgentBanner } from "@/components/site/AgentBanner";
import { PlanScreen } from "@/components/plan/PlanScreen";

const PLAN_MODES = ["music", "talking_head", "best_take", "voiceover_broll", "auto_clip"];
const PLAN_STATUSES = ["draft", "planning", "review", "plan_failed"]; // draft = started in the chat, nothing planned yet

export const metadata = { title: "Editor · AJOURNALLAB Studio" };

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const { id } = await params;
  const project = await prisma.project.findFirst({
    where: { id, userId: session.user.id },
    include: { timeline: true, voice: { select: { status: true, error: true } } },
  });
  if (!project) notFound();
  if (PLAN_MODES.includes(project.mode) && PLAN_STATUSES.includes(project.status)) {
    return (
      <div className="min-h-dvh">
        <AgentBanner />
        <PlanScreen projectId={project.id} />
      </div>
    );
  }
  const editable = (project.status === "ready" || project.status === "rendered") && project.timeline;
  if (!editable) {
    return <Processing projectId={project.id} title={project.title} initialStatus={project.status} />;
  }
  // background swap: mattes that finished while the editor was closed switch on now
  const settled = await settleMattes(project.id, project.timeline!.json as unknown as Timeline);
  if (settled.changed) project.timeline = (await prisma.timeline.findUnique({ where: { projectId: project.id } }))!;
  return (
    <div className="flex h-dvh flex-col">
      <AgentBanner />
      <div className="min-h-0 flex-1">
        <Editor
          project={{ id: project.id, title: project.title }}
          timeline={project.timeline!.json as unknown as Timeline}
          revision={project.timeline!.revision}
        />
      </div>
    </div>
  );
}
