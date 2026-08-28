ALTER TABLE `employee_cases` ADD `max_duration_ms` integer;
--> statement-breakpoint
ALTER TABLE `employee_cases` ADD `consumed_duration_ms` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `employee_cases` ADD `max_total_tokens` integer;
--> statement-breakpoint
ALTER TABLE `employee_cases` ADD `consumed_total_tokens` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `employee_case_metering_receipts` (
	`source_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`round_id` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`total_tokens` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `employee_cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_employee_case_metering_case` ON `employee_case_metering_receipts` (`case_id`,`created_at`);
