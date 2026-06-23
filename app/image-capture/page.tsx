"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Cropper, { type Area } from "react-easy-crop";
import { toast } from "react-hot-toast";
import "react-easy-crop/react-easy-crop.css";
import { HiddenScanInput, type HiddenScanInputHandle } from "@/app/components/HiddenScanInput";
import { cropAndCompress } from "./compress";
import { enqueueImage, pendingCountForEan } from "./queue";
import { useImageUploader } from "./uploader";
import { SyncPanel } from "./SyncPanel";

const MAX_IMAGES = 3;

type Selected = { ean: string; name: string; serverCount: number };

type PageState =
  | { kind: "loading" }
  | { kind: "no-active" }
  | { kind: "ready" };

export default function ImageCapturePage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [selected, setSelected] = useState<Selected | null>(null);
  const [queuedForEan, setQueuedForEan] = useState(0);

  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);

  const scanRef = useRef<HiddenScanInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { items, kick, retry, retryAllFailed, remove } = useImageUploader();

  // Active-session guard.
  useEffect(() => {
    fetch("/api/session/active", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => setState(j.session ? { kind: "ready" } : { kind: "no-active" }))
      .catch(() => setState({ kind: "no-active" }));
  }, []);

  const serverImageCount = useCallback(async (ean: string): Promise<number> => {
    try {
      const res = await fetch(`/api/product/${encodeURIComponent(ean)}/images`, {
        cache: "no-store",
      });
      if (!res.ok) return 0;
      const data = await res.json();
      return (data.images ?? []).length as number;
    } catch {
      return 0;
    }
  }, []);

  const selectEan = useCallback(
    async (ean: string) => {
      const clean = ean.trim();
      if (!clean) return;
      const res = await fetch(`/api/product/${encodeURIComponent(clean)}`, {
        cache: "no-store",
      });
      if (res.status === 404) {
        toast.error(`No item with EAN ${clean} in this audit.`);
        return;
      }
      if (!res.ok) {
        toast.error("Lookup failed.");
        return;
      }
      const data = await res.json();
      const [serverCount, queued] = await Promise.all([
        serverImageCount(clean),
        pendingCountForEan(clean),
      ]);
      setSelected({ ean: clean, name: data.product.name, serverCount });
      setQueuedForEan(queued);
    },
    [serverImageCount]
  );

  // Preselect from ?ean= (e.g. arriving from the worklist / product form).
  useEffect(() => {
    if (state.kind !== "ready") return;
    const param = new URLSearchParams(window.location.search).get("ean");
    if (param) selectEan(param);
  }, [state.kind, selectEan]);

  const totalForEan = selected ? selected.serverCount + queuedForEan : 0;
  const atCap = totalForEan >= MAX_IMAGES;

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    if (atCap) {
      toast.error("This item already has 3 images.");
      return;
    }
    setPendingFile(file);
    setImageSrc(URL.createObjectURL(file));
  };

  const closeCropper = () => {
    if (imageSrc) URL.revokeObjectURL(imageSrc);
    setPendingFile(null);
    setImageSrc(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedArea(null);
  };

  const confirmCrop = async () => {
    if (!selected || !pendingFile || !croppedArea) return;
    setBusy(true);
    try {
      const blob = await cropAndCompress(pendingFile, croppedArea);
      // Re-check the cap against the freshest counts before enqueueing.
      const queued = await pendingCountForEan(selected.ean);
      if (selected.serverCount + queued >= MAX_IMAGES) {
        toast.error("This item already has 3 images.");
        return;
      }
      await enqueueImage({
        ean: selected.ean,
        productName: selected.name,
        blob,
        mimeType: "image/jpeg",
      });
      setQueuedForEan(queued + 1);
      toast.success("Queued — uploading in background.");
      closeCropper();
      kick(); // start draining now
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not process image.");
    } finally {
      setBusy(false);
    }
  };

  // Keep the per-EAN counter fresh as the queue drains.
  useEffect(() => {
    if (!selected) return;
    pendingCountForEan(selected.ean).then(setQueuedForEan);
  }, [items, selected]);

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

  // Release the scanner while a crop modal is open so it doesn't steal focus.
  const scannerReleased = pendingFile !== null || selected !== null;

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Capture images</h1>
        <Link href="/worklist" className="text-xs text-muted underline">
          Worklist →
        </Link>
      </div>
      <p className="mt-1 text-xs text-muted">
        Scan an item, take or choose a photo, crop, and it uploads in the background.
      </p>

      <div className="mt-4">
        <HiddenScanInput
          ref={scanRef}
          released={scannerReleased}
          onScan={selectEan}
        />
      </div>

      {selected && (
        <div className="mt-4 rounded-lg border border-border bg-surface p-5">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-xs text-muted">{selected.ean}</p>
              <p className="mt-1 truncate font-medium text-text">{selected.name}</p>
            </div>
            <span className="text-xs text-muted">{totalForEan}/3 images</span>
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={atCap}
              className="flex-1 rounded-md border border-border bg-text px-4 py-3 text-sm font-medium text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {atCap ? "3 images captured" : "Take / choose photo"}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelected(null);
                setQueuedForEan(0);
                scanRef.current?.focus();
              }}
              className="rounded-md border border-border bg-bg px-4 py-3 text-sm text-text hover:bg-border"
            >
              Scan next
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onFilePicked}
            className="hidden"
          />
        </div>
      )}

      <div className="mt-6">
        <SyncPanel
          items={items}
          onRetry={retry}
          onRemove={remove}
          onRetryAllFailed={retryAllFailed}
        />
      </div>

      {/* Crop modal */}
      {imageSrc && (
        <div className="fixed inset-0 z-50 flex flex-col bg-bg/95">
          <div className="relative flex-1">
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={1}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={(_area, areaPixels) => setCroppedArea(areaPixels)}
            />
          </div>
          <div className="flex items-center gap-3 border-t border-border bg-surface p-4">
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="flex-1"
              aria-label="Zoom"
            />
            <button
              type="button"
              onClick={closeCropper}
              disabled={busy}
              className="rounded-md border border-border bg-bg px-4 py-2 text-sm text-text hover:bg-border disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmCrop}
              disabled={busy || !croppedArea}
              className="rounded-md border border-border bg-text px-5 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Processing…" : "Use photo"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
