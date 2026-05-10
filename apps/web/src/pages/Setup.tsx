import { type FormEvent, useState } from "react";

import { type SettingsResponse, saveSettings, triggerScan } from "../api/client";
import { DEFAULT_SOURCE, getSourceOption, SOURCE_OPTIONS } from "../lib/sources";

interface SetupProps {
  initialSettings: SettingsResponse | null;
  onConfigured: () => Promise<void> | void;
}

export function Setup({ initialSettings, onConfigured }: SetupProps) {
  const [source, setSource] = useState(initialSettings?.source ?? DEFAULT_SOURCE.value);
  const [sourcePath, setSourcePath] = useState(
    initialSettings?.sourcePath ?? getSourceOption(initialSettings?.source).defaultSourcePath,
  );
  const [apiUrl, setApiUrl] = useState(initialSettings?.apiUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedSource = getSourceOption(source);

  function handleSourceChange(nextSource: string) {
    setSource(nextSource);
    setSourcePath(getSourceOption(nextSource).defaultSourcePath);
  }

  async function handleConnect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setStatus("Saving source configuration...");

    try {
      await saveSettings({
        source,
        ...(sourcePath.trim().length > 0 ? { sourcePath: sourcePath.trim() } : {}),
        ...(apiUrl.trim().length > 0 ? { apiUrl: apiUrl.trim() } : {}),
        ...(apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
      });

      setStatus("Scanning your latest traces...");
      const result = await triggerScan(false);
      setStatus(`Scan complete. Ingested ${result.tracesIngested} traces.`);
      await onConfigured();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to configure source.");
      setStatus(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100vh-8rem)] items-center justify-center">
      <div className="panel w-full max-w-3xl overflow-hidden">
        <div className="grid gap-8 p-8 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <p className="section-kicker">First Run</p>
            <h1 className="mt-3 text-4xl font-semibold text-slate-50">Welcome to langcost</h1>
            <p className="section-copy mt-4 max-w-xl text-base leading-7">
              Connect your agent data source, run the first scan, and start breaking down where cost
              and waste are hiding.
            </p>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              {SOURCE_OPTIONS.map((option) => (
                <button
                  type="button"
                  key={option.value}
                  onClick={() => handleSourceChange(option.value)}
                  className={`rounded-2xl border p-4 text-left transition ${
                    source === option.value
                      ? "border-blue-400/40 bg-blue-500/10"
                      : "border-[color:var(--border)] bg-[color:var(--surface-alt)] hover:bg-[color:var(--surface-hover)]"
                  }`}
                >
                  <div className="text-lg font-medium text-slate-100">{option.label}</div>
                  <div className="mt-2 text-sm text-slate-400">{option.description}</div>
                </button>
              ))}

              <div className="soft-card opacity-70">
                <div className="text-lg font-medium text-slate-100">Langfuse</div>
                <div className="mt-2 text-sm text-slate-400">Remote traces over API</div>
                <div className="mt-4 text-sm text-slate-500">Coming soon</div>
              </div>
            </div>
          </div>

          <form onSubmit={handleConnect} className="soft-card rounded-3xl p-6">
            <div className="text-sm font-semibold text-slate-100">Source configuration</div>

            <label className="mt-4 block text-sm">
              <span className="mb-2 block text-slate-400">Source</span>
              <select
                value={source}
                onChange={(event) => handleSourceChange(event.target.value)}
                className="field-shell w-full"
              >
                {SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="mt-4 block text-sm">
              <span className="mb-2 block text-slate-400">{selectedSource.sourcePathLabel}</span>
              <input
                value={sourcePath}
                onChange={(event) => setSourcePath(event.target.value)}
                placeholder={selectedSource.sourcePathPlaceholder}
                className="field-shell w-full"
              />
            </label>

            <label className="mt-4 block text-sm">
              <span className="mb-2 block text-slate-400">API URL (optional)</span>
              <input
                value={apiUrl}
                onChange={(event) => setApiUrl(event.target.value)}
                placeholder="https://..."
                className="field-shell w-full"
              />
            </label>

            <label className="mt-4 block text-sm">
              <span className="mb-2 block text-slate-400">API key (optional)</span>
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                type="password"
                placeholder="••••••••"
                className="field-shell w-full"
              />
            </label>

            {status ? <p className="mt-4 text-sm text-blue-200">{status}</p> : null}
            {error ? <p className="mt-4 text-sm text-red-300">{error}</p> : null}

            <button type="submit" disabled={submitting} className="button-primary mt-6 w-full">
              {submitting ? "Connecting..." : "Connect & Scan"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
