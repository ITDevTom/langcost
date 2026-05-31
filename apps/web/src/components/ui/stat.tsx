import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/cn";

const statValue = cva("mt-0.5 text-lg font-semibold tabular-nums", {
  variants: {
    tone: {
      default: "text-[var(--text-primary)]",
      accent: "text-[var(--accent-orange)]",
      error: "text-[var(--accent-red)]",
      ok: "text-[var(--accent-green)]",
    },
  },
  defaultVariants: { tone: "default" },
});

interface StatProps extends VariantProps<typeof statValue> {
  label: string;
  value: string;
  className?: string;
}

/** Compact KPI tile (cost / waste / tokens …). */
export function Stat({ label, value, tone, className }: StatProps) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] px-3.5 py-2.5",
        className,
      )}
    >
      <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
      <div className={statValue({ tone })}>{value}</div>
    </div>
  );
}
