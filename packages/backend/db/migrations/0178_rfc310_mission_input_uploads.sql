-- RFC-310 PR-3 T36 — mission 输入上传的临时 artifact 会话（design §12.1）。
--
-- actor-scoped、TTL、一次性原子 claim：POST /api/code/mission-input-uploads 收
-- 单文件（bounded stream）落 evidence 暂存并建行；launch 的 Mission 事务里按
-- uploadRef 原子 claim（任一失败则一个都不消费）。未 claim 行到期由后台回收。
-- bytes 落 EvidenceStore（内容寻址 blob），DB 只存 ref/digest/元数据。

CREATE TABLE `mission_input_uploads` (
  `id` text PRIMARY KEY NOT NULL,
  `actor_user_id` text,
  `original_name` text NOT NULL,
  `bytes` integer NOT NULL,
  `sha256` text NOT NULL,
  `blob_ref` text NOT NULL,
  `state` text NOT NULL DEFAULT 'pending',
  `claimed_by_mission_id` text,
  `upload_idempotency_key` text,
  `expires_at` integer NOT NULL,
  `created_at` integer NOT NULL,
  `claimed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mission_input_uploads_idem_unique` ON `mission_input_uploads` (`actor_user_id`, `upload_idempotency_key`) WHERE `upload_idempotency_key` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `idx_mission_input_uploads_state` ON `mission_input_uploads` (`state`, `expires_at`);
