# RFC-160 任务分解

## 子任务

- **RFC-160-T1（shared）**：翻常量 `CLARIFY_QUESTION_SCOPE_DEFAULT` designer→questioner；校正
  `schemas/clarify.ts` + `clarify.ts` 的 doc comment（含 `ClarifyQuestionScopeSchema` /
  `resolveQuestionScope` 3+ 处）；翻/补 shared 测试（`clarify-question-scope-shared`、
  `task-questions-reconcile`）。依赖：无。
- **RFC-160-T2（backend）**：逐一核 backend clarify/task-question 测试里「默认 designer」的
  断言并翻转（命中集见下）；新增「追溯收敛」回归锁（AC-4：NULL-scope 老轮未下发 designer 行
  reconcile 移除、已下发保留、questioner 保留）。依赖：T1（常量）。
- **RFC-160-T3（frontend）**：详情页 picker 默认随常量翻转（**无源码改动**＝靠 shared 常量，
  校正 `CentralizedAnswerDialog.tsx:372-374` 注释即可）；翻转前端相关测试里依赖默认 designer
  的断言（cross-clarify-scope-control/shortcut、centralized-answer-pane、
  clarify-question-handler）。依赖：T1。
- **RFC-160-T4（门禁 + 收尾）**：typecheck/lint/test/format + binary smoke + 前端 vitest；
  Codex 实现门；`STATE.md` 已完成表加行、`design/plan.md` RFC 索引状态 Draft→Done。依赖：
  T1–T3。

## 需逐一核的测试命中集（「默认 designer」锁）

实现时对每个文件判定：靠**默认** designer 的断言翻转；**显式**设 scope 的不动（golden-lock）。

- **shared**：`clarify-question-scope-shared`、`task-questions-reconcile`。
- **backend**：`rfc120-deferred-dispatch`（:294「no scopes → all-designer」）、
  `rfc128-p5-0-stranding-guard`（:359「DEFAULT='designer'」）、`cross-clarify-service`、
  `cross-clarify-question-scope`、`cross-clarify-designer-rerun-no-rollback`、
  `cross-clarify-fast-path-isolation`、`rfc120-task-questions-service`、
  `rfc128-p1-per-question-seal`、`rfc128-p2-per-question-endpoint`、
  `rfc128-p3-designer-per-question-dispatch`、`rfc128-p5-bc-self-questioner-rerun`、
  `rfc128-p5-d-autodispatch`、`rfc136-reanswer`、`rfc138-reassign-to-asker-collapse`、
  `rfc140-one-click-dispatch-all`、`routes-cross-clarify`、`scheduler-cross-clarify-dispatch`、
  `rfc096-designer-rerun-pick`、`rfc127-designer-borrow-dispatch`、`workflow-validator`、
  `freshness`。
- **frontend**：`cross-clarify-scope-control`、`cross-clarify-scope-shortcut`、
  `centralized-answer-pane`、`clarify-question-handler`、`node-history-split`、`segmented`。

（注：清单是 grep 命中的**候选**，非全部都改——多数显式设 scope，不受默认翻转影响；实现时
逐一确认。）

## PR 拆分

**单 PR**（跨 shared/backend/frontend，但同一语义变更＝一个常量的连带效应；拆分反而割裂
原子性）。commit：`feat(clarify): RFC-160 跨节点反问默认 scope 改反问者（cross 默认单卡、与同
节点对齐）`。多人树下按精确路径 `git commit -- <paths>` 单步提交，不扫他人未提改动
（[feedback_shared_index_commit_race] / [feedback_dont_delete_others_code_for_ci]）。

## 验收清单

- [ ] AC-1 新 cross 无 scope → 单 questioner 卡
- [ ] AC-2 显式 designer 仍产 designer 卡
- [ ] AC-3 改派 questioner→designer 恢复 designer 卡 + echo
- [ ] AC-4 老轮未下发 designer 卡 reconcile 收敛移除、已下发保留、questioner 保留
- [ ] AC-5 常量 / `resolveQuestionScope` 值 + 显式仍胜
- [ ] AC-6 self / 显式 scope golden-lock
- [ ] 门禁四项 + binary smoke + 前端 vitest 全绿
- [ ] Codex 设计门（本 RFC 落档后）+ 实现门（代码后）
- [ ] `STATE.md` / `design/plan.md` RFC 索引更新
