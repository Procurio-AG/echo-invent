"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import type { Product, CategoryGroup } from "@/app/components/ProductForm";

const TAKE = 100;

// Raw non-numeric source annotations, surfaced per column only when that
// column's Float is NULL because the source cell held text (e.g. "check").
type Flags = {
  purchase_price?: string;
  selling_price?: string;
  mrp?: string;
};

// A worklist row is the ProductForm Product plus the per-column flags object
// the list API now returns.
type WorklistRow = Product & { flags?: Flags };

type ListResponse = {
  rows: WorklistRow[];
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

// Per-row local edit. Inputs are pre-filled from the row's current values, so a
// field is "changed" only when its trimmed value differs from the original.
type Edit = { pp: string; sp: string; mrp: string };
type Field = "pp" | "sp" | "mrp";

const EMPTY_EDIT: Edit = { pp: "", sp: "", mrp: "" };

// Render a current numeric value as the string an input is seeded with.
function originalStr(n: number | null): string {
  return n === null ? "" : String(n);
}

// Build the initial edits map for a freshly-loaded set of rows, pre-filling each
// PP/SP/MRP field with the row's current value.
function seedEdits(rows: WorklistRow[]): Record<string, Edit> {
  const seeded: Record<string, Edit> = {};
  for (const r of rows) {
    seeded[r.id] = {
      pp: originalStr(r.purchase_price),
      sp: originalStr(r.selling_price),
      mrp: originalStr(r.mrp),
    };
  }
  return seeded;
}

// Validate a single (already-changed, non-blank) field value: mirror the
// server's toNullableNumber — finite and >= 0.
function parseInput(s: string): { value?: number; invalid: boolean } {
  const n = Number(s.trim());
  if (!Number.isFinite(n) || n < 0) return { invalid: true };
  return { value: n, invalid: false };
}

export default function PricingPage() {
  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [rows, setRows] = useState<WorklistRow[]>([]);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);

  // Filters: `q` is the live input, `query` is the debounced/submitted value.
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [groups, setGroups] = useState<CategoryGroup[]>([]);

  // Per-row edits keyed by product id, pre-filled from each row's current
  // values. Each row also carries the version we read it at, so the batch save
  // sends an optimistic version check per row.
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [saving, setSaving] = useState(false);

  // Refs to PP/SP/MRP inputs, keyed "<id>:pp" / "<id>:sp" / "<id>:mrp", for
  // Tab/Enter navigation.
  const inputRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const allCategories = useMemo(() => {
    const fromGroups = groups.flatMap((g) => g.subcategories);
    const set = new Set(fromGroups);
    for (const r of rows) if (r.category) set.add(r.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [groups, rows]);

  // Low-level fetch that returns the payload (or null on a handled error) so
  // both the navigation path (which resets edits) and the post-save refetch
  // (which re-applies conflict edits) can share it.
  const requestList = useCallback(
    async (
      nextSkip: number,
      nextQuery: string,
      nextCategory: string
    ): Promise<ListResponse | null> => {
      const params = new URLSearchParams();
      if (nextQuery) params.set("q", nextQuery);
      if (nextCategory) params.set("category", nextCategory);
      params.set("skip", String(nextSkip));
      params.set("take", String(TAKE));
      const res = await fetch(`/api/product/list?${params.toString()}`, {
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
    async (nextSkip: number, nextQuery: string, nextCategory: string) => {
      try {
        const payload = await requestList(nextSkip, nextQuery, nextCategory);
        if (!payload) return;
        setRows(payload.rows);
        setTotal(payload.total);
        setSkip(payload.skip);
        // A page change discards in-progress edits and re-seeds the inputs from
        // the new page's current values.
        setEdits(seedEdits(payload.rows));
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

  // Initial load.
  useEffect(() => {
    fetchList(0, "", "");
  }, [fetchList]);

  // Debounce the search box into `query`.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Re-fetch from the start whenever the committed filters change.
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    fetchList(0, query, category);
  }, [query, category, fetchList]);

  const setEdit = useCallback((id: string, field: Field, value: string) => {
    setEdits((prev) => {
      const cur = prev[id] ?? EMPTY_EDIT;
      return { ...prev, [id]: { ...cur, [field]: value } };
    });
  }, []);

  // ── Keyboard navigation: Tab/Enter walk PP -> SP -> MRP -> next row's PP. ──
  const orderedInputKeys = useMemo(() => {
    const keys: string[] = [];
    for (const r of rows) {
      keys.push(`${r.id}:pp`, `${r.id}:sp`, `${r.id}:mrp`);
    }
    return keys;
  }, [rows]);

  const focusKey = useCallback((key: string) => {
    inputRefs.current.get(key)?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, key: string) => {
      // Let Tab keep its native behaviour but constrain it to the grid order so
      // it skips straight between price inputs.
      if (e.key === "Enter" || e.key === "Tab") {
        const idx = orderedInputKeys.indexOf(key);
        if (idx === -1) return;
        const delta = e.shiftKey ? -1 : 1;
        const nextKey = orderedInputKeys[idx + delta];
        if (nextKey) {
          e.preventDefault();
          focusKey(nextKey);
        } else if (e.key === "Enter") {
          // Enter on the last input commits nothing special — just blur.
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
      }
    },
    [orderedInputKeys, focusKey]
  );

  // A row is dirty when any field's trimmed value differs from the row's
  // original value (the value the input was seeded with).
  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const r of rows) {
      const e = edits[r.id] ?? EMPTY_EDIT;
      if (
        e.pp.trim() !== originalStr(r.purchase_price) ||
        e.sp.trim() !== originalStr(r.selling_price) ||
        e.mrp.trim() !== originalStr(r.mrp)
      ) {
        count += 1;
      }
    }
    return count;
  }, [rows, edits]);

  // Pre-flight: only changed, non-blank fields are validated — a field left at
  // its original value or cleared to blank never blocks the save.
  const hasInvalidInput = useMemo(() => {
    for (const r of rows) {
      const e = edits[r.id] ?? EMPTY_EDIT;
      const checks: [string, string][] = [
        [e.pp.trim(), originalStr(r.purchase_price)],
        [e.sp.trim(), originalStr(r.selling_price)],
        [e.mrp.trim(), originalStr(r.mrp)],
      ];
      for (const [t, orig] of checks) {
        if (t !== orig && t !== "" && parseInput(t).invalid) return true;
      }
    }
    return false;
  }, [rows, edits]);

  const handleSaveAll = useCallback(async () => {
    if (saving || dirtyCount === 0) return;

    if (hasInvalidInput) {
      toast.error("Some prices are invalid (must be a number ≥ 0).");
      return;
    }

    // Build the batch payload from changed fields only. A field equal to its
    // original is omitted (no change); a field cleared to blank is also omitted
    // (we never clear a value via the grid).
    const items: {
      id: string;
      ean: string;
      version: number;
      purchase_price?: number;
      selling_price?: number;
      mrp?: number;
    }[] = [];

    for (const r of rows) {
      const e = edits[r.id] ?? EMPTY_EDIT;
      const item: (typeof items)[number] = {
        id: r.id,
        ean: r.ean,
        version: r.version,
      };
      let changed = false;
      const fields: [Field, "purchase_price" | "selling_price" | "mrp", number | null][] = [
        ["pp", "purchase_price", r.purchase_price],
        ["sp", "selling_price", r.selling_price],
        ["mrp", "mrp", r.mrp],
      ];
      for (const [field, key, original] of fields) {
        const t = e[field].trim();
        if (t === originalStr(original)) continue; // unchanged
        if (t === "") continue; // never clear a value via the grid
        const parsed = parseInput(t);
        if (parsed.invalid) continue; // guarded by hasInvalidInput above
        item[key] = parsed.value;
        changed = true;
      }
      if (changed) items.push(item);
    }

    if (items.length === 0) return;

    setSaving(true);
    const toastId = toast.loading("Saving prices…");
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
      // typed edits on top of the freshly-refetched rows (the manager retries
      // with one more "Save all" against the now-current version).
      const conflictEans = new Set(result.conflicts.map((c) => c.ean));
      const conflictEditsByEan = new Map<string, Edit>();
      for (const r of rows) {
        if (conflictEans.has(r.ean) && edits[r.id]) {
          conflictEditsByEan.set(r.ean, edits[r.id]);
        }
      }

      // Membership is now a complex server-side rule (a flagged row only drops
      // once its Float is set, and a non-numeric annotation can keep it in the
      // list). So instead of mutating rows locally, REFETCH the current page /
      // filters to recompute exactly which rows remain.
      const payload = await requestList(skip, query, category);
      if (payload) {
        setRows(payload.rows);
        setTotal(payload.total);
        setSkip(payload.skip);

        // Re-seed every input from the fresh current values, then re-apply the
        // conflict rows' typed edits on top (matched by ean, since ids are
        // stable per session) so the manager can retry against the now-current
        // version without re-typing.
        const nextEdits = seedEdits(payload.rows);
        for (const r of payload.rows) {
          const carried = conflictEditsByEan.get(r.ean);
          if (carried) nextEdits[r.id] = carried;
        }
        setEdits(nextEdits);
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
  }, [saving, dirtyCount, hasInvalidInput, rows, edits, requestList, skip, query, category]);

  const pageStart = total === 0 ? 0 : skip + 1;
  const pageEnd = Math.min(skip + rows.length, total);
  const hasPrev = skip > 0;
  const hasNext = skip + TAKE < total;

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">Pricing</p>
        <h1 className="font-serif text-3xl tracking-tight">Pricing worklist</h1>
        <p className="max-w-xl text-sm text-muted">
          Audited items still missing a purchase, selling price or MRP — including
          rows where the source cell held a note like “check” instead of a number.
          Known prices are pre-filled and editable; fill in the missing ones, then
          save them all at once. Tab or Enter jumps between price fields.
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
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-text focus:border-text/60 focus:outline-none sm:w-64"
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {allCategories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          {total === 0 ? (
            <div className="rounded-lg border border-border bg-surface p-8 text-center">
              <p className="text-sm font-medium">All audited items priced</p>
              <p className="mt-1 text-xs text-muted">
                {query || category
                  ? "Nothing in the worklist matches these filters."
                  : "Every audited item in the active audit has a purchase price, selling price and MRP."}
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted">
                  Showing {pageStart}–{pageEnd} of {total} needing a price
                </p>
                <p className="text-xs text-muted">
                  {dirtyCount > 0
                    ? `${dirtyCount} row${dirtyCount === 1 ? "" : "s"} edited`
                    : "No edits yet"}
                </p>
              </div>

              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface text-left text-[10px] uppercase tracking-wider text-muted">
                      <th className="px-4 py-3 font-medium">Product</th>
                      <th className="px-3 py-3 font-medium">Purchase price</th>
                      <th className="px-3 py-3 font-medium">Selling price</th>
                      <th className="px-3 py-3 font-medium">MRP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => {
                      const e = edits[p.id] ?? EMPTY_EDIT;
                      const ppKey = `${p.id}:pp`;
                      const spKey = `${p.id}:sp`;
                      const mrpKey = `${p.id}:mrp`;
                      const flags = p.flags ?? {};
                      const inputBase =
                        "w-28 rounded-md border bg-bg px-2 py-2 font-mono text-sm text-text outline-none focus:border-text/60 disabled:opacity-50";
                      // Border cue: invalid (changed, non-blank, bad number) -> red;
                      // still-empty -> yellow (needs a value); otherwise default.
                      const borderFor = (raw: string): string => {
                        const t = raw.trim();
                        if (t !== "" && parseInput(t).invalid) return "border-red-500";
                        if (t === "") return "border-yellow-500/40";
                        return "border-border";
                      };
                      const ppBorder = borderFor(e.pp);
                      const spBorder = borderFor(e.sp);
                      const mrpBorder = borderFor(e.mrp);
                      return (
                        <tr
                          key={p.id}
                          className="border-b border-border last:border-b-0 align-top hover:bg-surface/60"
                        >
                          <td className="px-4 py-3">
                            <p className="font-medium text-text">{p.name}</p>
                            <p className="mt-0.5 text-xs text-muted">
                              <span className="font-mono">{p.ean}</span>
                              {p.category ? ` · ${p.category}` : ""}
                            </p>
                          </td>
                          <td className="px-3 py-3">
                            <input
                              ref={(el) => {
                                if (el) inputRefs.current.set(ppKey, el);
                                else inputRefs.current.delete(ppKey);
                              }}
                              type="text"
                              inputMode="decimal"
                              value={e.pp}
                              onChange={(ev) => setEdit(p.id, "pp", ev.target.value)}
                              onKeyDown={(ev) => handleKeyDown(ev, ppKey)}
                              disabled={saving}
                              className={`${inputBase} ${ppBorder}`}
                              placeholder="price"
                              aria-label={`Purchase price for ${p.name}`}
                            />
                            <FlagBadge text={flags.purchase_price} label="Source purchase price" />
                          </td>
                          <td className="px-3 py-3">
                            <input
                              ref={(el) => {
                                if (el) inputRefs.current.set(spKey, el);
                                else inputRefs.current.delete(spKey);
                              }}
                              type="text"
                              inputMode="decimal"
                              value={e.sp}
                              onChange={(ev) => setEdit(p.id, "sp", ev.target.value)}
                              onKeyDown={(ev) => handleKeyDown(ev, spKey)}
                              disabled={saving}
                              className={`${inputBase} ${spBorder}`}
                              placeholder="price"
                              aria-label={`Selling price for ${p.name}`}
                            />
                            <FlagBadge text={flags.selling_price} label="Source selling price" />
                          </td>
                          <td className="px-3 py-3">
                            <input
                              ref={(el) => {
                                if (el) inputRefs.current.set(mrpKey, el);
                                else inputRefs.current.delete(mrpKey);
                              }}
                              type="text"
                              inputMode="decimal"
                              value={e.mrp}
                              onChange={(ev) => setEdit(p.id, "mrp", ev.target.value)}
                              onKeyDown={(ev) => handleKeyDown(ev, mrpKey)}
                              disabled={saving}
                              className={`${inputBase} ${mrpBorder}`}
                              placeholder="MRP"
                              aria-label={`MRP for ${p.name}`}
                            />
                            <FlagBadge text={flags.mrp} label="Source MRP" />
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
                    onClick={() => fetchList(Math.max(0, skip - TAKE), query, category)}
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
                    onClick={() => fetchList(skip + TAKE, query, category)}
                    disabled={!hasNext || saving}
                    className="rounded-md border border-border bg-bg px-4 py-2 text-xs font-medium text-text transition hover:bg-border disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleSaveAll}
                  disabled={saving || dirtyCount === 0}
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

// Small warning badge surfacing the raw non-numeric source annotation (e.g.
// "check") an auditor wrote into a price cell. Renders nothing when the column
// is not flagged.
function FlagBadge({ text, label }: { text?: string; label: string }) {
  if (!text) return null;
  return (
    <span
      className="mt-1 inline-flex max-w-28 items-center gap-1 rounded border border-yellow-500/40 bg-yellow-500/10 px-1.5 py-0.5 text-[10px] font-medium text-yellow-300"
      title={`${label}: ${text}`}
    >
      <span aria-hidden>⚠</span>
      <span className="truncate">{text}</span>
    </span>
  );
}
