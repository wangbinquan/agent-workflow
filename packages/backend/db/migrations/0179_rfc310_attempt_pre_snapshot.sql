-- RFC-310 PR-4 T43/T50 — attempt 的 pre-state 上下文 ref。
--
-- launch 轮把「验证与重建所需的一切」冻结为一个内容寻址 evidence JSON blob
-- （manifest-sans-nonce、workspacePath、pre 业务树/protected 快照、closed
-- refs、重试预算、baseline 定位），collect 轮凭此对拍与整树重建。台账只持
-- ref；nonce 明文永不入库（attempt 行持 nonce_digest，§7.1）。

ALTER TABLE `development_agent_attempts` ADD COLUMN `pre_snapshot_ref` text;
