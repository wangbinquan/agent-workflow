-- RFC-311 T28 — /api/cached-repos 分页的 keyset 索引。
-- 排序键是 (last_fetched_at DESC, id DESC)：单列 idx_cached_repos_last_fetched
-- 无法保证同一时间戳内的 id 次序，keyset 断点需要复合索引给出全序；
-- 复合索引按前缀规则完全覆盖旧单列索引的用途，直接替换。
DROP INDEX IF EXISTS `idx_cached_repos_last_fetched`;--> statement-breakpoint
CREATE INDEX `idx_cached_repos_fetched_id` ON `cached_repos` (`last_fetched_at`,`id`);
