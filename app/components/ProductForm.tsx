"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { toast } from "react-hot-toast";

export type Product = {
  id: string;
  session_id: string;
  ean: string;
  name: string;
  category: string | null;
  purchase_price: number | null;
  selling_price: number | null;
  mrp: number | null;
  status: string;
  version: number;
  original_data?: Record<string, unknown> | null;
};

export type CategoryGroup = { parent: string; subcategories: string[] };

type EditProps = {
  mode?: "edit";
  product: Product;
  onSaved: (updated: Product) => void;
  onCancel?: () => void;
  variant?: "mobile" | "desktop";
};

type CreateProps = {
  mode: "create";
  ean: string;
  onSaved: (created: Product) => void;
  onCancel?: () => void;
  variant?: "mobile" | "desktop";
};

type Props = EditProps | CreateProps;

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

// price = MRP × (1 − discount%) ; discount% = (1 − price / MRP) × 100
function priceFromDiscount(mrpNum: number, discNum: number): number {
  return round2(mrpNum * (1 - discNum / 100));
}

function discountFromPrice(mrpNum: number, priceNum: number): number {
  return round2((1 - priceNum / mrpNum) * 100);
}

// Initial discount-box value derived from an existing price + MRP.
function discountStr(price: number | null, mrp: number | null): string {
  if (price === null || mrp === null || mrp === 0) return "";
  return String(discountFromPrice(mrp, price));
}

export const ProductForm = forwardRef<ProductFormHandle, Props>(function ProductForm(
  props,
  ref
) {
  const isCreate = props.mode === "create";
  const variant = props.variant ?? "mobile";

  const initialName = isCreate ? "" : props.product.name;
  const initialCategory = isCreate ? "" : props.product.category ?? "";
  const initialPp = isCreate ? "" : fieldStr(props.product.purchase_price);
  const initialMrp = isCreate ? "" : fieldStr(props.product.mrp);
  const initialSp = isCreate ? "" : fieldStr(props.product.selling_price);
  const initialPpDisc = isCreate
    ? ""
    : discountStr(props.product.purchase_price, props.product.mrp);
  const initialSpDisc = isCreate
    ? ""
    : discountStr(props.product.selling_price, props.product.mrp);

  const [name, setName] = useState<string>(initialName);
  const [category, setCategory] = useState<string>(initialCategory);
  const [pp, setPp] = useState<string>(initialPp);
  const [mrp, setMrp] = useState<string>(initialMrp);
  const [sp, setSp] = useState<string>(initialSp);
  const [ppDisc, setPpDisc] = useState<string>(initialPpDisc);
  const [spDisc, setSpDisc] = useState<string>(initialSpDisc);
  const [saving, setSaving] = useState(false);
  const [locked, setLocked] = useState(false);

  const [groups, setGroups] = useState<CategoryGroup[] | null>(null);
  const [parentFilter, setParentFilter] = useState<string>("");

  const nameRef = useRef<HTMLInputElement>(null);
  const ppRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focusFirstField: () => {
      if (isCreate) nameRef.current?.focus();
      else ppRef.current?.focus();
    },
  }));

  // Load category options once.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/categories", { cache: "force-cache" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setGroups(d.groups ?? []);
      })
      .catch(() => {
        if (!cancelled) setGroups([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When editing, derive the parent filter from the current category so its parent dropdown matches.
  useEffect(() => {
    if (!groups || !category) return;
    const group = groups.find((g) => g.subcategories.includes(category));
    if (group && !parentFilter) setParentFilter(group.parent);
  }, [groups, category, parentFilter]);

  // Reset when product changes (new scan, edit mode only).
  const resetKey = isCreate
    ? `create:${props.ean}`
    : `edit:${props.product.id}:${props.product.version}`;
  useEffect(() => {
    setName(initialName);
    setCategory(initialCategory);
    setPp(initialPp);
    setMrp(initialMrp);
    setSp(initialSp);
    setPpDisc(initialPpDisc);
    setSpDisc(initialSpDisc);
    setLocked(false);
    if (!initialCategory) setParentFilter("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // ── MRP-discount calculator ───────────────────────────────────────────────
  // Purchase/selling price and their "% off MRP" boxes stay in sync: editing a
  // discount recomputes its price, editing a price back-fills its discount, and
  // changing MRP re-derives both prices from the current discounts. Typing in a
  // price box always overwrites the calculated value.
  const handleMrpChange = (next: string) => {
    setMrp(next);
    const mrpNum = toNumOrNull(next);
    if (!mrpNum) return;
    const pd = toNumOrNull(ppDisc);
    if (pd !== null) setPp(String(priceFromDiscount(mrpNum, pd)));
    const sd = toNumOrNull(spDisc);
    if (sd !== null) setSp(String(priceFromDiscount(mrpNum, sd)));
  };

  const handlePriceChange = (
    next: string,
    setPrice: (s: string) => void,
    setDisc: (s: string) => void
  ) => {
    setPrice(next);
    const mrpNum = toNumOrNull(mrp);
    const priceNum = toNumOrNull(next);
    if (next.trim() === "") setDisc("");
    else if (mrpNum && priceNum !== null) setDisc(String(discountFromPrice(mrpNum, priceNum)));
  };

  const handleDiscChange = (
    next: string,
    setDisc: (s: string) => void,
    setPrice: (s: string) => void
  ) => {
    setDisc(next);
    const mrpNum = toNumOrNull(mrp);
    const discNum = toNumOrNull(next);
    if (mrpNum && discNum !== null) setPrice(String(priceFromDiscount(mrpNum, discNum)));
  };

  const handleParentChange = (next: string) => {
    setParentFilter(next);
    if (category) {
      const stillValid =
        next === "" ||
        (groups?.find((g) => g.parent === next)?.subcategories.includes(category) ?? false);
      if (!stillValid) setCategory("");
    }
  };

  const handleSave = async () => {
    if (locked || saving) return;
    const trimmedName = name.trim();
    if (isCreate && !trimmedName) {
      toast.error("Name is required.");
      return;
    }
    setSaving(true);
    const toastId = toast.loading("Saving…");
    try {
      const payload = {
        ean: isCreate ? props.ean : props.product.ean,
        name: trimmedName,
        category: category || null,
        purchase_price: toNumOrNull(pp),
        mrp: toNumOrNull(mrp),
        selling_price: toNumOrNull(sp),
      };
      const endpoint = isCreate ? "/api/product/create" : "/api/product/update";
      const body = isCreate ? payload : { ...payload, version: props.product.version };

      const res = await fetch(endpoint, {
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
      if (res.status === 409 && data.code === "ALREADY_EXISTS") {
        toast.error("This EAN already exists in the session.", { id: toastId });
        return;
      }
      if (!res.ok) {
        toast.error(data.error ?? "Save failed.", { id: toastId });
        return;
      }
      toast.success(
        isCreate
          ? `Added · MRP ${data.product.mrp ?? "—"}`
          : `Saved · MRP ${data.product.mrp ?? "—"}`,
        { id: toastId, duration: 1500 }
      );
      props.onSaved(data.product as Product);
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

  const ean = isCreate ? props.ean : props.product.ean;
  const headerRight = isCreate ? (
    <span className="text-[10px] uppercase tracking-wider text-yellow-300">
      new · not in sheet
    </span>
  ) : (
    <span
      className={
        "text-[10px] uppercase tracking-wider " +
        (props.product.status === "updated" ? "text-yellow-300" : "text-muted")
      }
    >
      {props.product.status} · v{props.product.version}
    </span>
  );

  const subcategoryOptions =
    groups === null
      ? []
      : parentFilter === ""
      ? groups
      : groups.filter((g) => g.parent === parentFilter);

  return (
    <div className="rounded-lg border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-muted">{ean}</p>
          {!isCreate && <p className="mt-1 truncate font-medium text-text">{props.product.name}</p>}
        </div>
        {headerRight}
      </div>

      <div className="mt-5 grid gap-4">
        <label className="space-y-1">
          <span className={labelClass}>Name {isCreate && <span className="text-yellow-300">*</span>}</span>
          <input
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={locked}
            className={inputClass}
            placeholder="Product name"
          />
        </label>

        <div className={"grid gap-3 " + (big ? "" : "sm:grid-cols-2")}>
          <label className="space-y-1">
            <span className={labelClass}>Parent category</span>
            <select
              value={parentFilter}
              onChange={(e) => handleParentChange(e.target.value)}
              disabled={locked || groups === null}
              className={inputClass}
            >
              <option value="">All</option>
              {(groups ?? []).map((g) => (
                <option key={g.parent} value={g.parent}>
                  {g.parent}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className={labelClass}>Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={locked || groups === null}
              className={inputClass}
            >
              <option value="">—</option>
              {subcategoryOptions.map((g) => (
                <optgroup key={g.parent} label={g.parent}>
                  {g.subcategories.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>

        <label className="space-y-1">
          <span className={labelClass}>MRP</span>
          <input
            type="text"
            inputMode="decimal"
            value={mrp}
            onChange={(e) => handleMrpChange(e.target.value)}
            disabled={locked}
            className={inputClass}
            placeholder="—"
          />
        </label>

        <div className="space-y-1">
          <span className={labelClass}>Purchase price</span>
          <div className="flex gap-2">
            <div className="relative w-28 shrink-0">
              <input
                type="text"
                inputMode="decimal"
                value={ppDisc}
                onChange={(e) => handleDiscChange(e.target.value, setPpDisc, setPp)}
                disabled={locked}
                className={inputClass + " pr-7 text-right"}
                placeholder="0"
                aria-label="Purchase discount percent off MRP"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">
                %
              </span>
            </div>
            <input
              ref={ppRef}
              type="text"
              inputMode="decimal"
              value={pp}
              onChange={(e) => handlePriceChange(e.target.value, setPp, setPpDisc)}
              disabled={locked}
              className={inputClass + " flex-1"}
              placeholder="price"
              aria-label="Purchase price"
            />
          </div>
          <span className="block text-[10px] text-muted/70">
            % off MRP fills the price — or type the price directly
          </span>
        </div>

        <div className="space-y-1">
          <span className={labelClass}>Selling price</span>
          <div className="flex gap-2">
            <div className="relative w-28 shrink-0">
              <input
                type="text"
                inputMode="decimal"
                value={spDisc}
                onChange={(e) => handleDiscChange(e.target.value, setSpDisc, setSp)}
                disabled={locked}
                className={inputClass + " pr-7 text-right"}
                placeholder="0"
                aria-label="Selling discount percent off MRP"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">
                %
              </span>
            </div>
            <input
              type="text"
              inputMode="decimal"
              value={sp}
              onChange={(e) => handlePriceChange(e.target.value, setSp, setSpDisc)}
              disabled={locked}
              className={inputClass + " flex-1"}
              placeholder="price"
              aria-label="Selling price"
            />
          </div>
          <span className="block text-[10px] text-muted/70">
            % off MRP fills the price — or type the price directly
          </span>
        </div>
      </div>

      <div className={"mt-5 flex gap-3 " + (big ? "" : "justify-end")}>
        {props.onCancel && (
          <button
            type="button"
            onClick={props.onCancel}
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
          {locked
            ? "Reload required"
            : saving
            ? "Saving…"
            : isCreate
            ? "Add to audit"
            : "Save"}
        </button>
      </div>
    </div>
  );
});
