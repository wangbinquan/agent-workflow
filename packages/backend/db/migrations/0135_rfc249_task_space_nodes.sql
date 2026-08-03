-- RFC-249 — 冻结任务启动时展开后的显式目录树。
-- task_repos 继续保存仓来源/ref/subdir/readonly；这里只保存目录路径，避免重跑时
-- 读取已经漂移或被删除的当前组定义。
CREATE TABLE `task_space_nodes` (
	`task_id` text NOT NULL,
	`node_path` text NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY (`task_id`, `node_path`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_task_space_nodes_path_ci`
	ON `task_space_nodes` (`task_id`, lower(`node_path`));
