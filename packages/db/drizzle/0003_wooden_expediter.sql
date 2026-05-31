ALTER TABLE `fault_reports` ADD `severity` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `fault_reports` ADD `confidence` text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE `fault_reports` ADD `recommendation` text DEFAULT '' NOT NULL;