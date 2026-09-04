# RFC-358 技术设计：把工作流图校验接进意图链路

> **r2（2026-09-04）**——设计门两路评审（事实核对 + 对抗审查，只审功能）报出 12 条 P0、13 条 P1，
> 逐条回源码复核后全部折入。r1 有四处会**直接做不出来**：覆盖层漏 `outputKinds` 会误报本 RFC 自己的旗舰
> 用例；合成的 agent 新行缺 `skills`/`dependsOn` 会让 validator 抛 TypeError；loose 定义直喂 validator 会崩；
> `graphWarnings` 撞上 `.strict()` 会让会话详情 500。另有两处**整块缺失**：同批新建的 skill/MCP/plugin 与
> 被调工作流没有注入上下文（必然假阳性）、`currentWorkflow` 从未传入（自调用与环规则静默失效）。

## 1. 架构落位（RFC-294 对齐）

本 RFC 触及三个包，按 RFC-294 §3 G1/G2 的层次规范落位：

| 模块 / 包          | 层                                                                          | 本 RFC 的改动                                                                                                                                  |
| ------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource-catalog` | `infrastructure/legacy/workflow.validator.ts`                               | `WorkflowValidationCandidate` 增加候选期覆盖层入参；新增纯函数把覆盖层并进 `ValidatorContext`；给 `:1716` / `:1772` 两处无保护解引用补 `?? []` |
| `resource-catalog` | `application/workflows/{ports,workflowValidation}.ts`                       | `WorkflowValidationPort.validate` 透传覆盖层；新增 query 方法 `validateCandidate`                                                              |
| `resource-catalog` | `public/{queries,types}.ts`                                                 | `WorkflowValidationQueries.validateCandidate` 的 exact 合同 + 覆盖层类型                                                                       |
| `resource-catalog` | `infrastructure/{sqlite,postgresql}WorkflowValidation.ts`                   | 两个 provider 各接一行覆盖层合并（**调同一个纯函数**）                                                                                         |
| `resource-catalog` | `infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants.ts` | **D5/B-5**：copy 的 create 分支补 sidecar 回填（与 update 分支 `:823-858` 同源）                                                               |
| `intent`           | `domain/workflowGraphCandidate.ts`（新）                                    | 纯判据：变更集 → 可校验候选（schema 前置 + ref 重写 + 四类覆盖层派生）                                                                         |
| `intent`           | `application/ports/intentWorkflowGraphValidation.ts`（新）                  | 意图侧消费端口，由 composition 绑到 resource-catalog 的 public query                                                                           |
| `intent`           | `application/{turnEngine,resolveChangeset}.ts`                              | draft 接线；`DraftValidationReport` 扩 warning / 不可用标记                                                                                    |
| `intent`           | `application/dispatcher.ts` + `ports/intentPersistence.ts`                  | 图修复轮调度；`IntentTurnOutcome` / `settleTurn` 返回契约扩展                                                                                  |
| `intent`           | `infrastructure/intentSqlPersistence.ts`                                    | 非抛出的图修复轮预约（两 provider 共用这一份 SQL 程序）                                                                                        |
| `intent`           | `infrastructure/{sqlite,postgresql}IntentApplyOperations.ts`                | preflight 段各调一次共享的 application 判据（**位置在 `prepare` 之后**）                                                                       |
| `shared`           | `schemas/intentSession.ts`                                                  | `IntentDraftDtoSchema.shape.validation` 增可选 `graphWarnings` / `graphValidationUnavailable`（**必须同步，否则 500**）                        |
| `frontend`         | `routes/intent.detail.tsx`                                                  | warning 段、图修复轮标识、截断提示、下游影响提示                                                                                               |

**为什么候选构造落 `domain/`**：它只依赖 `@agent-workflow/shared` 的变更集类型与调用方传入的 `handle → id` 映射，不碰持久化、不碰 provider、不需要 `manifest.ts`（后者仍依赖 `@/services/*OperationRevision`，RFC-355 T2 已判定必须留在 application）。

**偏离项**：无。跨模块一律经 `resource-catalog/public/queries.ts` 的 exact 合同，intent 不 import 任何 resource-catalog 的 infrastructure / legacy 路径。

> **关于是否新增 public 方法**：评审提出既有 `WorkflowValidationPort.validate` 的 `currentWorkflow` 本就可选，
> 「不要求已存行」在 **port 层**已满足。但 intent 是**另一个 bounded context**，只能经 public 合同调用，而
> `WorkflowValidationQueries` 现有两个方法都强制要 `workflow: WorkflowCatalogDetail`（`public/types.ts:575-584`）。
> 因此 public 层仍需新增 `validateCandidate`；port 层则**扩既有输入类型**而不是再开一个方法，少一处长期同步面。

## 2. 现状接缝

```
runIntentTurn (turnEngine.ts:657)
  └── validateDraftChangeset(manifest, changeset, {agentBranchPorts})   ← 第一层
        └── report {errors[], credentialFindings[]}
              └── settle('changeset', …, {draft: {validationJson: JSON.stringify(report)}})
                    ├── 前端 draft.validation.errors → 红牌 + 禁提交
                    └── 下一轮 buildIntentDoc({validationErrors}) → INTENT.md blocking 段
```

本 RFC 只加一条边：**第二层的 error 汇入第一层的 `report.errors`**，其余全部复用。

## 3. 候选构造（`intent/domain/workflowGraphCandidate.ts`，纯函数）

### 3.1 前置 schema 校验（P0-7）

意图侧的工作流定义 schema 是 loose 的：`nodes` 为 `.passthrough()` 只约束 `id`/`kind`，**`edges: z.array(z.unknown())`**（`packages/shared/src/schemas/intentChangeset.ts:322-331`）。而第一层的 `WorkflowDefinitionSchema.safeParse` 失败时**什么都不 push**（`resolveChangeset.ts:204-215`，只用于模板扫描）——所以一个 `edges: [{from:'a',to:'b'}]` 的定义在今天是「合法」的。

validator 第一件事就解引用 `edge.target.nodeId`（`workflow.validator.ts:632-652`）。直喂会抛 TypeError，被 `turnEngine.ts:680-691` 的既有 catch 兜成 `intent-turn-crashed`——**整轮产出全丢**，比现状（照常出 draft、apply 时给可读的 `intent-op-canonical-invalid`）更差。

因此候选构造第一步：

```
WorkflowDefinitionSchema.safeParse(op.payload.definition)
  ├── 失败 → 产出一条 op 级 blocking error（`${opId}: workflow definition is malformed — …`），不进 validator
  └── 成功 → migrateWorkflowDefinitionToLatest → 继续 §3.2
```

顺带把第一层那处「safeParse 失败静默跳过」补成 error——它本身就是一个既有的假绿。

### 3.2 引用重写（P2-5）

重写规则与 apply 期（`resolveChangeset.ts:662-690`）**逐条同形**：`agentRef→agentId`、`workflowRef→workflowId`、`workgroupRef→workgroupId`。为避免同判据两份（RFC-355 T1 实测过必漂），apply 期改调本文件同一函数，但**必须保留一个分叉参数**：

|          | 解析不出引用时                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------- |
| draft 期 | **跳过**该 op 的图校验（第一层已经报过 `intent-ref-unknown` 同源的错误，重复报只会淹没图问题） |
| apply 期 | **抛** `intent-ref-unknown`（`resolveChangeset.ts:530` 的既有行为，不得改变）                  |

draft 期占位 id 取 `intent-pending:<opId>`：`agentId` 的 schema 只要求 `z.string().min(1)`（`packages/shared/src/schemas/workflow.ts:243`），validator 对 agent id 只做字典查找（`:709`），不校验形状。

### 3.3 agent 覆盖层（P0-1 / P0-3 / P0-5）

字段集**不手写**，以 `projectWorkflowValidationContext`（`workflow.validator.ts:518-546`）为权威清单——那段的 docstring 自称是「每一个能影响工作流校验或端口语义的 inventory 字段」的投影，与 `PortLookupAgent`（`packages/shared/src/nodePorts.ts:57-64`）合起来就是全集：

```ts
export interface WorkflowValidationAgentOverlay {
  readonly agentId: string
  readonly isNew: boolean
  readonly fields: {
    readonly name?: string
    readonly outputs?: readonly string[]
    readonly outputKinds?: Readonly<Record<string, string>> // ← r1 漏；review 判据只读它
    readonly outputWrapperPortNames?: Readonly<Record<string, string>> // ← r1 类型写成了数组
    readonly branchPorts?: readonly string[]
    readonly role?: string
    readonly skills?: readonly unknown[] // ← r1 漏；validator 无 `?? []` 保护
    readonly dependsOn?: readonly string[] // ← r1 漏；同上
    readonly mcp?: readonly string[]
    readonly plugins?: readonly string[]
  }
}
```

r1 列的 `inputs` 与 `readonly` **删掉**：agent `inputs` 是对象数组且**没有任何规则读它**（`nodePorts.ts:256` 明写 "agent inputs are edge-derived prompt vars, never declared"，只在上下文哈希里出现）；`readonly` 在 `Agent` 类型与 validator 里都不存在。

**`isNew:true` 的合成行必须字段齐全**——validator 对 `agent.skills`（`:1716`）与 `agent.dependsOn`（`:1772`）是**无保护解引用**（同类的 `mcp`/`plugins` 有 `?? []`）。变更集这四个字段都是 `.default([])`，所以本来就拿得到。同时在 validator 侧给那两处补 `?? []`——不是为了本 RFC，而是任何未来注入路径都不该因为少一个字段就崩。

**「省略 = 保留存值」不是统一规则**（P0-5）。zod 的 `.default([])` 让五个字段解析后**永远存在**，apply 无条件覆盖；只有 `.optional()` 的那几个才是「省略=保留」：

| 语义       | 字段                                                                                     | 依据                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 无条件覆盖 | `outputs` / `skills` / `dependsOn` / `mcp` / `plugins`                                   | `intentChangeset.ts:128,156-159` 均 `.default([])`；`resolveChangeset.ts:587-610` 无条件写         |
| 省略=保留  | `outputKinds` / `branchPorts` / `inputs` / `outputWrapperPortNames` / `role` / `runtime` | 同上 `:129-132,148-150` 均 `.optional()`；`resolveChangeset.ts` 用 `=== undefined ? {} : {…}` 展开 |

覆盖层的这张表必须**逐字段镜像** `resolveChangeset.ts:587-610`，并加测试锁死两处同形。

合并动作发生在**有 live 行的那一侧**（provider 的 port 实现），intent 只产出「覆盖什么」。合并本身是 validator 层的纯函数 `withValidationOverlays(ctx, overlays)`，两个 provider（`sqliteWorkflowValidation.ts:18` 走 helper、`postgresqlWorkflowValidation.ts:87-136` 自建 context）**各调一次同一个函数**。

### 3.4 同批新建的 skill / MCP / plugin（P0-2 后半，AC-9）

validator 会**经由 agent** 校验它的资源闭包：`skill-not-found`（`:1716-1725`、闭包内 `:1791`）、MCP 未知（`:1732-1738`、`:1802`）、`plugin-not-found` / plugin disabled（`:1745-1758`、`:1815-1822`）、`agent-dependency-not-found`（`:1778-1786`）。

意图会话最常见的形态恰恰是「一次建技能 + agent + 工作流」。若只做 agent 覆盖层，这批引用要么解析不出（handle 不是 id）、要么解析出的 id 不在 `ctx.skills` / `ctx.mcps` / `ctx.plugins` 里——**两种都是假阳性，而且 agent 修不掉**（它建的技能本来就在同一个 bundle 里）。

所以覆盖层扩成四类，同批新建的 skill / MCP / plugin 以**最小行**注入（这几处 validator 只做 id 存在性 + `plugin.enabled` 判断，不读内容，注入成本极低）：

```ts
export interface WorkflowValidationCandidateOverlays {
  readonly agents: readonly WorkflowValidationAgentOverlay[]
  readonly skills: readonly { id: string; name: string }[]
  readonly mcps: readonly { id: string; name: string; enabled: boolean }[]
  readonly plugins: readonly { id: string; name: string; enabled: boolean }[]
  readonly callWorkflows: readonly { id: string; name: string; definition: WorkflowDefinition }[]
}
```

### 3.5 call 闭包覆盖层（P0-4）

call-workflow 的存在性判据走**名字**（`workflow.validator.ts:2765`、`:2790-2805`），闭包加载也按名字查库（`:407-412`）。同批新建的被调工作流不在库里 ⇒ 必报 `call-workflow-ref-missing`（error 级），占位 id 帮不上忙。

而「一次会话里建 A 和被 A 调用的 B」正是意图文档**教用户写**的形态（`intentChangeset.ts:379-385`：按名字建 call 边合法且容忍悬空）。级联后果更糟：call 节点的 `declaredPorts` 退化为 `NO_PORTS`（`nodePorts.ts:369-370`），它的每条出边再报一次 `edge-source-port-missing`——那条**会**降级成 warning（`:1048-1057`），于是用户看到一堆 warning、而 agent（按 D1 看不到 warning）只看到一条它修不了的 error。

因此 `ctx.callWorkflows` 必须注入同批新建 / 修改的工作流定义，**按名字与占位 id 双键落**（与 `loadCallWorkflowClosure` 的双键形状一致）。

r1 §8 写的「call-workflow 不可见时 validator 自身已有降级」只对 `ctx.callWorkflows === undefined`（resolver 整个缺席）成立；resolver 在场而单条 ref 找不到时是**硬 error**。该行已改。

### 3.6 `currentWorkflow` 与 copy 模式（P1-3 / P0-6，决策 D5）

**`currentWorkflow` 必须传**：自调用判据读 `ctx.currentWorkflow.name`（`:2773-2786`），环走查以 `ctx.currentWorkflow?.id` 为根（`:2890-2896`）。不传则工作流自己 call 自己不报错（draft 绿）、apply 期若传了就报（apply 红）。规定：**update op 传 `{id: 真实 id, name: nameOf(op)}`，create op 传 `{id: 占位/最终 id, name: payload.name}`**，两个既有 query 也都是无条件传（`application/workflows/workflowValidation.ts:77-79`、`:102-104`）。

注意 `nameOf` 在 commit 期可被 `finalName` 槽覆盖（`resolveChangeset.ts:534-548`）——按名字建立的 call 边会因改名断掉。这是 draft/apply 名字口径的第三处潜在分叉，归入 §7 的文案分类。

**copy 模式**：`applyMode` 是用户在确认时才做的决定，draft 期不可知（不落库、不进 `IntentDraftDtoSchema`）。copy 把 update 归一成 create，而 apply 的 **create 分支不做 sidecar 回填**（`legacyIntentApplyResourceParticipants.ts:809-822`），update 分支才做（`:823-858`）。于是同一个 op：draft 期覆盖层 = `live ⊕ payload`（带存值的 `outputKinds`），apply 期 = payload only（丢 `outputKinds`）——**按构造必然分叉**，且挂载 builtin / 他人资源时 copy 是唯一合法模式（`resolveChangeset.ts:495-506`），所以这是强制路径而非边角。

**决策 D5 的修法**：给 copy 的 create 分支补 sidecar 回填（`plan.copiedFromHandle` 存在时从源行回填 `branchPorts` / `outputKinds` / `role` / `outputWrapperPortNames`），与 update 分支同源。两侧口径自然同形，draft 期的 `live ⊕ payload` 就是对的。这同时修掉一个既有缺陷——现状「复制一个 builtin agent 再改」会静默丢这四个字段。已列为 B-5 呈确认。剩余的口径差（`finalName` 改名等）由 §7 的文案分类兜住。

## 4. draft 阶段接线（`turnEngine.ts`）

在 `validateDraftChangeset` 之后、`settle('changeset', …)` 之前：

```ts
const report = validateDraftChangeset(dump.manifest, normalized.changeset, {…})
report.errors.unshift(...normalized.errors)
const graph = await deps.graphValidation.validateChangesetWorkflows({…})
if (graph.unavailable) report.graphValidationUnavailable = true      // D7
else {
  report.errors.push(...graph.errors)   // 已带 `<opId>:` 前缀，已截断
  report.graphWarnings = graph.warnings
}
```

- **error 文案形状**：`` `${opId}: ${code}${where} — ${message}` ``，其中 `where` 从 issue 的 `target`（`kind: 'node' | 'node-field' | 'node-port'` 时取 `nodeId`）派生，否则回落 `pointer`。`WorkflowValidationIssue` **没有 `nodeId` 字段**（`packages/shared/src/schemas/workflow.ts:648-662`）。
- **前缀逐字**：前端判据是 `error.startsWith(\`${op.opId}:\`)`，**冒号后无空格**。
- **条数上限（AC-11）**：每 op 20 条、全局 64 条，超出显式标注 `… and N more graph issues not listed`。依据是 `intentDoc.ts:14` 写死的约定「Any truncation is explicitly labeled — silence never means completeness」，既有实现先例见 `intentDoc.ts:51-52`、`dumpBuilder.ts:781-785`、`turnEngine.ts:625-628`。validator 有 108 个错误码且多条规则逐边产出（意图 schema 允许 1024 条边 / 256 节点 / 64 op），不设上限会把 blocking 段撑爆并淹没第一层。
- **顺序**：第一层 error 在前，图校验 error 在后。
- **降级（D7）**：端口异常不吞、也不丢产出——draft 照落，`graphValidationUnavailable: true` 落进 `validation_json`，前端提交按钮按不可用禁用（与 error 同效），下一轮 INTENT.md **不渲染**图校验段，最终由 §7 的 apply 硬拦兜底。注意 `intent-graph-validation-failed` 不会自然出现——turnEngine 的既有 catch 会把任何异常变成 `intent-turn-crashed`，所以这里必须**显式 try/catch**。

## 5. warning 与不可用标记（决策 D1 / D7）

```ts
export interface DraftValidationReport {
  errors: string[]
  credentialFindings: Array<CredentialFinding & { opId: string }>
  graphWarnings?: Array<{ opId: string; code: string; where?: string; message: string }>
  graphValidationUnavailable?: boolean
}
```

**必须同步扩 shared schema**（P0-8）：`IntentDraftDtoSchema.shape.validation` 是 **`.strict()`**（`packages/shared/src/schemas/intentSession.ts:471-485`），读点用的是**抛错版** `.parse`（`application/sessionDetail.ts:110`）。不扩就会让 `GET /api/intent-sessions/:id` 对该会话所有 draft 抛 ZodError ——**整个详情页 500**，会话事实上不可用。r1 那句「无需迁移」只在**向后**方向成立（老行没这两个键，可选字段读出 `undefined`）。

对照：turn 的 `content` 是 `z.record(z.string(), z.unknown())`（`intentSession.ts:417`），加标记**不需要**改 schema。两处口径不同，容易连带漏掉。

- warning 落 `validation_json`，随 `draft.validation` 投影到前端；
- 确认页在 blocking 段之下单独一段，**用既有的 `<NoticeBanner tone="warning">`**（`packages/frontend/src/components/NoticeBanner.tsx`，本页 `intent.detail.tsx:647` 已在用；warning 档自带图标与 `role="status"` / `aria-live="polite"`）。按 CLAUDE.md §Frontend UI consistency，不新写 chrome、不新写 CSS。
- `buildIntentDoc` **不读** `graphWarnings`——D1 的锁点，测试直接断言 INTENT.md 文本不含 warning code。

## 6. 图修复轮（决策 D2）

> 命名：叫 **`graphRepairTurn`**，不叫 `autoRepair`——后者在本仓已被任务侧占用（`packages/backend/src/services/autoRepair.ts`、`shared/src/schemas/config.ts:260`），撞名会让 grep 失效。

### 6.1 判据从哪来（P1-1 / P2-3(a)）

r1 的伪码把 `outcome {blockingErrors, autoRepair}` 当既有事实，实际都没有：

- `IntentTurnOutcome` 只有 `{turnId, kind, errorCode?, draftRevision?}`（`turnEngine.ts:108-113`），由 `settleTurn` 返回，扩字段要动 `ports/intentPersistence.ts:335-340` 的端口合同 + 两 provider 共用的那份实现；
- `dispatchIntentTurn` 现在 `await runIntentTurn(...)` **丢弃返回值**（`dispatcher.ts:100`），`finally` 里读不到；
- 端口上没有 `findTurn(turnId)`，只有全量 `listTurns`。

`blockingErrors` 其实**已经在 turn 的 content 里**（`turnEngine.ts:666`），顺手返出来即可。所以 T6 必须扩这两处契约——这是 r1 plan 漏掉的一步。

### 6.2 标记怎么存（P2-3(b)）

标记写进 turn 的 `content_json`（读侧是宽松 record，无需迁移），但 r1 给的理由「抗重启」**方向反了**：`content_json` 会被四条路径整体覆写，重启恰恰是其中一条——superseded（`intentSqlPersistence.ts:1108`）、预约期取消（`:1015`）、start-failure（`:1052`）、**boot 修复**（`:1668` 写 `intent-run-daemon-restart`）。而 boot 侧没有图修复轮的恢复逻辑。

正确的理由是：**`finally` 没有返回通道**，判据必须从库里读回来。标记要在 `settle` 闭包（`turnEngine.ts:294-327`）里**统一注入**，覆盖全部 11 个调用点——否则自动轮以 error 收尾时标记就丢了，判据失效。

### 6.3 调度形状

```
runIntentTurn → outcome {kind:'changeset', blockingErrors, graphRepairTurn}
   └── finally（dispatcher.ts:145-165，与既有 working-set successor 同形）:
        若 kind==='changeset' && blockingErrors>0 && !outcome.graphRepairTurn && 无排队 successor
           → reserveGraphRepairTurn(...)   // 非抛出，见下
           → void dispatchIntentTurn(...)
```

- **预约必须非抛出**（P1-1）：`reserveIntentRetryTurn`（`session.ts:520`）是**全仓零调用方的死代码**——用户点的「重试」走的是 `/retry` → `reserveExactIntentRetry` → `persistence.reserveRetry`（`intentSessionRoutes.ts:671`），后者带 `clientMutationId` 幂等重放与 CAS，且会铸 user + agent 两条轮。更要命的是它在 in-flight / 预算耗尽 / 会话归档 / 有未结 apply 时**直接抛**（`intentSqlPersistence.ts:1419-1425`、`:453-471`），而 `dispatchIntentTurn` 全部调用点都是 `void`，`finally` 里抛出会冒泡成未捕获拒绝。既有正解就在旁边：`activateWorkingSetChange` 遇到 in-flight **返回 `{reservation:null}` 而不抛**（`:2299`、`:2314`）。因此新增 `reserveGraphRepairTurn`，照 working-set 的形状返回 null。
- **消灭 in-flight 空窗**：`settle` 清 `inFlightTurnId`（`intentSqlPersistence.ts:1179-1184`）与图修复轮 `beginTurn` 占位之间有一个窗口。窗口里前端按 `inFlight===false` 解禁输入框与「重新生成」（`intent.detail.tsx:598-600`、`:751`），用户点「取消」会**静默失效**（`abortIntentTurn` 取不到控制器、`cancelReservedTurn` 因 `inFlightTurnId===null` 返回 false），紧接着自动轮照常起飞。这是用户没发起的轮，观感不可接受。**修法：图修复轮的预约在 settle 的同一事务内完成**（settle 与 reserve 合成一个 SQL 程序），`inFlightTurnId` 从旧轮直接过渡到新轮，不落地。
- **入口不止一处**（P2-11）：working-set successor 轮（`intentSqlPersistence.ts:2394-2416` 铸的那条）同样不是用户直接发起的，它红了也会引出一次修复轮。判据因此定为「**本轮是否为非用户直接发起的轮**」，而不只是「是否为图修复轮」。
- **预算**：照常 `budgetDelta: { generateRounds: 1 }`；预约返回 null 即不修复。注意真实错误码是 `intent-budget-exhausted`（不是 r1 写的 `intent-generate-budget-exhausted`），且**生成轮与反问轮共用同一上限**（`intentSqlPersistence.ts:453-462`）。
- **UI（B-4）**：轮次列表标识图修复轮（`intent.turnKind.*` 的 i18n 现无可用档位，需新增）；该轮期间会话被锁（发消息 / 回答反问 / 批准挂载 / 提交全部 409），禁用文案要写明「正在自动修复图校验错误」并保证取消入口显眼。
- **崩溃收尾**：中断的图修复轮以「最新一条 error 轮」收场，会被 `intentRetrySourceOf`（`domain/sessionComposer.ts:83-91`）挂上「重试本轮」按钮——用户会看到一个自己没发起过的轮请他重试。§8 已列。

## 7. apply 二次硬拦（决策 D3）

**位置**：两个 provider 的 apply preflight 段，**在 `resourceSession.prepare(plan)` 循环之后、`prestage` 之前**（`sqliteIntentApplyOperations.ts:376-398`）。

r1 把它放在 `prepare` 之前是错的（P0-7）：canonical `WorkflowDefinitionSchema.parse` 正是在 `prepare` 里跑的（`legacyIntentApplyResourceParticipants.ts:949-951`），先于它做图校验会拿到未校验定义 → TypeError → 500，并把 `packages/backend/tests/rfc234-apply-changeset.test.ts:808`（用例名直说 `canonical schema rejection maps to intent-op-canonical-invalid, not 500`）推红——那正是它当初防的回归。放在 `prepare` 之后则拿到的是 canonical + migrated 的 `prepared.definition`。

- 覆盖层的 `isNew` 由 `op.action === 'create'` 派生；配合 D5 的 copy 回填，两侧口径同形；
- 判据函数落 `intent/application/`，两 provider 共用一份（理由同 `applyCommitPlan.ts` 文件头记的 RFC-355 教训）；
- 红则抛 `ValidationError('intent-workflow-invalid', …, { issues })`，journal 记 `failed`，**零资源落库**——preflight 段还没有任何副作用，走的是「补偿干净」档（`sqliteIntentApplyOperations.ts:483-524`：session 状态与 `currentDraftId` 全不动、draft 完好、不写 `intent_draft_resolutions`）。前端每次开关提交弹窗都重铸 `clientMutationId`（`intent.detail.tsx:1290-1295`），所以关掉重开再提交就是干净重试，**不会卡死**。
- **文案按成因分类**（B-2）：live 库漂移 / 该草稿产生于本功能上线前、从未跑过图校验 / `finalName` 改名导致按名字的 call 边断掉。一律说「引用的资源发生了变化」会把用户引到错误方向。

## 8. 失败模式

| 场景                                                           | 行为                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 变更集不含工作流 op                                            | 图校验整段跳过，零额外查询（agent update 的知情提示仍照 §12 出）                                                                                                                                                                                                                         |
| 定义未过 `WorkflowDefinitionSchema`                            | 一条可读的 op 级 blocking error，**不进 validator、不崩**（AC-10）                                                                                                                                                                                                                       |
| 句柄/tempRef 解析不出                                          | draft 期跳过该 op；apply 期抛 `intent-ref-unknown`（既有行为）                                                                                                                                                                                                                           |
| 图校验查库失败                                                 | draft 照落 + `graphValidationUnavailable`，提交禁用，INTENT.md 不渲染图校验段（D7）                                                                                                                                                                                                      |
| issue 条数超上限                                               | 截断并显式标注条数（AC-11）                                                                                                                                                                                                                                                              |
| 同批新建资源被引用                                             | 注入覆盖层，不产生 not-found 假阳性（AC-9）                                                                                                                                                                                                                                              |
| 图修复轮再次红                                                 | 停止，draft 保留最新一版，交给用户                                                                                                                                                                                                                                                       |
| 图修复轮预约不可用（in-flight / 预算耗尽 / 归档 / 未结 apply） | 预约返回 null，静默不修复，不抛                                                                                                                                                                                                                                                          |
| 图修复轮自身崩溃 / 进程重启                                    | 以 error 轮收场，`intentRetrySourceOf` 会给它挂「重试本轮」按钮——用户看到一个自己没发起的轮请他重试。UI 需在该轮的标识里说明它是自动轮                                                                                                                                                   |
| 两 provider 结果不一致                                         | 覆盖层合并共用同一纯函数是结构性保证；但 context 其余部分**本就有差异**（SQLite 用 `listSkills(db)` 全量，PostgreSQL 按 `reservationState==='ready'` + `skillContent.isAvailable` 过滤，`postgresqlWorkflowValidation.ts:97-101`），AC-7 的固件须避开 skill 可用性差异或显式列为已知豁免 |

## 9. 既有测试的预期变化

评审实跑核对过，**不会大面积推红**——两条最常见的意图测试 fixture（`rfc234-apply-changeset.test.ts:203-211` 的双 agent 无边、`rfc234-turn-engine.test.ts:317-326` 的 input/agent/output 无边）在 validator 下都是 `ok: true`。需要处理的只有三处：

1. `rfc234-apply-changeset.test.ts:808` —— 只要图校验放在 `prepare` 之后就不受影响（§7）。
2. `rfc234-apply-changeset.test.ts:1258-1272` —— call-workflow 套在 `wrapper-loop` 里，实跑得 `wrapper-loop-exit-condition` error，AC-6 会把它拦下，**该用例的预期结果要改**（这正是本 RFC 想要的效果，需在改动里写明理由）。
3. `intent-teaching-registry.test.ts` 带反向 AST 检查与常驻 baseline，T8 补 `mistakes` 时要同步 baseline。

另需重跑 `scripts/architecture-census.ts` 并提交 `architecture/*.json`：新增 public 方法与新文件会改动 `public-surfaces.json` / `module-symbol-owners.json` 等，账本守卫（`tests/architecture/rfc294-canonical-manifests.test.ts`）以生产源码重建为准，不更新必红。

## 10. 测试策略

`packages/backend/tests/rfc358-intent-graph-validation.test.ts`（主锁）+ 增量断言：

1. **候选构造纯函数**：schema 前置（畸形定义 → 可读 error 而非崩）；句柄→真实 id、tempRef→占位 id；三种 ref 同形重写；draft 跳过 / apply 抛的分叉。
2. **覆盖层派生**：字段表逐字段镜像 `resolveChangeset.ts:587-610`（无条件覆盖 5 个 / 省略保留 6 个）；合成新行经 validator 全判据**不抛**；`isNew` 与库状态不符时抛。
3. **AC-9**：同批建 skill + agent + 用它的工作流 → 无 `skill-not-found`；同批建 A 调 B → 无 `call-workflow-ref-missing`。
4. **旗舰用例（AC-1）**：review 接 fanout → `<opId>:review-input-source-not-markdown …`；改接 agent 节点且带 `outputKinds:{…:'markdown'}` → 绿。**这一条同时锁死 P0-1**（去掉 `outputKinds` 覆盖必须让它变红，证明字段确实被喂进去了）。
5. **US-2 联动**：agent 加输出端口 + 工作流连上它 → 绿；把 outputs 改回去 → 红。
6. **D1 锁**：warning 进 `graphWarnings`、不进 `errors`、**不出现在 `buildIntentDoc` 输出文本里**。
7. **D7 锁**：端口抛异常 → draft 照落 + `graphValidationUnavailable` + 提交禁用 + INTENT.md 无图校验段。
8. **AC-11**：构造超限 issue → 截断且带显式条数标注。
9. **D2 锁**：连续坏 changeset → 恰好一个图修复轮；仍红 → 无第三轮；预约不可用 → 不抛且不修复；working-set successor 轮红了也走同一判据；settle→修复轮之间 `inFlightTurnId` **不落地**（锁空窗）。
10. **AC-6/D5**：draft 绿 → apply 前改掉被引用 agent 的 outputs → `intent-workflow-invalid`，零落库；copy 模式下 draft 与 apply 的覆盖层同形（回填生效）。
11. **provider 对等（AC-7）**：同一坏变更集两 provider 同一组 code。
12. **P0-8**：带 `graphWarnings` 的 draft 行能被 `sessionDetail` 正常投影（不 500）；老 draft 行（无该键）同样正常。
13. **AC-13**：agent update 时确认页提示引用它的既有工作流；该文本不进 INTENT.md。

每个测试文件顶端写明「它锁的是哪类回归」并链接本 RFC。

## 11. 教学补强（任务前移到批次 2）

D1 让 agent 看不见 warning，唯一低成本缓解就是 RFC-348 的 teaching registry（现 14 处 `mistakes`、11 处为空）。系统性、会反复复发的 warning 就那么几条——validator 里全部 `severity:'warning'` 的码：`clarify-no-iteration-cap`、`cross-clarify-no-iteration-cap`、`clarify-answers-port-disconnected`、`cross-clarify-manual-edge-missing`、`input-orphan-declared`、`prompt-template-deprecated-token` 等——写成 `mistakes` 是一次性成本、永久收益。不做普查式补写（堆满 108 条只会稀释）。

## 12. agent update 的下游知情提示（决策 D6）

变更集含 agent update 时，确认页列出「引用该 agent 的既有工作流 N 个（列名字），本次未校验」。

- 扫表逻辑现成：`deleteAgent` 的 `workflowsUsingAgentIn`（`legacy/agent.ts:766-816`）就是同一个查询，抽出来复用；
- **不阻塞**任何操作，**不进** INTENT.md（与 D1 同口径：这是给人的信息）；
- 同时把「改 agent 无下游守卫、删 agent 有」这条不对称记进 `docs/audit-backlog.md`，留给后续 RFC 决定是否要真守卫。
