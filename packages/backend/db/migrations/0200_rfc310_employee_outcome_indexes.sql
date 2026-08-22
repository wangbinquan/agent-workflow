-- RFC-310 T212: employee cards read terminal outcomes through two bounded
-- group projections. Keep both aggregations on covering indexes so opening
-- the employee directory does not scan Case or legacy Mission history.

CREATE INDEX `idx_employee_cases_state_employee_terminal`
ON `employee_cases` (`state`, `employee_id`, `terminal_kind`);--> statement-breakpoint
CREATE INDEX `idx_development_missions_status_employee`
ON `development_missions` (`status`, `employee_id`);
