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
      <section className="stat-strip">
        <span className="stat-strip__item">
          <span className="stat-strip__label">Total:</span> {formatUsd(overview.totalCostUsd)}
        </span>
        <span className="stat-strip__separator">|</span>
        <span className="stat-strip__item">
          <span className="stat-strip__label">Waste:</span> {formatUsd(overview.totalWastedUsd)} (
          {formatPercent(overview.wastePercentage)})
        </span>
        <span className="stat-strip__separator">|</span>
        <span className="stat-strip__item">
          <span className="stat-strip__label">Sessions:</span> {overview.totalTraces}
        </span>
        <span className="stat-strip__separator">|</span>
        <span className="stat-strip__item">
          <span className="stat-strip__label">Last scan:</span>{" "}
          {formatRelativeTime(overview.lastScanAt)}
        </span>
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

          <div className="model-usage-line mt-4">
            {overview.costByModel.map((entry, index) => (
              <span key={entry.model} className="model-usage-line__item">
                {entry.model}: {entry.traceCount} sessions {formatUsd(entry.costUsd)}
                {index < overview.costByModel.length - 1 ? (
                  <span className="model-usage-line__separator">|</span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
