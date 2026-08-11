# RFC-282 · 技术设计

状态：Draft（待用户批准 → Codex 设计门）

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
  /** 进程 cwd（业务 = 任务 worktree；系统 = scratch worktree）。 */
  readonly cwd: string
  /** per-run 根 `<appHome>/runs/<taskId>/<nodeRunId>` 或系统面的 scratch run 目录。 */
  readonly runRoot: string
  readonly configDir: RuntimeConfigDirProfile
  readonly profile: RuntimeProfile
  /** RFC-281 边界的 runtime 无关部分；省略 = 不施加边界（系统面 v1 不套）。 */
  readonly boundary?: BoundaryCtx
  /** 调用方是否希望产出启动清单观测（driver 依自身能力决定是否兑现）。 */
  readonly wantsInventory: boolean
  /** 原生会话续接（测试台 / followup）。 */
  readonly nativeSessionId?: string | null
  /**
   * TEST-ONLY 二进制覆写（决策 17）。生产恒 undefined —— 二进制解析是 driver 的
   * 职责，调用链上不再有任何 runtime 专属参数。其 PRESENCE 同时是「不碰真实
   * 凭据桥」的信号（沿用既有 runtimeCmd 语义）。
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

### 2.2 显式能力声明（决策 14）

取代 `driver.readInventory !== undefined` 这个代理判据：

```ts
/** DeclaredManifest 的九个面 —— 新增面时此联合类型扩张，见 §4.4。 */
export type DeclarationFace =
  | 'mcpServers' | 'skills' | 'subagents' | 'plugins' | 'tools'
  | 'droppedParams' | 'skippedDisabledMcps' | 'unsupported' | 'unobservable'

export interface RuntimeCapabilities {
  /**
   * 启动清单观测源。runner 按此 switch（穷尽），第三个 runtime 必须显式表态
   * 而不是掉进 claude 分支（现状：runner.ts:1836 的 readInventory 有无二分）。
   */
  readonly startupObservation: 'inventory-file' | 'init-event' | 'none'
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
  | 'supported'     // 该 runtime 有这个面，且能观测验证
  | 'unsupported'   // 该 runtime 没有这个面（如 claude × plugin）
  | 'unobservable'  // 注入了但无观测手段（如 opencode × plugin 键域对不上）
```

runner 的消费从二分改为穷尽 switch：

```ts
switch (driver.capabilities.startupObservation) {
  case 'inventory-file': observation = observationFromInventory(...); break
  case 'init-event':     observation = observationFromClaudeInit(...); break
  case 'none':           observation = { state: 'unavailable', reason: 'runtime-has-no-observation' }
}
```

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

```ts
// services/execution/resourcePolicy.ts —— 「disabled 资源怎么办」的唯一可读点
export type DisabledDisposition = 'skip-and-declare' | 'fail-node'

/**
 * Record 穷尽 ⇒ 新增可注入资源类型时，不在此表态就编译报错（§4.4）。
 * RFC-282 决策 4：全部统一为 skip-and-declare（告警不失败）。
 * plugin 原为 fail-node（scheduler.ts:9262 `plugin-disabled`），本 RFC 改判并
 * 删除该错误码（决策 20，proposal §7 行为变更 1）。
 */
export const DISABLED_RESOURCE_POLICY: Readonly<
  Record<InjectableResourceKind, DisabledDisposition>
> = {
  mcp: 'skip-and-declare',
  plugin: 'skip-and-declare',
  skill: 'skip-and-declare',
  agent: 'skip-and-declare',
}
```

被跳过的项进 `DeclaredManifest.skippedDisabled*`，经 §1④ 的验证层落
`node_runs.startup_verification_json`，节点详情 banner 可见。**声明面因此从
`skippedDisabledMcps` 泛化为按资源类型分组**（wire 兼容处理见 §5）。

### 2.5 boundary 拆分（决策 10）

`services/execution/workspaceBoundary.ts` 拆为三处，**语义一字不改**：

| 内容 | 去处 | 理由 |
|---|---|---|
| `BoundaryCtx` / `resolveBoundaryMounts` / `opencodeDataDir` / `machineSkillRoots` | 留 `services/execution/workspaceBoundary.ts` | 「哪些目录算本任务工作区」是产品语义，runtime 无关 |
| `composeOpencodeBoundary`（`external_directory` 键序纪律） | `runtime/opencode/boundary.ts` | opencode 原生权限键的键序规则，是 opencode 专属知识 |
| `composeClaudeBoundarySettings` / `claudeExpressibleAuthorDirs` | `runtime/claudeCode/boundary.ts` | claude sandbox settings 的字段形状，是 claude 专属知识 |

`opencodeDataDir` / `machineSkillRoots` 看似 opencode 专属，但它们回答的是「哪些目录
必须放行否则误伤业务」——属 RFC-281 §0 的产品判断，且 claude 侧未来同样需要等价概念。
留在统一层，由 opencode 的合成消费。（此项在 Codex 设计门中重点复核。）

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

`eslint.config.js` 增 `no-restricted-imports` 分层规则：

```js
// packages/backend/src/**（除 services/runtime/**）
{ patterns: [{
    group: ['@/services/runtime/opencode/*', '@/services/runtime/claudeCode/*'],
    message: 'per-runtime 代码只能经 @/services/runtime（index/types）访问 —— RFC-282 §4.2',
}] }
```

存量违规逐条进 `RFC282_IMPORT_EXCEPTIONS` 清单（文件顶部常量 + 每条注明归属批次），
**清单归零 = 完工判据 1**。

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

| 失败 | 现状 | 归一后 |
|---|---|---|
| 引用 disabled plugin | 节点硬失败 `plugin-disabled` | 照常运行 + 声明告警（决策 4，行为变更） |
| 引用 disabled MCP / skill / agent | MCP 跳过告警；其余各异 | 全部 skip-and-declare（单一规则表） |
| 闭包内不同 id 同 enabled name | spawn 前 fail | **原样保留**（RFC-223/228 语义不变） |
| skill quarantine / 非 canonical path | throw → 任务级错误 | typed failure → 节点级归属（§2.3-1） |
| 未知 / 损坏的 runtime kind | 静默当 opencode 跑 | 显式报错（决策 13） |
| driver 漏实现某个声明面 | 静默空声明 | 启动自检拒绝启动（§4.3） |
| 新增资源类型漏了某 runtime | 运行时才发现 | 编译期报错（§4.4） |
| 有人在 driver 里再写一份转换 | 无人发现 | grep 锁 + ESLint 当场红（§4.1/4.2） |

## 7. 有意变更清单（golden / source-lock 影响面，owning 任务见 plan.md）

决策 16：接受等价变化，逐条改断言并在 commit message 声明。清单外的任何变化都是 bug。

| # | 变更 | 受影响断言 | owning |
|---|------|-----------|--------|
| 1 | 系统 agent inline 条目统一产出（多出 description/permission/options） | `runtime-buildspawn.test.ts` 系统面精确形状断言 | B1 |
| 2 | `plugin-disabled` 错误码删除 | scheduler 的 plugin-disabled 用例反转为「能跑 + 有告警」 | B3 |
| 3 | `opencodeCmd` 从调用链剔除 | 传参断言 / mock 注入姿势改走 `binaryOverride` | C1 |
| 4 | boundary 合成下沉各 driver | RFC-281 测试的 import 路径（**断言内容不改**） | C4 |
| 5 | `skippedDisabledMcps` → 按类型分组（保留旧字段） | startup-verification 形状断言扩展 | B3 |
| 6 | driver 三方法 → 单一 `buildSpawn` | `rfc143-runtime-driver-capability.test.ts` 接口面断言 | B1 |

其余 argv / env / 落库形状**必须字节不变**，由每批的对拍测试证明。

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

## 9. 待 Codex 设计门重点复核项

1. §2.5 `opencodeDataDir` / `machineSkillRoots` 留在统一层是否成立（它们含
   opencode 的路径知识，但回答的是产品级「不误伤」问题）。
2. §2.3-1 skill 门从 throw 改 typed failure 是否会改变既有失败归属（须逐条比对
   RFC-130/253 的 skill 失败用例）。
3. §5 `skippedDisabled` 分组的读端兼容是否覆盖存量行的全部形态。
4. 决策 19「每批都对拍」在纯移动批次（C3 的 1300 行搬迁）上如何具体兑现 —— 对拍
   什么？（当前设想：搬迁批次以「import 路径改写前后，模块导出面逐符号相等」为对拍面。）
5. 6 入口统一后，commit-push / merge 的 `resolveInjection` 调用是否引入新的 DB 往返，
   对 writeSem 内的 merge agent 是否有时序影响。
