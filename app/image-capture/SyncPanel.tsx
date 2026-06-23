"use client";

import type { ImageStatus, QueuedImage } from "./queue";

const STATUS_LABEL: Record<ImageStatus, string> = {
  pending: "Pending",
  uploading: "Uploading",
  failed: "Failed",
  done: "Done",
};

const STATUS_COLOR: Record<ImageStatus, string> = {
  pending: "text-muted",
  uploading: "text-yellow-300",
  failed: "text-red-400",
  done: "text-green-400",
};

export function SyncPanel({
  items,
  onRetry,
  onRemove,
  onRetryAllFailed,
}: {
  items: QueuedImage[];
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onRetryAllFailed: () => void;
}) {
  const counts = items.reduce(
    (acc, i) => {
      acc[i.status] += 1;
      return acc;
    },
    { pending: 0, uploading: 0, failed: 0, done: 0 } as Record<ImageStatus, number>
  );
  const hasFailed = counts.failed > 0;

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Upload queue</p>
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className={STATUS_COLOR.pending}>{counts.pending} pending</span>
          <span className={STATUS_COLOR.uploading}>{counts.uploading} uploading</span>
          <span className={STATUS_COLOR.failed}>{counts.failed} failed</span>
          {hasFailed && (
            <button
              type="button"
              onClick={onRetryAllFailed}
              className="rounded-md border border-border px-2 py-1 text-text hover:bg-border"
            >
              Retry all failed
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-xs text-muted">Queue is empty — captures upload here.</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {items.map((i) => (
            <li
              key={i.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-bg px-3 py-2 text-xs"
            >
              <div className="min-w-0">
                <span className="font-mono text-muted">{i.ean}</span>{" "}
                <span className="truncate text-text">{i.productName}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={STATUS_COLOR[i.status]}>
                  {STATUS_LABEL[i.status]}
                  {i.status === "failed" && i.lastError ? ` · ${i.lastError}` : ""}
                </span>
                {i.status === "failed" && (
                  <button
                    type="button"
                    onClick={() => onRetry(i.id)}
                    className="rounded-md border border-border px-2 py-0.5 text-text hover:bg-border"
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(i.id)}
                  className="rounded-md border border-border px-2 py-0.5 text-muted hover:bg-border hover:text-text"
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
