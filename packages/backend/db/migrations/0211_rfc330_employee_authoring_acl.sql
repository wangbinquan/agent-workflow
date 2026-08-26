-- RFC-330 (1/3): employee tools / job templates become ACL resources.
--
-- Both tables carried `owner_user_id` since RFC-310, but the column was a
-- bookkeeping field: no visibility column, no acl_revision, not in
-- ACL_RESOURCE_TYPES — so every holder of `digital-employees:update` could
-- edit / publish / retire anyone's tool or template, and a private tool could
-- not exist. Existing rows backfill to 'public' so every reader keeps exactly
-- the rows they see today (proposal D12); new rows are created 'private' by
-- the application (initialPrivateResourceAcl). The SQL default is legacy /
-- raw-SQL compatibility only — same shape as 0045_rfc099_ownership_acl.sql.
ALTER TABLE `employee_tool_registrations` ADD COLUMN `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
-- json_extract raises on malformed JSON (it never reaches COALESCE), so the
-- json_valid branch is what keeps one dirty row from aborting the upgrade.
UPDATE `employee_tool_registrations`
   SET `name` = CASE
     WHEN json_valid(`draft_json`) THEN COALESCE(json_extract(`draft_json`, '$.content.displayName'), '')
     ELSE '' END;--> statement-breakpoint
ALTER TABLE `employee_tool_registrations` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_tool_registrations` ADD COLUMN `acl_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_job_templates` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_job_templates` ADD COLUMN `acl_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- RFC-330 (2/3): D17' —— the type-revision name partition gains an owner layer.
-- Today's index already forbids duplicates inside (type, revision, name), so
-- adding the owner column only LOOSENS the constraint: no existing row can
-- collide and no row is renamed. Different owners may now share a template
-- name inside one type revision; the same owner still cannot.
DROP INDEX IF EXISTS `employee_job_templates_type_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `employee_job_templates_owner_type_name_unique`
  ON `employee_job_templates` (COALESCE(`owner_user_id`, ''), `type_id`, `type_revision`, `name`);--> statement-breakpoint
-- RFC-330 (3/3): D19/D20 —— employee case members (observer / collaborator),
-- the same shape as task_collaborators. The owner stays on
-- employee_cases.owner_user_id and is never a member row. user_id is RESTRICT
-- like task_collaborators: a user who is still on a case cannot be deleted.
CREATE TABLE `employee_case_members` (
  `case_id` text NOT NULL REFERENCES `employee_cases`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE RESTRICT,
  `role` text NOT NULL CHECK (`role` IN ('collaborator', 'observer')),
  `added_by` text NOT NULL,
  `added_at` integer NOT NULL,
  PRIMARY KEY (`case_id`, `user_id`)
);--> statement-breakpoint
CREATE INDEX `idx_employee_case_members_user` ON `employee_case_members` (`user_id`, `case_id`);
