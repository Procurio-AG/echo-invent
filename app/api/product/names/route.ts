import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAMES = 1000;

export async function GET() {
  const session = await prisma.session.findFirst({
    where: { closed_at: null },
    orderBy: { started_at: "desc" },
  });
  if (!session) {
    return NextResponse.json(
      { error: "No active session.", code: "NO_ACTIVE_SESSION" },
      { status: 409 }
    );
  }

  // Distinct across ALL sessions so canonical spellings learned in past audits
  // assist the current one. Dedup case-insensitively in JS (DB distinct is
  // case-sensitive) and cap the list.
  const rows = await prisma.product.findMany({
    where: { name: { not: "" } },
    select: { name: true },
    distinct: ["name"],
    orderBy: { name: "asc" },
    take: MAX_NAMES * 4, // over-fetch; case-insensitive dedup trims below
  });

  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(r.name);
    if (names.length >= MAX_NAMES) break;
  }

  return NextResponse.json({ names });
}
