# RFC-023 Plan — 实施任务分解

> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
>
> **PR 拆分建议**：4 个 PR。本 RFC 体量介于 RFC-005（5 PR）与 RFC-007（2 PR）之间——核心运行时复用 review 框架降低成本，UI 体量是 review 的 ~60%（无 markdown 渲染管线 / 无 diff view），因此 4 PR 更合适：schema → 运行时 → 前端 → e2e + 收尾。每个 PR 自带完整测试 + 文档同步，CI 全绿单独可合。

## 0. 前置

- 用户在对话中通过 ExitPlanMode（或等价的显式批准）接受 proposal / design / plan。
- 在 `STATE.md` 顶部追加 `"进行中 RFC：[RFC-023](./design/RFC-023-agent-clarify/proposal.md)"` 一行。
- `design/plan.md` RFC 索引追加 `RFC-023` 行，状态 `In Progress`。
- 由 PR1 开 branch；后续 3 个 PR 各自基于前一个的合并提交起新 branch。**不要拉长 branch 链**——每个 PR 合 main 后立即基于 main 开下一个，以避开同 session 中 RFC-021 / RFC-022 / RFC-020 in-flight 改动造成的脏 working tree。

## 1. PR 切分总览

| PR | 范围 | 关键交付 |
| --- | --- | --- |
| **PR-A** | Schema + Migration + Validator | shared schemas（含 clarify schemas & 新 builtin tokens）/ DB 0007 migration / workflow validator 新规则 / schema v2→v3 透明 migrator |
| **PR-B** | Runtime（envelope / runner / clarify service / scheduler / REST / WS / protocol block） | 后端全套反问业务逻辑 + REST + WS 事件 + agent-multi shard fanout 调度补强 |
| **PR-C** | Canvas + Inspector + 反向拖动 + /clarify 路由 + Form + draft + 左栏 badge | xyflow `ClarifyNode` 视觉、`clarifyDragHelper` 反向拖两条边、`QuestionForm`、list/detail 路由、`useClarifyWs` hook、IndexedDB draft、shard 切换器 |
| **PR-D** | e2e + design/design.md sync + STATE 收尾 + i18n 全集校验 | `e2e/clarify.spec.ts` 覆盖 A1 + A3（agent-multi shard）；`design/design.md` §3 / §5 / §7.4 / §9 / §4.3 增补；STATE / plan 收尾 |

## 2. 任务清单

### PR-A：Schema + Migration + Validator

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-023-T1 | shared schemas：`workflow.ts` NODE_KIND 加 `'clarify'` + WORKFLOW_SCHEMA_VERSION `2 → 3` + WORKFLOW_SCHEMA_VERSIONS 加 3 + `ClarifyNodeSchema`；新文件 `schemas/clarify.ts`（ClarifyQuestion / ClarifyEnvelopeBody / ClarifyAnswer / SubmitClarifyAnswers / ClarifySession）；`schemas/task.ts` 状态枚举加 `awaiting_human`（tasks + node_runs）；`schemas/ws.ts` 加 `clarify.created` / `clarify.answered`；`schemas/clarify.ts` 测试 5 case | `packages/shared/src/schemas/*.ts`、`tests/schemas/clarify.test.ts` | — |
| RFC-023-T2 | shared `clarify.ts`（纯函数）：常量 `CLARIFY_*_PORT_NAME` / `CLARIFY_MAX_*`、`parseClarifyEnvelopeBody`（zod + 截断 warning + 错误返回 issues[]）、`buildClarifyPromptBlock` / `summariseClarifyAnswer`（5 种 case 全覆盖）/ `renderClarifyQuestionsBlock` / `agentHasClarifyChannel` / `findClarifyNodeForAgent`；7 case 测试 | `packages/shared/src/clarify.ts`、`tests/clarify-utils.test.ts` | T1 |
| RFC-023-T3 | `packages/shared/src/prompt.ts`：BUILTIN_VARS 加 4 个 clarify token、`ClarifyPromptContext` interface、`RenderPromptInput.clarifyContext`、`renderUserPrompt` 4 case + auto-append `## Clarify Q&A` 章节、新 `buildClarifyProtocolBlock()`；6 case 测试（含源代码层 grep 4 token 名稳定性兜底） | `packages/shared/src/prompt.ts`、`tests/clarify-prompt-injection.test.ts` | T1 |
| RFC-023-T4 | DB schema：(a) `tasks.status` + `node_runs.status` enum 加 `awaiting_human`；(b) `node_runs` 加 `clarify_iteration INTEGER NOT NULL DEFAULT 0`；(c) 新表 `clarify_sessions` + 4 个索引（含 `idx_clarify_sessions_node_shard`）；`bun run drizzle-kit generate` 产 `0007_*.sql`；migration test 用 0005 后的真实 SQLite 文件跑 0007 → schema 一致 + 数据完整；含 v1（pre-RFC-005）/ v2（post-RFC-005）/ v3（本 RFC）三类 workflow $schema_version 共存 case | `packages/backend/src/db/schema.ts`、`packages/backend/db/migrations/0007_*.sql`、`packages/backend/tests/migration-0007.test.ts` | T1 |
| RFC-023-T5 | Workflow validator：7 条新规则（见 design.md §2.3）；`clarify-target-not-agent` 允许 `agent-single` + `agent-multi`、拒 wrapper / review / output / input / 另一 clarify；7 case 测试（每条 1 + grep 1 = clarify-target-validator.test.ts） | `packages/backend/src/services/workflow.validator.ts`、`packages/backend/tests/workflow-validator-clarify.test.ts`、`packages/backend/tests/clarify-target-validator.test.ts` | T1 |
| RFC-023-T6 | schema_version `v2 → v3` 自动 migrator：workflow GET 路径上检测 `$schema_version === 2` 时透明上提（v2 不带 clarify 节点，纯字段追加无风险）；同时保留 RFC-005 的 v1 → v2 路径；3 case 测试 | `packages/backend/src/services/workflow.ts`、`packages/backend/tests/workflow-schema-migrate-v3.test.ts` | T1, T5 |
| RFC-023-T7 | PR-A 收尾：`bun run typecheck && bun run test && bun run format:check` 全绿；commit + push；按 [feedback_post_commit_ci_check] 守 GH Actions | — | T2-T6 |

### PR-B：Runtime（review 业务逻辑无关，但与 review service 并列）

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-023-T8 | `services/envelope.ts`：新 `detectEnvelopeKind(stdout)` 返 `'output'/'clarify'/'both'/'none'` + `extractClarifyEnvelopeBody`；既有 output 解析路径零改动；6 case 测试（含 both 互斥 + 多 envelope 取最后 + 边界） | `packages/backend/src/services/envelope.ts`、`packages/backend/tests/envelope-clarify-parse.test.ts`、`packages/backend/tests/clarify-envelope-exclusive.test.ts` | PR-A |
| RFC-023-T9 | `services/clarify.ts`（新文件）：`createClarifySession` + `submitClarifyAnswers`（事务 + 乐观锁）+ `triggerAgentRerunFromClarify`（含 agent-multi shard 透传 + 仅重跑该 shard）+ `buildClarifyPromptContext`（按 sourceAgentNodeRunId 维度查最近 answered session）+ `summariseClarifyAnswer` server-side 镜像（防 client 伪造 selectedOptionLabels）+ `cleanupSessionsForTask`；8 case 测试 + 不影响 review 状态的回归 case（`clarify-no-cross-review-interference.test.ts` 1 case） | `packages/backend/src/services/clarify.ts`、`packages/backend/tests/clarify-service.test.ts`、`packages/backend/tests/clarify-no-cross-review-interference.test.ts` | T8 |
| RFC-023-T10 | `services/runner.ts` envelope 分支增强：探测 kind 后分流 output / clarify / both / none；agent-single + agent-multi 子 shard 走同一路径（沿用既有 `shardKey` 字段透传）；node_run 状态机：clarify 时本 node_run 仍 done（agent 成功表达了反问）+ 调 createClarifySession 落 awaiting_human；source code 层 grep 兜底 detectEnvelopeKind 调用点 | `packages/backend/src/services/runner.ts`、`packages/backend/tests/runner-clarify-branch.test.ts` | T9 |
| RFC-023-T11 | `services/scheduler.ts`：(a) clarify 节点 dispatch 短路（runtime 不主动调度，状态由 runner 写入）；(b) `recomputeTaskStatus` 加 awaiting_human 分支（优先级 > awaiting_review）；(c) submitClarifyAnswers 路径回滚 pre_snapshot + mint 新 agent node_run（clarify_iteration+1, retry_index=0, shardKey 透传）；(d) agent-multi 父节点 ready-to-aggregate：所有 shard done **且** 无 awaiting_human clarify_session；7 case 测试（含 agent-multi 部分 shard 反问 + 仅重跑该 shard + 父节点等所有 shard done 才聚合 + agent-single happy path） | `packages/backend/src/services/scheduler.ts`、`packages/backend/tests/scheduler-clarify-dispatch.test.ts`、`packages/backend/tests/clarify-options-cap.test.ts` | T9 |
| RFC-023-T12 | Prompt context wire-up：`scheduler.ts` 在 `runNode` 前调 `buildClarifyPromptContext` 注入 `RenderPromptInput.clarifyContext`；同 review 路径并列；agent 有 clarify channel 时 runner 在 user prompt 末尾追加 `buildClarifyProtocolBlock()`；2 case wire-up 测试 + 源代码层 `grep -q "buildClarifyPromptContext" scheduler.ts && grep -q "buildClarifyProtocolBlock" runner.ts` 兜底 | `packages/backend/src/services/scheduler.ts`、`packages/backend/src/services/runner.ts`、`packages/backend/tests/clarify-prompt-wire-up.test.ts` | T10, T11 |
| RFC-023-T13 | REST `routes/clarify.ts`：4 端点（GET list + GET pending-count + GET detail + POST answers），乐观锁 `If-Match: iteration` + body 字段二选一；token 鉴权；6 case integration test（含 shard_key 分组 + 列表 segmented filter + POST 412 conflict） | `packages/backend/src/routes/clarify.ts`、`packages/backend/tests/routes-clarify.test.ts` | T9 |
| RFC-023-T14 | WS：`/ws/workflows` 加 `clarify.created` / `clarify.answered` broadcast；payload 含 shardKey（agent-multi 路由分组用）；`tests/ws-clarify.test.ts` 2 case | `packages/backend/src/routes/ws.ts`（或现有 ws 文件） | T13 |
| RFC-023-T15 | PR-B 收尾：`typecheck && test && format:check` 全绿；commit + push；守 GH Actions；backend +32 case 达成 | — | T8-T14 |

### PR-C：Canvas + Inspector + /clarify 路由 + Form + draft + 左栏 badge

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-023-T16 | `clarifyDragHelper.ts`（新纯函数）：`buildClarifyEdges(sourceAgentNodeId, clarifyNodeId)` 返两条 edge、`isValidClarifyTarget(node)` 允许 agent-single + agent-multi、`hasExistingClarifyChannel(definition, agentNodeId)` 防重；5 case 测试 + 源代码层断言（`clarify-reverse-drag-two-edges.test.ts`） | `packages/frontend/src/components/canvas/clarifyDragHelper.ts`、`packages/frontend/tests/canvas-clarify-drag.test.ts`、`packages/frontend/tests/clarify-reverse-drag-two-edges.test.ts` | PR-A |
| RFC-023-T17 | `nodes/ClarifyNode.tsx` 视觉：xyflow 节点 + 1 进 1 出固定 handle + 4 态色块（pending / awaiting_human / answered / failed）+ header pill；`nodePalette.ts` "Human" 分类加 clarify 条目；2 case 视觉测试 | `packages/frontend/src/components/canvas/nodes/ClarifyNode.tsx`、`packages/frontend/src/components/canvas/nodePalette.ts`、`packages/frontend/tests/clarify-node-visual.test.tsx` | T16 |
| RFC-023-T18 | `WorkflowCanvas.handleConnect` 扩展：复用 RFC-007 review/output drag 同套 branch 风格，新增 clarify 反向拖动分支；`isValidConnection` 拒非 agent / 已挂 clarify；删除 answers→agent 边不影响注入路径的源码层兜底 | `packages/frontend/src/components/canvas/WorkflowCanvas.tsx` | T16, T17 |
| RFC-023-T19 | `NodeInspector.tsx` 加 `clarify` 分支：title / description input、只读"已挂接 agent: {id}"、wrapper-loop 检测显示提示、端口不可编辑；3 case 测试 | `packages/frontend/src/components/canvas/NodeInspector.tsx`、`packages/frontend/tests/node-inspector-clarify.test.tsx` | T17 |
| RFC-023-T20 | `lib/clarify/draftStore.ts`：复用 idb-keyval（RFC-005 已落 deps），key = `${taskId}:${clarifyNodeRunId}:${sessionId}`；getDraft / setDraft / deleteDraft / listDrafts；3 case | `packages/frontend/src/lib/clarify/draftStore.ts`、`packages/frontend/tests/clarify-draft-store.test.ts` | — |
| RFC-023-T21 | `QuestionForm` 组件：单选互斥 4 + 第 5 行 textarea；多选不互斥 4 + 第 5 独立 textarea；数字键 1-N+1 hotkey；required 推荐题判定；custom textarea 启用 / disabled / draft / submit-disabled state；8 case 测试 | `packages/frontend/src/components/clarify/QuestionForm.tsx`、`packages/frontend/src/components/clarify/RecommendedChip.tsx`、`packages/frontend/tests/clarify-question-form.test.tsx` | T20 |
| RFC-023-T22 | `/clarify` 路由（list）：segmented filter 待回答 / 已回答 / 全部 + 按 task 分组 + shard_key 显示 + 未读 badge；`useQuery(['clarify','list'])` + `useQuery(['clarify','pending-count'])`；3 case | `packages/frontend/src/routes/clarify.tsx`、`packages/frontend/tests/clarify-list-route.test.tsx` | T13, T21 |
| RFC-023-T23 | `/clarify/:nodeRunId` 详情路由：context card + truncation warning bar + shard 切换器（仅当同 task 同 clarifyNodeId 有 ≥ 2 awaiting shard 时）+ QuestionForm 列表 + 历史 sessions 只读列表 + 提交按钮；提交后跳回 list；3 case（含 shard 切换 + 历史 sessions 渲染顺序 + 推荐 chip 顺序）+ source code 层 grep `shard_key` UI 字段兜底 | `packages/frontend/src/routes/clarify.detail.tsx`、`packages/frontend/tests/clarify-detail-route.test.tsx` | T21, T22 |
| RFC-023-T24 | `hooks/useClarifyWs.ts`：WS 订阅 `/ws/workflows` + 过滤 `clarify.*` event + invalidate `['clarify','list']` / `['clarify','detail',nodeRunId]` / `['clarify','pending-count']`；自动重连 + since-id 续传；1 case（多 tab 一处提交对方实时切只读） | `packages/frontend/src/hooks/useClarifyWs.ts`、`packages/frontend/tests/use-clarify-ws.test.tsx` | T14, T23 |
| RFC-023-T25 | `__root.tsx` 左栏：Reviews nav 项之下加 Clarify 项 + `useQuery(['clarify','pending-count'])` badge + WS 订阅刷新；1 case | `packages/frontend/src/routes/__root.tsx`、`packages/frontend/tests/root-clarify-badge.test.tsx` | T22 |
| RFC-023-T26 | i18n：`zh-CN.ts` + `en-US.ts` 加 `clarify.*` section（按 design.md §12 索引约 30 条 key）；双语完整性测试 1 case | `packages/frontend/src/i18n/zh-CN.ts`、`packages/frontend/src/i18n/en-US.ts`、`packages/frontend/tests/i18n-clarify.test.ts` | T17-T25 |
| RFC-023-T27 | PR-C 收尾：typecheck / test / format 全绿；commit + push；守 GH Actions；frontend +26 case 达成 | — | T16-T26 |

### PR-D：e2e + design.md sync + STATE 收尾

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-023-T28 | `e2e/clarify.spec.ts`：fixture stub-opencode 第一轮 envelope=`<workflow-clarify>` 2 题、用户答题后第二轮 envelope=`<workflow-output>`；workflow `input → designer(agent-single) → clarify → reviewDesign(review)`；e2e 覆盖 A1 全链路 + 推荐 chip 渲染 + custom textarea 互斥行为；增加 `e2e/fixtures/stub-opencode-clarify.sh` | `e2e/clarify.spec.ts`、`e2e/fixtures/stub-opencode-clarify.sh`、`e2e/harness.ts`（如需扩展） | PR-C 合并 |
| RFC-023-T29 | `e2e/clarify.spec.ts` 第 2 子 case：agent-multi fan-out 3 shard，其中 1 个 shard 反问 → list 显示分组 + shard 切换器只显示 1 项（因为只 1 个 awaiting）→ 答完 → shard 重跑 → 父节点聚合 → task done | `e2e/clarify.spec.ts` 扩展 | T28 |
| RFC-023-T30 | `design/design.md` 同步：§3 数据模型加 `clarify_sessions` 表段 + `clarify_iteration` 字段说明；§5 加 clarify 节点 schema（第 8 类）；§7.4 envelope 解析加 `<workflow-clarify>` 协议块 + 互斥规则；§9 节点状态机加 awaiting_human + 优先级说明；§4.3 WS 频道加 `clarify.*` event；§11 配置表零增项（说明草稿走前端 maxLength + zod 兜底） | `design/design.md` | T29 |
| RFC-023-T31 | `STATE.md` 收尾：删"进行中 RFC"行；"已完成 RFC"表追加 RFC-023 行（关键产出按 RFC-005 那种密度写：shared schema bump v3 + ClarifyNodeSchema + 4 builtin tokens + clarify_sessions 表 + agent-multi shard fanout 反问 + REST/WS + canvas drag + Form + draft + e2e）；更新"最近更新"日期；`design/plan.md` RFC 索引 RFC-023 状态改 `Done` | `STATE.md`、`design/plan.md` | T30 |
| RFC-023-T32 | PR-D 收尾：`typecheck && test && format:check && build:binary smoke` 全绿；commit + push；守 GH Actions e2e job 全绿 | — | T28-T31 |

## 3. 执行顺序（依赖图）

```
PR-A:
  T1 (shared schemas) ─┬─ T2 (clarify utils)
                       ├─ T3 (prompt tokens)
                       ├─ T4 (DB migration 0007)
                       ├─ T5 (validator)
                       └─ T6 (schema v2→v3 migrator)
                       T7 (CI green)

PR-B:
  T8 (envelope) ── T9 (clarify service) ─┬─ T10 (runner branch)
                                          ├─ T11 (scheduler dispatch)
                                          ├─ T13 (REST)
                                          │     └─ T14 (WS)
                                          T12 (prompt wire-up)
  T15 (CI green)

PR-C:
  T16 (clarifyDragHelper) ── T17 (ClarifyNode visual) ── T18 (WorkflowCanvas branch)
                                                          T19 (NodeInspector branch)
  T20 (draft store) ── T21 (QuestionForm)
                              └─ T22 (/clarify list)
                                    └─ T23 (/clarify detail)
                                          └─ T24 (useClarifyWs hook)
                                          └─ T25 (left nav badge)
  T26 (i18n) ── T27 (CI green)

PR-D:
  T28 (e2e agent-single) ── T29 (e2e agent-multi fanout) ── T30 (design.md sync) ── T31 (STATE) ── T32 (CI green)
```

PR-A 内部 T1 是 critical path；T2–T6 可在 T1 后并行起。
PR-B 内部 T8 → T9 是串行；T10 / T11 / T13 都依赖 T9 但相互并行；T12 在 T10/T11 后；T14 在 T13 后。
PR-C 内部三条线在最前可并行：(T16-T19 canvas) / (T20-T21 form) / (T22+ 路由依赖前两条)。
PR-D 内部线性。

## 4. 验收清单（对齐 proposal §4）

### 功能

- [ ] **A1** S1 happy path e2e（PR-D T28）
- [ ] **A2** Answer injection in next-round prompt（PR-B T9 / T12 单元 + PR-D T28 e2e）
- [ ] **A3** agent-multi fan-out 每 shard 独立反问 / 仅重跑该 shard（PR-B T11 + PR-D T29 e2e）
- [ ] **A4** 互斥 envelope 拒绝（PR-B T8/T10 unit + PR-A T5 grep guard）
- [ ] **A5** 问题数 / 选项数宽容截断（PR-A T2 unit + PR-B T10 wire-up）
- [ ] **A6** options < 2 fail（PR-A T2 unit + PR-B T10）
- [ ] **A7** loop in clarify exit_condition port-empty 命中（PR-B T11 unit + PR-D T28 e2e 可选）
- [ ] **A8** loop 反问轮数 max_iterations exhausted（PR-B T11 unit）
- [ ] **A9** 单选互斥 / 多选不互斥 + custom textarea（PR-C T21）
- [ ] **A10** 推荐 chip + 数字键 1-5（PR-C T21）
- [ ] **A11** draft IndexedDB 关 tab 恢复（PR-C T20/T21）
- [ ] **A12** 多 tab WS 同步（PR-B T14 + PR-C T24）
- [ ] **A13** 反向拖动建两条 edge + 删 answers 边后注入仍正常（PR-C T16/T18）
- [ ] **A14** schema v2 → v3 透明上提（PR-A T6）
- [ ] **A15** clarify_iteration 与 review_iteration 正交（PR-B T9 / T11）
- [ ] **A16** task 顶层 awaiting_human / awaiting_review 同存优先级（PR-B T11）

### 非功能

- [ ] **B1** 三命令全绿（每 PR 末尾 Tx）
- [ ] **B2** RFC-005 / RFC-007 / RFC-014 既有测试零退化（每 PR diff 不动既有 spec 文件 + design.md §16 隔离审计 grep 兜底）
- [ ] **B3** backend tests +32（PR-A 12 + PR-B 20）
- [ ] **B4** frontend tests +26（PR-C 26）
- [ ] **B5** Playwright `e2e/clarify.spec.ts` 跑通双子 case（PR-D T28/T29）
- [ ] **B6** 单二进制构建包体积 / 启动时间不退化（PR-D T32 build smoke）
- [ ] **B7** 与 RFC-021 / RFC-022 兼容性回归（PR-D rebase 主干跑全套）

### 回归防护

- [ ] **C1** `clarify-envelope-exclusive.test.ts` 顶部注释 + 硬约束（PR-B T8）
- [ ] **C2** `clarify-prompt-injection.test.ts` grep 4 token 名（PR-A T3）
- [ ] **C3** `clarify-options-cap.test.ts` 锁 4 option / 5 question 上限（PR-A T2 + PR-B T11）
- [ ] **C4** `clarify-no-cross-review-interference.test.ts`（PR-B T9）
- [ ] **C5** `clarify-target-validator.test.ts` 锁 agent-single + agent-multi 通过 / wrapper 等拒绝（PR-A T5）
- [ ] **C6** `clarify-reverse-drag-two-edges.test.ts` 反向拖建两条 edge（PR-C T16）

## 5. 风险与回滚

| 风险 | 缓解 | 回滚路径 |
| --- | --- | --- |
| schema v3 migrator 在生产 v2 数据上失败 | T4 强制 migration test 用真实 v2 数据文件；上线前在本机跑一次完整 migration | drizzle migration 0007 可直接 down（drizzle-kit 生成的 down SQL 保留） |
| agent-multi shard 反问 + scheduler 父节点聚合判定 bug | T11 把 ready-to-aggregate 抽纯函数测试；e2e T29 双子 case 锁端到端 | 单 PR revert PR-B（PR-A 的 schema 保留，无副作用） |
| `<workflow-clarify>` 与 `<workflow-output>` 解析顺序 race（同一 stdout 写两段） | T8 解析器明确"任何 stdout 中同时出现两种 envelope 即 both"，不靠顺序判别 | 单 PR revert PR-B |
| draft IndexedDB 与 review draft 命名冲突 | T20 key 前缀 `clarify:` 区分；不直接 import review/draftStore（design.md §1 已注明） | 单 PR revert PR-C |
| `0007_*.sql` SQLite enum 重建路径上 lose data | T4 用 drizzle 默认 `INSERT INTO __new__ SELECT *` 模式 + 测试断言 v2 task / node_run 行迁移后字段不变 | drizzle migration 0007 down |
| 多 session 并发 working tree 中本 RFC 与 RFC-021/022 改 STATE.md 冲突 | 推之前 rebase + 按路径精确 `git add`；如冲突在 STATE.md 已完成 RFC 表区域，**保留对方行不删** | conflict 手动调和 |
| agent-multi shard 个数巨大（譬如 ≥ 20）+ 每个都反问 → 用户面对 100 题挫败感 | proposal §2.1 / design §11.2 在 detail 路由顶部显示 "本 task 还有 N 个待答 shard" 进度条；产品上不阻断但教育用户预期 | 文档说明 |
| WS 多 tab 同步丢事件 | T24 hook 重连后 refetch；REST GET detail 仍有兜底 | 无 |

## 6. 完工后

- `STATE.md`（T31）：把"进行中 RFC"行删；"已完成 RFC"表追加 RFC-023 行；关键产出列写：(a) shared schema bump v3 + ClarifyNodeSchema + 4 builtin tokens (`__clarify_questions__` / `__clarify_answers__` / `__clarify_iteration__` / `__clarify_remaining__`)；(b) DB 加 awaiting_human status + clarify_iteration 字段 + clarify_sessions 表 + 4 索引；(c) clarify service 全套（createSession / submitAnswers 含乐观锁 / triggerAgentRerun 含 agent-multi shard 透传 / buildClarifyPromptContext / summariseClarifyAnswer 确定性纯函数）；(d) envelope 双形态互斥解析；(e) protocol block `buildClarifyProtocolBlock()` 与既有 output block 并列追加；(f) REST `/api/clarify/*` 4 端点 + WS `clarify.created` / `clarify.answered`；(g) canvas 反向拖动建两条 edge + ClarifyNode 视觉 + Inspector 分支；(h) /clarify list + detail 路由含 shard 切换器；(i) QuestionForm 单选互斥 / 多选不互斥 + custom textarea + 数字键 hotkey；(j) IndexedDB draft 持久化；(k) e2e/clarify.spec.ts 双子 case（agent-single + agent-multi shard fanout）；(l) backend +32 test、frontend +26 test、e2e +2 sub-case；(m) 4 个 PR 合并完成。
- `design/plan.md`（T31）：RFC-023 索引状态改 `Done`。
- 每个 PR 推完按 [feedback_post_commit_ci_check] 立即查 GH Actions 全绿（含 e2e job）。
- 不更新 `design/proposal.md`（产品规格层）和 `design/design.md` §1（架构层）；新增的 clarify 节点视为 v1 之外的增量演化，仅 §3 / §5 / §7.4 / §9 / §4.3 五处增补（与 RFC-005 收尾风格一致）。
