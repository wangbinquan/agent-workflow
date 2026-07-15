-- RFC-193 — path 端口产物归档制（archive-at-emit）。
-- node_run_outputs 新增 archive_json：runner 在校验窗口（节点 iso 存活）把
-- path 形端口指向的文件内容归档到 {appHome}/runs/{taskId}/ports/ 后写入的
-- 引用（{ v:1, items:[{ path, file, size, truncated }] }，path=容器相对源
-- 路径、file=appHome 相对归档路径）。NULL = 本 RFC 之前的存量行（读取走
-- readPortArtifact 的 worktree 回退链）或非 path 形端口。不 backfill——
-- 存量任务的 worktree 可能已被 GC，无从补归档。
ALTER TABLE node_run_outputs ADD COLUMN archive_json TEXT;
