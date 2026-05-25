export default function DashboardPage() {
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          Dashboard
        </p>
        <h1 className="font-serif text-4xl tracking-tight">
          Inventory session
        </h1>
        <p className="max-w-xl text-sm text-muted">
          Upload the master Excel sheet to start a session. Workers can then
          scan items on mobile or desktop. When the audit is done, export the
          updated rows back to Excel.
        </p>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card title="Upload" hint="Excel → DB buffer" />
        <Card title="Export" hint="Updated rows → Excel" />
        <Card title="Exceptions" hint="Unknown barcodes" />
      </section>
    </div>
  );
}

function Card({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs text-muted">{hint}</p>
      <p className="mt-6 text-xs text-muted">Coming in Prompt 2 / 3.</p>
    </div>
  );
}
