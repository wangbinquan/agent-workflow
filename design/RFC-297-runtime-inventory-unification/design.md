# RFC-297 技术设计：运行时清单统一

配套 `proposal.md`。本文定接口契约、数据流、耦合点、失败模式与测试策略。

## 1. 现状锚点（实现前请逐条复核）

| 事实                                                                    | 锚点                                                                                   |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `RuntimeDriver` 能力对象                                                | `packages/backend/src/services/runtime/types.ts:649`                                   |
| 静态能力声明 `RuntimeDriverCapabilities`                                | `runtime/types.ts:629-647`                                                             |
| `FaceSupport` 三态                                                      | `runtime/types.ts:609-612`                                                             |
| `DeclarationFace = keyof DeclaredManifestV1` + 漏表态即编译错的棘轮注释 | `runtime/types.ts:602-607`                                                             |
| opencode 独有 `readInventory?()`                                        | `runtime/types.ts:731-734`                                                             |
| claude 独有 `parseStartupInventory?()`                                  | `runtime/types.ts:776-786`                                                             |
| claude 独有 `parseUnusableMcpServers?()`                                | `runtime/types.ts:763-769`                                                             |
| 归一 switch 在调用方                                                    | `services/runner.ts:1942-1957`                                                         |
| 同一 init 行解析两遍                                                    | `services/runner.ts:1155` + `:1176`；`claudeCode/events.ts:104` + `:142`               |
| `wantsInventory` 布尔穿透                                               | `runtime/types.ts:383 / 453 / 590`，计算点 `runner.ts:562`                             |
| observation 写入受 `declaredHasContent` 门控                            | `runner.ts:1945`；`execution/startupVerification.ts:32-42`                             |
| opencode 富快照被降维成只剩 name                                        | `execution/startupVerification.ts:106-116`                                             |
| claude init 观测组装                                                    | `execution/startupVerification.ts:127-137`                                             |
| 落库列（快照 / 验证）                                                   | `db/schema.ts:1582` / `db/schema.ts:1600`                                              |
| opencode 读端                                                           | `runtime/opencode/inventory.ts:144`                                                    |
| verification 读端                                                       | `execution/startupVerificationRead.ts`                                                 |
| 路由                                                                    | `routes/tasks.ts:1115`（inventory）、`routes/tasks.ts:82`（verification 读端 import）  |
| 启动自检（声明 init-event 必须实现解析）                                | `runtime/selfCheck.ts:70-73`                                                           |
| 前端清单区                                                              | `frontend/src/components/inventory/RuntimeInventorySection.tsx`                        |
| 四张表 + 来源标签 + 状态徽章                                            | 同目录 `AgentsTable/SkillsTable/McpsTable/PluginsTable/sourceLabel.ts/StatusBadge.tsx` |
| 告警 banner                                                             | `frontend/src/components/inventory/StartupVerificationBanner.tsx`                      |
| i18n 强类型（`Resources` interface / `enUS: Resources`）                | `frontend/src/i18n/zh-CN.ts:10` / `en-US.ts:6`                                         |
| 现有 i18n 键树                                                          | `zh-CN.ts:10276-10314`（inventory）、`:10315-10329`（startupVerification）             |
| 其余观测消费点（需同步迁移）                                            | `services/systemAgentRun.ts:503`、`services/mcpRuntimeTest.ts:2689`                    |

## 2. 统一类型（shared）

新增 `packages/shared/src/schemas/runtimeInventory.ts`。既有 `shared/src/inventory.ts`（RFC-029）保留，仅服务存量转码（§5.3）。

### 2.1 面与字段：封闭联合 + 二维表态

```ts
/** 清单的五个面。新增一个面 = 每个 driver 的声明缺键 = 编译错误。 */
export type InventoryFace = 'agents' | 'skills' | 'mcps' | 'plugins' | 'tools'

/** 每个面下的可选富字段。新增字段 = 该面 Record 缺键 = 编译错误。 */
export interface InventoryFieldsByFace {
  agents: 'mode' | 'model' | 'source'
  skills: 'source' | 'path' | 'description'
  mcps: 'status' | 'type' | 'hint'
  plugins: 'source'
  tools: never
}

/** driver 的静态声明：面级 + 字段级，全部三态（沿用 RFC-282 的 FaceSupport 语义）。 */
export type InventoryDeclaration = {
  readonly [F in InventoryFace]: {
    /** supported = 有此概念且可观测；unsupported = 协议无此概念；
     *  unobservable = 平台会注入，但运行时不报告。 */
    readonly support: FaceSupport
    readonly fields: Readonly<Record<InventoryFieldsByFace[F], FaceSupport>>
  }
}
```

`tools` 的 `fields` 是 `Record<never, FaceSupport>` = `{}`，合法且为空——表示该面只有名字，没有富字段。

**这是 RFC-282 `declarationFaces`（`runtime/types.ts:646`）的直接同构扩展**，不是新造机制：同样用 `keyof` / 映射类型派生，同样让"漏表态"变成编译错误，同样由启动自检兜底校验（§4.3）。

### 2.2 清单条目

```ts
export const InventoryProvenanceSchema = z.enum([
  'injected', // 平台声明注入 ∩ 运行时报告已加载
  'ambient', // 运行时报告了，但平台没注入（内建 / 机器 / 项目配置继承）
  'declared-missing', // 平台声明注入了，运行时没报告 —— 与 banner 的 missing 行同源
])

export const InventoryEntrySchema = z.object({
  /** 面内唯一键：plugins 用 specifier，其余用 name。 */
  key: z.string(),
  /** 展示名。 */
  name: z.string(),
  provenance: InventoryProvenanceSchema,
  // —— 富字段：全部可选。缺失 = 该 runtime 不提供该字段（由 declaration 说明是
  //    unsupported 还是 unobservable）；null = 提供该字段但本条目无值。
  mode: z.string().nullable().optional(),
  modelProviderId: z.string().nullable().optional(),
  modelId: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  hint: z.string().nullable().optional(),
})
```

**为什么是单一 entry 而不是每面一个 schema**：五个面各自建 schema + 各自建 declaration + UI 五套泛型表格，啰嗦且没换来真实约束（UI 反正要按 declaration 选列）。放松点在类型、收紧点在测试——§8.1 有一条 driver 一致性测试：**driver 规范化出的事件载荷里，凡 declaration 声明为 `unsupported` 的字段不得出现非 `undefined` 值**。类型放松带来的风险由这条测试补回。

### 2.3 观测结果

```ts
export const RuntimeInventoryObservationSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('captured'),
    capturedAt: z.number().int(),
    faces: z.record(InventoryFaceSchema, z.array(InventoryEntrySchema)),
  }),
  /** 观测源在本轮按设计就不存在（opencode followup 复用会话）。 */
  z.object({ state: z.literal('not-produced'), reason: z.string() }),
  /** 观测源应该在却缺失。 */
  z.object({ state: z.literal('unavailable'), reason: z.string() }),
  /** 观测源在但坏了。 */
  z.object({ state: z.literal('malformed'), reason: z.string() }),
])
```

`not-produced` 与 `unavailable` 分开是刻意的：前者是正常状态（AC-6），后者才值得用户注意。混为一谈会复活 RFC-280 P2-E 治过的 followup 告警噪音。

## 3. driver 侧收口：统一事件流 + pipeline 消费

### 3.1 用户裁决（2026-08-13）：不要 collector，要事件流

本节初稿设计的是「每个 driver 交出一个 inventory collector」。用户否掉并给出更强的方案——**event 事件流 + pipeline 解析，来源统一、消费也统一**。采纳，理由成立且比初稿好一个量级：

collector 方案里，「把原始观测映射成统一清单」这件事**要在每个 driver 里各写一份**（初稿正是让 opencode 与 claude 各自映射富字段）。走事件流则职责重新切分：

- **driver 只负责规范化**——把自己的原始形态（claude 的 `system/init` 行 / opencode 的 `inventory.json` 文件）变成统一的 `NormalizedEvent`。这本来就是 `parseEvent` 的既有职责（`runtime/types.ts:136-141` 注释自陈 "the runtime-agnostic shape the generic pump consumes"）。
- **消费只写一份**——清单组装、provenance 计算、MCP 可用性告警、startup verification 全部是**运行时无关**的 pipeline stage，读同一个事件流。

于是 N 个 driver × 消费逻辑，坍缩成 N 个规范化器 + 1 份消费逻辑。第三个运行时接入时只需回答一个问题：「你的观测怎么变成事件」。

### 3.2 两个来源如何统一进一条流

| 运行时      | 原始形态                        | 进流方式                                                                                         |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| claude-code | stdout 首条 `system/init` 行    | 在该行**既有**的 `NormalizedEvent` 上附加清单载荷（`data`），kind / sessionId / persist 全部不变 |
| opencode    | 子进程退出后的 `inventory.json` | driver 在**退出后补发**一个合成事件（`kind: 'startup_inventory'`, `persist: false`）             |

**claude 侧为什么是「附加」而不是「产出新事件」**（实现期核实 `claudeCode/events.ts:63-100` 后修订）：那一行今天**已经**是结构化事件——`inferKind('system', …)`（`events.ts:234-243`）判为 `step_start` 并照常落 `node_run_events`，同时它还是 session 认领的入口之一。若把它改判成 `startup_inventory` 新事件，会同时改掉落库 kind 与 session 认领路径——两处都是高价值既有行为，且都不属于本 RFC 的标的。故 claude 只在原事件上多挂一个 `data` 字段，其余字节不动。

> ⚠️ **并发面（2026-08-13 记）**：另一个 session 正在同一个 `parseEvent` 里收窄 `sessionId` 的暴露口径——从「任何帧的 `session_id` 都暴露」改为「只暴露 root `system/init` 的」（工作树未提交改动，理由是内联子代理帧会在同一条 stdout 流里报出另一个 id）。该改动与本 RFC 的 T9 **改同一个函数**，落地时必须先确认它是否已入 main：
> · 若已入 main —— T9 在其之上叠加 `data` 载荷即可，init 行同时是「唯一 sessionId 来源」与「清单载荷宿主」，两件事天然同点；
> · 若仍未入 main —— T9 只做 `data` 载荷，**不得顺手改动 sessionId 的取值逻辑**，把那半留给对方，避免两个 session 对同一函数各改一半。
> 本 RFC 的设计不依赖该改动的落地与否。

`startup_inventory` 这个 kind 因此**只服务于 opencode 的合成事件**（它没有对应的 stdout 原文行，需要一个 kind 才能进流），并以 `persist: false` 排除出 `node_run_events`。

补发需要一个新钩子——流的生命周期从「逐行」扩展为「逐行 + 收尾」：

```ts
/** 子进程退出后调用一次；返回本运行时要补进事件流的合成事件（无则空数组）。
 *  opencode 在这里读 inventory.json 产出 startup_inventory 事件；claude 返回 []。 */
drainFinalEvents?(ctx: FinalEventContext): Promise<readonly NormalizedEvent[]>
```

这样「观测从哪来」被彻底封在 driver 内，pipeline 下游完全不知道有文件这回事——这正是用户要的「event 来源也统一了」。

### 3.3 事件形状扩展

`NormalizedEventKind`（`runtime/types.ts:127-134`，现有 7 个）新增一个成员：

```ts
export type NormalizedEventKind =
  | 'tool_use'
  | 'text'
  | 'reasoning'
  | 'permission_asked'
  | 'error'
  | 'step_start'
  | 'step_finish'
  | 'startup_inventory' // 新增：仅用于 drainFinalEvents 补发的合成事件
```

注意这个 kind **不用于 claude 的 init 行**（见 §3.2 的说明：那一行保持 `step_start`）。

`NormalizedEvent` 现有字段（`text` / `sessionId` / `timestamp` / `tokens` / `rawLine`）都是**pump 的横切关注点**；结构化观测需要一个 kind-specific 载荷：

```ts
export interface NormalizedEvent {
  // …现有字段不变…
  /** kind-specific 结构化载荷。按 kind 分派 zod 校验；
   *  'startup_inventory' 时为 RuntimeInventoryPayload。 */
  data?: NormalizedEventData
  /** 是否落 node_run_events。默认 true；合成的大载荷事件置 false（§3.6）。 */
  persist?: boolean
}
```

**为什么不把 `NormalizedEvent` 整体改成 discriminated union**：现有全部消费点（落库、token 统计、session 认领、文本累积、`SystemAgentOutputEvidence`）都读的是横切字段，改 union 会波及每一处却换不来真实约束。载荷用可选字段 + 按 kind 的 zod 分派，收紧点放在测试（§8.1 T-1）。

### 3.4 pipeline

runner 的 stdout pump 今天已经是一条**手写且散开**的 pipeline：`runner.ts:1155`（unusable MCP）、`:1176`（startup inventory）、`:1192`（terminal result）、`:1196`（parseEvent 后落库 / token / session / 文本）各自对同一行做一次 `JSON.parse`。本 RFC 把它显式化：

```
[driver.parseEvent(line)] ─┐
                           ├─→ NormalizedEvent ─→ [stage: 落库 node_run_events]
[driver.drainFinalEvents()]┘                   ├─→ [stage: token 统计]
                                               ├─→ [stage: session id 认领]
                                               ├─→ [stage: 文本累积]
                                               └─→ [stage: 清单组装 ← 新]
                                                        │
                                                        ├─→ runtime_inventory_json
                                                        ├─→ MCP 不可用告警
                                                        └─→ startup verification
```

- stage 是**纯消费者**，只看事件不看运行时；
- 每行只解析一次（AC-10 天然成立，不需要靠 driver 内部的命中标志）；
- 新增一个关注点 = 加一个 stage，不动 runner，也不动 driver。

**清单组装 stage** 吃**任何携带清单载荷（`data.inventory`）的事件** + `declared`，产出 `RuntimeInventoryObservation`——它不关心那是 claude 附加在 init 行上的载荷，还是 opencode 补发的合成事件：

- 富字段映射（opencode 的 mode/model/path/description/type/hint、claude 的 mcps.status）由事件载荷直接携带，stage 不做运行时判断；
- provenance 三态在此计算（§3.5 的映射表）；
- 全程没有任何携带清单载荷的事件 → 按 `capabilities` 区分 `not-produced`（followup 复用会话）与 `unavailable`（应该有却没有）。

各 driver 的规范化职责与静态声明：

**opencode**：`parseEvent` 不附加清单载荷；`drainFinalEvents` 读 `inventory.json`（沿用 `readSnapshotFromRunDir`）补发一个载荷完整的合成事件；`freshRun === false` 直接返回 `[]`（把今天 `observationSkippedByDesign`（`runner.ts:1943`）的判断从调用方搬进 driver）。declaration：`tools.support = 'unsupported'`（dump 插件不导出工具集），其余 `supported`。

**claude-code**：`parseEvent` 在识别 `system/init` 时于**同一次 `JSON.parse`** 内顺带填好 `data` 载荷的 tools / agents / skills / mcp_servers（合并今天 `events.ts:104` 与 `:142` 的两次重复解析——它们各自又 `JSON.parse` 了同一行，而 `parseEvent` 本来就已经解析过一次，故实际是**三次解析并作一次**）；`drainFinalEvents` 不实现。declaration：`plugins.support = 'unsupported'`（与既有 `declarationFaces.plugins`，`claudeCode/driver.ts:448` 一致）；富字段除 `mcps.status` 外全部 `unsupported`（init 不报告 mode/model/path/description/type/hint/source）。

`capabilities` 仍新增 `inventory: InventoryDeclaration`（D2 不变）。

### 3.5 provenance 计算（运行时无关，pipeline stage 内）

| 清单面    | 对应 `DeclaredManifestV1` 键                    |
| --------- | ----------------------------------------------- |
| `agents`  | `subagents`                                     |
| `skills`  | `skills`                                        |
| `mcps`    | `mcpServers`                                    |
| `plugins` | `plugins`                                       |
| `tools`   | `tools`（`null` = 未约束 → 该面全部 `ambient`） |

- `injected` = observed ∩ declared
- `ambient` = observed − declared
- `declared-missing` = declared − observed（**与 `verifyStartup` 的 missing 判定同源，抽同一个纯函数，不写第二套**，AC-4）

注意面名不同形（`agents` ↔ `subagents`、`mcps` ↔ `mcpServers`），映射表必须单点定义，避免实现时对错。

### 3.6 runner 的收敛

`runner.ts` 变化：

- 删 `capturedStartupInventory` / `capturedInventorySnapshot` 两个并行变量——观测状态归清单组装 stage 持有；
- stdout pump 里删 `runner.ts:1155-1171`（unusable MCP 解析）与 `:1176-1179`（startup inventory 解析）两个 if 块——它们变成 stage，pump 只做「`parseEvent` 一次 → 分发给各 stage」；
- 子进程退出后删 `runner.ts:1890-1930` 的 `readInventory?.()` 分支与 `:1947-1957` 的 switch，替换为「`drainFinalEvents()` 补发的事件走同一条分发」；
- `runtime-declared-mcp-unusable` 告警（`runner.ts:1164`）改为 stage 从统一观测里算：`mcps` 面中 `provenance === 'injected'` 且 `status !== 'connected'` 的条目。语义等价，且不再需要独立的 `parseUnusableMcpServers`；
- `wantsInventory` 从 `AgentSpawnContext` 移除，改由各 driver 在自己的 `buildSpawn` 里决定（opencode 依 `freshRun` + nodeKind 决定是否注入 dump 插件）。

**落库 stage 的过滤**：合成的 `startup_inventory` 事件载荷可达数十 KB，落进 `node_run_events` 会无谓撑大事件表（且它已经有 `runtime_inventory_json` 这个正式归宿）。故该事件 `persist: false`，落库 stage 跳过它——这正是 pipeline 的价值：**每个 stage 自己决定关心什么**，而不是由一个全知的 pump 替所有人决定。

### 3.7 本 RFC 的收口边界

runner pump 里还有两处同类的「对同一行二次解析」，**本 RFC 不动**，登记为后续：

- `parseTerminalResultError`（`runner.ts:1192`，`types.ts:762`）—— 服务的是终态错误判定，关注点不同；
- `observeSystemEvent`（`types.ts:679`）—— 服务的是系统 agent 取证。

二者按同一方向收进事件流是自然的下一步（各自变成一个 kind + 一个 stage），但它们牵动节点成败判定与 RFC-237 的取证契约，混进本 RFC 会让「清单看不见」这个用户问题的修复被无关风险拖住。在 `docs/audit-backlog.md` 登记一条即可。

同步迁移的另外两个调用点：`systemAgentRun.ts:503`（系统 agent 路径）与 `mcpRuntimeTest.ts:2689`（MCP 测试台）。

## 4. 落库与写入门槛

### 4.1 新增列（D4）

`node_runs` 新增 `runtime_inventory_json TEXT`（migration 一支，仅加列，无回填）。

**为什么不复用现有两列**：

- `inventory_snapshot_json` 是 opencode dump 文件的原文形状，塞不下 claude 的 `tools` 面，也没有 provenance；
- `startup_verification_json` 是「declared × observation × verification」三段取证记录，其 observation 段**已被刻意降维成只剩 name**（`startupVerification.ts:106-116`）——那是判定证据，不是展示数据。往里塞富字段会改掉 RFC-280 的既有契约与存量兼容面。

**新 run 的写入**：`runtime_inventory_json` 是唯一观测落库目标；`inventory_snapshot_json` **对新 run 停写**（避免第三份冗余，符合 RFC-279 的方向）。`startup_verification_json` 继续按原样写——它承载 declared 与判定结论，是另一份信息。

代价（诚实列出）：`inventory_snapshot_json` 停写会波及一批既有测试（`inventory-service.test.ts` / `routes-inventory.test.ts` / `runner-inventory-integration.test.ts` / `inventory-dump-twin-parity.test.ts` / `inventory-in-flight-fallback.test.ts` 等），需逐个迁移到新列语义。这是本 RFC 最大的一块改动面，plan.md 单列一批。

### 4.2 放宽 observation 的写入门槛（D5，需用户确认）

今天 `runner.ts:1945` 的 `if (declaredHasContent(injectionDeclared) && !observationSkippedByDesign)` 让**零注入节点整段跳过**——claude 侧 `capturedStartupInventory` 随作用域丢弃，连运行时自带的清单都留不下。

改为：

- **观测（`runtime_inventory_json`）无条件写**，只要清单组装 stage 给出了 `captured`；
- **验证（`startup_verification_json`）仍受 `declaredHasContent` 门控**——没注入任何东西，就不存在"注入是否生效"这个问题。

必须同时保证：零注入且观测缺失时，**不产生 `unavailable` 告警**。否则会复活 RFC-280 P2-E 治过的 followup 噪音（`startupVerificationHasFindings` 的第一条判据就是 `observation !== 'verified'`，`shared/src/schemas/startupVerification.ts:85`）。由于验证记录整体不写，banner 读端返回 `available:false`，天然不显示——但这条必须有测试锁定（§7.1 T-5）。

### 4.3 启动自检扩展

`runtime/selfCheck.ts` 现有规则（`:70-73`：声明 `init-event` 却没实现解析就拒绝启动）扩展为：

- 每个注册 driver 必须提供 `capabilities.inventory`，且五个面齐全（类型已保证，自检兜住 raw 注册路径）；
- 声明 `support: 'supported'` 的面，driver 必须真的能规范化出该面（以一条样本事件断言载荷含该键）；
- `startupObservation: 'none'` 的 driver 其 `inventory` 各面必须全为 `unsupported` 或 `unobservable`——不能声明 supported 却无观测源。

## 5. 读端

### 5.1 路由

沿用现有路径 `GET /api/tasks/:id/node-runs/:nodeRunId/inventory`（`routes/tasks.ts:1115`），响应体换成统一形状：

```ts
{ available: true, observation: RuntimeInventoryObservation, declaration: InventoryDeclaration }
| { available: false, reason: 'node-kind-not-supported' | 'run-not-found' | ... }
```

`declaration` 随响应返回，前端据此选列（§6）——不在前端硬编码 runtime kind。

### 5.2 数据源分派（实现期修订：按 capabilities 分派，且复用既有读端）

初稿写的是「先读新列，为空再回退转码」。实现时改为**按 driver 的静态表态分派**，
因为新列尚未落地（接入批阻塞）而用户可见问题不该等——且这个形状本来就更对：
读端不该知道运行时叫什么，只该知道它的观测源属于哪一类。

`services/execution/inventoryRead.ts` 的实际分派：

| `capabilities.startupObservation` | 取数                                                                 |
| --------------------------------- | -------------------------------------------------------------------- |
| `'inventory-file'`                | **调用既有的 `getInventorySnapshot`**，再把快照转成统一形状          |
| `'init-event'`                    | 读 `startup_verification_json` 的 `observation`（verified 态）转形状 |
| `'none'`                          | `not-produced('runtime-has-no-inventory')`                           |

**opencode 侧刻意复用而不是重写**（实现期教训）：初版把取数逻辑重写了一遍，当场
丢掉 RFC-062 的「运行中从 runRoot 实时读」——既有测试立刻抓出。那个读端承载了
RFC-029/062 多轮修复（in-flight 与 file-missing 的区分、reason 分类、非 agent kind
的 410），重写一遍等于悄悄丢掉其中几条。

失败 reason → 观测状态的映射（`observationFromSnapshotReason`）：

- `in-flight` / `non-agent-kind` → `not-produced`（正常状态，不告警）
- `parse-failed` → `malformed`
- 其余（`file-missing` / `plugin-load-failed` / `dump-plugin-internal-error` /
  `opencode-pure-mode`）→ `unavailable`，reason 原样呈现

**刻意不**按 `observationRequiresFreshRun` 把 `file-missing` 降级成「按设计不产」：
那个 capability 说的是「该运行时的观测依赖 fresh run」，而读端并不知道**本次** run
是否复用了会话（DB 未存该事实）。据此降级会把一次真实的插件加载失败说成正常状态，
正是 RFC-062 反过来治的那类误导。followup 的噪音归启动验证层处理。

三个非 captured 态均带 `message` 透传——dump 插件报的 `agents() call threw` 这类
诊断详情，不许因为「统一形状」被吃掉。

新列落地后（接入批），`'inventory-file'` 与 `'init-event'` 两支会一并改读新列，
本节的 reason 映射与 message 透传保持不变。

### 5.3 存量转码（D7：零 backfill）

存量行不回填，读端一次性转码：

- 老 opencode 行：`inventory_snapshot_json` → 统一 entry（与 §3.3 的 opencode 映射同一个纯函数）。provenance 无从取得（老行没存 declared）——统一填 `ambient` 并在响应里标 `provenanceUnavailable: true`，前端隐藏对账列而非显示错值；
- 老 claude 行：`startup_verification_json` 的 `observation`（verified 态）→ 统一 entry，只有 name + mcps.status；此列**存有 declared**，所以 provenance 可以正常算出；
- 两列都空 → `unavailable`。

存量转码层标注为过渡代码，随存量 run 被 events 归档 / GC 清理自然消亡，未来单独一个清理 RFC 移除。

## 6. 前端

### 6.1 组件

- `RuntimeInventorySection.tsx`：改为按 `declaration` 渲染五个面，`support === 'unsupported'` 的面**整块不渲染**（AC-3/B3/B4），`unobservable` 的面渲染为一行说明而非空表；summary 上的 chips 同步——不渲染的面不出现在 chips 里（"不支持"≠"0 个"）。
- 五张表收敛为**一个泛型表格组件** `InventoryFaceTable`，列集由 `declaration[face].fields` 计算：`unsupported` 的字段不出列，`unobservable` 的字段出列但单元格渲染 `—` 加 tooltip。现有 `AgentsTable` / `SkillsTable` / `McpsTable` / `PluginsTable` 四个组件退役（其列定义变成配置数据）。
  - 这一步同时满足 CLAUDE.md 的前端一致性硬规则：新面（tools）不新写第五张表，而是复用同一原语。
- 新增「来源」列：`injected` / `ambient` / `declared-missing` 三态，用既有 `<StatusChip>` 家族渲染（`StatusBadge.tsx` 已经是 StatusChip 的包装，RFC-035）。`declared-missing` 用 danger 色，与 banner 呼应。
- `sourceLabel.ts` 保留——它翻译的是 opencode 的 `source` **字面量**（inline/project/global/native），与新的 provenance 是两个不同维度，同时存在不冲突（B2）。
- `StartupVerificationBanner.tsx` 不动（D8：职责不同，且它与清单共用同一份 missing 判定）。

### 6.2 i18n

新增键全部进 `Resources` interface（`zh-CN.ts:10`），`en-US.ts` 同步 1:1（AC-11）：

- `nodeDrawer.inventory.face.tools`（新面标题）
- `nodeDrawer.inventory.provenance.injected / ambient / declaredMissing`
- `nodeDrawer.inventory.faceUnobservable`（该面注入了但运行时不报告）
- `nodeDrawer.inventory.reason.not-produced-session-reused`（B6）
- `nodeDrawer.inventory.reason.runtime-has-no-inventory`（取代对 claude 显示的 `file-missing`，B1）
- `nodeDrawer.inventory.col.provenance`

既有 `reason.*` 键保留供存量与 opencode 真实故障使用。

## 7. 失败模式

| 模式                                              | 处理                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 某个 stage 抛错                                   | **按 stage 声明的 `errorPolicy` 分流，不能一刀切隔离**——详见下方「§7.1 错误策略」。                                                 |
| `drainFinalEvents()` 抛错（opencode 读文件失败）  | 视作无补发事件，清单落 `unavailable(reason)`，不改节点成败。沿用今天 `inventory-read-unhandled` warn（`runner.ts:1921`）。          |
| init 事件缺失（claude 早期崩溃）                  | `unavailable('no-init-event')`；若同时有终态 `is_error`，节点本就按 `parseTerminalResultError` 失败，清单缺失是次要信息。           |
| dump 文件缺失（opencode）                         | 沿用既有 reason 分类（`plugin-load-failed` / `dump-plugin-internal-error` / `opencode-pure-mode` 等），不与"该运行时不产清单"混淆。 |
| 尾部输出截断（RFC-284 T14 `outputTailTruncated`） | 不影响清单：claude 的 init 在**流首**，opencode 的读在退出后。design 记此结论，测试锁定。                                           |
| 观测与声明面名不匹配（实现写错映射）              | §3.3 映射表单点定义 + 一条测试断言五个面的映射闭合。                                                                                |
| 第三个 runtime 漏表态                             | 类型层编译错误（`Record` 缺键）+ 启动自检兜底（§4.3）。                                                                             |

### 7.1 错误策略：stage 隔离不能一刀切（实现期修订）

初稿写的是「stage 之间必须相互隔离」。读 `runner.ts:1198-1219` 后修正——**现状里有一条 stage 的抛错是刻意要冒泡的**：

```ts
} else if (sessionId !== ev.sessionId) {
  throw new Error('runtime changed native session id during one run')
}
```

原生会话 id 在一次 run 中途变化，意味着运行时对话身份错乱，该 run 的所有事件归属都不可信——现状让它冒泡把节点判失败，这是 RFC-027/RFC-276 会话租约语义的一部分。若 pipeline 把所有 stage 的错误一律吞掉，这条保护会静默消失，且不会有任何测试变红（它只在异常运行时才触发）。

故 stage 显式声明错误策略：

| stage                           | errorPolicy | 理由                                                                             |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------- |
| session id 认领（含租约 claim） | `propagate` | 身份错乱必须终止该 run，保持现状                                                 |
| 事件落库                        | `propagate` | 沿用 `persistRunnerWrite` 的既有语义（写不进去 = 证据丢失，现状即冒泡）          |
| token 统计 / 文本累积           | `propagate` | 纯内存操作，抛错即代码 bug，不该被掩盖                                           |
| **清单组装（新增）**            | `isolate`   | 清单是呈现面，挂了不该弄坏一次成功的 run——warn 一次，其余 stage 与后续行不受影响 |

即：**新增的 stage 一律 isolate，搬迁的既有 stage 一律 propagate**，这样 PR-2 的骨架重构在错误路径上也是字节等价的。pump 本身仍不得中断（中断会让子进程在管道上阻塞，与 RFC-284 T14 的 drain 教训同源）——`propagate` 指的是错误沿现有路径抛给 `runAgentProcess` 的调用方，与今天完全一致。

## 8. 测试策略

### 8.1 后端

- **T-1** driver 规范化契约：每个注册 driver 各一组——喂入真实样本行 / 样本 dump 文件，断言产出的清单载荷形状正确，且 declaration 声明 `unsupported` 的字段恒 `undefined`（§2.2 的收紧点）。
- **T-2** claude：一条真实 `system/init` 样本（沿用 `rfc280-startup-verification.test.ts` 已有的样本）产出四个面；断言 `plugins` 面缺席、`tools` 面存在。
- **T-3** opencode：dump 文件样本产出四个面且**富字段一个不少**（逐字段断言，锁 AC-2 的无回归）。
- **T-4** provenance 纯函数：injected / ambient / declared-missing 三态的交并差；与 `verifyStartup` 的 missing 判定**同源**（同一输入两处结果必须相等，锁 AC-4）。
- **T-5** 零注入节点：`runtime_inventory_json` 有值、`startup_verification_json` 为 NULL、banner 读端 `available:false`（锁 AC-5 + §4.2 的噪音防复发）。
- **T-6** followup：`freshRun:false` → `not-produced('session-reused')`，且不产生告警（锁 AC-6）。
- **T-7** runner kind-blind：源码层文本断言——`runner.ts` 中不出现 `startupObservation` 的 switch、不出现 `readInventory` / `parseStartupInventory` / `parseUnusableMcpServers`（锁 AC-8，沿用本仓既有的源码文本兜底断言惯例）。
- **T-8** 单次解析：断言 claude 的 init 行在整条链路上只被 `JSON.parse` 一次（今天是三次：`parseEvent` + `parseUnusableMcpServers` + `parseStartupInventory`），其结果分发给全部 stage（锁 AC-10）。
- **T-8d** init 行既有行为不变：该行落库 kind 仍为 `step_start`、`sessionId` 仍被暴露给租约层——附加 `data` 不得改动这两处（锁 §3.2 的「附加而非替换」）。
- **T-8b** 错误策略分流（§7.1）：`isolate` stage（清单）抛错时其余 stage 仍收到后续事件、事件落库不丢且节点仍成功；`propagate` stage（session id 中途变化）抛错时**仍然**让 run 失败——后者是防止骨架重构把一条只在异常路径触发的保护静默吞掉。
- **T-8c** 补发事件同流：opencode 的 `drainFinalEvents` 产物与 claude 的流内事件走**同一条** stage 分发路径（断言两者产出的观测结构一致）。
- **T-9** 存量转码：老 opencode 行 / 老 claude 行各一，断言可读且 provenance 处理正确（老 opencode 行标 `provenanceUnavailable`），锁 AC-7。
- **T-10** 启动自检扩展：构造一个声明 supported 却产不出该面的假 driver，断言拒绝启动（扩 `rfc282-a3-driver-selfcheck.test.ts`）。
- **T-11** 迁移：新列 migration 的正向 + 存量行读取不受影响。
- **T-12** 失败模式：`observe` 抛错不中断 pump（喂 N 行、第 k 行抛错，断言后续行仍被消费且节点正常完成）。

### 8.2 前端

- **T-13** 按 declaration 选列：给定 claude declaration，断言 `plugins` 块与 `mode/model/path` 列**不在 DOM 里**（不是空文本）；给定 opencode declaration，断言 `tools` 块不在 DOM 里。
- **T-14** 富字段无回归：opencode fixture 渲染出今天全部列（对照现有 `session-inventory-section.test.tsx` 的断言集逐条保留）。
- **T-15** provenance 三态渲染 + `declared-missing` 与 banner 指向同一批名字。
- **T-16** i18n 完整性：扩现有 `i18n-inventory-rfc029.test.ts`，断言新键在 `zh-CN` / `en-US` 双份齐全、无 `defaultValue` 兜底泄漏。
- **T-17** `not-produced` 三档文案（in-flight / session-reused / runtime-has-no-inventory）各自渲染正确，且 claude 节点**不出现** `file-missing` 文案（锁 B1 的回归防护）。

### 8.3 回归防护命名

新测试文件顶端注明「锁的是哪类回归」，并链回本 RFC 与触发它的用户实证（claude 运行时清单显示 file-missing）。

## 9. 分批与风险

见 `plan.md`。最大风险是 §4.1 的 `inventory_snapshot_json` 停写波及的既有测试面——该批单独成一个 PR，与功能批解耦，便于出问题时单独回滚。
