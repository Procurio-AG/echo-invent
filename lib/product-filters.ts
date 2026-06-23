import { Prisma } from "@prisma/client";

// "Complete" = every mandatory audit field is filled: category, purchase_price (PP),
// selling_price (SP), mrp, name, ean. EAN is the unique key so it is always present;
// the rest are guarded here. Shared by the worklist filter and the flexible export.
export const COMPLETE_WHERE: Prisma.ProductWhereInput = {
  category: { not: null },
  purchase_price: { not: null },
  selling_price: { not: null },
  mrp: { not: null },
  name: { not: "" },
};

export const INCOMPLETE_WHERE: Prisma.ProductWhereInput = {
  OR: [
    { category: null },
    { purchase_price: null },
    { selling_price: null },
    { mrp: null },
    { name: "" },
  ],
};

// Build the shared product WHERE for the worklist and the exports. Independent
// conditions are composed via AND so the search's OR and the "incomplete" OR never
// clobber one another. `ids`, when present, takes precedence over the filters.
export function buildProductWhere(
  sessionId: string,
  opts: {
    ids?: string[];
    q?: string;
    category?: string;
    exported?: boolean;
    complete?: boolean;
  }
): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  const where: Prisma.ProductWhereInput = { session_id: sessionId, AND: and };

  if (opts.ids && opts.ids.length > 0) {
    where.id = { in: opts.ids };
    return where;
  }
  if (opts.category) where.category = opts.category;
  if (opts.exported === true) where.exported_at = { not: null };
  if (opts.exported === false) where.exported_at = null;
  if (opts.complete === true) and.push(COMPLETE_WHERE);
  if (opts.complete === false) and.push(INCOMPLETE_WHERE);
  if (opts.q) {
    and.push({
      OR: [
        { name: { contains: opts.q, mode: "insensitive" } },
        { ean: { contains: opts.q, mode: "insensitive" } },
      ],
    });
  }
  return where;
}

export function isComplete(p: {
  category: string | null;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
  name: string;
  ean: string;
}): boolean {
  return (
    !!p.category &&
    p.purchase_price !== null &&
    p.selling_price !== null &&
    p.mrp !== null &&
    !!p.name.trim() &&
    !!p.ean.trim()
  );
}
