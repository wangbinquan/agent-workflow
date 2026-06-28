# RFC-122 任务分解

单 PR（backend + API + frontend 一体）。设计经用户 AskUserQuestion 拍板（开关放提问 agent 节点），实现后过 Codex impl-gate。

- **RFC-122-T1** 数据层：migration `0064` 新表 `task_node_clarify_directives` + `schema.ts`。
- **RFC-122-T2** shared oracle：`isClarifyAskingNode`（clarify.ts）、`resolveEffectiveClarifyChannel`（clarifyRounds.ts 抽纯函数）、`prompt.ts` `clarifyStopNotice` 字段 + trailer 注入。
- **RFC-122-T3** 调度器：dispatch 读 `nodeStopOverride`（**per-attempt**，retry 取最新）+ 三缝注入（effective-channel / 首跑 notice / prior-轮 directiveOverride）；review-rerun STOP 兜底。
- **RFC-122-T4** service + route：`taskClarifyDirective.{ts}` + `POST/GET /api/tasks/:id/nodes/:nodeId/clarify-directive`（成员门控 + 提问节点校验 + registry）。
- **RFC-122-T5** 前端：`ClarifyDirectiveToggle` + 画布线（types/AgentNode/WorkflowCanvas/tasks.detail/useTaskSync）+ i18n + styles。
- **RFC-122-T6** 测试：oracle 真值表 + dispatch e2e（真 promptText）+ route + 前端开关 + retry/review-rerun 回归。

## 验收清单
- [x] migration 0064 statement-breakpoint 正确、binary smoke 嵌入。
- [x] golden-lock：无 override ⇒ 逐字不变（self + cross）。
- [x] 实现：新表 / 三缝注入 / route / 画布开关 / i18n 对称。
- [ ] Codex impl-gate：H1 per-attempt 读 + H2 review-rerun STOP 兜底 fold（进行中）。
- [ ] 完整 backend 套件 + typecheck×3 + lint + format + binary smoke + 前端 vitest 全绿。
- [ ] push origin/main + CI 全绿。

## 教训
RFC 文档**本应先于编码落档**（CLAUDE.md RFC workflow）；本次因设计经 AskUserQuestion 已锁、走了 code-first，事后补三件套 + 索引登记。下次新功能仍先落档再编码。
