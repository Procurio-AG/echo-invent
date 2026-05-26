-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "source_filename" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purchase_price" DOUBLE PRECISION,
    "selling_price" DOUBLE PRECISION,
    "mrp" DOUBLE PRECISION,
    "original_data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "purchase_price" DOUBLE PRECISION,
    "selling_price" DOUBLE PRECISION,
    "mrp" DOUBLE PRECISION,
    "audited_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExceptionQueue" (
    "id" TEXT NOT NULL,
    "session_id" TEXT,
    "barcode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExceptionQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_started_at_idx" ON "Session"("started_at");

-- CreateIndex
CREATE INDEX "Product_session_id_status_idx" ON "Product"("session_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_session_id_ean_key" ON "Product"("session_id", "ean");

-- CreateIndex
CREATE INDEX "AuditEntry_product_id_audited_at_idx" ON "AuditEntry"("product_id", "audited_at");

-- CreateIndex
CREATE INDEX "ExceptionQueue_session_id_created_at_idx" ON "ExceptionQueue"("session_id", "created_at");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExceptionQueue" ADD CONSTRAINT "ExceptionQueue_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enforce at-most-one-active-session at the database level.
-- Prisma can't model a partial unique index, so this is appended manually.
CREATE UNIQUE INDEX "one_active_session" ON "Session" ((true)) WHERE "closed_at" IS NULL;
