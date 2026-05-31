// langcost ships two products behind one `dashboard` command, switched in the header:
//   - "coding"  → local dev-tool session logs (OpenClaw, Claude Code, Warp, Cline, Codex)
//   - "ai"      → production agent traces (Langfuse, …) with the lens view + fault tolerance
// The classification is a presentation concern (which source belongs to which product), so it
// lives here in the web layer rather than in the source-agnostic backend.

export type ProductMode = "coding" | "ai";

// Observability / production trace sources surface the "AI agents" product. "sample" is the
// seeded production-shaped demo data, so it belongs with the AI-agents product too. Everything
// else (and any unknown source) is treated as a local coding-agent log source.
//
// SYNC INVARIANT: this client-side set classifies trace.source for the mode switch. The Adapters
// page instead reads each adapter's API-declared `product` (no drift there). When you add a new
// production adapter with product:"ai" to KNOWN_ADAPTERS (apps/api/src/routes/adapters.ts), add its
// source name here too — otherwise its traces would be mode-switched as "coding". (Follow-up: drive
// this from the /adapters product field so the two lists can't diverge.)
const AI_SOURCES = new Set(["langfuse", "langsmith", "langwatch", "otel", "sample"]);

export interface ModeMeta {
  id: ProductMode;
  label: string;
  tagline: string;
}

export const MODES: ModeMeta[] = [
  { id: "coding", label: "Coding agents", tagline: "Local dev-tool sessions" },
  { id: "ai", label: "AI agents", tagline: "Production agent traces" },
];

export function modeForSource(source: string | undefined): ProductMode {
  return source && AI_SOURCES.has(source) ? "ai" : "coding";
}

export function sourcesForMode<T extends { name: string }>(sources: T[], mode: ProductMode): T[] {
  return sources.filter((s) => modeForSource(s.name) === mode);
}

// Pick the initial mode: honor the saved choice when that mode has data; otherwise fall back to
// whichever mode actually has sources (prefer coding when both or neither have data), so a fresh
// install doesn't open on an empty product.
export function resolveInitialMode(sources: { name: string }[], saved: string | null): ProductMode {
  const hasAi = sources.some((s) => modeForSource(s.name) === "ai");
  const hasCoding = sources.some((s) => modeForSource(s.name) === "coding");
  if (saved === "ai" && hasAi) return "ai";
  if (saved === "coding" && hasCoding) return "coding";
  if (hasCoding) return "coding";
  if (hasAi) return "ai";
  return saved === "ai" ? "ai" : "coding";
}
