# Tabbed Completion Worklist (Images + Expiry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/image-capture` into a two-tab completion worklist — **Images** (products with 0 images, filled via a Google-Images → paste/drag → crop flow) and **Expiry** (products with no expiry date, inline-edited) — so backlogs are cleared by picking from a list instead of scanning each product.

**Architecture:** A client tab shell owns one `useImageUploader()` instance and two `usePendingProducts()` data hooks (one per filter), passing rows + refresh down to presentational tab components. The Images tab feeds chosen images (paste-primary, drag-fallback, or file picker) into the existing crop → `cropAndCompress` → IndexedDB queue → background uploader pipeline, unchanged. The Expiry tab saves through the existing version-locked `POST /api/product/update`. Two new filters on `buildProductWhere` (`hasImages`, `hasExpiry`) are surfaced through `GET /api/product/worklist` query params.

**Tech Stack:** Next.js 14 App Router, React 18 (client components), TypeScript, Tailwind, Prisma, `react-easy-crop`, `react-hot-toast`.

## Global Constraints

- **No test framework exists** (scripts: dev/build/start/lint only). Verification per task = `npm run lint` then `npm run build` (TypeScript typecheck) plus the manual checks stated in the task. Do **not** add a test runner.
- **All new UI files are client components** — first line `"use client";`.
- **Do not change** the upload pipeline: `app/image-capture/{queue,uploader,compress}.ts(x)`, `SyncPanel.tsx`, `app/api/product/[ean]/images/route.ts`.
- **Image cap is 3 per product**; re-check `serverCount + queued < 3` before every enqueue.
- **Image transfer is paste-primary, drag-fallback.** On a drag whose pixels can't be read (CORS/opaque/non-image), toast exactly: `Couldn't read that image — right-click it → Copy image, then paste here.`
- **Google search URL:** `https://www.google.com/search?tbm=isch&tbs=isz:l&q=${encodeURIComponent(name)}` opened via an anchor with `target="_blank" rel="noopener noreferrer"` (never `window.open`).
- **Commit style:** Conventional Commits, scope `images`/`worklist`. No `Co-Authored-By` lines.
- `cropAndCompress(file: File, area: CroppedArea): Promise<Blob>` where `CroppedArea = { x; y; width; height }` (structurally equal to react-easy-crop's `Area`); it always re-encodes to `image/jpeg`, so enqueue with `mimeType: "image/jpeg"`.

---

### Task 1: Data-layer filters (hasImages / hasExpiry) + worklist params

**Files:**
- Modify: `lib/product-filters.ts`
- Modify: `app/api/product/worklist/route.ts`

**Interfaces:**
- Consumes: existing `buildProductWhere(sessionId, opts)` and its `AND` composition.
- Produces: `buildProductWhere` accepts `hasImages?: boolean` and `hasExpiry?: boolean`; `GET /api/product/worklist?images=none` filters to `image_count === 0`, `?expiry=none` filters to `expiry_date === null`. Response shape (rows include `id, ean, name, category, version, image_count, expiry_date`, plus `total`) is unchanged.

- [ ] **Step 1: Add the two filters to `buildProductWhere`**

In `lib/product-filters.ts`, extend the `opts` parameter type and add two branches. The full updated function:

```ts
export function buildProductWhere(
  sessionId: string,
  opts: {
    ids?: string[];
    q?: string;
    category?: string;
    exported?: boolean;
    complete?: boolean;
    hasImages?: boolean;
    hasExpiry?: boolean;
  }
): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  const where: Prisma.ProductWhereInput = { session_id: sessionId, AND: and };

  if (opts.ids && opts.ids.length > 0) {
    where.id = { in: opts.ids };
    return where;
  }
  if (opts.category) where.category = opts.category;
  if (opts.exported === true) where.exported_at = { not: null };
  if (opts.exported === false) where.exported_at = null;
  if (opts.complete === true) and.push(COMPLETE_WHERE);
  if (opts.complete === false) and.push(INCOMPLETE_WHERE);
  if (opts.hasImages === true) and.push({ images: { some: {} } });
  if (opts.hasImages === false) and.push({ images: { none: {} } });
  if (opts.hasExpiry === true) and.push({ expiry_date: { not: null } });
  if (opts.hasExpiry === false) and.push({ expiry_date: null });
  if (opts.q) {
    and.push({
      OR: [
        { name: { contains: opts.q, mode: "insensitive" } },
        { ean: { contains: opts.q, mode: "insensitive" } },
      ],
    });
  }
  return where;
}
```

- [ ] **Step 2: Read the new params in the worklist route**

In `app/api/product/worklist/route.ts`, after the existing `complete` line, add the two param reads:

```ts
  const complete = url.searchParams.get("complete"); // "true" | "false" | null
  const images = url.searchParams.get("images"); // "none" | null
  const expiry = url.searchParams.get("expiry"); // "none" | null
```

Then extend the `buildProductWhere` call:

```ts
  const where = buildProductWhere(session.id, {
    q: q || undefined,
    category: category || undefined,
    exported: exported === "true" ? true : exported === "false" ? false : undefined,
    complete: complete === "true" ? true : complete === "false" ? false : undefined,
    hasImages: images === "none" ? false : undefined,
    hasExpiry: expiry === "none" ? false : undefined,
  });
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run lint && npm run build`
Expected: PASS (no type errors).

- [ ] **Step 4: Manual API check (dev server running, active session)**

Run: `curl -s 'http://localhost:3000/api/product/worklist?images=none' | head -c 400`
Expected: JSON `{ "rows": [...], "total": N, ... }` where every row has `image_count: 0`. Repeat with `?expiry=none` and confirm every row has `expiry_date: null`.

- [ ] **Step 5: Commit**

```bash
git add lib/product-filters.ts app/api/product/worklist/route.ts
git commit -m "feat(worklist): hasImages/hasExpiry filters + images/expiry query params"
```

---

### Task 2: `usePendingProducts` data hook

**Files:**
- Create: `app/image-capture/usePendingProducts.ts`

**Interfaces:**
- Consumes: `GET /api/product/worklist` (Task 1).
- Produces: `usePendingProducts(filter: { images?: "none"; expiry?: "none" }): { rows: PendingRow[]; total: number; loading: boolean; refresh: () => Promise<void> }` and the exported `PendingRow` type (`{ id; ean; name; category: string | null; version: number; image_count: number; expiry_date: string | null }`). Consumed by Tasks 4, 5, 6.

- [ ] **Step 1: Write the hook**

Create `app/image-capture/usePendingProducts.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";

export type PendingRow = {
  id: string;
  ean: string;
  name: string;
  category: string | null;
  version: number;
  image_count: number;
  expiry_date: string | null;
};

type Filter = { images?: "none"; expiry?: "none" };

// Fetches the active session's pending products for one filter (no images / no
// expiry). `take=200` so a moderate backlog isn't silently truncated; `total` is
// the true count for the tab badge.
export function usePendingProducts(filter: Filter) {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const qs = new URLSearchParams({ take: "200" });
  if (filter.images) qs.set("images", filter.images);
  if (filter.expiry) qs.set("expiry", filter.expiry);
  const query = qs.toString();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/product/worklist?${query}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setRows([]);
        setTotal(0);
        return;
      }
      const data = (await res.json()) as { rows?: PendingRow[]; total?: number };
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rows, total, loading, refresh };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run lint && npm run build`
Expected: PASS (file compiles though not yet imported anywhere).

- [ ] **Step 3: Commit**

```bash
git add app/image-capture/usePendingProducts.ts
git commit -m "feat(worklist): usePendingProducts data hook"
```

---

### Task 3: `CropModal` component (extracted)

**Files:**
- Create: `app/image-capture/CropModal.tsx`

**Interfaces:**
- Consumes: `react-easy-crop` `Cropper`/`Area`.
- Produces: `<CropModal imageSrc={string} busy={boolean} onCancel={() => void} onConfirm={(area: Area) => void} />`. Manages crop/zoom/croppedArea internally; calls `onConfirm` with the latest `croppedAreaPixels`. Consumed by Task 4.

- [ ] **Step 1: Write the component**

Create `app/image-capture/CropModal.tsx` (lifts the modal markup currently inline in `page.tsx`):

```tsx
"use client";

import { useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";

type Props = {
  imageSrc: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (croppedAreaPixels: Area) => void;
};

// Full-screen square cropper. Self-contained crop/zoom state; reports the final
// pixel area up via onConfirm so the parent can crop+compress+enqueue.
export function CropModal({ imageSrc, busy, onCancel, onConfirm }: Props) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);

  return (
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
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-border bg-bg px-4 py-2 text-sm text-text hover:bg-border disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => croppedArea && onConfirm(croppedArea)}
          disabled={busy || !croppedArea}
          className="rounded-md border border-border bg-text px-5 py-2 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Processing…" : "Use photo"}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/image-capture/CropModal.tsx
git commit -m "refactor(images): extract CropModal component"
```

---

### Task 4: `ImagesTab` — Google search + paste/drag/file → crop → queue

**Files:**
- Create: `app/image-capture/ImagesTab.tsx`

**Interfaces:**
- Consumes: `PendingRow` + `usePendingProducts` shape (Task 2, passed in as props), `CropModal` (Task 3), `cropAndCompress` (`compress.ts`), `enqueueImage`/`pendingCountForEan` (`queue.ts`), `QueuedImage` (`queue.ts`), `GET /api/product/[ean]/images` (server image count), `GET /api/product/[ean]` (select-by-EAN for scan/preselect).
- Produces: `<ImagesTab rows refresh kick uploaderItems scanEan onScanConsumed onCropOpenChange preselectEan />` (prop types in code below). Consumed by Task 6.

- [ ] **Step 1: Write the component**

Create `app/image-capture/ImagesTab.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import type { Area } from "react-easy-crop";
import { CropModal } from "./CropModal";
import { cropAndCompress } from "./compress";
import { enqueueImage, pendingCountForEan, type QueuedImage } from "./queue";
import { usePendingProducts, type PendingRow } from "./usePendingProducts";

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
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/image-capture/ImagesTab.tsx
git commit -m "feat(images): ImagesTab with Google search + paste/drag/file capture"
```

---

### Task 5: `ExpiryTab` — inline date edit

**Files:**
- Create: `app/image-capture/ExpiryTab.tsx`

**Interfaces:**
- Consumes: `PendingRow` + `usePendingProducts` (Task 2), `POST /api/product/update`, `GET /api/product/[ean]` (version refetch on conflict).
- Produces: `<ExpiryTab />` (no props; owns its own `usePendingProducts({ expiry: "none" })`). Consumed by Task 6.

- [ ] **Step 1: Write the component**

Create `app/image-capture/ExpiryTab.tsx`:

```tsx
"use client";

import { useState } from "react";
import { toast } from "react-hot-toast";
import { usePendingProducts, type PendingRow } from "./usePendingProducts";

// Save one product's expiry date via the version-locked update endpoint. On a
// version conflict, refetch the current version once and retry.
async function saveExpiry(ean: string, version: number, date: string): Promise<boolean> {
  const post = (v: number) =>
    fetch("/api/product/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ean, version: v, expiry_date: date }),
    });

  let res = await post(version);
  if (res.status === 409) {
    const fresh = await fetch(`/api/product/${encodeURIComponent(ean)}`, {
      cache: "no-store",
    });
    if (!fresh.ok) return false;
    const data = (await fresh.json()) as { product: { version: number } };
    res = await post(data.product.version);
  }
  return res.ok;
}

export function ExpiryTab() {
  const { rows, refresh } = usePendingProducts({ expiry: "none" });
  const [values, setValues] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const onSave = async (row: PendingRow) => {
    const date = values[row.id];
    if (!date) {
      toast.error("Pick a date first.");
      return;
    }
    setSavingId(row.id);
    try {
      const ok = await saveExpiry(row.ean, row.version, date);
      if (ok) {
        toast.success("Expiry saved.");
        await refresh();
      } else {
        toast.error("Save failed — try again.");
      }
    } finally {
      setSavingId(null);
    }
  };

  return (
    <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
      {rows.length === 0 && (
        <li className="p-4 text-sm text-muted">No products are missing an expiry date. 🎉</li>
      )}
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-3 p-3">
          <span className="min-w-0 flex-1">
            <span className="font-mono text-xs text-muted">{r.ean}</span>
            <span className="ml-2 truncate text-sm text-text">{r.name}</span>
          </span>
          <input
            type="date"
            value={values[r.id] ?? ""}
            onChange={(e) =>
              setValues((v) => ({ ...v, [r.id]: e.target.value }))
            }
            className="rounded-md border border-border bg-bg px-2 py-1 text-sm text-text"
          />
          <button
            type="button"
            onClick={() => onSave(r)}
            disabled={savingId === r.id}
            className="rounded-md border border-border bg-text px-4 py-1.5 text-sm font-medium text-bg hover:opacity-90 disabled:opacity-50"
          >
            {savingId === r.id ? "Saving…" : "Save"}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/image-capture/ExpiryTab.tsx
git commit -m "feat(worklist): ExpiryTab inline date editing"
```

---

### Task 6: Page shell — tabs, uploader, scan quick-jump, SyncPanel

**Files:**
- Modify: `app/image-capture/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `ImagesTab` (Task 4), `ExpiryTab` (Task 5), `usePendingProducts` (Task 2, for badges), `useImageUploader` (`uploader.ts`), `SyncPanel` (`SyncPanel.tsx`), `HiddenScanInput` (`app/components/HiddenScanInput`), `GET /api/session/active`.
- Produces: the live `/image-capture` page. Terminal deliverable.

- [ ] **Step 1: Rewrite the page**

Replace the entire contents of `app/image-capture/page.tsx` with:

```tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HiddenScanInput, type HiddenScanInputHandle } from "@/app/components/HiddenScanInput";
import { useRef } from "react";
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
```

- [ ] **Step 2: Typecheck + lint**

Run: `npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual end-to-end (dev server, active session with backlog)**

1. Visit `/image-capture` → two tabs **Images (N)** and **Expiry (M)** with non-zero counts.
2. **Images:** click a product → "Search Google Images ↗" opens a Large-filtered search in a new tab → right-click an image → Copy image → focus the app → Ctrl/⌘-V → crop modal opens → "Use photo" → toast "Queued" → SyncPanel shows it draining → after upload the product drops from the list and `x/3` increments. "Next item →" advances.
3. **Drag fallback:** drag a thumbnail from the search tab onto the dashed zone → either it opens the cropper (CORS-permissive) or toasts `Couldn't read that image — right-click it → Copy image, then paste here.` Neither path throws.
4. **Choose file / camera** still opens the cropper.
5. **Expiry:** switch tab → pick a product → set a date → Save → toast "Expiry saved" → row drops. Open `/worklist`, filter expiry, confirm it persisted.
6. **Scan quick-jump:** scan an EAN → switches to Images tab and selects that product. **`?ean=`:** open `/image-capture?ean=<known>` → Images tab preselects it.

- [ ] **Step 4: Commit**

```bash
git add app/image-capture/page.tsx
git commit -m "feat(images): tabbed completion worklist shell (images + expiry)"
```

---

## Self-Review

**Spec coverage:**
- Two tabs Images + Expiry with badges → Task 6 (shell), counts via Task 2 hook. ✓
- 0-image filter + no-expiry filter → Task 1. ✓
- Google Images Large-filter search button → Task 4 (`tbs=isz:l`, anchor). ✓
- Paste-primary, drag-fallback with the exact toast → Task 4. ✓
- File picker retained → Task 4. ✓
- Existing crop→compress→queue→upload pipeline reused unchanged → Tasks 3/4 (CropModal + ImagesTab call `cropAndCompress`/`enqueueImage`; queue/uploader/compress/images-API untouched). ✓
- Inline expiry edit via version-locked update with conflict refetch → Task 5. ✓
- Scan quick-jump + `?ean=` preselect → Tasks 4 + 6. ✓
- List self-corrects on drain → Task 4 (`uploaderItems` effect). ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. ✓

**Type consistency:** `PendingRow` defined in Task 2 used identically in Tasks 4–6; `usePendingProducts(filter)` signature consistent; `CropModal` props (`imageSrc/busy/onCancel/onConfirm`) match Task 4's usage; `confirmCrop(area: Area)` matches `onConfirm`; `cropAndCompress(file, area)` matches `compress.ts`; `enqueueImage` payload matches `queue.ts`; `ImagesTab` props in Task 4 match the call site in Task 6. ✓

**Note:** No automated tests by design (no runner in the project); each task verifies via `npm run lint && npm run build` plus manual checks. The data-layer change (Task 1) and the two tabs (Tasks 4–5) have explicit manual verification steps.
```
