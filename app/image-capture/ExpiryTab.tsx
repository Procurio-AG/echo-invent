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
