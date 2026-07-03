# RFC-138 任务分解

单 RFC 单 PR（main 直推），commit 前缀 `feat(clarify): RFC-138 ...`。任务强序 T1→T2→T3→T4。

## RFC-138-T1 后端 collapse 分支

- `services/taskQuestions.ts reassignTaskQuestion`：collapse 判定（cross ∧ designer ∧
  target==round.askingNodeId）+ 单 dbTxSync（CAS → tx 内重读 round → 两表 scope merge 双写
  → 删未下发 designer 行）+ 审计 log + 返回判别值 `'override' | 'collapsed-to-questioner'`。
- `routes/taskQuestions.ts`：响应体加 `action` 字段。
- 测试：design §5 case 1/2/5/7 + 9（双写锁）。
- 验收：AC-1、AC-4、AC-5。

## RFC-138-T2 下发/注入集成断言

- 不改生产代码（若 T1 正确则纯测试任务；跑出问题回改 T1）。
- 测试：design §5 case 3（混轮无 multi-target、设计节点注入只含未 collapse 题）、
  case 4（提问节点单 rerun + 单次渲染 + 无 cross-clarify-answer mint）、case 6（reconcile /
  RFC-136 reseal 不复活）。
- 验收：AC-2、AC-3、AC-6。

## RFC-138-T3 前端反馈

- `ClarifyQuestionHandler.tsx` + 看板 reassign mutation：读 `action`，collapse 时 toast
  （新 i18n 键 zh/en，走既有 toast 原语）；invalidation 复用既有键。
- 测试：design §5 case 8（vitest）。
- 验收：AC-7。

## RFC-138-T4 收口

- `design/plan.md` RFC 索引状态 Draft→Done；`STATE.md` 追加已完成条目、撤「进行中」行。
- 门禁：`bun run typecheck && bun run test && bun run format:check` + 前端 vitest；本改动
  不触 shared 导出结构，二进制 smoke 按需（[reference_binary_build_module_cycle]）。
- push 后查 GitHub Actions（[feedback_post_commit_ci_check]）。

## 验收清单

- [ ] AC-1 collapse 正路径（T1）
- [ ] AC-2 单次投递（T2）
- [ ] AC-3 混轮下发（T2）
- [ ] AC-4 golden-lock 第三节点改派不变（T1）
- [ ] AC-5 已下发/manual/self/terminal 边界（T1）
- [ ] AC-6 reconcile/reseal 不复活（T2）
- [ ] AC-7 前端反馈（T3）
- [ ] 门禁 + CI 绿（T4）
