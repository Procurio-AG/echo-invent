"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { HiddenScanInput, type HiddenScanInputHandle } from "@/app/components/HiddenScanInput";
import { useImageUploader } from "./uploader";
import { usePendingProducts } from "./usePendingProducts";
import { ImagesTab } from "./ImagesTab";
import { ExpiryTab } from "./ExpiryTab";
import { SyncPanel } from "./SyncPanel";

type PageState = { kind: "loading" } | { kind: "no-active" } | { kind: "ready" };
type Tab = "images" | "expiry";

export default function ImageCapturePage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("images");
  const [cropOpen, setCropOpen] = useState(false);
  const [scanEan, setScanEan] = useState<string | null>(null);
  const [preselectEan, setPreselectEan] = useState<string | null>(null);
  const scanRef = useRef<HiddenScanInputHandle>(null);

  const { items, kick, retry, retryAllFailed, remove } = useImageUploader();
  const imagesCount = usePendingProducts({ images: "none" }).total;
  const expiryCount = usePendingProducts({ expiry: "none" }).total;

  useEffect(() => {
    fetch("/api/session/active", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setState(j.session ? { kind: "ready" } : { kind: "no-active" }))
      .catch(() => setState({ kind: "no-active" }));
  }, []);

  useEffect(() => {
    if (state.kind !== "ready") return;
    const param = new URLSearchParams(window.location.search).get("ean");
    if (param) {
      setTab("images");
      setPreselectEan(param);
    }
  }, [state.kind]);

  if (state.kind === "loading") {
    return <p className="p-6 text-sm text-muted">Loading…</p>;
  }
  if (state.kind === "no-active") {
    return (
      <div className="p-6">
        <p className="text-sm text-muted">
          No active audit. Start one from the{" "}
          <Link href="/" className="underline">
            dashboard
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Complete products</h1>
        <Link href="/worklist" className="text-xs text-muted underline">
          Worklist →
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted">
        Work the backlog: add images from Google, or fill in expiry dates. Scan an
        item to jump to it.
      </p>

      <div className="mt-4">
        <HiddenScanInput
          ref={scanRef}
          released={cropOpen}
          onScan={(ean) => {
            setTab("images");
            setScanEan(ean);
          }}
        />
      </div>

      <div className="mt-4 flex gap-2 border-b border-border">
        <button
          type="button"
          onClick={() => setTab("images")}
          className={`-mb-px border-b-2 px-4 py-2 text-sm ${
            tab === "images"
              ? "border-text font-medium text-text"
              : "border-transparent text-muted hover:text-text"
          }`}
        >
          Images ({imagesCount})
        </button>
        <button
          type="button"
          onClick={() => setTab("expiry")}
          className={`-mb-px border-b-2 px-4 py-2 text-sm ${
            tab === "expiry"
              ? "border-text font-medium text-text"
              : "border-transparent text-muted hover:text-text"
          }`}
        >
          Expiry ({expiryCount})
        </button>
      </div>

      {tab === "images" ? (
        <ImagesTab
          kick={kick}
          uploaderItems={items}
          scanEan={scanEan}
          onScanConsumed={() => setScanEan(null)}
          onCropOpenChange={setCropOpen}
          preselectEan={preselectEan}
        />
      ) : (
        <ExpiryTab />
      )}

      <div className="mt-6">
        <SyncPanel
          items={items}
          onRetry={retry}
          onRemove={remove}
          onRetryAllFailed={retryAllFailed}
        />
      </div>
    </div>
  );
}
