-- RFC-207 §3.7.3 — 「停止反问」加 shard 维度
--
-- 工作组把所有成员派单跑在同一个 __wg_member__ 节点上，只靠 node_runs.shard_key
-- 区分。原表主键是 (task_id, node_id)，所以「停掉发问的那张派单」写下去会变成
-- 「停掉全体成员的反问」。加一列 shard_key 并入主键。
--
-- 用 '' 作节点级哨兵而不是 NULL：SQLite 普通（有 rowid）表的 PRIMARY KEY 列**不**
-- 隐含 NOT NULL，用 NULL 会允许重复行、主键形同虚设。
--
-- SQLite 改不了主键，只能重建：建新表 → 全量搬 → 删旧 → 改名 → 重建索引。
-- 存量行全部是节点级语义，搬迁时 shard_key 取 ''。

CREATE TABLE task_node_clarify_directives_new (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  shard_key TEXT NOT NULL DEFAULT '',
  directive TEXT NOT NULL,
  set_by TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (task_id, node_id, shard_key)
);
--> statement-breakpoint
INSERT INTO task_node_clarify_directives_new (task_id, node_id, shard_key, directive, set_by, updated_at)
  SELECT task_id, node_id, '', directive, set_by, updated_at FROM task_node_clarify_directives;
--> statement-breakpoint
DROP TABLE task_node_clarify_directives;
--> statement-breakpoint
ALTER TABLE task_node_clarify_directives_new RENAME TO task_node_clarify_directives;
--> statement-breakpoint
CREATE INDEX idx_task_node_clarify_directives_task ON task_node_clarify_directives(task_id);
