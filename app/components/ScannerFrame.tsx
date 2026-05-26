"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  /** Pause the camera (e.g., while a product is open in the form). */
  paused: boolean;
  onScan: (ean: string) => void;
  onError?: (message: string) => void;
};

type ScannerStatus = "idle" | "starting" | "running" | "error";

const SCANNER_DIV_ID = "scanner-frame-target";

export function ScannerFrame({ paused, onScan, onError }: Props) {
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void } | null>(null);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const onScanRef = useRef(onScan);
  const onErrorRef = useRef(onError);
  const [status, setStatus] = useState<ScannerStatus>("idle");

  useEffect(() => {
    onScanRef.current = onScan;
    onErrorRef.current = onError;
  }, [onScan, onError]);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    let scanner: { stop: () => Promise<void>; clear: () => void } | null = null;

    (async () => {
      try {
        setStatus("starting");
        const mod = await import("html5-qrcode");
        if (cancelled) return;
        const { Html5Qrcode } = mod;
        const instance = new Html5Qrcode(SCANNER_DIV_ID, { verbose: false });
        scanner = instance as unknown as typeof scanner;
        scannerRef.current = scanner;

        await instance.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 140 }, aspectRatio: 1.333 },
          (decoded: string) => {
            const now = Date.now();
            if (
              lastScanRef.current.code === decoded &&
              now - lastScanRef.current.at < 2000
            ) {
              return;
            }
            lastScanRef.current = { code: decoded, at: now };
            onScanRef.current(decoded);
          },
          () => {}
        );

        if (cancelled) {
          try { await instance.stop(); } catch {}
          try { instance.clear(); } catch {}
          return;
        }
        setStatus("running");
      } catch (err) {
        setStatus("error");
        const msg =
          err instanceof Error ? err.message : "Could not start camera.";
        onErrorRef.current?.(msg);
      }
    })();

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      scannerRef.current = null;
      if (!s) return;
      (async () => {
        try { await s.stop(); } catch {}
        try { s.clear(); } catch {}
      })();
    };
  }, [paused]);

  return (
    <div className="relative">
      <div
        id={SCANNER_DIV_ID}
        className="aspect-[4/3] w-full overflow-hidden rounded-lg border border-border bg-black"
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-32 w-56 rounded-md border-2 border-text/80" />
      </div>
      <div className="absolute left-2 top-2 rounded-md bg-black/60 px-2 py-1 text-[10px] uppercase tracking-wider text-text">
        {status === "running"
          ? "● scanning"
          : status === "starting"
          ? "starting…"
          : status === "error"
          ? "camera error"
          : "paused"}
      </div>
    </div>
  );
}
