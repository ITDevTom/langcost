import type { DataRequirement } from "@langcost/core";

import { getNumericMetadataValue, type TraceAnalysisContext } from "../context";

/**
 * Whether a trace carries the normalized data a rule needs. The runner uses this to skip traces
 * that can't yield findings (e.g. an adapter that doesn't capture cache tokens), which is what
 * makes per-adapter behavior explainable in the dashboard rather than a silent zero.
 *
 * The gate is conservative: it only ever skips a trace when the data is definitively absent, so it
 * can never drop a trace a rule would have flagged. Unknown/uncaptured requirements never block.
 */
export function satisfiesRequirements(
  context: TraceAnalysisContext,
  requires: DataRequirement[] | undefined,
): boolean {
  if (!requires || requires.length === 0) {
    return true;
  }
  return requires.every((requirement) => satisfiesOne(context, requirement));
}

function satisfiesOne(context: TraceAnalysisContext, requirement: DataRequirement): boolean {
  switch (requirement) {
    case "messages":
      return context.messages.length > 0;
    case "spans":
      return context.spans.length > 0;
    case "cacheTokens":
      return context.llmSpans.some(
        (span) =>
          getNumericMetadataValue(span.metadata, "cacheRead") !== undefined ||
          getNumericMetadataValue(span.metadata, "cacheCreationTokens") !== undefined,
      );
    case "toolDefs":
      // The normalized model does not yet capture declared tool sets; never block on it.
      return true;
    default:
      return true;
  }
}
