import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildProductWhere, isComplete } from "@/lib/product-filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TAKE = 100;
const MAX_TAKE = 200;

function clampInt(value: string | null, fallback: number, min: number, max: number) {
  const n = value === null ? NaN : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

// GET — the worklist: every product in the active session with its image count and
// export status, filterable by search / category / exported (yes/no) / complete.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  const category = url.searchParams.get("category")?.trim() ?? "";
  const exported = url.searchParams.get("exported"); // "true" | "false" | null
  const complete = url.searchParams.get("complete"); // "true" | "false" | null
  const images = url.searchParams.get("images"); // "none" | null
  const expiry = url.searchParams.get("expiry"); // "none" | null
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

  const where = buildProductWhere(session.id, {
    q: q || undefined,
    category: category || undefined,
    exported: exported === "true" ? true : exported === "false" ? false : undefined,
    complete: complete === "true" ? true : complete === "false" ? false : undefined,
    hasImages: images === "none" ? false : undefined,
    hasExpiry: expiry === "none" ? false : undefined,
  });

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ category: "asc" }, { name: "asc" }],
      skip,
      take,
      include: { images: { select: { id: true, position: true }, orderBy: { position: "asc" } } },
    }),
    prisma.product.count({ where }),
  ]);

  const rows = products.map((p) => ({
    id: p.id,
    ean: p.ean,
    name: p.name,
    category: p.category,
    purchase_price: p.purchase_price,
    selling_price: p.selling_price,
    mrp: p.mrp,
    batch: p.batch,
    expiry_date: p.expiry_date ? p.expiry_date.toISOString().slice(0, 10) : null,
    status: p.status,
    version: p.version,
    exported_at: p.exported_at ? p.exported_at.toISOString() : null,
    exported: p.exported_at !== null,
    image_count: p.images.length,
    images: p.images,
    complete: isComplete(p),
  }));

  return NextResponse.json({ rows, total, skip, take });
}
