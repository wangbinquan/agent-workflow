-- RFC-311 G1 — 物化每个任务的**树根**，让过滤视图也能走 O(页) 快路径。
--
-- 旧管线为了回答「哪些 root 该出现在这一页、按什么排序」，要先把全部授权任务
-- 物化成 base，再走两条递归 CTE（向上求祖先闭包、向下求分支成员），最后才
-- LIMIT——10 万任务库上单次 68 秒，而且是**一条 SQL**，在单连接同步 daemon 上
-- 意味着这段时间整站冻结。
--
-- 关键等价：对全可见 actor 而言，`subtree(root) ∩ (匹配集 ∪ 其祖先)` 恰好等于
-- 「root_task_id = root 且属于合格集」的那批行。把 root 物化成一列，向上/向下
-- 两条递归就塌缩成一次 `GROUP BY root_task_id`。
--
-- parent_task_id 铸行后不可变（services/task.ts 唯一铸行点，无任何改父路径），
-- 所以这一列一次写定、永不漂移。
ALTER TABLE `tasks` ADD `root_task_id` text;--> statement-breakpoint
-- 回填：沿 parent 链走到顶（深度上限与 MAX_TREE_DEPTH 同为 64；超限或成环的行
-- 由下面的兜底 UPDATE 落回自身，宁可把它当自己的根，也不要留 NULL）。
WITH RECURSIVE walk(id, cur, depth) AS (
	SELECT id, id, 0 FROM tasks
	UNION ALL
	SELECT w.id, t.parent_task_id, w.depth + 1
	FROM walk w
	JOIN tasks t ON t.id = w.cur
	WHERE t.parent_task_id IS NOT NULL AND w.depth < 64
)
UPDATE tasks SET root_task_id = (
	SELECT w.cur FROM walk w
	JOIN tasks anc ON anc.id = w.cur
	WHERE w.id = tasks.id AND anc.parent_task_id IS NULL
	LIMIT 1
);--> statement-breakpoint
UPDATE tasks SET root_task_id = id WHERE root_task_id IS NULL;--> statement-breakpoint
-- 页内 root 的子树取回（enrichment）走这条；分组键本身的扫描由过滤谓词驱动。
CREATE INDEX `idx_tasks_root_started` ON `tasks` (`root_task_id`,`started_at`);--> statement-breakpoint
-- 准入闸门用的部分索引：快路径把 root_task_id 当分组键，一旦有行没落根（绕过
-- 服务层的裸 SQL 插入、或将来某条迁移漏了回填），那行会被当成自己的根、**静默
-- 挂错分支**。所以每次取页先问一句「还有没有未落根的行」，有就整条退回旧管线：
-- 宁可慢，不可错。这条谓词与查询逐字一致，索引才用得上（partial index 的蕴含
-- 判定很窄，见 docs/dev-gotchas.md）。
CREATE INDEX `idx_tasks_root_missing` ON `tasks` (`id`) WHERE `root_task_id` IS NULL;
