import type { Trace } from "@langcost/core";
import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "../client";
import { traces } from "../schema";
import { numeric } from "./shared";

export interface TraceRecord extends Trace {
  ingestedAt: Date;
}

export interface TraceTotals {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface TraceListOptions {
  traceIds?: string[];
  since?: Date;
}

type TraceRow = typeof traces.$inferSelect;

function toRow(record: TraceRecord): typeof traces.$inferInsert {
  return {
    id: record.id,
    externalId: record.externalId,
    source: record.source,
    sessionKey: record.sessionKey ?? null,
    agentId: record.agentId ?? null,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    totalInputTokens: record.totalInputTokens,
    totalOutputTokens: record.totalOutputTokens,
    totalCostUsd: record.totalCostUsd,
    model: record.model ?? null,
    status: record.status,
    metadata: record.metadata ?? null,
    ingestedAt: record.ingestedAt,
  };
}

function fromRow(row: TraceRow): TraceRecord {
  return {
    id: row.id,
    externalId: row.externalId,
    source: row.source,
    startedAt: row.startedAt,
    totalInputTokens: row.totalInputTokens,
    totalOutputTokens: row.totalOutputTokens,
    totalCostUsd: row.totalCostUsd,
    status: row.status,
    ingestedAt: row.ingestedAt,
    ...(row.sessionKey !== null ? { sessionKey: row.sessionKey } : {}),
    ...(row.agentId !== null ? { agentId: row.agentId } : {}),
    ...(row.endedAt !== null ? { endedAt: row.endedAt } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.metadata !== null ? { metadata: row.metadata } : {}),
  };
}

export function createTraceRepository(db: Db) {
  return {
    upsert(record: TraceRecord): void {
      const row = toRow(record);
      db.insert(traces)
        .values(row)
        .onConflictDoUpdate({
          target: traces.id,
          set: {
            externalId: row.externalId,
            source: row.source,
            sessionKey: row.sessionKey,
            agentId: row.agentId,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            totalInputTokens: row.totalInputTokens,
            totalOutputTokens: row.totalOutputTokens,
            totalCostUsd: row.totalCostUsd,
            model: row.model,
            status: row.status,
            metadata: row.metadata,
            ingestedAt: row.ingestedAt,
          },
        })
        .run();
    },
    getById(id: string): TraceRecord | null {
      const row = db.select().from(traces).where(eq(traces.id, id)).get();
      return row ? fromRow(row) : null;
    },
    listForAnalysis(options: TraceListOptions = {}): TraceRecord[] {
      const filters = [];

      if (options.traceIds && options.traceIds.length > 0) {
        filters.push(inArray(traces.id, options.traceIds));
      }

      if (options.since) {
        filters.push(gte(traces.startedAt, options.since));
      }

      const filter =
        filters.length === 0 ? undefined : filters.length === 1 ? filters[0] : and(...filters);

      return (filter ? db.select().from(traces).where(filter) : db.select().from(traces))
        .orderBy(desc(traces.startedAt))
        .all()
        .map(fromRow);
    },
    list(limit = 50, offset = 0): TraceRecord[] {
      return db
        .select()
        .from(traces)
        .orderBy(desc(traces.startedAt))
        .limit(limit)
        .offset(offset)
        .all()
        .map(fromRow);
    },
    count(): number {
      const row = db.select({ count: count() }).from(traces).get();
      return numeric(row?.count);
    },
    totals(): TraceTotals {
      const row = db
        .select({
          totalCostUsd: sql<number>`coalesce(sum(${traces.totalCostUsd}), 0)`,
          totalInputTokens: sql<number>`coalesce(sum(${traces.totalInputTokens}), 0)`,
          totalOutputTokens: sql<number>`coalesce(sum(${traces.totalOutputTokens}), 0)`,
        })
        .from(traces)
        .get();

      return {
        totalCostUsd: numeric(row?.totalCostUsd),
        totalInputTokens: numeric(row?.totalInputTokens),
        totalOutputTokens: numeric(row?.totalOutputTokens),
      };
    },
    getLastIngestedAt(): Date | null {
      const row = db
        .select({ ingestedAt: traces.ingestedAt })
        .from(traces)
        .orderBy(desc(traces.ingestedAt))
        .limit(1)
        .get();
      return row?.ingestedAt ?? null;
    },
    deleteByIds(ids: string[]): void {
      if (ids.length === 0) {
        return;
      }

      const [firstId] = ids;

      db.delete(traces)
        .where(ids.length === 1 && firstId ? eq(traces.id, firstId) : inArray(traces.id, ids))
        .run();
    },
  };
}
