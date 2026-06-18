"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import type { Product, CategoryGroup } from "@/app/components/ProductForm";

const TAKE = 100;

type ListResponse = {
  rows: Product[];
  total: number;
  skip: number;
  take: number;
};

type BatchResponse = {
  applied: { ean: string; version: number }[];
  conflicts: { ean: string; currentVersion: number }[];
  notFound: string[];
  invalid: { ean: string; reason: string }[];
};

type PageState =
  | { kind: "loading" }
  | { kind: "no-active" }
  | { kind: "error"; message: string }
  | { kind: "ready" };

function fmtPrice(n: number | null): string {
  return n === null ? "—" : String(n);
}

export default function CategorizePage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [rows, setRows] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);

  // `q` is the live input, `query` is the debounced/submitted value.
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<CategoryGroup[]>([]);

  // Per-row edits keyed by product id. Each holds only the fields that differ
  // from the loaded row; an empty/absent override means "no change".
  type Override = { name?: string; brand?: string | null; category?: string };
  const [selections, setSelections] = useState<Record<string, Override>>({});
  const [saving, setSaving] = useState(false);
  const [knownNames, setKnownNames] = useState<string[]>([]);

  const allCategories = useMemo(() => {
    const fromGroups = groups.flatMap((g) => g.subcategories);
    const set = new Set(fromGroups);
    for (const r of rows) if (r.category) set.add(r.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [groups, rows]);

  // Low-level fetch that returns the payload (or null on a handled error) so
  // both the navigation path (which resets selections) and the post-save
  // refetch (which re-applies conflict selections) can share it.
  const requestList = useCallback(
    async (nextSkip: number, nextQuery: string): Promise<ListResponse | null> => {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      params.set("skip", String(nextSkip));
      params.set("take", String(TAKE));
      const res = await fetch(`/api/product/uncategorized?${params.toString()}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
        setState({ kind: "no-active" });
        return null;
      }
      if (!res.ok) {
        setState({ kind: "error", message: data.error ?? "Failed to load worklist." });
        return null;
      }
      return data as ListResponse;
    },
    []
  );

  const fetchList = useCallback(
    async (nextSkip: number, nextQuery: string) => {
      try {
        const payload = await requestList(nextSkip, nextQuery);
        if (!payload) return;
        setRows(payload.rows);
        setTotal(payload.total);
        setSkip(payload.skip);
        // A page change discards in-progress selections — they belonged to the
        // old page.
        setSelections({});
        setState({ kind: "ready" });
      } catch {
        setState({ kind: "error", message: "Network error." });
      }
    },
    [requestList]
  );

  // Load category options once.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/categories", { cache: "force-cache" })
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setGroups(d.groups ?? []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load known product names once for the type-ahead datalist.
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

  // Initial load.
  useEffect(() => {
    fetchList(0, "");
  }, [fetchList]);

  // Debounce the search box into `query`.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Re-fetch from the start whenever the committed query changes.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    fetchList(0, query);
  }, [query, fetchList]);

  const loadedBrand = (p: Product): string => {
    const b = (p.original_data as Record<string, unknown> | null | undefined)?.brand;
    return typeof b === "string" ? b : "";
  };

  // The value shown in each input: the override if present, else the loaded row.
  const effName = (p: Product) => selections[p.id]?.name ?? p.name;
  const effBrand = (p: Product) => {
    const o = selections[p.id];
    if (o && "brand" in o) return o.brand ?? "";
    return loadedBrand(p);
  };
  const effCategory = (p: Product) => selections[p.id]?.category ?? "";

  const rowDirty = (p: Product): boolean => {
    const o = selections[p.id];
    if (!o) return false;
    if (o.name !== undefined && o.name !== p.name) return true;
    if ("brand" in o && (o.brand ?? "") !== loadedBrand(p)) return true;
    if (o.category !== undefined && o.category !== "") return true;
    return false;
  };

  const updateOverride = useCallback((id: string, patch: Override) => {
    setSelections((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);

  const dirtyCount = rows.filter(rowDirty).length;

  const handleSaveAll = useCallback(async () => {
    if (saving || dirtyCount === 0) return;

    // Build the batch payload from dirty rows, sending only changed fields.
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

    if (items.length === 0) return;

    setSaving(true);
    const toastId = toast.loading("Saving categories…");
    try {
      const res = await fetch("/api/product/price-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();

      if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
        setState({ kind: "no-active" });
        toast.error("No active audit.", { id: toastId });
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? "Save failed.", { id: toastId });
        return;
      }

      const result = data as BatchResponse;

      // Capture which rows conflicted, keyed by ean, so we can re-apply the
      // chosen category on top of the freshly-refetched rows.
      const conflictEans = new Set(result.conflicts.map((c) => c.ean));
      const conflictSelByEan = new Map<string, Override>();
      for (const r of rows) {
        if (conflictEans.has(r.ean) && selections[r.id]) {
          conflictSelByEan.set(r.ean, selections[r.id]);
        }
      }

      // Refetch the current page to recompute exactly which rows remain
      // uncategorised after the save.
      const payload = await requestList(skip, query);
      if (payload) {
        setRows(payload.rows);
        setTotal(payload.total);
        setSkip(payload.skip);

        // Re-apply conflict rows' selections on top of the refetched rows
        // (matched by ean, since ids are stable per session) so the auditor can
        // retry against the now-current version without re-selecting.
        const nextSelections: Record<string, Override> = {};
        for (const r of payload.rows) {
          const carried = conflictSelByEan.get(r.ean);
          if (carried) nextSelections[r.id] = carried;
        }
        setSelections(nextSelections);
      }

      const savedCount = result.applied.length;
      const conflictCount = result.conflicts.length;
      const otherBad = result.notFound.length + result.invalid.length;
      const parts = [`${savedCount} saved`];
      if (conflictCount > 0)
        parts.push(`${conflictCount} conflict${conflictCount === 1 ? "" : "s"}`);
      if (otherBad > 0) parts.push(`${otherBad} rejected`);
      const summary = parts.join(", ");

      if (conflictCount > 0 || otherBad > 0) {
        toast.error(summary, { id: toastId, duration: 4000 });
      } else {
        toast.success(summary, { id: toastId, duration: 2000 });
      }
    } catch {
      toast.error("Network error.", { id: toastId, duration: 4000 });
    } finally {
      setSaving(false);
    }
  }, [saving, dirtyCount, rows, selections, requestList, skip, query]);

  const pageStart = total === 0 ? 0 : skip + 1;
  const pageEnd = Math.min(skip + rows.length, total);
  const hasPrev = skip > 0;
  const hasNext = skip + TAKE < total;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">Categorisation</p>
        <h1 className="font-serif text-3xl tracking-tight">Categorisation worklist</h1>
        <p className="max-w-xl text-sm text-muted">
          Items captured or audited that still need a category. Assign a category
          across as many rows as you like, then save them all at once.
        </p>
      </header>

      {state.kind === "loading" && <p className="text-sm text-muted">Loading…</p>}

      {state.kind === "no-active" && (
        <div className="rounded-lg border border-border bg-surface p-5">
          <p className="text-sm font-medium">No active audit</p>
          <p className="mt-1 text-xs text-muted">
            Upload a sheet on the dashboard to start a session.
          </p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="rounded-lg border border-border bg-surface p-5">
          <p className="text-sm font-medium">Something went wrong</p>
          <p className="mt-1 text-xs text-muted">{state.message}</p>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name or EAN"
              className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
              aria-label="Search worklist by name or EAN"
            />
          </div>

          {total === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-8 text-center">
              <p className="text-sm font-medium">All audited items categorised</p>
              <p className="mt-1 text-xs text-muted">
                {query
                  ? "Nothing in the worklist matches this search."
                  : "Every audited item in the active audit has a category."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted">
                  Showing {pageStart}–{pageEnd} of {total} needing a category
                </p>
                <p className="text-xs text-muted">
                  {dirtyCount > 0
                    ? `${dirtyCount} row${dirtyCount === 1 ? "" : "s"} edited`
                    : "No edits yet"}
                </p>
              </div>

              <datalist id="known-names">
                {knownNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>

              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[760px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface text-left text-[10px] uppercase tracking-wider text-muted">
                      <th className="px-4 py-3 font-medium">Product</th>
                      <th className="px-3 py-3 font-medium">Category</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      return (
                        <tr
                          key={p.id}
                          className="border-b border-border last:border-b-0 align-top hover:bg-surface/60"
                        >
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
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fetchList(Math.max(0, skip - TAKE), query)}
                    disabled={!hasPrev || saving}
                    className="rounded-md border border-border bg-bg px-4 py-2 text-xs font-medium text-text transition hover:bg-border disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-xs text-muted">
                    {pageStart}–{pageEnd} of {total}
                  </span>
                  <button
                    type="button"
                    onClick={() => fetchList(skip + TAKE, query)}
                    disabled={!hasNext || saving}
                    className="rounded-md border border-border bg-bg px-4 py-2 text-xs font-medium text-text transition hover:bg-border disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleSaveAll}
                  disabled={
                    saving ||
                    dirtyCount === 0 ||
                    rows.some((p) => rowDirty(p) && !effName(p).trim())
                  }
                  className="rounded-md border border-border bg-text px-6 py-2 text-sm font-medium text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving
                    ? "Saving…"
                    : dirtyCount === 0
                    ? "Save all"
                    : `Save all (${dirtyCount})`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
