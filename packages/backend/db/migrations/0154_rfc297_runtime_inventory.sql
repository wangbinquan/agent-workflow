-- RFC-297 T17 —— 跨运行时统一的「运行时清单」观测落库。
--
-- 此前清单只有一条落库路径：`node_runs.inventory_snapshot_json`，那是 RFC-029
-- opencode dump 插件的原文形状。Claude Code 从不写它（没有那个插件），于是前台
-- 读到 NULL 后照着 opencode 的失败语义显示「插件可能加载失败」——用户实证的 bug。
--
-- 本列存的是**运行时无关**的观测（`RuntimeInventoryObservation`）：五个面的条目
-- 带来源对账，以及「没观测到」的三种归因。仅加列，不回填——存量行由读端转码
-- 呈现（RFC-297 D7 零 backfill）。
ALTER TABLE `node_runs`
ADD COLUMN `runtime_inventory_json` text;
