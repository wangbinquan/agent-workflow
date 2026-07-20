-- RFC-207 §3.8 — 任务运行时长与「停等人」时长分离
--
-- 起因：`maxDurationMs` 一直按 now - started_at 计算，而 started_at 只在建任务时
-- 写过一次、恢复时不重置；同时 enforceLimits 只扫 status='running' 的行。合起来
-- 就是最坏的组合：任务停在等人回答期间**不检查**，可那段等待却被追溯计费——人一
-- 答完，下一个 tick 就可能把任务判超时杀掉。
--
-- 修法不动 started_at（它还被任务列表排序、GC 最小年龄、stuck 检测、不变式扫描等
-- 八处按「任务何时开始」消费，平移会静默污染全部），改为单独记账真实运行时长。
--
-- 当前正在 running 的行需要回填 running_since，否则它们会平白获得一次赦免。

ALTER TABLE tasks ADD COLUMN running_ms integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN running_since integer;
--> statement-breakpoint
UPDATE tasks SET running_since = started_at WHERE status = 'running';
