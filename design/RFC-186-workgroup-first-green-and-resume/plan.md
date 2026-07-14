# RFC-186 任务分解——工作组到第一次绿 + 中断恢复

> 承接 [`proposal.md`](./proposal.md) / [`design.md`](./design.md)。零 migration。建议 **2 个 PR**（P0-A / P0-B），也可单 PR——但 T 顺序里的硬依赖必须守。

## PR 拆分建议
- **PR-1（P0-A：到第一次绿）**：T1–T4 + T8 的正向/重试 e2e。可独立交付、独立见「第一次绿」。
- **PR-2（P0-B：别再永久死）**：T5–T7 + T8 的中断 e2e。依赖 PR-1 已合（e2e 基建复用）。

## 子任务

### RFC-186-T1 —— followupMode 入 hook（failureCode 出已由 9874fffd 完成）
- **已在**：`WorkgroupHostRunResult.failureCode` + `runHostNode` 透传（9874fffd）。
- 本任务：`WorkgroupHostRunRequest` +`followupMode?: EnvelopeFollowupMode`；scheduler `runHostNode` 透传 `req.followupMode` 入 `runNode`；核对 iso/injection 致命路径（`:668/688`）带稳定致命码，缺则补。
- 依赖：无。

### RFC-186-T2 —— followupForFailure + 三 driver 失败分支收编为单表分派
- 新增 `followupForFailure(failureCode)`（薄封装 `FOLLOWUP_POLICY`/复用 `decideEnvelopeFollowup` 核心）。
- `driveLeaderTurn`/`driveAssignmentTurn`/`driveMessageTurn` 失败分支：保留 `CLARIFY_FORBIDDEN_PREFIX` 特判；**收编 9874fffd 的 `failureCode==='envelope-missing'` 臂 + 删 `startsWith('clarify-questions-')` 链**，统一走 `followupForFailure`——retry 设 `followupMode`（走 `renderEnvelopeFollowupPrompt`）continue、否则 fatal/assignment-failed；`driveMessageTurn` 非 done 也重试 + 耗尽发 `system` 房间提示。
- `WG_PROTOCOL_RETRIES` 1→3。
- 依赖：T1。**改动落在 9874fffd 同文件、同函数——在其基础上加，不回退。**

### RFC-186-T3 —— 协议块范例加锁（范例本体已由 9874fffd 加）
- 核对 `workgroupContext.ts:266-271` 现有 `<workflow-output>` 范例是否 per-role；非则补。
- 加存在性 + 端口一致性单测（每 role 范例含且仅含 `wgHostRolePorts(role)` 端口）。
- 依赖：无（可与 T1/T2 并行）。

### RFC-186-T4 —— PR-1 测试
- `workgroup-e2e.test.ts`（scenario-opencode）：AC1 正向到绿、AC2 信封重试恢复（leader+member）、边界超预算 fatal。
- 单元：`followupForFailure` golden 表；`WG_OUTPUT_FORMAT_EXAMPLE` 存在性+端口一致；源码文本锁（无 startsWith 链、failureCode 回传、retries≥3）。
- 依赖：T1–T3。

---

### RFC-186-T5 —— （前置）cursor 改 turn 后推进
- 三处 `advanceMemberCursor`（`:1020/1231/1385`）：turn 前快照 `turnStartMax`，turn 效果落库后再推进（理想同事务）。
- 单元：turn 效果未落即崩 → cursor 未推进。
- 依赖：无，但**必须先于 T6 合入**。

### RFC-186-T6 —— 重启对账 running-assignment × 终态 node_run
- 引擎载入加 `reconcileRunningAssignments`：done+merged→assignment done（补 result）；interrupted/failed→重派或 failed。
- 单元：纯函数期望 CAS 动作集合。
- 依赖：T5。

### RFC-186-T7 —— 接通 interrupted 恢复
- 去 `autoResume.ts:77` 排除 + 更新 `rfc108-auto-resume.test.ts:86-107` 锁定断言（有意行为变更）。
- `workgroupTasks.ts` kickResume（×3）放宽到任何可恢复态。
- （stretch）房间 Resume 入口直调 `resumeTask`。
- 依赖：T5、T6（否则 resume 丢活/撞死锁）。

### RFC-186-T8 —— PR-2 中断 e2e
- `workgroup-e2e.test.ts` 追加 AC5：worker `{crash:true}`→interrupted→resume→最终 done、结果未丢。
- 依赖：T5–T7。

## 验收清单（对齐 proposal §验收标准）
- [ ] AC1 真实 e2e：leader_worker 任务到 `done`，`__wg_member__` run done，worker 文件入 diff。
- [ ] AC2 信封重试：leader/member skipEnvelope 后仍到 done；超预算才 fatal。
- [ ] AC3 重试对齐：failureCode 回传、FOLLOWUP_POLICY 分派、renderEnvelopeFollowupPrompt 重提示、无 startsWith 链（源码锁+单测）。
- [ ] AC4 协议块含 `<workflow-output>` 范例（每 role，端口一致）。
- [ ] AC5 中断恢复真实 e2e：crash→interrupted→resume→done、未丢活。
- [ ] AC6 重启对账单测。
- [ ] `typecheck && lint && test && format:check` 全绿；CI + 单二进制 smoke + Playwright 绿；新 e2e 计入后端套件。
- [ ] Codex 设计门（批准前）+ 实现门各一次并折入。

## 实现记录（2026-07-14）
- **PR-1（P0-A + 真实 e2e）已落地 CI 绿**：`45c4ef9a`（T1-T4：followupForFailure 统一 FOLLOWUP_POLICY + retries 1→3 + message-turn 可见 + 12 单测/源码锁；主 CI ✅）+ `5c54abc7`（真实子进程 e2e：AC1 到 done / AC2 信封重试恢复 / fixture smoke；主 CI ✅）。基础 envelope-missing 重试 + `<workflow-output>` 范例先由并发 `9874fffd` 落，本 RFC 深化收编。
- **PR-2（P0-B 恢复）本次落地 T7+T6**：
  - **T7 接通 interrupted 恢复**：去 `autoResume.ts` turn-engine 排除 + 更 `rfc108-auto-resume.test.ts` 锁（改断言 lw/fc 也 resume）；真实 e2e「interrupted→autoResume→engine 再入→done」验证。
  - **T6 重启对账**：`decideAssignmentReconcile` 纯函数（undefined/interrupted/failed/canceled→redispatch、done→done、pending/running→none）+ `reconcileRunningAssignments` 引擎再入一次性对账 running-assignment×终态 node_run；纯函数单测 + 源码锁（`rfc186-resume-reconcile.test.ts`）。
- **T5（cursor 改 turn 后推进，audit §5 F6）延后**：这是对并发 owner 活跃函数的精细外科手术，只覆盖「中途 *leader* 轮崩溃→resume 跳过该轮」这一最窄子例，失败模式（跳过一轮→可恢复 re-park）远轻于 T7/T6 修的永久死/wedge，且**不损坏状态**（未持久化效果、无可丢）。为避免 session 尾部仓促改坏，作为 RFC-186 窄follow-up 留档：中途 leader 轮崩溃恢复仍可能丢该轮意图（非永久死、非损坏）。**T8（crash→resume e2e 的 running-assignment wedge 版）**同延后，其对账逻辑已由 T6 纯函数单测覆盖。

## 收尾
- `design/plan.md` RFC 索引 Draft→Done；`STATE.md` 进行中行移除/已完成表加行。
- push 后按 [feedback_post_commit_ci_check] 查 CI。
- Phase 2/3（fan-out 救回、clarify 老化 F4、TRAP-1 护栏、maxRounds 计数、monotonic ULID 等）**另立 RFC**，不在本 RFC。
