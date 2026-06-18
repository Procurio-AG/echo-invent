# Bulk Name Fix (confidence-gated grounding) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Fix names" button on the categorize worklist that proposes corrected name/brand for the visible rows — a cheap text batch for all rows, plus Google-Search-grounded verification only for low-confidence rows — which the auditor reviews and accepts through the existing editable inputs (never auto-saved).

**Architecture:** Refactor `lib/gemini.ts` so the key round-robin caller takes a `model` argument and exposes named model constants (env-overridable, default to the known-good `gemini-2.5-flash`). Add shared `correctNamesBatch` (text-only) and `groundedNamesBatch` (grounded, defensive parse) helpers — these are the same helpers spec D's pipeline reuses. A new `POST /api/product/suggest-names` runs Tier 1 (all rows) then Tier 2 (low-confidence subset). The categorize page (already editable from spec A) gets a "Fix names" button that merges suggestions into its per-row override state.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma 5 + PostgreSQL, Gemini REST (`generativelanguage.googleapis.com`), react-hot-toast.

## Global Constraints

- No automated test framework; per-task cycle = `npm run build` clean + manual/curl check.
- Builds on spec A (editable name/brand on the categorize page with a per-id `Override` override object). That plan must be implemented first.
- Model IDs are **env-overridable named constants** defaulting to `gemini-2.5-flash` (the only id verified working today). Operators set the new ids (`gemini-3.x-*`) once verified — never hardcode an unverified id.
- Grounding + `responseSchema` may be mutually exclusive: the grounded helper sends **no** `responseSchema`, requests JSON in the prompt, and parses defensively (code-fence/brace extraction), falling back to an empty result on parse failure.
- Suggestions never persist until the auditor presses Save-all (spec A's path). Partial success: a per-row model failure degrades that row to `unchanged`, never fails the batch.
- `GROUNDING_MAX` default `0.75`. Only rows with `original_data.confidence != null && < GROUNDING_MAX` are grounded; manual (`null`) and high-confidence rows are not.

---

### Task 1: Refactor `lib/gemini.ts` to a model-parameterized caller + name helpers

**Files:**
- Modify: `lib/gemini.ts` (extract a generic caller, add model constants, add `correctNamesBatch` / `groundedNamesBatch`, give `transcribeAudio` an optional `model` arg)

**Interfaces:**
- Produces:
  - `MODEL_HEAR`, `MODEL_REPAIR`, `MODEL_SPELL`, `MODEL_GROUND: string` constants.
  - `class GeminiQuotaError extends Error` (thrown when every key returns 429).
  - `transcribeAudio(audioBase64: string, mimeType: string, model?: string): Promise<Transcription>` (default `MODEL_REPAIR`, preserving today's behavior).
  - `type NameItem = { ean: string; name: string; brand: string | null }`.
  - `type NameSuggestion = { ean: string; name: string; brand: string | null; correction_conf: number }`.
  - `correctNamesBatch(items: NameItem[], model?: string): Promise<NameSuggestion[]>` (default `MODEL_SPELL`).
  - `groundedNamesBatch(items: NameItem[], model?: string): Promise<NameSuggestion[]>` (default `MODEL_GROUND`).

- [ ] **Step 1: Replace the model constant + endpoint with named, env-overridable constants and a generic caller**

In `lib/gemini.ts`, replace the top `const MODEL` + `const ENDPOINT` lines:

```typescript
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
```

- [ ] **Step 2: Add a generic `callGemini` that the round-robin uses for every model**

Add below the `cursor` declaration:

```typescript
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
```

- [ ] **Step 3: Rewrite `transcribeAudio` to take a `model` and use `callGemini`**

Replace the `transcribeAudio` function body so it builds the body and delegates:

```typescript
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
```

(The old per-key loop inside `transcribeAudio` is now in `callGemini`; delete it. `parseResult`, `PROMPT`, `RESPONSE_SCHEMA`, `loadKeys`, `cursor` stay.)

- [ ] **Step 4: Add the name-correction types, schema, prompts, parser, and the two helpers**

Append to `lib/gemini.ts`:

```typescript
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
  for (const raw of arr) {
    const it = raw as Record<string, unknown>;
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
```

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: clean. The existing `/api/transcribe` route still compiles (it calls `transcribeAudio(a, m)` — the new third arg is optional).

- [ ] **Step 6: Commit**

```bash
git add lib/gemini.ts
git commit -m "refactor(gemini): model-parameterized caller + name-correction helpers"
```

---

### Task 2: `POST /api/product/suggest-names`

**Files:**
- Create: `app/api/product/suggest-names/route.ts`

**Interfaces:**
- Consumes: `correctNamesBatch`, `groundedNamesBatch`, `NameItem` from Task 1.
- Produces: `POST /api/product/suggest-names` body `{ eans: string[] }` → `{ suggestions: [{ ean, suggested_name, suggested_brand, source, changed }] }`, `source ∈ {"batch","grounded","unchanged"}`. Requires active session (409 `NO_ACTIVE_SESSION`).

- [ ] **Step 1: Write the route**

```typescript
// app/api/product/suggest-names/route.ts
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
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean; `/api/product/suggest-names` appears in the route list.

- [ ] **Step 3: Manual check (curl)**

With an active session and a known mis-transcribed captured row:

```bash
curl -s -X POST http://localhost:3000/api/product/suggest-names \
  -H 'Content-Type: application/json' \
  -d '{"eans":["<EAN_OF_KIYO_KARPIN_ROW>"]}'
# Expect a suggestion with suggested_name "Keo Karpin Oil", changed:true, source "batch" or "grounded".
```
Confirm a high-confidence row is not grounded (`source` != "grounded") and a model failure yields `source:"unchanged"`.

- [ ] **Step 4: Commit**

```bash
git add app/api/product/suggest-names/route.ts
git commit -m "feat: add suggest-names route (tiered correction + gated grounding)"
```

---

### Task 3: "Fix names" button on the categorize page

**Files:**
- Modify: `app/categorize/page.tsx` (suggestion state, fetch handler, button, per-row badge)

**Interfaces:**
- Consumes: `POST /api/product/suggest-names` (Task 2); spec A's `Override` state + `updateOverride` + `effName`/`effBrand`.
- Produces: a "Fix names" button that merges changed suggestions into the override state and badges suggested rows; nothing saves until Save-all.

- [ ] **Step 1: Add suggestion state + handler**

After the `saving` state, add:

```typescript
  const [suggesting, setSuggesting] = useState(false);
  // EANs that received an applied suggestion this pass, for the "suggested" badge.
  const [suggestedEans, setSuggestedEans] = useState<Set<string>>(new Set());
```

Add a handler near `handleSaveAll`:

```typescript
  const handleFixNames = useCallback(async () => {
    if (suggesting || rows.length === 0) return;
    setSuggesting(true);
    const toastId = toast.loading("Suggesting corrected names…");
    try {
      const res = await fetch("/api/product/suggest-names", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eans: rows.map((r) => r.ean) }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
        setState({ kind: "no-active" });
        toast.error("No active audit.", { id: toastId });
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? "Suggestion failed.", { id: toastId });
        return;
      }
      const suggestions: {
        ean: string;
        suggested_name: string;
        suggested_brand: string | null;
        source: string;
        changed: boolean;
      }[] = data.suggestions ?? [];
      const byEan = new Map(suggestions.map((s) => [s.ean, s]));
      const changedEans = new Set<string>();
      // Merge changed suggestions into the per-row override state (not saved yet).
      setSelections((prev) => {
        const next = { ...prev };
        for (const r of rows) {
          const s = byEan.get(r.ean);
          if (!s || !s.changed) continue;
          changedEans.add(r.ean);
          next[r.id] = {
            ...next[r.id],
            name: s.suggested_name,
            brand: s.suggested_brand,
          };
        }
        return next;
      });
      setSuggestedEans(changedEans);
      const n = changedEans.size;
      toast.success(
        n > 0 ? `${n} suggestion${n === 1 ? "" : "s"} applied — review & save` : "No changes suggested",
        { id: toastId, duration: 3000 }
      );
    } catch {
      toast.error("Network error.", { id: toastId });
    } finally {
      setSuggesting(false);
    }
  }, [suggesting, rows]);
```

- [ ] **Step 2: Render the button next to the search box**

Replace the search-box wrapper so the button sits beside it:

```tsx
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or EAN"
              className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
              aria-label="Search worklist by name or EAN"
            />
            <button
              type="button"
              onClick={handleFixNames}
              disabled={suggesting || saving || rows.length === 0}
              className="rounded-md border border-border bg-bg px-4 py-2 text-sm font-medium text-text transition hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
            >
              {suggesting ? "Fixing…" : "Fix names"}
            </button>
          </div>
```

- [ ] **Step 3: Badge suggested rows**

In the name cell (spec A's editable name input), add a badge above the input when the row was suggested. Replace the name `<input>`'s wrapping by adding, right before it:

```tsx
                            {suggestedEans.has(p.ean) && (
                              <span className="mb-1 inline-block rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300">
                                suggested
                              </span>
                            )}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 5: Manual check (page)**

`npm run dev`, open Categorize with the known "Kiyo Karpin Oil" row visible. Click **Fix names**: the row's name input updates to "Keo Karpin Oil", a "suggested" badge appears, Save-all count increments, and nothing is persisted until Save-all. Editing the suggested value still works; a high-confidence correct row is left unchanged.

- [ ] **Step 6: Commit**

```bash
git add app/categorize/page.tsx
git commit -m "feat(categorize): Fix names button (tiered AI correction suggestions)"
```

---

## Self-Review

- **Spec coverage:** confidence-gated two-tier correction (Task 2: Tier 1 all rows `correctNamesBatch`, Tier 2 low-confidence `groundedNamesBatch`, `GROUNDING_MAX` 0.75); manual/`null` + high-confidence rows not grounded (Task 2 filter); never auto-saves — suggestions land in spec A's override state and ride Save-all (Task 3); partial success / per-tier failure → `unchanged` (Task 2 try/catch); grounding+schema risk handled by no-schema + defensive `extractJson`/`parseNameItems` (Task 1); shared helpers built once for spec D reuse (Task 1).
- **Placeholders:** none.
- **Type consistency:** `NameItem`/`NameSuggestion` defined in Task 1, consumed in Task 2; suggestion shape `{ean, suggested_name, suggested_brand, source, changed}` returned in Task 2 and consumed in Task 3; `correctNamesBatch(items, model?)` / `groundedNamesBatch(items, model?)` signatures match call sites; `MODEL_*` constants exported for spec D. `transcribeAudio` third arg optional → existing `/api/transcribe` caller unaffected.
