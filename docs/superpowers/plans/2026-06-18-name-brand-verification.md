# Name + Brand Verification on Categorize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the auditor fix item **name** and **brand** inline on the categorize worklist (saved together with category), add a free local type-ahead of known names, and export brand as its own column.

**Architecture:** Extend the existing `price-batch` route to also write `name` and `brand` (brand is a read-modify-write of `original_data` JSON). The categorize page gains editable name/brand inputs backed by a per-id override object instead of a bare category string. A new `GET /api/product/names` feeds a `<datalist>`. The export route + `xlsx-import` header map gain a Brand column. No schema change — brand stays at `original_data.brand`.

**Tech Stack:** Next.js 14 App Router, TypeScript, Prisma 5 + PostgreSQL, xlsx (SheetJS), react-hot-toast.

## Global Constraints

- No automated test framework; verification cycle per task = `npm run build` clean (runs typecheck + ESLint) + the task's manual/curl check. (`npm run lint` is interactive-unconfigured in this repo; rely on `next build`.)
- Mirror existing route conventions exactly: `undefined` = leave unchanged, `null`/`""` = clear, optimistic concurrency via `version`, chunked transactions, `applied`/`conflicts`/`notFound`/`invalid` reporting.
- Brand is stored at `original_data.brand`, is optional, and is **not** backfilled. Editing brand must preserve all other `original_data` keys.
- Name must never be saved empty (reject to `invalid`).
- The audit entry continues to record prices only — no name/brand history.

---

### Task 1: Add a `brand` header to the xlsx header map

**Files:**
- Modify: `lib/xlsx-import.ts` (`HeaderMap` type ~lines 18-25, `HEADER_CANDIDATES` ~27-34, `resolveHeaders` return ~42-49)

**Interfaces:**
- Produces: `HeaderMap` now has an optional `brand?: string`; `resolveHeaders(sample)` resolves a brand-like source column when present.

- [ ] **Step 1: Add `brand` to the type, candidates, and resolver**

In `lib/xlsx-import.ts`, add `brand?: string;` to `HeaderMap`:

```typescript
export type HeaderMap = {
  ean?: string;
  name?: string;
  category?: string;
  purchase_price?: string;
  selling_price?: string;
  mrp?: string;
  brand?: string;
};
```

Add a `brand` entry to `HEADER_CANDIDATES`:

```typescript
const HEADER_CANDIDATES = {
  ean: ["ean", "barcode", "bar code"],
  name: ["item name", "product name", "name", "description"],
  category: ["category name", "category"],
  purchase_price: ["purchase price", "cost price", "cost", "pp"],
  selling_price: ["selling price", "sell price", "sp"],
  mrp: ["mrp", "max retail price", "maximum retail price"],
  brand: ["brand", "manufacturer", "company"],
} as const;
```

Add `brand` to the `resolveHeaders` return object:

```typescript
  return {
    ean: find(HEADER_CANDIDATES.ean),
    name: find(HEADER_CANDIDATES.name),
    category: find(HEADER_CANDIDATES.category),
    purchase_price: find(HEADER_CANDIDATES.purchase_price),
    selling_price: find(HEADER_CANDIDATES.selling_price),
    mrp: find(HEADER_CANDIDATES.mrp),
    brand: find(HEADER_CANDIDATES.brand),
  };
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add lib/xlsx-import.ts
git commit -m "feat(export): recognize a brand column in the header map"
```

---

### Task 2: Export a Brand column

**Files:**
- Modify: `app/api/export/route.ts` (`DEFAULT_COLUMNS` ~44-51, header/seed block ~53-56, row mapping ~58-71)

**Interfaces:**
- Consumes: `resolveHeaders` (now returns `brand`) from Task 1.
- Produces: the exported sheet has a Brand column; each row writes `original_data.brand ?? ""`.

- [ ] **Step 1: Ensure a Brand column exists, then write it per row**

In `app/api/export/route.ts`, after `const headers = resolveHeaders(firstOriginal);` (line ~56), determine the brand column name — reuse a resolved source header if present, else `"Brand"` — and guarantee it is part of the column shape so `json_to_sheet`'s `header` includes it:

```typescript
  const headers = resolveHeaders(firstOriginal);

  // Brand is exported as its own column. Reuse a source brand header if the
  // workbook had one; otherwise append a "Brand" column to the shape.
  const brandColumn = headers.brand ?? "Brand";
  if (!(brandColumn in firstOriginal)) {
    (firstOriginal as Record<string, unknown>)[brandColumn] = null;
  }
```

Then in the `rows = products.map(...)` block, after the existing `if (headers.mrp) ...` line, write the brand value:

```typescript
    if (headers.mrp) original[headers.mrp] = p.mrp;
    const brand = (p.original_data as Record<string, unknown>)?.brand;
    original[brandColumn] = typeof brand === "string" ? brand : "";
    return original;
```

Note: `firstOriginal` is the object passed as `json_to_sheet`'s `header: Object.keys(firstOriginal)`, so adding `brandColumn` to it is what makes the column appear (including for the manually-seeded `DEFAULT_COLUMNS` path, since those rows are seeded from `firstOriginal`'s keys).

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 3: Manual check (curl the export)**

With an active session that has at least one `status:"updated"` row carrying `original_data.brand`, request the export and open the xlsx: confirm a Brand column exists, a branded row shows its brand, an unbranded row shows a blank cell, and the existing Item Name / Category / EAN / price columns are unchanged.

```bash
curl -s "http://localhost:3000/api/export" -o /tmp/audit.xlsx && echo "saved"
```

- [ ] **Step 4: Commit**

```bash
git add app/api/export/route.ts
git commit -m "feat(export): add a Brand column to the exported sheet"
```

---

### Task 3: `price-batch` accepts and writes name + brand

**Files:**
- Modify: `app/api/product/price-batch/route.ts` (`Item` type ~8-16, the `Resolved` type ~85-92, the per-item normalize loop ~95-156, the skip guard ~146-153, the transaction's `findUnique` select ~170-173 and `update` data ~185-195)

**Interfaces:**
- Consumes: each batch item may now carry `name?: string` and `brand?: string | null`.
- Produces: a provided non-empty `name` updates `Product.name`; `brand` updates `original_data.brand` (read-modify-write, other keys preserved); `brand: null`/`""` clears it. Version bump, audit entry (prices only), conflict/notFound/invalid reporting unchanged.

- [ ] **Step 1: Extend the `Item` type**

```typescript
type Item = {
  id?: string;
  ean?: string;
  version?: number;
  purchase_price?: number | null;
  selling_price?: number | null;
  mrp?: number | null;
  category?: string | null;
  name?: string; // NEW: provided => trim; reject "" to invalid
  brand?: string | null; // NEW: null/"" => clear; string => trim + store
};
```

- [ ] **Step 2: Extend the `Resolved` type to carry name + brand**

```typescript
  type Resolved = {
    ean: string;
    version: number;
    purchase_price: number | null | undefined;
    selling_price: number | null | undefined;
    mrp: number | null | undefined;
    category: string | null | undefined;
    name: string | undefined; // undefined => leave unchanged
    brand: string | null | undefined; // undefined => leave; null => clear
  };
```

- [ ] **Step 3: Normalize + validate name and brand in the per-item loop**

In the loop, after the `category` resolution block and **before** the "no actual field to write" skip guard, add:

```typescript
    // name: undefined => unchanged; provided => trim; empty => invalid (never write "").
    let name: string | undefined;
    if (item.name === undefined) {
      name = undefined;
    } else {
      const trimmed = item.name.trim();
      if (!trimmed) {
        invalid.push({ ean, reason: "name cannot be empty" });
        continue;
      }
      name = trimmed;
    }

    // brand: undefined => unchanged; null/"" => clear; otherwise trim + store.
    let brand: string | null | undefined;
    if (item.brand === undefined) {
      brand = undefined;
    } else if (item.brand === null || item.brand === "") {
      brand = null;
    } else {
      brand = item.brand.trim() || null;
    }
```

- [ ] **Step 4: Add name/brand to the skip guard and the `resolved.push`**

Update the skip guard so a name-only or brand-only edit still counts as work:

```typescript
    // No actual field to write — skip rather than bump the version for nothing.
    if (
      purchase_price === undefined &&
      selling_price === undefined &&
      mrp === undefined &&
      category === undefined &&
      name === undefined &&
      brand === undefined
    ) {
      continue;
    }

    resolved.push({
      ean,
      version,
      purchase_price,
      selling_price,
      mrp,
      category,
      name,
      brand,
    });
```

- [ ] **Step 5: Include `original_data` in the transaction's `findUnique` select**

Brand is a read-modify-write of the JSON, so the existing row's `original_data` must be loaded:

```typescript
        const existing = await tx.product.findUnique({
          where: { session_id_ean: { session_id: session.id, ean: r.ean } },
          select: { id: true, version: true, original_data: true },
        });
```

- [ ] **Step 6: Write name + brand in the `update` data**

Extend the `update`'s `data` block (which currently spreads prices/category) to also set name and the merged `original_data`:

```typescript
        const nextOriginal =
          r.brand !== undefined
            ? {
                ...((existing.original_data as Record<string, unknown>) ?? {}),
                brand: r.brand,
              }
            : undefined;

        const updated = await tx.product.update({
          where: { id: existing.id, version: r.version },
          data: {
            ...(r.purchase_price !== undefined ? { purchase_price: r.purchase_price } : {}),
            ...(r.selling_price !== undefined ? { selling_price: r.selling_price } : {}),
            ...(r.mrp !== undefined ? { mrp: r.mrp } : {}),
            ...(r.category !== undefined ? { category: r.category } : {}),
            ...(r.name !== undefined ? { name: r.name } : {}),
            ...(nextOriginal !== undefined ? { original_data: nextOriginal } : {}),
            status: "updated",
            version: { increment: 1 },
          },
        });
```

(The `auditEntry.create` below it is unchanged — prices only.)

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 8: Manual check (curl)**

Against an active session with a known captured row (note its `ean` + `version`):

```bash
# Updates name, sets brand, preserves other original_data keys, bumps version.
curl -s -X POST http://localhost:3000/api/product/price-batch \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"ean":"<EAN>","version":<V>,"name":"Keo Karpin Oil","brand":"Keo Karpin"}]}'
# Expect: {"applied":[{"ean":"<EAN>","version":<V+1>}], ...}
```
Confirm: empty `name` ("   ") reports `invalid` with reason `name cannot be empty` and writes nothing; `brand:null` clears brand while `confidence`/`transcript` in `original_data` survive; a stale `version` reports `conflict`; a name-only edit is applied (not skipped).

- [ ] **Step 9: Commit**

```bash
git add app/api/product/price-batch/route.ts
git commit -m "feat(price-batch): accept and persist name + brand edits"
```

---

### Task 4: Distinct-names endpoint for type-ahead

**Files:**
- Create: `app/api/product/names/route.ts`

**Interfaces:**
- Produces: `GET /api/product/names` → `{ names: string[] }` (up to ~1000 distinct, case-insensitively deduped, ordered). Requires an active session (409 `NO_ACTIVE_SESSION`), mirroring sibling routes.

- [ ] **Step 1: Write the route**

```typescript
// app/api/product/names/route.ts
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAMES = 1000;

export async function GET() {
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

  // Distinct across ALL sessions so canonical spellings learned in past audits
  // assist the current one. Dedup case-insensitively in JS (DB distinct is
  // case-sensitive) and cap the list.
  const rows = await prisma.product.findMany({
    where: { name: { not: "" } },
    select: { name: true },
    distinct: ["name"],
    orderBy: { name: "asc" },
    take: MAX_NAMES * 4, // over-fetch; case-insensitive dedup trims below
  });

  const seen = new Set<string>();
  const names: string[] = [];
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(r.name);
    if (names.length >= MAX_NAMES) break;
  }

  return NextResponse.json({ names });
}
```

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: clean; route appears as `/api/product/names` in the build output.

- [ ] **Step 3: Manual check (curl)**

```bash
curl -s http://localhost:3000/api/product/names | head -c 300
# Expect: {"names":["...","..."]} — distinct, deduped.
```

- [ ] **Step 4: Commit**

```bash
git add app/api/product/names/route.ts
git commit -m "feat: add distinct product-names endpoint for type-ahead"
```

---

### Task 5: Return `original_data` from the worklist so the page can pre-fill Brand

**Files:**
- Modify: `app/api/product/uncategorized/route.ts` (the `findMany` `select`)
- Modify: `app/components/ProductForm.tsx` (`Product` type ~6-17)

**Interfaces:**
- Produces: worklist rows now include `original_data`; the `Product` type gains `original_data?: Record<string, unknown> | null` so the categorize page can read `original_data.brand`.

- [ ] **Step 1: Add `original_data` to the select**

In `app/api/product/uncategorized/route.ts`, add `original_data: true` to the `select`:

```typescript
      select: {
        id: true,
        ean: true,
        name: true,
        category: true,
        purchase_price: true,
        selling_price: true,
        mrp: true,
        status: true,
        version: true,
        original_data: true,
      },
```

- [ ] **Step 2: Extend the `Product` type**

In `app/components/ProductForm.tsx`:

```typescript
export type Product = {
  id: string;
  session_id: string;
  ean: string;
  name: string;
  category: string | null;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
  status: string;
  version: number;
  original_data?: Record<string, unknown> | null;
};
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/product/uncategorized/route.ts app/components/ProductForm.tsx
git commit -m "feat(worklist): expose original_data so the page can read brand"
```

---

### Task 6: Editable Name + Brand on the categorize worklist

**Files:**
- Modify: `app/categorize/page.tsx` (override state model, datalist fetch, row inputs, dirty/save/conflict logic)

**Interfaces:**
- Consumes: `GET /api/product/names` (Task 4), the extended `price-batch` (Task 3), `Product.original_data` (Task 5).
- Produces: per-row `{ name?, brand?, category? }` overrides; Save-all sends name/brand/category; conflict-retry re-applies the full override object by EAN.

- [ ] **Step 1: Replace the category-only selection state with an override object**

Change the selection state type and helpers. Replace:

```typescript
  // Per-row selected category keyed by product id. "" = no change.
  const [selections, setSelections] = useState<Record<string, string>>({});
```

with:

```typescript
  // Per-row edits keyed by product id. Each holds only the fields that differ
  // from the loaded row; an empty/absent override means "no change".
  type Override = { name?: string; brand?: string | null; category?: string };
  const [selections, setSelections] = useState<Record<string, Override>>({});
```

- [ ] **Step 2: Add a known-names datalist fetch**

After the category-loading `useEffect`, add state + a fetch for the names list:

```typescript
  const [knownNames, setKnownNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/product/names", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { names: [] }))
      .then((d) => {
        if (!cancelled) setKnownNames(d.names ?? []);
      })
      .catch(() => {
        if (!cancelled) setKnownNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);
```

- [ ] **Step 3: Compute per-row effective values + dirtiness against the loaded row**

Replace `setSelection` and `dirtyCount` with helpers that diff against the loaded `Product`. Add above the return (after `setSelections` is defined):

```typescript
  // The value shown in each input: the override if present, else the loaded row.
  const effName = (p: Product) => selections[p.id]?.name ?? p.name;
  const effBrand = (p: Product) => {
    const o = selections[p.id];
    if (o && "brand" in o) return o.brand ?? "";
    const b = (p.original_data as Record<string, unknown> | null | undefined)?.brand;
    return typeof b === "string" ? b : "";
  };
  const effCategory = (p: Product) => selections[p.id]?.category ?? "";

  const rowDirty = (p: Product): boolean => {
    const o = selections[p.id];
    if (!o) return false;
    const loadedBrand = (() => {
      const b = (p.original_data as Record<string, unknown> | null | undefined)?.brand;
      return typeof b === "string" ? b : "";
    })();
    if (o.name !== undefined && o.name !== p.name) return true;
    if ("brand" in o && (o.brand ?? "") !== loadedBrand) return true;
    if (o.category !== undefined && o.category !== "") return true;
    return false;
  };

  const updateOverride = useCallback(
    (id: string, patch: Override) => {
      setSelections((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    },
    []
  );

  const dirtyCount = rows.filter(rowDirty).length;
```

Delete the old `setSelection` `useCallback` and the old `const dirtyCount = Object.keys(selections).length;`.

- [ ] **Step 4: Rebuild the Save-all payload from overrides**

Replace the payload-building loop in `handleSaveAll` so it sends name/brand/category for every dirty row:

```typescript
    const items: {
      id: string;
      ean: string;
      version: number;
      name?: string;
      brand?: string | null;
      category?: string;
    }[] = [];
    for (const r of rows) {
      if (!rowDirty(r)) continue;
      const o = selections[r.id];
      const item: {
        id: string;
        ean: string;
        version: number;
        name?: string;
        brand?: string | null;
        category?: string;
      } = { id: r.id, ean: r.ean, version: r.version };
      if (o.name !== undefined && o.name !== r.name) item.name = o.name;
      if ("brand" in o) item.brand = o.brand;
      if (o.category) item.category = o.category;
      items.push(item);
    }
```

- [ ] **Step 5: Generalize conflict-retry to carry the whole override**

In `handleSaveAll`, change the conflict-carry map from `string` to `Override`. Replace the `conflictSelByEan` block:

```typescript
      const conflictEans = new Set(result.conflicts.map((c) => c.ean));
      const conflictSelByEan = new Map<string, Override>();
      for (const r of rows) {
        if (conflictEans.has(r.ean) && selections[r.id]) {
          conflictSelByEan.set(r.ean, selections[r.id]);
        }
      }
```

and the re-apply block after refetch:

```typescript
        const nextSelections: Record<string, Override> = {};
        for (const r of payload.rows) {
          const carried = conflictSelByEan.get(r.ean);
          if (carried) nextSelections[r.id] = carried;
        }
        setSelections(nextSelections);
```

- [ ] **Step 6: Render editable Name (with datalist) + Brand inputs and keep the Category select**

Replace the `<td className="px-4 py-3">` Product cell **and** the category `<td>` body. The Product cell becomes editable Name on its own line, with Brand + Category beneath, and the read-only EAN/price sub-line stays. Render one shared `<datalist>` once (e.g. just inside the `<tbody>`-wrapping fragment or above the table). First, add the datalist above the table (right after the opening of the `overflow-x-auto` div):

```tsx
              <datalist id="known-names">
                {knownNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
```

Then replace the two `<td>`s in the row map with:

```tsx
                          <td className="px-4 py-3">
                            <input
                              type="text"
                              value={effName(p)}
                              list="known-names"
                              onChange={(ev) =>
                                updateOverride(p.id, { name: ev.target.value })
                              }
                              disabled={saving}
                              placeholder="Product name"
                              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-text/60 disabled:opacity-50"
                              aria-label={`Name for ${p.name}`}
                            />
                            <p className="mt-1 text-xs text-muted">
                              <span className="font-mono">{p.ean}</span>
                              {` · MRP ₹${fmtPrice(p.mrp)} · PP ₹${fmtPrice(
                                p.purchase_price
                              )} · SP ₹${fmtPrice(p.selling_price)}`}
                            </p>
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex flex-col gap-2">
                              <input
                                type="text"
                                value={effBrand(p)}
                                onChange={(ev) =>
                                  updateOverride(p.id, {
                                    brand: ev.target.value || null,
                                  })
                                }
                                disabled={saving}
                                placeholder="Brand (optional)"
                                className="w-48 rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text outline-none focus:border-text/60 disabled:opacity-50"
                                aria-label={`Brand for ${p.name}`}
                              />
                              <select
                                value={effCategory(p)}
                                onChange={(ev) =>
                                  updateOverride(p.id, { category: ev.target.value })
                                }
                                disabled={saving}
                                className="w-48 rounded-md border border-border bg-bg px-2 py-2 text-sm text-text outline-none focus:border-text/60 disabled:opacity-50"
                                aria-label={`Category for ${p.name}`}
                              >
                                <option value="">— set category —</option>
                                {allCategories.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </td>
```

Block the empty-name save client-side: in the Save-all button, the `disabled` already gates on `dirtyCount === 0`; additionally guard against an emptied name. Replace the Save-all `disabled` with:

```tsx
                  disabled={
                    saving ||
                    dirtyCount === 0 ||
                    rows.some((p) => rowDirty(p) && !effName(p).trim())
                  }
```

- [ ] **Step 7: Build**

Run: `npm run build`
Expected: clean. (Watch for leftover references to the removed `setSelection` / old `selections[r.id]` string usage — update or remove them.)

- [ ] **Step 8: Manual check (page)**

`npm run dev`, open Categorize in an active session with captured rows:
- Editing a name marks the row dirty and increments Save-all `(N)`; editing brand likewise; setting a category likewise.
- Saving a name (e.g. "Kiyo Karpin Oil" → "Keo Karpin Oil") persists and shows corrected after the post-save refetch.
- Emptying a name disables Save-all (client-side block).
- Force a conflict (edit the same row in two tabs, save one, then the other): the conflicted row's full `{name,brand,category}` override is re-applied by EAN after refetch.

- [ ] **Step 9: Commit**

```bash
git add app/categorize/page.tsx
git commit -m "feat(categorize): editable name + brand inline with type-ahead"
```

---

## Self-Review

- **Spec coverage:** editable Name + Brand inputs + override state (Task 6); batch save accepts name+brand with read-modify-write brand + name-empty rejection (Task 3); local type-ahead via `/api/product/names` + `<datalist>` (Tasks 4, 6); export Brand column + header candidate (Tasks 1, 2); generalized conflict-retry carrying `{name,brand,category}` (Task 6 Step 5); backfill-the-27 is just the normal inline flow (no task needed). Required enabling change — worklist must return `original_data` for brand prefill — added as Task 5.
- **Placeholders:** none — every step shows the concrete code.
- **Type consistency:** `Override = { name?; brand?: string | null; category? }` defined in Task 6 Step 1 and used consistently in Steps 3-6; `Item`/`Resolved` extended with matching `name?: string` / `brand?: string | null` in Task 3; `HeaderMap.brand?: string` (Task 1) consumed by export `headers.brand` (Task 2); `Product.original_data?` (Task 5) consumed by `effBrand`/`rowDirty` (Task 6). `price-batch` item shape (`name?`, `brand?: string|null`, `category?`) matches what the page sends in Task 6 Step 4.
