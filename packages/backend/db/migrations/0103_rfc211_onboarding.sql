-- RFC-211 引导式沙盒（guided onboarding sandbox）。
--
-- 两部分，都是纯增量：
--   (1) 五张业务表各加一个 `example` 布尔列。NOT NULL DEFAULT false ⇒ 每一条存量
--       行都变成「非示例」，静默语义与改动前逐字节一致、零回归。`example` 与
--       RFC-104 的 `builtin` **正交**：builtin = 框架基础设施（列表隐藏 + 全面
--       只读 + 禁止启动）；example = 用户自己的引导沙盒产物（可见 + 可编辑 +
--       可启动 + 可一键清除）。
--   (2) onboarding_runs / onboarding_artifacts 两张引导表。artifacts 刻意**不**
--       对五张业务表建 FK —— 五类资源的删除路径各不相同（skill 走 op 锁、
--       workflow 走 OCC），FK 会把删除顺序焊死；改由清除服务在删除成功后显式
--       删 artifact 行，并由 rfc211-example-marker-consistency 测试锁住两处一致。
--
-- 手写迁移，已登记进 meta/_journal.json。设计见
-- design/RFC-211-guided-onboarding-sandbox/design.md §1。
ALTER TABLE `agents` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `workgroups` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onboarding_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`track` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_step` text,
	`completed_steps` text DEFAULT '[]' NOT NULL,
	`suffix` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onboarding_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`resource_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `onboarding_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_onboarding_runs_user` ON `onboarding_runs` (`user_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_onboarding_artifacts_resource` ON `onboarding_artifacts` (`resource_type`,`resource_id`);
