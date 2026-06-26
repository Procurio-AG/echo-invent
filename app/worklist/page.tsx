"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "react-hot-toast";
import type { CategoryGroup } from "@/app/components/ProductForm";

const TAKE = 100;

type Row = {
  id: string;
  ean: string;
  name: string;
  category: string | null;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
  batch: string | null;
  expiry_date: string | null;
  status: string;
  exported_at: string | null;
  exported: boolean;
  image_count: number;
  complete: boolean;
};

type WorklistResponse = { rows: Row[]; total: number; skip: number; take: number };

type PageState =
  | { kind: "loading" }
  | { kind: "no-active" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

function fmtPrice(n: number | null): string {
  return n === null ? "—" : String(n);
}

// Trigger a browser download from an export response blob (xlsx or zip).
async function downloadBlob(res: Response) {
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? "audit.xlsx";
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return filename;
}

export default function WorklistPage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);

  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [exported, setExported] = useState<"" | "true" | "false">("");
  const [complete, setComplete] = useState<"" | "true" | "false">("");

  const [groups, setGroups] = useState<CategoryGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    fetch("/api/categories", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setGroups(d.groups ?? []))
      .catch(() => setGroups([]));
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q.trim()) params.set("q", q.trim());
    if (category) params.set("category", category);
    if (exported) params.set("exported", exported);
    if (complete) params.set("complete", complete);
    params.set("skip", String(skip));
    params.set("take", String(TAKE));
    try {
      const res = await fetch(`/api/product/worklist?${params.toString()}`, {
        cache: "no-store",
      });
      if (res.status === 409) {
        setState({ kind: "no-active" });
        return;
      }
      if (!res.ok) {
        setState({ kind: "error", message: "Failed to load worklist." });
        return;
      }
      const data = (await res.json()) as WorklistResponse;
      setRows(data.rows);
      setTotal(data.total);
      setState({ kind: "ready" });
    } catch {
      setState({ kind: "error", message: "Network error." });
    }
  }, [q, category, exported, complete, skip]);

  // Debounce search; immediate for the other filters.
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  // Reset to first page when filters change.
  useEffect(() => {
    setSkip(0);
  }, [q, category, exported, complete]);

  const allSubcategories = useMemo(
    () => groups.flatMap((g) => g.subcategories),
    [groups]
  );

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const visibleIds = rows.map((r) => r.id);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });

  const runExport = async (
    payload: Record<string, unknown>,
    label: string
  ) => {
    setExporting(true);
    const toastId = toast.loading("Building xlsx…");
    try {
      const res = await fetch("/api/export/selected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let msg = "Export failed.";
        try {
          const data = await res.json();
          msg = data.error ?? msg;
        } catch {}
        toast.error(msg, { id: toastId });
        return;
      }
      const count = res.headers.get("X-Exported-Count") ?? "";
      const filename = await downloadBlob(res);
      toast.success(`${label}: ${count} rows → ${filename}`, {
        id: toastId,
        duration: 2500,
      });
      setSelected(new Set());
      await load(); // refresh so the "Exported before" column updates
    } catch {
      toast.error("Network error.", { id: toastId });
    } finally {
      setExporting(false);
    }
  };

  const exportSelected = () =>
    runExport({ ids: Array.from(selected) }, "Exported selection");

  const exportComplete = () =>
    runExport(
      { filter: { complete: true, exported: false }, requireComplete: true },
      "Exported complete"
    );

  // Images ship as a separate per-EAN zip; this does NOT mark rows exported.
  const downloadImages = async () => {
    setExporting(true);
    const toastId = toast.loading("Zipping images…");
    try {
      const res = await fetch("/api/export/images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selected) }),
      });
      if (!res.ok) {
        let msg = "No images to download.";
        try {
          msg = (await res.json()).error ?? msg;
        } catch {}
        toast.error(msg, { id: toastId });
        return;
      }
      const count = res.headers.get("X-Image-Count") ?? "";
      const filename = await downloadBlob(res);
      toast.success(`${count} images → ${filename}`, { id: toastId, duration: 2500 });
    } catch {
      toast.error("Network error.", { id: toastId });
    } finally {
      setExporting(false);
    }
  };

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
  if (state.kind === "error") {
    return <p className="p-6 text-sm text-red-400">{state.message}</p>;
  }

  const selectClass =
    "rounded-md border border-border bg-bg px-3 py-2 text-sm text-text outline-none focus:border-text/60";

  return (
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Worklist</h1>
        <span className="text-xs text-muted">{total} items</span>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name / EAN"
          className={selectClass + " min-w-[200px] flex-1"}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className={selectClass}
        >
          <option value="">All categories</option>
          {allSubcategories.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={exported}
          onChange={(e) => setExported(e.target.value as typeof exported)}
          className={selectClass}
        >
          <option value="">Exported: all</option>
          <option value="false">Not exported</option>
          <option value="true">Exported before</option>
        </select>
        <select
          value={complete}
          onChange={(e) => setComplete(e.target.value as typeof complete)}
          className={selectClass}
        >
          <option value="">Status: all</option>
          <option value="true">Complete</option>
          <option value="false">Incomplete</option>
        </select>
      </div>

      {/* Export actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={exportSelected}
          disabled={exporting || selected.size === 0}
          className="rounded-md border border-border bg-text px-3 py-2 text-xs font-medium text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Export selected ({selected.size})
        </button>
        <button
          type="button"
          onClick={exportComplete}
          disabled={exporting}
          className="rounded-md border border-border bg-bg px-3 py-2 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
        >
          Export complete &amp; not-yet-exported
        </button>
        <button
          type="button"
          onClick={downloadImages}
          disabled={exporting || selected.size === 0}
          className="rounded-md border border-border bg-bg px-3 py-2 text-xs font-medium text-text hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
        >
          Download images (zip)
        </button>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface text-[11px] uppercase tracking-wider text-muted">
            <tr>
              <th className="px-3 py-2">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAllVisible}
                  aria-label="Select all visible"
                />
              </th>
              <th className="px-3 py-2">EAN</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Category</th>
              <th className="px-3 py-2 text-right">PP</th>
              <th className="px-3 py-2 text-right">SP</th>
              <th className="px-3 py-2 text-right">MRP</th>
              <th className="px-3 py-2">Batch</th>
              <th className="px-3 py-2">Expiry</th>
              <th className="px-3 py-2 text-center">Img</th>
              <th className="px-3 py-2">Exported</th>
              <th className="px-3 py-2 text-center">Done</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-muted">
                  No items match.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border hover:bg-surface/40"
                >
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggleRow(r.id)}
                      aria-label={`Select ${r.ean}`}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.ean}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2">{r.category ?? "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {fmtPrice(r.purchase_price)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {fmtPrice(r.selling_price)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {fmtPrice(r.mrp)}
                  </td>
                  <td className="px-3 py-2">{r.batch ?? "—"}</td>
                  <td className="px-3 py-2">{r.expiry_date ?? "—"}</td>
                  <td className="px-3 py-2 text-center">
                    <Link
                      href={`/image-capture?ean=${encodeURIComponent(r.ean)}`}
                      className="underline hover:text-text"
                    >
                      {r.image_count}/3
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.exported_at ? (
                      <span className="text-yellow-300">
                        {r.exported_at.slice(0, 10)}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {r.complete ? (
                      <span className="text-green-400">✓</span>
                    ) : (
                      <span className="text-muted">✗</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="mt-3 flex items-center justify-between text-xs text-muted">
        <span>
          {skip + 1}–{Math.min(skip + TAKE, total)} of {total}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setSkip(Math.max(0, skip - TAKE))}
            disabled={skip === 0}
            className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
          >
            Prev
          </button>
          <button
            type="button"
            onClick={() => setSkip(skip + TAKE)}
            disabled={skip + TAKE >= total}
            className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
