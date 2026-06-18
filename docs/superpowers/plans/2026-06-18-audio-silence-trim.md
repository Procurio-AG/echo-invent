# Audio Silence Trimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim leading/trailing silence and collapse long internal pauses from each Rapid-Capture voice clip client-side, before upload, to cut Gemini audio-duration tokens without harming the spoken name/MRP.

**Architecture:** A new pure client helper `trimSilence(buffer: AudioBuffer): AudioBuffer` lives next to the existing audio code in `app/rapid-capture/`. `toWavBase64` already decodes the recorded blob into an `AudioBuffer`; we insert `trimSilence` between decode and `encodeWav`. No API, schema, or server change.

**Tech Stack:** Next.js 14 App Router (client component), TypeScript, Web Audio API (`AudioBuffer`, `AudioContext`). No new dependencies.

## Global Constraints

- No automated test framework exists; the verification cycle for every task is `npm run lint` clean + `npm run build` clean + the task's manual check. (Spec: "only `next lint`".)
- Client-side only. No change to `/api/transcribe`, Prisma schema, or any route.
- Tuning constants (thresholds, pause/gap/padding durations, floors) must be named `const`s at the top of the helper.
- Never upload an over-trimmed clip: if the trimmed result is below a minimum kept-audio floor, return the original buffer unchanged.
- Operate on the mono channel only (capture is `channelCount: 1`; `encodeWav` already reads channel 0).

---

### Task 1: `trimSilence` helper module

**Files:**
- Create: `app/rapid-capture/trim-silence.ts`

**Interfaces:**
- Consumes: the `AudioBuffer` produced by `ctx.decodeAudioData(...)` inside `toWavBase64`.
- Produces: `trimSilence(buffer: AudioBuffer): AudioBuffer` — a new mono `AudioBuffer` (same `sampleRate`) containing only voiced regions with collapsed internal pauses, OR the original `buffer` when trimming would drop below the kept-audio floor. Also exports the named tuning constants for the call site / tests to reference.

- [ ] **Step 1: Write the helper**

The algorithm: frame the mono signal at ~20 ms, compute per-frame RMS, derive an adaptive threshold from the clip's own noise floor and peak, mark frames voiced/silent, drop leading/trailing silence, collapse internal silent runs > `MAX_GAP_S` down to `KEPT_GAP_S`, pad voiced regions by `PAD_S`, concatenate kept samples into a fresh `AudioBuffer`. Fall back to the original if kept audio < `MIN_KEPT_S`.

```typescript
// app/rapid-capture/trim-silence.ts
// Client-side silence trimming for Rapid-Capture voice clips. Pure function over
// an AudioBuffer (mono) — cuts dead air so we upload (and pay Gemini for) less
// audio duration, without clipping the spoken name/MRP. No dependencies.

// --- tuning constants (top of file for easy adjustment) --------------------
const FRAME_MS = 20; // analysis frame length
const MAX_GAP_S = 0.6; // internal silent runs longer than this get collapsed
const KEPT_GAP_S = 0.2; // ...down to this much retained silence (word boundary)
const PAD_S = 0.1; // lead-in / lead-out kept around each voiced region
const MIN_KEPT_S = 0.3; // if kept voiced audio is shorter, fall back to original
const FLOOR_DBFS = -45; // absolute silence ceiling: never treat above this as silence
const NOISE_MULT = 2.0; // threshold = max(noiseFloor * NOISE_MULT, dBFS floor)

const DBFS_FLOOR_LINEAR = Math.pow(10, FLOOR_DBFS / 20);

function rms(data: Float32Array, start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += data[i] * data[i];
  const n = Math.max(1, end - start);
  return Math.sqrt(sum / n);
}

export function trimSilence(buffer: AudioBuffer): AudioBuffer {
  const sampleRate = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const total = data.length;
  const frameLen = Math.max(1, Math.round((FRAME_MS / 1000) * sampleRate));
  const frameCount = Math.ceil(total / frameLen);
  if (frameCount === 0) return buffer;

  // Per-frame RMS.
  const energies = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const s = f * frameLen;
    energies[f] = rms(data, s, Math.min(total, s + frameLen));
  }

  // Adaptive threshold from this clip's own noise floor (low percentile) and an
  // absolute dBFS floor, so loud and quiet recordings both trim sensibly.
  const sorted = Float32Array.from(energies).sort();
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const threshold = Math.max(noiseFloor * NOISE_MULT, DBFS_FLOOR_LINEAR);

  const voiced: boolean[] = new Array(frameCount);
  for (let f = 0; f < frameCount; f++) voiced[f] = energies[f] >= threshold;

  // First/last voiced frame -> drop leading/trailing silence entirely.
  let first = voiced.indexOf(true);
  let last = voiced.lastIndexOf(true);
  if (first === -1) return buffer; // all silence: let downstream too-short guard handle it

  const padFrames = Math.round((PAD_S * sampleRate) / frameLen);
  first = Math.max(0, first - padFrames);
  last = Math.min(frameCount - 1, last + padFrames);

  const maxGapFrames = Math.round((MAX_GAP_S * sampleRate) / frameLen);
  const keptGapFrames = Math.max(1, Math.round((KEPT_GAP_S * sampleRate) / frameLen));

  // Walk frames first..last, keeping voiced frames and collapsing long silent runs.
  const keptFrames: number[] = [];
  let f = first;
  while (f <= last) {
    if (voiced[f]) {
      keptFrames.push(f);
      f++;
      continue;
    }
    // measure the silent run
    let g = f;
    while (g <= last && !voiced[g]) g++;
    const runLen = g - f;
    const keep = runLen > maxGapFrames ? keptGapFrames : runLen;
    for (let k = 0; k < keep; k++) keptFrames.push(f + k);
    f = g;
  }

  const keptSamples = keptFrames.length * frameLen;
  if (keptSamples < MIN_KEPT_S * sampleRate) return buffer;

  // Concatenate kept frames into a fresh buffer (clamp the final frame to total).
  const out = new AudioBuffer({
    length: keptSamples,
    numberOfChannels: 1,
    sampleRate,
  });
  const dst = out.getChannelData(0);
  let w = 0;
  for (const fr of keptFrames) {
    const s = fr * frameLen;
    const e = Math.min(total, s + frameLen);
    for (let i = s; i < e; i++) dst[w++] = data[i];
  }
  // If the last frame was short, w < keptSamples; the tail stays zero-filled,
  // which is silence and harmless.
  return out;
}

export const TRIM_CONSTANTS = {
  FRAME_MS,
  MAX_GAP_S,
  KEPT_GAP_S,
  PAD_S,
  MIN_KEPT_S,
  FLOOR_DBFS,
  NOISE_MULT,
};
```

- [ ] **Step 2: Lint + typecheck the new module**

Run: `npm run lint`
Expected: clean (no errors for the new file). `AudioBuffer` constructor is standard DOM-lib typed; if the TS DOM lib flags the `new AudioBuffer({...})` options form, fall back to `ctx.createBuffer(1, keptSamples, sampleRate)` — but the call site has the `ctx`, the helper does not, so prefer the constructor.

- [ ] **Step 3: Commit**

```bash
git add app/rapid-capture/trim-silence.ts
git commit -m "feat(rapid-capture): add client-side trimSilence audio helper"
```

---

### Task 2: Wire `trimSilence` into `toWavBase64`

**Files:**
- Modify: `app/rapid-capture/page.tsx` (import + the `toWavBase64` body, around lines 94-108)

**Interfaces:**
- Consumes: `trimSilence` from Task 1.
- Produces: `toWavBase64` now uploads a shorter WAV; signature and return type `{ base64, mimeType }` are unchanged, so `handleRecordingStop` and everything downstream are untouched.

- [ ] **Step 1: Import the helper**

Add near the other imports at the top of `app/rapid-capture/page.tsx`:

```typescript
import { trimSilence } from "@/app/rapid-capture/trim-silence";
```

- [ ] **Step 2: Call `trimSilence` between decode and encode**

Replace the body of `toWavBase64` (currently decodes then `encodeWav(buf)`) so it trims first and logs original-vs-trimmed duration for the manual check:

```typescript
async function toWavBase64(blob: Blob): Promise<{ base64: string; mimeType: string }> {
  const AC =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const trimmed = trimSilence(buf);
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.debug(
        `trimSilence: ${buf.duration.toFixed(2)}s -> ${trimmed.duration.toFixed(2)}s`
      );
    }
    const wav = encodeWav(trimmed);
    const base64 = await blobToBase64(new Blob([wav], { type: "audio/wav" }));
    return { base64, mimeType: "audio/wav" };
  } finally {
    void ctx.close();
  }
}
```

- [ ] **Step 3: Lint + build**

Run: `npm run lint && npm run build`
Expected: both clean.

- [ ] **Step 4: Manual check (record cycle)**

Run `npm run dev`, open Rapid Capture in an active session, scan a test EAN, hold-record a clip with a deliberate long mid-sentence pause, release. In the browser console confirm the `trimSilence: X.XXs -> Y.YYs` line shows a shorter trimmed duration, and the resulting transcription still returns the right name + MRP. Then record a near-silent clip and confirm it falls back (trimmed ≈ original duration) rather than uploading near-nothing, and that the existing too-short / low-confidence paths still behave.

- [ ] **Step 5: Commit**

```bash
git add app/rapid-capture/page.tsx
git commit -m "feat(rapid-capture): trim silence before uploading capture WAV"
```

---

## Self-Review

- **Spec coverage:** helper with framing/RMS/adaptive-threshold/drop-ends/collapse-internal/pad/concat — Task 1. Safety fallback below `MIN_KEPT_S` and all-silence guard — Task 1. Named tuning constants — Task 1. `toWavBase64` calls it before `encodeWav`, downstream unchanged — Task 2. Duration logging for the "uploads visibly shorter" check — Task 2. All spec "Verification" bullets covered by Task 2 Step 4.
- **Placeholders:** none — full helper and full call-site code provided.
- **Type consistency:** `trimSilence(buffer: AudioBuffer): AudioBuffer` defined in Task 1, consumed with that exact signature in Task 2; `toWavBase64` return type `{ base64, mimeType }` preserved.
