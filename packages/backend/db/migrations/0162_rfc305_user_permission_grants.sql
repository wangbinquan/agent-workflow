-- RFC-305 — one canonical account-additive permission set per user, a
-- monotonic access CAS fence, and append-only access history.
--
-- Permission ids deliberately have no CHECK enum. The shared permission
-- catalog is the evolving authority; strict module writes and fail-closed reads
-- reject values that are unknown, intrinsic, or baseline-redundant.
ALTER TABLE `users`
ADD COLUMN `access_revision` integer NOT NULL DEFAULT 0;--> statement-breakpoint

CREATE TABLE `user_permission_grants` (
	`user_id` text NOT NULL,
	`permission` text NOT NULL,
	`granted_by_user_id` text,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `permission`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_user_permission_grants_permission`
ON `user_permission_grants` (`permission`);--> statement-breakpoint

-- No target/actor FK by design: account deletion must not erase audit history.
CREATE TABLE `user_access_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`target_user_id` text NOT NULL,
	`actor_user_id` text,
	`actor_kind` text NOT NULL,
	`operation_id` text NOT NULL,
	`correlation_id` text,
	`before_role` text NOT NULL,
	`after_role` text NOT NULL,
	`added_permissions_json` text NOT NULL,
	`removed_permissions_json` text NOT NULL,
	`access_revision` integer NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_user_access_audit_target_revision`
ON `user_access_audit` (`target_user_id`, `access_revision`);--> statement-breakpoint
CREATE INDEX `idx_user_access_audit_created`
ON `user_access_audit` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_user_access_audit_operation`
ON `user_access_audit` (`operation_id`);--> statement-breakpoint

-- Append-only is a database invariant, not merely a repository convention.
-- Retention/export tooling may read this table but cannot rewrite history.
CREATE TRIGGER `user_access_audit_no_update`
BEFORE UPDATE ON `user_access_audit`
BEGIN
	SELECT RAISE(ABORT, 'user_access_audit_append_only');
END;--> statement-breakpoint
CREATE TRIGGER `user_access_audit_no_delete`
BEFORE DELETE ON `user_access_audit`
BEGIN
	SELECT RAISE(ABORT, 'user_access_audit_append_only');
END;
