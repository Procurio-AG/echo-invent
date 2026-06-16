import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Item = {
  id?: string;
  ean?: string;
  version?: number;
  purchase_price?: number | null;
  selling_price?: number | null;
  mrp?: number | null;
};

type Body = {
  items?: Item[];
};

// Mirrors app/api/product/update + create: undefined => leave unchanged,
// null/"" => clear, otherwise coerce to a finite number (NaN => null).
function toNullableNumber(v: unknown): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// A provided price must be a finite, non-negative number. undefined (omitted)
// is fine — it means "leave unchanged". null means "clear" and is allowed.
function isInvalidPrice(v: number | null | undefined): boolean {
  if (v === undefined || v === null) return false;
  return !Number.isFinite(v) || v < 0;
}

// Chunk size mirrors the upload route's chunked-refresh precedent so a large
// batch doesn't become one oversized interactive transaction that exhausts the
// Supabase pooler / blows past pool_timeout.
const CHUNK = 100;

// Bound the work per request so a pathological/abusive payload can't spawn
// hundreds of sequential interactive transactions and hold pooled connections.
// The UI only ever sends <= TAKE (100) dirty rows; this is a defensive ceiling
// mirroring the list route's MAX_TAKE clamp discipline.
const MAX_ITEMS = 500;

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const items = Array.isArray(body.items) ? body.items : null;
  if (!items) {
    return NextResponse.json({ error: "items array required." }, { status: 400 });
  }
  if (items.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: `Too many items (max ${MAX_ITEMS} per request).` },
      { status: 400 }
    );
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

  const applied: { ean: string; version: number }[] = [];
  const conflicts: { ean: string; currentVersion: number }[] = [];
  const notFound: string[] = [];
  const invalid: { ean: string; reason: string }[] = [];

  // ── Normalise + validate up-front so bad rows never reach the DB. ──────────
  type Resolved = {
    ean: string;
    version: number;
    purchase_price: number | null | undefined;
    selling_price: number | null | undefined;
    mrp: number | null | undefined;
  };
  const resolved: Resolved[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const ean = item.ean?.trim();
    if (!ean) {
      // No EAN to key the upsert / report against — surface as invalid with a
      // best-effort label (raw ean + array index) so multiple eanless rows stay
      // distinguishable instead of collapsing to a single "" entry.
      invalid.push({ ean: item.ean ?? `#${idx}`, reason: "ean required" });
      continue;
    }

    const version = item.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      invalid.push({ ean, reason: "version (int >= 1) required" });
      continue;
    }

    const purchase_price = toNullableNumber(item.purchase_price);
    const selling_price = toNullableNumber(item.selling_price);
    const mrp = toNullableNumber(item.mrp);

    if (isInvalidPrice(purchase_price)) {
      invalid.push({ ean, reason: "purchase_price must be a number >= 0" });
      continue;
    }
    if (isInvalidPrice(selling_price)) {
      invalid.push({ ean, reason: "selling_price must be a number >= 0" });
      continue;
    }
    if (isInvalidPrice(mrp)) {
      invalid.push({ ean, reason: "mrp must be a number >= 0" });
      continue;
    }

    // No actual field to write — skip rather than bump the version for nothing.
    if (purchase_price === undefined && selling_price === undefined && mrp === undefined) {
      continue;
    }

    resolved.push({ ean, version, purchase_price, selling_price, mrp });
  }

  // ── Process in chunks; one interactive transaction per chunk. ──────────────
  for (let i = 0; i < resolved.length; i += CHUNK) {
    const chunk = resolved.slice(i, i + CHUNK);

    const results = await prisma.$transaction(async (tx) => {
      const out: Array<
        | { kind: "applied"; ean: string; version: number }
        | { kind: "conflict"; ean: string; currentVersion: number }
        | { kind: "not_found"; ean: string }
      > = [];

      for (const r of chunk) {
        const existing = await tx.product.findUnique({
          where: { session_id_ean: { session_id: session.id, ean: r.ean } },
          select: { id: true, version: true },
        });
        if (!existing) {
          out.push({ kind: "not_found", ean: r.ean });
          continue;
        }
        if (existing.version !== r.version) {
          out.push({ kind: "conflict", ean: r.ean, currentVersion: existing.version });
          continue;
        }

        // Partial update: only spread provided (defined) prices, mirroring the
        // update route so a blank input never wipes an existing value.
        const updated = await tx.product.update({
          where: { id: existing.id, version: r.version },
          data: {
            ...(r.purchase_price !== undefined ? { purchase_price: r.purchase_price } : {}),
            ...(r.selling_price !== undefined ? { selling_price: r.selling_price } : {}),
            ...(r.mrp !== undefined ? { mrp: r.mrp } : {}),
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

        out.push({ kind: "applied", ean: r.ean, version: updated.version });
      }

      return out;
    });

    for (const res of results) {
      if (res.kind === "applied") applied.push({ ean: res.ean, version: res.version });
      else if (res.kind === "conflict")
        conflicts.push({ ean: res.ean, currentVersion: res.currentVersion });
      else notFound.push(res.ean);
    }
  }

  return NextResponse.json({ applied, conflicts, notFound, invalid });
}
