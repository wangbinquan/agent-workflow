-- RFC-204 (T2) — 仓库 Git 凭据封存 + 确定性引用键。
--
-- cached_repos 是全局共享池且 `repos:read` 属 USER_BASELINE，此前 rowToCached 把
-- 明文 `url`（私有仓的接入方式就是把凭据塞进 URL）与 urlRedacted 一起上 wire，
-- 任何登录用户都能拉到他人凭据。凭据改为 AES-256-GCM 封存在 url_enc（secretBox，
-- 与 OIDC client_secret_enc 同款），展示走 url_redacted；旧 `url` 列由启动/备份
-- 共用的 ensureCredentialsSealed gate 清空（列本身留到 0099 再 drop，避免
-- rolling-upgrade 掉列）。
--
-- cached_repo_id：seal 用随机 IV，密文非确定性，不能再拿 URL 做等值 join。
-- refTaskCount 与记忆 scope 解析（memoryInject / memoryDistillScheduler）原本
-- 都是 `cached_repos.url == tasks.repo_url` 明文 join，改走这个确定性外键。
-- 索引是必需的：refTaskCount 对列出的每一个 cache row 求值一次，没有索引就是
-- 对 task_repos 的重复全表扫。
ALTER TABLE cached_repos ADD COLUMN url_enc TEXT;
--> statement-breakpoint
ALTER TABLE cached_repos ADD COLUMN url_redacted TEXT;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN cached_repo_id TEXT;
--> statement-breakpoint
ALTER TABLE task_repos ADD COLUMN cached_repo_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_repos_cached_repo_id ON task_repos (cached_repo_id);
