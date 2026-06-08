import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const session = await prisma.session.findFirst({
    where: { closed_at: null },
    orderBy: { started_at: "desc" },
  });

  if (!session) {
    return NextResponse.json({ error: "No active session." }, { status: 404 });
  }

  const closed = await prisma.session.update({
    where: { id: session.id },
    data: { closed_at: new Date() },
  });

  return NextResponse.json({ session: closed });
}
