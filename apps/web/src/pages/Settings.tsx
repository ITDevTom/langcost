import { type FormEvent, useEffect, useState } from "react";

import { type HealthResponse, type SettingsResponse, saveSettings } from "../api/client";
import { formatBytes, formatInt, formatRelativeTime } from "../lib/format";

interface SettingsProps {
  settings: SettingsResponse | null;
  health: HealthResponse | null;
  refreshing: boolean;
  onSettingsSaved: () => Promise<void> | void;
  onRefreshData: () => Promise<void> | void;
}

export function Settings({
  settings,
  health,
  refreshing,
  onSettingsSaved,
  onRefreshData,
}: SettingsProps) {
  const [source, setSource] = useState(settings?.source ?? "openclaw");
  const [sourcePath, setSourcePath] = useState(settings?.sourcePath ?? "");
  const [apiUrl, setApiUrl] = useState(settings?.apiUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setSource(settings?.source ?? "openclaw");
    setSourcePath(settings?.sourcePath ?? "");
    setApiUrl(settings?.apiUrl ?? "");
  }, [settings]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatus("Saving...");

    try {
      await saveSettings({
        source,
        ...(sourcePath.trim().length > 0 ? { sourcePath: sourcePath.trim() } : {}),
        ...(apiUrl.trim().length > 0 ? { apiUrl: apiUrl.trim() } : {}),
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      });
      await onSettingsSaved();
      setStatus("Saved.");
      setApiKey("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save settings.");
      setStatus(null);
    } finally {
      setSaving(false);
    }
  }

  const limitReached = Boolean(
    health && health.traceCount >= health.traceLimit && health.traceLimit > 0,
  );

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
      <form onSubmit={handleSave} className="panel p-6">
        <h1 className="text-2xl font-semibold text-slate-50">Settings</h1>
        <p className="section-copy mt-2 text-sm">
          Change the active source configuration and refresh the dataset on demand.
        </p>

        <label className="mt-6 block text-sm">
          <span className="mb-2 block text-slate-400">Source</span>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="field-shell w-full"
          >
            <option value="openclaw">OpenClaw</option>
          </select>
        </label>

        <label className="mt-4 block text-sm">
          <span className="mb-2 block text-slate-400">Source path</span>
          <input
            value={sourcePath}
            onChange={(event) => setSourcePath(event.target.value)}
            className="field-shell w-full"
          />
        </label>

        <label className="mt-4 block text-sm">
          <span className="mb-2 block text-slate-400">API URL</span>
          <input
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            className="field-shell w-full"
          />
        </label>

        <label className="mt-4 block text-sm">
          <span className="mb-2 block text-slate-400">
            API key {settings?.hasApiKey ? "(leave blank to keep current key)" : ""}
          </span>
          <input
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            type="password"
            className="field-shell w-full"
          />
        </label>

        {status ? <p className="mt-4 text-sm text-blue-200">{status}</p> : null}
        {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}

        <button type="submit" disabled={saving} className="button-primary mt-6">
          {saving ? "Saving..." : "Save settings"}
        </button>
      </form>

      <div className="flex flex-col gap-6">
        <section className="panel p-6">
          <h2 className="text-lg font-semibold text-slate-100">Database</h2>
          {health ? (
            <div className="mt-4 space-y-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Path</span>
                <span className="truncate text-right text-slate-200">{health.dbPath}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Size</span>
                <span className="text-slate-200">{formatBytes(health.dbSizeBytes)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Traces</span>
                <span className={limitReached ? "text-yellow-200" : "text-slate-200"}>
                  {formatInt(health.traceCount)} / {formatInt(health.traceLimit)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Spans</span>
                <span className="text-slate-200">{formatInt(health.spanCount)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Messages</span>
                <span className="text-slate-200">{formatInt(health.messageCount)}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-500">Last scan</span>
                <span className="text-slate-200">{formatRelativeTime(health.lastScanAt)}</span>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Database stats unavailable.</p>
          )}
        </section>

        <section className="panel p-6">
          <h2 className="text-lg font-semibold text-slate-100">Actions</h2>
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void onRefreshData()}
              disabled={refreshing}
              className="button-primary"
            >
              {refreshing ? "Refreshing..." : "Refresh Data"}
            </button>
            <button type="button" disabled className="button-secondary">
              Clear Database
            </button>
          </div>
        </section>

        <section
          className={`panel p-6 ${limitReached ? "border-yellow-400/30 bg-yellow-500/6" : ""}`}
        >
          <h2 className="text-lg font-semibold text-slate-100">History Limit</h2>
          <p className="mt-2 text-sm text-slate-400">
            OSS keeps the 500 most recent traces. Older traces are pruned after each refresh.
          </p>
          {limitReached ? (
            <p className="mt-4 text-sm text-yellow-200">
              The database is currently at capacity. New scans will keep only the newest traces.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
