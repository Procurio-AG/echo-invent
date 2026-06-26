-- The product-images bucket is now PRIVATE: images are served via short-lived
-- signed URLs and exported by streaming bytes into a zip server-side, so a stored
-- public URL is no longer needed. No image rows exist yet, so this is a clean drop.
ALTER TABLE "ProductImage" DROP COLUMN "url";
