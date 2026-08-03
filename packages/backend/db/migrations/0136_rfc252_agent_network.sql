-- RFC-252 G4 —— 按 agent 声明的受控出网。
--
-- 'deny' | 'allow' | NULL。**不回填**：NULL 就是「未表态」，语义等同 'deny'，因此每一行
-- 存量 agent 的行为在升级前后字节不变（proposal AC-10）。只有精确 'allow' 才是授权，
-- 由 services/agent.ts:rowToAgent 保证 —— 它对 NULL 省略而不是透出 null，杜绝下游用
-- `?? ` 或真值判断把「未表态」读成「放行」。
--
-- 'allow' 的含义是「公网可达但仍拒 loopback」，由 containment profile
-- model-child-egress-v1 的必需能力 modelChildLoopbackDeny 强制，不是尽力而为。
ALTER TABLE `agents` ADD `network` text;
