"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listImages,
  removeImages,
  updateImage,
  type QueuedImage,
} from "./queue";

const MAX_ATTEMPTS = 6;
const DRAIN_INTERVAL_MS = 4000;

// Terminal HTTP outcomes — retrying won't help, so the item parks as "failed"
// for the user to remove (oversized, wrong type, unknown EAN, slots full).
function isTerminal(status: number, code: string): boolean {
  return (
    status === 413 ||
    status === 415 ||
    status === 404 ||
    code === "MAX_IMAGES"
  );
}

// Drains the IndexedDB image queue to the server in the background, with retry and
// backoff (via the drain interval). One instance should own the queue — mount it
// once on the capture page and pass its state down to the sync panel.
export function useImageUploader() {
  const [items, setItems] = useState<QueuedImage[]>([]);
  const drainingRef = useRef(false);
  const pausedRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listImages());
    } catch {
      /* ignore */
    }
  }, []);

  const uploadOne = useCallback(async (item: QueuedImage) => {
    await updateImage(item.id, { status: "uploading" });
    try {
      const form = new FormData();
      form.append(
        "file",
        new File([item.blob], `${item.ean}.jpg`, { type: item.mimeType })
      );
      const res = await fetch(
        `/api/product/${encodeURIComponent(item.ean)}/images`,
        { method: "POST", body: form }
      );
      if (res.ok) {
        await removeImages([item.id]);
        return;
      }
      let code = "";
      try {
        code = ((await res.json()) as { code?: string }).code ?? "";
      } catch {
        /* non-JSON */
      }
      if (code === "NO_ACTIVE_SESSION") {
        pausedRef.current = true;
        await updateImage(item.id, { status: "pending" });
        return;
      }
      const attempts = item.attempts + 1;
      const terminal = isTerminal(res.status, code) || attempts >= MAX_ATTEMPTS;
      await updateImage(item.id, {
        status: terminal ? "failed" : "pending",
        attempts,
        lastError: code || `HTTP ${res.status}`,
      });
    } catch {
      const attempts = item.attempts + 1;
      await updateImage(item.id, {
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        attempts,
        lastError: "Network error",
      });
    }
  }, []);

  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    pausedRef.current = false;
    try {
      const queue = await listImages();
      for (const item of queue) {
        if (pausedRef.current) break;
        if (item.status !== "pending") continue;
        await uploadOne(item);
        await refresh();
      }
    } finally {
      drainingRef.current = false;
      await refresh();
    }
  }, [uploadOne, refresh]);

  // Drain on mount, on an interval, and when connectivity returns.
  useEffect(() => {
    refresh();
    drain();
    const interval = setInterval(drain, DRAIN_INTERVAL_MS);
    const onOnline = () => drain();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
    };
  }, [drain, refresh]);

  const retry = useCallback(
    async (id: string) => {
      await updateImage(id, { status: "pending", attempts: 0, lastError: undefined });
      await drain();
    },
    [drain]
  );

  const retryAllFailed = useCallback(async () => {
    const all = await listImages();
    await Promise.all(
      all
        .filter((i) => i.status === "failed")
        .map((i) => updateImage(i.id, { status: "pending", attempts: 0, lastError: undefined }))
    );
    await drain();
  }, [drain]);

  const remove = useCallback(
    async (id: string) => {
      await removeImages([id]);
      await refresh();
    },
    [refresh]
  );

  return { items, refresh, kick: drain, retry, retryAllFailed, remove };
}
