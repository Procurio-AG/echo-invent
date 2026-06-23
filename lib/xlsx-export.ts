import * as XLSX from "xlsx";
import { resolveHeaders } from "@/lib/xlsx-import";

// Shared by the dashboard "updated rows" export (app/api/export) and the worklist
// flexible export (app/api/export/selected). Rebuilds the source workbook's column
// shape from original_data and writes the current product fields back into it, so
// the export mirrors the uploaded sheet. `includeExtras` appends the optional audit
// columns (Batch, Expiry Date, Image 1..3 URL) — used by the worklist export only.

export type ExportProduct = {
  ean: string;
  name: string;
  category: string | null;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
  batch?: string | null;
  expiry_date?: Date | string | null;
  original_data: unknown;
  images?: { position: number }[];
};

const DEFAULT_COLUMNS = [
  "Category Name",
  "Item Name",
  "EAN",
  "Purchase Price",
  "MRP",
  "Selling Price",
];

// Images themselves ship in a separate per-EAN zip (see app/api/export/images);
// the sheet just records how many photos exist so rows can be matched to folders.
const EXTRA_COLUMNS = ["Batch", "Expiry Date", "Images"];

function formatExpiry(v: Date | string | null | undefined): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function buildAuditXlsx(
  products: ExportProduct[],
  opts: { includeExtras?: boolean; sheetName?: string } = {}
): Buffer {
  const { includeExtras = false, sheetName = "Export" } = opts;

  // Prefer a product with real original_data so column order matches the source
  // workbook. Manually-created products carry an empty {} — fall back to defaults.
  const seed =
    products.find((p) => {
      const data = p.original_data as Record<string, unknown>;
      return data && Object.keys(data).length > 0;
    }) ?? null;

  const firstOriginal = seed
    ? ({ ...(seed.original_data as Record<string, unknown>) } as Record<string, unknown>)
    : (Object.fromEntries(DEFAULT_COLUMNS.map((c) => [c, null])) as Record<string, unknown>);
  const headers = resolveHeaders(firstOriginal);

  if (includeExtras) {
    for (const col of EXTRA_COLUMNS) {
      if (!(col in firstOriginal)) firstOriginal[col] = null;
    }
  }

  const rows = products.map((p) => {
    const original = { ...(p.original_data as Record<string, unknown>) };
    // Manually-created rows have empty original_data — seed the chosen shape.
    if (Object.keys(original).length === 0) {
      for (const key of Object.keys(firstOriginal)) original[key] = null;
    }
    if (headers.name) original[headers.name] = p.name;
    if (headers.category) original[headers.category] = p.category;
    if (headers.ean) original[headers.ean] = p.ean;
    if (headers.purchase_price) original[headers.purchase_price] = p.purchase_price;
    if (headers.selling_price) original[headers.selling_price] = p.selling_price;
    if (headers.mrp) original[headers.mrp] = p.mrp;

    if (includeExtras) {
      original["Batch"] = p.batch ?? "";
      original["Expiry Date"] = formatExpiry(p.expiry_date);
      original["Images"] = (p.images ?? []).length;
    }
    return original;
  });

  const sheet = XLSX.utils.json_to_sheet(rows, { header: Object.keys(firstOriginal) });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
