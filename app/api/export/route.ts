import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/prisma";
import { resolveHeaders } from "@/lib/xlsx-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedSessionId = url.searchParams.get("session_id");

  const session = requestedSessionId
    ? await prisma.session.findUnique({ where: { id: requestedSessionId } })
    : await prisma.session.findFirst({
        where: { closed_at: null },
        orderBy: { started_at: "desc" },
      });

  if (!session) {
    return NextResponse.json(
      { error: requestedSessionId ? "Session not found." : "No active session." },
      { status: 404 }
    );
  }

  const products = await prisma.product.findMany({
    where: { session_id: session.id, status: "updated" },
    orderBy: { updated_at: "asc" },
  });

  if (products.length === 0) {
    return NextResponse.json({ error: "No updated rows to export." }, { status: 404 });
  }

  const firstOriginal = products[0].original_data as Record<string, unknown>;
  const headers = resolveHeaders(firstOriginal);

  const rows = products.map((p) => {
    const original = { ...(p.original_data as Record<string, unknown>) };
    if (headers.purchase_price) original[headers.purchase_price] = p.purchase_price;
    if (headers.selling_price) original[headers.selling_price] = p.selling_price;
    if (headers.mrp) original[headers.mrp] = p.mrp;
    return original;
  });

  const sheet = XLSX.utils.json_to_sheet(rows, {
    header: Object.keys(firstOriginal),
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Updated");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `audit-${session.id.slice(0, 8)}-${stamp}.xlsx`;

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
