import type { TraceSummary } from "../../api/client";
import { formatCompactInt, formatUsd, statusDotClass, traceLabel } from "../../lib/format";

interface SessionRowProps {
  trace: TraceSummary;
  expanded: boolean;
  onToggle: () => void;
}

function statusLabel(status: TraceSummary["status"]): string {
  switch (status) {
    case "error":
      return "err";
    case "partial":
      return "partial";
    default:
      return "ok";
  }
}

export function SessionRow({ trace, expanded, onToggle }: SessionRowProps) {
  return (
    <tr
      onClick={onToggle}
      className="panel-hover cursor-pointer border-b border-[color:var(--border)] text-left transition-colors last:border-b-0"
    >
      <td className="px-4 py-2.5 align-middle">
        <div className="flex items-center gap-2 text-sm text-slate-300">
          <span
            className={`inline-flex h-2.5 w-2.5 rounded-full ${statusDotClass(trace.status)}`}
          />
          <span className="font-medium lowercase">{statusLabel(trace.status)}</span>
        </div>
      </td>
      <td className="px-4 py-2.5 align-middle">
        <div className="flex min-w-0 items-center gap-2 truncate font-medium text-slate-100">
          <span className="text-slate-500">{expanded ? "▾" : "▸"}</span>
          {traceLabel(trace.externalId, trace.id)}
        </div>
      </td>
      <td className="truncate px-4 py-2.5 text-sm text-slate-300 align-middle">
        {trace.model ?? "unknown"}
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
      <td className="px-4 py-2.5 text-right text-sm font-medium text-slate-100 align-middle">
        {formatUsd(trace.totalCostUsd)}
      </td>
      <td
        className={`px-4 py-2.5 text-right text-sm font-medium align-middle ${
          trace.wasteUsd > 0 ? "text-red-300" : "text-slate-500"
        }`}
      >
        {trace.wasteUsd > 0 ? formatUsd(trace.wasteUsd) : "—"}
      </td>
    </tr>
  );
}
