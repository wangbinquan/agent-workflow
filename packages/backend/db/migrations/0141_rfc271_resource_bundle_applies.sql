-- RFC-271 T7 —— `resource_bundle_applies`：`BundleApply` 引擎的 apply journal，
-- 泛化自 `intent_apply_journal`（RFC-234）。
--
-- 一行 = 一次**提交尝试**。`UNIQUE(scope, key)` 让重放幂等：同一个
-- `(scope,key)` 再来一次不重跑，按 I3 的**三态**回答（committed → 原 receipt；
-- failed → 409；prepared/applying → 409 未结）。
--
-- 为什么不复用 `intent_apply_journal`：那张表的 `session_id` 是指向
-- `intent_sessions` 的 NOT NULL 外键，配置包导入压根没有 session。硬塞会要么
-- 放松那条外键（削弱 intent 的完整性），要么给导入伪造一个 session 行。
-- 两张表各自收敛、互不感知，也就没有跨表幂等 / in-flight 排他的并存期问题。
-- **`intent_apply_journal` 一字不动**（决策 26：intent 不迁移）。
--
-- `prepared_artifacts_json` 是**补偿 oracle**：任何外部副作用（技能 staging、
-- 插件 generation 目录）**落地之前**先把「足以精确删掉它」的信息写进这里
-- （I14 record-before-act）。只把路径挂在抛出的错误上不够——进程可能在 mkdir
-- 之后、返回之前被 SIGKILL。
--
-- 秘密值**绝不**落这张表：payload 里的凭据槽位在入包时已被换成哨兵。
CREATE TABLE `resource_bundle_applies` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`state` text NOT NULL DEFAULT 'prepared',
	`prepared_artifacts_json` text NOT NULL DEFAULT '[]',
	`receipt_json` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_resource_bundle_applies_key` ON `resource_bundle_applies` (`scope`,`key`);--> statement-breakpoint
-- 收敛器按 state 扫（`prepared`/`applying` 逆序补偿、`committed` 前滚幂等尾）。
CREATE INDEX `idx_resource_bundle_applies_state` ON `resource_bundle_applies` (`state`);--> statement-breakpoint
-- 「谁导入的」既是审计列，也是收敛期重建 Actor 的依据。
CREATE INDEX `idx_resource_bundle_applies_actor` ON `resource_bundle_applies` (`actor_user_id`);
