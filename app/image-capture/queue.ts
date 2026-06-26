// IndexedDB-backed queue of captured product images, decoupled from upload so the
// auditor is never blocked by the Tailscale funnel. Mirrors app/rapid-capture/queue.ts.
// Keyed by a generated id (not EAN) because one product can have several queued
// images. The compressed JPEG Blob is stored so the queue survives reload / lock.

export const QUEUE_MAX = 50;

const DB_NAME = "image-capture";
const STORE = "images";
const DB_VERSION = 1;

export type ImageStatus = "pending" | "uploading" | "failed" | "done";

export type QueuedImage = {
  id: string;
  ean: string;
  productName: string;
  blob: Blob;
  mimeType: string;
  status: ImageStatus;
  attempts: number;
  lastError?: string;
  order: number;
  createdAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function asPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export async function listImages(): Promise<QueuedImage[]> {
  const db = await openDb();
  try {
    const all = (await asPromise(tx(db, "readonly").getAll())) as QueuedImage[];
    return all.sort((a, b) => a.order - b.order);
  } finally {
    db.close();
  }
}

export async function countImages(): Promise<number> {
  const db = await openDb();
  try {
    return await asPromise(tx(db, "readonly").count());
  } finally {
    db.close();
  }
}

export async function enqueueImage(input: {
  ean: string;
  productName: string;
  blob: Blob;
  mimeType: string;
}): Promise<void> {
  const db = await openDb();
  try {
    const all = (await asPromise(tx(db, "readonly").getAll())) as QueuedImage[];
    const nextOrder =
      all.length === 0 ? 0 : Math.max(...all.map((c) => c.order)) + 1;
    const record: QueuedImage = {
      id: uid(),
      ean: input.ean,
      productName: input.productName,
      blob: input.blob,
      mimeType: input.mimeType,
      status: "pending",
      attempts: 0,
      order: nextOrder,
      createdAt: Date.now(),
    };
    await asPromise(tx(db, "readwrite").put(record));
  } finally {
    db.close();
  }
}

export async function updateImage(
  id: string,
  patch: Partial<QueuedImage>
): Promise<void> {
  const db = await openDb();
  try {
    const store = tx(db, "readwrite");
    const existing = (await asPromise(store.get(id))) as QueuedImage | undefined;
    if (!existing) return;
    await asPromise(store.put({ ...existing, ...patch, id }));
  } finally {
    db.close();
  }
}

export async function removeImages(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  try {
    const store = tx(db, "readwrite");
    await Promise.all(ids.map((id) => asPromise(store.delete(id))));
  } finally {
    db.close();
  }
}

// How many images (queued + uploaded-not-yet-pruned) exist locally for an EAN —
// used to enforce the 3-image cap before enqueueing another.
export async function pendingCountForEan(ean: string): Promise<number> {
  const all = await listImages();
  return all.filter((i) => i.ean === ean && i.status !== "done").length;
}
