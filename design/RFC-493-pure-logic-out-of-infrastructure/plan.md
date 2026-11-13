# RFC-493 实施计划

依赖：无硬前置；与 S9 共用 `collaboration/infrastructure/review.ts`，串行（S9 当前没有在制的步骤）。按 CLAUDE.md 文首硬规则：先完成全部
实现与用例编写，再集中验证；开发期只做语法与格式的静态自查。

## 任务

- **RFC-493-T1 工作流静态校验迁入 domain**：`legacy/workflow.validator.ts` 的纯函数部分原样迁入 resource-catalog
  `domain/workflowValidator.ts`；加载器一段留在原文件、改取 domain（design D1）。
- **RFC-493-T2 评审的纯规则迁入 domain**：锚点规范化 → `domain/reviewAnchor.ts`，决定策略表 → `domain/reviewDecisionPolicy.ts`，轮次规则 →
  `domain/reviewRounds.ts`；`review.ts` 改取，不再转出 `findAllOccurrences`（design D2～D4）。
- **RFC-493-T3 使用方**：生产 5 个、用例约 50 个的 import 改到新位置；读源码文本的锁随内容改指新文件；架构账本里描述这些位置的文字锚点
  改指（design D5）。
- **RFC-493-T4 用例**：新增 RFC-493 用例并登记 guard-manifest（design §4）。
- **RFC-493-T5 集中验证**：backend `tsc`、eslint；RFC-493 与受影响用例；按 CI 的跑法跑相关文件（与 HEAD 同时 A/B）；全量 SQLite；架构报告
  对照；全仓旧位置扫描（含 `design/` 里的 markdown 链接）。
- **RFC-493-T6 实现门**（本会话自审，只审功能）与收口文档。

## 验收清单

- [ ] AC-1 清单里每一项只在新的 domain 文件声明一次；旧位置不声明、不转出（含 `findAllOccurrences`）；没有文件从旧位置取
- [ ] AC-2 同样输入下校验、锚点规范化、决定策略与轮次分组的结果与此前一致
- [ ] AC-3 新文件不取 infrastructure、IO 包与进程全局；跨 context 边、public surface 与计数不升
- [ ] AC-4 受影响用例全部通过；exact SHA CI 全绿

## PR / 提交

两个提交：先提交三件套、RFC 索引与 `STATE.md` 的 In Progress 条目；实现与验证后再提交
`refactor(backend): RFC-493 纯逻辑归位——工作流静态校验与评审的锚点、决定策略迁出 infrastructure（RFC-294 S13）`。走私有 index、按路径
清单提交，在共享发布锁下 fetch / ff / push。推送后按 exact SHA 跟 CI。
