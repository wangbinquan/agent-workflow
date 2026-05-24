# RFC-062 — 调度器 stall 三层防御（任务分解）

> 配套 [proposal.md](./proposal.md) + [design.md](./design.md)。
> 当前状态：**Draft**，等用户批准后进入 PR-A。

## 整体约束

- **3 PR 强序、可独立合并**：每 PR 自含价值，CI 绿即可合；不依赖后续 PR 才"完整"。
- **每 PR 测试随改动落地**（CLAUDE.md "Test-with-every-change"）；不允许"先实现、补测试"。
- **每 commit push 后立刻按 `feedback_post_commit_ci_check`** 查 GitHub Actions 状态（不能"绿了再走"假设）。
- **多人 working tree 安全**（CLAUDE.md "Multi-person collaboration"）：commit 只提自己的改动，不动他人未提的文件；`design/plan.md` / `STATE.md` 索引行只加自己的、不动他人的。
- **格式三件套**：每次 commit 前 `bun run typecheck && bun run test && bun run format:check` 必须本地全绿。
- **opencode 源码自取**（CLAUDE.md "opencode 源码自取规则"）：本 RFC 不涉及 opencode 子进程行为，不需要自取；如 PR-B fixture 需要"opencode envelope 格式"做断言，按规则去 `packages/opencode/src/` grep 引用。

## PR-A 契约层 + scanner 修复 + 立即解锁（~3 天）

### 目标

把"feedback edge 不是 gate"从私有常量提升为公共契约 + 修当前 deadlock + 装 grep guard + 顺手修 daemonResume Step 4。落地即解锁今天的 incident 任务。

### 子任务

- **RFC-062-T1** 新 `packages/shared/src/workflow/edges.ts`（`SYSTEM_PORT_NAMES` / `WorkflowEdgeLike` / `isFeedbackEdge` / `filterDataEdges` / `filterFeedbackEdges`）+ 从 `packages/shared/src/index.ts` re-export。
  - **测试**：`packages/shared/tests/rfc062-workflow-edges.test.ts` ≥ 8 case（正向 + 边界）。
- **RFC-062-T2** `packages/shared/src/prompt.ts:266` 删除私有 `SYSTEM_PORT_NAMES`，改为 `import` 自 `./workflow/edges`。
  - **回归保护**：现有 `prompt.test.ts` 全绿。
- **RFC-062-T3** `packages/backend/src/scheduler-v2/readyScanner.ts:175 scanFreshDownstream` 改用 `filterDataEdges`。
  - **测试**：`packages/backend/tests/rfc062-scanner-feedback-edge.test.ts` ≥ 6 case。
- **RFC-062-T4** `packages/backend/src/scheduler-v2/launcher.ts:134-144 findEntryNodes` + `178-220 makeUpstreamInputsResolver` 同样过 `filterDataEdges`。
  - **测试**：`packages/backend/tests/rfc062-launcher-upstream-resolver.test.ts` ≥ 3 case。
- **RFC-062-T5** `packages/backend/src/services/fanout.ts:70/86/125/187` audit 改 `filterDataEdges`。
  - **测试**：现有 fanout 测试零回归；若发现行为差异（例如某测试隐式依赖 feedback edge 参与 shard）→ 测试本身需更新 + commit message 显式说明。
- **RFC-062-T6** `packages/backend/src/services/workflow.validator.ts:97` 拆出 `validateDataAcyclic(dataEdges)` + `validateFeedbackEdgesHaveSources(feedbackEdges)`。
  - **测试**：现有 validator 测试零回归 + 加 2 case 覆盖 feedback edge 形成 self-loop 不再被 cycle detector 误报。
- **RFC-062-T7** `packages/backend/src/services/task.ts:664` snapshot edges 用途 audit。若仅做 input 端口解析 → `filterDataEdges`；若另有用途 → 注释 `// edges:include-system <reason>` 显式表态。
- **RFC-062-T8** `packages/backend/src/scheduler-v2/daemonResume.ts` 删除"caller's responsibility for now / unused in production"段，Step 4 真正 spawn actor loops；从 `services/task.ts` 拆出 `launchTaskActor(taskId)` 公共 helper（读 task row → 调 `runTaskActorViaProduction`）。`cli/start.ts:138-139` 不变。
  - **测试**：`packages/backend/tests/rfc062-daemon-resume-spawns-actors.test.ts` ≥ 3 case（resume 后非终态任务 events 表确实有新增；多任务并发 spawn 不互相阻塞；terminal task 不被 spawn）。
- **RFC-062-T9** grep guard 落地：
  - `packages/backend/tests/rfc062-edges-guard.test.ts`（扫所有 `.ts` 文件强制 `filterDataEdges` 或注释豁免）
  - `packages/backend/tests/rfc062-no-deferred-todo.test.ts`（"未接通占位"禁词扫描）
  - **测试**：每个 guard 文件 1 case；guard 自身的负面 case（故意写一条违例确认 guard 能 catch）放 `__fixtures__/` 子目录。
- **RFC-062-T10** 验证 incident 解锁：
  - 重启 daemon → `01KSDZ76T0YFTE7JF37CWAJ2S2` + `01KSE07E4D6TDHMAS1VZWVMKE7` 应至少推进到 `attempt-started:agent_m7p3n1`；如果用户已经手动 cancel，则新建一个同 workflow 的 fresh 任务跑到出现 `attempt-started`。
  - **测试**：不写新 case（fixture 在 PR-B 完整覆盖），手动 smoke。

### PR-A 验收清单

- [ ] T1-T10 全部完成
- [ ] PR-A 新增测试 ≥ 22 case
- [ ] 本地 `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] commit message 前缀 `feat(backend): RFC-062 PR-A 契约层 + scanner 修复 + daemonResume Step 4`
- [ ] push 后 GitHub Actions 15/15 全绿
- [ ] STATE.md 顶部加一行 `**RFC-062 PR-A 完工**（commit XXX）……`
- [ ] manual smoke：新建一个 incident workflow 任务能跑过 input → agent → attempt-started

### PR-A 提交建议

单 commit 即可（10 个子任务高度内聚，逻辑都是"把同一条契约线接到底"）；如果 reviewer 觉得太大，可按"shared 层 (T1+T2) + scheduler/launcher 修复 (T3+T4) + 其他消费点 audit (T5+T6+T7) + daemonResume (T8) + guards (T9)"切 5 commit，但仍单 PR。

---

## PR-B 真实工作流 e2e fixture（~4 天）

### 目标

固化 3 个生产形态 workflow 作为 fixture，用 ScriptedRunnerAdapter 端到端跑到 done，让"含反馈环的 workflow 能跑通"成为 CI 一等公民。

### 子任务

- **RFC-062-T11** 新 `packages/backend/tests/e2e-snapshots/README.md` 解释 fixture 来源、文件 schema、升级规则、新增 NodeKind 必须配 fixture 原则。
- **RFC-062-T12** 从生产 DB 抽 incident workflow snapshot 落 `cross-clarify-roundtrip.json`；手工裁剪 inputs / scriptedAgentOutputs / scriptedReviewDecisions / expectedEvents 字段。
- **RFC-062-T13** 新 `self-clarify-only.json` fixture（一个 agent + 一个 clarify 节点；agent 第一次问 → clarify auto-answer → agent 续跑 done）。
- **RFC-062-T14** 新 `wrapper-loop-with-clarify.json` fixture（wrapper-loop 内含一个 agent + clarify，max_iterations=2，第一轮 clarify-answer 后第二轮直接 done）。
- **RFC-062-T15** `packages/backend/src/scheduler-v2/runnerAdapter.ts` 新增 `ScriptedRunnerAdapter`（基于 `MockRunnerAdapter` 的薄包装，接 fixture array → 按 nodeId/iter 匹配 → 立刻 simulateExit）；未匹配 spawn 抛带 `unexpected dispatch` 的 Error。
  - **测试**：`packages/backend/tests/rfc062-scripted-runner-adapter.test.ts` ≥ 5 case。
- **RFC-062-T16** auto-resolver helpers：`autoResolveClarifyFromFixture` + `autoResolveReviewFromFixture`（订阅 events 表新写入的 `suspension-created` 行，按 fixture 决策写 `suspension-resolved`）。
  - **测试**：随 fixture replay 测试一起覆盖（不单独写）。
- **RFC-062-T17** 新 `packages/backend/tests/rfc062-snapshot-replay.test.ts`，`describe.each` 遍历 `e2e-snapshots/*.json`，每 fixture 一 case 走完整 actor 循环 + 断言 terminal + 事件序列子集。
  - **测试**：自身即 3 case。
- **RFC-062-T18** 文档更新：在 `e2e-snapshots/README.md` 加 "新增 NodeKind / SignalKind checklist"——任何 PR 引入新 kind 必须配至少 1 fixture 覆盖该 kind 在含反馈环 workflow 里的行为。

### PR-B 验收清单

- [ ] T11-T18 全部完成
- [ ] PR-B 新增 ≥ 3 fixture + ≥ 8 case
- [ ] 本地三件套全绿；3 fixture 全部 pass
- [ ] commit message 前缀 `test(backend): RFC-062 PR-B 真实工作流 e2e fixture`
- [ ] push 后 CI 15/15 全绿
- [ ] STATE.md 顶部更新

### PR-B 风险点

- ScriptedRunnerAdapter 匹配语义（按 nodeId+iter 还是 nodeId+iter+shardKey）要在 T15 完工前确定，避免 wrapper-loop fixture 写不对。
- clarify auto-resolver 与 RFC-061 `clarify` SignalKindHandler 的 onSuspend/applyResolution 接口耦合；若接口变动应跟随。

---

## PR-C stall invariant + UI alert + log-must-alert guard（~3 天）

### 目标

让 5 分钟以上没动静的 running 任务自动落 alert，UI 红条可见，用户/AI 不再依赖手动 sqlite3 查 events 表才能发现死锁。

### 子任务

- **RFC-062-T19** `packages/backend/src/services/lifecycleInvariants.ts`：
  - 加 `StuckRule` 联合 `'S5'` + `STUCK_RULES` 加 `'S5'`
  - 实现 `checkS5(db, ctx, now)` + `resolveStallThresholdMs` + `computeStallDiagnostic`
  - 在 `runLifecycleInvariants` 调用链加 S5
  - **测试**：`packages/backend/tests/rfc062-stall-invariant-s5.test.ts` ≥ 8 case。
- **RFC-062-T20** alert reconcile + WS broadcast 走 RFC-053 既有路径（零改动核心代码）；加 `packages/backend/tests/rfc062-stall-invariant-reconcile.test.ts` ≥ 3 case。
- **RFC-062-T21** `packages/shared/src/lifecycle-alerts.ts` 联合类型 + 文案模板加 `S5`；i18n key `tasks.alert.S5.title` + `.detail` 中英对称。
  - **测试**：`packages/frontend/tests/rfc062-i18n-cn-en-parity.test.ts` 1 case。
- **RFC-062-T22** `packages/frontend/src/components/tasks/StuckTaskBanner.tsx`（已存在）扩展支持 S5 渲染；红条点击跳 `TaskDiagnosePanel`（RFC-057 既有）。
  - **测试**：`packages/frontend/tests/rfc062-task-header-stall-banner.test.tsx` ≥ 4 case（chip 渲染 / 文案 / i18n / 点击行为）。
- **RFC-062-T23** `packages/backend/tests/rfc062-error-must-alert.test.ts` log↔alert 完备性 grep guard。
  - 第一次跑会扫出存量违例；逐一审查：能挂 alert 的挂、不该的加 `// log-only: <reason>` 注释；guard 自身 1 case + 修复存量违例若干 commit。
- **RFC-062-T24** 配置：`packages/backend/src/services/config.ts` 加 `invariantStallMs?: number`（默认 5 * 60_000）；`packages/frontend/src/routes/settings.tsx` 暂不暴露 UI（v1 不必，用户改 `~/.agent-workflow/config.json` 即可）。

### PR-C 验收清单

- [ ] T19-T24 全部完成
- [ ] PR-C 新增 ≥ 17 case
- [ ] 本地三件套全绿
- [ ] commit message 前缀 `feat(backend+frontend): RFC-062 PR-C stall invariant S5 + UI alert`
- [ ] push 后 CI 15/15 全绿
- [ ] manual smoke：用 `sqlite3` 把某任务的最新事件 ts 改到 1 小时前 → 等 5 分钟 invariant scan → UI 头部出现红条
- [ ] STATE.md 顶部更新；`design/plan.md` RFC 索引 RFC-062 行状态改 `Done`

### PR-C 风险点

- log-must-alert guard 首次跑会扫出大量存量违例；不要在 PR-C 里"顺手修一堆 RFC-057 时代的 log.error"——只关心本 PR 引入的、其他显式加 `// log-only` 注释。
- S5 阈值 default 5 分钟可能对真实 long-running agent 偏短；按 design.md §4.2 用节点 timeoutMs × 2 兜底，必要时改默认到 10 分钟。

---

## 完工标准（RFC 级）

按 proposal.md §AC-1..AC-8 全部满足。

- [ ] 3 PR 全合并到 main
- [ ] CI 每 PR 15/15 全绿
- [ ] incident workflow（`跨节点反问`）能新建任务跑到 `task-completed`
- [ ] `01KSDZ76T0YFTE7JF37CWAJ2S2` / `01KSE07E4D6TDHMAS1VZWVMKE7` resume 后继续往下推进
- [ ] grep guards 6 条全绿（edges / no-deferred-todo / error-must-alert / 3 个 layer-specific）
- [ ] STATE.md 顶部 `**RFC-062 完工**` 段落含 3 PR commit hash + CI run number
- [ ] `design/plan.md` RFC 索引 RFC-062 行状态 `Done`

预计 ≈ 10 工作日（3 + 4 + 3），可单人全程跑完；多人并行可压到 1 周（PR-B fixture 可与 PR-C invariant 并行启动，待 PR-A 合并后再 rebase）。

---

## 不在范围

- **后续可独立立项的 follow-up**：
  - S5 alert 的 RFC-057 repair option（v1 仅展示 alert，不提供"一键 cancel + 重试"按钮）
  - daemon.log archival / structured log（本 RFC 只确保 ERROR 有对应 alert，不改 log 格式）
  - 删 legacy 测试需配等价新测试的流程规则（这是 CLAUDE.md 改动，与代码 PR 解耦）
  - 把"删除旧服务 PR" 改成"feature-flag dual-run + N 天观察后删"的硬流程规则
- **遗留 stall 原因（非本次 incident 根因）**：除 feedback edge gating 之外的 deadlock（如 wrapper-loop 永远不收敛、agent 一直挂 retry-pending-human）由 S5 alert 自动捕获，但具体根因排查由 alert 详情手动跟进，不在本 RFC。
