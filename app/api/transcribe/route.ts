import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body = {
  audioBase64?: string;
  mimeType?: string;
  ean?: string;
};

// Below this, treat the transcription as unreliable and make the auditor
// re-record or type it — never silently save a guessed product name.
const CONFIDENCE_THRESHOLD = 0.55;

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const audioBase64 = body.audioBase64?.trim();
  const mimeType = body.mimeType?.trim();
  if (!audioBase64 || !mimeType) {
    return NextResponse.json(
      { error: "audioBase64 and mimeType are required." },
      { status: 400 }
    );
  }

  // Require an open session, mirroring the other routes.
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

  let result;
  try {
    result = await transcribeAudio(audioBase64, mimeType);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Transcription failed.";
    return NextResponse.json(
      { error: message, code: "TRANSCRIBE_FAILED" },
      { status: 502 }
    );
  }

  // Low-confidence / empty / flagged -> 422 so the client prompts for a
  // re-record or manual entry rather than creating a bad row.
  if (
    !result.name ||
    result.needs_review ||
    result.confidence < CONFIDENCE_THRESHOLD
  ) {
    return NextResponse.json(
      { ...result, code: "LOW_CONFIDENCE" },
      { status: 422 }
    );
  }

  return NextResponse.json(result);
}
