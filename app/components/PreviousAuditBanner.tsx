type Props = {
  audit: {
    audited_at: string;
    purchase_price: number | null;
    selling_price: number | null;
    mrp: number | null;
  };
};

function fmt(n: number | null) {
  return n === null ? "—" : `₹${n}`;
}

export function PreviousAuditBanner({ audit }: Props) {
  const when = new Date(audit.audited_at).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div
      role="status"
      className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs"
    >
      <p className="font-medium text-yellow-200">Previously audited</p>
      <p className="mt-1 text-yellow-100/80">
        {when} · MRP {fmt(audit.mrp)} · SP {fmt(audit.selling_price)} · PP{" "}
        {fmt(audit.purchase_price)}
      </p>
      <p className="mt-1 text-[11px] text-yellow-100/60">
        Saving will overwrite the previous audit.
      </p>
    </div>
  );
}
