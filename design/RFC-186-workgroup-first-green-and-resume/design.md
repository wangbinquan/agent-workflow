# RFC-186 技术设计——工作组到第一次绿 + 中断恢复

> 承接 [`proposal.md`](./proposal.md)。任务分解见 [`plan.md`](./plan.md)。锚点依据 [`design/workgroup-e2e-audit.md`](../workgroup-e2e-audit.md)。

## §1 现状锚点

- 工作组轮驱动：`workgroupRunner.ts` `driveLeaderTurn`（失败分支 `:1042/1060/1067`）、`driveAssignmentTurn`（`:1253-1291`）、`driveMessageTurn`（`:1397` `!==done→return`）；`WG_PROTOCOL_RETRIES=1`（`:165`）；cursor 前置推进 `:1020/1231/1385`。
- Host hook：`scheduler.ts` `buildWorkgroupHooks.runHostNode`（`:656-1009`）——失败返回只带 `errorMessage`、**丢 `failureCode`**（`:668/688/941/1000`）。
- 已打磨的普通节点机制（复用目标）：`runNode` 接受 `followupMode` 并渲染 `renderEnvelopeFollowupPrompt`（`runner.ts:600-671`）；`RunResult` 带 `failureCode`（持久化列，`runner.ts:390`）；`scheduler.ts:1117` `decideEnvelopeFollowup` + `prompt.ts:948` `FOLLOWUP_POLICY: Record<FailureCode,{reason}>`。
- 中断恢复：`autoResume.ts:77`（`!isTurnEngineWorkgroupTask` 过滤）；`workgroupTasks.ts:396-453`（终态守卫 + kickResume 仅 `awaiting_human`）；`resumeTask` 服务其实通到 `runWorkgroupEngine`（`scheduler.ts:539`）。
- e2e 模板：`rfc167-dw-e2e.test.ts`（`startWorkgroupTask(..., {opencodeCmd:OPENCODE_CMD, awaitScheduler:true})`）+ `fixtures/scenario-opencode.ts`（`SCENARIO_PLAN_FILE={"<agent>":Step[]}`，Step 支持 `{skipEnvelope}`/`{crash}`）。

---

## §2 P0-A：信封重试**深化**为全量复用普通节点（承接 9874fffd）

**决策（用户选定）**：9874fffd 已把 `envelope-missing` 做成可重试（结构化 `failureCode`）并补了协议范例、拿到首绿——但**修法是最小补丁**：`result.failureCode === 'envelope-missing'` 特判 + 残留 `startsWith('clarify-questions-')` 字符串链混用、`WG_PROTOCOL_RETRIES=1`、重提示是手写 bullet。本 RFC **深化**为「不再手搓、统一走 `FOLLOWUP_POLICY` + `renderEnvelopeFollowupPrompt`」，死后只有一套逻辑。

> **协调提醒**：§2 全部改动落在 9874fffd 刚改过的 `workgroupRunner.ts`/`workgroupContext.ts`/`scheduler.ts`——**在其基础上加，不回退**（多人树原则）。

### §2.1 `failureCode` 贯穿 hook 边界 —— **已由 9874fffd 完成**
- `WorkgroupHostRunResult.failureCode?: FailureCode` ✅ 已在（`:1079` 已读它）；`runHostNode` 已透传 ✅。
- 本 RFC 仅新增 `WorkgroupHostRunRequest.followupMode?: EnvelopeFollowupMode`（`runNode` 已有类型），scheduler `runHostNode` 把 `req.followupMode` 透传进 `runNode`（收到即渲染 `renderEnvelopeFollowupPrompt`，`runner.ts:653-671`）。iso/injection 等 hook 自身失败（`:668/688`）确认带稳定致命 `failureCode`（如 `wg-iso-setup`/`wg-injection`）以便 §2.2 判 fatal——**若 9874fffd 未给这些致命路径赋码则补上**。

### §2.2 失败分派：clarify-forbidden 特判保留，其余走 `FOLLOWUP_POLICY`
新增共享判定（复用/薄封装 `decideEnvelopeFollowup` 的核心）：
```
followupForFailure(failureCode) →
  FOLLOWUP_POLICY[failureCode] 存在 ? { retry:true, reason }   // envelope-missing / *-malformed / port-validation …
                                    : { retry:false }          // wg-iso-setup / wg-injection / merge-conflict / spawn/timeout → fatal
```
三个 driver 的失败分支改写（现状：leader `:1047/1065/1079` 三臂混用、member `:1279/1287`、message `:1415` `!==done→return`）：
1. **`CLARIFY_FORBIDDEN_PREFIX`** → 维持现状（autonomous 软驳回 drop-and-continue / member floats up；这是工作组专有语义，不进 FOLLOWUP_POLICY）。
2. **否则** → `followupForFailure(result.failureCode)`：
   - `retry:true` 且 `attempt < WG_PROTOCOL_RETRIES` → 设 `followupMode`（含 reason + per-kind 修复块）供下次 `runHostNode`，`continue`。
   - `retry:false` 或耗尽 → **fatal `throw`（leader）/ assignment failed（member）**。
- **收编 9874fffd 的 `failureCode==='envelope-missing'` 特判** + 删掉 `startsWith('clarify-questions-')` 那条顺序敏感字符串链（审计 §2 P1-5）——两者统一进 `followupForFailure`。`driveMessageTurn` 的 `!==done→return`（`:1415`）改为：非 done 先按上式重试，耗尽再 return + 发 `system` 房间提示（审计 §2 P1-7）。

### §2.3 重提示复用 `renderEnvelopeFollowupPrompt`
`followupMode` 一旦设入下次 `runHostNode`→`runNode`，重提示由 `renderEnvelopeFollowupPrompt`（`runner.ts:653`）渲染：理由化开场 + 分 kind 修复块——取代现有 `## Protocol errors…Re-emit a CORRECT envelope.` 裸 bullet（`:1017-1019/:1228-1230`）。
> 说明：工作组每 attempt 重铸新 run（fresh 子进程，非同会话续跑）——本 RFC 保留该形态，followupMode 作为**完整纠正 prompt** 注入即可（拿到理由化文案 + 范例）；同会话续跑是更深的改动，留后续。

### §2.4 重试预算
`WG_PROTOCOL_RETRIES` 从 `1` 提到与普通节点默认同量级（`defaultNodeRetries ?? 3`，`scheduler.ts:2663`）。计入审计 §3-3 的轮数膨胀风险：本 RFC **不**改 `countRoundsUsed`（膨胀在 Phase 2 处理），但把重试上限设为可配/常量并在 §5 记明其与 maxRounds 的相互作用。

### §2.5 协议块 `<workflow-output>` 范例 —— **9874fffd 已加，本 RFC 仅加锁 + 补 per-role**
- 现状：`workgroupContext.ts:266-271` 已有字面 `<workflow-output>` 示例 + 「envelope shape is LITERAL」措辞。
- 本 RFC 仅：① 核对该范例是否**按 role**（leader 用 wg_assignments/wg_decision、worker 用 wg_result、fc_member +wg_tasks_add），若为通用则补 per-role；② 加**存在性 + 端口一致性单测**（每 role 范例含且仅含 `wgHostRolePorts(role)` 的端口，锁防漂移）——9874fffd 没加这条锁。若已 per-role 且够用，本项退化为纯加测试。

---

## §3 P0-B：中断恢复（顺序有硬依赖）

### §3.1（前置必做）cursor 改「turn 后推进」
审计 §5 F6：cursor 现在 turn **执行前**推进（`:1020/1231/1385`）→ 崩掉的 turn 在 resume 后 `hasUnconsumed=false` 被静默跳过。
- 改法：turn 开始前快照 `turnStartMax = maxMessageId(state.messages)`；**turn 效果持久化成功后**再 `advanceMemberCursor(member, turnStartMax)`（理想同事务）。崩在效果落库前 → cursor 不动 → resume 重导该 turn。
- 不变式：leader/member 自己本轮 post 的消息由 wake 逻辑按 author 排除（`hasUnconsumed` 不含自作），推进到 `turnStartMax`（而非含自作的新 max）语义正确、且不再吞崩掉的 turn。
- **必须先于/同步于 §3.2**，否则接通 resume 会静默丢活。

### §3.2 接通 interrupted 恢复
审计 §5 F1/F2：`interrupted` turn-engine 工作组三条出路全拒。
- **放开 boot 自动恢复**：去掉 `autoResume.ts:77` 的 `!isTurnEngineWorkgroupTask` 排除，让工作组与 DAG 任务走**同一** auto-resume 策略（`resumeTask`→`runTask`→`runWorkgroupEngine`，引擎 adopt pending + 重导 wake）。相应更新 `rfc108-auto-resume.test.ts:86-107` 那条**刻意锁排除**的断言（改为断言可恢复；这是本 RFC 的有意行为变更）。
- **房间/消息 kick 覆盖 interrupted**（F2）：`workgroupTasks.ts` 的 `/messages`(`:452`)/`/deliver`(`:518`)/config-`PATCH`(`:1008`) 的 `kickResume` 从「仅 `awaiting_human`」放宽到「任何可恢复态」（`kickResume` 本就对不可恢复态 `task-not-resumable` no-op，无条件调用安全）——这样 @成员 也能解卡，不再建悬空 assignment 黑洞。
- （可选，plan 里列为 stretch）房间显式「Resume」入口直调 `resumeTask` 服务（绕 builtin-403，先例 `taskQuestions.ts:176`）。

### §3.3 重启对账：running-assignment × 终态 node_run
审计 §4 F1：`running` assignment 的 node_run 已终态却无对账 → 永久卡 barrier。
- 引擎载入（`loadDbState` 后一个 reconcile pass）：对每个 `status==='running'` 的 assignment，看其 `nodeRunId` 指向的 node_run：
  - `done` 且 merge 完成 → CAS assignment `running→done`（补/合成 result summary 供 leader 聚合）。
  - `interrupted`/`failed` → CAS `running→dispatched`（重派）或 `→failed`（按重试预算）。
  - 仍活（有在途 driver）→ 不动。
- 消除「node_run 终态而 assignment 恒 running 且算 blocking→leader 永不醒」的死锁。

---

## §4 契约变更清单

| 位置 | 变更 | 类型 |
|------|------|------|
| `workgroupRunner.ts` `WorkgroupHostRunResult` | +`failureCode?: FailureCode` | 向后兼容新增 |
| `workgroupRunner.ts` `WorkgroupHostRunRequest` | +`followupMode?: EnvelopeFollowupMode` | 向后兼容新增 |
| `scheduler.ts` `runHostNode` | 透传 failureCode 出、followupMode 入；iso/injection 失败带稳定致命码 | 行为 |
| `workgroupRunner.ts` 三 driver 失败分支 | clarify-forbidden 特判保留；其余走 `followupForFailure`（FOLLOWUP_POLICY）；删字符串前缀链；message-turn 非 done 也重试+房间提示 | 行为 |
| `workgroupRunner.ts` `WG_PROTOCOL_RETRIES` | 1→3（对齐普通默认） | 行为 |
| `workgroupContext.ts` `renderWgProtocolBlock` | +按 role 的 `<workflow-output>` 范例（共享常量） | 行为 |
| `workgroupRunner.ts` cursor 推进（×3） | 前置→后置（turn 效果落库后） | 行为 |
| `autoResume.ts:77` | 去掉 turn-engine 工作组排除 | 行为 |
| `rfc108-auto-resume.test.ts:86-107` | 更新锁定断言（有意行为变更） | 测试 |
| `workgroupTasks.ts` kickResume 门（×3） | `awaiting_human`→任何可恢复态 | 行为 |
| 引擎载入 reconcile | running-assignment×终态 node_run 对账 | 新增 |

零 schema / migration / 前端（房间 Resume 按钮列为 stretch）。

## §5 失败模式与边界

1. **followupMode 用于 fresh 子进程**：非同会话续跑，模型看不到上一 attempt 的 transcript——但拿到理由化纠正 prompt + 范例，足以修复格式手滑（DP7BXB 类）。同会话续跑留 Phase 2。
2. **重试预算 × maxRounds**（审计 §3-3）：重试重铸 leader run 计入 `countRoundsUsed`，预算 3 会让一次 sloppy 聚合最多吃 ~3 轮。本 RFC 只把预算对齐、不改计数；§6 测试断言默认 maxRounds(20) 下正向仍绿。若实测吃紧，Phase 2 修计数。
3. **fatal 码判定**：`followupForFailure` 只对 FOLLOWUP_POLICY 内的码重试；iso/injection/merge-conflict/spawn/timeout 等不在其中 → 保持 fatal（正确）。需在实现时枚举核对 `FailureCode` 联合，防漏判把真致命错误误重试。
4. **cursor 后置 × 并发成员**：多成员各自 cursor 独立；后置推进只影响本 member，不串台。leader 聚合轮的 cursor 后置确保崩溃重导。
5. **接通 resume 的安全前提**：§3.1（cursor）+ §3.3（对账）是 §3.2 的硬前提——否则 resume 会丢活或撞死锁。plan 里 T 顺序强制。
6. **clarify-forbidden 语义不动**：RFC-181/183 的 autonomous 软驳回/delegated 不受影响（仍走特判分支，不进 FOLLOWUP_POLICY）。
7. **RFC-184 clarify 老化失效（F4）本 RFC 不碰**：host 节点已答 clarify 每轮重注入的问题独立、需产品决策，留后续；本 RFC 的正向 e2e 用不触发 clarify 的脚本避开。

## §6 测试策略（test-with-every-change）

**真实子进程 e2e（本 RFC 的核心——焊死 stub 缝，`buildWorkgroupHooks` 那条链）**，以 `rfc167-dw-e2e.test.ts` 为模板、`scenario-opencode.ts` 脚本化，新建 `workgroup-e2e.test.ts`：
- **AC1 正向到绿**：`leader_worker`（leader + 1 producer worker）。SCENARIO_PLAN：leader turn1=`{wg_assignments:[写文件], wg_decision:continue}` → worker turn1=`{wg_result}`（真写文件）→ leader turn2=`{wg_decision:done}`。断言任务 `status==='done'`、`__wg_member__` run `done`、worker 文件在任务 diff。
- **AC2 信封重试恢复**：leader turn1=`{skipEnvelope:true}`（→envelope-missing）→ turn... 断言首个 leader run failed(envelope-missing)、同 turn 重试后任务仍 `done`（锁 P0-A 非 fatal）。member 版：worker turn1 skipEnvelope → 重试恢复。
- **AC5 中断恢复**：worker turn1=`{crash:true}` → 任务 `interrupted` → 触发 resume（模拟 boot auto-resume 或房间 kick）→ 断言最终 `done`、且 leader 聚合未丢 worker 结果（cursor 修复生效）。
- **AC 边界**：leader 连续 2 次 skipEnvelope（超预算）→ 断言最终 fatal（锁「耗尽才死」）。

**纯函数/单元（首选可断言面）**
- `followupForFailure`：`envelope-missing`/`clarify-questions-malformed`/`port-validation-*`→retry；`wg-iso-setup`/未知致命码→fatal；golden 表联合类型驱动（防新 FailureCode 漏判）。
- `WG_OUTPUT_FORMAT_EXAMPLE` 存在性 + 与 `wgHostRolePorts` 端口一致（每 role 范例含且仅含该 role 端口）。
- cursor 后置：给定「turn 效果未落库即崩」→ cursor 未推进（纯函数或小集成断言）。
- 重启对账纯函数：`reconcileRunningAssignments(assignments, nodeRuns)` → 期望 CAS 动作集合。

**源码文本锁（兜底）**
- `workgroupRunner.ts` 失败分支不再出现 `startsWith('clarify-questions-')` / `startsWith('envelope`（改走 followupForFailure）。
- `runHostNode` 返回带 `failureCode`；`WG_PROTOCOL_RETRIES` ≥ 3。
- cursor 推进在 `runHostNode` 调用**之后**（源码顺序断言或注释锚点）。

测试文件顶部注释链接本 RFC + 审计 + 三个死亡任务 id（F42SE/E0RBDE/DP7BXB）。
