/**
 * Form metadata for connecting API-backed sources (e.g. Langfuse) from the Settings page.
 * Local coding adapters auto-detect their path and need no credential form, so they aren't listed
 * here — `getApiSourceForm` returns undefined for them and the row renders no connect panel.
 */

export interface WindowOption {
  days: number;
  label: string;
}

export interface ApiSourceForm {
  /** Langfuse-style two-key auth, persisted as a single `apiKey` = "publicKey:secretKey". */
  publicKeyLabel: string;
  publicKeyPlaceholder: string;
  secretKeyLabel: string;
  secretKeyPlaceholder: string;
  apiUrlLabel: string;
  apiUrlPlaceholder: string;
  defaultApiUrl: string;
  /** How far back to pull on each sync — bounded so a large project can't time out / rate-limit. */
  windowOptions: WindowOption[];
  defaultWindowDays: number;
  docsUrl: string;
  helpText: string;
}

export const API_SOURCE_FORMS: Record<string, ApiSourceForm> = {
  langfuse: {
    publicKeyLabel: "Public key",
    publicKeyPlaceholder: "pk-lf-…",
    secretKeyLabel: "Secret key",
    secretKeyPlaceholder: "sk-lf-…",
    apiUrlLabel: "Host (API URL)",
    apiUrlPlaceholder: "https://cloud.langfuse.com",
    defaultApiUrl: "https://cloud.langfuse.com",
    windowOptions: [
      { days: 7, label: "Last 7 days" },
      { days: 30, label: "Last 30 days" },
      { days: 60, label: "Last 60 days" },
      { days: 90, label: "Last 90 days" },
    ],
    defaultWindowDays: 30,
    docsUrl: "https://langfuse.com/faq/all/where-are-langfuse-api-keys",
    helpText:
      "Create a key pair in Langfuse → Project Settings → API Keys. Use your region's host (EU: cloud.langfuse.com, US: us.cloud.langfuse.com) or your self-hosted URL.",
  },
};

export function getApiSourceForm(source: string): ApiSourceForm | undefined {
  return API_SOURCE_FORMS[source];
}
