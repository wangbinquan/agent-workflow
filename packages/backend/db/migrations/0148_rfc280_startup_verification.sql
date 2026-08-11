-- RFC-280 T3 — 节点启动验证快照。
--
-- 持久化 { declared, observation, verification }：平台声明注入了什么 ×
-- runtime 启动清单实际报告了什么 × 差集判定。业务节点消费为持久告警
--（不改变节点成败）；NULL = 该 run 早于验证层或该链路无声明注入。
-- 纯增量可空列，无 backfill。
ALTER TABLE `node_runs` ADD COLUMN `startup_verification_json` text;
