"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";

type ActiveSessionResponse = {
  session: { id: string } | null;
  stats: { total: number; pending: number; updated: number } | null;
};

export function ExportCard({ refreshKey }: { refreshKey: number }) {
  const [stats, setStats] = useState<{ updated: number; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [hasSession, setHasSession] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/session/active", { cache: "no-store" });
      const json = (await res.json()) as ActiveSessionResponse;
      setHasSession(!!json.session);
      setStats(
        json.stats
          ? { updated: json.stats.updated, total: json.stats.total }
          : null
      );
    } catch {
      setHasSession(false);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const download = async () => {
    setDownloading(true);
    const toastId = toast.loading("Building xlsx…");
    try {
      const res = await fetch("/api/export", { cache: "no-store" });
      if (!res.ok) {
        let msg = "Export failed.";
        try {
          const data = await res.json();
          msg = data.error ?? msg;
        } catch {}
        toast.error(msg, { id: toastId });
        return;
      }

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

      toast.success(`Downloaded ${filename}`, { id: toastId, duration: 2000 });
    } catch {
      toast.error("Network error.", { id: toastId });
    } finally {
      setDownloading(false);
    }
  };

  const updatedCount = stats?.updated ?? 0;
  const canExport = hasSession && updatedCount > 0;

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <p className="text-sm font-medium">Export</p>
      <p className="mt-1 text-xs text-muted">Updated rows → Excel</p>

      {loading ? (
        <p className="mt-4 text-xs text-muted">Loading…</p>
      ) : !hasSession ? (
        <p className="mt-4 text-xs text-muted">No active audit.</p>
      ) : (
        <p className="mt-4 text-xs text-muted">
          <span className="font-mono text-text">{updatedCount}</span> updated of{" "}
          <span className="font-mono text-text">{stats?.total ?? 0}</span> ready to download.
        </p>
      )}

      <button
        type="button"
        onClick={download}
        disabled={!canExport || downloading}
        className="mt-4 w-full rounded-md border border-border bg-bg px-3 py-2 text-xs font-medium text-text transition hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
      >
        {downloading ? "Preparing…" : "Download xlsx"}
      </button>
    </div>
  );
}
