# RFC-141 任务分解

单 RFC 单 PR；commit 前缀 `feat(clarify): RFC-141 反问轮携带上轮产出`。
依赖：无（建立在 RFC-119/120/132 已落地代码上）。

## 子任务

### RFC-141-T1 渲染层变体（shared）

- `packages/shared/src/clarify.ts`：新增 `ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE` /
  `ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE` / `ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT`
  （design §3.1 文案，用户拍板措辞）。
- `packages/shared/src/prompt.ts`：pou 渲染去掉 `hasClarifyChannel !== true` 门、按
  `hasClarifyChannel` 选变体（design §3.2）；`PriorOutputUpdateContext` /
  `priorOutputUpdate` / `hasClarifyChannel` 注释随动。
- 测试（同 commit）：`rerun-prior-output.test.ts:125` 翻转 + 双变体黄金锁新增；
  inline / xcc 互斥 case 保持跑绿；`clarify-baseline-prompt-render.test.ts` 快照如涉及则更新。

### RFC-141-T2 调度层门缩减 + 改派抑制拆除（backend）

依赖 T1（渲染层需先能处理 ask-back 变体，避免中间态注入定稿指令到反问轮）。

- `scheduler.ts`：2653-2657 suppress 读取删除；2740-2759 门缩减为
  `currentRunRow !== undefined && !resumeDecision.inlineMode`；注释随动（D6 → RFC-141）。
- `clarifyQueue.ts`：`suppressPriorOutput` 字段 / 派生 / 注释整体拆除（design §3.4）。
- `runner.ts`：173-178 注释随动（零逻辑改动）。
- 测试（同 commit）：`rerun-prior-output-source-guards.test.ts` 重写为负向锁；
  `rfc098-rerun-cause-gates.test.ts:119-122` 源锁随动；`rfc120-deferred-dispatch.test.ts` /
  `rfc120-manual-questions.test.ts` suppress 断言删除 + override-handoff 注入行为 case；
  `rerun-prior-output-injection.test.ts` ask-back 端到端 case（design §5）。

### RFC-141-T3 收口

- `rerun-prior-output-e2e.test.ts` ask-back case（可行则加，过重则文件头注明双层覆盖依据）。
- `design/plan.md` RFC 索引状态 Draft → Done；`STATE.md` 已完成表加行、顶部进行中行移除。
- 门禁：`bun run typecheck && bun run test && bun run format:check` + binary smoke；推后查
  GitHub Actions（[feedback_post_commit_ci_check]）。
- Codex 实现门 review，findings 修完再宣布完成。

## 验收清单

- [ ] 反问轮 + 有旧产出 → prompt 含反问版两节，尾部协议仍 clarify-only（T1 测试锁定）
- [ ] 定稿轮 prompt 与现状 byte-identical（黄金锁）
- [ ] inline 续跑轮不注入（既有 case 保持绿）
- [ ] 纯 override 交接轮注入（反问版 / 定稿版随协议）且 `suppressPriorOutput` 全链路无残留
- [ ] 无产出首轮反问不注入（`freshestPriorRunWithOutput` 空 → 无块）
- [ ] 全部源锁测试翻转为新语义而非删除；typecheck / test / format / smoke 全绿
