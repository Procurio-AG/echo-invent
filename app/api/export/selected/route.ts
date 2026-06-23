import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildAuditXlsx } from "@/lib/xlsx-export";
import { buildProductWhere, isComplete } from "@/lib/product-filters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Filter = {
  q?: string;
  category?: string;
  exported?: boolean;
  complete?: boolean;
};

type Body = {
  ids?: string[];
  filter?: Filter;
  requireComplete?: boolean;
  markExported?: boolean;
};

// POST — flexible export of the worklist. Either an explicit `ids` selection or a
// `filter` resolves the target set; `requireComplete` drops rows missing a mandatory
// field; `markExported` (default true) stamps exported_at so the worklist's
// "Exported before" column flips.
export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

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

  const hasIds = Array.isArray(body.ids) && body.ids.length > 0;
  if (!hasIds && !body.filter) {
    return NextResponse.json({ error: "Provide ids or a filter." }, { status: 400 });
  }
  const where = buildProductWhere(session.id, {
    ids: hasIds ? body.ids : undefined,
    q: body.filter?.q,
    category: body.filter?.category,
    exported: body.filter?.exported,
    complete: body.filter?.complete,
  });

  let products = await prisma.product.findMany({
    where,
    orderBy: [{ category: "asc" }, { name: "asc" }],
    include: { images: { orderBy: { position: "asc" } } },
  });

  if (body.requireComplete) {
    products = products.filter(isComplete);
  }

  if (products.length === 0) {
    return NextResponse.json(
      { error: "No matching rows to export.", code: "EMPTY" },
      { status: 404 }
    );
  }

  const buffer = buildAuditXlsx(products, { includeExtras: true, sheetName: "Export" });

  if (body.markExported !== false) {
    await prisma.product.updateMany({
      where: { id: { in: products.map((p) => p.id) } },
      data: { exported_at: new Date() },
    });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `audit-${session.id.slice(0, 8)}-${stamp}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Exported-Count": String(products.length),
      "Cache-Control": "no-store",
    },
  });
}
