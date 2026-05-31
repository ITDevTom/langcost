#!/usr/bin/env bun
// Seeds RICH, production-shaped agent-run traces into a SQLite DB so the AI-agents dashboard (lens /
// tree view, cost rollups, waste, fault attribution) can be developed and evaluated before real
// Langfuse/LangSmith ingestion exists. These are normalized records — the shape every adapter targets
// — so they double as a reference for what the adapters should produce. Source = "sample".
//
// Modeled on real production topologies (Langfuse / LangSmith / OpenInference-OTel observation trees):
//   1. Customer-support RAG agent — multi-turn session, embed → retrieve → ground → tool call
//   2. Multi-agent research — planner + worker agents, deep nesting, tool loops
//   3. Coding/ReAct agent — write-code → run-code loop with failures + prompt caching (Anthropic)
//   4. Long cached chat — one session, many turns, large cache_read + a cache-expiry gap
//   5. Retry / tool-storm — fault showcase: a flaky tool retried to death + retrieval thrash
//   6. RAG empty-retrieval → hallucination → tool error (upstream-data fault, FAILED)
//   7. Partial/cancelled run (status = "partial")
//
//   bun scripts/seed-sample-traces.ts [--db ./sample-traces.db]
//   langcost dashboard --db ./sample-traces.db

import {
  createDb,
  createMessageRepository,
  createSpanRepository,
  createTraceRepository,
  createWasteReportRepository,
  getSqliteClient,
  type MessageRecord,
  migrate,
  type SpanRecord,
  type TraceRecord,
  type WasteReportRecord,
} from "@langcost/db";

const dbArg = process.argv.indexOf("--db");
const dbPath =
  dbArg >= 0 && process.argv[dbArg + 1]
    ? (process.argv[dbArg + 1] as string)
    : "./sample-traces.db";

const BASE = new Date("2026-05-29T10:00:00Z").getTime();

// ---- model pricing (USD / 1M tokens) so synthetic costs are internally consistent ----
interface Price {
  provider: string;
  in: number;
  out: number;
  cacheRead?: number;
}
const PRICES: Record<string, Price> = {
  "gpt-4o": { provider: "openai", in: 2.5, out: 10, cacheRead: 1.25 },
  "gpt-4o-mini": { provider: "openai", in: 0.15, out: 0.6, cacheRead: 0.075 },
  "text-embedding-3-small": { provider: "openai", in: 0.02, out: 0 },
  "claude-sonnet-4-5": { provider: "anthropic", in: 3, out: 15, cacheRead: 0.3 },
  "claude-opus-4-1": { provider: "anthropic", in: 5, out: 25, cacheRead: 0.5 },
  "gemini-2.5-flash": { provider: "google", in: 0.3, out: 2.5, cacheRead: 0.075 },
};

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const jstr = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

function genCost(model: string, input: number, output: number, cacheRead = 0): number {
  const p = PRICES[model];
  if (!p) return 0;
  const fresh = Math.max(0, input - cacheRead);
  const cost = (fresh * p.in + cacheRead * (p.cacheRead ?? p.in) + output * p.out) / 1_000_000;
  return round6(cost);
}

type SpanType = SpanRecord["type"];
type Role = MessageRecord["role"];
interface Msg {
  role: Role;
  content: string;
  tokens?: number;
  metadata?: Record<string, unknown>;
}
interface BuiltTrace {
  trace: TraceRecord;
  spans: SpanRecord[];
  messages: MessageRecord[];
  waste: WasteReportRecord[];
}

interface AddOpts {
  type: SpanType;
  name: string;
  durSec: number;
  parent?: string | null;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheCreation?: number;
  provider?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolSuccess?: boolean;
  error?: string;
  langfuseType?: string;
  metadata?: Record<string, unknown>;
  messages?: Msg[];
  gapBeforeSec?: number;
  incomplete?: boolean;
}

// A small builder that assigns ids/timestamps, computes per-span cost, and rolls up trace totals.
class TraceBuilder {
  readonly traceId: string;
  readonly spans: SpanRecord[] = [];
  readonly messages: MessageRecord[] = [];
  readonly waste: WasteReportRecord[] = [];
  private t: number;
  private spanN = 0;
  private wasteN = 0;

  constructor(
    private readonly externalId: string,
    startSec: number,
    private readonly meta: {
      sessionKey?: string;
      agentId?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    this.traceId = `sample:${externalId}`;
    this.t = BASE + startSec * 1000;
  }

  add(opts: AddOpts): string {
    if (opts.gapBeforeSec) this.t += opts.gapBeforeSec * 1000;
    const id = `${this.traceId}:s${this.spanN}`;
    const externalId = `${this.externalId}-s${this.spanN}`;
    this.spanN += 1;

    const start = new Date(this.t);
    this.t += opts.durSec * 1000;
    const end = new Date(this.t);

    const isLlm = opts.type === "llm";
    const isTool = opts.type === "tool";
    const model = opts.model ?? null;
    const provider = opts.provider ?? (model ? (PRICES[model]?.provider ?? null) : null);
    const inputTokens = opts.inputTokens ?? null;
    const outputTokens = opts.outputTokens ?? null;
    const costUsd =
      isLlm && model && (inputTokens !== null || outputTokens !== null)
        ? genCost(model, inputTokens ?? 0, outputTokens ?? 0, opts.cacheRead ?? 0)
        : null;

    const metadata: Record<string, unknown> = { ...(opts.metadata ?? {}) };
    if (opts.langfuseType) metadata.langfuseType = opts.langfuseType;
    if (opts.cacheRead !== undefined) metadata.cacheRead = opts.cacheRead;
    if (opts.cacheCreation !== undefined) metadata.cacheCreationTokens = opts.cacheCreation;

    this.spans.push({
      id,
      traceId: this.traceId,
      parentSpanId: opts.parent ?? null,
      externalId,
      type: opts.type,
      name: opts.name,
      startedAt: start,
      endedAt: opts.incomplete ? null : end,
      durationMs: opts.incomplete ? null : end.getTime() - start.getTime(),
      model,
      provider,
      inputTokens,
      outputTokens,
      costUsd,
      toolName: isTool ? (opts.toolName ?? opts.name) : null,
      toolInput: isTool && opts.toolInput !== undefined ? jstr(opts.toolInput) : null,
      toolOutput: isTool && opts.toolOutput !== undefined ? jstr(opts.toolOutput) : null,
      toolSuccess: isTool ? (opts.error ? false : (opts.toolSuccess ?? true)) : null,
      status: opts.error ? "error" : "ok",
      errorMessage: opts.error ?? null,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
    });

    let pos = 0;
    for (const m of opts.messages ?? []) {
      this.messages.push({
        id: `${id}:m${pos}`,
        spanId: id,
        traceId: this.traceId,
        role: m.role,
        content: m.content,
        tokenCount: m.tokens ?? null,
        position: pos,
        metadata: m.metadata ?? null,
      });
      pos += 1;
    }
    return id;
  }

  wasteRep(opts: {
    spanId?: string | null;
    category: WasteReportRecord["category"];
    severity: WasteReportRecord["severity"];
    wastedTokens: number;
    wastedCostUsd: number;
    description: string;
    recommendation: string;
    estimatedSavingsUsd?: number;
    evidence: Record<string, unknown>;
  }): void {
    this.waste.push({
      id: `${this.traceId}:w${this.wasteN}`,
      traceId: this.traceId,
      spanId: opts.spanId ?? null,
      category: opts.category,
      severity: opts.severity,
      wastedTokens: opts.wastedTokens,
      wastedCostUsd: round6(opts.wastedCostUsd),
      description: opts.description,
      recommendation: opts.recommendation,
      estimatedSavingsUsd: round6(opts.estimatedSavingsUsd ?? opts.wastedCostUsd),
      evidence: opts.evidence,
      detectedAt: new Date(this.t),
    });
    this.wasteN += 1;
  }

  finalize(statusOverride?: TraceRecord["status"]): BuiltTrace {
    // Envelope: make every container span's time range cover its descendants, so the waterfall
    // renders parents spanning their children (as Langfuse/LangSmith trace UIs do) instead of a
    // sliver at the start. Leaf spans (and incomplete ones with no children) keep their own range.
    const childMap = new Map<string | null, SpanRecord[]>();
    for (const s of this.spans) {
      const list = childMap.get(s.parentSpanId);
      if (list) list.push(s);
      else childMap.set(s.parentSpanId, [s]);
    }
    const envelope = (s: SpanRecord): { start: number; end: number } => {
      let start = s.startedAt.getTime();
      let end = (s.endedAt ?? s.startedAt).getTime();
      const kids = childMap.get(s.id) ?? [];
      for (const child of kids) {
        const r = envelope(child);
        if (r.start < start) start = r.start;
        if (r.end > end) end = r.end;
      }
      if (kids.length > 0) {
        s.startedAt = new Date(start);
        s.endedAt = new Date(end);
        s.durationMs = end - start;
      }
      return { start, end };
    };
    for (const root of childMap.get(null) ?? []) envelope(root);

    const llmish = this.spans.filter((s) => s.type === "llm");
    const totalInputTokens = sum(llmish.map((s) => s.inputTokens ?? 0));
    const totalOutputTokens = sum(llmish.map((s) => s.outputTokens ?? 0));
    const totalCostUsd = round6(sum(this.spans.map((s) => s.costUsd ?? 0)));
    const anyError = this.spans.some((s) => s.status === "error");
    const startedAt = new Date(Math.min(...this.spans.map((s) => s.startedAt.getTime())));
    const endedAt = new Date(
      Math.max(...this.spans.map((s) => (s.endedAt ?? s.startedAt).getTime())),
    );

    const counts = new Map<string, number>();
    for (const s of llmish) if (s.model) counts.set(s.model, (counts.get(s.model) ?? 0) + 1);
    const model = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    const trace: TraceRecord = {
      id: this.traceId,
      externalId: this.externalId,
      source: "sample",
      startedAt,
      endedAt,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      status: statusOverride ?? (anyError ? "error" : "complete"),
      ingestedAt: new Date(),
      ...(this.meta.sessionKey ? { sessionKey: this.meta.sessionKey } : {}),
      ...(this.meta.agentId ? { agentId: this.meta.agentId } : {}),
      ...(model ? { model } : {}),
      ...(this.meta.metadata ? { metadata: this.meta.metadata } : {}),
    };
    return { trace, spans: this.spans, messages: this.messages, waste: this.waste };
  }
}

// ===========================================================================
// 1) Customer-support RAG agent — multi-turn session (one trace per turn).
// ===========================================================================
function supportTurn(turn: number, startSec: number, question: string, answer: string): BuiltTrace {
  const cacheRead = turn === 1 ? 0 : 2600 + turn * 200; // cached system prompt + history on later turns
  const tb = new TraceBuilder(`support-thread-8842-turn${turn}`, startSec, {
    sessionKey: "support-thread-8842",
    agentId: "support-bot-v3",
    metadata: {
      environment: "production",
      tags: ["support", "prod", "tier-2"],
      userId: "user_5521",
      release: "2026.5.1",
      turn,
    },
  });
  const root = tb.add({
    type: "agent",
    name: "support-agent",
    durSec: 0.05,
    langfuseType: "agent",
  });
  tb.add({
    type: "llm",
    name: "embed-query",
    durSec: 0.2,
    parent: root,
    model: "text-embedding-3-small",
    inputTokens: 14,
    outputTokens: 0,
    langfuseType: "embedding",
    metadata: { dimensions: 1536 },
  });
  tb.add({
    type: "retrieval",
    name: "kb-search",
    durSec: 0.4,
    parent: root,
    langfuseType: "retriever",
    metadata: {
      query: question,
      top_k: 5,
      embedding_model: "text-embedding-3-small",
      documents: [
        { id: "kb_142", title: "Refund policy", score: 0.91 },
        { id: "kb_207", title: "Order tracking", score: 0.78 },
        { id: "kb_061", title: "Shipping windows", score: 0.66 },
      ],
    },
  });
  const usesTool = turn === 2;
  const answerSpan = tb.add({
    type: "llm",
    name: "answer-grounded",
    durSec: 1.6,
    parent: root,
    model: "gpt-4o",
    inputTokens: 3800 + turn * 250,
    outputTokens: 210,
    cacheRead,
    metadata: { temperature: 0.2, finish_reason: usesTool ? "tool_calls" : "stop" },
    messages: usesTool
      ? [
          {
            role: "system",
            content:
              "You are Acme Support. Answer only from the provided KB context; if an order lookup is needed, call order_lookup.",
            tokens: 2600,
          },
          { role: "user", content: question, tokens: 22 },
          {
            role: "assistant",
            content: 'Calling order_lookup({"order_id":"AC-99812"})',
            tokens: 18,
          },
          {
            role: "tool",
            content: '{"status":"shipped","carrier":"UPS","eta":"2026-05-31"}',
            tokens: 30,
          },
          { role: "assistant", content: answer, tokens: 192 },
        ]
      : [
          {
            role: "system",
            content: "You are Acme Support. Answer only from the provided KB context.",
            tokens: 2600,
          },
          { role: "user", content: question, tokens: 22 },
          { role: "assistant", content: answer, tokens: 210 },
        ],
  });
  if (usesTool) {
    tb.add({
      type: "tool",
      name: "order_lookup",
      durSec: 0.5,
      parent: root,
      toolInput: { order_id: "AC-99812" },
      toolOutput: { status: "shipped", carrier: "UPS", eta: "2026-05-31" },
      toolSuccess: true,
    });
  }
  if (turn === 1) {
    tb.wasteRep({
      spanId: answerSpan,
      category: "low_cache_utilization",
      severity: "medium",
      wastedTokens: 2600,
      wastedCostUsd: round6(genCost("gpt-4o", 2600, 0) - genCost("gpt-4o", 0, 0, 2600)),
      description:
        "The 2.6k-token system prompt + KB instructions are sent uncached on the first turn of a session that runs many turns.",
      recommendation:
        "Mark the static system/KB preamble as a cache breakpoint so turns 2+ replay it as cache_read (~10x cheaper).",
      evidence: {
        systemPromptTokens: 2600,
        cacheRead: 0,
        sessionTurns: 3,
        spanName: "answer-grounded",
      },
    });
  }
  return tb.finalize();
}

// ===========================================================================
// 2) Multi-agent research — planner + 4 worker agents (deep nesting, tool loops).
// ===========================================================================
function multiAgentResearch(): BuiltTrace {
  const tb = new TraceBuilder("research-multiagent-stylegan", 600, {
    sessionKey: "research-run-77",
    agentId: "deep-research-orchestrator",
    metadata: {
      environment: "production",
      tags: ["research", "multi-agent", "gaia"],
      userId: "analyst_22",
      question: "Which 2019 paper introduced StyleGAN and what FID did it report on FFHQ?",
    },
  });
  const root = tb.add({ type: "agent", name: "orchestrator", durSec: 0.1, langfuseType: "agent" });
  tb.add({
    type: "llm",
    name: "plan-decompose",
    durSec: 2.1,
    parent: root,
    model: "gpt-4o",
    inputTokens: 1200,
    outputTokens: 320,
    messages: [
      {
        role: "system",
        content:
          "You are a research orchestrator. Decompose the question into independent sub-tasks and dispatch workers.",
        tokens: 210,
      },
      {
        role: "user",
        content: "Which 2019 paper introduced StyleGAN and what FID did it report on FFHQ?",
        tokens: 28,
      },
      {
        role: "assistant",
        content:
          "Plan: (1) identify the paper, (2) find FID on FFHQ, (3) confirm venue/year, (4) cross-check a 2nd source. Dispatching 4 workers.",
        tokens: 82,
      },
    ],
  });

  const topics = [
    { topic: "identify the StyleGAN paper", query: "StyleGAN 2019 paper authors" },
    { topic: "find reported FID on FFHQ", query: "StyleGAN FID FFHQ score" },
    { topic: "confirm publication venue/year", query: "StyleGAN CVPR 2019" },
    { topic: "cross-check second source", query: "StyleGAN FID 4.40 FFHQ" },
  ];
  let overuseSpan = "";
  topics.forEach((w, i) => {
    const worker = tb.add({
      type: "agent",
      name: `worker-${i + 1}`,
      durSec: 0.05,
      parent: root,
      langfuseType: "agent",
      metadata: { subtask: w.topic },
    });
    tb.add({
      type: "llm",
      name: "gen-search-query",
      durSec: 0.7,
      parent: worker,
      model: "gpt-4o-mini",
      inputTokens: 420,
      outputTokens: 40,
      messages: [
        {
          role: "system",
          content: `Sub-task: ${w.topic}. Produce one web search query.`,
          tokens: 60,
        },
        { role: "assistant", content: w.query, tokens: 12 },
      ],
    });
    tb.add({
      type: "tool",
      name: "web_search",
      durSec: 1.3,
      parent: worker,
      toolInput: { query: w.query, top_k: 5 },
      toolOutput: {
        count: 5,
        results: [
          {
            title: "A Style-Based Generator Architecture for GANs",
            url: "https://arxiv.org/abs/1812.04948",
          },
        ],
      },
      toolSuccess: true,
    });
    tb.add({
      type: "llm",
      name: "read-extract",
      durSec: 1.5,
      parent: worker,
      model: "gpt-4o-mini",
      inputTokens: 2600,
      outputTokens: 140,
      cacheRead: i > 0 ? 1800 : 0,
      messages: [
        {
          role: "system",
          content: "Extract the answer to the sub-task from the search results.",
          tokens: 55,
        },
        { role: "user", content: "<5 search snippets, ~2.4k tokens of page text>", tokens: 2400 },
        {
          role: "assistant",
          content: `Finding for "${w.topic}": StyleGAN, Karras et al., 2019.`,
          tokens: 120,
        },
      ],
    });
    // Worker 2 loops one extra time on the wrong model (agent_loop + model_overuse).
    if (i === 1) {
      tb.add({
        type: "tool",
        name: "web_search",
        durSec: 1.1,
        parent: worker,
        toolInput: { query: "StyleGAN FID FFHQ 4.40 reproduce", top_k: 5 },
        toolOutput: { count: 0, results: [] },
        toolSuccess: true,
        metadata: { iteration: 2, note: "low-confidence, re-querying" },
      });
      overuseSpan = tb.add({
        type: "llm",
        name: "read-extract",
        durSec: 1.5,
        parent: worker,
        model: "gpt-4o",
        inputTokens: 3000,
        outputTokens: 160,
        messages: [
          {
            role: "system",
            content: "Re-extract the FID with higher reasoning effort.",
            tokens: 55,
          },
          { role: "assistant", content: "Confirmed FID 4.40 on FFHQ at 1024×1024.", tokens: 130 },
        ],
      });
    }
  });

  tb.add({
    type: "llm",
    name: "synthesize-answer",
    durSec: 3.2,
    parent: root,
    model: "gpt-4o",
    inputTokens: 3400,
    outputTokens: 380,
    cacheRead: 1200,
    messages: [
      {
        role: "system",
        content: "Synthesize the workers' findings into a final grounded answer with citations.",
        tokens: 240,
      },
      { role: "user", content: "<4 worker findings, ~2.6k tokens>", tokens: 2900 },
      {
        role: "assistant",
        content:
          "StyleGAN (Karras et al., CVPR 2019) reported FID 4.40 on FFHQ at 1024×1024. Confirmed across two sources.",
        tokens: 96,
      },
    ],
  });

  tb.wasteRep({
    spanId: overuseSpan,
    category: "model_overuse",
    severity: "medium",
    wastedTokens: 3000,
    wastedCostUsd: round6(genCost("gpt-4o", 3000, 160) - genCost("gpt-4o-mini", 3000, 160)),
    description:
      "A worker re-ran snippet extraction on gpt-4o where gpt-4o-mini handled the same step fine.",
    recommendation:
      "Pin worker extraction steps to gpt-4o-mini; reserve gpt-4o for the synthesis step only.",
    evidence: {
      spanName: "read-extract",
      model: "gpt-4o",
      cheaperModel: "gpt-4o-mini",
      inputTokens: 3000,
      outputTokens: 160,
    },
  });
  tb.wasteRep({
    category: "agent_loop",
    severity: "low",
    wastedTokens: 3200,
    wastedCostUsd: 0.012,
    description:
      "Worker 2 ran an extra search+extract iteration that returned 0 new results before converging.",
    recommendation: "Cap fact-lookup workers at 1 iteration and add a no-new-results early stop.",
    evidence: { worker: "worker-2", iterations: 2, secondIterationResults: 0 },
  });
  return tb.finalize();
}

// ===========================================================================
// 3) Coding / ReAct agent — write-code → run-code loop with failures + caching.
// ===========================================================================
function codingAgent(): BuiltTrace {
  const tb = new TraceBuilder("coding-react-swebench", 1200, {
    sessionKey: "swe-task-4471",
    agentId: "codeact-agent",
    metadata: {
      environment: "production",
      tags: ["coding", "react", "swe-bench"],
      repo: "acme/billing",
      task: "fix failing test test_proration_rounding",
    },
  });
  const root = tb.add({ type: "agent", name: "codeact-agent", durSec: 0.1, langfuseType: "agent" });
  const outcomes = [
    { ok: false, err: "AssertionError: expected 12.34 got 12.35 (1 failed)" },
    { ok: false, err: "AssertionError: expected 12.34 got 12.33 (1 failed)" },
    { ok: false, err: "TypeError: unsupported operand type 'Decimal' and 'float'" },
    { ok: true, err: null },
  ];
  outcomes.forEach((o, i) => {
    const first = i === 0;
    tb.add({
      type: "llm",
      name: "write-patch",
      durSec: 2.4,
      parent: root,
      model: "claude-sonnet-4-5",
      inputTokens: 5200 + i * 1400, // context grows each iteration (context bloat)
      outputTokens: 320,
      cacheCreation: first ? 4800 : 0,
      cacheRead: first ? 0 : 4800,
      metadata: { iteration: i + 1, finish_reason: "tool_calls" },
      messages: [
        {
          role: "system",
          content: "You are a coding agent. Edit files and run the test suite until it passes.",
          tokens: 4800,
        },
        {
          role: "user",
          content:
            i === 0
              ? "Fix test_proration_rounding in billing/proration.py"
              : `Previous run failed: ${outcomes[i - 1]?.err}`,
          tokens: 60 + i * 40,
        },
        {
          role: "assistant",
          content: "Editing proration.py to use Decimal.quantize(ROUND_HALF_UP); running tests.",
          tokens: 220,
        },
      ],
    });
    tb.add({
      type: "tool",
      name: "run_python",
      durSec: 3.1,
      parent: root,
      toolInput: { cmd: "pytest tests/test_proration.py -q" },
      toolOutput: o.ok ? { exit: 0, stdout: "1 passed in 0.42s" } : { exit: 1, stderr: o.err },
      toolSuccess: o.ok,
      ...(o.ok ? {} : { error: o.err ?? "run_python failed" }),
      metadata: { iteration: i + 1 },
    });
    if (!o.ok) {
      tb.add({
        type: "llm",
        name: "interpret-failure",
        durSec: 1.1,
        parent: root,
        model: "claude-sonnet-4-5",
        inputTokens: 2200 + i * 300,
        outputTokens: 110,
        cacheRead: 4800,
        messages: [
          {
            role: "system",
            content: "Interpret the test failure and decide the next edit.",
            tokens: 80,
          },
          { role: "tool", content: o.err ?? "", tokens: 40 },
          {
            role: "assistant",
            content: "Rounding mode is wrong; switch to ROUND_HALF_UP and cast float to Decimal.",
            tokens: 96,
          },
        ],
      });
    }
  });

  tb.wasteRep({
    category: "tool_failure_waste",
    severity: "high",
    wastedTokens: 9800,
    wastedCostUsd: 0.18,
    description:
      "3 of 4 test runs failed; each failed iteration re-sent the growing context and a fresh generation before the patch converged.",
    recommendation:
      "Add a static analysis / type-check pre-step before running the full suite to catch the Decimal/float type error without a failed pytest cycle.",
    evidence: {
      totalIterations: 4,
      failedIterations: 3,
      failureReasons: ["rounding", "rounding", "type-error"],
    },
  });
  tb.wasteRep({
    category: "low_cache_utilization",
    severity: "low",
    wastedTokens: 4800,
    wastedCostUsd: round6(
      genCost("claude-sonnet-4-5", 4800, 0) - genCost("claude-sonnet-4-5", 0, 0, 4800),
    ),
    description:
      "First iteration paid full price to create the cache; acceptable, but the system prompt is regenerated per task rather than shared across tasks in the session.",
    recommendation:
      "Persist the cached system prompt across tasks in a session to amortize the cache-creation cost.",
    evidence: { cacheCreationTokens: 4800, iterations: 4 },
  });
  return tb.finalize();
}

// ===========================================================================
// 4) Long cached chat — one session, many turns, big cache_read + a cache-expiry gap.
// ===========================================================================
function longCachedChat(): BuiltTrace[] {
  const traces: BuiltTrace[] = [];
  const turns = [
    { gapSec: 0, fresh: 9200, cacheRead: 0, cacheCreation: 9000, note: "cold start" },
    { gapSec: 40, fresh: 600, cacheRead: 9000, cacheCreation: 0, note: "warm" },
    { gapSec: 55, fresh: 900, cacheRead: 9600, cacheCreation: 0, note: "warm, history grew" },
    {
      gapSec: 600,
      fresh: 11200,
      cacheRead: 0,
      cacheCreation: 11000,
      note: "cache expired (>5m idle)",
    },
  ];
  let at = 1800;
  turns.forEach((t, i) => {
    at += t.gapSec;
    const tb = new TraceBuilder(`assistant-chat-1191-turn${i + 1}`, at, {
      sessionKey: "chat-sess-1191",
      agentId: "doc-assistant",
      metadata: {
        environment: "production",
        tags: ["assistant", "chat"],
        userId: "user_3390",
        turn: i + 1,
        note: t.note,
      },
    });
    const root = tb.add({ type: "agent", name: "assistant", durSec: 0.05, langfuseType: "agent" });
    const gen = tb.add({
      type: "llm",
      name: "chat-completion",
      durSec: 2.0,
      parent: root,
      model: "claude-sonnet-4-5",
      inputTokens: t.fresh + t.cacheRead,
      outputTokens: 260,
      cacheRead: t.cacheRead,
      cacheCreation: t.cacheCreation,
      metadata: { temperature: 0.4, finish_reason: "stop" },
      messages: [
        {
          role: "system",
          content: "You are a documentation assistant grounded in a 9k-token product manual.",
          tokens: 9000,
        },
        {
          role: "user",
          content: `Follow-up question #${i + 1} about the billing API.`,
          tokens: 40,
        },
        {
          role: "assistant",
          content: "Here's how that works, referencing section 4.2 of the manual…",
          tokens: 260,
        },
      ],
    });
    if (i === 3) {
      tb.wasteRep({
        spanId: gen,
        category: "cache_expiry",
        severity: "high",
        wastedTokens: 11000,
        wastedCostUsd: round6(
          genCost("claude-sonnet-4-5", 11000, 0) - genCost("claude-sonnet-4-5", 0, 0, 11000),
        ),
        description:
          "A 10-minute idle gap expired the prompt cache, so turn 4 re-paid full input price for the 11k-token context instead of cache_read.",
        recommendation:
          "Use a longer cache TTL (1h breakpoint) for slow human-paced chats, or pre-warm the cache before resuming.",
        evidence: { idleSeconds: 600, cacheTtlSeconds: 300, contextTokens: 11000, cacheRead: 0 },
      });
    }
    if (i === 2) {
      tb.wasteRep({
        spanId: gen,
        category: "unbounded_history",
        severity: "low",
        wastedTokens: 600,
        wastedCostUsd: 0.0008,
        description:
          "Conversation history is replayed in full each turn and is growing unbounded; cheap now due to caching, but will erode the cache hit-rate over a long session.",
        recommendation: "Summarize or window older turns once history exceeds ~12k tokens.",
        evidence: { turn: 3, historyGrowthTokens: 600, strategy: "none" },
      });
    }
    traces.push(tb.finalize());
  });
  return traces;
}

// ===========================================================================
// 5) Retry / tool-storm — fault showcase: flaky tool retried to death + retrieval thrash.
// ===========================================================================
function retryStorm(): BuiltTrace {
  const tb = new TraceBuilder("retry-toolstorm-incident", 4000, {
    sessionKey: "incident-2026-05-29",
    agentId: "ops-agent",
    metadata: {
      environment: "production",
      tags: ["ops", "incident", "retry-storm"],
      userId: "svc_account",
      incident: "provider outage triggered runaway retries",
    },
  });
  const root = tb.add({ type: "agent", name: "ops-agent", durSec: 0.1, langfuseType: "agent" });
  tb.add({
    type: "llm",
    name: "plan",
    durSec: 1.4,
    parent: root,
    model: "gpt-4o",
    inputTokens: 1100,
    outputTokens: 180,
    messages: [
      {
        role: "system",
        content: "Resolve the incident: fetch metrics, then summarize root cause.",
        tokens: 240,
      },
      { role: "user", content: "Latency p99 spiked at 14:02; find why.", tokens: 30 },
      {
        role: "assistant",
        content: "Fetching metrics via metrics_api, then I'll correlate deploys.",
        tokens: 60,
      },
    ],
  });
  // Step 1: a "fetch metrics" sub-step whose flaky tool is retried 8x with exponential backoff —
  // all error (system-execution fault). Nesting the retries under the step makes the storm read as
  // a multi-step waterfall (the step bar spans all 8 attempts) rather than 8 loose siblings.
  const fetchStep = tb.add({
    type: "agent",
    name: "fetch-metrics",
    durSec: 0.05,
    parent: root,
    langfuseType: "chain",
    metadata: { step: "fetch metrics (with retry)" },
  });
  for (let i = 0; i < 8; i++) {
    tb.add({
      type: "tool",
      name: "metrics_api",
      durSec: 2 + i * 0.3,
      gapBeforeSec: i === 0 ? 0 : 2 ** i,
      parent: fetchStep,
      toolInput: { metric: "latency_p99", from: "14:00", to: "14:10", attempt: i + 1 },
      toolOutput: { error: "503 Service Unavailable", upstream: "metrics-gateway" },
      toolSuccess: false,
      error: `metrics_api 503 Service Unavailable (attempt ${i + 1})`,
      metadata: { attempt: i + 1, backoffSec: i === 0 ? 0 : 2 ** i },
    });
  }
  // Step 2: after the storm, a "correlate deploys" sub-step re-queries the retriever 6x with
  // near-duplicate queries (retrieval thrash), nested under its own step.
  const correlateStep = tb.add({
    type: "agent",
    name: "correlate-deploys",
    durSec: 0.05,
    parent: root,
    langfuseType: "chain",
    metadata: { step: "correlate deploy log (thrash)" },
  });
  const queries = [
    "deploy events around 14:02",
    "deployments near 14:00 to 14:05",
    "recent deploys 14:02 incident",
    "what deployed at 14:02",
    "deploy log 14:02 latency",
    "deployments 14:00-14:10 service mesh",
  ];
  queries.forEach((q, i) => {
    tb.add({
      type: "retrieval",
      name: "deploy-log-search",
      durSec: 0.5,
      parent: correlateStep,
      langfuseType: "retriever",
      metadata: {
        query: q,
        top_k: 5,
        docCount: i < 2 ? 2 : 1,
        note: "oscillating query, not converging",
      },
    });
  });
  // Agent gives up — parent marked error (cascade).
  tb.add({
    type: "llm",
    name: "give-up-summary",
    durSec: 1.2,
    parent: root,
    model: "gpt-4o",
    inputTokens: 2400,
    outputTokens: 140,
    error: "aborted: metrics_api unavailable after 8 retries",
    messages: [
      { role: "system", content: "Summarize findings.", tokens: 220 },
      {
        role: "assistant",
        content: "Unable to fetch metrics after 8 attempts; escalating to on-call.",
        tokens: 120,
      },
    ],
  });

  tb.wasteRep({
    category: "retry_waste",
    severity: "critical",
    wastedTokens: 0,
    wastedCostUsd: 0.0,
    description:
      "metrics_api was retried 8 times against a 503ing upstream with exponential backoff and no circuit breaker — 8 wasted tool calls over ~4 minutes.",
    recommendation:
      "Add a circuit breaker: stop after 3 failures, fail fast, and surface the upstream outage instead of looping.",
    estimatedSavingsUsd: 0.0,
    evidence: {
      tool: "metrics_api",
      attempts: 8,
      allFailed: true,
      upstream: "503",
      hardKillThreshold: 30,
    },
  });
  tb.wasteRep({
    category: "duplicate_rag",
    severity: "high",
    wastedTokens: 7200,
    wastedCostUsd: 0.024,
    description:
      "deploy-log-search ran 6 times with near-duplicate queries (retrieval thrash) without converging; p95 retrieval iterations should be <6.",
    recommendation: "Deduplicate semantically-similar queries and cap retrieval iterations at 3.",
    evidence: { retrievalIterations: 6, distinctResults: 2, thrashThreshold: 6 },
  });
  tb.wasteRep({
    category: "agent_loop",
    severity: "high",
    wastedTokens: 2400,
    wastedCostUsd: 0.012,
    description:
      "The agent never converged and aborted, after 14 tool/retrieval calls on one request (>10 = investigate).",
    recommendation:
      "Bound total tool calls per request and exit with a partial answer instead of looping.",
    evidence: { totalToolCalls: 14, investigateThreshold: 10, outcome: "aborted" },
  });
  return tb.finalize();
}

// ===========================================================================
// 6) RAG empty-retrieval → hallucination → tool error (upstream-data fault, FAILED).
// ===========================================================================
function ragEmptyRetrievalFail(): BuiltTrace {
  const tb = new TraceBuilder("rag-empty-retrieval-fail", 5200, {
    sessionKey: "qa-thread-3",
    agentId: "qa-agent",
    metadata: {
      environment: "production",
      tags: ["qa", "rag"],
      userId: "user_8810",
      faultClass: "upstream_data",
    },
  });
  const root = tb.add({ type: "agent", name: "qa-agent", durSec: 0.05, langfuseType: "agent" });
  tb.add({
    type: "llm",
    name: "embed-query",
    durSec: 0.2,
    parent: root,
    model: "text-embedding-3-small",
    inputTokens: 18,
    outputTokens: 0,
    langfuseType: "embedding",
  });
  const retr = tb.add({
    type: "retrieval",
    name: "kb-search",
    durSec: 0.4,
    parent: root,
    langfuseType: "retriever",
    metadata: {
      query: "what is the 2026 enterprise SSO price?",
      top_k: 5,
      docCount: 0,
      note: "index missing the pricing namespace",
    },
  });
  const gen = tb.add({
    type: "llm",
    name: "answer",
    durSec: 2.2,
    parent: root,
    model: "gpt-4o",
    inputTokens: 900,
    outputTokens: 540, // long, confident, hallucinated answer
    metadata: { temperature: 0.7, finish_reason: "stop", grounded: false },
    messages: [
      {
        role: "system",
        content: "Answer from KB context only. If no context, say you don't know.",
        tokens: 320,
      },
      { role: "user", content: "What is the 2026 enterprise SSO price?", tokens: 16 },
      {
        role: "assistant",
        content:
          "Enterprise SSO is $4,800/yr per 100 seats with volume tiers… (fabricated — no docs were retrieved)",
        tokens: 540,
      },
    ],
  });
  tb.add({
    type: "tool",
    name: "create_quote",
    durSec: 0.6,
    parent: root,
    toolInput: { plan: "enterprise-sso", annual_price: 4800 },
    toolOutput: { error: "validation failed: price 4800 not in catalog" },
    toolSuccess: false,
    error: "create_quote validation failed: hallucinated price not in catalog",
  });

  tb.wasteRep({
    spanId: gen,
    category: "high_output",
    severity: "medium",
    wastedTokens: 540,
    wastedCostUsd: round6(genCost("gpt-4o", 0, 540)),
    description:
      "With 0 retrieved documents the model produced a 540-token confident (hallucinated) answer instead of abstaining — the downstream create_quote then failed validation.",
    recommendation:
      "Short-circuit to an 'insufficient context' response when retrieval returns 0 docs; this is the decisive upstream-data fault.",
    evidence: {
      retrievedDocs: 0,
      outputTokens: 540,
      grounded: false,
      faultSpan: retr,
      downstreamFailure: "create_quote",
    },
  });
  return tb.finalize();
}

// ===========================================================================
// 7) Partial / cancelled run (status = "partial").
// ===========================================================================
function partialCancelled(): BuiltTrace {
  const tb = new TraceBuilder("partial-cancelled-run", 6000, {
    sessionKey: "batch-job-55",
    agentId: "etl-agent",
    metadata: {
      environment: "staging",
      tags: ["etl", "batch"],
      cancelledBy: "user",
      reason: "timeout budget exceeded",
    },
  });
  const root = tb.add({ type: "agent", name: "etl-agent", durSec: 0.05, langfuseType: "agent" });
  tb.add({
    type: "llm",
    name: "plan-extraction",
    durSec: 1.3,
    parent: root,
    model: "gpt-4o-mini",
    inputTokens: 800,
    outputTokens: 120,
    messages: [
      { role: "system", content: "Plan an ETL extraction over the uploaded CSVs.", tokens: 140 },
      { role: "assistant", content: "Will process 12 files sequentially.", tokens: 40 },
    ],
  });
  tb.add({
    type: "tool",
    name: "load_csv",
    durSec: 0.9,
    parent: root,
    toolInput: { file: "part-001.csv" },
    toolOutput: { rows: 12044 },
    toolSuccess: true,
  });
  tb.add({
    type: "tool",
    name: "load_csv",
    durSec: 0.9,
    parent: root,
    toolInput: { file: "part-002.csv" },
    toolOutput: { rows: 11890 },
    toolSuccess: true,
  });
  // Cancelled mid-flight: this long-running tool never completed (no endedAt).
  tb.add({
    type: "tool",
    name: "transform_batch",
    durSec: 0,
    parent: root,
    toolInput: { file: "part-003.csv", op: "normalize+dedupe" },
    incomplete: true,
    metadata: { state: "running", cancelled: true },
  });
  return tb.finalize("partial");
}

// ---- assemble + seed -------------------------------------------------------
const SAMPLES: BuiltTrace[] = [
  supportTurn(
    1,
    0,
    "What's your refund window?",
    "Our refund window is 30 days from delivery for unopened items.",
  ),
  supportTurn(
    2,
    120,
    "Where is my order AC-99812?",
    "Your order AC-99812 shipped via UPS and is expected 2026-05-31.",
  ),
  supportTurn(
    3,
    300,
    "Can I change the shipping address now?",
    "Since it has shipped, the address can't be changed; you can request a redirect via UPS My Choice.",
  ),
  multiAgentResearch(),
  codingAgent(),
  ...longCachedChat(),
  retryStorm(),
  ragEmptyRetrievalFail(),
  partialCancelled(),
];

const db = createDb(dbPath);
migrate(db);
const traceRepo = createTraceRepository(db);
const spanRepo = createSpanRepository(db);
const messageRepo = createMessageRepository(db);
const wasteRepo = createWasteReportRepository(db);
const sqlite = getSqliteClient(db);

// Clean slate: drop any previously-seeded sample data (child→parent order, FK-safe) so re-running
// this script doesn't leave stale traces from an older version behind.
sqlite.run(
  "DELETE FROM waste_reports WHERE trace_id IN (SELECT id FROM traces WHERE source = 'sample')",
);
sqlite.run(
  "DELETE FROM messages WHERE trace_id IN (SELECT id FROM traces WHERE source = 'sample')",
);
sqlite.run("DELETE FROM spans WHERE trace_id IN (SELECT id FROM traces WHERE source = 'sample')");
sqlite.run("DELETE FROM traces WHERE source = 'sample'");

let spanTotal = 0;
let messageTotal = 0;
let wasteTotal = 0;
for (const sample of SAMPLES) {
  sqlite.transaction(() => {
    traceRepo.upsert(sample.trace);
    for (const s of sample.spans) spanRepo.upsert(s);
    for (const m of sample.messages) messageRepo.upsert(m);
    for (const w of sample.waste) wasteRepo.upsert(w);
  })();
  spanTotal += sample.spans.length;
  messageTotal += sample.messages.length;
  wasteTotal += sample.waste.length;
}

sqlite.close(false);

console.log(`Seeded ${SAMPLES.length} sample traces → ${dbPath}`);
console.log(`  ${spanTotal} spans, ${messageTotal} messages, ${wasteTotal} waste reports.`);
console.log(`  View:  langcost dashboard --db ${dbPath}`);
