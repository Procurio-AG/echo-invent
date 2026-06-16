// Server-only Gemini speech-to-text client with N-key round-robin + 429 failover.
// Keys come from GEMINI_API_KEYS (comma-separated). Never import this client-side.

const MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

export type Transcription = {
  name: string;
  brand: string | null;
  mrp: number | null;
  confidence: number;
  needs_review: boolean;
};

function loadKeys(): string[] {
  return (process.env.GEMINI_API_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Module-level round-robin cursor. Single Node worker -> good enough; we also
// fail over on HTTP 429, so we never depend on precise per-key request counting.
let cursor = 0;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    name: { type: "STRING" },
    brand: { type: "STRING", nullable: true },
    mrp: { type: "NUMBER", nullable: true },
    confidence: { type: "NUMBER" },
    needs_review: { type: "BOOLEAN" },
  },
  required: ["name", "confidence", "needs_review"],
};

const PROMPT = `You transcribe a short voice clip from a retail inventory auditor who has just scanned a product and is speaking its NAME and its MRP (maximum retail price). The auditor may speak Hindi, English, or a Hinglish mix.

Return ONLY these structured fields:
- name: the product name in ROMAN / LATIN script. Transliterate Hindi to Latin; NEVER use Devanagari and NEVER translate (keep words like "ghee", "atta", "doodh", "namkeen" as spoken). Keep brand words verbatim. Use "" (empty string) if no clear product name is heard.
- brand: just the brand / manufacturer token if clearly present (e.g. Amul, Parle, Patanjali, Britannia, Nestle, Tata, Mother Dairy, Haldiram). null if no clear brand or it is ambiguous. Do NOT guess a brand from the product type.
- mrp: the price as ONE plain number in rupees. Convert spoken number words in any language, including Hindi: "do sau pachaas"=250, "saadhe teen sau"=350, "sava do sau"=225, "paune teen sau"=275, "dhai sau"=250, "pachattar"=75, "ek sau bees"=120. Strip filler such as "rupaye", "rupees", "rs", "ka", "MRP", "price". null if no price is spoken.
- confidence: 0..1, how confident you are that name + mrp are correct.
- needs_review: true if the audio is silence / noise / non-product, or you are unsure. In that case set name="" and needs_review=true rather than fabricating a name.`;

export async function transcribeAudio(
  audioBase64: string,
  mimeType: string
): Promise<Transcription> {
  const keys = loadKeys();
  if (keys.length === 0) {
    throw new Error("No Gemini API keys configured (set GEMINI_API_KEYS).");
  }

  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { text: PROMPT },
          { inlineData: { mimeType, data: audioBase64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  let lastError: unknown = null;
  // Try each key once, rotating from the current cursor; fail over on 429.
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(cursor + attempt) % keys.length];
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
      });
      if (res.status === 429) {
        lastError = new Error("All keys rate-limited (429).");
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
      }
      // Advance the cursor past the key that succeeded for the next request.
      cursor = (cursor + attempt + 1) % keys.length;
      const data = (await res.json()) as unknown;
      return parseResult(data);
    } catch (err) {
      lastError = err;
      // network / parse error: try the next key
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Transcription failed.");
}

function parseResult(data: unknown): Transcription {
  const d = data as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw = d?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { name: "", brand: null, mrp: null, confidence: 0, needs_review: true };
  }

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  const brand =
    typeof parsed.brand === "string" && parsed.brand.trim()
      ? parsed.brand.trim()
      : null;

  let mrp: number | null = null;
  const n =
    typeof parsed.mrp === "number" ? parsed.mrp : Number(parsed.mrp);
  if (Number.isFinite(n) && n > 0) mrp = n;

  const c = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  const confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;

  const needs_review = parsed.needs_review === true || name === "";

  return { name, brand, mrp, confidence, needs_review };
}
