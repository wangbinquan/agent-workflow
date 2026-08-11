# RFC-282 · 技术设计

状态：Draft **v2**（已按 2026-08-11 双路独立子代理设计门 20×P1 + 10×P2 修订；
findings 逐条落点见 §10。三条方向题已由用户重新拍板，其中 disabled 改判**已撤回**）

## 1. 目标架构

```
调用方（scheduler×6 / intent / narrative / smoke / distiller / MCP 测试台）
   │  只负责构造 runtime 无关的 AgentInjectionSpec + 上下文
   ▼
┌─ services/execution/ ──────────────────────────────────────────┐
│ ① resolveInjection.ts   引用 → 资源实体                         │
│      · dependsOn/mcp/plugin 闭包展开                            │
│      · exact-identity 围栏（RFC-223/228，语义原样）              │
│      · skill quarantine / canonical-path 门                     │
│      · DISABLED_RESOURCE_POLICY 单一规则表                      │
│ ② agentInjection.ts     资源实体 → 注入意图（纯函数，已有）      │
│ ③ driver.buildSpawn()   注入意图 → SpawnPlan{…, declared}       │
│      · 唯一装配方法（三合一）；declared 是装配的返回字段         │
│ ④ startupVerification.ts declared × 观测 → 验证（已有）          │
│ ⑤ agentProcess.ts → managedProcess（RFC-280 已收敛，不动）      │
└────────────────────────────────────────────────────────────────┘
                          ▲
        per-runtime 差异只在 services/runtime/{opencode,claudeCode}/
```

两道物理围栏，四道守卫（§4）分别守它们的不同侧面。

## 2. 接口契约

### 2.1 driver 三合一（决策 9）

删除 `buildSpawn(SystemAgentSpawnContext)` / `buildBusinessSpawn(BusinessNodeSpawnContext)`
/ `renderInjection(AgentInjectionSpecV1)` 三份，合为一个：

```ts
/** 一次 agent 子进程装配的完整输入。persona-only = injection 为空集，不是特例分支。 */
export interface AgentSpawnContext {
  /** runtime 无关的注入意图。系统面用 emptyInjectionSpec()。 */
  readonly injection: AgentInjectionSpec
  // ── 提示词与 persona（设计门 P1-1：三者缺一，业务/系统面都发不出提示词）──
  /** 用户提示词。opencode 走 positional argv（`opencode/driver.ts:184`）；claude 走 stdin。 */
  readonly prompt: string
  /** 本次运行的 agent 名（inline 条目的 map 键 / `--agent` 实参）。 */
  readonly agentName: string
  /** 系统面 persona 正文；业务面为 agent 的 body（`opencode/driver.ts:131-152`）。 */
  readonly systemPrompt: string
  /** RFC-041 记忆块（`opencode/driver.ts:274-281` / `claudeCode/driver.ts:211-215`）。 */
  readonly injectedMemoryBlock?: string | null
  /**
   * 每个 agent（root + 各 dependent）各自解析出的 runtime profile。
   * 设计门 P1-1：**不能收缩成单数 `profile`** —— dependent 的 model 会静默丢弃，
   * 正是 `agentInjection.ts:289-296` 注释刚修好的那个 bug。
   */
  readonly resolvedParamsByAgent: ReadonlyMap<string, RuntimeProfile>
  /** 进程 cwd（业务 = 任务 worktree；系统 = scratch worktree）。 */
  readonly cwd: string
  /** per-run 根 `<appHome>/runs/<taskId>/<nodeRunId>` 或系统面的 scratch run 目录。 */
  readonly runRoot: string
  readonly configDir: RuntimeConfigDirProfile
  /**
   * RFC-281 边界所需的 runtime 无关数据（本任务全部 mount 路径）。
   * 设计门 P1-10(b)：**不传 `BoundaryCtx`** —— 它的内容（`tmpGlobs` 含
   * `<tmpdir>/opencode/*`、`stagedSkillDirs` 含 opencode staging 布局）是纯
   * opencode 知识，让统一层构造它等于把 runtime 知识搬进统一层，与目标 2 相反。
   * `BoundaryCtx` 的**构造留在各 driver**（现状即如此，等于零改动）。
   * 省略 = 不施加边界（系统面 v1 不套）。
   */
  readonly taskMounts?: readonly string[]
  /** RFC-281 T3 的 sandbox 可用性探测缝（degrade-loudly 分支的测试注入点）。 */
  readonly boundaryHostProbe?: BoundaryHostProbe
  /** 调用方是否希望产出启动清单观测（driver 依自身能力决定是否兑现）。 */
  readonly wantsInventory: boolean
  // ── 会话：两个字段**必须分开**（设计门 P1-1）──
  /** 新建原生会话时预铸的 id（测试台 / 首次派发）。 */
  readonly nativeSessionId?: string | null
  /**
   * 续接已捕获会话的 id（RFC-026/148，`opencode/driver.ts:305`）。与
   * `nativeSessionId` **互斥**：两者同时出现时 driver 抛
   * `system-agent-native-session-conflict`（`claudeCode/driver.ts:168-169`），
   * 该断言原样保留 —— 合并成一个字段会把这条互斥判据抹掉。
   */
  readonly resumeSessionId?: string | null
  /**
   * RFC-111 D15 + RFC-112（Codex P1）冻结在 node_run 上的二进制。
   * 设计门 P1-3：**必须由调用方传入冻结值**，driver 不得自行从 registry 重解析
   * —— `nodeRunMint.ts:452-470` 的裁决是「resume/retry 读冻结快照，绝不读可变
   * registry」，否则运维改了 registry 后，minted 于旧二进制的 node_run 会在恢复
   * 时跑到新二进制上。drivers 也保持 DB-free（`types.ts:415`）。
   */
  readonly runtimeBinary?: string | null
  /**
   * TEST-ONLY 二进制覆写（决策 17 的**收窄射程**）：取代原 opencode-ONLY 的
   * `opencodeCmd`，成为 runtime 中立的 mock 注入通道。其 PRESENCE 同时是
   * 「不碰真实凭据桥」的信号（沿用既有 `runtimeCmd` 语义）。生产恒 undefined。
   */
  readonly binaryOverride?: readonly string[]
  readonly gitUserName?: string | null
  readonly gitUserEmail?: string | null
  readonly extraArgs?: readonly string[]
  readonly nodeRunId: string
  readonly log: Logger
}

export interface SpawnPlan {
  readonly cmd: string[]
  readonly env: Record<string, string>
  readonly stdin: { mode: 'pipe'; data: string } | { mode: 'ignore' }
  readonly beforeSpawn?: () => void | Promise<void>
  readonly cleanup?: () => Promise<void>
  /**
   * 决策 2/9 的兑现点：声明清单是本次装配的返回字段，与实际注入同源。
   * **必填** —— 不产声明的 driver 编译不过（§4.4 类型层收口）。
   */
  readonly declared: DeclaredManifest
  /**
   * 设计门 P1-6：既有 `SpawnPlan` 的两个字段必须保留，它们各有活消费方 ——
   * `declaredMcpServers` 被 `runner.ts:1057/1091/1098` 用作 RFC-242 T5 的
   * unusable-MCP 交集；`diagnostics` 被 `runner.ts:1008` 展开进 spawn 日志。
   * （`declaredMcpServers` 在 C 批可考虑改由 `declared.mcpServers` 承接，
   *   但那是独立的收敛动作，需单独登记 §7。）
   */
  readonly declaredMcpServers?: readonly string[]
  readonly diagnostics?: Record<string, unknown>
}

export interface RuntimeDriver {
  readonly kind: RuntimeKind
  readonly capabilities: RuntimeCapabilities // §2.2
  /** 唯一装配方法。 */
  buildSpawn(ctx: AgentSpawnContext): Promise<SpawnPlan>
  parseEvent(line: string): NormalizedEvent | null
  observeSystemEvent?(line: string): SystemEventObservation
  readInventory?(...): ... // 保留为实现细节，不再被当作 runtime 判据（§2.2）
  // …既有可选方法（createNativeSessionId / sessionReference / startLiveCapture）不变
}
```

**为什么 declared 必填而不是可选**：可选会让「忘了产声明」编译通过并静默退化成
「无验证」——正是 RFC-280 要终结的那类静默降级。必填 + 空清单常量
（`emptyDeclaredManifest()`）表达「本次确实无注入」，两者语义不同且都显式。

### 2.1b `buildPlan` 逃生舱与测试台的声明回传（设计门 P1-9）

「声明 = 注入的副产品」有一条现存的漏网路径：`systemAgentRun.ts:99/336-337` 的
`buildPlan?` 回调是 **driver 之外的第二个装配点**，它直接返回一个完整 `SpawnPlan`。
MCP 测试台正走这条路（`mcpRuntimeTest.ts:2485-2534` 装配、`:2634-2646` 验证），
且验证时是**重新纯函数渲染**拿 declared（代码注释自述 "re-renders from the
frozen-hash MCP row"）。四道守卫都拦不住它：grep 锁看不到（不是转换函数）、
ESLint 看不到（同目录）、启动自检看不到（不是 driver）、类型层只逼它**填个值**
不逼它**填对**。

两条修正：

1. **契约收窄**：`buildPlan` 只允许**包裹** `cleanup` / `beforeSpawn`，
   **不得替换** `cmd` / `env` / `declared`。签名从「返回 SpawnPlan」改为
   「接收 driver 产出的 SpawnPlan 并返回包裹后的 SpawnPlan」，使替换在类型上
   不可表达。此条加进 A2 grep 锁的禁止词族。
2. **声明回传路径**：测试台把 `plan.declared` 存进 turn 上下文供 settle 消费，
   删除 `:2646` 的重新渲染。这是「五条链路全部同源」的最后一块。

### 2.2 显式能力声明（决策 14）

取代 `driver.readInventory !== undefined` 这个代理判据：

```ts
/** DeclaredManifest 的九个面 —— 新增面时此联合类型扩张，见 §4.4。 */
export type DeclarationFace =
  | 'mcpServers'
  | 'skills'
  | 'subagents'
  | 'plugins'
  | 'tools'
  | 'droppedParams'
  | 'skippedDisabledMcps'
  | 'unsupported'
  | 'unobservable'

/**
 * 命名注意（设计门 P2-4）：**不叫 `RuntimeCapabilities`** —— `runtime/types.ts:626`
 * 已有 `DeclaredRuntimeCapabilities`，语义是「运行时启动清单里**观测到**的能力」，
 * 与这里的「driver **静态声明**的能力」完全不同却只差一个词，同文件内极易误读。
 */
export interface RuntimeDriverCapabilities {
  /**
   * 启动清单观测源。runner 按此 switch（穷尽），第三个 runtime 必须显式表态
   * 而不是掉进 claude 分支（现状：runner.ts:1836 的 readInventory 有无二分）。
   */
  readonly startupObservation: 'inventory-file' | 'init-event' | 'none'
  /**
   * 设计门 P1-7：**观测是否只在「本次 run 产清单」时可得**。
   * opencode 的 inventory 由插件在本次 run 写文件，followup（复用会话、不重跑
   * 插件）拿不到 ⇒ 现状 `runner.ts:1829` 用
   * `readInventory !== undefined && !wantsInventory` 整条跳过验证记录，注释
   * （`:1815-1819`）写明这是 RFC-280 实现门 P2-E：不跳过会让**每个 followup 都挂
   * 「无法验证」banner**（systematic noise）。claude 的 init 事件每次都有，不受影响。
   * 只保留 `startupObservation` 而丢掉这一维，等于复活那个已修的噪声。
   */
  readonly observationRequiresFreshRun: boolean
  /**
   * 每个声明面的表态。启动自检（§4.3）校验其完整性：缺面即拒绝启动。
   * Record 的穷尽性使「新增声明面」在所有 driver 上编译报错（§4.4）。
   */
  readonly declarationFaces: Readonly<Record<DeclarationFace, FaceSupport>>
  readonly acceptsExtraArgs?: true
  readonly acceptsSandboxCompatibilityMarker?: true
  readonly minVersion: string | null
}

export type FaceSupport =
  | 'supported' // 该 runtime 有这个面，且能观测验证
  | 'unsupported' // 该 runtime 没有这个面（如 claude × plugin）
  | 'unobservable' // 注入了但无观测手段（如 opencode × plugin 键域对不上）
```

runner 的消费从二分改为穷尽 switch，**并保留 P2-E 的跳过守卫**：

```ts
const caps = driver.capabilities
// P1-7：先判「这次 run 能不能观测」，再判「从哪观测」。顺序反了就是噪声回归。
if (caps.observationRequiresFreshRun && !wantsInventory) {
  // 不落验证记录（现状 runner.ts:1831-1835 的行为，逐字保留）
} else {
  switch (caps.startupObservation) {
    case 'inventory-file': observation = observationFromInventory(...); break
    case 'init-event':     observation = observationFromClaudeInit(...); break
    case 'none':           observation = { state: 'unavailable', reason: 'runtime-has-no-observation' }
  }
}
```

C2 需附一条**点名 followup 的回归锁**：opencode followup run 不产生
`startup_verification_json` 记录。

### 2.3 资源解析层归位（决策 8）

`scheduler.ts:9137-9330` 的 `prepareNodeRunInjection` + `resolveSkills` 搬到
`services/execution/resolveInjection.ts`，签名保持 typed-result（不 throw）：

```ts
export type InjectionResolution =
  | { kind: 'ok'; spec: AgentInjectionSpec; notices: readonly ResolutionNotice[] }
  | { kind: 'failed'; summary: string; message: string }

export async function resolveInjection(
  db: DbClient,
  agent: Agent,
  opts: ResolveInjectionOpts,
): Promise<InjectionResolution>
```

**`AgentInjectionSpec.skills` 必须拓宽**（设计门 P1-2）：现类型是
`{ name; sourceKind }[]`（`types.ts:54`，只够声明用），而实际 staging 消费的是
`ResolvedSkill`（`types.ts:77-87`，带 `sourcePath` / `skillId` / `contentVersion` /
`readContentVersion` —— RFC-178/223 内容版本围栏的载荷，被 `stageSkills` 与
`renderClaudeManagedSkillAttachments` 直接读）。不拓宽则 B2 一落地技能注入就残。
此项作为向后兼容的类型扩张登记进 §7。

三点语义调整（其余原样）：

1. **skill 的 quarantine / canonical-path 门从 throw 改为 typed failure**，与 mcp/plugin
   三段对齐（现状不一致：同函数内 skill 是 throw、其余是 `{kind:'failed'}`）。
   throw 会被 `runScope` 冒泡成任务级错误，把节点级归属整个吃掉。
2. **disabled 处理改走单一规则表**（§2.4）。
3. **6 个入口全走它**：commit-push / merge agent 的合成 agent 也经此解析，资源从
   `buildCommitAgent()` / `buildMergeAgent()` 的定义推导，而非调用点写死四个空数组。
   两个内置 agent 定义处本就零资源 ⇒ 解析结果今天等价，但从此「给内置 agent 加引用」
   会真正生效而不是静默丢弃。

exact-identity 围栏（`injectionIdentity.ts`）语义原样保留，RFC-223 的锁不改断言。

### 2.4 disabled 单一规则表（决策 4/6/20）

**v2 重大修订**：初版要把取值统一为 `skip-and-declare`。设计门第二轮查明该改判的真实
射程是 **5 个产出点 + 4 道上游 launch 门 + 前端状态推导 + 已落 DB 列**（详见 proposal
§5 表第 1 行），用户据此**撤回决策 4/20**。v2 的目标因此收窄为：**不改任何取值，只把
散在三处的规则集中到一处可读，并让新增资源类型必须表态。**

```ts
// services/execution/resourcePolicy.ts —— 「引用了 disabled 资源会怎样」的唯一可读点
export type DisabledDisposition =
  | 'fail-closed' // 拒绝启动/派发；理由随附
  | 'skip-and-declare' // 跳过并进声明清单，节点照常运行

/**
 * 键集**只收真有 `enabled` 列的资源类型**（设计门 P1-7/P1-10）：
 * `mcps`(schema.ts:199) / `plugins`(:241) / `agents`(:105) 有该列，
 * **`skills` 表没有** —— 把 skill 写进这张表会造出永不被求值的死条目，而启动
 * 自检还会「验证」它存在，接手者读到会以为 disabled skill 已被处理。这正是
 * §8-2 引用的 RFC-280 实现门 P2-D「未用函数假装有保障」的同类复发。
 * （skill 的不可用性走的是 RFC-170 quarantine —— 完整性围栏而非用户开关，
 *   在 §2.3 单独描述，不进本表。）
 */
export const DISABLED_RESOURCE_POLICY: Readonly<
  Record<DisableableResourceKind, DisabledPolicyEntry>
> = {
  // plugin 影响 runtime 的行为面（工具/钩子），缺失会让 agent 跑出"看似成功
  // 但能力不全"的结果 ⇒ 5 个产出点 + 4 道上游门共同保证它到不了执行。
  plugin: { disposition: 'fail-closed', sites: PLUGIN_DISABLED_SITES },
  // MCP 缺失只是少一个工具，且 RFC-280 已裁定为「声明 + 告警」（落差③）。
  mcp: { disposition: 'skip-and-declare', declaredField: 'skippedDisabledMcps' },
  // agents.enabled 存在，但 resolveDependsClosure（agentDeps.ts:65+）今天全程
  // 不看它。写成任何一种 disposition 都是**新增行为**（前者拒跑、后者静默丢弃），
  // 均属未评审的语义变更 ⇒ 显式记为「本表不管」，由自检单独报告。
  agent: { disposition: 'not-modeled', why: 'dependsOn 闭包不消费 enabled（现状）' },
}
```

两条配套要求：

1. **`'not-modeled'` 必须被启动自检单独报告**，不计入「已表态」——使「某类资源的
   disabled 语义尚未建模」保持可见，不被一张看似穷尽的表掩盖。
2. **规则表是索引而非实现**：`fail-closed` 那条的 `sites` 指向 5 个真实产出点，
   本 RFC **不搬动它们的逻辑**（搬动 = 改 RFC-228 围栏 = 未 scope）。表的价值是
   「一处读完 + 新增类型编译期强制表态」，不是把实现挪进来。

被跳过的项进 `DeclaredManifest.skippedDisabled*`，经 §1④ 的验证层落
`node_runs.startup_verification_json`，节点详情 banner 可见。**声明面因此从
`skippedDisabledMcps` 泛化为按资源类型分组**（wire 兼容处理见 §5）。

### 2.5 boundary 拆分（决策 10）

`services/execution/workspaceBoundary.ts` 拆为三处，**语义一字不改**：

| 内容                                                            | 去处                                         | 理由                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BoundaryCtx` **类型定义** / `resolveBoundaryMounts`            | 留 `services/execution/workspaceBoundary.ts` | 「本任务的合法工作区有哪些 mount」是产品语义，runtime 无关                                                                                                                                                              |
| `BoundaryCtx` 的**构造**                                        | **留在各 driver**（现状即如此，零改动）      | 设计门 P1-10(b)：其内容是纯 opencode 知识 —— `tmpGlobs` 含 `<tmpdir>/opencode/*`、`stagedSkillDirs` 含 opencode staging 布局（`opencode/driver.ts:227-235`）。让统一层构造它 = 把 runtime 知识搬进统一层，与目标 2 相反 |
| `opencodeDataDir` / `machineSkillRoots`                         | `runtime/opencode/boundary.ts`               | 同上：它们编码的是 opencode 的 XDG 布局与 skill 发现规则（函数注释直接引 opencode 源码行号），是 opencode 专属知识                                                                                                      |
| `composeOpencodeBoundary`（`external_directory` 键序纪律）      | `runtime/opencode/boundary.ts`               | opencode 原生权限键的键序规则                                                                                                                                                                                           |
| `composeClaudeBoundarySettings` / `claudeExpressibleAuthorDirs` | `runtime/claudeCode/boundary.ts`             | claude sandbox settings 的字段形状                                                                                                                                                                                      |

即：**统一层只保留「哪些 mount 属于本任务」这一条产品语义**（`taskMounts`，
`AgentSpawnContext` 上唯一的边界字段），其余全部下沉。这与 §2.1 一致 —— 调用方
传 `taskMounts`，driver 自己构造 `BoundaryCtx` 并合成。RFC-281 的行为锁只改
import 路径，断言内容一字不改。

## 3. 数据流（业务节点，归一后）

```
scheduler 入口（6 个，统一形态）
  → resolveInjection(db, agent, opts)          [execution 层，含围栏与 disabled 规则表]
      → { spec: AgentInjectionSpec, notices }
  → runner 构造 AgentSpawnContext（cwd/runRoot/profile/boundary/wantsInventory/…）
  → driver.buildSpawn(ctx) → SpawnPlan{ cmd, env, stdin, cleanup, declared }
      └ declared 与 argv/env 同一次装配产出（决策 2 的结构性兑现）
  → runAgentProcess(plan → AgentProcessRequest)  [RFC-280，不动]
  → 按 driver.capabilities.startupObservation 取观测 → verifyStartup(declared, obs)
  → 落 node_runs.startup_verification_json（RFC-280 已有）
```

系统面（intent / narrative / smoke / distiller）走同一条链，`injection` 为空集、
`boundary` 省略、`wantsInventory: false`；declared 为空清单，验证层自然跳过。

## 4. 四道防护（决策 3，第一批先行）

### 4.1 源码层 grep 锁

新增 `tests/rfc282-single-implementation-lock.test.ts`，沿用仓内既有模式
（`SPAWN_CWD_SITES` / rfc276 守卫词族）。锁三类事实：

1. **每类资源的转换函数只有一个定义点**（八类：MCP wire / agent 条目 / subagent 条目 /
   skill staging / plugin spec / permission 映射 / memory 织入 / boundary 合成）。
2. **调用点在白名单内** —— 白名单是显式常量数组，加调用点必须改这个文件（评审可见）。
3. **禁止词族** —— 例如 `services/runtime/**` 之外不得出现 `OPENCODE_CONFIG_CONTENT`
   / `--mcp-config` / `.claude/` 字面量（现状已基本满足，锁住它）。

### 4.2 ESLint import 边界（严格 + 存量例外清单，决策 15）

> **⚠️ 实现方式的硬约束（设计门 P1-8）：必须「扩展既有 block 的 `patterns` 数组」，
> 绝不新增一个 config 对象。** `eslint.config.js:62-74` 已为
> `files: ['packages/backend/**']` 声明过 `no-restricted-imports`（禁
> `@agent-workflow/frontend` / `react` / `@xyflow/*` / `vite`）。ESLint flat config
> 对**同名规则**是后者整体替换 options、**不合并 `patterns`** —— 新增一个针对
> `packages/backend/src/**` 的 config 对象，会让该目录下所有文件**丢掉原有的跨包禁令**，
> 是一次伪装成加固的防护移除，且 lint 输出上完全看不出来。
>
> A1 的「正向证明」因此必须**同时**覆盖新旧两组 pattern 的变异实证（旧 pattern 仍会
> 报错），而不只是新 pattern —— 沿用 `docs/dev-gotchas.md` 的「结构守卫必做变异实证」。
>
> **实现修正（A1 落地时，2026-08-11）**：设计门漏算了 `packages/backend/tests/`
> 里 **33 条**对 driver 内部的合法单元测试 deep import——「扩展既有 block」的字面
> 做法会把它们全部打红（给 33 处测试挂 disable 注释是纯噪声）。落地形态改为：
> 抽 `backendCrossPackagePatterns` **共享常量**，把既有 block 拆成
> `packages/backend/**`（ignores src）与 `packages/backend/src/**` 两个 block，
> **两个都 spread 同一份跨包禁令数组**、后者追加 runtime 围栏 patterns。P1-8 保护的
> 不变量（旧禁令不静默失效）由共享常量结构性成立，且
> `rfc282-a1-eslint-boundary.test.ts` 对**两个 block 各自**做旧 pattern 变异实证
> （src 文件 + tests 文件 × react/frontend 禁令四个方向全红）。存量违规 5 处
> （`runner.ts:81/2194/2195/2199`、`runtimeRegistry.ts:34`）挂
> `RFC282_IMPORT_EXCEPTIONS` 行内注释，三元组清单与陈旧棘轮在
> `rfc282-single-implementation-lock.test.ts`。

规则内容（并入既有 block）：

```js
// packages/backend/src/**（除 services/runtime/**）
{
  patterns: [
    {
      // 设计门 P1-8(1)：**必须同时匹配相对路径形态** —— 现存越界恰恰是相对路径
      // （`runner.ts:81` `from './runtime/opencode/inlineConfig'`），只写别名的
      // 规则上线即漏。
      group: [
        '@/services/runtime/opencode/*',
        '@/services/runtime/claudeCode/*',
        '**/runtime/opencode/*',
        '**/runtime/claudeCode/*',
        './runtime/opencode/*',
        './runtime/claudeCode/*',
      ],
      message: 'per-runtime 代码只能经 @/services/runtime（index/types）访问 —— RFC-282 §4.2',
    },
  ]
}
```

**re-export 洗白通道必须一并堵死**（设计门 P1-8(2)）：`runner.ts:2194/2195/2199`
把 opencode 内部原样 re-export（`events` / `spawn` / `inlineConfig`，注释自述是为了
让 tests 与 memoryDistiller 继续从 `./runner` 解析）。任何模块
`from '@/services/runner'` 即可拿到 opencode 内部，而 **importer 侧的
`no-restricted-imports` 完全看不见**。因此：

- A2 的 grep 锁增一条：`services/runtime/**` 之外的文件不得
  `export … from '…runtime/{opencode,claudeCode}/…'`；
- plan 增前置任务 **C0**（C3 之前）：拆掉 runner 的三条 re-export，把
  `memoryDistiller` 与测试的 import 点改到真源。否则 C3 搬完文件，这些 re-export
  会把 opencode 内部又拉回 `services/` 根。

顺带一处真重复（应进 A2 八类清单）：`EMPTY_RUNTIME_PROFILE` 同时在
`agentInjection.ts:33` 定义、又从 `runtime/opencode/inlineConfig.ts` 导出，
runner 从后者 import —— 正是 grep 锁该抓的分叉。

**例外清单的形态与棘轮**（设计门 P1-9）：`RFC282_IMPORT_EXCEPTIONS` 必须按
**`(规则, 文件, 匹配文本)` 三元组**表达，而不是按文件豁免 —— 按文件豁免会连带放过该
文件未来的每一处新违规，这是仓内 `scripts/depcheck.ts` 已经修掉过一次的反模式；同时
照抄它的**陈旧棘轮**（`staleIgnores`：清单里已不再命中的条目必须硬失败，否则清单只涨
不落）。

**清单会先涨后落，plan 必须承认**（设计门 P1-9）：今天围栏内的生产违规几乎为零
（`runtimeRegistry.ts:34` 一条 + `runner.ts:81` 的 value-import + `runtime/types.ts:28`
的 type-import）。C3 把 ~1700 行**搬进**围栏后，42 条 import specifier 会一次性变成
越界。因此「每收敛一批划掉一条、归零 = 完工」的表述要改成：**A1 建清单 → C3 一次性
增列（同批全部改写完毕即清零）→ E1 验证归零**。

**访问机制必须明写**（设计门 P1-9 风险 B）：目标 2 说「外部只能经 `runtime/index.ts`
与 `runtime/types.ts` 访问」，但让 7 个路由继续拿到二进制解析有两条路，本 RFC 选后者：

- ~~加 barrel/re-export~~ —— `runtime/types.ts:30` 的注释已警告 `runtimeRegistry`
  value-imports `runtime/index`，把 `util/opencode`（它 import `@/config`）挂进去会
  显著扩大模块初始化环面。**不采用**。
- **采用**：跨用类型（如 `ProbeOpts`，`claudeCode/probe.ts:7` 从 `util/opencode` 取 ——
  设计门 P2-7 指出搬迁后它会变成 claude→opencode 的跨 runtime 边）上提到
  `runtime/types.ts`；其余按需在 `runtime/index.ts` **逐个具名 re-export** 并逐条论证
  不闭环。C1 完成后路由不再需要二进制解析，这条需求自然消失大半。

存量违规逐条进清单（文件顶部常量 + 每条注明归属批次），**清单归零 = 完工判据 1**。

### 4.3 启动期自检

daemon boot 在业务服务前校验（沿用 `ROUTE_BACKED_POINTS` 反向自检先例）：

1. 每个注册 driver 的 `capabilities.declarationFaces` 覆盖 `DeclarationFace` 全集；
2. `capabilities.startupObservation` 是三个合法值之一；
3. `DISABLED_RESOURCE_POLICY` 覆盖 `InjectableResourceKind` 全集。

任一不满足 → 拒绝启动并点名缺失项。理由同 RFC-247：一个声明了却没实现的面，比没声明
更糟——它让验证层以为自己在验证。

### 4.4 类型层收口

三个穷尽性约束，使「绕过统一层」在类型上不可表达：

1. `SpawnPlan.declared` **必填** ⇒ 不产声明编译不过。
2. `RuntimeCapabilities.declarationFaces: Record<DeclarationFace, FaceSupport>` ⇒ 新增
   声明面时**所有 driver 编译报错**，必须逐个表态。
3. `DISABLED_RESOURCE_POLICY: Record<InjectableResourceKind, …>` ⇒ 新增可注入资源类型
   时必须在规则表表态。

这三条是本 RFC 最强的防护：它们让「加一类资源却漏了某个 runtime」从「运行时才发现」
变成「编译期就过不去」。

## 5. 兼容与迁移

- **无 DB 迁移**。`startup_verification_json` 的持久化结构保持向后兼容：
  `skippedDisabledMcps` 字段保留（读端容错），新增按类型分组的
  `skippedDisabled: Record<ResourceKind, string[]>`；存量行不回填，读端两者取并。
- **无 wire 破坏**：`opencodeCmd` 是纯内部字段（shared / frontend 零命中，已核实）。
- **resume / retry**：注入解析在每次 attempt 重新执行（现状即如此），不存在跨版本
  持久化的注入快照，故重构对 resume 无影响。**此项在实现期以 rfc026/042 的 resume
  行为锁验证。**
- 分批推进（见 plan.md），每批独立 `gate:local` 全绿、独立可回滚。

## 6. 失败模式

| 失败                                 | 现状                         | 归一后                                  |
| ------------------------------------ | ---------------------------- | --------------------------------------- |
| 引用 disabled plugin                 | 节点硬失败 `plugin-disabled` | 照常运行 + 声明告警（决策 4，行为变更） |
| 引用 disabled MCP / skill / agent    | MCP 跳过告警；其余各异       | 全部 skip-and-declare（单一规则表）     |
| 闭包内不同 id 同 enabled name        | spawn 前 fail                | **原样保留**（RFC-223/228 语义不变）    |
| skill quarantine / 非 canonical path | throw → 任务级错误           | typed failure → 节点级归属（§2.3-1）    |
| 未知 / 损坏的 runtime kind           | 静默当 opencode 跑           | 显式报错（决策 13）                     |
| driver 漏实现某个声明面              | 静默空声明                   | 启动自检拒绝启动（§4.3）                |
| 新增资源类型漏了某 runtime           | 运行时才发现                 | 编译期报错（§4.4）                      |
| 有人在 driver 里再写一份转换         | 无人发现                     | grep 锁 + ESLint 当场红（§4.1/4.2）     |

## 7. 有意变更清单（golden / source-lock 影响面，owning 任务见 plan.md）

决策 16：接受等价变化，逐条改断言并在 commit message 声明。清单外的任何变化都是 bug。

| #     | 变更                                                                                                      | 受影响断言                                                                                                                                                                                                                                                                                                                                                                                   | owning  |
| ----- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1a    | **opencode** 系统 agent inline 条目统一产出（多出 description/options）                                   | `runtime-buildspawn.test.ts` 系统面精确形状断言                                                                                                                                                                                                                                                                                                                                              | B1      |
| 1b    | **claude 系统 agent 条目不注入 permission**（设计门 P1-6，用户拍板）                                      | 无断言变更 —— 这是**显式保持现状**。claude 无 permission 声明 = unconstrained（`claudeCode/driver.ts:239-245`，2026-07-31 用户裁定）；注入会让 intent/narrative/smoke/distiller 的工具面从「全开」收缩成「只开声明的」，症状是模型干不动活而非报错。B1 需加一条**正向锁**：claude 系统面渲染出的条目不含 permission 键                                                                       | B1      |
| ~~2~~ | ~~`plugin-disabled` 错误码删除~~                                                                          | **v2 撤回**（决策 4/20）。该码及其 5 个产出点、4 道上游门、双语文案、DB 落列**全部原样保留**                                                                                                                                                                                                                                                                                                 | —       |
| 3     | `opencodeCmd` + `runtimeCmd` → 单一 `binaryOverride`（**射程收窄**：`runtimeBinary` 冻结值保留，见 §2.1） | 传参断言 + **124 个测试夹具**的 mock 注入姿势 + `rfc143-runtime-driver-capability.test.ts:333` 的精确 import 字符串锁                                                                                                                                                                                                                                                                        | C1      |
| 4     | boundary 合成下沉各 driver                                                                                | RFC-281 测试的 import 路径（**断言内容不改**）                                                                                                                                                                                                                                                                                                                                               | C4      |
| ~~5~~ | ~~`skippedDisabledMcps` → 按类型分组~~                                                                    | **v2 撤回**（随决策 4：只有 MCP 一类走 skip-and-declare，分组无收益。声明面形状不变 ⇒ 前端 banner / `declaredHasContent` / `startupVerificationHasFindings` 三段漏斗**零改动**，规避了设计门 P1-3 指出的整条风险）                                                                                                                                                                           | —       |
| 6     | driver 三方法 → 单一 `buildSpawn`                                                                         | `rfc143-runtime-driver-capability.test.ts` 接口面断言                                                                                                                                                                                                                                                                                                                                        | B1      |
| 7     | **skill 门 throw → typed failure**（设计门 P1-6-1）                                                       | 失败**归属**从任务级变节点级：`SkillQuarantinedError`（`scheduler.ts:9301`）与 `ConflictError('skill-path-not-canonical')`（`:9309`）今天在 src 内零 catch，冒泡成任务级失败；改后同任务其它节点（含 commit-push）会继续跑。这是把 RFC-170 T9 的 fail-closed 从「整任务停」放宽成「本节点停」。**今天没有任何测试锁住现有归属 ⇒ B2 必须先补一条「quarantine skill → 任务级失败」的红测再改** | B2      |
| 8     | `AgentInjectionSpec.skills` 拓宽为 `ResolvedSkill[]`（§2.3）                                              | 类型面向后兼容扩张                                                                                                                                                                                                                                                                                                                                                                           | B2      |
| 9     | **声明渲染失败的优雅降级消失**（设计门 P1-6-3）                                                           | 今天 `renderInjection` 在独立 try/catch 里（`runner.ts:943-968`），渲染失败只是「验证不记录」**不失败节点**；三合一后它并入 `buildSpawn`，失败即 `runtime-spawn-failed`。**需在 B1 显式决定**：要么保留 declared 渲染的独立降级（推荐：装配内 try/catch，declared 退化为空清单 + warn），要么登记为行为变更                                                                                  | B1      |
| 10    | `buildPlan` 契约收窄为「只可包裹不可替换」（§2.1b）                                                       | `systemAgentRun` 逃生舱签名 + 测试台声明回传                                                                                                                                                                                                                                                                                                                                                 | B1/C 批 |

其余 argv / env / 落库形状**必须字节不变**，由每批的对拍测试证明。

**§0 规矩 2 的自洽性**：本表是「唯一允许的行为差异」全集。设计门 P1-6 指出初版漏登
4 项（7/8/9/10 已补）；实现期若再发现清单外的差异，一律按 bug 处理并回填本表。

## 8. 测试策略（Test-with-every-change + 决策 19「每批都对拍」）

1. **对拍测试（每批必备）**：换装配路径的批次，先写「新实现 vs 旧实现产出逐字段
   相等」的对拍用例（跨 opencode × claude × 有/无注入 × 有/无 boundary 的矩阵），
   证明等价后在**同一 PR** 内删旧实现。对拍用例本身随旧实现一起删除，其覆盖意图由
   golden 锁承接（避免留下一堆只比较两个相同东西的僵尸测试）。
2. **防护自身的测试**：四道守卫各自要有「能抓到违规」的正向证明 —— 例如故意在
   fixture 里写一个越界 import，断言 ESLint 规则报错；故意让一个 mock driver 少一个
   声明面，断言 boot 拒绝启动。**只有能抓到违规的守卫才算守卫**（RFC-280 实现门
   P2-D 的教训：`files containment` 曾是「未用函数假装有保障」）。
3. **行为锁不改断言**：RFC-280 / RFC-281 / RFC-223 的全部行为锁，除 §7 清单外零改动。
4. **功能不受影响的正向证明**（决策 21）：每批 PR 的 `gate:local` 全绿 + 关键业务链路
   e2e（至少覆盖：业务节点带 MCP/skill/plugin 跑通、fan-out、commit-push、merge、
   intent 回合、MCP 测试台）。
5. **反向回归锁**：disabled plugin 现在能跑通且产告警（行为变更 1 的红→绿实证）。

## 9. 设计门复核项的结论（v2：双路设计门已给出答案）

| #   | 初版待复核项                                             | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `opencodeDataDir` / `machineSkillRoots` 留统一层是否成立 | **不成立，已改**：它们编码 opencode 的 XDG 布局与 skill 发现规则（注释直接引 opencode 源码行号），下沉到 `runtime/opencode/boundary.ts`。统一层只留 `taskMounts`（§2.5）                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | skill 门 throw → typed failure 是否改变失败归属          | **确实改变**：从任务级变节点级（RFC-170 T9 的 fail-closed 从「整任务停」放宽为「本节点停」），且**今天零测试锁定**。已登记 §7-7，B2 必须先补红测                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | `skippedDisabled` 分组的读端兼容                         | **需求消失**（随决策 4 撤回，声明面形状不变）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4   | C3 纯搬迁对拍什么                                        | **符号相等不够**：`src/opencode-plugin/` 是嵌入资产生产线（`scripts/build-binary.ts:34` 硬编码路径、`:201-202` 禁嵌套子目录、`index.ts:21` 相对深度依赖），搬迁后 `PLUGIN_FILES` 可能空表 ⇒ 二进制模式 inventory 恒空 ⇒ 启动验证恒 unavailable（RFC-029 当年 `c839862` 修过的回归），而 **`gate:local` 不跑 `build:binary`** ⇒ 本地全绿、CI 才炸。**对拍面改为**：`build:binary -- --include-e2e` + `PLUGIN_FILES` 非空断言 + 一次真读 inventory 的集成跑通；符号相等保留但非唯一证明。**外加**断言搬迁 commit 的 diff 除 import 路径外零内容变更（`git diff -M --find-copies-harder` similarity 100%）       |
| 5   | 6 入口统一对 writeSem 内 merge agent 的时序影响          | **今天≈零成本**：`buildCommitAgent()` / `buildMergeAgent()` 零资源，`resolveDependsClosure` 空 `dependsOn` 零 DB，`loadMcpsByIds` 空 ids 直接返回（`mcpClosure.ts:62`）；writeSem 是信号量非 DB 锁，且 merge 走 DIRECT runNode 绕开 node pool ⇒ 无死锁。**但代价在未来兑现**：B2 的卖点就是「以后给内置 agent 加引用会真正生效」，那一天起闭包展开 + skill staging + 三次 DB 查询会跑在 writeSem 内，而该路径的超时保护是 RFC-208 事后补的。⇒ **要求 `resolveInjection` 在 writeSem 内的调用点透传 `signal`**，并在 B2 加一条「零资源合成 agent 经 resolveInjection 恒返回 ok」的回归锁（新增失败模式的守卫） |

### 9.1 依赖图与 depcheck 的真实风险（设计门第二轮的反向澄清）

初版担心的「C3 会闭合模块初始化环」**经核实不成立** —— 纯搬迁是图同构，不增删边；唯一
涉及 `services/runtime/` 的环（`runtime/types.ts` →type→ `subagentLiveCapture` →value→
`sessionCapture` →type→ `sessionEventSink.ts:1` →type→ `runtime/types.ts`）**今天就存在**，
且被 `.dependency-cruiser.cjs:118` 的 `viaOnly: { dependencyTypesNot: ['type-only'] }`
排除（该排除本身被 `tests/rfc217-architecture-locks.test.ts:39` 锁住）。

**真正的风险是另一条**：`scripts/depcheck.ts:250-256` / `:335-349` 的 fail-closed
「未解析第一方边 = 0」棘轮 —— 42 条 import 改写里错一条就红。C3 的收尾必须包含一次
完整 `bun run depcheck`。

## 10. 设计门 findings 落点索引（v2）

2026-08-11 双路独立子代理对抗评审（未用 Codex：共享 main 上并发提交会让 `--base` 把
他人 diff 卷进复审，见 `docs/dev-gotchas.md`）。共 20×P1 + 10×P2。

### 10.1 三条方向题（用户重新拍板）

| finding                                                    | 裁决                                                            | 落点                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| disabled 改判真实射程 = 5 产出点 + 4 上游门 + 前端状态推导 | **撤回改判**，plugin 保持硬失败；归一目标收窄为「规则单点可读」 | proposal §0-3/§5-1/§7/§9(决策 4,20)、design §2.4/§7-2/§7-5 |
| C1 真实半径 = 124 个测试夹具 + audit-backlog 的 Windows P2 | **纳入，顺带关闭该 P2**                                         | proposal §5-4/§5-5/§9(决策 22)、plan C1                    |
| §7 变更 3 对 claude 语义相反（会静默收缩工具面）           | **claude 系统面不注入 permission**                              | proposal §5-3/§9(决策 23)、design §7-1b                    |

### 10.2 结构性 findings

| finding                                                                                                  | 落点                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| P1-1 `AgentSpawnContext` 漏 prompt/persona/memory/每-dependent profile/resumeSessionId/boundaryHostProbe | §2.1 逐字段补齐 + 互斥断言保留                       |
| P1-2 `AgentInjectionSpec.skills` 装不下 staging 载荷                                                     | §2.3 拓宽为 `ResolvedSkill[]`，登记 §7-8             |
| P1-3 二进制自解析会破 `(protocol,binary)` 冻结不变量                                                     | §2.1 `runtimeBinary` 保留 + 决策 17 射程收窄         |
| P1-5/A3 依赖 B3 产物（自检无表可校验）                                                                   | plan A3 同批建表、值照抄现状                         |
| P1-6 §7 清单漏登记 4 项                                                                                  | §7 补 7/8/9/10 行                                    |
| P1-7 规则表死条目（skills 无 enabled 列）                                                                | §2.4 键集收缩 + `'not-modeled'` 单独报告             |
| P1-7(第二路) `wantsInventory` 守卫丢失 → followup 噪声回归                                               | §2.2 `observationRequiresFreshRun` + switch 前置守卫 |
| P1-8 ESLint 新增 config 对象会静默关掉既有跨包禁令                                                       | §4.2 顶部硬约束 + 新旧双变异实证                     |
| P1-9 例外清单形态/棘轮/先涨后落/访问机制                                                                 | §4.2 三元组 + staleIgnores + 明写不加 barrel         |
| P1-9(第一路) 声明同源在测试台兑现不了 + `buildPlan` 逃生舱四守卫全拦不住                                 | §2.1b 契约收窄 + 声明回传                            |
| P1-10 §2.5 与 §2.1 自相矛盾                                                                              | §2.5 表格改「构造留 driver」，ctx 只传 `taskMounts`  |
| P1-4(第二路) C3 会静默打断单二进制构建                                                                   | §9 复核项 4 换对拍面 + plan C3 同步编辑清单          |
| P2-1 `DRIVERS` 抛错会把只读页变 500                                                                      | 决策 13 限定「只在执行路径抛」                       |
| P2-4 `RuntimeCapabilities` 与既有 `DeclaredRuntimeCapabilities` 撞名                                     | §2.2 改名 `RuntimeDriverCapabilities`                |
| P2-4 `SpawnPlan` 漏现存字段                                                                              | §2.1 补 `declaredMcpServers` / `diagnostics`         |
| P2-6 并发碰撞（scheduler.ts 91 commits/30d）                                                             | plan：D 批优先、B1 拆三提交、每批 pin worktree       |
| P2-7 `ProbeOpts` 会成 claude→opencode 跨边                                                               | §4.2 访问机制段 + plan C3 前置                       |
| P1-1(第二路)/P2-8 audit-backlog 交叉                                                                     | plan E1 文档面补 audit-backlog                       |
| P2-9 E1「死代码清理」不是纯删                                                                            | plan E1 拆两条                                       |
| P2-5 验收标准不可机械验证                                                                                | plan 验收清单改可核对形式                            |
