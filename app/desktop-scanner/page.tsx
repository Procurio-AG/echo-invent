"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "react-hot-toast";
import {
  HiddenScanInput,
  type HiddenScanInputHandle,
} from "@/app/components/HiddenScanInput";
import {
  ProductForm,
  type Product,
  type ProductFormHandle,
} from "@/app/components/ProductForm";
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

type Loaded =
  | { kind: "edit"; product: Product; previousAudit: AuditEntry | null }
  | { kind: "create"; ean: string };

export default function DesktopScannerPage() {
  const [session, setSession] = useState<SessionState>({ kind: "loading" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [looking, setLooking] = useState(false);
  const scanInputRef = useRef<HiddenScanInputHandle>(null);
  const formRef = useRef<ProductFormHandle>(null);

  useEffect(() => {
    (async () => {
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
    })();
  }, []);

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
          setLoaded({ kind: "create", ean });
          toast(`New barcode ${ean} — fill in details`, {
            icon: "✚",
            duration: 2500,
            style: {
              background: "#3b2f12",
              color: "#fde68a",
              border: "1px solid #b45309",
            },
          });
          setTimeout(() => formRef.current?.focusFirstField(), 0);
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
        setLoaded({
          kind: "edit",
          product: data.product,
          previousAudit: data.previousAudit,
        });
        setTimeout(() => formRef.current?.focusFirstField(), 0);
      } catch {
        toast.error("Network error.");
      } finally {
        setLooking(false);
      }
    },
    [looking, loaded]
  );

  const returnFocusToScanner = useCallback(() => {
    setLoaded(null);
    setTimeout(() => scanInputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        returnFocusToScanner();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loaded, returnFocusToScanner]);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-[0.2em] text-muted">
          Desktop Scanner
        </p>
        <h1 className="font-serif text-3xl tracking-tight">Back-office</h1>
        <p className="max-w-xl text-sm text-muted">
          Scan with a USB barcode reader. The cursor stays armed; after each
          save it returns here automatically. Press{" "}
          <kbd className="rounded border border-border bg-bg px-1 text-[10px]">
            Esc
          </kbd>{" "}
          to cancel an open form.
        </p>
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
          <HiddenScanInput
            ref={scanInputRef}
            released={!!loaded}
            onScan={handleScan}
          />

          {looking && <p className="text-xs text-muted">Looking up…</p>}

          {loaded && loaded.kind === "edit" && (
            <div className="space-y-3">
              {loaded.previousAudit && (
                <PreviousAuditBanner audit={loaded.previousAudit} />
              )}
              <ProductForm
                ref={formRef}
                product={loaded.product}
                onSaved={returnFocusToScanner}
                onCancel={returnFocusToScanner}
                variant="desktop"
              />
            </div>
          )}

          {loaded && loaded.kind === "create" && (
            <ProductForm
              ref={formRef}
              mode="create"
              ean={loaded.ean}
              onSaved={returnFocusToScanner}
              onCancel={returnFocusToScanner}
              variant="desktop"
            />
          )}
        </>
      )}
    </div>
  );
}
