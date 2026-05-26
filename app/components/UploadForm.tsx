"use client";

import { useRef, useState } from "react";
import { toast } from "react-hot-toast";

type UploadResponse = {
  sessionId: string;
  inserted: number;
  refreshed: number;
  skippedLocked: number;
  skippedNoEan: number;
  totalDataRows: number;
};

export function UploadForm({ onUploaded }: { onUploaded?: () => void } = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [lastResult, setLastResult] = useState<UploadResponse | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      toast.error("Pick a file first.");
      return;
    }

    setUploading(true);
    setLastResult(null);

    const formData = new FormData();
    formData.append("file", file);

    const toastId = toast.loading(`Uploading ${file.name}…`);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = (await res.json()) as UploadResponse | { error: string };

      if (!res.ok || "error" in data) {
        toast.error(("error" in data && data.error) || "Upload failed.", { id: toastId });
        return;
      }

      setLastResult(data);
      toast.success(
        `Imported ${data.inserted} new, refreshed ${data.refreshed}`,
        { id: toastId }
      );
      onUploaded?.();
    } catch {
      toast.error("Network error during upload.", { id: toastId });
    } finally {
      setUploading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border border-border bg-surface p-5">
      <p className="text-sm font-medium">Upload</p>
      <p className="mt-1 text-xs text-muted">Excel → DB buffer</p>

      <label className="mt-4 block">
        <span className="sr-only">Excel file</span>
        <input
          ref={inputRef}
          type="file"
          accept=".xlsx,.xls,.csv"
          disabled={uploading}
          onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
          className="block w-full text-xs text-muted file:mr-3 file:rounded-md file:border file:border-border file:bg-bg file:px-3 file:py-1.5 file:text-xs file:text-text hover:file:bg-border disabled:opacity-50"
        />
      </label>

      {fileName && (
        <p className="mt-2 truncate text-xs text-muted" title={fileName}>
          {fileName}
        </p>
      )}

      <button
        type="submit"
        disabled={uploading}
        className="mt-4 w-full rounded-md border border-border bg-bg px-3 py-2 text-xs font-medium text-text transition hover:bg-border disabled:cursor-not-allowed disabled:opacity-50"
      >
        {uploading ? "Uploading…" : "Import"}
      </button>

      {lastResult && (
        <>
          <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-muted">
            <dt>Inserted</dt>
            <dd className="text-right text-text">{lastResult.inserted}</dd>
            <dt>Refreshed</dt>
            <dd className="text-right text-text">{lastResult.refreshed}</dd>
            <dt>Skipped (locked)</dt>
            <dd className="text-right text-text">{lastResult.skippedLocked}</dd>
            <dt>Skipped (no EAN)</dt>
            <dd className="text-right text-text">{lastResult.skippedNoEan}</dd>
            <dt>Total rows</dt>
            <dd className="text-right text-text">{lastResult.totalDataRows}</dd>
          </dl>
          <p className="mt-3 truncate text-[10px] text-muted" title={lastResult.sessionId}>
            Session <span className="font-mono text-text">{lastResult.sessionId.slice(0, 8)}</span>
          </p>
        </>
      )}
    </form>
  );
}
