# ECHO — Inventory Audit Tool

A small web app for retail stock audits. The store gives you an Excel
sheet of every product they sell; workers walk the aisles with a phone
(or sit at a desk with a USB barcode scanner) and update purchase
price, MRP, and selling price for every item they find. At the end of
the audit you export an updated Excel sheet that matches the original
column layout.

I built this as a course project. The original problem came from
talking to a family friend who runs a small grocery chain — they audit
prices twice a year and the whole thing is paper-and-pen + somebody
typing it back into Excel later. That felt like a fun thing to fix.

## What it does

- **Dashboard** (`/`) — upload the master Excel, see how many items are
  pending vs updated in the active session, download the updated xlsx
  when you're done.
- **Mobile scanner** (`/mobile-scanner`) — opens the phone's back camera
  and decodes EAN-13 barcodes. When a known product is scanned the
  form appears with the existing prices pre-filled. If the same item
  was audited earlier in the session you get a yellow banner showing
  the previous values before you overwrite them.
- **Desktop scanner** (`/desktop-scanner`) — for back-office work with a
  USB barcode reader. There's an always-focused hidden input that
  catches the scanner's keystrokes; after a lookup, focus jumps to the
  form fields so you can Tab through Purchase → MRP → Selling Price
  and hit Enter to save without ever touching the mouse.

The selling price is auto-calculated as `purchase price × 1.10` (a
10% markup) but you can override it. Unknown barcodes get logged to
an exceptions queue so they can be added later.

## Tech stack

- **Next.js 14** (App Router, TypeScript) — pages, API routes, the
  whole frontend
- **Prisma 5** + **PostgreSQL** (hosted on Supabase) — schema,
  migrations, queries
- **Tailwind CSS** — the dark editorial look, mostly because reading
  light screens under store fluorescents is painful
- **html5-qrcode** — barcode decoding from the phone camera. Lazy-
  loaded so the initial page is small.
- **xlsx** (SheetJS) — both the import parser and the export writer
- **react-hot-toast** — all the little success/error popups

## Schema (the short version)

Four tables:

- `Session` — one audit run. Only one can be "active" (open) at a
  time; a partial unique index enforces this at the DB level.
- `Product` — one row per EAN per session. Holds current prices,
  `status` (`pending` / `updated`), a `version` counter for optimistic
  locking, and a `Json` blob of the original Excel row so the export
  can reconstruct it column-for-column.
- `AuditEntry` — every save writes a snapshot here. This is the audit
  trail; the previous-audit banner shows the latest entry.
- `ExceptionQueue` — unknown barcodes that didn't match any product.

## Concurrency

Two workers can scan the same aisle. To stop them from clobbering
each other's edits there's an optimistic-locking pattern:

1. `GET /api/product/[ean]` returns the product with a `version`
   number.
2. The save (`POST /api/product/update`) sends that version back.
3. Inside a transaction, the update is `WHERE id = ? AND version = ?`
   and bumps version by 1.
4. If the row was already updated by someone else, the `WHERE` won't
   match, the API returns `409 VERSION_CONFLICT`, and the UI shows a
   sticky red toast that locks the form.

It's a very standard pattern but it was one of the more satisfying
bits to wire end-to-end.

## Running it locally

You need Node 18+ and a Postgres database (Supabase is free; I used
their pooler).

```bash
git clone <this repo>
cd sb_invent
npm install

# Set up the database URL in .env (Supabase gives you two URLs):
# DATABASE_URL   – the transaction pooler on :6543 (runtime)
# DIRECT_URL     – the session connection on :5432 (migrations)
cp .env.example .env  # then edit it

npx prisma migrate deploy
npm run dev
```

Open <http://localhost:3000>. Upload an Excel sheet that has columns
for EAN code, item name, purchase price, MRP, and selling price (the
parser is forgiving about exact column names — it tries a few common
variations).

## Project layout

```
app/
  page.tsx                     dashboard
  mobile-scanner/page.tsx      phone view
  desktop-scanner/page.tsx     USB-scanner view
  api/
    upload/                    parses + ingests xlsx
    product/[ean]/             lookup
    product/update/            save with optimistic lock
    exception/                 unknown-barcode queue
    export/                    builds the output xlsx
    session/active/            current session + counts
    session/close/             closes the current session
  components/
    SessionPanel, UploadForm, ExportCard,
    ScannerFrame, ProductForm, PreviousAuditBanner,
    HiddenScanInput
lib/
  prisma.ts                    shared Prisma client
  xlsx-import.ts               header resolver + row parser
prisma/
  schema.prisma                models + indexes
  migrations/                  generated by prisma migrate
```

## What's not done

This was a one-semester project and there's stuff I'd want to finish
before calling it real:

- The Exceptions dashboard card is still a placeholder; the API
  exists but I never wired the UI to list them.
- No auth — workers share a device per shift, which is fine for the
  prototype but not for production.
- The mobile camera path needs a real on-device test pass; I only
  verified the API contract and the lazy-loaded bundle size from the
  CLI.
- `next` 14.2.15 has a security advisory; the bump to 14.2.34 is
  pending.

## Credits / references

- The dark editorial palette is loosely cribbed from [Linear](https://linear.app)
  and [Vercel](https://vercel.com).
- Optimistic locking write-up I leaned on:
  Martin Fowler's PoEAA chapter on Optimistic Offline Lock.
- The Zoho-format sample CSV in `refference_files/` came from the
  family friend who described the problem in the first place.
