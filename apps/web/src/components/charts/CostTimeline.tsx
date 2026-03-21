import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { OverviewResponse } from "../../api/client";
import { formatUsd } from "../../lib/format";

interface CostTimelineProps {
  data: OverviewResponse["costByDay"];
}

export function CostTimeline({ data }: CostTimelineProps) {
  const styles =
    typeof window === "undefined" ? null : window.getComputedStyle(document.documentElement);
  const axisColor = styles?.getPropertyValue("--chart-axis").trim() || "#9ca3af";
  const gridColor = styles?.getPropertyValue("--chart-grid").trim() || "rgba(255,255,255,0.06)";
  const tooltipBackground = styles?.getPropertyValue("--chart-tooltip-bg").trim() || "#11131b";
  const tooltipBorder =
    styles?.getPropertyValue("--chart-tooltip-border").trim() || "rgba(255,255,255,0.08)";
  const costColor = styles?.getPropertyValue("--chart-series-cost").trim() || "#3b82f6";
  const wasteColor = styles?.getPropertyValue("--chart-series-waste").trim() || "#ef4444";

  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-slate-500">
        No cost data yet.
      </div>
    );
  }

  return (
    <div className="h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid stroke={gridColor} vertical={false} />
          <XAxis dataKey="date" stroke={axisColor} tickLine={false} axisLine={false} />
          <YAxis
            stroke={axisColor}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => formatUsd(Number(value))}
          />
          <Tooltip
            contentStyle={{
              background: tooltipBackground,
              border: `1px solid ${tooltipBorder}`,
              borderRadius: "16px",
            }}
            formatter={(value, name) => [
              formatUsd(Number(value ?? 0)),
              String(name) === "costUsd" ? "Cost" : "Waste",
            ]}
          />
          <Bar dataKey="costUsd" fill={costColor} radius={[8, 8, 0, 0]} />
          <Line
            type="monotone"
            dataKey="wastedUsd"
            stroke={wasteColor}
            strokeWidth={2}
            dot={{ r: 3, fill: wasteColor }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
