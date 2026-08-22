-- RFC-310: digital-employee Cases participate in the same task-list ownership
-- and launch-origin filters as orchestration tasks. Historical rows cannot be
-- attributed reliably, so they remain ownerless and use the neutral API origin.

ALTER TABLE `employee_cases` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `employee_cases` ADD `launch_origin` text DEFAULT 'api' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_employee_cases_owner_origin_updated`
ON `employee_cases` (`owner_user_id`, `launch_origin`, `updated_at`, `id`);
