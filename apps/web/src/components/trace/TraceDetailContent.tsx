import { useEffect, useState } from "react";

import {
  getTraceDetail,
  readClaudeCodeTokens,
  readWarpArbitrage,
  type TraceDetailResponse,
  type TraceSummary,
} from "../../api/client";
import {
  formatCategoryLabel,
  formatDateTime,
  formatInt,
  formatPercent,
  formatUsd,
  severityClasses,
  traceLabel,
} from "../../lib/format";
import { Badge, type BadgeProps } from "../ui/badge";
import { Card, CardBody, CardHeader, CardTitle } from "../ui/card";
import { Stat } from "../ui/stat";
import { TraceTree } from "./TraceTree";

function statusTone(status: TraceSummary["status"]): NonNullable<BadgeProps["tone"]> {
  if (status === "error") return "error";
  if (status === "partial") return "warn";
  return "ok";
}

function severityTone(severity: string): NonNullable<BadgeProps["tone"]> {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warn";
  return "neutral";
}

interface TraceDetailContentProps {
  traceId: string;
  refreshToken: number;
}

// The body of a trace's detail view — header, cost segments, annotations, and the span tree.
// Page chrome (back button, max-width) lives in the caller, so this renders identically as a full
// page (coding mode) or inside the AI-mode master-detail right pane.
export function TraceDetailContent({ traceId, refreshToken }: TraceDetailContentProps) {
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshToken;
    let active = true;

    void (async () => {
      setLoading(true);
      setError(null);

      try {
        const response = await getTraceDetail(traceId);

        if (!active) {
          return;
        }

        setDetail(response);
      } catch (cause) {
        if (!active) {
          return;
        }

        setError(cause instanceof Error ? cause.message : "Failed to load trace detail.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [refreshToken, traceId]);

  if (loading) {
    return <div className="panel p-8 text-sm text-slate-400">Loading trace detail...</div>;
  }

  if (error) {
    return <div className="panel p-8 text-sm text-red-300">{error}</div>;
  }

  if (!detail) {
    return <div className="panel p-8 text-sm text-slate-500">Trace not found.</div>;
  }

  const actionableReports = detail.wasteReports.filter(
    (report) => report.category !== "model_overuse",
  );
  const modelInsights = detail.wasteReports.filter((report) => report.category === "model_overuse");

  // Tolerate an older API that doesn't send faultReports (don't crash the whole detail pane).
  const faults = detail.faultReports ?? [];
  const spanLabelById = new Map(
    detail.spans.map((s) => [s.id, s.name ?? s.toolName ?? s.type] as const),
  );
  const rootCauseSpanIds = faults
    .map((f) => f.rootCauseSpanId)
    .filter((id): id is string => typeof id === "string");
  const affectedSpanIds = [...new Set(faults.flatMap((f) => f.affectedSpanIds))];

  return (
    <div className="flex w-full flex-col gap-6">
      <Card>
        <CardBody className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="section-kicker">Trace</div>
            <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em] text-[var(--text-primary)]">
              {traceLabel(detail.trace.externalId, detail.trace.id)}
            </h1>
            <div className="mt-3 flex flex-wrap gap-3 text-sm text-[var(--text-secondary)]">
              <span>Model: {detail.trace.model ?? "unknown"}</span>
              <span>Started: {formatDateTime(detail.trace.startedAt)}</span>
              <span>
                Tokens: {formatInt(detail.trace.totalInputTokens + detail.trace.totalOutputTokens)}
              </span>
            </div>

            <TraceMetaChips trace={detail.trace} />
          </div>

          <div className="flex flex-wrap items-start gap-3">
            <Stat label="Cost" value={formatUsd(detail.trace.totalCostUsd)} />
            <Stat
              label="Actionable waste"
              value={formatUsd(detail.costBreakdown.wastedCostUsd)}
              tone="error"
            />
            <div className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] px-3.5 py-2.5">
              <div className="text-[11px] text-[var(--text-muted)]">Status</div>
              <div className="mt-1.5">
                <Badge tone={statusTone(detail.trace.status)}>{detail.trace.status}</Badge>
              </div>
            </div>
          </div>
        </CardBody>
      </Card>

      <WarpArbitrageSection trace={detail.trace} />
      <ClaudeCodeTokensSection trace={detail.trace} />

      <section className="grid gap-4 lg:grid-cols-3">
        {detail.costBreakdown.segments.map((segment) => (
          <div key={segment.type} className="soft-card">
            <div className="text-sm text-slate-500">{segment.type}</div>
            <div className="mt-2 text-xl font-semibold text-slate-50">
              {formatUsd(segment.costUsd)}
            </div>
            <div className="mt-2 text-sm text-slate-400">
              {formatInt(segment.tokenCount)} tokens · {formatPercent(segment.percentOfTotal)}
            </div>
          </div>
        ))}
      </section>

      {faults.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              Faults <span className="font-normal text-[var(--text-muted)]">· {faults.length}</span>
            </CardTitle>
          </CardHeader>
          <CardBody className="space-y-3">
            {faults.map((fault) => (
              <div key={fault.id} className="soft-card">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severityTone(fault.severity)}>
                    {fault.faultType.replace(/_/g, " ")}
                  </Badge>
                  <Badge tone="neutral">{fault.severity}</Badge>
                  <Badge tone="neutral">confidence: {fault.confidence}</Badge>
                  {fault.cascadeDepth > 1 ? (
                    <span className="text-xs text-[var(--text-muted)]">
                      cascade · {fault.cascadeDepth} spans
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-slate-300">{fault.description}</p>
                <p className="mt-1 text-sm text-slate-500">{fault.recommendation}</p>
                {fault.rootCauseSpanId ? (
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    root cause: {spanLabelById.get(fault.rootCauseSpanId) ?? fault.rootCauseSpanId}
                  </p>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Trace annotations</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          {actionableReports.length === 0 && modelInsights.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-500">
              No waste reports for this trace.
            </div>
          ) : (
            [...actionableReports, ...modelInsights].map((report) => (
              <div
                key={report.id}
                className={`${
                  report.category === "model_overuse"
                    ? "annotation-card annotation-card--info"
                    : "soft-card"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-slate-100">
                    {report.category === "model_overuse" ? (
                      <span className="text-blue-200">ℹ</span>
                    ) : (
                      <span
                        className={`inline-flex h-2.5 w-2.5 rounded-full ${severityClasses(report.severity)}`}
                      />
                    )}
                    {formatCategoryLabel(report.category)}
                  </div>
                  {report.category !== "model_overuse" ? (
                    <div className="text-sm text-red-300">{formatUsd(report.wastedCostUsd)}</div>
                  ) : null}
                </div>
                <p className="mt-3 text-sm text-slate-300">{report.description}</p>
                <p className="mt-2 text-sm text-slate-500">{report.recommendation}</p>
              </div>
            ))
          )}
        </CardBody>
      </Card>

      <TraceTree
        spans={detail.spans}
        messages={detail.messages}
        wasteReports={detail.wasteReports}
        rootCauseSpanIds={rootCauseSpanIds}
        affectedSpanIds={affectedSpanIds}
      />
    </div>
  );
}

// Trace-level context chips (environment / session / user / tags) — the metadata Langfuse-style
// dashboards surface in the trace header. Reads loosely from the normalized trace metadata.
function TraceMetaChips({ trace }: { trace: TraceSummary }) {
  const meta = (trace.metadata ?? {}) as Record<string, unknown>;
  const environment = typeof meta.environment === "string" ? meta.environment : null;
  const userId = typeof meta.userId === "string" ? meta.userId : null;
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((tag): tag is string => typeof tag === "string")
    : [];

  if (!environment && !userId && !trace.sessionKey && tags.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {environment ? (
        <span className="meta-chip">
          <span className="meta-chip__key">env</span> {environment}
        </span>
      ) : null}
      {trace.sessionKey ? (
        <span className="meta-chip">
          <span className="meta-chip__key">session</span> {trace.sessionKey}
        </span>
      ) : null}
      {userId ? (
        <span className="meta-chip">
          <span className="meta-chip__key">user</span> {userId}
        </span>
      ) : null}
      {tags.map((tag) => (
        <span key={tag} className="meta-chip">
          #{tag}
        </span>
      ))}
    </div>
  );
}

function WarpArbitrageSection({ trace }: { trace: TraceSummary }) {
  const arbitrage = readWarpArbitrage(trace);
  if (!arbitrage) return null;

  const { creditCostUsd, apiCostUsd, costMarkupPct, warpPlan, billingMode } = arbitrage;
  const comparable = apiCostUsd !== null && apiCostUsd > 0;
  const delta = comparable ? creditCostUsd - apiCostUsd : null;
  const cheaper = delta !== null && delta < 0;
  const deltaTone = !comparable
    ? "text-slate-400"
    : cheaper
      ? "text-emerald-300"
      : "text-amber-300";
  const headline = !comparable
    ? "Warp arbitrage (partial data)"
    : cheaper
      ? "Warp cheaper than API"
      : "Warp markup vs API";

  const isByok = billingMode === "byok";
  const isMixed = billingMode === "mixed";

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-kicker">Warp arbitrage</div>
          <h2 className="mt-2 text-lg font-semibold text-slate-100">{headline}</h2>
          <p className="mt-1 text-sm text-slate-500">
            What you paid Warp in credits vs. the same tokens at direct API rates.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-slate-300">
            plan: {warpPlan}
          </span>
          {isByok ? (
            <span className="rounded-full border border-emerald-300/30 bg-emerald-300/10 px-2.5 py-1 text-emerald-200">
              BYOK
            </span>
          ) : null}
          {isMixed ? (
            <span className="rounded-full border border-blue-300/30 bg-blue-300/10 px-2.5 py-1 text-blue-200">
              partial BYOK
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <div className="soft-card">
          <div className="text-xs text-slate-500">Paid (Warp credits)</div>
          <div className="mt-1 text-xl font-semibold text-slate-50">{formatUsd(creditCostUsd)}</div>
        </div>
        <div className="soft-card">
          <div className="text-xs text-slate-500">API-equivalent</div>
          <div className="mt-1 text-xl font-semibold text-slate-50">
            {comparable ? formatUsd(apiCostUsd) : "—"}
          </div>
          {!comparable ? (
            <div className="mt-1 text-xs text-slate-500">model not yet priced</div>
          ) : null}
        </div>
        <div className="soft-card">
          <div className="text-xs text-slate-500">Δ</div>
          <div className={`mt-1 text-xl font-semibold ${deltaTone}`}>
            {comparable ? (
              <>
                {cheaper ? "−" : "+"}
                {formatUsd(Math.abs(delta ?? 0))}
                {costMarkupPct !== null ? (
                  <span className="ml-2 text-sm font-normal text-slate-400">
                    ({formatPercent(Math.abs(costMarkupPct))} {cheaper ? "lower" : "higher"})
                  </span>
                ) : null}
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ClaudeCodeTokensSection({ trace }: { trace: TraceSummary }) {
  const breakdown = readClaudeCodeTokens(trace);
  if (!breakdown) return null;

  const {
    freshInputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    inputCostUsd,
    cacheWriteCostUsd,
    cacheReadCostUsd,
    outputCostUsd,
    totalCostUsd,
    cacheHitRate,
    cacheRoi,
  } = breakdown;

  const totalContextTokens = freshInputTokens + cacheWriteTokens + cacheReadTokens;

  // Cache ROI = cache_read_savings / cache_write_premium.
  // Read at 0.1× input vs full input = 0.9× saved per read token.
  // Write at 2× input vs full input = 1× extra per write token (1h cache).
  // ROI > 1 means cache investment paid back; < 1 means writes weren't amortized.
  const roiTone =
    cacheRoi === null
      ? "text-slate-400"
      : cacheRoi >= 1
        ? "text-emerald-300"
        : cacheRoi >= 0.5
          ? "text-amber-300"
          : "text-red-300";
  const roiLabel =
    cacheRoi === null
      ? "—"
      : cacheRoi >= 1
        ? `${cacheRoi.toFixed(1)}× (paid back)`
        : `${cacheRoi.toFixed(2)}× (under-amortized)`;

  const rows: Array<{ label: string; tokens: number; costUsd: number; rateNote: string }> = [
    { label: "Fresh input", tokens: freshInputTokens, costUsd: inputCostUsd, rateNote: "1× rate" },
    {
      label: "Cache writes",
      tokens: cacheWriteTokens,
      costUsd: cacheWriteCostUsd,
      rateNote: "2× rate (1h)",
    },
    {
      label: "Cache reads",
      tokens: cacheReadTokens,
      costUsd: cacheReadCostUsd,
      rateNote: "0.1× rate",
    },
    { label: "Output", tokens: outputTokens, costUsd: outputCostUsd, rateNote: "" },
  ];

  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="section-kicker">Tokens</div>
          <h2 className="mt-2 text-lg font-semibold text-slate-100">API-equivalent breakdown</h2>
          <p className="mt-1 text-sm text-slate-500">
            Where this session's tokens went, priced at Anthropic API rates.
          </p>
        </div>
        <div className="flex flex-wrap gap-3 text-right">
          <div className="pill-card">
            <div className="text-xs text-slate-500">Total context</div>
            <div className="mt-1 text-lg font-semibold text-slate-50">
              {formatInt(totalContextTokens)}
            </div>
          </div>
          <div className="pill-card">
            <div className="text-xs text-slate-500">API-equivalent cost</div>
            <div className="mt-1 text-lg font-semibold text-slate-50">
              {formatUsd(totalCostUsd)}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-2xl border border-[color:var(--border)]">
        <table className="w-full text-sm">
          <thead className="bg-white/[0.02] text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Bucket</th>
              <th className="px-4 py-2 text-right font-medium">Tokens</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
              <th className="px-4 py-2 text-right font-medium">Rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--border)]">
            {rows.map((row) => (
              <tr key={row.label}>
                <td className="px-4 py-2.5 text-slate-200">{row.label}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                  {formatInt(row.tokens)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums text-slate-100">
                  {formatUsd(row.costUsd)}
                </td>
                <td className="px-4 py-2.5 text-right text-xs text-slate-500">{row.rateNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap gap-6 text-sm">
        <div>
          <div className="text-xs text-slate-500">Cache hit rate</div>
          <div className="mt-1 font-semibold text-slate-100">
            {formatPercent(cacheHitRate * 100)}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Cache ROI</div>
          <div className={`mt-1 font-semibold ${roiTone}`}>{roiLabel}</div>
        </div>
      </div>
    </section>
  );
}
