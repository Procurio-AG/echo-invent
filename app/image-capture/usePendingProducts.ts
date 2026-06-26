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
