import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "../../lib/cn";

// Tone sets the text color; the `.ui-badge` base derives its border + fill from currentColor, so a
// single class themes correctly (the "accent" tone follows the product token — emerald in AI mode).
const badge = cva("ui-badge", {
  variants: {
    tone: {
      neutral: "text-[var(--text-secondary)]",
      accent: "text-[var(--accent-orange)]",
      ok: "text-[var(--accent-green)]",
      error: "text-[var(--accent-red)]",
      warn: "text-[var(--accent-yellow)]",
      info: "text-[var(--accent-purple)]",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export function Badge({ tone, className, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
