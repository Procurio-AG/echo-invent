import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseWorkbook, XlsxImportError } from "@/lib/xlsx-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field." }, { status: 400 });
  }

  let parsed;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    parsed = parseWorkbook(buffer);
  } catch (err) {
    if (err instanceof XlsxImportError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to parse workbook." }, { status: 400 });
  }

  const { rows, skippedNoEan, totalDataRows } = parsed;

  const session =
    (await prisma.session.findFirst({ where: { closed_at: null } })) ??
    (await prisma.session.create({ data: { source_filename: file.name } }));

  if (rows.length === 0) {
    return NextResponse.json({
      sessionId: session.id,
      inserted: 0,
      refreshed: 0,
      skippedLocked: 0,
      skippedNoEan,
      totalDataRows,
    });
  }

  const eans = rows.map((r) => r.ean);
  const existing = await prisma.product.findMany({
    where: { session_id: session.id, ean: { in: eans } },
    select: { ean: true, status: true },
  });
  const existingByEan = new Map(existing.map((e) => [e.ean, e.status]));

  const newRows: typeof rows = [];
  const refreshRows: typeof rows = [];
  let skippedLocked = 0;

  for (const row of rows) {
    const status = existingByEan.get(row.ean);
    if (status === undefined) newRows.push(row);
    else if (status === "updated") skippedLocked += 1;
    else refreshRows.push(row);
  }

  let inserted = 0;
  if (newRows.length > 0) {
    const result = await prisma.product.createMany({
      data: newRows.map((r) => ({
        session_id: session.id,
        ean: r.ean,
        name: r.name,
        purchase_price: r.purchase_price,
        selling_price: r.selling_price,
        mrp: r.mrp,
        original_data: r.original_data as Prisma.InputJsonValue,
      })),
      skipDuplicates: true,
    });
    inserted = result.count;
  }

  let refreshed = 0;
  if (refreshRows.length > 0) {
    await prisma.$transaction(
      refreshRows.map((r) =>
        prisma.product.update({
          where: { session_id_ean: { session_id: session.id, ean: r.ean } },
          data: {
            name: r.name,
            purchase_price: r.purchase_price,
            selling_price: r.selling_price,
            mrp: r.mrp,
            original_data: r.original_data as Prisma.InputJsonValue,
          },
        })
      )
    );
    refreshed = refreshRows.length;
  }

  return NextResponse.json({
    sessionId: session.id,
    inserted,
    refreshed,
    skippedLocked,
    skippedNoEan,
    totalDataRows,
  });
}
