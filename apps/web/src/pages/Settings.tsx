import { useCallback, useEffect, useState } from "react";

import {
  type AdapterStatus,
  getAdapters,
  getRules,
  type InstalledAdapter,
  installAdapter,
  type MissingAdapter,
  type RuleCatalogEntry,
  type RuleConfigEntry,
  type RulesConfig,
  saveRules,
  triggerScan,
  uninstallAdapter,
} from "../api/client";
import { formatInt, formatRelativeTime } from "../lib/format";
import { MODES, type ProductMode } from "../lib/modes";

interface SettingsProps {
  mode: ProductMode;
  onShellRefresh: () => Promise<void> | void;
}

type RowAction = "idle" | "syncing" | "installing" | "uninstalling";

interface RowState {
  action: RowAction;
  message: string | null;
  error: string | null;
}

const INITIAL_ROW_STATE: RowState = { action: "idle", message: null, error: null };

const REPO_URL = "https://github.com/vjvkrm/langcost";
const ADAPTERS_DIR_URL = `${REPO_URL}/tree/main/packages`;

/**
 * Bucket an adapter into a product group. Anything not explicitly flagged "ai" (including a missing
 * product field from an older/stale API response) falls back to "coding", so adapters are never
 * dropped from the list — mirrors modeForSource's unknown→coding default.
 */
function productGroupOf(adapter: AdapterStatus): ProductMode {
  return adapter.product === "ai" ? "ai" : "coding";
}

/** Whether a rule (with its persisted scope) currently applies to a given adapter. */
function ruleAppliesToAdapter(entry: RuleConfigEntry | undefined, adapterName: string): boolean {
  if (!entry?.enabled) {
    return false;
  }
  return entry.sources === "*" || entry.sources.includes(adapterName);
}

/**
 * Toggle a rule on/off for a single adapter, editing the shared rules config adapter-first.
 * A `"*"` scope is expanded to the concrete adapter set before toggling, so unchecking one adapter
 * leaves the rule applied to the rest (rather than all-or-nothing).
 */
function toggleRuleForAdapter(
  config: RulesConfig,
  ruleId: string,
  adapterName: string,
  allAdapterNames: string[],
): RulesConfig {
  const entry = config.rules[ruleId];

  let scope: Set<string>;
  if (!entry?.enabled) {
    scope = new Set();
  } else if (entry.sources === "*") {
    scope = new Set(allAdapterNames);
  } else {
    scope = new Set(entry.sources);
  }

  if (scope.has(adapterName)) {
    scope.delete(adapterName);
  } else {
    scope.add(adapterName);
  }

  const next: RuleConfigEntry = {
    enabled: scope.size > 0,
    sources: [...scope],
    ...(entry?.thresholds ? { thresholds: entry.thresholds } : {}),
  };

  return { rules: { ...config.rules, [ruleId]: next } };
}

export function Settings({ mode, onShellRefresh }: SettingsProps) {
  const [adapters, setAdapters] = useState<AdapterStatus[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  const [rulesCatalog, setRulesCatalog] = useState<RuleCatalogEntry[]>([]);
  const [rulesConfig, setRulesConfig] = useState<RulesConfig>({ rules: {} });
  const [rulesDirty, setRulesDirty] = useState(false);
  const [savingRules, setSavingRules] = useState(false);
  const [rulesMessage, setRulesMessage] = useState<string | null>(null);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const loadAll = useCallback(async () => {
    setListError(null);
    try {
      const [adaptersResponse, rulesResponse] = await Promise.all([getAdapters(), getRules()]);
      setAdapters(adaptersResponse.adapters);
      setRulesCatalog(rulesResponse.catalog);
      setRulesConfig(rulesResponse.config);
      setRulesDirty(false);
    } catch (cause) {
      setListError(cause instanceof Error ? cause.message : "Failed to load adapters.");
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  function setRow(name: string, next: Partial<RowState>) {
    setRowState((current) => ({
      ...current,
      [name]: { ...(current[name] ?? INITIAL_ROW_STATE), ...next },
    }));
  }

  async function runRowAction(
    name: string,
    action: Exclude<RowAction, "idle">,
    fn: () => Promise<string | null>,
    failureLabel: string,
  ) {
    setRow(name, { action, message: null, error: null });
    try {
      const message = await fn();
      setRow(name, { action: "idle", message, error: null });
      await loadAll();
      await onShellRefresh();
    } catch (cause) {
      setRow(name, {
        action: "idle",
        message: null,
        error: cause instanceof Error ? cause.message : failureLabel,
      });
    }
  }

  function handleSync(adapter: InstalledAdapter) {
    void runRowAction(
      adapter.name,
      "syncing",
      async () => {
        const result = await triggerScan(false, adapter.name);
        return `Ingested ${result.tracesIngested} traces in ${Math.round(result.durationMs)}ms.`;
      },
      "Scan failed.",
    );
  }

  function handleInstall(adapter: MissingAdapter) {
    void runRowAction(
      adapter.name,
      "installing",
      async () => {
        await installAdapter(adapter.name);
        return null;
      },
      "Install failed.",
    );
  }

  function handleUninstall(adapter: InstalledAdapter) {
    if (adapter.installType !== "npm") return;
    const confirmed = window.confirm(
      `Uninstall ${adapter.label}? Already-ingested traces will remain in the DB.`,
    );
    if (!confirmed) return;

    void runRowAction(
      adapter.name,
      "uninstalling",
      async () => {
        await uninstallAdapter(adapter.name);
        return null;
      },
      "Uninstall failed.",
    );
  }

  // Rule-scope expansion ("*") must span ALL adapters regardless of the visible product, so this
  // list is intentionally unfiltered.
  const adapterNames = (adapters ?? []).map((adapter) => adapter.name);

  // The Adapters page shows only the adapters for the product you're currently in.
  const activeMode = MODES.find((m) => m.id === mode);
  const visibleAdapters = adapters?.filter((adapter) => productGroupOf(adapter) === mode);

  function handleToggleRule(adapterName: string, ruleId: string) {
    setRulesConfig((current) => toggleRuleForAdapter(current, ruleId, adapterName, adapterNames));
    setRulesDirty(true);
    setRulesMessage(null);
    setRulesError(null);
  }

  function toggleExpand(name: string) {
    setExpanded((current) => ({ ...current, [name]: !current[name] }));
  }

  async function handleSaveRules() {
    setSavingRules(true);
    setRulesMessage(null);
    setRulesError(null);
    try {
      const result = await saveRules(rulesConfig);
      setRulesMessage(
        `Saved. Re-analyzed ${result.tracesAnalyzed} trace(s); ${result.findingsCount} finding(s).`,
      );
      await loadAll();
      await onShellRefresh();
    } catch (cause) {
      setRulesError(cause instanceof Error ? cause.message : "Failed to save rules.");
    } finally {
      setSavingRules(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="panel p-6">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-50">Adapters</h1>
            <p className="section-copy mt-2 text-sm">
              Install or uninstall adapters, sync their traces, and choose which detection rules
              (cost + fault) run for each.{" "}
              <a
                href={ADAPTERS_DIR_URL}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-2 hover:text-slate-200"
              >
                Browse adapters on GitHub →
              </a>
            </p>
          </div>
          <button type="button" onClick={() => void loadAll()} className="button-ghost text-xs">
            Refresh list
          </button>
        </div>

        <OssLimitsCallout />

        {listError ? <div className="banner banner--error mt-6 text-sm">{listError}</div> : null}
        {rulesError ? <div className="banner banner--error mt-6 text-sm">{rulesError}</div> : null}
        {rulesMessage ? (
          <div className="banner banner--info mt-6 text-sm">{rulesMessage}</div>
        ) : null}

        <div className="mt-6">
          <div className="flex items-baseline gap-2">
            <h2
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: "var(--text-secondary)" }}
            >
              {activeMode?.label ?? "Available"} adapters
            </h2>
            {activeMode?.tagline ? (
              <span className="text-xs text-slate-500">{activeMode.tagline}</span>
            ) : null}
          </div>

          <div className="mt-3 space-y-3">
            {visibleAdapters === undefined ? (
              <p className="text-sm text-slate-500">Loading adapters…</p>
            ) : visibleAdapters.length === 0 ? (
              <p className="text-sm text-slate-500">No adapters available for this product yet.</p>
            ) : (
              visibleAdapters.map((adapter) => (
                <AdapterRow
                  key={adapter.name}
                  adapter={adapter}
                  state={rowState[adapter.name] ?? INITIAL_ROW_STATE}
                  onSync={handleSync}
                  onInstall={handleInstall}
                  onUninstall={handleUninstall}
                  rulesCatalog={rulesCatalog}
                  isExpanded={expanded[adapter.name] ?? false}
                  onToggleExpand={() => toggleExpand(adapter.name)}
                  isRuleChecked={(ruleId) =>
                    ruleAppliesToAdapter(rulesConfig.rules[ruleId], adapter.name)
                  }
                  onToggleRule={(ruleId) => handleToggleRule(adapter.name, ruleId)}
                  onSaveRules={() => void handleSaveRules()}
                  savingRules={savingRules}
                  rulesDirty={rulesDirty}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 180 also lives in MAX_SINCE_DAYS in @langcost/core; kept literal here to avoid
// pulling core into the web workspace just for one number.
function OssLimitsCallout() {
  return (
    <div
      className="mt-4 rounded-2xl border px-4 py-3 text-sm leading-6"
      style={{
        borderColor: "color-mix(in srgb, var(--accent-yellow) 32%, var(--border))",
        backgroundColor: "color-mix(in srgb, var(--accent-yellow) 10%, transparent)",
        color: "var(--text-secondary)",
      }}
    >
      <span className="font-medium" style={{ color: "var(--accent-yellow)" }}>
        OSS limits:
      </span>{" "}
      scans only ever read the last <strong>180 days</strong> of history, and the dashboard keeps
      the <strong>500 most recent traces</strong> (older ones are pruned after each scan). For
      faster syncs on large histories, narrow the window from the CLI with{" "}
      <code
        className="rounded px-1.5 py-0.5 text-xs"
        style={{ backgroundColor: "var(--surface-soft)", color: "var(--text-primary)" }}
      >
        langcost scan --since 30d
      </code>
      .
    </div>
  );
}

interface AdapterRowProps {
  adapter: AdapterStatus;
  state: RowState;
  onSync: (adapter: InstalledAdapter) => void;
  onInstall: (adapter: MissingAdapter) => void;
  onUninstall: (adapter: InstalledAdapter) => void;
  rulesCatalog: RuleCatalogEntry[];
  isExpanded: boolean;
  onToggleExpand: () => void;
  isRuleChecked: (ruleId: string) => boolean;
  onToggleRule: (ruleId: string) => void;
  onSaveRules: () => void;
  savingRules: boolean;
  rulesDirty: boolean;
}

function AdapterRow({
  adapter,
  state,
  onSync,
  onInstall,
  onUninstall,
  rulesCatalog,
  isExpanded,
  onToggleExpand,
  isRuleChecked,
  onToggleRule,
  onSaveRules,
  savingRules,
  rulesDirty,
}: AdapterRowProps) {
  const busy = state.action !== "idle";
  const enabledRuleCount = adapter.installed
    ? rulesCatalog.filter((rule) => isRuleChecked(rule.id)).length
    : 0;

  return (
    <div className="rounded-2xl border border-[color:var(--border)] bg-[color:var(--surface-alt)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-medium text-slate-100">{adapter.label}</span>
            {adapter.installed ? (
              <span className="text-xs text-slate-500">v{adapter.version}</span>
            ) : (
              <span className="rounded-full border border-slate-500/30 bg-slate-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-300">
                not installed
              </span>
            )}
            {adapter.installed && adapter.installType === "workspace" ? (
              <span className="rounded-full border border-blue-400/30 bg-blue-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-blue-200">
                workspace
              </span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <span>@langcost/adapter-{adapter.name}</span>
            <span aria-hidden>·</span>
            <span>
              {formatInt(adapter.traceCount)} {adapter.traceCount === 1 ? "trace" : "traces"}
            </span>
            {adapter.lastScanAt ? (
              <>
                <span aria-hidden>·</span>
                <span>last scan {formatRelativeTime(adapter.lastScanAt)}</span>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {adapter.installed ? (
            <>
              <button
                type="button"
                onClick={() => onSync(adapter)}
                disabled={busy}
                className="button-primary px-3 py-2 text-sm"
              >
                {state.action === "syncing" ? "Syncing…" : "Sync"}
              </button>
              <button
                type="button"
                onClick={() => onUninstall(adapter)}
                disabled={busy || adapter.installType !== "npm"}
                title={
                  adapter.installType === "npm"
                    ? undefined
                    : "Workspace-linked adapters can't be uninstalled from the UI."
                }
                className="button-secondary px-3 py-2 text-sm"
              >
                {state.action === "uninstalling" ? "Uninstalling…" : "Uninstall"}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onInstall(adapter)}
              disabled={busy}
              className="button-primary px-3 py-2 text-sm"
            >
              {state.action === "installing" ? "Installing…" : "Install"}
            </button>
          )}
        </div>
      </div>

      {!adapter.installed ? (
        <div className="mt-3 rounded-xl bg-[color:var(--surface-soft)] px-3 py-2 text-[11px] text-slate-400">
          Or run from your terminal:{" "}
          <code className="text-slate-200">{adapter.installCommand}</code>
        </div>
      ) : null}

      {adapter.installed && rulesCatalog.length > 0 ? (
        <div className="mt-3 border-t border-[color:var(--border)] pt-3">
          <button
            type="button"
            onClick={onToggleExpand}
            className="flex items-center gap-2 text-xs font-medium text-slate-300 hover:text-slate-100"
          >
            <span aria-hidden>{isExpanded ? "▾" : "▸"}</span>
            <span>
              Detection rules{" "}
              <span className="text-slate-500">
                ({enabledRuleCount}/{rulesCatalog.length} on)
              </span>
            </span>
          </button>

          {isExpanded ? (
            <div className="mt-3">
              <p className="mb-2 text-[11px] text-slate-500">
                Only the rules you check run for {adapter.label}. Detection is opt-in.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {rulesCatalog.map((rule) => (
                  <label
                    key={rule.id}
                    className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-200 hover:bg-[color:var(--surface-soft)]"
                  >
                    <input
                      type="checkbox"
                      checked={isRuleChecked(rule.id)}
                      onChange={() => onToggleRule(rule.id)}
                      className="mt-1"
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{rule.title}</span>
                      <span
                        className="ml-1 text-[10px] uppercase tracking-wide"
                        style={{
                          color: rule.kind === "fault" ? "var(--accent-red)" : "var(--text-muted)",
                        }}
                      >
                        {rule.kind ?? "cost"}
                      </span>
                      <span className="block text-[11px] leading-snug text-slate-500">
                        {rule.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={onSaveRules}
                  disabled={savingRules || !rulesDirty}
                  className="button-primary px-3 py-2 text-sm"
                >
                  {savingRules ? "Saving…" : "Save & analyze"}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {state.message ? <p className="mt-3 text-xs text-blue-200">{state.message}</p> : null}
      {state.error ? <p className="mt-3 text-xs text-red-300">{state.error}</p> : null}
    </div>
  );
}
