"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { ScannerFrame } from "@/app/components/ScannerFrame";
import { ProductForm, type Product } from "@/app/components/ProductForm";
import { PreviousAuditBanner } from "@/app/components/PreviousAuditBanner";

type AuditEntry = {
  audited_at: string;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
};

type SessionState =
  | { kind: "loading" }
  | { kind: "no-active" }
  | { kind: "active"; sessionId: string };

type Loaded = { product: Product; previousAudit: AuditEntry | null };

export default function MobileScannerPage() {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [looking, setLooking] = useState(false);
  const [manualEan, setManualEan] = useState("");

  const refetchSession = useCallback(async () => {
    try {
      const res = await fetch("/api/session/active", { cache: "no-store" });
      const data = await res.json();
      setSession(
        data.session
          ? { kind: "active", sessionId: data.session.id }
          : { kind: "no-active" }
      );
    } catch {
      setSession({ kind: "no-active" });
    }
  }, []);

  useEffect(() => {
    refetchSession();
  }, [refetchSession]);

  const handleScan = useCallback(
    async (raw: string) => {
      const ean = raw.trim();
      if (!ean || looking || loaded) return;
      setLooking(true);
      try {
        const res = await fetch(`/api/product/${encodeURIComponent(ean)}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.status === 404 && data.code === "NOT_FOUND") {
          await fetch("/api/exception", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ barcode: ean }),
          });
          toast(
            `Unknown barcode ${ean} — logged to exceptions`,
            {
              icon: "⚠",
              duration: 3000,
              style: {
                background: "#3b2f12",
                color: "#fde68a",
                border: "1px solid #b45309",
              },
            }
          );
          return;
        }
        if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
          toast.error("No active audit.");
          setSession({ kind: "no-active" });
          return;
        }
        if (!res.ok) {
          toast.error(data.error ?? "Lookup failed.");
          return;
        }
        setLoaded({ product: data.product, previousAudit: data.previousAudit });
      } catch {
        toast.error("Network error.");
      } finally {
        setLooking(false);
      }
    },
    [looking, loaded]
  );

  const handleSaved = useCallback(() => {
    setLoaded(null);
  }, []);

  const handleCancel = useCallback(() => {
    setLoaded(null);
  }, []);

  const handleManualSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!manualEan.trim()) return;
    handleScan(manualEan);
    setManualEan("");
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          Mobile Scanner
        </p>
        <h1 className="font-serif text-3xl tracking-tight">Aisle walk</h1>
      </header>

      {session.kind === "loading" && (
        <p className="text-sm text-muted">Loading…</p>
      )}

      {session.kind === "no-active" && (
        <div className="rounded-lg border border-border bg-surface p-5">
          <p className="text-sm font-medium">No active audit</p>
          <p className="mt-1 text-xs text-muted">
            Upload a sheet on the dashboard to start a session.
          </p>
        </div>
      )}

      {session.kind === "active" && (
        <>
          <ScannerFrame
            paused={!!loaded}
            onScan={handleScan}
            onError={(m) => toast.error(`Camera: ${m}`)}
          />

          <form
            onSubmit={handleManualSubmit}
            className="flex gap-2"
            aria-label="Manual EAN entry"
          >
            <input
              type="text"
              inputMode="numeric"
              value={manualEan}
              onChange={(e) => setManualEan(e.target.value)}
              placeholder="Type EAN to test without camera"
              className="flex-1 rounded-md border border-border bg-bg px-3 py-2 font-mono text-xs text-text placeholder:text-muted/60 focus:border-text/60 focus:outline-none"
              disabled={looking || !!loaded}
            />
            <button
              type="submit"
              disabled={looking || !!loaded || !manualEan.trim()}
              className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-text hover:bg-border disabled:opacity-50"
            >
              Look up
            </button>
          </form>

          {looking && <p className="text-xs text-muted">Looking up…</p>}

          {loaded && (
            <div className="space-y-3">
              {loaded.previousAudit && (
                <PreviousAuditBanner audit={loaded.previousAudit} />
              )}
              <ProductForm
                product={loaded.product}
                onSaved={handleSaved}
                onCancel={handleCancel}
                variant="mobile"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
