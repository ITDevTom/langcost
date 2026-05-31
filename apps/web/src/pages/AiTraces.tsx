import { useEffect, useMemo, useState } from "react";

import { getTraces, type TraceSummary } from "../api/client";
import { TraceDetailContent } from "../components/trace/TraceDetailContent";
import { Badge } from "../components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { ScrollArea } from "../components/ui/scroll-area";
import { formatCompactInt, formatRelativeTime, formatUsd, traceLabel } from "../lib/format";

interface AiTracesProps {
  refreshToken: number;
  source?: string | undefined;
  // Driven by the URL (/traces/:id) so selection is deep-linkable; falls back to the first trace.
  selectedTraceId?: string | undefined;
  onSelect: (traceId: string) => void;
}

const PAGE_SIZE = 100;

type Status = TraceSummary["status"];

// A session = many traces (turns) sharing a sessionKey; a singleton trace renders on its own.
type Group =
  | { kind: "single"; trace: TraceSummary }
  | { kind: "session"; sessionKey: string; traces: TraceSummary[] };

// Worst-wins status rollup for a session (error > partial > complete).
function rollupStatus(traces: TraceSummary[]): Status {
  if (traces.some((t) => t.status === "error")) return "error";
  if (traces.some((t) => t.status === "partial")) return "partial";
  return "complete";
}

function statusDot(status: Status): string {
  if (status === "error") return "bg-red-400";
  if (status === "partial") return "bg-amber-400";
  return "bg-emerald-400";
}

// AI-agents trace explorer: master list on the left (turns grouped under their session), detail in a
// right pane. Selecting a trace updates the URL; the right pane fetches that trace.
export function AiTraces({ refreshToken, source, selectedTraceId, onSelect }: AiTracesProps) {
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSessions, setOpenSessions] = useState<Set<string>>(new Set());

  useEffect(() => {
    void refreshToken;
    let active = true;

    void (async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await getTraces({
          limit: PAGE_SIZE,
          sort: "date_desc",
          ...(source ? { source } : {}),
        });
        if (!active) return;
        setTraces(response.traces);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Failed to load traces.");
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [refreshToken, source]);

  const selected = selectedTraceId ?? traces[0]?.id;

  // Group turns under their session, preserving the date_desc order by first appearance.
  const groups = useMemo<Group[]>(() => {
    const order: string[] = [];
    const bucket = new Map<string, TraceSummary[]>();
    for (const trace of traces) {
      const key = trace.sessionKey ?? `__single__:${trace.id}`;
      const list = bucket.get(key);
      if (list) {
        list.push(trace);
      } else {
        bucket.set(key, [trace]);
        order.push(key);
      }
    }
    return order.map((key) => {
      const list = bucket.get(key) ?? [];
      return list.length > 1
        ? { kind: "session", sessionKey: key, traces: list }
        : { kind: "single", trace: list[0] as TraceSummary };
    });
  }, [traces]);

  // Auto-expand the session that contains the selected trace.
  useEffect(() => {
    const sessionKey = traces.find((t) => t.id === selected)?.sessionKey;
    if (!sessionKey) return;
    setOpenSessions((prev) => (prev.has(sessionKey) ? prev : new Set(prev).add(sessionKey)));
  }, [selected, traces]);

  function toggleSession(key: string): void {
    setOpenSessions((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1480px]">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(300px,360px)_1fr]">
        <aside className="lg:sticky lg:top-[84px]">
          <h1 className="mb-3 text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
            Traces
            <span className="ml-2 text-sm font-normal" style={{ color: "var(--text-muted)" }}>
              ({traces.length})
            </span>
          </h1>

          <ScrollArea className="lg:h-[calc(100vh-148px)] lg:pr-2">
            {loading ? (
              <div className="panel p-6 text-sm text-slate-400">Loading traces…</div>
            ) : error ? (
              <div className="panel p-6 text-sm text-red-300">{error}</div>
            ) : traces.length === 0 ? (
              <div className="panel p-6 text-sm text-slate-500">No traces yet.</div>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {groups.map((group) =>
                  group.kind === "single" ? (
                    <li key={group.trace.id}>
                      <TraceListItem
                        trace={group.trace}
                        active={group.trace.id === selected}
                        onClick={() => onSelect(group.trace.id)}
                      />
                    </li>
                  ) : (
                    <li key={group.sessionKey}>
                      <SessionGroup
                        sessionKey={group.sessionKey}
                        traces={group.traces}
                        selected={selected}
                        open={openSessions.has(group.sessionKey)}
                        onToggle={() => toggleSession(group.sessionKey)}
                        onSelect={onSelect}
                      />
                    </li>
                  ),
                )}
              </ul>
            )}
          </ScrollArea>
        </aside>

        <section className="min-w-0">
          {selected ? (
            <TraceDetailContent traceId={selected} refreshToken={refreshToken} />
          ) : (
            <div className="panel p-8 text-sm text-slate-500">
              Select a trace to see its details.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SessionGroup({
  sessionKey,
  traces,
  selected,
  open,
  onToggle,
  onSelect,
}: {
  sessionKey: string;
  traces: TraceSummary[];
  selected: string | undefined;
  open: boolean;
  onToggle: () => void;
  onSelect: (traceId: string) => void;
}) {
  const totalCost = traces.reduce((sum, t) => sum + t.totalCostUsd, 0);
  const totalTokens = traces.reduce((sum, t) => sum + t.totalInputTokens + t.totalOutputTokens, 0);
  const totalFaults = traces.reduce((sum, t) => sum + t.faultCount, 0);
  const status = rollupStatus(traces);
  const containsSelected = traces.some((t) => t.id === selected);

  return (
    <Collapsible open={open} onOpenChange={onToggle}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className={`w-full rounded-2xl border px-3.5 py-3 text-left transition ${
            containsSelected && !open
              ? "trace-list-item trace-list-item--active"
              : "trace-list-item"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="w-3 shrink-0 text-slate-500">{open ? "▾" : "▸"}</span>
              <span className={`inline-flex h-2 w-2 shrink-0 rounded-full ${statusDot(status)}`} />
              <span
                className="truncate text-sm font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                {sessionKey}
              </span>
            </span>
            <span
              className="shrink-0 text-sm tabular-nums"
              style={{ color: "var(--text-secondary)" }}
            >
              {formatUsd(totalCost)}
            </span>
          </div>
          <div
            className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-5 text-xs"
            style={{ color: "var(--text-muted)" }}
          >
            <Badge tone="accent">{traces.length} turns</Badge>
            <span>{formatCompactInt(totalTokens)} tok</span>
            {totalFaults > 0 ? (
              <span style={{ color: "var(--accent-red)" }}>⚠ {totalFaults}</span>
            ) : null}
            <span aria-hidden>·</span>
            <span>{formatRelativeTime(traces[0]?.startedAt)}</span>
          </div>
        </button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <ul className="mt-1.5 ml-3 flex flex-col gap-1.5 border-l border-[color:var(--border)] pl-2">
          {traces.map((trace) => (
            <li key={trace.id}>
              <TraceListItem
                trace={trace}
                active={trace.id === selected}
                showSession={false}
                onClick={() => onSelect(trace.id)}
              />
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TraceListItem({
  trace,
  active,
  showSession = true,
  onClick,
}: {
  trace: TraceSummary;
  active: boolean;
  showSession?: boolean;
  onClick: () => void;
}) {
  const tokens = trace.totalInputTokens + trace.totalOutputTokens;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-2xl border px-3.5 py-3 text-left transition ${
        active ? "trace-list-item trace-list-item--active" : "trace-list-item"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex h-2 w-2 shrink-0 rounded-full ${statusDot(trace.status)}`}
          />
          <span className="truncate text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            {traceLabel(trace.externalId, trace.id)}
          </span>
        </span>
        <span className="shrink-0 text-sm tabular-nums" style={{ color: "var(--text-secondary)" }}>
          {formatUsd(trace.totalCostUsd)}
        </span>
      </div>

      <div
        className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs"
        style={{ color: "var(--text-muted)" }}
      >
        <span className="max-w-[140px] truncate">{trace.model ?? "—"}</span>
        <span aria-hidden>·</span>
        <span>{formatCompactInt(tokens)} tok</span>
        <span aria-hidden>·</span>
        <span>{trace.spanCount} spans</span>
        {trace.wasteUsd > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span className="text-red-300">{formatUsd(trace.wasteUsd)} waste</span>
          </>
        ) : null}
        {trace.faultCount > 0 ? (
          <>
            <span aria-hidden>·</span>
            <span style={{ color: "var(--accent-red)" }}>
              ⚠ {trace.faultCount} fault{trace.faultCount === 1 ? "" : "s"}
            </span>
          </>
        ) : null}
      </div>

      <div className="mt-1 truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
        {showSession && trace.sessionKey ? (
          <span className="mr-2">⛓ {trace.sessionKey}</span>
        ) : null}
        {formatRelativeTime(trace.startedAt)}
      </div>
    </button>
  );
}
