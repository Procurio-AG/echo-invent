import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildAuditXlsx } from "@/lib/xlsx-export";

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

  const buffer = buildAuditXlsx(products, { sheetName: "Updated" });

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
