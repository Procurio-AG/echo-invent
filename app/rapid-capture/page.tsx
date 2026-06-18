"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import {
  HiddenScanInput,
  type HiddenScanInputHandle,
} from "@/app/components/HiddenScanInput";
import { ProductForm } from "@/app/components/ProductForm";
import { trimSilence } from "@/app/rapid-capture/trim-silence";

type SessionState =
  | { kind: "loading" }
  | { kind: "no-active" }
  | { kind: "active" };

type MicState = "checking" | "ready" | "denied" | "unsupported";
type Phase = "idle" | "recording" | "transcribing";

type Pending = {
  ean: string;
  name: string;
  brand: string | null;
  mrp: string;
  transcript?: string;
};

type Recent = {
  ean: string;
  name: string;
  brand: string | null;
  mrp: number | null;
};

const MIN_BLOB_BYTES = 1500;

// Compose the stored item name from the separately-extracted brand and the
// descriptive name (which already carries any spoken quantity/size, e.g.
// "Khus Syrup 750ml"). Brand is prepended so the saved name reads
// "Haldiram Khus Syrup 750ml" — unless the name already leads with the brand,
// in which case we leave it as-is to avoid doubling it.
function composeName(brand: string | null, name: string): string {
  const n = name.trim();
  const b = brand?.trim();
  if (!b) return n;
  if (!n) return b;
  if (n.toLowerCase().startsWith(b.toLowerCase())) return n;
  return `${b} ${n}`;
}

// --- audio helpers (client-side, no deps) ----------------------------------

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onloadend = () => resolve(String(fr.result).split(",")[1] ?? "");
    fr.onerror = () => reject(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(blob);
  });
}

function encodeWav(buffer: AudioBuffer): ArrayBuffer {
  const sampleRate = buffer.sampleRate;
  const ch = buffer.getChannelData(0); // mono (we capture channelCount:1)
  const len = ch.length;
  const out = new ArrayBuffer(44 + len * 2);
  const view = new DataView(out);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return out;
}

// Always decode whatever MediaRecorder produced (webm/opus on Android,
// mp4/aac on iOS) into a WAV — a format Gemini reliably accepts.
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

// ---------------------------------------------------------------------------

export default function RapidCapturePage() {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const [mic, setMic] = useState<MicState>("checking");
  const [phase, setPhase] = useState<Phase>("idle");
  const [looking, setLooking] = useState(false);
  const [activeEan, setActiveEan] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [manualEan, setManualEan] = useState<string | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);

  const micStreamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const scanRef = useRef<HiddenScanInputHandle>(null);

  const paused = looking || !!activeEan || !!pending || !!manualEan;

  const refetchSession = useCallback(async () => {
    try {
      const res = await fetch("/api/session/active", { cache: "no-store" });
      const data = await res.json();
      setSession(data.session ? { kind: "active" } : { kind: "no-active" });
    } catch {
      setSession({ kind: "no-active" });
    }
  }, []);

  useEffect(() => {
    refetchSession();
  }, [refetchSession]);

  // Acquire the mic once for the whole session and reuse it for every clip.
  useEffect(() => {
    if (session.kind !== "active") return;
    let stream: MediaStream | null = null;
    (async () => {
      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof window.MediaRecorder === "undefined"
      ) {
        setMic("unsupported");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        micStreamRef.current = stream;
        setMic("ready");
      } catch {
        setMic("denied");
      }
    })();
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    };
  }, [session.kind]);

  const resetActive = useCallback(() => {
    setActiveEan(null);
    setPhase("idle");
  }, []);

  const saveCaptured = useCallback(
    async (
      ean: string,
      name: string,
      brand: string | null,
      mrp: number | null,
      extra?: { confidence?: number; transcript?: string }
    ) => {
      // Brand is stored separately (original_data.brand) AND folded into the
      // item name so the worklist shows e.g. "Haldiram Khus Syrup 750ml".
      const fullName = composeName(brand, name);
      try {
        const res = await fetch("/api/product/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ean,
            name: fullName,
            mrp,
            status: "captured",
            original_data: {
              brand,
              confidence: extra?.confidence ?? null,
              transcript: extra?.transcript ?? null,
            },
          }),
        });
        const data = await res.json();
        if (res.status === 201) {
          setRecent((r) => [{ ean, name: fullName, brand, mrp }, ...r].slice(0, 6));
          toast.success(`Saved: ${fullName}${mrp != null ? ` · ₹${mrp}` : ""}`);
        } else if (res.status === 409 && data.code === "ALREADY_EXISTS") {
          toast(`${ean} already exists in this session.`);
        } else if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
          setSession({ kind: "no-active" });
        } else {
          toast.error(data.error ?? "Save failed.");
        }
      } catch {
        toast.error("Network error while saving.");
      }
    },
    []
  );

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
      setPhase("transcribing");
      try {
        const { base64, mimeType: sendMime } = await toWavBase64(blob);
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audioBase64: base64, mimeType: sendMime, ean }),
        });
        const data = await res.json();
        if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
          setSession({ kind: "no-active" });
          resetActive();
          return;
        }
        if (res.ok) {
          await saveCaptured(ean, data.name, data.brand ?? null, data.mrp ?? null, {
            confidence: data.confidence,
            transcript: data.transcript,
          });
          resetActive();
          return;
        }
        // 422 low-confidence / other: hand off to the editable card.
        setPending({
          ean,
          name: typeof data.name === "string" ? data.name : "",
          brand: typeof data.brand === "string" ? data.brand : null,
          mrp: data.mrp != null ? String(data.mrp) : "",
          transcript: data.transcript,
        });
        setActiveEan(null);
        setPhase("idle");
        toast("Didn't catch that clearly — confirm or type it.");
      } catch {
        setPending({ ean, name: "", brand: null, mrp: "" });
        setActiveEan(null);
        setPhase("idle");
        toast.error("Couldn't transcribe — type it or re-record.");
      }
    },
    [resetActive, saveCaptured]
  );

  const handleScan = useCallback(
    async (raw: string) => {
      const ean = raw.trim();
      if (!ean) return;
      if (looking || activeEan || pending || manualEan || phase !== "idle") return;
      setLooking(true);
      try {
        const res = await fetch(`/api/product/${encodeURIComponent(ean)}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
          setSession({ kind: "no-active" });
          return;
        }
        if (res.ok) {
          toast(`Already in session: ${data.product?.name ?? ean}`);
          return;
        }
        if (res.status === 404 && data.code === "NOT_FOUND") {
          setActiveEan(ean);
          if (mic !== "ready") setManualEan(ean); // no mic -> type it
          return;
        }
        toast.error(data.error ?? "Lookup failed.");
      } catch {
        toast.error("Network error.");
      } finally {
        setLooking(false);
      }
    },
    [looking, activeEan, pending, manualEan, phase, mic]
  );

  const startRecording = useCallback(() => {
    const stream = micStreamRef.current;
    if (!stream || phase !== "idle" || !activeEan) return;
    chunksRef.current = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      toast.error("Recorder unavailable — type it instead.");
      setManualEan(activeEan);
      setActiveEan(null);
      return;
    }
    recorderRef.current = recorder;
    const ean = activeEan;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    // Drive the pipeline off 'stop' so iOS finishes finalizing the clip.
    recorder.onstop = () => {
      void handleRecordingStop(ean, recorder.mimeType);
    };
    recorder.start();
    setPhase("recording");
  }, [phase, activeEan, handleRecordingStop]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          Rapid Capture
        </p>
        <h1 className="font-serif text-3xl tracking-tight">Scan &amp; speak</h1>
        <p className="text-xs text-muted">
          Scan with a connected USB or Bluetooth barcode scanner, then hold the
          button and say the name and MRP. Pricing and category are filled later
          in their worklists.
        </p>
      </header>

      {session.kind === "loading" && <p className="text-sm text-muted">Loading…</p>}

      {session.kind === "no-active" && (
        <div className="rounded-lg border border-border bg-surface p-5">
          <p className="text-sm font-medium">No active audit</p>
          <p className="mt-1 text-xs text-muted">
            Upload a sheet on the dashboard to start a session.
          </p>
        </div>
      )}

      {session.kind === "active" && (
        <>
          {mic === "denied" && (
            <p className="rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              Microphone blocked — you can still scan and type details manually.
            </p>
          )}
          {mic === "unsupported" && (
            <p className="rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              Voice not supported in this browser — scan and type manually.
            </p>
          )}

          <HiddenScanInput
            ref={scanRef}
            released={paused}
            onScan={handleScan}
          />

          {looking && <p className="text-xs text-muted">Looking up…</p>}

          {/* Voice capture for a freshly-scanned barcode */}
          {activeEan && mic === "ready" && (
            <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted">{activeEan}</span>
                <button
                  type="button"
                  onClick={() => {
                    setManualEan(activeEan);
                    setActiveEan(null);
                  }}
                  className="text-xs text-muted underline hover:text-text"
                >
                  Type instead
                </button>
              </div>

              {phase === "transcribing" ? (
                <p className="py-4 text-center text-sm text-muted">Transcribing…</p>
              ) : (
                <button
                  type="button"
                  onPointerDown={startRecording}
                  onPointerUp={stopRecording}
                  onPointerLeave={stopRecording}
                  onPointerCancel={stopRecording}
                  onContextMenu={(e) => e.preventDefault()}
                  className={`w-full select-none touch-none rounded-md px-4 py-6 text-center text-base font-medium transition-colors ${
                    phase === "recording"
                      ? "bg-red-600 text-white"
                      : "bg-border text-text hover:bg-border/70"
                  }`}
                >
                  {phase === "recording"
                    ? "● Recording… release to save"
                    : "Hold to speak (name + MRP)"}
                </button>
              )}

              <button
                type="button"
                onClick={resetActive}
                className="w-full text-xs text-muted hover:text-text"
              >
                Skip this item
              </button>
            </div>
          )}

          {/* Low-confidence / manual confirm card */}
          {pending && (
            <div className="space-y-3 rounded-lg border border-amber-700/50 bg-surface p-4">
              <p className="font-mono text-xs text-muted">{pending.ean}</p>
              <div className="space-y-2">
                <input
                  value={pending.name}
                  onChange={(e) =>
                    setPending({ ...pending, name: e.target.value })
                  }
                  placeholder="Product name"
                  className="w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
                />
                <div className="flex gap-2">
                  <input
                    value={pending.brand ?? ""}
                    onChange={(e) =>
                      setPending({ ...pending, brand: e.target.value || null })
                    }
                    placeholder="Brand (optional)"
                    className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
                  />
                  <input
                    value={pending.mrp}
                    onChange={(e) =>
                      setPending({ ...pending, mrp: e.target.value })
                    }
                    inputMode="decimal"
                    placeholder="MRP"
                    className="w-28 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!pending.name.trim()}
                  onClick={async () => {
                    const mrpNum = pending.mrp.trim() ? Number(pending.mrp) : null;
                    await saveCaptured(
                      pending.ean,
                      pending.name.trim(),
                      pending.brand,
                      Number.isFinite(mrpNum as number) && (mrpNum as number) > 0
                        ? (mrpNum as number)
                        : null,
                      { transcript: pending.transcript }
                    );
                    setPending(null);
                  }}
                  className="flex-1 rounded-md bg-text px-3 py-2 text-sm font-medium text-bg disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActiveEan(pending.ean);
                    setPending(null);
                  }}
                  className="rounded-md border border-border px-3 py-2 text-sm text-text hover:bg-border"
                >
                  Re-record
                </button>
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="rounded-md border border-border px-3 py-2 text-sm text-muted hover:text-text"
                >
                  Skip
                </button>
              </div>
            </div>
          )}

          {/* Manual typing fallback (no mic / chosen) */}
          {manualEan && (
            <ProductForm
              mode="create"
              ean={manualEan}
              onSaved={() => {
                setManualEan(null);
                toast.success("Saved.");
              }}
              onCancel={() => setManualEan(null)}
              variant="mobile"
            />
          )}

          {recent.length > 0 && (
            <div className="rounded-lg border border-border bg-surface p-4">
              <p className="mb-2 text-xs uppercase tracking-wider text-muted">
                Just captured
              </p>
              <div className="grid grid-cols-[1fr_8rem_4rem] gap-3 border-b border-border pb-1 text-[10px] uppercase tracking-wider text-muted">
                <span>Item</span>
                <span>Brand</span>
                <span className="text-right">MRP</span>
              </div>
              <ul className="mt-1 space-y-1 text-sm">
                {recent.map((r, i) => (
                  <li
                    key={`${r.ean}-${i}`}
                    className="grid grid-cols-[1fr_8rem_4rem] items-center gap-3"
                  >
                    <span className="truncate">{r.name}</span>
                    <span className="truncate text-xs text-muted">
                      {r.brand ?? "—"}
                    </span>
                    <span className="text-right font-mono text-muted">
                      {r.mrp != null ? `₹${r.mrp}` : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
