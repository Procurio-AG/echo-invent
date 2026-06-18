import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  correctNamesBatch,
  groundedNamesBatch,
  type NameItem,
  type NameSuggestion,
} from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EANS = 200;
const GROUNDING_MAX = 0.75; // ground only rows whose CAPTURE confidence is below this

type Body = { eans?: string[] };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const eans = Array.isArray(body.eans)
    ? body.eans.map((e) => String(e).trim()).filter(Boolean).slice(0, MAX_EANS)
    : null;
  if (!eans || eans.length === 0) {
    return NextResponse.json({ error: "eans array required." }, { status: 400 });
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

  const products = await prisma.product.findMany({
    where: { session_id: session.id, ean: { in: eans } },
    select: { ean: true, name: true, original_data: true },
  });

  const brandOf = (od: unknown): string | null => {
    const b = (od as Record<string, unknown> | null | undefined)?.brand;
    return typeof b === "string" && b.trim() ? b.trim() : null;
  };
  const confOf = (od: unknown): number | null => {
    const c = (od as Record<string, unknown> | null | undefined)?.confidence;
    return typeof c === "number" ? c : null;
  };

  const all: NameItem[] = products.map((p) => ({
    ean: p.ean,
    name: p.name,
    brand: brandOf(p.original_data),
  }));
  const lowConf: NameItem[] = products
    .filter((p) => {
      const c = confOf(p.original_data);
      return c !== null && c < GROUNDING_MAX;
    })
    .map((p) => ({ ean: p.ean, name: p.name, brand: brandOf(p.original_data) }));

  // Tier 1 (all) + Tier 2 (low-confidence subset). A whole-tier failure degrades
  // to no suggestions for that tier rather than failing the request.
  let batch: NameSuggestion[] = [];
  let grounded: NameSuggestion[] = [];
  try {
    batch = await correctNamesBatch(all);
  } catch {
    batch = [];
  }
  if (lowConf.length > 0) {
    try {
      grounded = await groundedNamesBatch(lowConf);
    } catch {
      grounded = [];
    }
  }

  const batchByEan = new Map(batch.map((s) => [s.ean, s]));
  const groundedByEan = new Map(grounded.map((s) => [s.ean, s]));

  const suggestions = products.map((p) => {
    const currentBrand = brandOf(p.original_data);
    const g = groundedByEan.get(p.ean);
    const b = batchByEan.get(p.ean);
    const pick = g ?? b;
    const source: "batch" | "grounded" | "unchanged" = g
      ? "grounded"
      : b
      ? "batch"
      : "unchanged";
    if (!pick || !pick.name) {
      return {
        ean: p.ean,
        suggested_name: p.name,
        suggested_brand: currentBrand,
        source: "unchanged" as const,
        changed: false,
      };
    }
    const suggested_name = pick.name;
    const suggested_brand = pick.brand ?? currentBrand;
    const changed =
      suggested_name !== p.name || (suggested_brand ?? "") !== (currentBrand ?? "");
    return { ean: p.ean, suggested_name, suggested_brand, source, changed };
  });

  return NextResponse.json({ suggestions });
}
