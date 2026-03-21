import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";

import type { OverviewResponse } from "../../api/client";
import { formatUsd } from "../../lib/format";

interface WasteByCategoryProps {
  data: OverviewResponse["topWasteCategories"];
}

export function WasteByCategory({ data }: WasteByCategoryProps) {
  const styles =
    typeof window === "undefined" ? null : window.getComputedStyle(document.documentElement);
  const tooltipBackground = styles?.getPropertyValue("--chart-tooltip-bg").trim() || "#11131b";
  const tooltipBorder =
    styles?.getPropertyValue("--chart-tooltip-border").trim() || "rgba(255,255,255,0.08)";
  const colors = [
    styles?.getPropertyValue("--chart-series-waste").trim() || "#ef4444",
    styles?.getPropertyValue("--accent-yellow").trim() || "#eab308",
    styles?.getPropertyValue("--chart-series-cost").trim() || "#3b82f6",
    styles?.getPropertyValue("--accent-green").trim() || "#22c55e",
    styles?.getPropertyValue("--accent-purple").trim() || "#a855f7",
  ];
  const defaultColor = colors[0] ?? "#ef4444";

  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center rounded-2xl border border-dashed border-white/10 text-sm text-slate-500">
        No waste findings yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_220px]">
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="totalWasted"
              nameKey="category"
              innerRadius={68}
              outerRadius={96}
              paddingAngle={4}
            >
              {data.map((entry, index) => (
                <Cell key={entry.category} fill={colors[index % colors.length] ?? defaultColor} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                background: tooltipBackground,
                border: `1px solid ${tooltipBorder}`,
                borderRadius: "16px",
              }}
              formatter={(value) => formatUsd(Number(value ?? 0))}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-col gap-3">
        {data.map((entry, index) => (
          <div key={entry.category} className="rounded-2xl border border-white/8 bg-black/10 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
              <span
                className="inline-flex h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: colors[index % colors.length] ?? defaultColor }}
              />
              {entry.category}
            </div>
            <div className="mt-2 text-lg font-semibold text-slate-50">
              {formatUsd(entry.totalWasted)}
            </div>
            <div className="mt-1 text-xs text-slate-500">{entry.count} traces affected</div>
          </div>
        ))}
      </div>
    </div>
  );
}
