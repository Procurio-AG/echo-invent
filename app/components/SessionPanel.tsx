"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";

type ActiveSessionResponse = {
  session: {
    id: string;
    source_filename: string | null;
    started_at: string;
    closed_at: string | null;
  } | null;
  stats: { total: number; pending: number; updated: number } | null;
};

export function SessionPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<ActiveSessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const fetchActive = useCallback(async () => {
    try {
      const res = await fetch("/api/session/active", { cache: "no-store" });
      const json = (await res.json()) as ActiveSessionResponse;
      setData(json);
    } catch {
      toast.error("Failed to load session.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActive();
  }, [fetchActive, refreshKey]);

  const closeSession = async () => {
    setClosing(true);
    const toastId = toast.loading("Closing audit…");
    try {
      const res = await fetch("/api/session/close", { method: "POST" });
      if (!res.ok) throw new Error();
      toast.success("Audit closed. Next upload starts a new session.", { id: toastId });
      setConfirmOpen(false);
      await fetchActive();
    } catch {
      toast.error("Failed to close audit.", { id: toastId });
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <p className="text-sm font-medium">Active audit</p>
        {data?.session && (
          <span className="text-[10px] uppercase tracking-wider text-muted">Open</span>
        )}
      </div>

      {loading ? (
        <p className="mt-4 text-xs text-muted">Loading…</p>
      ) : !data?.session ? (
        <>
          <p className="mt-1 text-xs text-muted">No audit in progress.</p>
          <p className="mt-4 text-xs text-muted">
            Upload a sheet to start a new session.
          </p>
        </>
      ) : (
        <>
          <p className="mt-1 truncate text-xs text-muted" title={data.session.id}>
            <span className="font-mono">{data.session.id.slice(0, 8)}</span>
            {data.session.source_filename ? ` · ${data.session.source_filename}` : ""}
          </p>
          <p className="mt-1 text-[10px] text-muted">
            Started {new Date(data.session.started_at).toLocaleString()}
          </p>

          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            <Stat label="Total" value={data.stats?.total ?? 0} />
            <Stat label="Pending" value={data.stats?.pending ?? 0} />
            <Stat label="Updated" value={data.stats?.updated ?? 0} />
          </dl>

          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={closing}
            className="mt-4 w-full rounded-md border border-border bg-bg px-3 py-2 text-xs font-medium text-text transition hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
          >
            Start new audit
          </button>
        </>
      )}

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-5">
            <p className="text-sm font-medium">Close current audit?</p>
            <p className="mt-2 text-xs text-muted">
              This closes the active session. The next upload will start a fresh
              audit. Existing data stays in the database.
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={closing}
                className="flex-1 rounded-md border border-border bg-bg px-3 py-2 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={closeSession}
                disabled={closing}
                className="flex-1 rounded-md border border-border bg-text px-3 py-2 text-xs font-medium text-bg hover:opacity-90 disabled:opacity-50"
              >
                {closing ? "Closing…" : "Close audit"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-bg px-2 py-2">
      <p className="text-base font-medium text-text">{value}</p>
      <p className="text-[10px] uppercase tracking-wider text-muted">{label}</p>
    </div>
  );
}
