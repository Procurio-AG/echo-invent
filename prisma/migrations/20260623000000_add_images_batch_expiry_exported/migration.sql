-- AlterTable: optional batch / expiry / export-tracking columns
ALTER TABLE "Product" ADD COLUMN     "batch" TEXT DEFAULT 'open',
ADD COLUMN     "expiry_date" DATE,
ADD COLUMN     "exported_at" TIMESTAMP(3);

-- Backfill existing rows so the worklist/export sees a uniform default. A column
-- DEFAULT only applies to rows inserted after this migration, not historical ones.
UPDATE "Product" SET "batch" = 'open' WHERE "batch" IS NULL;

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_session_id_exported_at_idx" ON "Product"("session_id", "exported_at");

-- CreateIndex
CREATE INDEX "ProductImage_product_id_idx" ON "ProductImage"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_product_id_position_key" ON "ProductImage"("product_id", "position");

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
