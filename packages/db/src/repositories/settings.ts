import { eq } from "drizzle-orm";

import type { Db } from "../client";
import { settings } from "../schema";

export interface SourceSettings {
  source?: string;
  sourcePath?: string;
  apiKey?: string;
  apiUrl?: string;
}

export type SettingRecord = typeof settings.$inferInsert;
type SettingRow = typeof settings.$inferSelect;

function fromRow(row: SettingRow): SettingRow {
  return row;
}

function toRow(record: SettingRecord): SettingRecord {
  return record;
}

const SOURCE_SETTINGS_KEY = "source_config";

export function createSettingsRepository(db: Db) {
  function setValue(key: string, value: Record<string, unknown>, updatedAt = new Date()): void {
    const row = toRow({
      key,
      value,
      updatedAt,
    });

    db.insert(settings)
      .values(row)
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: row.value,
          updatedAt: row.updatedAt,
        },
      })
      .run();
  }

  return {
    get(key: string): SettingRow | null {
      const row = db.select().from(settings).where(eq(settings.key, key)).get();
      return row ? fromRow(row) : null;
    },
    set(key: string, value: Record<string, unknown>, updatedAt = new Date()): void {
      setValue(key, value, updatedAt);
    },
    list(): SettingRow[] {
      return db.select().from(settings).all().map(fromRow);
    },
    getSourceConfig(): SourceSettings | null {
      const row = db.select().from(settings).where(eq(settings.key, SOURCE_SETTINGS_KEY)).get();
      return row?.value as SourceSettings | null;
    },
    setSourceConfig(value: SourceSettings, updatedAt = new Date()): void {
      setValue(
        SOURCE_SETTINGS_KEY,
        {
          ...(value.source ? { source: value.source } : {}),
          ...(value.sourcePath ? { sourcePath: value.sourcePath } : {}),
          ...(value.apiKey ? { apiKey: value.apiKey } : {}),
          ...(value.apiUrl ? { apiUrl: value.apiUrl } : {}),
        },
        updatedAt,
      );
    },
  };
}
