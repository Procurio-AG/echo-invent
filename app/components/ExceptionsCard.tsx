"use client";

import { useCallback, useEffect, useState } from "react";

type Exception = {
  id: string;
  barcode: string;
  created_at: string;
};

export function ExceptionsCard({ refreshKey }: { refreshKey: number }) {
  const [exceptions, setExceptions] = useState<Exception[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/exception", { cache: "no-store" });
      const json = await res.json();
      setExceptions(json.exceptions ?? []);
    } catch {
      setExceptions([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  // Light polling — scanner pages add to this queue out-of-band.
  useEffect(() => {
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh]);

  const count = exceptions?.length ?? 0;

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">Exceptions</p>
        {count > 0 && (
          <span className="text-[10px] uppercase tracking-wider text-yellow-300">
            {count} unknown
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">Unknown barcodes</p>

      {loading ? (
        <p className="mt-4 text-xs text-muted">Loading…</p>
      ) : count === 0 ? (
        <p className="mt-4 text-xs text-muted">
          No unknown barcodes for this session.
        </p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="mt-4 w-full rounded-md border border-border bg-bg px-3 py-2 text-xs font-medium text-text hover:bg-border"
          >
            {expanded ? "Hide list" : `Show ${count} barcode${count === 1 ? "" : "s"}`}
          </button>
          {expanded && (
            <ul className="mt-3 max-h-56 space-y-1 overflow-y-auto rounded-md border border-border bg-bg p-2">
              {exceptions!.map((e) => (
                <li
                  key={e.id}
                  className="flex items-baseline justify-between gap-3 px-2 py-1 font-mono text-xs"
                >
                  <span className="truncate">{e.barcode}</span>
                  <span className="shrink-0 text-[10px] text-muted">
                    {new Date(e.created_at).toLocaleTimeString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
