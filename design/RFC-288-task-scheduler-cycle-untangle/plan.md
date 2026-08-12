# RFC-288 — 任务分解（plan）

> 前置：RFC-287 实现完毕（同文件严格串行）。**落档后须用户批准方可实现**。
> 每刀第一子任务=逐锚复核（基线 da706b19；2026-08-03 审计锚已漂勿照抄）。

## 批次（对应原始 WP-5 的 3-4 PR + 先行小刀）

- T0 先行小刀：AGENT_HOST_AGENT_NODE_ID 常量下沉（D7 叶抽取）+ 对应账目
  微调；独立可回退。
- T1 逐锚复核 + kick/shutdown/orphan 行为基线夹具。
- T2 第一刀 taskDriver：叶子落地 + A1/B1-B4 断 + C1/C2 转静态 + facade 收编
  - CALL_FACES/rfc243/rfc257 型锁更新 + 账本前 5 条销（含 C-6 型中间条处置）
  - 88+ 测试 import 改锚。
- T3 第二刀 workspace/materialize：物化域迁移 + D5 改锚。
- T4 第三刀 taskReadModel + workspaceLeases：E1/E3 断 + 第 6 条账销。
- T5 归位刀：scheduler export 收缩断言 + gate fixture 样例对更换 +
  depcheck 头注计数/文档账本同步（08-03 审计 ⓪ 回填、路线表、STATE）。
- T6 实现门（双路独立子代理）+ 终局 Tarjan 棘轮测试。

## 依赖

- T2 依赖 T1；T3/T4 依赖 T2；T5/T6 收尾。T0 随时可先行。
- 与 RFC-289 同文件（scheduler.ts）——继续串行。

## 验收清单

- [ ] AC-1…AC-6（proposal §5）
- [ ] 零能力变化（§4）
- [ ] 测绘地图更新为终态
