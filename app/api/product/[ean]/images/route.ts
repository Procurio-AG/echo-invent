import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  signProductImageUrls,
  uploadProductImage,
  removeProductImage,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_IMAGES = 3;
const MAX_BYTES = 2 * 1024 * 1024; // 2MB
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/png": "png",
};

async function activeSession() {
  return prisma.session.findFirst({
    where: { closed_at: null },
    orderBy: { started_at: "desc" },
  });
}

// GET — list this product's images (active session), ordered by slot.
export async function GET(_req: Request, { params }: { params: { ean: string } }) {
  const ean = params.ean?.trim();
  if (!ean) return NextResponse.json({ error: "EAN required." }, { status: 400 });

  const session = await activeSession();
  if (!session) {
    return NextResponse.json(
      { error: "No active session.", code: "NO_ACTIVE_SESSION" },
      { status: 409 }
    );
  }

  const rows = await prisma.productImage.findMany({
    where: { product: { session_id: session.id, ean } },
    orderBy: { position: "asc" },
    select: { id: true, path: true, position: true },
  });
  // Private bucket — sign URLs on demand for display.
  const signed = await signProductImageUrls(rows.map((r) => r.path));
  const images = rows.map((r) => ({
    id: r.id,
    position: r.position,
    url: signed[r.path] ?? "",
  }));
  return NextResponse.json({ images });
}

// POST multipart/form-data { file } — attach one image (<=2MB, max 3) to the
// product identified by EAN in the active session. Multipart (not base64) keeps
// the payload lean over the Tailscale funnel.
export async function POST(req: Request, { params }: { params: { ean: string } }) {
  const ean = params.ean?.trim();
  if (!ean) return NextResponse.json({ error: "EAN required." }, { status: 400 });

  const session = await activeSession();
  if (!session) {
    return NextResponse.json(
      { error: "No active session.", code: "NO_ACTIVE_SESSION" },
      { status: 409 }
    );
  }

  const product = await prisma.product.findUnique({
    where: { session_id_ean: { session_id: session.id, ean } },
    select: { id: true },
  });
  if (!product) {
    return NextResponse.json(
      { error: "Unknown EAN.", code: "NOT_FOUND" },
      { status: 404 }
    );
  }

  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    return NextResponse.json({ error: "Invalid form body." }, { status: 400 });
  }
  if (!file) {
    return NextResponse.json({ error: "file is required." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Image exceeds 2MB.", code: "TOO_LARGE" },
      { status: 413 }
    );
  }
  const ext = EXT_BY_MIME[file.type];
  if (!ext) {
    return NextResponse.json(
      { error: `Unsupported image type: ${file.type || "unknown"}` },
      { status: 415 }
    );
  }

  // Pick the lowest free slot in 0..2. Concurrent uploads can race on this, so a
  // unique-constraint violation below retries against the freshly-read slots.
  const existing = await prisma.productImage.findMany({
    where: { product_id: product.id },
    select: { position: true },
  });
  if (existing.length >= MAX_IMAGES) {
    return NextResponse.json(
      { error: "This item already has 3 images.", code: "MAX_IMAGES" },
      { status: 409 }
    );
  }
  const used = new Set(existing.map((e) => e.position));
  const position = [0, 1, 2].find((p) => !used.has(p));
  if (position === undefined) {
    return NextResponse.json(
      { error: "This item already has 3 images.", code: "MAX_IMAGES" },
      { status: 409 }
    );
  }

  const path = `${session.id}/${ean}/${randomUUID()}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  await uploadProductImage(path, bytes, file.type);

  try {
    const image = await prisma.productImage.create({
      data: {
        product_id: product.id,
        path,
        position,
        size_bytes: file.size,
      },
      select: { id: true, path: true, position: true },
    });
    return NextResponse.json({ image }, { status: 201 });
  } catch (err) {
    // Lost the race for this slot — clean up the orphaned object and signal the
    // client to retry (the uploader re-reads slots on retry).
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      await removeProductImage(path).catch(() => {});
      return NextResponse.json(
        { error: "Slot taken, retry.", code: "SLOT_RACE" },
        { status: 409 }
      );
    }
    await removeProductImage(path).catch(() => {});
    throw err;
  }
}

// DELETE ?imageId=... — remove one image (storage object first, then row).
export async function DELETE(
  req: Request,
  { params }: { params: { ean: string } }
) {
  const ean = params.ean?.trim();
  const imageId = new URL(req.url).searchParams.get("imageId")?.trim();
  if (!ean) return NextResponse.json({ error: "EAN required." }, { status: 400 });
  if (!imageId) {
    return NextResponse.json({ error: "imageId required." }, { status: 400 });
  }

  const session = await activeSession();
  if (!session) {
    return NextResponse.json(
      { error: "No active session.", code: "NO_ACTIVE_SESSION" },
      { status: 409 }
    );
  }

  const image = await prisma.productImage.findFirst({
    where: { id: imageId, product: { session_id: session.id, ean } },
    select: { id: true, path: true },
  });
  if (!image) {
    return NextResponse.json({ error: "Image not found." }, { status: 404 });
  }

  // Storage first: if the object delete fails we keep the row so we don't orphan
  // a still-referenced URL. A failed row delete after a successful object delete
  // just leaves a dead row, which the next attempt clears.
  await removeProductImage(image.path).catch(() => {});
  await prisma.productImage.delete({ where: { id: image.id } });
  return NextResponse.json({ ok: true });
}
