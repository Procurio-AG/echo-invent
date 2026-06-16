import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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

// The set of rows the pricing worklist surfaces. A row qualifies when EITHER:
//   1. it has been audited at least once (status <> 'pending') and is still
//      missing a purchase or selling price; OR
//   2. one of its Float price columns is NULL *because* the source cell held a
//      non-numeric annotation (e.g. "check") — the raw text survives only in
//      original_data. The per-column "AND <Float> IS NULL" guard is REQUIRED so
//      the row drops out the moment a real numeric value is entered (a stale
//      'check' in original_data must never pin it forever).
//
// A price column is "non-numerically filled" when its source cell held text the
// importer could not turn into a number. The importer (lib/xlsx-import.ts) writes
// NULL into the Float column whenever Number(comma-stripped text) is NaN — so the
// reliable, import-aligned test is: the Float is NULL (guarded at each call site
// below) AND the raw source cell was non-empty (not blank, not a lone '-'). This
// catches "check", "₹99.50", "n/a", etc. without re-implementing Number() in SQL,
// and never flags a value that actually parsed (its Float would be set, not NULL).
// column is a fixed original_data JSON key, passed as a bind param — not concat'd.
function sourceFilled(column: string) {
  return Prisma.sql`(
    original_data->>${column} IS NOT NULL
    AND btrim(original_data->>${column}) NOT IN ('', '-')
  )`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category")?.trim() ?? "";
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

  // ── Build the shared WHERE as parameterised SQL fragments. ─────────────────
  const ppFlag = sourceFilled("Purchase Price");
  const spFlag = sourceFilled("Selling Price");
  const mrpFlag = sourceFilled("MRP");

  const membership = Prisma.sql`(
    (status <> 'pending' AND (purchase_price IS NULL OR selling_price IS NULL))
    OR (purchase_price IS NULL AND ${ppFlag})
    OR (selling_price IS NULL AND ${spFlag})
    OR (mrp IS NULL AND ${mrpFlag})
  )`;

  const filters: Prisma.Sql[] = [
    Prisma.sql`session_id = ${session.id}`,
    membership,
  ];

  if (category) {
    filters.push(Prisma.sql`category = ${category}`);
  }

  if (q) {
    const like = `%${q}%`;
    filters.push(
      Prisma.sql`(name ILIKE ${like} OR ean ILIKE ${like})`
    );
  }

  const whereSql = Prisma.join(filters, " AND ");

  type Row = {
    id: string;
    session_id: string;
    ean: string;
    name: string;
    category: string | null;
    purchase_price: number | null;
    selling_price: number | null;
    mrp: number | null;
    status: string;
    version: number;
    // Raw source annotations, surfaced ONLY when that column matched the
    // non-numeric predicate (else NULL). Coalesced into the flags object below.
    flag_purchase_price: string | null;
    flag_selling_price: string | null;
    flag_mrp: string | null;
  };

  const [rawRows, countRows] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT
        id,
        session_id,
        ean,
        name,
        category,
        purchase_price,
        selling_price,
        mrp,
        status,
        version,
        CASE WHEN purchase_price IS NULL AND ${ppFlag}
             THEN original_data->>'Purchase Price' END AS flag_purchase_price,
        CASE WHEN selling_price IS NULL AND ${spFlag}
             THEN original_data->>'Selling Price' END AS flag_selling_price,
        CASE WHEN mrp IS NULL AND ${mrpFlag}
             THEN original_data->>'MRP' END AS flag_mrp
      FROM "Product"
      WHERE ${whereSql}
      ORDER BY category ASC NULLS LAST, name ASC
      OFFSET ${skip}
      LIMIT ${take}
    `,
    prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM "Product"
      WHERE ${whereSql}
    `,
  ]);

  const rows = rawRows.map((r) => {
    const flags: {
      purchase_price?: string;
      selling_price?: string;
      mrp?: string;
    } = {};
    if (r.flag_purchase_price !== null) flags.purchase_price = r.flag_purchase_price;
    if (r.flag_selling_price !== null) flags.selling_price = r.flag_selling_price;
    if (r.flag_mrp !== null) flags.mrp = r.flag_mrp;

    return {
      id: r.id,
      session_id: r.session_id,
      ean: r.ean,
      name: r.name,
      category: r.category,
      purchase_price: r.purchase_price,
      selling_price: r.selling_price,
      mrp: r.mrp,
      status: r.status,
      version: r.version,
      flags,
    };
  });

  const total = Number(countRows[0]?.count ?? 0);

  return NextResponse.json({ rows, total, skip, take });
}
