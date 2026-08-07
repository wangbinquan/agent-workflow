-- RFC-269 — 代码平台调用节点的两块持久化。
--
-- ① code_host_connections：每个 provider **至多一行**全局凭据（用户拍板 Q2：
--    全局唯一一套；Q12 追加 GitHub 后自然成为「每家一行」）。token 走
--    `secretBox` 密封而不是明文 config.json —— 后者是明文文件且
--    `GET /api/config` 会整份回传；仓内既有三处凭据（webhook_endpoints.secret_enc /
--    oidc_providers.client_secret_enc / cached_repos.url_enc）都在 DB + secretBox，
--    不为一个新凭据发明第二套姿势。token_hint 是尾 4 位，读路径唯一可见的部分。
--
-- ② tasks.trigger_context_json：webhook 触发时把归一化事件信封的**变量投影**
--    （RFC-263 的 29 项，剔除 event_json）快照进任务行，让节点参数能直接写
--    {{trigger.mr_iid}} 而不必为每个参数接一条 input 连线。可空，NULL = 该任务
--    不是 webhook 触发的 —— 这与「有上下文但该变量恰好为空」是两回事，执行器
--    据此给出可读的失败原因。
--
-- 零回填：存量任务该列为 NULL，语义正确（它们本来就不是 webhook 起的）。
CREATE TABLE `code_host_connections` (
	`provider` text PRIMARY KEY NOT NULL,
	`base_url` text NOT NULL,
	`token_enc` text NOT NULL,
	`token_hint` text NOT NULL,
	`last_test_json` text,
	`updated_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
	`updated_by` text
);--> statement-breakpoint
ALTER TABLE `tasks` ADD `trigger_context_json` text;
