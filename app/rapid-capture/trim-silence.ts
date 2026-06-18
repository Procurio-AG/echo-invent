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
