-- RFC-144：存量僵尸行清洗——被更新一代取代、但 merge_state 还停在在途值
-- （isolating / pending-merge / conflict-human）的行打到 'abandoned'。
-- 修复 stale replay：runTask 入口的 replayPendingMerges /
-- replayConflictHumanResolutions 只按 (task_id, merge_state) 捞行，历史遗留的
-- 被取代行会把过期 delta 物化进主树。运行时的等价不变量由 mint 收口点
-- （mintNodeRun / taskQuestionDispatch 的 abandonSupersededMergeStates）维持，
-- 本迁移只负责 RFC-144 之前落库的存量。
--   (a) 支：被取代的 top-level 行（存在同 (task,node,iteration) 的更大 ULID
--       top-level 兄弟）——freshest 崩溃窗口行不匹配、原样保留（合法 replay 对象）；
--   (b) 支：被取代父行的子行（fanout shard / aggregator / merge-resolve 子行
--       随父废弃）。子行的取代性只能由父行闭包表达，(a) 支的 top-level 谓词
--       保证不误伤「父行未被取代」的子行（Codex 设计门 P1-2）。
UPDATE node_runs SET merge_state = 'abandoned'
WHERE merge_state IN ('isolating', 'pending-merge', 'conflict-human')
  AND (
    (node_runs.parent_node_run_id IS NULL
     AND EXISTS (SELECT 1 FROM node_runs s
                 WHERE s.task_id = node_runs.task_id AND s.node_id = node_runs.node_id
                   AND s.iteration = node_runs.iteration AND s.parent_node_run_id IS NULL
                   AND s.id > node_runs.id))
    OR node_runs.parent_node_run_id IN (
        SELECT r.id FROM node_runs r
        WHERE EXISTS (SELECT 1 FROM node_runs s
                      WHERE s.task_id = r.task_id AND s.node_id = r.node_id
                        AND s.iteration = r.iteration AND s.parent_node_run_id IS NULL
                        AND s.id > r.id))
  );
