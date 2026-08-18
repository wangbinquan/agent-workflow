-- RFC-310 PR-1B — development-automation 配置资源（T13/T13a/T14/T15/T16/T17）。
--
-- 形态是「identity + immutable revisions」双表：identity 行持 ACL/名称/可变
-- draft_json；publish 把 draft 冻结成 (id, revision) 的不可变行并记 canonical
-- digest。Mission pin 的是 revision 行——编辑永远产生新 revision，在途 pin
-- 不漂移（design §3.1/§11.2）。内容都是 zod strict codec 校验过的 canonical
-- JSON；digest 供 replay/audit 对拍。assignment 每个 scope 至多一行（§3.8：
-- 同级多份是配置错误，用唯一索引直接挡）。adapter definition 归 integration
-- bounded context 所有，但表在同一 SQLite（跨 context 只经 required-ports 消费）。

CREATE TABLE `action_templates` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `capability_id` text NOT NULL,
  `draft_json` text NOT NULL,
  `published_revision` integer,
  `owner_user_id` text,
  `visibility` text NOT NULL DEFAULT 'private',
  `acl_revision` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_templates_owner_name_unique` ON `action_templates` (COALESCE(`owner_user_id`,''),`name`);
--> statement-breakpoint
CREATE TABLE `action_template_revisions` (
  `template_id` text NOT NULL REFERENCES `action_templates`(`id`),
  `revision` integer NOT NULL,
  `content_json` text NOT NULL,
  `content_digest` text NOT NULL,
  `published_at` integer NOT NULL,
  `published_by` text,
  PRIMARY KEY (`template_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `verification_profiles` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `draft_json` text NOT NULL,
  `published_revision` integer,
  `owner_user_id` text,
  `visibility` text NOT NULL DEFAULT 'private',
  `acl_revision` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `verification_profiles_owner_name_unique` ON `verification_profiles` (COALESCE(`owner_user_id`,''),`name`);
--> statement-breakpoint
CREATE TABLE `verification_profile_revisions` (
  `profile_id` text NOT NULL REFERENCES `verification_profiles`(`id`),
  `revision` integer NOT NULL,
  `content_json` text NOT NULL,
  `content_digest` text NOT NULL,
  `published_at` integer NOT NULL,
  `published_by` text,
  PRIMARY KEY (`profile_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `digital_employees` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `draft_json` text NOT NULL,
  `published_revision` integer,
  `owner_user_id` text,
  `visibility` text NOT NULL DEFAULT 'private',
  `acl_revision` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digital_employees_owner_name_unique` ON `digital_employees` (COALESCE(`owner_user_id`,''),`name`);
--> statement-breakpoint
CREATE TABLE `digital_employee_revisions` (
  `employee_id` text NOT NULL REFERENCES `digital_employees`(`id`),
  `revision` integer NOT NULL,
  `content_json` text NOT NULL,
  `content_digest` text NOT NULL,
  `published_at` integer NOT NULL,
  `published_by` text,
  PRIMARY KEY (`employee_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `automation_policies` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `draft_json` text NOT NULL,
  `published_revision` integer,
  `owner_user_id` text,
  `visibility` text NOT NULL DEFAULT 'private',
  `acl_revision` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_policies_owner_name_unique` ON `automation_policies` (COALESCE(`owner_user_id`,''),`name`);
--> statement-breakpoint
CREATE TABLE `automation_policy_revisions` (
  `policy_id` text NOT NULL REFERENCES `automation_policies`(`id`),
  `revision` integer NOT NULL,
  `content_json` text NOT NULL,
  `content_digest` text NOT NULL,
  `published_at` integer NOT NULL,
  `published_by` text,
  PRIMARY KEY (`policy_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `development_adapter_definitions` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `purpose` text NOT NULL,
  `draft_json` text NOT NULL,
  `published_revision` integer,
  `owner_user_id` text,
  `visibility` text NOT NULL DEFAULT 'private',
  `acl_revision` integer NOT NULL DEFAULT 0,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `archived_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `development_adapter_definitions_owner_name_unique` ON `development_adapter_definitions` (COALESCE(`owner_user_id`,''),`name`);
--> statement-breakpoint
CREATE TABLE `development_adapter_definition_revisions` (
  `adapter_id` text NOT NULL REFERENCES `development_adapter_definitions`(`id`),
  `revision` integer NOT NULL,
  `content_json` text NOT NULL,
  `content_digest` text NOT NULL,
  `published_at` integer NOT NULL,
  `published_by` text,
  PRIMARY KEY (`adapter_id`, `revision`)
);
--> statement-breakpoint
CREATE TABLE `repository_employee_assignments` (
  `id` text PRIMARY KEY NOT NULL,
  `scope_kind` text NOT NULL,
  `scope_ref` text,
  `employee_id` text,
  `employee_revision` integer,
  `selection_policy_id` text,
  `selection_policy_revision` integer,
  `execution_policy_id` text,
  `execution_policy_revision` integer,
  `default_requirement_source_key` text,
  `updated_by` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repository_employee_assignments_scope_unique` ON `repository_employee_assignments` (`scope_kind`,COALESCE(`scope_ref`,''));
