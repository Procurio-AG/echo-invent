"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import type { Area } from "react-easy-crop";
import { CropModal } from "./CropModal";
import { cropAndCompress } from "./compress";
import { enqueueImage, pendingCountForEan, type QueuedImage } from "./queue";
import { usePendingProducts } from "./usePendingProducts";

const MAX_IMAGES = 3;
const PASTE_HINT = "Couldn't read that image — right-click it → Copy image, then paste here.";

type Props = {
  kick: () => void;
  uploaderItems: QueuedImage[];
  scanEan: string | null;
  onScanConsumed: () => void;
  onCropOpenChange: (open: boolean) => void;
  preselectEan: string | null;
};

// Pull an <img src> out of dropped text/html (drag from another tab).
function imgSrcFromHtml(html: string): string | null {
  const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m ? m[1] : null;
}

export function ImagesTab({
  kick,
  uploaderItems,
  scanEan,
  onScanConsumed,
  onCropOpenChange,
  preselectEan,
}: Props) {
  const { rows, refresh } = usePendingProducts({ images: "none" });

  const [selected, setSelected] = useState<{ ean: string; name: string } | null>(null);
  const [serverCount, setServerCount] = useState(0);
  const [queued, setQueued] = useState(0);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalForEan = serverCount + queued;
  const atCap = totalForEan >= MAX_IMAGES;

  const serverImageCount = useCallback(async (ean: string): Promise<number> => {
    try {
      const res = await fetch(`/api/product/${encodeURIComponent(ean)}/images`, {
        cache: "no-store",
      });
      if (!res.ok) return 0;
      const data = (await res.json()) as { images?: unknown[] };
      return (data.images ?? []).length;
    } catch {
      return 0;
    }
  }, []);

  const selectProduct = useCallback(
    async (ean: string, name: string) => {
      setSelected({ ean, name });
      const [sc, q] = await Promise.all([
        serverImageCount(ean),
        pendingCountForEan(ean),
      ]);
      setServerCount(sc);
      setQueued(q);
    },
    [serverImageCount]
  );

  // Select by EAN (scan quick-jump / ?ean= preselect): look up name even if the
  // product isn't in the 0-image list.
  const selectByEan = useCallback(
    async (ean: string) => {
      const clean = ean.trim();
      if (!clean) return;
      const row = rows.find((r) => r.ean === clean);
      if (row) {
        await selectProduct(clean, row.name);
        return;
      }
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
      const data = (await res.json()) as { product: { name: string } };
      await selectProduct(clean, data.product.name);
    },
    [rows, selectProduct]
  );

  // Consume a scan from the shell.
  useEffect(() => {
    if (!scanEan) return;
    selectByEan(scanEan).finally(onScanConsumed);
  }, [scanEan, selectByEan, onScanConsumed]);

  // Consume ?ean= preselect once.
  const preselectDone = useRef(false);
  useEffect(() => {
    if (preselectDone.current || !preselectEan) return;
    preselectDone.current = true;
    selectByEan(preselectEan);
  }, [preselectEan, selectByEan]);

  // As uploads drain: refresh the list (drop products that gained an image) and
  // recompute counts for the selected product.
  useEffect(() => {
    refresh();
    if (selected) {
      Promise.all([
        serverImageCount(selected.ean),
        pendingCountForEan(selected.ean),
      ]).then(([sc, q]) => {
        setServerCount(sc);
        setQueued(q);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploaderItems]);

  const openCropper = useCallback(
    (file: File) => {
      if (atCap) {
        toast.error("This item already has 3 images.");
        return;
      }
      setPendingFile(file);
      setImageSrc(URL.createObjectURL(file));
      onCropOpenChange(true);
    },
    [atCap, onCropOpenChange]
  );

  const closeCropper = useCallback(() => {
    if (imageSrc) URL.revokeObjectURL(imageSrc);
    setPendingFile(null);
    setImageSrc(null);
    onCropOpenChange(false);
  }, [imageSrc, onCropOpenChange]);

  // Paste (primary): read the first image blob off the clipboard while a product
  // is selected and no modal is open.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!selected || imageSrc) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of Array.from(items)) {
        if (it.type.startsWith("image/")) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            openCropper(file);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [selected, imageSrc, openCropper]);

  // Drag fallback: OS file first; else fetch the dropped image URL (often CORS-
  // blocked → guide the user to paste).
  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      if (!selected) return;
      const dt = e.dataTransfer;
      const droppedFile = Array.from(dt.files).find((f) =>
        f.type.startsWith("image/")
      );
      if (droppedFile) {
        openCropper(droppedFile);
        return;
      }
      const uri =
        dt.getData("text/uri-list") ||
        imgSrcFromHtml(dt.getData("text/html")) ||
        dt.getData("text/plain");
      if (!uri) {
        toast.error("Drop an image, or copy it and paste here.");
        return;
      }
      try {
        const res = await fetch(uri);
        if (!res.ok) throw new Error("fetch failed");
        const blob = await res.blob();
        if (!blob.type.startsWith("image/")) throw new Error("not an image");
        openCropper(new File([blob], "dropped.jpg", { type: blob.type }));
      } catch {
        toast.error(PASTE_HINT);
      }
    },
    [selected, openCropper]
  );

  const onFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) openCropper(file);
  };

  const confirmCrop = useCallback(
    async (area: Area) => {
      if (!selected || !pendingFile) return;
      setBusy(true);
      try {
        const blob = await cropAndCompress(pendingFile, area);
        const q = await pendingCountForEan(selected.ean);
        if (serverCount + q >= MAX_IMAGES) {
          toast.error("This item already has 3 images.");
          return;
        }
        await enqueueImage({
          ean: selected.ean,
          productName: selected.name,
          blob,
          mimeType: "image/jpeg",
        });
        setQueued(q + 1);
        toast.success("Queued — uploading in background.");
        closeCropper();
        kick();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not process image.");
      } finally {
        setBusy(false);
      }
    },
    [selected, pendingFile, serverCount, closeCropper, kick]
  );

  const advanceNext = useCallback(() => {
    const next = rows.find((r) => r.ean !== selected?.ean);
    if (next) selectProduct(next.ean, next.name);
    else setSelected(null);
  }, [rows, selected, selectProduct]);

  const searchUrl = selected
    ? `https://www.google.com/search?tbm=isch&tbs=isz:l&q=${encodeURIComponent(
        selected.name
      )}`
    : "#";

  return (
    <div className="mt-4">
      {selected ? (
        <div className="rounded-lg border border-border bg-surface p-5">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-xs text-muted">{selected.ean}</p>
              <p className="mt-1 truncate font-medium text-text">{selected.name}</p>
            </div>
            <span className="text-xs text-muted">{totalForEan}/3 images</span>
          </div>

          <a
            href={searchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-block rounded-md border border-border bg-text px-4 py-2 text-sm font-medium text-bg hover:opacity-90"
          >
            Search Google Images ↗
          </a>

          <div
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            className="mt-4 flex min-h-[120px] items-center justify-center rounded-md border-2 border-dashed border-border bg-bg p-4 text-center text-sm text-muted"
          >
            {atCap
              ? "This item has 3 images."
              : "Paste an image (Ctrl/⌘-V) or drag one here from the search tab."}
          </div>

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={atCap}
              className="flex-1 rounded-md border border-border bg-bg px-4 py-3 text-sm text-text hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
            >
              Choose file / camera
            </button>
            <button
              type="button"
              onClick={advanceNext}
              className="rounded-md border border-border bg-bg px-4 py-3 text-sm text-text hover:bg-border"
            >
              Next item →
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
      ) : (
        <p className="text-sm text-muted">
          Pick a product below, search Google Images, then paste the image here.
        </p>
      )}

      <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
        {rows.length === 0 && (
          <li className="p-4 text-sm text-muted">No products are missing images. 🎉</li>
        )}
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => selectProduct(r.ean, r.name)}
              className={`flex w-full items-baseline justify-between gap-3 p-3 text-left hover:bg-border ${
                selected?.ean === r.ean ? "bg-border" : ""
              }`}
            >
              <span className="min-w-0">
                <span className="font-mono text-xs text-muted">{r.ean}</span>
                <span className="ml-2 truncate text-sm text-text">{r.name}</span>
              </span>
              <span className="shrink-0 text-xs text-muted">{r.image_count}/3</span>
            </button>
          </li>
        ))}
      </ul>

      {imageSrc && (
        <CropModal
          imageSrc={imageSrc}
          busy={busy}
          onCancel={closeCropper}
          onConfirm={confirmCrop}
        />
      )}
    </div>
  );
}
