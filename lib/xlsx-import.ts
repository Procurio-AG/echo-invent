import * as XLSX from "xlsx";

export type ParsedRow = {
  ean: string;
  name: string;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
  original_data: Record<string, unknown>;
};

export type ParseResult = {
  rows: ParsedRow[];
  skippedNoEan: number;
  totalDataRows: number;
};

export type HeaderMap = {
  ean?: string;
  name?: string;
  purchase_price?: string;
  selling_price?: string;
  mrp?: string;
};

const HEADER_CANDIDATES = {
  ean: ["ean", "barcode", "bar code"],
  name: ["item name", "product name", "name", "description"],
  purchase_price: ["purchase price", "cost price", "cost", "pp"],
  selling_price: ["selling price", "sell price", "sp"],
  mrp: ["mrp", "max retail price", "maximum retail price"],
} as const;

export function resolveHeaders(sample: Record<string, unknown>): HeaderMap {
  const keys = Object.keys(sample);
  const normalized = keys.map((k) => ({ raw: k, norm: k.trim().toLowerCase() }));
  const find = (candidates: readonly string[]) =>
    normalized.find((n) => candidates.includes(n.norm))?.raw;

  return {
    ean: find(HEADER_CANDIDATES.ean),
    name: find(HEADER_CANDIDATES.name),
    purchase_price: find(HEADER_CANDIDATES.purchase_price),
    selling_price: find(HEADER_CANDIDATES.selling_price),
    mrp: find(HEADER_CANDIDATES.mrp),
  };
}

function toNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function toEanString(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Avoid scientific notation if xlsx hands back a Number for long EANs.
  if (typeof v === "number") return v.toFixed(0);
  return String(v).trim();
}

export class XlsxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxImportError";
  }
}

export function parseWorkbook(buffer: ArrayBuffer | Buffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) throw new XlsxImportError("Workbook has no sheets.");

  const sheet = workbook.Sheets[firstSheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: null,
    raw: false,
  });

  if (raw.length === 0) {
    return { rows: [], skippedNoEan: 0, totalDataRows: 0 };
  }

  const headers = resolveHeaders(raw[0]);
  if (!headers.ean) throw new XlsxImportError("Could not find an EAN column.");
  if (!headers.name) throw new XlsxImportError("Could not find an Item Name column.");

  const rows: ParsedRow[] = [];
  const seenEans = new Set<string>();
  let skippedNoEan = 0;

  for (const row of raw) {
    const ean = toEanString(row[headers.ean]);
    if (!ean) {
      skippedNoEan += 1;
      continue;
    }
    // De-dupe within the upload itself; first occurrence wins.
    if (seenEans.has(ean)) continue;
    seenEans.add(ean);

    rows.push({
      ean,
      name: String(row[headers.name] ?? "").trim() || "(unnamed)",
      purchase_price: headers.purchase_price ? toNullableNumber(row[headers.purchase_price]) : null,
      selling_price: headers.selling_price ? toNullableNumber(row[headers.selling_price]) : null,
      mrp: headers.mrp ? toNullableNumber(row[headers.mrp]) : null,
      original_data: row,
    });
  }

  return { rows, skippedNoEan, totalDataRows: raw.length };
}
