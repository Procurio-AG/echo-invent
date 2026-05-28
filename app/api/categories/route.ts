import { NextResponse } from "next/server";
import { getCategoryGroups } from "@/lib/categories";

export const runtime = "nodejs";
export const dynamic = "force-static";

export async function GET() {
  try {
    return NextResponse.json({ groups: getCategoryGroups() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load categories.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
