# RFC-062 — 调度器 stall 三层防御（产品视角）

## 状态

**Draft** — 等用户批准。

## 触发事件（incident）

2026-05-25：用户在 UI 新建任务 `01KSE07E4D6TDHMAS1VZWVMKE7`（workflow `跨节点反问`），UI 显示「运行中」，但事实上调度器在 input 节点完成 4 ms 后就**死锁**——下游 `agent_m7p3n1` 永远不被 mint。同一工作流前一个任务 `01KSDZ76T0YFTE7JF37CWAJ2S2` 症状一致；累计今日两个任务都是 4 个事件后无声卡死。

直接根因（已定位）：RFC-061 PR-B 硬切删除 12 个 legacy services 之后，新 `scheduler-v2/readyScanner.ts:159-225 scanFreshDownstream` 在构建上游图时把**所有**入边都当作 gating 前置，没有过滤系统反馈端口（`__clarify_response__` / `__external_feedback__`）。`agent_m7p3n1` 有三条入边——一条真实数据流（`requirement`）+ 两条反馈回路（self-clarify 答案 / cross-clarify designer feedback）。后两条只在 agent 自己挂起 clarify suspension 后才会有内容，被当 gate 时永远等不到 `done`。

## 这次能从一个 bug 看出来的更大问题

如果只修 `scanFreshDownstream`，下一次硬切（或下一个忘了 `__xxx__` 反馈端口语义的开发者）还会重蹈。事故的**结构性根因**是三层都漏：

1. **契约层漏**：「`__clarify_response__` / `__external_feedback__` 是反馈回路、不是 gate」这个知识只活在 `packages/shared/src/prompt.ts:266-269` 内部一个私有 `SYSTEM_PORT_NAMES` 常量里，scheduler / fanout / validator 等所有消费 `workflow.edges` 的代码都靠开发者"恰好读到过"。RFC-061 重写 scheduler 时这条知识就丢失了。
2. **测试层漏**：W-1..W-5 集成测试 + property test + 67 backend / 99 shared / 30 frontend 全绿——但**没有一个测试用真实生产形态的 workflow（带 self-clarify + cross-clarify 反馈环）从 task-started 跑到 task-completed**。所有合成 workflow 都是直链。
3. **observability 层漏**：任务死了 8 小时，UI 写"运行中"，`/api/tasks/:id/diagnose` 返 0 findings，`lifecycleInvariants` 7+4 条规则一条都没识别，daemon.log 写 `ERROR open=29 errorCount=29` 但无 user-visible alert。用户唯一发现方式是手动点开任务页发现没有 node-runs。

本 RFC 同时治三层。

## 目标

- **G1 契约层** —— `__clarify_response__` / `__external_feedback__` 这类"系统反馈端口"的语义从 `prompt.ts` 私有常量提升为 `packages/shared/src/workflow/edges.ts` 公共契约（`SYSTEM_PORT_NAMES` + `isFeedbackEdge` + `filterDataEdges`）。grep guard 硬守门：任何 `.ts` 直接迭代 `workflow.edges` 而没显式声明 include/exclude system ports 一律 CI fail。
- **G2 真实工作流 e2e fixture** —— 在 `packages/backend/tests/e2e-snapshots/` 固化生产 DB 里真实跑过的代表工作流 snapshot（至少含本次出 bug 的`跨节点反问` + 一个 self-clarify only + 一个 wrapper-loop 内含 clarify）做 fixture，每次 PR 用 `MockRunnerAdapter` 驱动从 `task-started` 跑到 `task-completed`，断言关键事件序列。
- **G3 stall 检测 + alert** —— `lifecycleInvariants` 新增 `S5 scheduler-stalled` 规则：`tasks.status='running'` 且最新 `events.ts` 距今 > 阈值（按节点估算 timeout，默认 5 分钟）→ alert 落 `lifecycle_alerts`、broadcast WS、UI 任务详情头部红条显示「调度器疑似卡死，最后事件 X，节点 Y 等不到上游 Z」。
- **G4 当前 deadlock 立刻解锁** —— PR-A 落地后，2026-05-25 起所有"卡在 input 完成"的任务一旦被 resume 就能往下跑（含已经在 DB 里的 `01KSDZ76T0YFTE7JF37CWAJ2S2` / `01KSE07E4D6TDHMAS1VZWVMKE7`）。
- **G5 "未接通的占位"再不能上 main** —— grep guard 守门：源码 + 注释里出现 `unused in production` / `TBD` / `TODO: wire up` 直接 CI fail；`daemonResume Step 4` 现状作为先例修复。

## 非目标

- **不重写 actor 模型本身** —— RFC-061 的 4 原语（events 唯一真值 / Logical Run + Attempts projection / Suspension+Resolution / 双层 KindHandler）继续作为底座；本 RFC 只补它的契约 + 测试 + observability 三层。
- **不引入 feature flag / 双跑期** —— 系统未上生产、`scanFreshDownstream` 的 fix 是定义性 bug 修复（不是行为变更），直接硬切；保留旧路径反而增加状态复杂度。
- **不动 frontend 编辑器对 edges 的迭代** —— canvas / EdgeInspector / clarifyDragHelper 等编辑器代码本来就理解 system port 语义（专门为 clarify/cross-clarify drag 写的助手），grep guard 用 `// edges:include-system editor` 标注豁免，不强制改写。
- **不补"删测试时双跑期"流程规则** —— 这条第四层防御（流程层）放在 STATE.md / CLAUDE.md 改动里，不算本 RFC 代码工作量；改不改字两边都不阻塞。

## 用户故事

### US-1 设计者新建任务后立刻能跑

> 作为产品用户，我在 `/workflows/01KS7C0K5...` 启动一个含 self-clarify + cross-clarify 的工作流任务后，预期看到 input 完成 → 下游 agent 节点开跑 → 出现 attempt-started 事件。
> 现状：input 完成后无声卡死，UI 仍写"运行中"，diagnose 0 findings。
> 期望：契约层修复后下游 agent 自动 mint；万一未来再回归，stall invariant 在 5 分钟内把 alert 推到 UI 红条 + diagnose 面板。

### US-2 重写者删 service 时无法漏掉反馈端口语义

> 作为重写 scheduler / fanout / validator 的开发者，我在 PR 里写了 `for (const e of workflow.edges)`，预期 lint/test 流水线在我提交前就告诉我"这里需要决定要不要包含 system ports，请用 filterDataEdges 或 filterFeedbackEdges，或加 `// edges:include-system` 注释说明"。
> 现状：直接迭代不会有任何提示，行为偏差只能等生产任务死锁才发现。
> 期望：CI grep guard 在 PR 阶段就 fail，迫使每个消费点显式表态。

### US-3 运维 / 用户能立刻知道任务卡了

> 作为用户，我打开任务详情页看到「运行中」chip 时，预期它是真的在跑；如果调度器卡了 5 分钟以上没动静，预期看到醒目红条「调度器停滞 X 分钟」+ 一句可读诊断（哪个节点的哪条上游边没满足）。
> 现状：唯一发现方式是开发者手动 sqlite3 查 events 表。
> 期望：stall invariant 自动落 alert + UI 头部 banner + Inbox 提示。

## 验收标准

- **AC-1**（契约 + 立即解锁）：`packages/shared/src/workflow/edges.ts` 导出 `SYSTEM_PORT_NAMES` / `isFeedbackEdge` / `filterDataEdges` / `filterFeedbackEdges`；`scanFreshDownstream` + `makeUpstreamInputsResolver` + `findEntryNodes` 三处通过 `filterDataEdges` 计算 gating；2026-05-25 incident 的两个任务（`01KSDZ76T0YFTE7JF37CWAJ2S2` + `01KSE07E4D6TDHMAS1VZWVMKE7`）在 daemon 重启后能继续往下跑（手动复跑或新建同 workflow 任务到 done）。
- **AC-2**（grep guard）：CI 新增 `rfc062-edges-guard.test.ts`，任何 `.ts` 文件出现 `workflow\.edges` / `definition\.edges` / `\.edges \?\?` 但没 `filterDataEdges` / `filterFeedbackEdges` / `// edges:include-system` 标注 → fail。frontend 编辑器整批豁免（白名单 `packages/frontend/src/components/canvas/**`）。
- **AC-3**（"未接通占位" guard）：CI 新增 `rfc062-no-deferred-todo.test.ts`：源码 + 注释命中 `unused in production` / `caller's responsibility for now` / `TODO: wire up` / `the daemon hard-cut commit wires this up` 一律 fail；存量违例（`scheduler-v2/daemonResume.ts:264-272`）作为 RFC-062 一同修复（Step 4 真接到 `cli/start.ts`）。
- **AC-4**（真实 e2e fixture）：`packages/backend/tests/e2e-snapshots/` 新增至少 3 个 fixture：`cross-clarify-roundtrip.json`（本次 incident 的 workflow snapshot）+ `self-clarify-only.json` + `wrapper-loop-with-clarify.json`；每个 fixture 测试用 `MockRunnerAdapter` 喂预设 agent 输出，断言任务能在有限步内进入 `task-completed`，断言 events 序列包含 `attempt-started(agent_xxx)`。任意一个 fixture 走不到 `task-completed` → fail。
- **AC-5**（stall invariant）：`lifecycleInvariants` 新增 `S5 scheduler-stalled` 规则；`tasks.status='running'` 且 `max(events.ts) < now - thresholdMs` 时落 alert；threshold 默认 5 分钟、可在 `~/.agent-workflow/config.json.invariantStallMs` 调整；alert 详情包含最新事件 + 「下游节点 Y 等以下上游 done： Z1, Z2」可读诊断；`task_alerts` 表能查到该规则的开放 alert；`useTaskWs` 推 `lifecycle.alert` 事件触发 UI 头部红条。
- **AC-6**（observability 完整性）：daemon.log `ERROR [lifecycle.*]` 行**100%** 都有对应的 `lifecycle_alerts` 行（grep guard 在测试里断言这条对应关系）；不允许"只 log 不 alert"的检测器存在。
- **AC-7**（零回归）：现有 RFC-061 PR-A baseline + W-1..W-5 + launcher-e2e + 全部 backend tests + frontend tests + Playwright e2e + single-binary build smoke——CI 15/15 全绿。
- **AC-8**（STATE.md + 索引）：RFC-062 在 `design/plan.md` RFC 索引登记完成；`STATE.md` 顶部加 "RFC-062 完工"段落，列出 3 PR commit hash + CI run number。

## 与既有 RFC 关系

- **构建于 RFC-061 actor 模型之上** —— 不动 events / projection / KindHandler，只补它的契约 + 测试 + alert。
- **保留 RFC-053 lifecycleInvariants 模型** —— stall invariant 走同一 `lifecycle_alerts` 表 + `reconcileLifecycleAlerts` 同样的开/关/promotion 机制，新增的是规则 `S5` 一条，不动既有 R1/R2/C1/T1/T2/T3/U1/CR-1/S1/S2/S3/S4。
- **回应 RFC-057 diagnose-repair UI** —— S5 alert 可以接 RFC-057 的修复选项（v1 不强求；最小实现先把 alert 露出来给用户看，repair 留 follow-up）。
- **不与 RFC-058/059/060 冲突** —— 三者都是产品行为变更，本 RFC 完全在 scheduler / observability 层。

## 风险

- **R1 fixture 维护成本** —— 真实生产 workflow snapshot 一旦工作流定义 schema 升级（如新 NodeKind / 新 port）就要回填。缓解：fixture 用 `$schema_version` 锁版本，schema 升级时由破坏者负责把 fixture 升级 + 重新断言事件序列，作为「`$schema_version` bump checklist」一部分。
- **R2 stall 阈值误报** —— 长时跑的 agent（如 30 分钟的 deep research 任务）可能正常超过 5 分钟没事件。缓解：threshold 按"最近 attempt-started 的节点的 timeoutMs" 动态算（默认 fallback 5 分钟），仅当超过该节点 timeout × 2 才报；可在 config 调整。
- **R3 grep guard 过严卡住正当代码** —— 比如新增的 fanout 算法天然要看所有 edges。缓解：注释 `// edges:include-system <reason>` 显式豁免；guard 测试匹配时把豁免一并断言（不能光豁免不写 reason）。
