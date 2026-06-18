// IndexedDB-backed queue of recorded clips, keyed by EAN. Stores the original
// COMPRESSED blob (not decoded WAV) so the store stays ~10x smaller and survives
// reload / tab background / phone lock. Decode->trim->WAV happens at Transcribe.

export const QUEUE_MAX = 25;

const DB_NAME = "rapid-capture";
const STORE = "clips";
const DB_VERSION = 1;

export type QueuedClip = {
  ean: string;
  blob: Blob;
  mimeType: string;
  order: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "ean" });
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

export async function listClips(): Promise<QueuedClip[]> {
  const db = await openDb();
  try {
    const all = (await asPromise(tx(db, "readonly").getAll())) as QueuedClip[];
    return all.sort((a, b) => a.order - b.order);
  } finally {
    db.close();
  }
}

export async function countClips(): Promise<number> {
  const db = await openDb();
  try {
    return await asPromise(tx(db, "readonly").count());
  } finally {
    db.close();
  }
}

export async function enqueueClip(
  ean: string,
  blob: Blob,
  mimeType: string
): Promise<void> {
  const db = await openDb();
  try {
    const all = (await asPromise(tx(db, "readonly").getAll())) as QueuedClip[];
    const nextOrder =
      all.length === 0 ? 0 : Math.max(...all.map((c) => c.order)) + 1;
    const existing = all.find((c) => c.ean === ean);
    const order = existing ? existing.order : nextOrder;
    await asPromise(tx(db, "readwrite").put({ ean, blob, mimeType, order }));
  } finally {
    db.close();
  }
}

export async function removeClips(eans: string[]): Promise<void> {
  if (eans.length === 0) return;
  const db = await openDb();
  try {
    const store = tx(db, "readwrite");
    await Promise.all(eans.map((ean) => asPromise(store.delete(ean))));
  } finally {
    db.close();
  }
}
