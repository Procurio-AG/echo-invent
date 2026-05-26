"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "react-hot-toast";

export type Product = {
  id: string;
  session_id: string;
  ean: string;
  name: string;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
  status: string;
  version: number;
};

type Props = {
  product: Product;
  onSaved: (updated: Product) => void;
  onCancel?: () => void;
  /** Show large mobile-style Save button. Desktop variant uses compact. */
  variant?: "mobile" | "desktop";
};

export type ProductFormHandle = {
  focusFirstField: () => void;
};

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function toNumOrNull(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function fieldStr(n: number | null): string {
  return n === null ? "" : String(n);
}

export const ProductForm = forwardRef<ProductFormHandle, Props>(function ProductForm(
  { product, onSaved, onCancel, variant = "mobile" },
  ref
) {
  const [pp, setPp] = useState<string>(fieldStr(product.purchase_price));
  const [mrp, setMrp] = useState<string>(fieldStr(product.mrp));
  const [sp, setSp] = useState<string>(fieldStr(product.selling_price));
  const [spTouched, setSpTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);
  const ppRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusFirstField: () => ppRef.current?.focus(),
  }));

  useEffect(() => {
    // Reset when product changes (new scan).
    setPp(fieldStr(product.purchase_price));
    setMrp(fieldStr(product.mrp));
    setSp(fieldStr(product.selling_price));
    setSpTouched(false);
    setLocked(false);
  }, [product.id, product.version, product.purchase_price, product.mrp, product.selling_price]);

  // Auto-calc SP = PP × 1.10 while user hasn't manually edited SP.
  useEffect(() => {
    if (spTouched) return;
    const ppNum = toNumOrNull(pp);
    if (ppNum === null) return;
    setSp(String(round2(ppNum * 1.1)));
  }, [pp, spTouched]);

  const handleSave = async () => {
    if (locked || saving) return;
    setSaving(true);
    const toastId = toast.loading("Saving…");
    try {
      const body = {
        ean: product.ean,
        version: product.version,
        purchase_price: toNumOrNull(pp),
        mrp: toNumOrNull(mrp),
        selling_price: toNumOrNull(sp),
      };
      const res = await fetch("/api/product/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "VERSION_CONFLICT") {
        setLocked(true);
        toast.error("Another worker updated this. Reload to retry.", {
          id: toastId,
          duration: Infinity,
        });
        return;
      }
      if (res.status === 409 && data.code === "NO_ACTIVE_SESSION") {
        toast.error("No active audit.", { id: toastId });
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? "Save failed.", { id: toastId });
        return;
      }
      toast.success(
        `Saved · MRP ${data.product.mrp ?? "—"}`,
        { id: toastId, duration: 1500 }
      );
      onSaved(data.product as Product);
    } catch {
      toast.error("Network error.", { id: toastId, duration: Infinity });
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full rounded-md border border-border bg-bg px-3 py-3 font-mono text-base text-text outline-none ring-0 focus:border-text/60 disabled:opacity-50";
  const labelClass = "block text-[11px] uppercase tracking-wider text-muted";

  const big = variant === "mobile";

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between">
        <div>
          <p className="font-mono text-xs text-muted">{product.ean}</p>
          <p className="mt-1 font-medium text-text">{product.name}</p>
        </div>
        <span
          className={
            "text-[10px] uppercase tracking-wider " +
            (product.status === "updated" ? "text-yellow-300" : "text-muted")
          }
        >
          {product.status} · v{product.version}
        </span>
      </div>

      <div className={"mt-5 grid gap-4 " + (big ? "" : "sm:grid-cols-3")}>
        <label className="space-y-1">
          <span className={labelClass}>Purchase price</span>
          <input
            ref={ppRef}
            type="text"
            inputMode="decimal"
            value={pp}
            onChange={(e) => setPp(e.target.value)}
            disabled={locked}
            className={inputClass}
            placeholder="—"
          />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>MRP</span>
          <input
            type="text"
            inputMode="decimal"
            value={mrp}
            onChange={(e) => setMrp(e.target.value)}
            disabled={locked}
            className={inputClass}
            placeholder="—"
          />
        </label>
        <label className="space-y-1">
          <span className={labelClass}>
            Selling price <span className="text-muted/70">(auto +10%)</span>
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={sp}
            onChange={(e) => {
              setSpTouched(true);
              setSp(e.target.value);
            }}
            disabled={locked}
            className={inputClass}
            placeholder="—"
          />
        </label>
      </div>

      <div className={"mt-5 flex gap-3 " + (big ? "" : "justify-end")}>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md border border-border bg-bg px-4 py-3 text-xs font-medium text-text hover:bg-border disabled:opacity-50"
          >
            Cancel
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || locked}
          className={
            "rounded-md border border-border bg-text font-medium text-bg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 " +
            (big ? "h-12 flex-1 text-base" : "px-6 py-3 text-sm")
          }
        >
          {locked ? "Reload required" : saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
});
