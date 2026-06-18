# Batch Capture + Multi-Model Transcription Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure Rapid Capture from per-item transcribe-on-release into capture-many (locally queued in IndexedDB) → transcribe-once through a multi-model pipeline (hear → verify/repair → spell → gated grounding), ending in a review-then-save screen.

**Architecture:** A client IndexedDB queue stores each recorded compressed clip keyed by EAN. A record-time silence gate rejects dead clips with no network call. One "Transcribe" press decodes/trims all clips and POSTs them to a new batch route. The route runs Stage 1 (batched audio on the hearing model) with echo-and-verify alignment, per-item repair on the repair model, Stage 2 (text spelling), and Stage 3 (gated grounding) — each on a distinct model bucket. Results render as an editable review list saved via the existing create route.

**Tech Stack:** Next.js 14 App Router (client component), TypeScript, IndexedDB, Web Audio API, Prisma 5 + PostgreSQL, Gemini REST, react-hot-toast.

## Global Constraints

- No automated test framework; per-task cycle = `npm run build` clean + manual check.
- **Depends on spec C** (`app/rapid-capture/trim-silence.ts` exists; this plan adds `voicedSeconds` to it) and **spec B** (`lib/gemini.ts` model-parameterized caller, `MODEL_*` constants, `GeminiQuotaError`, `correctNamesBatch`, `groundedNamesBatch`). Both must be implemented first.
- Model ids are the env-overridable `MODEL_HEAR`/`MODEL_REPAIR`/`MODEL_SPELL`/`MODEL_GROUND` from spec B (default `gemini-2.5-flash`).
- Alignment is never trusted, only verified: validate output length, every echoed EAN ∈ the scanned set, and position-by-position EAN match; repair any unaligned row individually on `MODEL_REPAIR`.
- Queue cap 25; queue survives reload; near-silent clips rejected at record time. The IndexedDB queue is **not** cleared on quota exhaustion.
- The review screen saves each row through the unchanged `POST /api/product/create` (`status:"captured"`); clear saved EANs from the queue on success.
- `GROUNDING_MAX` default `0.75` (matches spec B).

---

### Task 1: Add `voicedSeconds` to the trim helper (record-time silence gate)

**Files:**
- Modify: `app/rapid-capture/trim-silence.ts` (add an exported voiced-duration helper reusing the existing constants)

**Interfaces:**
- Produces: `voicedSeconds(buffer: AudioBuffer): number` — total seconds of voiced (above-threshold) audio, using the same framing/threshold as `trimSilence`. The gate rejects a clip when `voicedSeconds(buf) < TRIM_CONSTANTS.MIN_KEPT_S`.

- [ ] **Step 1: Append `voicedSeconds`**

Add to `app/rapid-capture/trim-silence.ts`, after `trimSilence` (it reuses module-level `FRAME_MS`, `NOISE_MULT`, `DBFS_FLOOR_LINEAR`, and `rms`):

```typescript
// Total seconds of voiced audio (above the adaptive threshold). Used by the
// record-time gate to reject near-silent clips before they are ever queued.
export function voicedSeconds(buffer: AudioBuffer): number {
  const sampleRate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const total = data.length;
  const frameLen = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const frameCount = Math.ceil(total / frameLen);
  if (frameCount === 0) return 0;

  const energies = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const s = f * frameLen;
    energies[f] = rms(data, s, Math.min(total, s + frameLen));
  }
  const sorted = Float32Array.from(energies).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const threshold = Math.max(noiseFloor * NOISE_MULT, DBFS_FLOOR_LINEAR);

  let voicedFrames = 0;
  for (let f = 0; f < frameCount; f++) if (energies[f] >= threshold) voicedFrames++;
  return (voicedFrames * frameLen) / sampleRate;
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add app/rapid-capture/trim-silence.ts
git commit -m "feat(rapid-capture): voicedSeconds helper for record-time silence gate"
```

---

### Task 2: `transcribeBatch` (Stage 1) in `lib/gemini.ts`

**Files:**
- Modify: `lib/gemini.ts` (add the batch type, schema, prompt, parser, and `transcribeBatch`)

**Interfaces:**
- Consumes: `callGemini`, `MODEL_HEAR`, `extractJson` (from spec B).
- Produces:
  - `type BatchClip = { ean: string; audioBase64: string; mimeType: string }`.
  - `type BatchTranscription = { ean: string; name: string; brand: string | null; mrp: number | null; confidence: number; needs_review: boolean }`.
  - `transcribeBatch(items: BatchClip[], model?: string): Promise<BatchTranscription[]>` (default `MODEL_HEAR`). Throws `GeminiQuotaError` on all-keys-429 (so the route can fall back to `MODEL_REPAIR`).

- [ ] **Step 1: Append the batch helper**

Add to `lib/gemini.ts`:

```typescript
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
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/gemini.ts
git commit -m "feat(gemini): transcribeBatch (Stage 1 batched audio with EAN echo)"
```

---

### Task 3: IndexedDB queue module

**Files:**
- Create: `app/rapid-capture/queue.ts`

**Interfaces:**
- Produces:
  - `type QueuedClip = { ean: string; blob: Blob; mimeType: string; order: number }`.
  - `enqueueClip(ean: string, blob: Blob, mimeType: string): Promise<void>` (assigns the next order; overwrites a same-EAN entry).
  - `listClips(): Promise<QueuedClip[]>` (sorted by `order`).
  - `removeClips(eans: string[]): Promise<void>`.
  - `countClips(): Promise<number>`.
  - `QUEUE_MAX = 25`.

- [ ] **Step 1: Write the module**

```typescript
// app/rapid-capture/queue.ts
// IndexedDB-backed queue of recorded clips, keyed by EAN. Stores the original
// COMPRESSED blob (not decoded WAV) so the store stays ~10x smaller and survives
// reload / tab background / phone lock. Decode->trim->WAV happens at Transcribe.

export const QUEUE_MAX = 25;

const DB_NAME = "rapid-capture";
const STORE = "clips";
const DB_VERSION = 1;

export type QueuedClip = {
  ean: string;
  blob: Blob;
  mimeType: string;
  order: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "ean" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export async function listClips(): Promise<QueuedClip[]> {
  const db = await openDb();
  try {
    const all = (await asPromise(tx(db, "readonly").getAll())) as QueuedClip[];
    return all.sort((a, b) => a.order - b.order);
  } finally {
    db.close();
  }
}

export async function countClips(): Promise<number> {
  const db = await openDb();
  try {
    return await asPromise(tx(db, "readonly").count());
  } finally {
    db.close();
  }
}

export async function enqueueClip(
  ean: string,
  blob: Blob,
  mimeType: string
): Promise<void> {
  const db = await openDb();
  try {
    const all = (await asPromise(tx(db, "readonly").getAll())) as QueuedClip[];
    const nextOrder =
      all.length === 0 ? 0 : Math.max(...all.map((c) => c.order)) + 1;
    const existing = all.find((c) => c.ean === ean);
    const order = existing ? existing.order : nextOrder;
    await asPromise(tx(db, "readwrite").put({ ean, blob, mimeType, order }));
  } finally {
    db.close();
  }
}

export async function removeClips(eans: string[]): Promise<void> {
  if (eans.length === 0) return;
  const db = await openDb();
  try {
    const store = tx(db, "readwrite");
    await Promise.all(eans.map((ean) => asPromise(store.delete(ean))));
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean (the module is client-only but type-checks server-side; `indexedDB` is a DOM global — it is only *called* from client handlers, never at import time).

- [ ] **Step 3: Commit**

```bash
git add app/rapid-capture/queue.ts
git commit -m "feat(rapid-capture): IndexedDB clip queue module"
```

---

### Task 4: `POST /api/transcribe/batch` pipeline route

**Files:**
- Create: `app/api/transcribe/batch/route.ts`

**Interfaces:**
- Consumes: `transcribeBatch`, `transcribeAudio`, `correctNamesBatch`, `groundedNamesBatch`, `GeminiQuotaError`, `MODEL_REPAIR`, `type BatchClip` (Tasks 2 + spec B).
- Produces: `POST /api/transcribe/batch` body `{ items: BatchClip[] }` (cap 25) → `{ rows: [{ ean, name, brand, mrp, confidence, source, flags }] }`, `source ∈ {"batch","repair","grounded"}`. `409 NO_ACTIVE_SESSION`; `409 QUOTA_EXHAUSTED` when both hearing + repair buckets are exhausted.

- [ ] **Step 1: Write the route**

```typescript
// app/api/transcribe/batch/route.ts
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
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean; `/api/transcribe/batch` appears in the route list.

- [ ] **Step 3: Commit**

```bash
git add app/api/transcribe/batch/route.ts
git commit -m "feat: batch transcription pipeline route (hear/verify/spell/ground)"
```

---

### Task 5: Rapid-Capture queue-and-batch flow + review screen

**Files:**
- Modify: `app/rapid-capture/page.tsx` (record stop → silence gate → enqueue; queue badge + Transcribe button; review screen; Save-all)

**Interfaces:**
- Consumes: `enqueueClip`, `listClips`, `removeClips`, `countClips`, `QUEUE_MAX`, `QueuedClip` (Task 3); `voicedSeconds`, `TRIM_CONSTANTS` (Task 1); `toWavBase64`, `saveCaptured`, `composeName` (existing); `POST /api/transcribe/batch` (Task 4).
- Produces: recording enqueues instead of POSTing; a Transcribe button converts the whole queue; a review list edits then saves each row via `create`.

- [ ] **Step 1: Imports + new state + helpers**

Add imports near the top of `app/rapid-capture/page.tsx`:

```typescript
import {
  enqueueClip,
  listClips,
  removeClips,
  countClips,
  QUEUE_MAX,
} from "@/app/rapid-capture/queue";
import { voicedSeconds, TRIM_CONSTANTS } from "@/app/rapid-capture/trim-silence";
```

Add a review-row type next to the other `type` declarations:

```typescript
type ReviewRow = {
  ean: string;
  name: string;
  brand: string | null;
  mrp: string;
  confidence: number | null;
  source: string;
  flags: string[];
};
```

Inside the component, add state (near the existing `useState`s):

```typescript
  const [queueCount, setQueueCount] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [review, setReview] = useState<ReviewRow[] | null>(null);
  const [savingAll, setSavingAll] = useState(false);
```

Add a decode helper (module scope, beside `toWavBase64`) so the gate can decode without re-implementing the AudioContext dance:

```typescript
async function decodeClip(blob: Blob): Promise<AudioBuffer> {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new AC();
  try {
    return await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close();
  }
}
```

- [ ] **Step 2: Restore the queue count on load**

Add an effect (after the session effect) so the badge reflects a queue that survived reload:

```typescript
  useEffect(() => {
    if (session.kind !== "active") return;
    countClips()
      .then(setQueueCount)
      .catch(() => setQueueCount(0));
  }, [session.kind]);
```

- [ ] **Step 3: Replace `handleRecordingStop` with the gate-and-enqueue flow**

Replace the entire `handleRecordingStop` `useCallback` with:

```typescript
  const handleRecordingStop = useCallback(
    async (ean: string, mimeType: string) => {
      const blob = new Blob(chunksRef.current, {
        type: mimeType || "audio/webm",
      });
      chunksRef.current = [];
      if (blob.size < MIN_BLOB_BYTES) {
        toast("Too short — hold and say the name and MRP.");
        resetActive();
        return;
      }
      // Local silence gate: decode + measure voiced audio. No model call.
      try {
        const buf = await decodeClip(blob);
        if (voicedSeconds(buf) < TRIM_CONSTANTS.MIN_KEPT_S) {
          toast("Didn't catch that — hold and say it again.");
          resetActive();
          return;
        }
      } catch {
        // If decode fails, fall through and queue it anyway — better than dropping.
      }
      try {
        await enqueueClip(ean, blob, mimeType || "audio/webm");
        const n = await countClips();
        setQueueCount(n);
        toast.success(`Queued (${n}/${QUEUE_MAX})`);
      } catch {
        toast.error("Couldn't queue the clip — try again.");
      }
      resetActive();
    },
    [resetActive]
  );
```

- [ ] **Step 4: Cap the queue at scan time**

In `handleScan`, after the existing guards (right after `const ean = raw.trim(); if (!ean) return;`), block new scans when the queue is full:

```typescript
      if (queueCount >= QUEUE_MAX) {
        toast.error(`Queue full (${QUEUE_MAX}). Transcribe before scanning more.`);
        return;
      }
```

And add `queueCount` to the `handleScan` dependency array.

- [ ] **Step 5: Add the Transcribe handler**

Add near `saveCaptured`:

```typescript
  const handleTranscribe = useCallback(async () => {
    if (transcribing) return;
    const clips = await listClips();
    if (clips.length === 0) return;
    setTranscribing(true);
    const toastId = toast.loading(`Transcribing ${clips.length}…`);
    try {
      const items = await Promise.all(
        clips.map(async (c) => {
          const { base64, mimeType } = await toWavBase64(c.blob);
          return { ean: c.ean, audioBase64: base64, mimeType };
        })
      );
      const res = await fetch("/api/transcribe/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
        setSession({ kind: "no-active" });
        toast.error("No active audit.", { id: toastId });
        return;
      }
      if (res.status === 409 && data.code === "QUOTA_EXHAUSTED") {
        toast.error("Quota reached for today — queue saved, try later.", {
          id: toastId,
          duration: 5000,
        });
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? "Transcription failed.", { id: toastId });
        return;
      }
      const rows: ReviewRow[] = (data.rows ?? []).map(
        (r: {
          ean: string;
          name: string;
          brand: string | null;
          mrp: number | null;
          confidence: number | null;
          source: string;
          flags: string[];
        }) => ({
          ean: r.ean,
          name: r.name ?? "",
          brand: r.brand ?? null,
          mrp: r.mrp != null ? String(r.mrp) : "",
          confidence: r.confidence,
          source: r.source,
          flags: r.flags ?? [],
        })
      );
      setReview(rows);
      toast.success("Review and save.", { id: toastId, duration: 2000 });
    } catch {
      toast.error("Network error while transcribing.", { id: toastId });
    } finally {
      setTranscribing(false);
    }
  }, [transcribing]);
```

- [ ] **Step 6: Add the Save-all handler for the review screen**

Add after `handleTranscribe`:

```typescript
  const handleSaveReview = useCallback(async () => {
    if (!review || savingAll) return;
    setSavingAll(true);
    const toastId = toast.loading("Saving all…");
    const savedEans: string[] = [];
    try {
      for (const row of review) {
        if (!row.name.trim()) continue; // skip empty rows; leave them queued
        const mrpNum = row.mrp.trim() ? Number(row.mrp) : null;
        const mrp =
          Number.isFinite(mrpNum as number) && (mrpNum as number) > 0
            ? (mrpNum as number)
            : null;
        await saveCaptured(row.ean, row.name.trim(), row.brand, mrp, {
          confidence: row.confidence ?? undefined,
        });
        savedEans.push(row.ean);
      }
      await removeClips(savedEans);
      const n = await countClips();
      setQueueCount(n);
      setReview(null);
      toast.success(`Saved ${savedEans.length}.`, { id: toastId });
    } catch {
      toast.error("Some rows failed to save.", { id: toastId });
    } finally {
      setSavingAll(false);
    }
  }, [review, savingAll, saveCaptured]);
```

- [ ] **Step 7: Render the queue badge + Transcribe button, and the review screen**

In the `session.kind === "active"` block, just after the `<HiddenScanInput .../>` element, add the queue controls (hidden while reviewing):

```tsx
          {!review && queueCount > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-surface p-4">
              <span className="text-sm">
                {queueCount} queued{" "}
                <span className="text-muted">(max {QUEUE_MAX})</span>
              </span>
              <button
                type="button"
                onClick={handleTranscribe}
                disabled={transcribing}
                className="rounded-md bg-text px-4 py-2 text-sm font-medium text-bg disabled:opacity-50"
              >
                {transcribing ? "Transcribing…" : `Transcribe (${queueCount})`}
              </button>
            </div>
          )}

          {review && (
            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <p className="text-sm font-medium">Review {review.length} item(s)</p>
              <div className="space-y-3">
                {review.map((row, i) => (
                  <div
                    key={row.ean}
                    className="space-y-2 rounded-md border border-border p-3"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-muted">{row.ean}</span>
                      <span className="text-[10px] uppercase tracking-wider text-muted">
                        {row.source}
                        {row.flags.length > 0 ? ` · ${row.flags.join(", ")}` : ""}
                      </span>
                    </div>
                    <input
                      value={row.name}
                      onChange={(e) =>
                        setReview((prev) =>
                          prev
                            ? prev.map((r, j) =>
                                j === i ? { ...r, name: e.target.value } : r
                              )
                            : prev
                        )
                      }
                      placeholder="Product name"
                      className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
                    />
                    <div className="flex gap-2">
                      <input
                        value={row.brand ?? ""}
                        onChange={(e) =>
                          setReview((prev) =>
                            prev
                              ? prev.map((r, j) =>
                                  j === i
                                    ? { ...r, brand: e.target.value || null }
                                    : r
                                )
                              : prev
                          )
                        }
                        placeholder="Brand (optional)"
                        className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
                      />
                      <input
                        value={row.mrp}
                        onChange={(e) =>
                          setReview((prev) =>
                            prev
                              ? prev.map((r, j) =>
                                  j === i ? { ...r, mrp: e.target.value } : r
                                )
                              : prev
                          )
                        }
                        inputMode="decimal"
                        placeholder="MRP"
                        className="w-28 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveReview}
                  disabled={savingAll}
                  className="flex-1 rounded-md bg-text px-3 py-2 text-sm font-medium text-bg disabled:opacity-50"
                >
                  {savingAll ? "Saving…" : "Save all"}
                </button>
                <button
                  type="button"
                  onClick={() => setReview(null)}
                  className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-text"
                >
                  Back
                </button>
              </div>
            </div>
          )}
```

- [ ] **Step 8: Build**

Run: `npm run build`
Expected: clean. Resolve any unused-symbol errors: the old `pending`/`setPending` low-confidence card path is now superseded by the review screen, but **leave the existing `pending` card and manual `ProductForm` fallback in place** — they still serve the no-mic and re-record paths. The only behavioral change is that a successful recording now enqueues instead of POSTing to `/api/transcribe`.

- [ ] **Step 9: Manual check (full flow)**

`npm run dev`, Rapid Capture in an active session:
- Scan + record several items; each shows "Queued (n/25)" and no network transcribe call fires. A deliberately silent hold is rejected ("Didn't catch that") with no queue increment.
- Reload the page: the badge restores the queued count.
- Press **Transcribe (n)**: a review list appears with one row per EAN, each matched to its scanned barcode; low-confidence/repaired rows show their `source`/flags. Edit a name, press **Save all**: rows persist as `captured`, the queue clears, and the badge returns to 0.
- Scanning past 25 without transcribing is blocked.

- [ ] **Step 10: Commit**

```bash
git add app/rapid-capture/page.tsx
git commit -m "feat(rapid-capture): capture-many queue + batch transcribe + review screen"
```

---

## Self-Review

- **Spec coverage:** record-time silence gate with no model call (Task 1 + Task 5 Step 3); Stage 1 batched audio with delimiter-interleaved parts + EAN echo (Task 2); echo-and-verify alignment by position with EAN checksum + membership + per-item repair on `MODEL_REPAIR` (Task 4); overflow fallback hearing→repair then `QUOTA_EXHAUSTED` with queue preserved (Task 4 + Task 5 Step 5 leaves the queue intact on that code); Stage 2 text spelling + Stage 3 gated grounding on distinct buckets (Task 4); IndexedDB queue storing compressed blob, survives reload, cap 25 (Task 3 + Task 5 Steps 2,4); review-then-save via existing `create` then clear saved EANs (Task 5 Step 6); manual/no-mic fallback retained (Task 5 Step 8).
- **Placeholders:** none — full code for every module.
- **Type consistency:** `BatchClip`/`BatchTranscription` defined in Task 2, consumed in Task 4 and (as the POST body shape) Task 5; `Row.source ∈ {"batch","repair","grounded"}` and `flags` strings match the spec; `QueuedClip`/`enqueueClip`/`listClips`/`removeClips`/`countClips`/`QUEUE_MAX` defined in Task 3 and consumed in Task 5; `voicedSeconds`/`TRIM_CONSTANTS.MIN_KEPT_S` from Task 1 used in Task 5; `saveCaptured`'s existing `{confidence?, transcript?}` extra arg is honored (Task 5 passes `confidence`).
