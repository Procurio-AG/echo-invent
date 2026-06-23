// Server-only Supabase Storage client for product images. The SERVICE ROLE key
// bypasses RLS, so this module must NEVER be imported by a client component and
// the key must NEVER be exposed with a NEXT_PUBLIC_ prefix. Import only from
// route handlers running on the Node runtime.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "product-images";

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase storage not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)."
    );
  }
  client = createClient(url, key, { auth: { persistSession: false } });
  return client;
}

// Upload bytes to the product-images bucket. Throws on failure so the caller can
// avoid writing a DB row that points at a non-existent object.
export async function uploadProductImage(
  path: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<void> {
  const { error } = await getClient()
    .storage.from(BUCKET)
    .upload(path, body, { contentType, upsert: false });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

// Best-effort delete of a storage object. An orphaned object is harmless, so we
// surface the error to the caller but callers may choose to proceed.
export async function removeProductImage(path: string): Promise<void> {
  const { error } = await getClient().storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`Storage delete failed: ${error.message}`);
}

// Download an object's bytes — used server-side to bundle images into an export
// zip without ever exposing the private bucket.
export async function downloadProductImage(path: string): Promise<Buffer> {
  const { data, error } = await getClient().storage.from(BUCKET).download(path);
  if (error || !data) {
    throw new Error(`Storage download failed: ${error?.message ?? "no data"}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

// Short-lived signed URL for in-app display (thumbnails). The bucket is private,
// so these are generated on demand and never persisted.
export async function signProductImageUrls(
  paths: string[],
  expiresIn = 3600
): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await getClient()
    .storage.from(BUCKET)
    .createSignedUrls(paths, expiresIn);
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const entry of data) {
    if (entry.path && entry.signedUrl) out[entry.path] = entry.signedUrl;
  }
  return out;
}
