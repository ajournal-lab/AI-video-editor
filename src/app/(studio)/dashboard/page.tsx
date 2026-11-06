import { auth } from "@/auth";
import { prisma } from "@/server/db";
import { ProjectGrid, type ProjectCard } from "@/components/dashboard/ProjectGrid";

export const metadata = { title: "Projects · AJOURNALLAB Studio" };

export default async function DashboardPage() {
  const session = await auth();
  const projects = await prisma.project.findMany({
    where: { userId: session!.user.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      aspect: true,
      status: true,
      statusMessage: true,
      thumbnailUrl: true,
      duration: true,
      isSample: true,
      updatedAt: true,
      _count: { select: { renders: true } },
    },
  });
  const cards: ProjectCard[] = projects.map((p) => ({ ...p, updatedAt: p.updatedAt.toISOString(), renders: p._count.renders }));
  return <ProjectGrid initial={cards} />;
}
