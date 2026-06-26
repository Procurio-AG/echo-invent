import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isKnownSubcategory } from "@/lib/categories";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  ean?: string;
  version?: number;
  name?: string;
  category?: string | null;
  purchase_price?: number | null;
  selling_price?: number | null;
  mrp?: number | null;
  batch?: string | null;
  expiry_date?: string | null;
};

function toNullableNumber(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// undefined = field absent (leave unchanged); null = explicit clear.
function parseExpiry(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const ean = body.ean?.trim();
  const version = body.version;
  if (!ean) return NextResponse.json({ error: "ean required." }, { status: 400 });
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return NextResponse.json({ error: "version (int >= 1) required." }, { status: 400 });
  }

  let name: string | undefined;
  if (body.name !== undefined) {
    const trimmed = body.name.trim();
    if (trimmed === "") {
      return NextResponse.json({ error: "name cannot be empty." }, { status: 400 });
    }
    name = trimmed;
  }

  let category: string | null | undefined;
  if (body.category !== undefined) {
    if (body.category === null || body.category === "") {
      category = null;
    } else {
      const trimmed = body.category.trim();
      if (!isKnownSubcategory(trimmed)) {
        return NextResponse.json(
          { error: `Unknown category: ${trimmed}` },
          { status: 400 }
        );
      }
      category = trimmed;
    }
  }

  const purchase_price = toNullableNumber(body.purchase_price);
  const selling_price = toNullableNumber(body.selling_price);
  const mrp = toNullableNumber(body.mrp);

  let batch: string | null | undefined;
  if (body.batch !== undefined) {
    const trimmed = (body.batch ?? "").trim();
    batch = trimmed === "" ? null : trimmed;
  }
  const expiry_date = parseExpiry(body.expiry_date);

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

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.product.findUnique({
      where: { session_id_ean: { session_id: session.id, ean } },
      select: { id: true, version: true },
    });
    if (!existing) {
      return { kind: "not_found" as const };
    }
    if (existing.version !== version) {
      return { kind: "conflict" as const, currentVersion: existing.version };
    }

    const updated = await tx.product.update({
      where: { id: existing.id, version },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(category !== undefined ? { category } : {}),
        ...(purchase_price !== undefined ? { purchase_price } : {}),
        ...(selling_price !== undefined ? { selling_price } : {}),
        ...(mrp !== undefined ? { mrp } : {}),
        ...(batch !== undefined ? { batch } : {}),
        ...(expiry_date !== undefined ? { expiry_date } : {}),
        status: "updated",
        version: { increment: 1 },
      },
    });

    await tx.auditEntry.create({
      data: {
        product_id: existing.id,
        purchase_price: updated.purchase_price,
        selling_price: updated.selling_price,
        mrp: updated.mrp,
      },
    });

    return { kind: "ok" as const, product: updated };
  });

  if (result.kind === "not_found") {
    return NextResponse.json({ error: "Unknown EAN.", code: "NOT_FOUND" }, { status: 404 });
  }
  if (result.kind === "conflict") {
    return NextResponse.json(
      {
        error: "Version mismatch — refetch and retry.",
        code: "VERSION_CONFLICT",
        currentVersion: result.currentVersion,
      },
      { status: 409 }
    );
  }
  return NextResponse.json({ product: result.product });
}
