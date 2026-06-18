import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  transcribeBatch,
  transcribeAudio,
  correctNamesBatch,
  groundedNamesBatch,
  GeminiQuotaError,
  MODEL_REPAIR,
  type BatchClip,
  type BatchTranscription,
} from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 25;
const GROUNDING_MAX = 0.75;

type Body = { items?: BatchClip[] };

type Row = {
  ean: string;
  name: string;
  brand: string | null;
  mrp: number | null;
  confidence: number | null;
  source: "batch" | "repair" | "grounded";
  flags: string[];
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const items = Array.isArray(body.items)
    ? body.items.filter((i) => i && i.ean && i.audioBase64 && i.mimeType)
    : null;
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "items array required." }, { status: 400 });
  }
  if (items.length > MAX_ITEMS) {
    return NextResponse.json(
      { error: `Too many items (max ${MAX_ITEMS}).` },
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

  // ── Stage 1: hear the whole batch; fall back to the repair model on quota. ──
  let stage1: BatchTranscription[] = [];
  try {
    stage1 = await transcribeBatch(items);
  } catch (err) {
    if (err instanceof GeminiQuotaError) {
      try {
        stage1 = await transcribeBatch(items, MODEL_REPAIR);
      } catch (err2) {
        if (err2 instanceof GeminiQuotaError) {
          return NextResponse.json(
            {
              error: "Transcription quota reached for today — queue preserved.",
              code: "QUOTA_EXHAUSTED",
            },
            { status: 409 }
          );
        }
        stage1 = [];
      }
    } else {
      stage1 = [];
    }
  }

  // ── Alignment verify by position, using the echoed EAN as a checksum. ───────
  const scanned = new Set(items.map((i) => i.ean));
  const rows: Row[] = [];
  for (let i = 0; i < items.length; i++) {
    const expected = items[i].ean;
    const got = stage1[i];
    const aligned =
      got && got.ean === expected && scanned.has(got.ean) && !!got.name;
    if (aligned) {
      rows.push({
        ean: expected,
        name: got.name,
        brand: got.brand,
        mrp: got.mrp,
        confidence: got.confidence,
        source: "batch",
        flags: got.needs_review ? ["low_confidence"] : [],
      });
      continue;
    }
    // ── Repair: re-transcribe this one clip on the repair model. ──────────────
    try {
      const r = await transcribeAudio(
        items[i].audioBase64,
        items[i].mimeType,
        MODEL_REPAIR
      );
      rows.push({
        ean: expected,
        name: r.name,
        brand: r.brand,
        mrp: r.mrp,
        confidence: r.confidence,
        source: "repair",
        flags: r.name ? ["unaligned_repaired"] : ["unaligned_repaired", "empty"],
      });
    } catch {
      rows.push({
        ean: expected,
        name: "",
        brand: null,
        mrp: null,
        confidence: null,
        source: "repair",
        flags: ["unaligned_repaired", "empty"],
      });
    }
  }

  // ── Stage 2: bulk spelling (text-only) over rows that have a name. ──────────
  const named = rows.filter((r) => r.name);
  if (named.length > 0) {
    try {
      const fixes = await correctNamesBatch(
        named.map((r) => ({ ean: r.ean, name: r.name, brand: r.brand }))
      );
      const byEan = new Map(fixes.map((f) => [f.ean, f]));
      for (const r of rows) {
        const f = byEan.get(r.ean);
        if (f && f.name) {
          r.name = f.name;
          if (f.brand) r.brand = f.brand;
        }
      }
    } catch {
      // degrade silently: keep Stage-1 names
    }
  }

  // ── Stage 3: grounded verify, gated to low-confidence rows. ─────────────────
  const lowConf = rows.filter(
    (r) => r.confidence !== null && r.confidence < GROUNDING_MAX && r.name
  );
  if (lowConf.length > 0) {
    try {
      const grounded = await groundedNamesBatch(
        lowConf.map((r) => ({ ean: r.ean, name: r.name, brand: r.brand }))
      );
      const byEan = new Map(grounded.map((g) => [g.ean, g]));
      for (const r of rows) {
        const g = byEan.get(r.ean);
        if (g && g.name) {
          r.name = g.name;
          if (g.brand) r.brand = g.brand;
          r.source = "grounded";
        }
      }
    } catch {
      // degrade silently: keep Stage-2 names
    }
  }

  return NextResponse.json({ rows });
}
