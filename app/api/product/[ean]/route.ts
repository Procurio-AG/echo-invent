import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: { ean: string } }) {
  const ean = params.ean?.trim();
  if (!ean) {
    return NextResponse.json({ error: "EAN required." }, { status: 400 });
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

  const product = await prisma.product.findUnique({
    where: { session_id_ean: { session_id: session.id, ean } },
  });
  if (!product) {
    return NextResponse.json(
      { error: "Unknown EAN.", code: "NOT_FOUND", sessionId: session.id, ean },
      { status: 404 }
    );
  }

  const previousAudit =
    product.status === "updated"
      ? await prisma.auditEntry.findFirst({
          where: { product_id: product.id },
          orderBy: { audited_at: "desc" },
        })
      : null;

  return NextResponse.json({ product, previousAudit });
}
