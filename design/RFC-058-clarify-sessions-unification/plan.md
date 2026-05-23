# RFC-058 Plan — 任务分解与 PR 拆分

> 状态：Draft（2026-05-23）
> 关联文档：[proposal.md](./proposal.md)、[design.md](./design.md)

## 1. 子任务编号 & 依赖

总分两 PR，**PR-A 必须先全绿落 main、再开 PR-B**（baseline 锁住行为是 PR-B 回归判据）。

### PR-A — baseline 测试加固（≥ 60 case 锁当前行为）

| Task ID    | 描述                                                                                                  | Size | Deps |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---- | ---- |
| RFC-058-T1 | shared envelope + prompt block render baseline（self / cross 两路径）                                | M    | —    |
| RFC-058-T2 | self-clarify service baseline（submit / cascade / inline / cutoff / directive trailer）              | M    | T1   |
| RFC-058-T3 | cross-clarify service baseline（submit / reject / multi-source / abandoned / wrapper-loop）          | L    | T1   |
| RFC-058-T4 | RFC-056 patch chain baseline（patch-2026-05-22..25 各 lock 1-2 case）                                 | M    | T2, T3 |
| RFC-058-T5 | scheduler dispatch + aging cutoff baseline（self / cross / mixed）                                    | M    | T2, T3 |
| RFC-058-T6 | REST + WS baseline（mixed inbox / 6 event payload / submit dispatch）                                | M    | T2, T3 |
| RFC-058-T7 | frontend baseline（list / detail / chip / reject modal / multi-source banner）                       | S    | T2, T3 |
| RFC-058-T8 | PR-A push + 等 CI 六 jobs 全绿 + STATE.md 顶部记进度                                                  | S    | T1-T7 |

PR-A 子任务规模合计：**4M + 3S + 1L**，估计单人 **5-7 个工作日**。

### PR-B — unification refactor（在 PR-A 基础上重构）

| Task ID    | 描述                                                                                                  | Size | Deps |
| ---------- | ----------------------------------------------------------------------------------------------------- | ---- | ---- |
| RFC-058-T9  | shared schemas 重写（ClarifyRound + ClarifyRoundSummary + applyAgingCutoff，删 ClarifySession / CrossClarifySession 等） | M    | T8   |
| RFC-058-T10 | shared clarify-cross.ts 合并入 clarify.ts + 测试守门                                                  | S    | T9   |
| RFC-058-T11 | backend migration 0031（建新表 + 行迁移 + 验证 + drop 旧表）+ migration test                          | M    | T9   |
| RFC-058-T12 | backend services/clarify.ts 合并（删 services/crossClarify.ts、抽 computeHistoryCutoff + buildPromptContext 等）| L    | T10, T11 |
| RFC-058-T13 | backend scheduler.ts 调用点重构（删 inline cutoff + 用 computeHistoryCutoff + buildPromptContext）   | M    | T12  |
| RFC-058-T14 | backend REST + WS broadcaster 适配（响应 ClarifyRound + 6 event 保留）                                | S    | T12  |
| RFC-058-T15 | RFC-053 invariant CR-1 适配（查询条件改 kind='cross'）                                               | S    | T11  |
| RFC-058-T16 | frontend 类型重命名 + 12 处 callsite + fixture 刷新                                                  | M    | T9, T14 |
| RFC-058-T17 | 新增测试 ≥ 22 case（aging / single-source grep / migration / REST / schema）+ PR-A baseline 零字节 diff 验证 | M    | T11-T16 |
| RFC-058-T18 | PR-B push + 等 CI 六 jobs 全绿 + STATE.md / 索引标 Done                                              | S    | T9-T17 |

PR-B 子任务规模合计：**4M + 4S + 1L + 1M**，估计单人 **5-7 个工作日**。

**总规模**：10-14 个工作日单人；两 PR 强序、PR-A 单独 push 落 main 再启 PR-B。

## 2. 详细任务说明

### PR-A — Baseline 测试加固

#### RFC-058-T1 — shared envelope + prompt block render baseline

**目标**：把 envelope 解析 / Q&A block 渲染 / framework synthesis / inline mode 等 shared 纯函数的当前行为字节级 snapshot 锁住。

**子项**：
- `packages/shared/tests/clarify-baseline-envelope.test.ts`（≥ 4 case）：self-clarify envelope happy + 错误码 `clarify-and-output-both-present` + truncation (questions > 5) + options truncation (options > 4)；cross-clarify envelope happy + 问题数 1+ 无截断 + options truncation reuse。
- `packages/shared/tests/clarify-baseline-prompt-render.test.ts`（≥ 4 case）：renderClarifyQuestionsBlock 单 question / 多 question + recommended 排序；buildClarifyPromptBlock 单选 / 多选 / custom_text；directive trailer 'continue' / 'stop' 双语；External Feedback block 单源 / 多源（字典序）。
- snapshot 文件落库到 `packages/shared/tests/__snapshots__/clarify-baseline/`。

**验收**：
- 8 case 新增、全绿。
- typecheck / lint / format:check 全绿。
- 现有 RFC-023 / RFC-056 shared 套件零退化。

#### RFC-058-T2 — self-clarify service baseline

**目标**：RFC-023 self-clarify service 路径行为锁住。

**子项**（`packages/backend/tests/clarify-baseline-service.test.ts`，≥ 18 case）：
- envelope → session 创建：agent-single + agent-multi shard child；新行字段完整。
- submit happy continue：directive='continue' + 触发 cascade rerun；新 node_run cci+1。
- submit stop：directive='stop' + STOP CLARIFYING anchor 注入 trailer。
- ifMatchIteration 乐观锁：409 case + 成功 case。
- multi-round：第 N 轮 rerun prompt 含 `### Round 1..N` 子段。
- inline mode：sessionMode='inline' + spawn 含 `--session` + prompt collapse 单轮；fallback 路径 missing-session-id / session-not-found / unsupported 三 subreason。
- 老化 cutoff（GENERAL 规则）：节点有 prior done + outputs → 该 cci 之前 round 不再注入；prior 无 outputs / 无 fresher → 全量注入。
- ask-bias preamble：hasClarifyChannel=true 注入 / false 不注入。
- review-iterate / process-retry 路径：applyLatestDirective=false 时 'stop' 不传给下游 prompt。
- canceled status：task cancel → 所有 awaiting_human session 升级 canceled。

#### RFC-058-T3 — cross-clarify service baseline

**目标**：RFC-056 cross-clarify service 路径行为锁住。

**子项**（`packages/backend/tests/cross-clarify-baseline-service.test.ts`，≥ 22 case）：
- envelope → session 创建：单源 + 多源（同 designer 两个 cross-clarify 节点各自）。
- iteration 累计：同 (cross-clarify node, loop_iter) 内单调递增；不同 loop_iter 独立。
- submit continue 单源：触发 designer rerun + External Feedback + Prior Output + Update Directive 三块拼装。
- submit continue 多源 readiness：未就绪 → outcome='designer-waiting' + banner peer 列表；全就绪 → outcome='designer-rerun-triggered'。
- submit continue 多源汇总 External Feedback：按 source nodeId 字典序拼接；每 source 子段 `### From ... (round N)`。
- reject 单源：directive='stop' + 立刻触发 questioner cascade rerun（不等 peer） + STOP CLARIFYING anchor。
- reject 持久性：被 stop 的 cross-clarify 节点 cascade reset 时跳过 awaiting_human、不创建新 session。
- abandoned 升级：CR-1 invariant 在 task=failed 时自动升级未消费 session。
- wrapper-loop partial persistence：iter 1 reject → iter 2 仍 STOP；iter 2 Q&A 历史复位 / cci 重计。
- 反问者 cascade rerun Q&A 注入：当前全量历史注入（这条是 baseline 当前真实行为；PR-B 后 cci 之前已 baked 的轮被过滤——但 baseline 测试锁住 PR-B 前的字节级 prompt 文本，所以新加 C3 守门 separate）。
- inline mode 双轴：sessionModeForDesigner / sessionModeForQuestioner 独立；fallback 3 subreason。
- abandoned chip / 详情页 status 渲染（前端单测会接，本任务只测 service 返回 status）。

#### RFC-058-T4 — RFC-056 patch chain baseline

**目标**：4 个 RFC-056 patch 各自 lock 的行为进 baseline，防止 PR-B 退化。

**子项**：
- **patch-2026-05-22 downstream cascade**：`packages/backend/tests/cross-clarify-baseline-cascade.test.ts` ≥ 3 case：triggerDesignerRerun 后下游 BFS minted pending、freshness invariant 兜底多 hop、`isClarifyChannelEdge` 在 cascade BFS 中正确识别。
- **patch-2026-05-22 questioner Q&A injection**：1 case：cross-clarify questioner cascade rerun prompt 含 `## Clarify Q&A` 全量历史（PR-B 后此 case 会变化由 aging 修复——baseline 锁的是 PR-B 前的字节级输出；C3 守门锁 PR-B 后的）。
- **patch-2026-05-23 designer-retry-index**：1 case：triggerDesignerRerun newCci 算法 `max(designer, questioner, session) + 1` 正确；in-attempt retry 后 cci 继承不丢。
- **patch-2026-05-24 retry-preserves-cci**：2 case：insertNodeRun inherit cci 字段正确传播；初次铸 / 重试铸两处 callsite 都写。
- **patch-2026-05-25 questioner cascade no-skip**：2 case：cascadeDownstreamFromDesigner 在 questioner 是 clarify-only done 时不 skip；5 处 insert site cci 继承（task.ts:690 / clarify.ts:169 / clarify.ts:406 / review.ts:451 / review.ts:1335）grep 守门。

合计 ≥ 9 case。

#### RFC-058-T5 — scheduler dispatch + aging cutoff baseline

**目标**：scheduler.ts 当前 dispatch 行为锁住——包括 cutoff 计算、cross / self 分支判定、isQuestionerCrossClarifyRerun gate。

**子项**（`packages/backend/tests/scheduler-clarify-baseline.test.ts`，≥ 5 case）：
- self-clarify dispatch：自反问后下一轮 prompt 走 `buildClarifyPromptContext`。
- cross-clarify designer dispatch：cci > 0 + hasExternalFeedbackChannel → 触发 `buildExternalFeedbackContext` + Prior Output。
- cross-clarify questioner dispatch：cci > 0 + clarifyMode='cross' → 触发 `buildQuestionerCrossClarifyContext`。
- aging cutoff 在 self-clarify 路径生效（priorCompletedTopLevelRun 存在）；不生效（不存在）。
- mixed：同节点既有 self-clarify 又被 cross-clarify 反馈时 clarify_iteration / cross_clarify_iteration 正交递增、prompt 含 `## Self Clarify Q&A` + `## External Feedback` 两段。

#### RFC-058-T6 — REST + WS baseline

**目标**：REST + WS 当前 wire 形态锁住——支持 PR-B wire 切换前后字节级一致性比对。

**子项**：
- `packages/backend/tests/clarify-baseline-rest.test.ts` ≥ 4 case：mixed inbox /api/clarify 列表（含 kind chip）；GET /api/clarify/:id self / cross 详情 DTO；POST /api/clarify/:id/answers self continue / cross continue / cross stop。
- `packages/backend/tests/clarify-baseline-ws.test.ts` ≥ 3 case：6 个 event payload 字段完整（clarify.created / clarify.answered / cross-clarify.created / .answered / .rejected / .designer-rerun-batched）。

#### RFC-058-T7 — frontend baseline

**目标**：前端关键交互行为锁 vitest snapshot。

**子项**（≥ 7 case）：
- `packages/frontend/tests/clarify-baseline-list.test.tsx`：mixed self + cross 列表渲染 + chip。
- `packages/frontend/tests/clarify-baseline-detail.test.tsx`：self 详情 Submit Continue / Submit Stop 双按钮；cross 详情 Submit + Reject 按钮 + 二次确认 modal；多源等待 banner；abandoned chip；keyboard navigation。

#### RFC-058-T8 — PR-A push + CI + STATE 同步

- `git add` 仅 PR-A 范围文件（不含 PR-B 任何更改）。
- commit message：`test(clarify): RFC-058 PR-A baseline ≥ 60 case 锁 RFC-023 + RFC-056 当前行为`。
- push origin → 等 CI 六 jobs 全绿。
- STATE.md 顶部 "进行中 RFC" 行更新进度："PR-A 完工，commit X、CI run Y；准备开 PR-B"。

PR-A 验收清单见 §3。

### PR-B — Unification 重构

#### RFC-058-T9 — shared schemas 重写

**目标**：`ClarifyRoundSchema` / `ClarifyRoundSummarySchema` 落地；删 6 个旧 schema export。

**子项**：
- 改 `packages/shared/src/schemas/clarify.ts`：详见 design.md §2.1。
- 新文件 `packages/shared/src/clarify-aging.ts`：`applyAgingCutoff` 纯函数。
- 新文件 `packages/shared/tests/clarify-rfc058-schema.test.ts` ≥ 8 case：详见 design.md §2.5。

#### RFC-058-T10 — shared clarify-cross.ts 合并入 clarify.ts

**目标**：clarify-cross.ts 物理删除、所有 export 搬入 clarify.ts。

**子项**：
- 复制 `packages/shared/src/clarify-cross.ts` 内容追加到 `packages/shared/src/clarify.ts`。
- 删 `packages/shared/src/clarify-cross.ts`。
- grep 全工程：`from '@agent-workflow/shared/clarify-cross'` / `from './clarify-cross'` 等 import 路径全部改为 `from './clarify'` / `from '@agent-workflow/shared/clarify'`。
- typecheck 全绿。

#### RFC-058-T11 — backend migration 0031

**目标**：DB schema + 行迁移 + drop 旧表落地；migration test ≥ 5 case。

**子项**：
- `packages/backend/src/db/migrations/0031-clarify-rounds-unify.ts`：详见 design.md §3.1 + §3.2。
- `packages/backend/src/db/schema.ts`：加 `clarifyRounds` drizzle 对象 + 关系；删 `clarifySessions` + `crossClarifySessions`。
- `packages/backend/tests/migration-0031-clarify-rounds.test.ts` ≥ 5 case：详见 design.md §3.3。

**验收**：
- migration 上行可跑 + 下行 rollback 不需要（生产数据未上、回滚 = revert commit）。
- typecheck 全绿。

#### RFC-058-T12 — backend services/clarify.ts 合并

**目标**：删 `services/crossClarify.ts`、所有 export 合并入 `services/clarify.ts`、按 kind 分支；抽 `computeHistoryCutoff` + `buildPromptContext` 等公共 helper。

**子项**：
- 详见 design.md §4.1-§4.4 API 设计。
- 重命名所有 export：`submitClarifyAnswers`（合并 self + cross）、`buildPromptContext`（合并 self + cross-designer + cross-questioner 三 consumerKind 分支）、`computeHistoryCutoff`、`triggerSelfClarifyRerun` / `triggerDesignerRerun` / `triggerQuestionerCascadeRerun`、`evaluateDesignerRerunReadiness`、`listClarifyRoundSummaries`、`getClarifyRoundByIntermediaryNodeRunId`。
- 内部 helper 用 `_` 前缀：`_commitSelfAnswers` / `_commitCrossAnswers` / `_renderClarifyPromptContext` / `_selectAnsweredRoundsForConsumer`。
- 删 `packages/backend/src/services/crossClarify.ts`。
- grep 全工程 `from.*services/crossClarify` 调用方更新（实际期望调用方都在 scheduler / runner / task / clarify route 等少数地方）。
- 新增 service-level 单测：`packages/backend/tests/clarify-service-unified.test.ts` 验证 submitClarifyAnswers 按 kind 分支正确路由。

#### RFC-058-T13 — backend scheduler.ts 调用点重构

**目标**：scheduler.ts:1283-1455 的 inline cutoff + 双 build 函数 dispatch 范围简化为 2-3 行调用。

**子项**：
- 删 inline `priorCompletedTopLevelRun` 计算（搬到 `computeHistoryCutoff`）。
- 删 `isQuestionerCrossClarifyRerun` vs self 分支的两条 build 函数路径，改为单 `buildPromptContext` 调用 + `consumerKind` 参数。
- 保留 `priorDoneDesigner` 查询（feed `priorDoneRun` 参数到 buildPromptContext），因为它是 RFC-056 §6 update mode 专属 + 与 cutoff 不同维度。
- 单测：`packages/backend/tests/scheduler-clarify-refactor.test.ts` ≥ 3 case：scheduler 调用 `computeHistoryCutoff` + `buildPromptContext` 路径正确（用 spy / mock）。

#### RFC-058-T14 — backend REST + WS broadcaster 适配

**目标**：响应 body 切单 `ClarifyRound`；6 个 WS event 名保留、broadcaster 函数适配新 schema。

**子项**：
- `packages/backend/src/routes/clarify.ts`：GET 列表返回 `ClarifyRoundSummary[]`；GET 详情返回 `ClarifyRound`；POST 接受 `SubmitClarifyAnswersSchema` 不变。
- `packages/backend/src/services/wsBroadcast.ts`（或现有 broadcaster 模块）：6 event 函数接受 `ClarifyRound` 参数、payload 字段保留（kind / taskId / nodeRunId / sessionId 等）。
- 单测：`packages/backend/tests/routes-clarify-rfc058.test.ts` ≥ 6 case：详见 design.md §5.4。

#### RFC-058-T15 — RFC-053 invariant CR-1 适配

**目标**：CR-1 invariant 查询 `clarify_rounds WHERE kind='cross'`，行为字节级不变。

**子项**：
- `packages/backend/src/services/lifecycleInvariants.ts`：CR-1 SQL / drizzle 查询条件改 `clarify_rounds` + `kind='cross'`。
- RFC-053 invariant 既有套件零退化：`packages/backend/tests/lifecycle-invariants-CR1.test.ts` fixture 同步 schema 变化、断言不变。

#### RFC-058-T16 — frontend 类型重命名 + 12 callsite

**目标**：删 6 个旧前端类型 import；12 处 callsite + fixture 切单 shape `ClarifyRound`。

**子项**：
- `packages/frontend/src/routes/clarify.tsx` / `clarify.detail.tsx` / `useClarifyWs.ts`：类型 + 数据 narrowing 改 `entry.kind` 分支。
- 12 处 callsite 详见 design.md §7.2 清单。
- fixture：`packages/frontend/tests/clarify-rfc056-*-route.test.tsx` 等共 ≥ 7 fixture 文件刷类型；snapshot 文件按 PR-A baseline 字节级保留（前端 snapshot 在 PR-A 落库）。

#### RFC-058-T17 — 新增测试 + PR-A baseline 分层 diff 验证

**目标**：新加 ≥ 25 case + 跑 PR-A 60+ case **分层 diff** 守门（Q3 决策）。

**子项**：
- 新加测试详见 design.md §8.3：cross-clarify-questioner-aging（2 case）+ cross-clarify-loop-iter-isolation（2 case，wrapper-loop 隔离修复）+ aging-single-source（1 case）+ migration-0031（6 case，含 DB CHECK 跨域约束 case）+ routes-clarify-rfc058（6 case）+ clarify-rfc058-schema（8 case）。
- 跑 PR-A baseline 60+ case：**面向用户层 snapshot 字节级 diff 必须为零**（prompt 文本 / REST body / WS payload / 面向用户 error code & message / 前端 DOM textContent）；行为级（log 内容 / 内部 var 名 / SQL 字符串）允许 refactor 微调；3 类例外标注 LOCKS：cross-clarify questioner aging gap（cci 维度）+ wrapper-loop loop_iter isolation（loop_iter 维度）+ snapshot 文件单独标注。
- 跑 RFC-023 + RFC-026 + RFC-039 + RFC-053 + RFC-056（含 4 patch）既有套件：全绿。
- DB CHECK 跨域约束（Q2 决策）落地：migration test 覆盖违反约束 case；application 层不再重复 if 检查 status 是否匹配 kind。

#### RFC-058-T18 — PR-B push + CI + 收官

- `git add` 仅 PR-B 范围文件。
- commit message：`refactor(clarify): RFC-058 PR-B 合表重构 + 反问者 aging gap 修复 + 删 services/crossClarify.ts`。
- push origin → 等 CI 六 jobs 全绿。
- STATE.md 顶部 "进行中 RFC" 行改为 "RFC-058 Clarify Sessions Unification 完工"（含 commit + CI run id）。
- design/plan.md RFC 索引行 Draft → Done。
- 通知用户：RFC-058 落地完成、RFC-059 现在可以解除 Blocked-by-RFC-058 状态、由用户决定何时开。

## 3. PR 拆分约束

每个 PR 落地约束：

- **PR-A**：
  - `bun run typecheck && bun run test && bun run format:check` 三件套全绿。
  - 新增 ≥ 60 baseline case 全绿。
  - **零 src/ 文件改动**（仅 tests/ 与 __snapshots__/ 新增 / 改动；测试 fixture 与 helper 是允许的 src 改动，但生产代码字节级不动）。
  - push CI 后等六 jobs 全绿。
  - 按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态。
  - STATE.md 同步 + Plan-A 完工标记。

- **PR-B**：
  - `bun run typecheck && bun run test && bun run format:check` 三件套全绿。
  - PR-A baseline 60+ case 字节级守门通过（≥ 58 case 零 diff、1-2 case 显式标注 aging gap 修复）。
  - 新增 ≥ 22 case 全绿。
  - typecheck 通过且 `ClarifySession` / `CrossClarifySession` / `ClarifyInboxEntry` 等旧类型名 grep 不到（除 RFC-059 占位文档）。
  - push CI 后等六 jobs 全绿。
  - STATE.md 同步 + RFC-058 标 Done + RFC-059 解除 Blocked-by 提示。

## 4. 验收清单

完工前逐条核对：

### 功能（对照 proposal.md §A）

#### PR-A
- [ ] T1 — shared baseline ≥ 8 case 全绿
- [ ] T2 — self-clarify service baseline ≥ 18 case 全绿
- [ ] T3 — cross-clarify service baseline ≥ 22 case 全绿
- [ ] T4 — RFC-056 patch chain baseline ≥ 9 case 全绿
- [ ] T5 — scheduler baseline ≥ 5 case 全绿
- [ ] T6 — REST + WS baseline ≥ 7 case 全绿
- [ ] T7 — frontend baseline ≥ 7 case 全绿
- [ ] T8 — PR-A push + CI 六 jobs 全绿 + STATE.md 同步

#### PR-B
- [ ] A1 — self-clarify byte-level 字节级一致
- [ ] A2 — cross-clarify byte-level 字节级一致
- [ ] A3 — cross-clarify reject byte-level 字节级一致
- [ ] A4 — multi-source byte-level 字节级一致
- [ ] A5 — wrapper-loop byte-level 字节级一致
- [ ] A6 — 反问者侧 aging gap 修复（C3 守门）
- [ ] A6b — wrapper-loop loop_iter 隔离修复（C6 守门）
- [ ] A7 — migration 0031 硬切 + 5 case 全绿
- [ ] A8 — services/crossClarify.ts 删除 + grep 不到
- [ ] A9 — aging GENERAL 单一入口 grep 守门（C4）
- [ ] A10 — 前端单 wire shape + 旧类型名 grep 不到
- [ ] A11 — 前端 12 处 callsite 全部切换
- [ ] A12 — PR-A baseline 零字节 diff（A6 例外）
- [ ] A13 — RFC-053 CR-1 适配通过
- [ ] A14 — WS event 名 6 个保留
- [ ] A15 — RFC-059 占位完整 + Blocked-by banner 正确

### 非功能（对照 proposal.md §B）

- [ ] B1 — bun run typecheck && bun run test && bun run format:check 全绿
- [ ] B2 — PR-A baseline + PR-B 后字节级 diff = 0
- [ ] B3 — backend tests ≥ +50 净增
- [ ] B4 — frontend tests ≥ +7 净增（PR-A baseline）
- [ ] B5 — Playwright e2e 全绿（既有 cross-clarify.spec.ts）
- [ ] B6 — 单二进制体积下降 + 启动时间不退化

### 回归防护（对照 proposal.md §C）

- [ ] C1 — self-clarify byte-level 守门
- [ ] C2 — cross-clarify byte-level 守门
- [ ] C3 — 反问者侧 aging gap 修复守门
- [ ] C4 — aging 单一入口 grep 守门
- [ ] C5 — migration 0031 hard-cut 守门（含 DB CHECK 跨域约束 case）
- [ ] C6 — wrapper-loop loop_iter 隔离修复守门

### 落地

- [ ] PR-A commit hash + CI run id 落 STATE.md
- [ ] PR-B commit hash + CI run id 落 STATE.md
- [ ] design/plan.md RFC-058 行 Draft → Done
- [ ] design/plan.md RFC-059 行 Blocked-by-RFC-058 → Draft（解除）
- [ ] GitHub Actions 六 jobs（Lint+Typecheck+Test × {macos, ubuntu} + Build single-binary × {macos, ubuntu} + Playwright e2e × {macos, ubuntu}）全绿
- [ ] 按 [feedback_post_commit_ci_check] 推完后立刻查 CI 状态

## 5. 风险缓解（实施层）

详见 proposal.md §7 + design.md §10。本节补 4 条实施层风险：

| 风险 | 缓解 |
|---|---|
| PR-A baseline 漏 case → PR-B 退化但未抓到 | 用户 + 1-2 reviewer sign-off PR-A 完成度；按 RFC-056 4 个 patch / RFC-023 既有 38 测试 / RFC-056 既有 ≥ 64 测试逐条对照 baseline 覆盖度 |
| PR-B 与并发 RFC-056 patch（譬如未来 RFC-056 patch-2026-05-26）冲突 | 上手前与 user 沟通确认 RFC-056 patch chain 已稳定 + 无 in-flight patch；如有 in-flight 先合入 main 再开 RFC-058 PR-B |
| migration 0031 在已运行 RFC-053 invariant loop 的 daemon 上启动失败 | invariant CR-1 在 migration 0031 上行后才适配新 schema；daemon 启动顺序：先 migration 跑完、再 invariant 注册（RFC-053 已有该顺序保证） |
| 前端 12 callsite 改动遗漏 1 处 → 运行时类型错误 | TypeScript strict 模式 + 删除旧类型 export 后 typecheck 立即报错；vitest 跑全 / 局部 manual e2e 覆盖关键路径 |

## 6. 实施顺序提示

接手 session 时：

1. 先读 STATE.md 找 RFC-058 进度（"PR-A 完工 / PR-B 进行中 / Done" 三态）。
2. 读 proposal.md / design.md 找最新决策；patch chain 同步 check 是否有新 RFC-056 patch。
3. 读本 plan.md 找下一个 T-N 任务。
4. 实现 + 测试 + push + 查 CI（[feedback_post_commit_ci_check]）。
5. 完工后更新 STATE.md（commit hash + CI run id）+ 本 plan.md 验收清单打勾。

PR-A 与 PR-B 强序：
- PR-A push → CI 六 jobs 全绿 → 用户 review approve → merge 到 main。
- 拉最新 main → 开 PR-B 分支 → 实施 T9-T18。
- PR-B push → CI 六 jobs 全绿 → 用户 review approve → merge 到 main。
- 全部完工 → RFC-059 解除 Blocked-by 提示、由用户决定何时开。
