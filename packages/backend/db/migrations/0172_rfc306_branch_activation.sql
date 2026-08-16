-- RFC-306 §2 —条件分支所需的两列。
--
-- 1) node_run_outputs.active —— 端口是否「激活」。
--    今天「agent 没输出该端口」与「agent 输出了空端口」在库里完全同形（都是一行
--    content=''），所以端口本身无法承载「这条分支不要走」的意思。这一列把二者分开：
--    只有 agent/script 在 envelope 里显式写 `<port name="p" active="false">` 才写 0，
--    其余一律 1。
--
--    DEFAULT 1 是这条迁移的兼容性支点：存量行、以及此后所有不带标记的端口行，读出来
--    都是「激活」，于是没有声明分支端口的工作流行为逐字节不变（RFC-306 §4.2 / AC-3）。
--
--    active=0 时 content 存的是**决策理由**（自然语言，可为空），不再是数据——它绝不
--    进入任何下游 prompt（scheduler.ts 的输入解析对不激活端口一律贡献空串）。
--
-- 2) node_runs.force_activated —— 人工「仍然执行」。
--    用户在任务详情对一个 skipped 节点点「仍然执行」时，retryNode 在铸的行上打 1，
--    调度判定看到即把该节点视为激活一次。只影响这一个节点：它的下游仍按它**真实
--    输出**重新判定（RFC-306 §10）。DEFAULT 0 ⇒ 存量行为不变。
--
-- 两列都可空可默认，旧代码读新库照常工作（多余列被忽略），因此这条迁移可安全前滚。

ALTER TABLE node_run_outputs ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE node_runs ADD COLUMN force_activated INTEGER NOT NULL DEFAULT 0;
