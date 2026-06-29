# RFC-123 技术设计 — 反问 directive 单一事实源（双向）

## 接口核实（PHASE 0，源码引用）

- 画布开关显示值**唯一来源**：`WorkflowCanvas.tsx:1753` `data.clarifyDirective = clarifyDirectives[n.id] ?? 'continue'`；`clarifyDirectives` ← **GET `/api/tasks/:id/clarify-directives`**（复数，map `{nodeId→directive}`，`taskClarifyDirective.ts:40` → `listNodeClarifyDirectives` `:85`，读 `task_node_clarify_directives`）。写用**单数 POST** `/api/tasks/:id/nodes/:nodeId/clarify-directive`（`:46` → `setNodeClarifyDirective`）——勿混淆（Codex 设计 gate P3）。
- 该表（本 RFC 前）唯一写入方 = 画布开关 POST 路由 `taskClarifyDirective.ts:75`。答题路径 `services/clarify.ts` / `services/crossClarify.ts` 均**不写它**（grep 确认）。
- 调度器 stop 注入读点：`scheduler.ts:2348-2349` `nodeStopOverride = hasClarifyChannel && (await getNodeClarifyDirective(...)) === 'stop'`，**每次尝试**读（per-attempt）；forces `directiveOverride:'stop'`（self :2384 / cross :2370）；并喂 `resolveEffectiveClarifyChannel`（`clarifyRounds.ts:435`）+ `shouldInjectStopNotice`（`:469`）。
- **`buildPromptContext.directiveOverride` 本就通用**（`clarifyRounds.ts:401`：`directive = isLast ? (directiveOverride ?? rowDirective) : rowDirective`）——非 stop-hardcode；传 'continue' 即把最后一轮 directive 重建为 continue（ask-back trailer）。
- `resolveEffectiveClarifyChannel`（`clarifyRounds.ts:446`）= `hasClarifyChannel && contextDirective !== 'stop' && !nodeStopOverride && (!reviewActive || isClarifyRerun)`。
- 提问节点 id 字段：self = `clarify_sessions.source_agent_node_id`（schema:1005，`sessionRow.sourceAgentNodeId`）；cross = `cross_clarify_sessions.source_questioner_node_id`（schema:1062，`row.sourceQuestionerNodeId`）。均 `isClarifyAskingNode`（开关即为其渲染、`nodeStopOverride` 即键于其上）。
- `hasPersistentStop`（`crossClarify.ts:1065`）读 `cross_clarify_sessions.directive='stop'`（**任一**行），在 `dispatchCrossClarifyNode`（`crossClarify.ts:1040`）+ `scheduler.ts:1694` 短路 cross 节点。`findQuestionerNodeForCrossClarify`（`shared/clarify.ts:744`）从 cross 节点反解 questioner。`createCrossClarifySession`（`crossClarify.ts:195`）**不独立挡 stop**（只按 iteration mint 新 parked session，已核）。

## 改动 A：stop 方向——答题 `stop` 写画布开关（两写点）

1. **self-clarify** `submitClarifyAnswers`（`clarify.ts`，session → answered flip 之后）：
   ```ts
   if (directive === 'stop') {
     await setNodeClarifyDirective(
       db,
       sessionRow.taskId,
       sessionRow.sourceAgentNodeId,
       'stop',
       answeredBy,
     )
   }
   ```
2. **cross-clarify** `submitCrossClarifyAnswers`（`crossClarify.ts`，`if (args.directive === 'stop')` 分支 :497 内）：
   ```ts
   await setNodeClarifyDirective(
     args.db,
     row.taskId,
     row.sourceQuestionerNodeId,
     'stop',
     answeredBy,
   )
   ```
   `setNodeClarifyDirective` 既有 upsert，`setBy = answeredBy`（成员 id，仅审计 / UI）。需在两文件 import。

效果：① 画布开关如实显示「停止反问」；② 答题 stop 经既有 `nodeStopOverride` 通道获得与画布开关**同等持久度**（每次 dispatch，含 retry / review 重跑，强制 STOP）。

## 改动 B：重启用方向——画布开关翻回 `continue` 让 agent 再问（self + cross）

**共同根因**：今天 `toggle='continue'` **不覆盖**最新已答轮的 stale `directive='stop'`——scheduler 仅在 toggle='stop' 时传 `directiveOverride`、'continue' 不传 → `buildPromptContext` 仍读 stop 轮 → `resolveEffectiveClarifyChannel`（`contextDirective==='stop'`）关通道 → STOP。修法两处：

- **改 B1（prompt 路径，self + cross-questioner 同口）**：`scheduler.ts` ~2348 把布尔扩成读 directive 本体：
  ```ts
  const nodeDirective = hasClarifyChannel
    ? await getNodeClarifyDirective(db, taskId, node.id)
    : undefined
  const nodeStopOverride = nodeDirective === 'stop' // 喂 resolveEffectiveClarifyChannel / shouldInjectStopNotice，语义不变
  ```
  两处 `buildPromptContext` 调用（:2370 / :2384）：`...(nodeStopOverride ? {directiveOverride:'stop'} : {})` → `...(nodeDirective !== undefined ? {directiveOverride: nodeDirective} : {})`。于是 toggle='continue' → `ctx.directive='continue'`（`clarifyRounds.ts:401`，通用 override）→ `resolveEffectiveClarifyChannel`（`contextDirective!=='stop'` && `!nodeStopOverride`）= **ask-back ON** + 渲染 ask-back trailer（非 STOP）。
- **改 B2（cross 节点短路加 questioner toggle 闸）**：`dispatchCrossClarifyNode`（`crossClarify.ts:1040`）+ `scheduler.ts:1694` 两处：
  ```ts
  const qNode = findQuestionerNodeForCrossClarify(definition, crossClarifyNodeId)
  const qToggle = qNode ? await getNodeClarifyDirective(db, taskId, qNode) : undefined
  const stopped =
    qToggle === 'continue' ? false : await hasPersistentStop(db, taskId, crossClarifyNodeId)
  ```
  （`findQuestionerNodeForCrossClarify` 返回值若是 node 对象则取 `.id`——实现时按其签名定。）`createCrossClarifySession` 不独立挡 stop，故 questioner 再问能正常建新 parked session。

**review 重跑不变**：`reviewActive && !isClarifyRerun` 时 `resolveEffectiveClarifyChannel` 既有项天然 ask-back off——agent 处理评审意见、不反问，re-enable 不触碰这条（符合既有语义）。

## 为什么这样合并（语义）

- 合并后「该提问节点 continue/stop」只有一个事实源（`task_node_clarify_directives`），画布开关与答题页**双向**读/写它：答 stop → 写 stop；手点翻回 continue → 覆盖 stale stop、重新放行 ask-back。
- 答题 stop 与画布开关走**同一条** `nodeStopOverride` / `directiveOverride` 通道 → 持久度一致（每次 dispatch、含 retry / review 重跑）。对 **self-clarify** 是行为升级（今天 review 重跑剥离答题 directive→重新强制反问；合并后持久行 → `nodeStopOverride` 强制 STOP，对齐画布开关既有行为）。
- cross-clarify 的 stop 持久度今天已由 `hasPersistentStop` 保证；本 RFC 让 **toggle 成为权威**：stop 显示 + continue 重启用（B2 闸）。

## 决策

- **D1 答题仅 `stop` 写表，`continue` 不写。** continue 是默认态；避免一次 continue 答案顶掉用户特意点的 stop。重启用经**显式手点**画布开关 continue（B1/B2），非答题 continue。
- **D2 additive、不动既有机制。** 保留 session per-round directive 写 + `hasPersistentStop`，新写/新闸叠加。golden-lock：无 toggle 行 ⇒ 逐字不变。
- **D3 行为差异（self review 重跑）显式承认 + 测试。** 见上，对齐画布开关既有行为。
- **D4 归属。** `set_by = answeredBy`，仅审计 / UI、**不进 prompt**（RFC-122 不变式 + rfc099-prompt-isolation 精神）。
- **D5 节点 id 源。** self `sourceAgentNodeId` / cross `sourceQuestionerNodeId`（均 `isClarifyAskingNode`）。
- **D6 prompt 路径 `directiveOverride` 泛化（B1）。** 不再只传 'stop'：toggle 有显式值即传 `nodeDirective`。`nodeStopOverride` 布尔语义不变（仍 `=== 'stop'`）。**golden-lock：`nodeDirective===undefined` ⇒ 不传 ⇒ 逐字不变**；`buildPromptContext` 不改（本就通用）。
- **D7 cross 节点短路加 questioner toggle 闸（B2）。** `qToggle==='continue'` 覆盖 `hasPersistentStop`；否则（`'stop'`/无行）逐字 `hasPersistentStop`。**golden-lock：无 continue 行 ⇒ 逐字不变**。

## 失败模式 / 边角

- **写序（self T0/T0-extend 正交）**：`nodeStopOverride` / `nodeDirective` 在**后续 dispatch tick** 读，不在答题流内，与 RFC-076 torn-read 不变式正交。stop 写放 session→answered flip 之后；相对 rerun mint 次序对正确性无影响（调度器另一 tick 才派发 pending rerun）。崩溃窗口（session flip 后 toggle 写前进程崩）：session per-round directive 仍令紧接 rerun 走 STOP（self），仅 UI / review-重跑持久化延后——与既有多写序所接受的窄窗同性质；不引入事务（bun:sqlite async-tx 首 await 即 commit）。
- **mode-flip（既有 `clarifyModeFlip`）**：stop↔continue 翻转使 `effectiveHasClarifyChannel` 变化 → `clarifyModeFlip`（`scheduler.ts:2510`）已走新 session + 全 prompt（重启用天然复用，无需新增）。RFC-122 既有「writer mode-flip 脏工作区未回滚」窄边角不在本 RFC 范围、不被加剧。
- **手点 × 答题交错（幂等）**：upsert latest-write-wins。
- **多源 cross-clarify**：各 questioner 答 stop / 翻 continue 各写/读自身 questioner 行，per-node 正确。
- **review 重跑**：ask-back 仍由既有 `(!reviewActive || isClarifyRerun)` 项压制，toggle='continue' 不解除（符合既有语义）。

## 测试策略（test-with-every-change）

回归文件顶注链接 RFC-123 + 用户报（2026-06-29）。

- **service（self）**：`submitClarifyAnswers` directive='stop' → 断言 `task_node_clarify_directives` 有 `sourceAgentNodeId`='stop' + `setBy`=answeredBy；directive='continue' → 断言**无**该行。
- **service（cross）**：`submitCrossClarifyAnswers` directive='stop' → 断言 `sourceQuestionerNodeId`='stop'；continue → 无行。
- **stop 行为差异锁（self）**：答 stop 后 review-reject 重跑 → 真 promptText **含 STOP CLARIFYING、不含**强制 ask-back（复用 RFC-122 dispatch e2e harness）。
- **重启用锁（B1，self + cross-questioner）**：存在已答 `directive='stop'` 轮 + toggle='continue' → dispatch promptText **含 ask-back、不含 STOP**；`resolveEffectiveClarifyChannel` 真值表补 `(contextDirective='stop'? 但 directiveOverride='continue' → ctx.directive='continue')` 经 buildPromptContext 的端到端断言。
- **重启用锁（B2，cross 节点）**：cross 有 `directive='stop'` session + questioner toggle='continue' → `dispatchCrossClarifyNode` / scheduler:1694 **不短路**（返回 awaiting）；无 continue 行 → 仍短路（golden-lock）。
- **幂等**：手点 continue → 答 stop → 行终值 'stop'。
- **golden-lock**：无 toggle 行 ⇒ B1 不传 override、B2 走 hasPersistentStop、答题 continue 不写表 ⇒ dispatch 逐字不变（self + cross）。
- **归属不进 prompt**：promptText 不含 `set_by`/answeredBy。
- **前端（最小）**：directive map 含某节点 'stop' / 'continue' → `ClarifyDirectiveToggle` 渲染对应 active（`role=radio` `aria-checked`）。

## 影响面

- 改 A（stop 写）：`services/clarify.ts`、`services/crossClarify.ts`（各 +1 条件写 stop + import `setNodeClarifyDirective`）。
- 改 B1（prompt 路径 + recency）：`services/scheduler.ts` ~2348（`getNodeClarifyDirectiveRow` 取 directive+updatedAt）+ :2370/:2384（`directiveOverride: nodeDirective` + `directiveOverrideAt`）；`services/clarifyRounds.ts` `buildPromptContext` 加 `directiveOverrideAt` recency 闸。
- 改 B2（cross 短路 + recency）：`services/crossClarify.ts`（`dispatchCrossClarifyNode` → `resolveCrossNodeStopped`）+ `services/scheduler.ts:1694`（同）。
- 新增 helper：`services/taskClarifyDirective.ts` `getNodeClarifyDirectiveRow`；`services/crossClarify.ts` `latestPersistentStopAt` / `resolveCrossNodeStopped`。
- 改 C（前端 T3）：`hooks/useTaskSync.ts` 在 `clarify.answered` + `cross-clarify.answered/rejected` 失效 `['task-clarify-directives', taskId]`（答题后画布 toggle 即刷新；既有只在 node.status 失效）。
- 复用（不改）：`setNodeClarifyDirective` / `findQuestionerNodeForCrossClarify` / `resolveEffectiveClarifyChannel`。
- **零 migration**（表 `0064` 已存于 RFC-122）、**零新 API**。

## 实现勘误（Codex impl-gate 两轮 fold）

- **P2-① 答题后画布不刷新**：答题侧 stop 写了 directive，但 `useTaskSync` 只在 `node.status` 失效 `task-clarify-directives`、不在 `clarify.answered` / `cross-clarify.answered` → 已挂载画布的另一 tab 要等 rerun 的 node.status 才反映。**fold = 改 C**：答题事件也失效该 key。
- **P2-② stale `continue` 误重启用**：B1/B2 把**任何** `continue` toggle 行当作重启用，但升级前 RFC-122 canvas API 会留 `continue` 行、而答 stop（改动前）不写该表 → 「旧 continue 行 + 后来的 stop」被误判重启用。**fold = recency 闸**：`continue` 覆盖仅在其 `updatedAt` ≥ 它要覆盖的 stop 时间戳时生效（B1 比对该轮 `answeredAt`，B2 比对 `latestPersistentStopAt`）；`stop` toggle 仍无条件生效（RFC-122 durable）。golden-lock：无 toggle 行逐字不变；going-forward 答 stop 总把 toggle 写成 stop，故仅升级窗口存量数据需此闸。
- 两轮 fold 后 Codex impl-gate **CLEAN（No discrete issues）**。门禁全绿：typecheck×3 / 全量 backend **4389 pass 0 fail** / 前端 vitest **2863 pass** / format / 单二进制 smoke。
