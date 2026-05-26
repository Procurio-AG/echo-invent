import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = { barcode?: string };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const barcode = body.barcode?.trim();
  if (!barcode) {
    return NextResponse.json({ error: "barcode required." }, { status: 400 });
  }

  const session = await prisma.session.findFirst({
    where: { closed_at: null },
    orderBy: { started_at: "desc" },
  });

  const entry = await prisma.exceptionQueue.create({
    data: { barcode, session_id: session?.id ?? null },
  });

  return NextResponse.json({ exception: entry }, { status: 201 });
}

export async function GET() {
  const session = await prisma.session.findFirst({
    where: { closed_at: null },
    orderBy: { started_at: "desc" },
  });
  if (!session) {
    return NextResponse.json({ exceptions: [] });
  }
  const exceptions = await prisma.exceptionQueue.findMany({
    where: { session_id: session.id },
    orderBy: { created_at: "desc" },
  });
  return NextResponse.json({ exceptions });
}
