import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isKnownSubcategory } from "@/lib/categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  ean?: string;
  name?: string;
  category?: string | null;
  purchase_price?: number | null;
  selling_price?: number | null;
  mrp?: number | null;
};

function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ean = body.ean?.trim();
  if (!ean) return NextResponse.json({ error: "ean required." }, { status: 400 });

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "name required." }, { status: 400 });

  let category: string | null = null;
  if (body.category !== undefined && body.category !== null && body.category !== "") {
    const trimmed = body.category.trim();
    if (!isKnownSubcategory(trimmed)) {
      return NextResponse.json(
        { error: `Unknown category: ${trimmed}` },
        { status: 400 }
      );
    }
    category = trimmed;
  }

  const purchase_price = toNullableNumber(body.purchase_price);
  const selling_price = toNullableNumber(body.selling_price);
  const mrp = toNullableNumber(body.mrp);

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

  try {
    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          session_id: session.id,
          ean,
          name,
          category,
          purchase_price,
          selling_price,
          mrp,
          original_data: {} as Prisma.InputJsonValue,
          status: "updated",
        },
      });

      await tx.auditEntry.create({
        data: {
          product_id: created.id,
          purchase_price: created.purchase_price,
          selling_price: created.selling_price,
          mrp: created.mrp,
        },
      });

      // Clear any pending exception rows for this barcode in the active session
      // — the product they referred to now exists.
      await tx.exceptionQueue.deleteMany({
        where: { session_id: session.id, barcode: ean },
      });

      return created;
    });

    return NextResponse.json({ product }, { status: 201 });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "EAN already exists in this session.", code: "ALREADY_EXISTS" },
        { status: 409 }
      );
    }
    throw err;
  }
}
