PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_waste_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`span_id` text,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`wasted_tokens` integer NOT NULL,
	`wasted_cost_usd` real NOT NULL,
	`description` text NOT NULL,
	`recommendation` text NOT NULL,
	`estimated_savings_usd` real,
	`evidence` text NOT NULL,
	`detected_at` integer NOT NULL,
	FOREIGN KEY (`trace_id`) REFERENCES `traces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`span_id`) REFERENCES `spans`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "waste_reports_category_check" CHECK("category" in (
        'low_cache_utilization',
        'model_overuse',
        'unused_tools',
        'duplicate_rag',
        'unbounded_history',
        'uncached_prompt',
        'agent_loop',
        'retry_waste',
        'tool_failure_waste',
        'high_output',
        'oversized_context',
        'cache_expiry'
      )),
	CONSTRAINT "waste_reports_severity_check" CHECK("severity" in ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
INSERT INTO `__new_waste_reports`("id", "trace_id", "span_id", "category", "severity", "wasted_tokens", "wasted_cost_usd", "description", "recommendation", "estimated_savings_usd", "evidence", "detected_at") SELECT "id", "trace_id", "span_id", "category", "severity", "wasted_tokens", "wasted_cost_usd", "description", "recommendation", "estimated_savings_usd", "evidence", "detected_at" FROM `waste_reports`;--> statement-breakpoint
DROP TABLE `waste_reports`;--> statement-breakpoint
ALTER TABLE `__new_waste_reports` RENAME TO `waste_reports`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_waste_reports_trace_id_category` ON `waste_reports` (`trace_id`,`category`);