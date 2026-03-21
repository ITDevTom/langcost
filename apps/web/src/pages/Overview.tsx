import { useEffect, useState } from "react";

import {
  getOverview,
  getRecommendations,
  type OverviewResponse,
  type Recommendation,
} from "../api/client";
import { CostTimeline } from "../components/charts/CostTimeline";
import { formatPercent, formatRelativeTime, formatUsd } from "../lib/format";

interface OverviewProps {
  refreshToken: number;
  onNavigate: (path: string) => void;
}

export function Overview({ refreshToken, onNavigate }: OverviewProps) {
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshToken;
    let active = true;

    void (async () => {
      setLoading(true);
      setError(null);

      try {
        const [overviewResponse, recommendationResponse] = await Promise.all([
          getOverview(),
          getRecommendations(),
        ]);

        if (!active) {
          return;
        }

        setOverview(overviewResponse);
        setRecommendations(recommendationResponse.recommendations);
      } catch (cause) {
        if (!active) {
          return;
        }

        setError(cause instanceof Error ? cause.message : "Failed to load overview.");
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [refreshToken]);

  if (loading) {
    return <div className="panel p-8 text-sm text-slate-400">Loading overview...</div>;
  }

  if (error) {
    return <div className="panel p-8 text-sm text-red-300">{error}</div>;
  }

  if (!overview) {
    return <div className="panel p-8 text-sm text-slate-500">No overview data available.</div>;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-6">
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Total Cost",
            value: formatUsd(overview.totalCostUsd),
            detail: `${overview.costByModel.length} models observed`,
            tone: "summary-card--blue",
          },
          {
            label: "Actionable Waste",
            value: formatUsd(overview.totalWastedUsd),
            detail: formatPercent(overview.wastePercentage),
            tone: "summary-card--rose",
          },
          {
            label: "Sessions",
            value: `${overview.totalTraces}`,
            detail: `${overview.tracesWithWaste} with waste findings`,
            tone: "summary-card--green",
          },
          {
            label: "Last Scan",
            value: formatRelativeTime(overview.lastScanAt),
            detail: overview.lastScanAt ?? "No scans yet",
            tone: "summary-card--amber",
          },
        ].map((card) => (
          <div key={card.label} className={`summary-card ${card.tone}`}>
            <div className="summary-label">{card.label}</div>
            <div className="summary-value">{card.value}</div>
            <div className="summary-detail">{card.detail}</div>
          </div>
        ))}
      </section>

      <section className="panel p-5">
        <div className="mb-4">
          <div className="section-kicker">Daily Trend</div>
          <h2 className="text-lg font-semibold text-slate-100">Cost by Day</h2>
          <p className="section-copy mt-1 text-sm">Daily cost with actionable waste overlay</p>
        </div>
        <CostTimeline data={overview.costByDay} />
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="panel p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="section-kicker">Actions</div>
              <h2 className="text-lg font-semibold text-slate-100">Top Recommendations</h2>
              <p className="section-copy mt-1 text-sm">
                Actionable waste reductions ranked by estimated savings
              </p>
            </div>
            <button type="button" onClick={() => onNavigate("/")} className="button-ghost">
              Open traces
            </button>
          </div>

          <div className="mt-4 space-y-3">
            {recommendations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-slate-500">
                No recommendations yet.
              </div>
            ) : (
              recommendations.slice(0, 5).map((item, index) => (
                <div key={`${item.category}-${item.description}`} className="soft-card">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-slate-100">
                        {index + 1}. {item.description}
                      </div>
                      <div className="mt-2 text-sm text-slate-400">
                        {item.category} across {item.affectedTraces} traces
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm text-slate-500">Savings</div>
                      <div className="mt-1 text-lg font-semibold text-emerald-300">
                        {formatUsd(item.estimatedSavingsUsd)}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="panel p-5">
          <div className="section-kicker">Insight</div>
          <h2 className="text-lg font-semibold text-slate-100">Model Usage</h2>
          <p className="section-copy mt-1 text-sm">
            Informational only. Model mix is separate from actionable waste.
          </p>

          <div className="mt-4 space-y-3">
            {overview.costByModel.map((entry) => (
              <div key={entry.model} className="soft-card">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-medium text-slate-100">{entry.model}</div>
                    <div className="mt-1 text-sm text-slate-500">{entry.traceCount} traces</div>
                  </div>
                  <div className="text-right text-slate-100">{formatUsd(entry.costUsd)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
