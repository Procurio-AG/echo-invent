# Tabbed Completion Worklist on `/image-capture`

## Context

`sb_invent` is an in-store inventory/price-audit tool (Next.js 14 App Router, React 18, Tailwind, Prisma + Supabase Postgres). It runs on the owner's local machine; auditors connect over a Tailscale funnel, so image uploads are async/offline-tolerant (IndexedDB queue + background uploader). Product images live in a **private** Supabase Storage bucket (`sb-invent-images`, 2MB, `image/*`); thumbnails display via signed URLs and export streams bytes server-side.

Today `/image-capture` is **scan-first**: the auditor scans an EAN with the hardware keyboard-wedge scanner, takes/chooses a photo, crops it, and it queues for background upload. Each product can hold up to 3 images. Separately, `/worklist` lists every product with completeness/export status.

The owner wants to **clear backlogs of missing data without scanning each product**, and to **source product images from Google Images** instead of photographing them. Two gaps are most pressing across the catalog: products with **no images** and products with **no expiry date**.

## Goals

1. Turn `/image-capture` into a **two-tab completion worklist**:
   - **Images** — products with 0 images.
   - **Expiry** — products with no `expiry_date`.
   Each tab is badged with its pending count and lists pending products, so the auditor works the backlog by picking from a list rather than scanning each item.
2. **Source images from Google Images.** Picking a product offers a one-click Google Images search (query = product name, "Large" size filter). The auditor brings an image back into the app by **pasting** it (primary, CORS-safe) or **dragging** it (best-effort fallback), then crops and submits through the existing async pipeline.
3. **Inline-edit expiry** on the Expiry tab and save through the existing version-locked update endpoint.

Non-goals: batch and the mandatory fields (category/PP/SP/MRP/name) get no tabs — they are edited via `ProductForm`/`/worklist` as today. The capture/crop/queue/upload pipeline and the images API are unchanged.

## Key decisions

- **Two tabs only — Images and Expiry.** Batch defaults to `"open"` (never meaningfully "pending"); the mandatory fields already have an editing surface. Keeping the page to images + expiry matches the actual backlog.
- **Paste-primary, drag-fallback** for cross-tab image transfer. Dragging an image from a Google Images tab hands over the image **URL**, not pixels; re-fetching it is blocked by CORS on most hosts (including Google thumbnails), which taints the canvas and breaks crop/compress. **Pasting** (right-click image → *Copy image* → Ctrl/Cmd-V) puts a **decoded bitmap** on the clipboard that the app owns outright — no CORS. So paste is the reliable path; drag is accepted best-effort and falls back to a "paste instead" message when the fetch is opaque/tainted.
- **Anchor, not `window.open`,** for the Google search — avoids popup-blocker flakiness; the auditor controls when the tab opens.
- **Reuse the existing pipeline end-to-end.** Capture → `cropAndCompress` → `enqueueImage` (IndexedDB) → `useImageUploader` → `POST /api/product/[ean]/images`. No changes to `queue.ts`, `uploader.ts`, `compress.ts`, `SyncPanel.tsx`, or the images API.
- **Reuse the worklist API and update endpoint.** Add two filters to `buildProductWhere` and pass them through `/api/product/worklist`; save expiry via the existing version-locked `POST /api/product/update`.

## Data layer

### `lib/product-filters.ts`

Extend `buildProductWhere(sessionId, opts)` with two optional flags (compose via the existing `AND` array so they never clobber search/complete ORs):

- `hasImages?: boolean` — `false` → `{ images: { none: {} } }`; `true` → `{ images: { some: {} } }`.
- `hasExpiry?: boolean` — `false` → `{ expiry_date: null }`; `true` → `{ expiry_date: { not: null } }`.

`COMPLETE_WHERE`, `INCOMPLETE_WHERE`, and `isComplete()` are unchanged.

### `app/api/product/worklist/route.ts`

Read two new query params and pass them through:

- `images=none` → `hasImages: false` (any other value → unset).
- `expiry=none` → `hasExpiry: false` (any other value → unset).

The route already returns rows with `id`, `ean`, `name`, `version`, `image_count`, `expiry_date`, plus `total` (used for the tab badge). No response shape change.

## UI

### Page shell — `app/image-capture/page.tsx`

Rewritten into a client tab shell:

- Active-session guard (unchanged behaviour: `loading` / `no-active` / `ready`).
- Two tabs: **Images** and **Expiry**, each showing a pending count badge (from the tab's worklist `total`).
- A single mounted `useImageUploader()` instance owns the queue; `SyncPanel` renders below the tabs (visible on both, since uploads are global).
- HiddenScanInput remains as an optional quick-jump: a scan selects that product within the active tab (looked up via the existing `GET /api/product/[ean]`), released while a modal is open.
- `?ean=` query param preselects a product in the Images tab (preserves the ProductForm "add images" link).

### `usePendingProducts.ts`

A hook wrapping the worklist API for one filter: `usePendingProducts({ images?: "none"; expiry?: "none" })` → `{ rows, total, loading, refresh }`. Used by both tabs and for the tab badge counts.

### `ImagesTab.tsx`

- Left/top: the list of 0-image products (EAN · Name · `n/3`). Empty state when the backlog is clear.
- Selecting a product opens a work panel:
  1. **"Search Google Images"** anchor → `https://www.google.com/search?tbm=isch&tbs=isz:l&q=<encodeURIComponent(name)>`, `target="_blank"`, `rel="noopener noreferrer"`.
  2. **Paste/drop zone** (the focus):
     - `onPaste`: scan `clipboardData.files` / `clipboardData.items` for the first `image/*` blob → open crop modal. The zone is focusable so Ctrl/Cmd-V lands here; a document-level paste listener also works while the panel is open.
     - `onDrop`: try `dataTransfer.files` first; else read `text/uri-list` (fallback `text/html`) for an image URL and `fetch(url)` → `blob()`. If the fetch is opaque/throws or the blob isn't an image, toast: *"Couldn't read that image — right-click it → Copy image, then paste here."* `onDragOver` prevents default to enable drop.
     - The existing file picker (desktop file / mobile `capture="environment"`) stays as a third source.
  3. Chosen `File`/`Blob` → **crop modal** → `cropAndCompress(file, croppedAreaPixels)` → re-check the 3-image cap (server count + queued) → `enqueueImage` → `kick()`.
  4. Panel shows live `x/3` (server count + queued). A **"Next item →"** button advances to the next 0-image product; the current product stays selected after a submit so a 2nd/3rd image can be added before advancing.
- The list refreshes when the uploader queue drains (effect on `items`), dropping products once they reach ≥1 server image.

### `ExpiryTab.tsx`

- List of no-expiry products (EAN · Name · `<input type="date">` · Save). Empty state when clear.
- Save → `POST /api/product/update` `{ ean, version, expiry_date }`. On success, drop the row. On 409 `VERSION_CONFLICT`, refetch that product (`GET /api/product/[ean]`) for the current `version` and retry once; surface a toast if it still fails.

### `CropModal.tsx`

Extract the existing crop-modal markup/logic from `page.tsx` (the `react-easy-crop` `Cropper`, zoom slider, Cancel/Use buttons, `cropAndCompress` call) into a reusable component: props `imageSrc`, `busy`, `onCancel`, `onConfirm(croppedAreaPixels)`. Used by `ImagesTab`.

## Files

- **Modify:** `lib/product-filters.ts`, `app/api/product/worklist/route.ts`, `app/image-capture/page.tsx`.
- **Create:** `app/image-capture/ImagesTab.tsx`, `app/image-capture/ExpiryTab.tsx`, `app/image-capture/CropModal.tsx`, `app/image-capture/usePendingProducts.ts`.
- **Unchanged:** `app/image-capture/{queue,uploader,compress}.ts(x)`, `SyncPanel.tsx`, `app/api/product/[ean]/images/route.ts`, `app/api/product/update/route.ts`.

## Risks / notes

- **Cross-origin drag** will often fail to read pixels (opaque/tainted) — by design, handled by the paste-fallback message. Paste is the reliable path the user chose.
- **Async upload lag:** the Images list reflects server image count, which updates only when an upload completes, so the list trails reality by a beat; the drain-refresh self-corrects it.
- **Version conflicts** on expiry edits are handled with a single refetch-and-retry; concurrent edits to the same product are rare in this single-operator workflow.
- **Clipboard image type:** pasted images are typically `image/png`; `cropAndCompress` re-encodes to JPEG, so the uploaded type stays `image/jpeg` and within the bucket's `image/*` + 2MB limits.

## Verification (at execution time)

1. `npm run lint` + `npm run build`.
2. Start a session. `/image-capture` shows Images + Expiry tabs with counts.
3. **Images tab:** pick a 0-image product → "Search Google Images" opens a Large-filtered search in a new tab → copy an image → paste into the zone → crop → submit → queued → uploader drains → product drops from the list; `x/3` reflects it. Drag a CORS-blocked thumbnail → graceful "paste instead" toast. File picker still works.
4. **Expiry tab:** pick a no-expiry product → set a date → Save → row drops; reopen `/worklist` filtered by expiry to confirm it persisted.
5. Scan quick-jump selects a product in the active tab. `?ean=` from ProductForm preselects in the Images tab.
