import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirrors /api/product/list: a row "needs pricing" when it has been audited at
// least once and is still missing a price, OR a Float price column is NULL
// because the source cell held a non-numeric annotation (the per-column
// "AND <Float> IS NULL" guard lets a row drop once a real value is entered).
// "non-numerically filled" = Float NULL (guarded below) AND the source cell was
// non-empty. Import-aligned (see /api/product/list for the full rationale).
function sourceFilled(column: string) {
  return Prisma.sql`(
    original_data->>${column} IS NOT NULL
    AND btrim(original_data->>${column}) NOT IN ('', '-')
  )`;
}

export async function GET() {
  const session = await prisma.session.findFirst({
    where: { closed_at: null },
    orderBy: { started_at: "desc" },
  });

  if (!session) {
    return NextResponse.json({ session: null, stats: null });
  }

  const membership = Prisma.sql`(
    (status <> 'pending' AND (purchase_price IS NULL OR selling_price IS NULL))
    OR (purchase_price IS NULL AND ${sourceFilled("Purchase Price")})
    OR (selling_price IS NULL AND ${sourceFilled("Selling Price")})
    OR (mrp IS NULL AND ${sourceFilled("MRP")})
  )`;

  const [grouped, needsPricingRows] = await Promise.all([
    prisma.product.groupBy({
      by: ["status"],
      where: { session_id: session.id },
      _count: { _all: true },
    }),
    // Same combined worklist rule as /api/product/list so the dashboard badge
    // equals the count of rows the /pricing page shows.
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "Product"
      WHERE session_id = ${session.id} AND ${membership}
    `,
  ]);

  const needs_pricing = Number(needsPricingRows[0]?.count ?? 0);

  let pending = 0;
  let updated = 0;
  for (const row of grouped) {
    if (row.status === "updated") updated = row._count._all;
    else if (row.status === "pending") pending = row._count._all;
  }

  return NextResponse.json({
    session,
    stats: {
      total: pending + updated,
      pending,
      updated,
      needs_pricing,
    },
  });
}
