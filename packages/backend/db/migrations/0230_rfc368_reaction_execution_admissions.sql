-- RFC-368 expand phase: Reaction 执行合同的 admission 日志、派发调度列与 content-addressed 产物。
--
-- 纯增量（刀 1）：**只建新表**，既有表一列不加、既有索引一个不动。这不是风格选择——
-- 本仓 PostgreSQL 的迁移序列自 RFC-349 基线以来只支持新表 / 新索引 / CHECK 放宽三种，
-- 给既有表加列与改既有索引都不可表达。于是派发状态落进 1:1 侧表
-- `employee_reaction_dispatch`（它装的正是 `execution-launch` outbox 行今天装的东西），
-- 「admission 已登记、launch 回执未到」那一格用 `planned` + 未过期的租约表示，
-- `employee_reaction_rounds_one_active` 的不变量原样成立、前端不用认识新状态。
-- 在途 `execution-launch` 行的迁移与
-- outbox `kind` 的收缩在刀 3（T5b）——行迁走而派发臂还没接管时那些 round 会停摆。
CREATE TABLE `reaction_execution_admissions` (
	`operation_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`round_ref` text NOT NULL,
	`claim_epoch` integer NOT NULL,
	`fence_revision` integer NOT NULL,
	`request_hash` text NOT NULL,
	`authority_subject` text NOT NULL,
	`authority_revision` integer NOT NULL,
	`execution_ref` text NOT NULL,
	`state` text DEFAULT 'admitted' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reaction_execution_admissions_round` ON `reaction_execution_admissions` (`round_ref`,`claim_epoch`);
--> statement-breakpoint
CREATE INDEX `idx_reaction_execution_admissions_execution` ON `reaction_execution_admissions` (`execution_ref`);
--> statement-breakpoint
CREATE TABLE `employee_reaction_artifacts` (
	`digest` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_employee_reaction_artifacts_kind` ON `employee_reaction_artifacts` (`kind`,`created_at`);
--> statement-breakpoint
CREATE TABLE `employee_reaction_dispatch` (
	`round_ref` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`claim_epoch` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`dispatch_claimed_by` text,
	`dispatch_lease_expires_at` integer,
	`last_dispatch_error` text,
	`operation_ref` text,
	`retry_feedback_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_employee_reaction_dispatch_due` ON `employee_reaction_dispatch` (`next_attempt_at`,`dispatch_lease_expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_employee_reaction_dispatch_case` ON `employee_reaction_dispatch` (`case_id`);
