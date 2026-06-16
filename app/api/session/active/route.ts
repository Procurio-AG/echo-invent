import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await prisma.session.findFirst({
    where: { closed_at: null },
    orderBy: { started_at: "desc" },
  });

  if (!session) {
    return NextResponse.json({ session: null, stats: null });
  }

  const grouped = await prisma.product.groupBy({
    by: ["status"],
    where: { session_id: session.id },
    _count: { _all: true },
  });

  let pending = 0;
  let updated = 0;
  let captured = 0;
  for (const row of grouped) {
    if (row.status === "updated") updated = row._count._all;
    else if (row.status === "pending") pending = row._count._all;
    else if (row.status === "captured") captured = row._count._all;
  }

  return NextResponse.json({
    session,
    stats: {
      total: pending + captured + updated,
      pending,
      captured,
      updated,
    },
  });
}
