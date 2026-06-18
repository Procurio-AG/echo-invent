// Server-only Gemini speech-to-text client with N-key round-robin + 429 failover.
// Keys come from GEMINI_API_KEYS (comma-separated). Never import this client-side.

// Model buckets. Each id is an independent free-tier daily quota bucket; env vars
// let ops point them at newer ids once verified, without a code change. Default to
// the only id verified working today so the app runs out of the box.
export const MODEL_HEAR = process.env.GEMINI_MODEL_HEAR ?? "gemini-2.5-flash";
export const MODEL_REPAIR = process.env.GEMINI_MODEL_REPAIR ?? "gemini-2.5-flash";
export const MODEL_SPELL = process.env.GEMINI_MODEL_SPELL ?? "gemini-2.5-flash";
export const MODEL_GROUND = process.env.GEMINI_MODEL_GROUND ?? "gemini-2.5-flash";

function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export class GeminiQuotaError extends Error {
  constructor(message = "Gemini quota exhausted (all keys 429).") {
    super(message);
    this.name = "GeminiQuotaError";
  }
}

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

// One round-robin + 429-failover request against a given model. Returns the raw
// parsed JSON response. Throws GeminiQuotaError when every key is rate-limited so
// callers can fall back to another model bucket.
async function callGemini(model: string, body: string): Promise<unknown> {
  const keys = loadKeys();
  if (keys.length === 0) {
    throw new Error("No Gemini API keys configured (set GEMINI_API_KEYS).");
  }
  const endpoint = endpointFor(model);
  let lastError: unknown = null;
  let sawRateLimit = false;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = keys[(cursor + attempt) % keys.length];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body,
      });
      if (res.status === 429) {
        sawRateLimit = true;
        lastError = new Error("Key rate-limited (429).");
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Gemini ${res.status}: ${text.slice(0, 200)}`);
      }
      cursor = (cursor + attempt + 1) % keys.length;
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  if (sawRateLimit) throw new GeminiQuotaError();
  throw lastError instanceof Error ? lastError : new Error("Gemini request failed.");
}

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
- name: the product's DESCRIPTIVE name in ROMAN / LATIN script, INCLUDING any spoken quantity / size / volume / weight (e.g. "Khus Syrup 750ml", "Atta 5kg", "Lays 52g"). The quantity / size STAYS attached to the name. EXCLUDE the brand from the name. Transliterate Hindi to Latin; NEVER use Devanagari and NEVER translate (keep words like "ghee", "atta", "doodh", "namkeen" as spoken). Use "" (empty string) if no clear product name is heard.
- brand: ONLY the brand / manufacturer name if clearly present (e.g. Amul, Parle, Patanjali, Britannia, Nestle, Tata, Mother Dairy, Haldiram). null if no clear brand or it is ambiguous. Do NOT guess a brand from the product type. Do NOT include the brand in name.
- mrp: the price as ONE plain number in rupees. Convert spoken number words in any language, including Hindi: "do sau pachaas"=250, "saadhe teen sau"=350, "sava do sau"=225, "paune teen sau"=275, "dhai sau"=250, "pachattar"=75, "ek sau bees"=120. Strip filler such as "rupaye", "rupees", "rs", "ka", "MRP", "price". null if no price is spoken.
- confidence: 0..1, how confident you are that name + mrp are correct.
- needs_review: true if the audio is silence / noise / non-product, or you are unsure. In that case set name="" and needs_review=true rather than fabricating a name.

Example: spoken "Haldiram Khus Syrup saat sau pachaas ml, em-AR-pee ek sau pachaas" -> { "name": "Khus Syrup 750ml", "brand": "Haldiram", "mrp": 150 }. Note the brand ("Haldiram") is split out into brand, while the size ("750ml") stays inside name.`;

export async function transcribeAudio(
  audioBase64: string,
  mimeType: string,
  model: string = MODEL_REPAIR
): Promise<Transcription> {
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
  const data = await callGemini(model, body);
  return parseResult(data);
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

export type NameItem = { ean: string; name: string; brand: string | null };
export type NameSuggestion = {
  ean: string;
  name: string;
  brand: string | null;
  correction_conf: number;
};

const NAME_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          ean: { type: "STRING" },
          name: { type: "STRING" },
          brand: { type: "STRING", nullable: true },
          correction_conf: { type: "NUMBER" },
        },
        required: ["ean", "name", "correction_conf"],
      },
    },
  },
  required: ["items"],
};

const CORRECT_PROMPT = `These are phonetically transcribed Indian retail product names, possibly misspelled (e.g. "Kiyo Karpin Oil" should be "Keo Karpin Oil"). For EACH input item return the canonical brand + product spelling in Latin/Roman script. Keep any size/quantity inside name (e.g. "750ml"). Do NOT invent products or add items. Echo back each item's ean UNCHANGED. correction_conf is 0..1: how confident the corrected spelling is.`;

const GROUND_PROMPT = `These are phonetically transcribed Indian retail product names that may be misspelled. Use web search to find the correct canonical brand and product spelling for EACH item. Keep size/quantity in name. Do NOT invent products. Echo each ean unchanged.`;

// Defensive parse: works for both structured-JSON responses and grounded prose
// that embeds JSON (grounding + responseSchema can be mutually exclusive).
function extractJson(raw: string): string | null {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = fence ? fence[1] : raw;
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  return s.slice(start, end + 1);
}

function parseNameItems(data: unknown): NameSuggestion[] {
  const d = data as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw =
    d?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const json = extractJson(raw);
  if (!json) return [];
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(json) as { items?: unknown };
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed.items) ? parsed.items : [];
  const out: NameSuggestion[] = [];
  for (const entry of arr) {
    const it = entry as Record<string, unknown>;
    const ean = typeof it.ean === "string" ? it.ean.trim() : "";
    if (!ean) continue;
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const brand =
      typeof it.brand === "string" && it.brand.trim() ? it.brand.trim() : null;
    const c = typeof it.correction_conf === "number" ? it.correction_conf : 0;
    out.push({
      ean,
      name,
      brand,
      correction_conf: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0,
    });
  }
  return out;
}

// Tier 1 / pipeline Stage 2 — cheap text-only batch correction.
export async function correctNamesBatch(
  items: NameItem[],
  model: string = MODEL_SPELL
): Promise<NameSuggestion[]> {
  if (items.length === 0) return [];
  const body = JSON.stringify({
    contents: [
      { parts: [{ text: `${CORRECT_PROMPT}\n\nINPUT:\n${JSON.stringify(items)}` }] },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: NAME_SCHEMA,
      temperature: 0,
    },
  });
  const data = await callGemini(model, body);
  return parseNameItems(data);
}

// Tier 2 / pipeline Stage 3 — Google-Search grounded, defensive parse, no schema.
export async function groundedNamesBatch(
  items: NameItem[],
  model: string = MODEL_GROUND
): Promise<NameSuggestion[]> {
  if (items.length === 0) return [];
  const body = JSON.stringify({
    contents: [
      {
        parts: [
          {
            text: `${GROUND_PROMPT}\n\nINPUT:\n${JSON.stringify(
              items
            )}\n\nReturn ONLY a JSON object {"items":[{"ean","name","brand","correction_conf"}]} and no other prose.`,
          },
        ],
      },
    ],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 0 },
  });
  const data = await callGemini(model, body);
  return parseNameItems(data);
}

export type BatchClip = { ean: string; audioBase64: string; mimeType: string };
export type BatchTranscription = {
  ean: string;
  name: string;
  brand: string | null;
  mrp: number | null;
  confidence: number;
  needs_review: boolean;
};

const BATCH_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          ean: { type: "STRING" },
          name: { type: "STRING" },
          brand: { type: "STRING", nullable: true },
          mrp: { type: "NUMBER", nullable: true },
          confidence: { type: "NUMBER" },
          needs_review: { type: "BOOLEAN" },
        },
        required: ["ean", "name", "confidence", "needs_review"],
      },
    },
  },
  required: ["items"],
};

const BATCH_PROMPT = `${PROMPT}

You are given SEVERAL clips in one request. Before each clip is a line:
"=== ITEM <n> | EAN <digits> ===". Transcribe EACH clip with the same rules
above and return one array element PER clip, in the SAME ORDER. For each element
you MUST echo back that clip's EAN EXACTLY as given in its delimiter line (copy
the digits; never invent or alter them). Do not merge, drop, or reorder clips.`;

function parseBatchItems(data: unknown): BatchTranscription[] {
  const d = data as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const raw =
    d?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  const json = extractJson(raw);
  if (!json) return [];
  let parsed: { items?: unknown };
  try {
    parsed = JSON.parse(json) as { items?: unknown };
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed.items) ? parsed.items : [];
  const out: BatchTranscription[] = [];
  for (const entry of arr) {
    const it = entry as Record<string, unknown>;
    const ean = typeof it.ean === "string" ? it.ean.trim() : "";
    const name = typeof it.name === "string" ? it.name.trim() : "";
    const brand =
      typeof it.brand === "string" && it.brand.trim() ? it.brand.trim() : null;
    let mrp: number | null = null;
    const m = typeof it.mrp === "number" ? it.mrp : Number(it.mrp);
    if (Number.isFinite(m) && m > 0) mrp = m;
    const c = typeof it.confidence === "number" ? it.confidence : 0;
    const confidence = Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0;
    const needs_review = it.needs_review === true || name === "";
    out.push({ ean, name, brand, mrp, confidence, needs_review });
  }
  return out;
}

// Stage 1 — one multimodal request carrying every queued clip, delimiter-
// interleaved, with a required per-item EAN echo for server-side alignment.
export async function transcribeBatch(
  items: BatchClip[],
  model: string = MODEL_HEAR
): Promise<BatchTranscription[]> {
  if (items.length === 0) return [];
  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [{ text: BATCH_PROMPT }];
  items.forEach((it, i) => {
    parts.push({ text: `=== ITEM ${i + 1} | EAN ${it.ean} ===` });
    parts.push({ inlineData: { mimeType: it.mimeType, data: it.audioBase64 } });
  });
  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: BATCH_SCHEMA,
      temperature: 0,
    },
  });
  const data = await callGemini(model, body);
  return parseBatchItems(data);
}
