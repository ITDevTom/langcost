import { desc, eq, inArray } from "drizzle-orm";

import type { Db } from "../client";
import { faultReports } from "../schema";

export type FaultReportRecord = typeof faultReports.$inferInsert;
type FaultReportRow = typeof faultReports.$inferSelect;

function toRow(record: FaultReportRecord): FaultReportRecord {
  return {
    ...record,
    rootCauseSpanId: record.rootCauseSpanId ?? null,
  };
}

function fromRow(row: FaultReportRow): FaultReportRow {
  return row;
}

export function createFaultReportRepository(db: Db) {
  return {
    upsert(record: FaultReportRecord): void {
      const row = toRow(record);
      db.insert(faultReports)
        .values(row)
        .onConflictDoUpdate({
          target: faultReports.id,
          set: {
            traceId: row.traceId,
            faultSpanId: row.faultSpanId,
            rootCauseSpanId: row.rootCauseSpanId,
            faultType: row.faultType,
            severity: row.severity,
            confidence: row.confidence,
            description: row.description,
            recommendation: row.recommendation,
            cascadeDepth: row.cascadeDepth,
            affectedSpanIds: row.affectedSpanIds,
            detectedAt: row.detectedAt,
          },
        })
        .run();
    },
    deleteByTraceIds(traceIds: string[]): void {
      if (traceIds.length === 0) {
        return;
      }
      const [firstTraceId] = traceIds;
      db.delete(faultReports)
        .where(
          traceIds.length === 1 && firstTraceId
            ? eq(faultReports.traceId, firstTraceId)
            : inArray(faultReports.traceId, traceIds),
        )
        .run();
    },
    list(): FaultReportRow[] {
      return db
        .select()
        .from(faultReports)
        .orderBy(desc(faultReports.detectedAt))
        .all()
        .map(fromRow);
    },
    listByTraceId(traceId: string): FaultReportRow[] {
      return db
        .select()
        .from(faultReports)
        .where(eq(faultReports.traceId, traceId))
        .orderBy(desc(faultReports.detectedAt))
        .all()
        .map(fromRow);
    },
  };
}
