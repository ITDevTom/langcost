import { describe, expect, it } from "bun:test";

import type { TraceAnalysisContext } from "../src/context";
import { satisfiesRequirements } from "../src/index";

function ctx(overrides: Record<string, unknown>): TraceAnalysisContext {
  return {
    trace: {},
    spans: [],
    messages: [],
    segments: [],
    llmSpans: [],
    toolSpans: [],
    ...overrides,
  } as unknown as TraceAnalysisContext;
}

describe("satisfiesRequirements", () => {
  it("passes when there are no requirements", () => {
    expect(satisfiesRequirements(ctx({}), undefined)).toBe(true);
    expect(satisfiesRequirements(ctx({}), [])).toBe(true);
  });

  it("gates on the presence of messages", () => {
    expect(satisfiesRequirements(ctx({ messages: [] }), ["messages"])).toBe(false);
    expect(satisfiesRequirements(ctx({ messages: [{}] }), ["messages"])).toBe(true);
  });

  it("gates on cache tokens via span metadata", () => {
    expect(satisfiesRequirements(ctx({ llmSpans: [{ metadata: {} }] }), ["cacheTokens"])).toBe(
      false,
    );
    expect(
      satisfiesRequirements(ctx({ llmSpans: [{ metadata: { cacheRead: 10 } }] }), ["cacheTokens"]),
    ).toBe(true);
  });

  it("never blocks on requirements the normalized model does not yet capture (toolDefs)", () => {
    expect(satisfiesRequirements(ctx({}), ["toolDefs"])).toBe(true);
  });
});
