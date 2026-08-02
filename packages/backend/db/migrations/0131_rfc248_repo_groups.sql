-- RFC-248 PR-2 — 仓库组（repo groups）。
--
--   * repo_groups / repo_group_members: 可命名、可复用的执行空间定义——哪几个
--     仓 + 各自 checkout 什么 + 在运行目录里怎么摆。成员两种 kind：'repo'
--     （引用 cached_repos，带 ref / subdir）与 'group'（引用另一个组，启动时
--     递归展平，深度 ≤ 5 / 展平 ≤ 32）。两种都带 mount_path（'' = 挂在根，
--     至多一个成员可以挂根）与 readonly（取并集向内传播）。
--
--     cached_repo_id / child_group_id 上**刻意不加** ON DELETE CASCADE：
--     删除走 services/repoGroup.ts 的显式守卫（409 + force 摘除），静默级联会
--     让组悄悄变形，用户下次启动才发现少了一个仓。
--
--   * tasks.repo_group_id / repo_group_name: 溯源 + 记忆注入 + 详情页 chip。
--     名字是**快照**（D8）——组被删除后 chip 仍要能渲染名字而不是悬空 id。
--
--   * task_repos.mount_path / subdir / readonly / gitignore_commit:
--     mount_path 从 worktree_dir_name backfill——存量多仓任务是平铺布局，
--     它的 basename 就**是**挂载路径，所以历史审阅锚点不会错位。
--     gitignore_commit 记录 D1 的平台预置 commit（把嵌套挂载点写进外层
--     .gitignore 并提交，base_commit 指向它），便于「这一笔到底是不是平台造的」
--     在排错与 UI 上一眼可判。
--
-- 编号说明：本 RFC 落档时最新是 0129，写文档期间并发 session 落了 0130，
-- 故顺延到 0131（设计门 G2）。
--
-- See design/RFC-248-repo-groups/design.md §2.1–2.2.
CREATE TABLE `repo_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_repo_groups_name_ci` ON `repo_groups` (lower(`name`));--> statement-breakpoint
CREATE TABLE `repo_group_members` (
	`group_id` text NOT NULL,
	`member_index` integer NOT NULL,
	`kind` text NOT NULL,
	`cached_repo_id` text,
	`ref` text DEFAULT '' NOT NULL,
	`subdir` text DEFAULT '' NOT NULL,
	`child_group_id` text,
	`mount_path` text DEFAULT '' NOT NULL,
	`readonly` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY (`group_id`, `member_index`),
	CHECK (`kind` IN ('repo','group')),
	CHECK (
		(`kind` = 'repo'  AND `cached_repo_id` IS NOT NULL AND `child_group_id` IS NULL) OR
		(`kind` = 'group' AND `child_group_id` IS NOT NULL AND `cached_repo_id` IS NULL)
	),
	-- 组成员不带 ref / subdir：内层组的 ref 完全听它自己的（D19）。
	CHECK (`kind` = 'repo' OR (`ref` = '' AND `subdir` = '')),
	FOREIGN KEY (`group_id`) REFERENCES `repo_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cached_repo_id`) REFERENCES `cached_repos`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_group_id`) REFERENCES `repo_groups`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `idx_rgm_cached_repo` ON `repo_group_members` (`cached_repo_id`);--> statement-breakpoint
CREATE INDEX `idx_rgm_child_group` ON `repo_group_members` (`child_group_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `repo_group_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `repo_group_name` text;--> statement-breakpoint
ALTER TABLE `task_repos` ADD `mount_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `task_repos` ADD `subdir` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `task_repos` ADD `readonly` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `task_repos` ADD `gitignore_commit` text;--> statement-breakpoint
-- 存量多仓任务是平铺布局，worktree_dir_name 就是它的挂载路径；单仓任务两者
-- 都是 ''（挂根），语义一致。历史审阅锚点因此不变。
UPDATE `task_repos` SET `mount_path` = `worktree_dir_name`;
