import type { TraceSummary } from "../../api/client";
import { formatCompactInt, formatUsd, traceLabel } from "../../lib/format";

interface ModelTokens {
  model: string;
  tokens: number;
}

interface SessionRowProps {
  trace: TraceSummary;
  expanded: boolean;
  onToggle: () => void;
  showProject?: boolean;
  project?: string | undefined;
  showCost?: boolean;
  showCache?: boolean;
  cacheCost?: number;
  showWaste?: boolean;
  modelBreakdown?: ModelTokens[];
}

function shortModelName(model: string): string {
  return model
    .replace("claude-", "")
    .replace(/-20\d+/g, "")
    .replace("-4-5", "4.5")
    .replace("-4-6", "4.6");
}

const MODEL_COLORS = {
  opus: "#ff6b00",
  sonnet: "#3b82f6",
  haiku: "#10b981",
} as const;

function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return MODEL_COLORS.opus;
  if (lower.includes("sonnet")) return MODEL_COLORS.sonnet;
  if (lower.includes("haiku")) return MODEL_COLORS.haiku;
  return "#6b7280";
}

export function SessionRow({
  trace,
  expanded,
  onToggle,
  showProject,
  project,
  showCost,
  showCache,
  cacheCost,
  showWaste,
  modelBreakdown,
}: SessionRowProps) {
  return (
    <tr
      onClick={onToggle}
      className="panel-hover cursor-pointer border-b border-[color:var(--border)] text-left transition-colors last:border-b-0"
    >
      <td className="px-4 py-2.5 align-middle">
        <span
          className="inline-flex h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: trace.wasteUsd > 0 ? "#f97316" : "#22c55e" }}
          title={trace.wasteUsd > 0 ? "Has savings potential" : "Optimized"}
        />
      </td>
      {showProject ? (
        <td className="px-4 py-2.5 align-middle">
          <span className="text-sm font-medium" style={{ color: "var(--accent-orange, #ff6b00)" }}>
            {project ?? "—"}
          </span>
        </td>
      ) : null}
      <td className="px-4 py-2.5 align-middle">
        <div className="flex min-w-0 items-center gap-2 truncate font-medium text-slate-100">
          <span className="text-slate-500">{expanded ? "▾" : "▸"}</span>
          {traceLabel(trace.externalId, trace.id)}
        </div>
      </td>
      <td className="px-4 py-2.5 text-sm align-middle">
        {modelBreakdown && modelBreakdown.length > 0 ? (
          (() => {
            const total = modelBreakdown.reduce((sum, m) => sum + m.tokens, 0);
            if (total === 0) return <span className="text-slate-500">—</span>;
            const tooltip = modelBreakdown
              .map((m) => `${shortModelName(m.model)}: ${formatCompactInt(m.tokens)}`)
              .join("\n");
            return (
              <div title={tooltip}>
                <div
                  className="flex h-2.5 w-full overflow-hidden rounded-full"
                  style={{ background: "var(--surface-alt)", minWidth: "80px" }}
                >
                  {modelBreakdown.map((m) => {
                    const pct = (m.tokens / total) * 100;
                    if (pct < 1) return null;
                    return (
                      <div
                        key={m.model}
                        style={{
                          width: `${pct}%`,
                          backgroundColor: getModelColor(m.model),
                        }}
                      />
                    );
                  })}
                </div>
                <div className="flex gap-2 mt-1">
                  {modelBreakdown
                    .filter((m) => m.tokens > 0)
                    .map((m) => (
                      <span
                        key={m.model}
                        className="flex items-center gap-1 text-[10px] text-slate-400"
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: getModelColor(m.model) }}
                        />
                        {shortModelName(m.model)}
                      </span>
                    ))}
                </div>
              </div>
            );
          })()
        ) : (
          <span className="text-slate-300 truncate">
            {trace.model ? shortModelName(trace.model) : "unknown"}
          </span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right text-sm text-slate-400 align-middle">
        {formatCompactInt(trace.spanCount)}
      </td>
      <td className="px-4 py-2.5 text-right text-sm text-slate-300 align-middle">
        {formatCompactInt(trace.totalInputTokens)}
      </td>
      <td className="px-4 py-2.5 text-right text-sm text-slate-300 align-middle">
        {formatCompactInt(trace.totalOutputTokens)}
      </td>
      {showCost ? (
        <td className="px-4 py-2.5 text-right text-sm font-medium text-slate-100 align-middle">
          {formatUsd(trace.totalCostUsd)}
        </td>
      ) : null}
      {showCache ? (
        <td
          className="px-4 py-2.5 text-right text-sm align-middle"
          style={{ color: "var(--text-muted)" }}
        >
          {cacheCost && cacheCost > 0.01 ? formatUsd(cacheCost) : "—"}
        </td>
      ) : null}
      {showWaste ? (
        <td
          className={`px-4 py-2.5 text-right text-sm font-medium align-middle ${
            trace.wasteUsd > 0 ? "text-red-300" : "text-slate-500"
          }`}
        >
          {trace.wasteUsd > 0 ? formatUsd(trace.wasteUsd) : "—"}
        </td>
      ) : null}
    </tr>
  );
}
