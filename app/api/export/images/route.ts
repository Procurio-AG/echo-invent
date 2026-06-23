import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/prisma";
import { buildProductWhere } from "@/lib/product-filters";
import { downloadProductImage } from "@/lib/supabase";

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
};

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "jpg" : path.slice(dot + 1);
}

// POST — bundle the images of the selected products into a zip, one folder per EAN
// (<EAN>/1.jpg, <EAN>/2.jpg ...). Images stream from the PRIVATE bucket server-side,
// so the bucket never needs to be public. Mirrors the resolution logic of the xlsx
// export; does not mark exported (that belongs to the data export).
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

  const products = await prisma.product.findMany({
    where,
    select: {
      ean: true,
      images: {
        select: { path: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  });

  const zip = new JSZip();
  let fileCount = 0;
  let failed = 0;

  for (const p of products) {
    for (const img of p.images) {
      try {
        const bytes = await downloadProductImage(img.path);
        zip.file(`${p.ean}/${img.position + 1}.${extOf(img.path)}`, bytes);
        fileCount += 1;
      } catch {
        failed += 1; // skip unreadable object, keep going
      }
    }
  }

  if (fileCount === 0) {
    return NextResponse.json(
      { error: "No images to export for the selection.", code: "EMPTY" },
      { status: 404 }
    );
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `audit-images-${session.id.slice(0, 8)}-${stamp}.zip`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Image-Count": String(fileCount),
      "X-Image-Failed": String(failed),
      "Cache-Control": "no-store",
    },
  });
}
