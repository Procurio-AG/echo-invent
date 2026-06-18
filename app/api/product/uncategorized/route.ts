import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;

function clampInt(value: string | null, fallback: number, min: number, max: number) {
  const n = value === null ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const skip = clampInt(url.searchParams.get("skip"), 0, 0, Number.MAX_SAFE_INTEGER);
  const take = clampInt(url.searchParams.get("take"), DEFAULT_TAKE, 1, MAX_TAKE);

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

  // Rows in the active session that have been touched at least once
  // (status <> 'pending') but still have no category assigned.
  const where = {
    session_id: session.id,
    category: null,
    status: { not: "pending" },
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { ean: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { name: "asc" },
      skip,
      take,
      select: {
        id: true,
        ean: true,
        name: true,
        category: true,
        purchase_price: true,
        selling_price: true,
        mrp: true,
        status: true,
        version: true,
        original_data: true,
      },
    }),
    prisma.product.count({ where }),
  ]);

  return NextResponse.json({ rows, total, skip, take });
}
