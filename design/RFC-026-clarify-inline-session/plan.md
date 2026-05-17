# RFC-026 Plan — 实施任务分解

> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
>
> **PR 拆分建议**：2 个 PR。本 RFC 体量小（backend +120 行 / frontend +40 行 / shared +30 行 / migration +1 列），不需要按 schema → runtime → frontend 三段切——按"后端 + migration"和"前端 + e2e + 收尾"两段切即可。每 PR 自带完整测试 + CI 全绿可独立合。

## 0. 前置

- 用户在对话中通过 ExitPlanMode（或等价的显式批准）接受 proposal / design / plan。
- 在 `STATE.md` 顶部追加"进行中 RFC：[RFC-026](./design/RFC-026-clarify-inline-session/proposal.md)"一行。
- `design/plan.md` RFC 索引追加 `RFC-026` 行，状态 `In Progress`。
- 由 PR1 开 branch；PR2 基于 PR1 合并提交起新 branch。

## 1. PR 切分总览

| PR | 范围 | 关键交付 |
| --- | --- | --- |
| **PR-A** | Schema + Migration + Backend Runtime（runner / scheduler / clarify service / fallback） | shared `sessionMode` 字段 + ClarifyPromptContext 扩展 + `buildClarifyInlineReminder` + node_runs migration 0008 + runner `resumeSessionId` + scheduler inline 判定 + clarifyFallback + sessionId persist + events |
| **PR-B** | Frontend Inspector + 节点 stats chip + 事件流渲染 + i18n + e2e + design.md / STATE 收尾 | NodeInspector segmented + chip + 事件行样式 + 6 条 i18n key + e2e 扩展 + STATE/plan 收尾 |

## 2. 任务清单

### PR-A：Schema + Migration + Backend Runtime

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-026-T1 | shared `workflow.ts`：`ClarifyNodeSchema` 加 optional `sessionMode` 枚举；`shared/clarify.ts` 加 `resolveClarifySessionMode(node)` 默认 `'isolated'`；3 case schema 测试 | `packages/shared/src/schemas/workflow.ts`、`packages/shared/src/clarify.ts`、`tests/clarify-schema-session-mode.test.ts` | — |
| RFC-026-T2 | shared `prompt.ts`：`ClarifyPromptContext` 加 `mode` / `currentRoundOnly` 字段；`renderUserPrompt` 在 inline 模式下只 emit `## Clarify Q&A — User Answers`（不 emit Last-Round Questions）；新 `buildClarifyInlineReminder()`；4 case 测试（含 isolated 行为字符串 byte-for-byte 不变断言） | `packages/shared/src/prompt.ts`、`tests/clarify-prompt-inline.test.ts` | T1 |
| RFC-026-T3 | DB schema：`node_runs` 加 `opencodeSessionId TEXT` nullable；drizzle-kit 生成 `0008_*.sql`（仅 `ALTER TABLE ... ADD COLUMN`）；migration test 1 case（pre/post schema 一致 + 旧行 NULL 透明 + drizzle introspect 通过） | `packages/backend/src/db/schema.ts`、`packages/backend/db/migrations/0008_*.sql`、`tests/migration-0008.test.ts` | — |
| RFC-026-T4 | `services/runner.ts`：`RunNodeOptions` 加 `resumeSessionId?: string`；`buildCommand` resumeSessionId 非空时追加 `'--session', resumeSessionId`；protocol block helper 分支：inline → `buildClarifyInlineReminder()`、isolated → `buildClarifyProtocolBlock()`；2 case spawn args 测试 + 源码层 grep 守卫 | `packages/backend/src/services/runner.ts`、`tests/runner-resume-session-flag.test.ts`、`tests/clarify-inline-spawn-args.test.ts` | T2 |
| RFC-026-T5 | 新文件 `services/clarifyFallback.ts`：`detectSessionNotFoundFromStderr` 多 pattern + `decideResumeSessionId` 纯函数；3 case 测试 | `packages/backend/src/services/clarifyFallback.ts`、`tests/clarify-fallback.test.ts` | — |
| RFC-026-T6 | `services/clarify.ts`：`buildClarifyPromptContext` 加 `mode` 参数；inline 仅查最新一轮 answered session，isolated 行为不变；2 case + 源码层 grep mode 参数被调用 | `packages/backend/src/services/clarify.ts`、`tests/clarify-service-inline-context.test.ts` | T1, T2 |
| RFC-026-T7 | `services/scheduler.ts`：(a) clarify 触发 agent 重跑前查 sessionMode + source.opencode_session_id；(b) inline 路径填 `resumeSessionId` + `mode: 'inline'`；(c) RunResult.sessionId 完成后 UPDATE node_runs.opencode_session_id；(d) inline 路径跳过 worktree restoreSnapshot；(e) review/retry/loop 路径显式不传 resumeSessionId；(f) 写 info/warning 事件行；6 case 测试覆盖 inline happy / missing-session-id 回退 / session-not-found 后 retry / agent-multi shard 续 / loop 跨 iter 不续 / review reject 不走 inline | `packages/backend/src/services/scheduler.ts`、`tests/scheduler-clarify-inline.test.ts`、`tests/scheduler-clarify-inline-events.test.ts`、`tests/review-reject-not-inline.test.ts`、`tests/clarify-inline-loop-isolation.test.ts` | T3, T4, T5, T6 |
| RFC-026-T8 | 回归防护：`clarify-inline-isolated-parity.test.ts` 锁定 isolated 路径生成的 spawn args + prompt 与 RFC-023 落地版 byte-for-byte 相等；`clarify-inline-fallback.test.ts` 枚举所有 fallbackReason 子原因；2 spec | `packages/backend/tests/clarify-inline-isolated-parity.test.ts`、`packages/backend/tests/clarify-inline-fallback.test.ts` | T4-T7 |
| RFC-026-T9 | PR-A 收尾：`bun run typecheck && bun run test && bun run format:check` 全绿；commit + push；按 [feedback_post_commit_ci_check] 守 GH Actions 全绿 | — | T1-T8 |

### PR-B：Frontend + e2e + 收尾

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-026-T10 | i18n：zh-CN.ts + en-US.ts 加 6 条 `clarify.inspector.sessionMode.*` / `clarify.eventStream.*` / `clarify.node.chip.inline` key；双语完整性测试 1 case | `packages/frontend/src/i18n/zh-CN.ts`、`packages/frontend/src/i18n/en-US.ts`、`packages/frontend/tests/i18n-clarify-inline.test.ts` | PR-A |
| RFC-026-T11 | `NodeInspector.tsx` clarify 分支扩展：segmented sessionMode 选择器 + 帮助文字 + 切换触发 workflow PUT；旧节点（无 sessionMode 字段）默认渲染 isolated；2 case | `packages/frontend/src/components/canvas/NodeInspector.tsx`、`packages/frontend/tests/node-inspector-clarify-session-mode.test.tsx` | T10 |
| RFC-026-T12 | task 详情节点 stats tab chip："session=inline" chip 在 inline 模式下显示；isolated 不显示；事件流行渲染 info `clarify-session-resumed` + warning `inline-clarify-fallback-to-isolated`（带 reason 子标签）；2 case | `packages/frontend/src/routes/tasks.$taskId.tsx`（或既有节点行渲染处）、`packages/frontend/tests/node-stats-session-chip.test.tsx` | T10 |
| RFC-026-T13 | e2e `e2e/clarify.spec.ts` 扩展：新增 inline 模式子 case——fixture stub-opencode 第一轮吐 sessionId + clarify、第二轮检测命令行 `--session` 决定返回内容；断言 spawn 命令行含 `--session <id>` + 第二轮 user prompt 不含 "Last-Round Questions" 段 + 任务最终 done | `e2e/clarify.spec.ts`、`e2e/fixtures/stub-opencode-clarify-inline.sh` | PR-A 合并 + T11 |
| RFC-026-T14 | `design/design.md` 同步：§3 数据模型 node_runs 加 `opencode_session_id` 列描述；§7.4 在 RFC-023 段后追加 1 段引 RFC-026 inline 模式说明 | `design/design.md` | T13 |
| RFC-026-T15 | `STATE.md` / `design/plan.md` 收尾：删"进行中 RFC"行 + "已完成 RFC"表追加 RFC-026 行；plan RFC 索引 RFC-026 状态改 `Done`；关键产出按 RFC-023 收尾密度写 | `STATE.md`、`design/plan.md` | T14 |
| RFC-026-T16 | PR-B 收尾：`typecheck && test && format:check && build:binary smoke` 全绿；commit + push；守 GH Actions e2e job 全绿 | — | T10-T15 |

## 3. 执行顺序（依赖图）

```
PR-A:
  T1 (schema) ── T2 (prompt) ── T4 (runner)
  T3 (migration) ─────────────────────────── T7 (scheduler) ── T8 (regression guards) ── T9 (CI green)
  T5 (fallback) ─────────────────────────────╯
  T6 (clarify service) ──────────────────────╯

PR-B:
  T10 (i18n) ─┬─ T11 (Inspector)
              └─ T12 (chip + events)
                 T13 (e2e) ── T14 (design.md) ── T15 (STATE) ── T16 (CI green)
```

PR-A 内 T1/T3/T5 互不依赖、可并行起；T2 依赖 T1；T4 依赖 T2；T6 依赖 T1+T2；T7 依赖 T3+T4+T5+T6；T8 最后；T9 收尾。
PR-B 内 T11/T12 都依赖 T10 i18n；T13 依赖 PR-A 合并 + T11；T14-T16 线性。

## 4. 验收清单（对齐 proposal §4）

### 功能

- [ ] **A1** isolated 行为零差异（PR-A T8 byte-for-byte parity 测试）
- [ ] **A2** inline happy path（PR-A T4 spawn args + T7 scheduler + PR-B T13 e2e）
- [ ] **A3** sessionId 持久化（PR-A T3 schema + T7 UPDATE）
- [ ] **A4** inline 回退：sessionId 缺失（PR-A T7 + T8）
- [ ] **A5** inline 回退：session-not-found（PR-A T5 + T7 + T8）
- [ ] **A6** inline + agent-multi shard（PR-A T7 fanout 分支测试）
- [ ] **A7** loop 跨 iter 不续（PR-A T7 子 case `clarify-inline-loop-isolation`）
- [ ] **A8** Inspector UI 切换（PR-B T11）
- [ ] **A9** 事件流 info/warning（PR-A T7 + PR-B T12）
- [ ] **A10** i18n 完整（PR-B T10）
- [ ] **A11** migration 透明（PR-A T3）
- [ ] **A12** review reject 不带 --session（PR-A T7 `review-reject-not-inline.test.ts`）
- [ ] **A13** 手动 retry 不带 --session（PR-A T7 隐式覆盖 + retryIndex>0 分支测试）

### 非功能

- [ ] **B1** 三命令全绿（T9 / T16）
- [ ] **B2** RFC-005 / RFC-014 / RFC-023 既有测试零退化 + diff guard（T8 parity 测试）
- [ ] **B3** backend tests +14（T1+T2+T3+T4+T5+T6+T7+T8 合计）
- [ ] **B4** frontend tests +6（T10+T11+T12）
- [ ] **B5** e2e 加 1 子 case（T13）
- [ ] **B6** 单二进制构建包体积 / 启动时间不退化（T16 build smoke）

### 回归防护

- [ ] **C1** `clarify-inline-isolated-parity.test.ts`（PR-A T8）
- [ ] **C2** `clarify-inline-spawn-args.test.ts`（PR-A T4）
- [ ] **C3** `clarify-inline-fallback.test.ts`（PR-A T8）
- [ ] **C4** `review-reject-not-inline.test.ts`（PR-A T7）
- [ ] **C5** `clarify-inline-loop-isolation.test.ts`（PR-A T7）

## 5. 风险与回滚

| 风险 | 缓解 | 回滚路径 |
| --- | --- | --- |
| inline 在某 opencode minor 版本上回归 | daemon minVersion 守 + stderr 自动 fallback | 用户切回 isolated 模式即可（节点字段一改瞬时生效） |
| migration 0008 ALTER TABLE 在大型 SQLite 数据库上慢 | SQLite ALTER ADD COLUMN 是 O(1) metadata 操作，不重写行 | drizzle migration down (`DROP COLUMN`)，0008 整体撤回 |
| stderr false positive 触发误 fallback | regex 限制 + multi-pattern + warning 输出 reason 子标签让 ops 查 | 单 PR revert PR-A scheduler.ts 部分；schema 列保留无副作用 |
| 现有 RFC-023 测试因 prompt.ts emit 顺序微调而变红 | T2 显式断言 byte-for-byte parity，强制本 PR 行为不动既有 emit 路径 | 修 T2 或 prompt.ts 直到 parity 通过；不应回退 RFC-023 测试 |
| 多 session 并发 working tree 中本 RFC 与其他 in-flight RFC 冲突 STATE.md | rebase 前按路径精确 `git add`；STATE.md 冲突区"已完成 RFC"表保留对方行 | 冲突手动调和 |

## 6. 完工后

- `STATE.md`（T15）：删"进行中 RFC"行；"已完成 RFC"表追加 RFC-026 行，关键产出写：(a) ClarifyNodeSchema `sessionMode` 可选字段（默认 isolated）；(b) DB migration 0008：`node_runs.opencode_session_id` 列；(c) runner `resumeSessionId` + `--session` 透传；(d) scheduler inline 判定 + sessionId persist + fallback；(e) clarify service `buildClarifyPromptContext` mode 参数（inline 只查最新轮）；(f) shared `buildClarifyInlineReminder` 替代完整协议块在 inline 路径；(g) NodeInspector segmented sessionMode + 节点 stats chip + 事件流 info/warning；(h) 6 条 i18n key；(i) `e2e/clarify.spec.ts` 新增 inline 模式子 case；(j) backend +14 test / frontend +6 test / e2e +1；(k) 2 个 PR 合并完成。
- `design/plan.md`（T15）：RFC-026 索引状态改 `Done`。
- 每个 PR 推完按 [feedback_post_commit_ci_check] 立即查 GH Actions 全绿（含 e2e job）。
- 不更新 `design/proposal.md` / `design/design.md §1`；仅 design/design.md §3 / §7.4 增补两处。
