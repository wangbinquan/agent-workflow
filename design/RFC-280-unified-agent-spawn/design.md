# RFC-280 · 技术设计

状态：Draft（v2 —— 已按 2026-08-11 Codex 设计门 7×P1 + 2×P2 findings 修订；
findings 原文见门禁记录，逐条落点在 §9）

## 1. 现状锚点（盘点结论，全部 file:line 可复核；设计门已逐条核实一致）

### 1.1 五条 spawn 链路

| 链路 | spawn 点 | plan 构建 | 运行目录 |
|------|---------|-----------|---------|
| 业务节点 | `runner.ts:958`（Bun.spawn, detached, cwd=任务 iso worktree） | `driver.buildBusinessSpawn`（`runner.ts:867`） | 任务 worktree + `runRoot=<appHome>/runs/<taskId>/<nodeRunId>` |
| 系统 agent | `systemAgentRun.ts:460` | `driver.buildSpawn`（`:428`）或 `opts.buildPlan` 逃生舱（`:423`） | `<scratchParent>/<name>/{worktree,run}` |
| MCP 测试台 | 经 systemAgentRun，plan 来自 `mcpRuntimeTest.ts:2497` `runtime.capability.buildSpawn`（`mcpTest` capability，`types.ts:449-461`） | `opencode/mcpTest.ts:8` / `claudeCode/mcpTest.ts:7` | `<appHome>/mcp-runtime-tests/<sessionId>/…/turns/<turnId>` |
| 冒烟探针 | `runtimeSmoke.ts:291`（自建 timeout/kill 链） | `runtimeSmoke.ts:200 buildSmokePlan` → `driver.buildSpawn` | OS tmpdir `aw-runtime-smoke-*` |
| 记忆蒸馏器 | `memoryDistiller.ts:1120`（自建骨架） | `memoryDistiller.ts:1105` → `driver.buildSpawn` | OS tmpdir `aw-distiller-*` |

业务节点的 6 个调用入口全在 scheduler：`scheduler.ts:1011`（workgroup host）/
`:1938`（commit-push）/ `:2826`（merge agent）/ `:5866`（DAG）/ `:7721`（shard）/
`:8149`（aggregator）。资源集合统一由 `scheduler.ts:9137 prepareNodeRunInjection` 解析，
其中含 RFC-223/228 的 **exact-identity 围栏**：不同 canonical id 共享 runtime name 时在
spawn 前直接 fail（`scheduler.ts:9216-9249` + `injectionIdentity.ts:34-63`，
`rfc223-pr6-injection-identity.test.ts:276-305` 双 runtime 锁定）。**本 RFC 保留该
fail-fast 语义原样不动**（设计门 P1-1：闭包内不同 id 同名 = 身份冲突，必须阻断，
不允许降级为"先见者赢 + 告警"；同一 id 重复引用可去重；disabled 行不参与冲突判定）。

### 1.2 平行的注入转换实现（收敛对象）

MCP（4 套）：`opencode/inlineConfig.ts:128 buildInlineMcpEntry`、
`claudeCode/inject.ts:17 toClaudeMcpConfig`、
`runtime/mcpTestExecutionMaterial.ts:23`（一次产两 runtime 形状 + 独有的
`SAFE_RUNTIME_KEY`/URL userinfo 校验）、以及 claude 业务=内联 JSON 字符串
（`claudeCode/driver.ts:288`）vs 测试台=写文件传路径（`claudeCode/mcpTest.ts:12-21`）
的同字段双义。

agent 定义（6 套）：`inlineConfig.ts:32 buildInlineAgentEntry`、
`opencode/driver.ts:104-110`（系统 agent 手搓）、`opencode/mcpTest.ts:17-33`（测试台手搓）、
`claudeCode/driver.ts:156-300`+`spawn.ts:108`（业务）、`claudeCode/driver.ts:129-155`
（系统 agent，恒 bypassPermissions）、`claudeCode/inject.ts:92 toClaudeAgents`（subagent
条目，自带另一套 permission 交集逻辑）。

skill（3 套）：`runtime/stageSkills.ts:53`、`claudeCode/config.ts:143`
（attachment 块）、`claudeCode/config.ts:198`（worktree 投影）。
plugin（2 套）：`opencode/pluginSpec.ts:37`、`opencode-plugin/index.ts
materializeInventoryPlugin`；claude 无面仅 warn（`claudeCode/driver.ts:212-221`）。

### 1.3 校验缺口

- `parseStartupInventory`（`types.ts:584`/`claudeCode/driver.ts:85`/`events.ts:142`）
  **零消费方**；`claudeCode/driver.ts:315-323` 注释声称的 proof 不存在。
- `declaredMcpServers` 仅 claude 业务产出（`claudeCode/driver.ts:294`）；
  `runner.ts:1155` 的门对 opencode 恒不成立；命中也仅
  `log.warn('runtime-declared-mcp-unusable')`（`runner.ts:1163-1169`）。
- disabled-MCP 引用在 `inlineConfig.ts:103` / `inject.ts:22` 静默 `continue`。
- 测试台链路（含 systemAgentRun）不消费任何 MCP/inventory 校验；opencode 测试台
  **不注入 inventory 插件**（`opencode/mcpTest.ts:17-45` 无 plugin/无
  `OPENCODE_AW_INVENTORY_OUT`），故即便接上校验也无观测源（P1-4 的 fail-open 面）。
- claude 丢弃 variant/temperature/steps/maxSteps 无告警（`claudeCode/driver.ts:305-307`
  仅 diagnostics）。

### 1.4 既有进程原语（P2-1：本 RFC 的复用底座，不另造）

`services/execution/managedProcess.ts` 已是中立进程原语：bounded pumps / PID receipt /
timeout+cancel / TERM→KILL / reap+drain（`:1-8`、`:167-193`），并锁定了
「先 cancel、后 timeout 不得重标为 timeout」等语义（`:253-313`）。
**统一执行器实现为它的 agent adapter**，必要的能力（stdin 投递、`beforeSpawn` seam、
捕获策略）以向后兼容方式扩展到 managedProcess 本体；进程可靠性的唯一 authority
是 managedProcess，agent 层不得复制计时器/kill 链。

## 2. 目标架构：三层收拢

```
┌─────────────────────────────────────────────────────────────┐
│ 调用方（不变）: scheduler×6 / intent / narrative / mcp 测试台│
│                / smoke / distiller                          │
└──────────────┬──────────────────────────────────────────────┘
               ▼
┌─ A. 注入装配层 services/execution/agentInjection.ts ────────┐
│  AgentInjectionSpec（DB 形状，runtime 无关）                 │
│    → driver.renderInjection()（唯一 per-runtime 渲染钩子）   │
│    → RenderedInjection { argv/env/相对路径文件/投影,         │
│         cleanup, declared: DeclaredManifest }               │
└──────────────┬──────────────────────────────────────────────┘
               ▼
┌─ B. 进程执行器 services/execution/agentProcess.ts ──────────┐
│  = managedProcess 的 agent adapter（P2-1）                   │
│  AgentProcessRequest → 目录准备 → beforeSpawn 门 → spawn     │
│   → pump(行回调 + bounded raw tail) → onSpawned 收据         │
│   → timeout→TERM→KILL → reap → (仅 reap 后) cleanup          │
│   → AgentProcessResult（typed outcome）                      │
└──────────────┬──────────────────────────────────────────────┘
               ▼
┌─ C. 启动验证层 services/execution/startupVerification.ts ───┐
│  verifyStartup(declared, observation) → StartupVerification │
│  观测三态 verified|unavailable|malformed；                   │
│  消费方语义: 业务=持久告警 / 测试台=fail / 其他=空即无事      │
└─────────────────────────────────────────────────────────────┘
```

### 2.1 A 层 — 注入装配

```ts
// runtime 无关的注入意图（全部字段可选，persona-only 系统 agent 也走同一形状）
interface AgentInjectionSpec {
  agent: { name: string; prompt: string; description?: string
           permission?: AgentPermission; outputs?: string[] }
  profile: RuntimeProfile                    // model/variant/temperature/steps/maxSteps/isSandbox/extraArgs
  dependents?: readonly Agent[]              // dependsOn 闭包（BFS，根除外）
  profileByAgent?: ReadonlyMap<string, RuntimeProfile>
  mcps?: readonly Mcp[]                      // 含 disabled 行——装配层显式分拣；
                                             // 不同 id 同名（enabled）→ 抛错（沿用 §1.1 fail-fast）
  skills?: readonly ResolvedSkill[]          // 既有公共输入类型（types.ts:36-52），非新造
  plugins?: readonly Plugin[]
  memoryBlock?: string | null
  inventoryPlugin?: boolean                  // RFC-029（opencode-only 能力；claude 渲染为 no-op）
}

interface DeclaredManifest {
  mcpServers: string[]                       // 实际注入的 enabled 集（同名冲突已在装配前 fail）
  skippedDisabledMcps: string[]              // 落差③：显式记录，不再静默
  skills: string[]
  subagents: string[]
  plugins: string[]                          // P1-5：声明注入的 plugin（claude 恒 []）
  tools: string[] | null                     // claude 显式 gate；opencode 为 null
  droppedParams: string[]                    // 落差④：claude 丢弃的 variant/temperature/...
  unsupported: string[]                      // 如 claude×plugin（renderer 声明"此面不存在"）
  unobservable: string[]                     // P1-5：注入了但该 runtime 无观测手段的面
}

interface RenderedInjection {
  argv: string[]                             // 追加到 spawn cmd 的片段
  env: Record<string, string>                // 合入 spawn env 的片段（precedence 见 §2.2）
  files: Array<{                             // P1-7：executor-owned attemptRoot 下的相对路径
    relativePath: string                     //   绝对路径 / `..` / symlink 逃逸 → B 层写前拒绝
    content: string
    secret: boolean                          //   true → 强制 0600 + O_EXCL 原子创建
  }>
  worktreeProjections?: WorktreeProjection[] // claude .claude/{skills,agents}，带 cleanup
  declared: DeclaredManifest
  cleanup(): Promise<void>
}
```

- 每类资源的「DB 形状 → 注入意图」逻辑（现 4 套 MCP / 6 套 agent / 3 套 skill）收敛到
  本层的**纯函数**；driver 只保留一个 `renderInjection(spec, ctx): RenderedInjection`
  钩子做 wire 渲染（opencode = inline-config JSON + env；claude = flags + 文件 + 投影）。
- **同名/身份约束不在本层新造**：`prepareNodeRunInjection` 的 exact-identity 围栏
  （§1.1）保持在 scheduler；装配层对「不同 id 同 enabled name」重复断言（防御非
  scheduler 调用方），断言失败 = 抛错走各链路的 spawn-failed 路径，**不去重**。
- MCP wire 形状以现业务实现为基准（opencode 含 `oauth`/`timeout`，schema 依据
  `opencode core/src/v1/config/mcp.ts:6-63` 已核对；claude 保持
  `{command,args,env}`/`{type:'http',url,headers}`）。
- **URL 内嵌凭据全部放行**（用户拍板 2026-08-11：「配凭据是个人选择」）：装配层不做
  userinfo 拒绝；测试台现有 `mcp-test-invalid-remote-url` 的 userinfo 分支随收编
  **删除**（能力扩张，见 proposal §7）。名字校验复用公共 `McpNameSchema`
  （`shared/schemas/mcp.ts:18-25`，与测试台 `SAFE_RUNTIME_KEY` 接受集合等价——设计门
  已证实无兼容破坏面），不再保留第二个正则。
- claude `--mcp-config` 统一为**写文件传路径**（消除内联 JSON 字符串双义；秘密移出
  argv）。文件按 `secret:true` 落在 attemptRoot 下（P1-7 契约），测试台保持
  per-turn 目录（`turns/<turnId>`），**凭据文件不跨 turn 留存**。

### 2.2 B 层 — 进程执行器（managedProcess 的 agent adapter）

P1-2 修订：契约必须完整表达五条链路的既有行为，定义如下。

```ts
interface AgentProcessRequest {
  cmd: string[]                              // 完整 argv（base command + 注入片段已合成）
  cwd: string
  env: Record<string, string>
  stdin: { mode: 'pipe'; data: string } | { mode: 'ignore' }   // claude prompt 走 pipe
  workdir:                                    // 目录策略
    | { kind: 'external'; path: string }                        // 业务：任务 worktree
    | { kind: 'scratch'; parent: string; name: string; retainOnSuccess: boolean }
  files: RenderedInjection['files']          // B 层负责 containment 检查后落盘
  beforeSpawn?: () => void | Promise<void>   // 测试台 turn 准入重验（mcpRuntimeTest.ts:2455）
  onSpawned?: (receipt: { pid: number; spawnedAt: number; spawnBinaryPath: string | null })
    => void | Promise<void>                  // PID 收据 fence（mcpRuntimeTest.ts:2532-2575）；
                                             // 抛错 → 进入 TERM→KILL→reap，结果为 'aborted'
  abortSignal?: AbortSignal
  timeoutMs: number
  termGraceMs?: number
  capture: {
    onLine?: (line: string) => void | Promise<void>   // 逐行回调（调用方自行落库/解析）
    rawTailBytes?: number                    // >0 → 结果含 bounded stdout tail
                                             //（distiller envelope 解析需完整输出：
                                             //  memoryDistiller.ts:254-261/1366-1375）
    stderrTailBytes?: number
  }
}

type AgentProcessOutcome =
  | 'ok' | 'nonzero-exit' | 'timeout' | 'aborted' | 'spawn-failed' | 'unreaped'
// 调用方在自己的域内映射：system agent 的 result-error（terminal is_error）由调用方
// 从行回调判定后叠加；smoke 的 auth-missing/network-blocked/stream-nonconforming
//（runtimeSmoke.ts:28-46）是 smoke 对 ok/nonzero-exit + 输出内容的再分类——
// B 层不吞并这些域，只保证进程级 outcome 准确。

interface AgentProcessResult {
  outcome: AgentProcessOutcome
  exitCode: number | null
  pid: number | null
  stdoutTail: string                         // capture.rawTailBytes>0 时有值
  stderrTail: string
  durationMs: number
  workdirPath: string
  workdirRetained: boolean
}
```

硬性语义（全部来自既有行为，测试锁定）：

1. **可靠性内核复用 managedProcess**（§1.4）：timeout/cancel 竞态（「先 cancel 后
   timeout 不得重标」）、bounded pipe drain、TERM→KILL、reap 全部由
   `runManagedProcess` 承担；agent adapter 只做目录/文件/回调/结果映射。
   managedProcess 缺 stdin 投递与 `beforeSpawn` seam 的，向后兼容扩展其本体。
2. **cleanup 只在 reap 完成后执行**，且只清理 attemptRoot，不清理共享 session root
   （P1-7；测试台 sessionRoot 由会话状态机负责，与今天一致）。
3. **env merge precedence**：调用方 base env（含 PWD 修正、config-dir 键、
   `OPENCODE_CONFIG_CONTENT`）在前，`RenderedInjection.env` 合入时**不得覆盖**保留键
   （`PWD` / config-dir 键 / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_PERMISSION` scrub
   语义沿用 `opencode/spawn.ts:160-227` 原样，作为 opencode renderer 的产出）。
4. **files containment**（P1-7）：落盘前逐项校验 relativePath 解析后仍在 attemptRoot
   内（复用 `systemAgentRun.ts:227-238 assertSafeSeedPath` 的既有判定），`secret:true`
   → `O_EXCL` + 0600；违规 = spawn-failed，不 spawn。

runner 收编原则：**进程级职责进 B 层，节点级职责留 runner**。runner 保留：节点池 /
lifecycle CAS / 重试与 pre_snapshot 回滚 / 端口与 envelope 校验 / merge-back /
session 捕获 / liveness / nodeRunEvents 落库（经 `capture.onLine`）。删除：自有 pump /
kill 链 / stdin 写入 / PID 记账（`runner.ts:958-1100` 一带）。

### 2.3 C 层 — 启动验证

P1-4/P1-5 修订：观测建模为**三态**，MCP 条目保留 runtime 原因，含 plugin 面。

```ts
type StartupObservation =
  | { state: 'verified'; source: 'claude-init' | 'opencode-inventory'
      mcpServers: Array<{ name: string; status: string; hint?: string }>
        // opencode 五态 connected/disabled/failed/needs_auth/needs_client_registration
        //（opencode mcp/index.ts:83-107）+ transcoder 的 error→hint（transcoder.ts:64-78）
        // 原样保留；claude init 为 connected/failed 二态。不压 boolean。
      tools?: string[]; agents?: string[]; skills?: string[]; plugins?: string[] }
  | { state: 'unavailable'; reason: string } // 插件未注入 / 文件缺失 / init 事件未出现
  | { state: 'malformed'; reason: string }   // 观测源存在但解析失败

interface StartupVerification {
  observation: StartupObservation['state']
  observationReason?: string
  mcpUnusable: Array<{ name: string; status: string; hint?: string }>
  skillsMissing: string[]
  subagentsMissing: string[]
  toolsMissing: string[]
  pluginsMissing: string[]                   // P1-5
}
// 持久化结构 = { declared: DeclaredManifest, observation: StartupObservation,
//                verification: StartupVerification }（P1-5：UI 要能重建
//                「没声明 / disabled / 声明未加载 / 无法观测」完整对照，
//                 declared.unobservable 的面标"无法验证"，绝不伪装为已验证）
```

- claude：`parseUnusableMcpServers`（既有）+ **接上 `parseStartupInventory`**
 （落差①）——init 事件一次产出 observation（行内即时可判）。
- opencode：RFC-029 inventory 插件已 dump `mcp.status()`+agents+skills+plugins
 （`aw-inventory-dump.mjs:122-155`、`shared/inventory.ts:56-82` 已含 status/hint 与
  plugins 数组——观测数据现成，只差消费）；`readInventory` 后置判定。
  `declaredMcpServers` 不再是 driver 私有字段，统一来自
  `RenderedInjection.declared`（落差②）。
- 消费语义：
  - **业务节点**：`node_runs` 新列 `startup_verification_json`（上述持久化结构），
    verification 有缺失项或 observation ≠ verified 时节点详情 NoticeBanner +
    任务列表节点标记；**不改变节点成败，验证器不得改写进程结果**。
    observation=unavailable 的告警文案是「无法验证」，不是「验证通过」。
  - **MCP 测试台**（P1-4 失败码优先级）：仅当进程结果为 `ok` 时验证结果才参与定败：
    `mcpUnusable` 非空 → `mcp-test-mcp-unusable`；observation=unavailable/malformed
    → `mcp-test-verification-unavailable`。timeout / 取消 / daemon-shutdown /
    unreaped 等 durable 结果**优先，不被覆盖**（`mcpRuntimeTest.ts:197-225` 的
    既有优先级保持）。测试台 spec **强制 `inventoryPlugin: true`**（opencode），
    使 fail-open 面（§1.3 第 4 条）结构性消失。
  - smoke / distiller / intent / narrative：declared 为空 → verification 恒空，零成本。

### 2.4 `mcpTest` capability 并回 RuntimeDriver（落差⑥）

`RuntimeMcpTestCapabilityV1.buildSpawn` 删除；测试台改走 A 层
（spec = 系统 persona + `mcps:[被测行]` + `inventoryPlugin:true`）+ B 层（workdir =
scratch，session 根下 per-turn attemptRoot，保持 `turns/<turnId>` 两级——P1-7）。
driver 仅保留测试台真正 runtime 特有的两点：`createNativeSessionId` /
`sessionReference`（并入 RuntimeDriver 可选方法）。测试台的 `beforeSpawn` 准入重验与
`onSpawned` PID 收据经 B 层的对应 seam 原样保留（P1-2）。`mcpRuntimeTest.ts` 的
会话状态机 / lease / 收据 / 事件 sink 全部不动。收编同时删除
`mcp-test-invalid-remote-url` 的 userinfo 分支（§2.1，用户拍板放行）。

## 3. 数据流（业务节点，统一后）

```
scheduler.prepareNodeRunInjection (不变，含 exact-identity fail-fast)
  → AgentInjectionSpec 组装 (runner 内)
  → driver.renderInjection → RenderedInjection{..., declared}
  → runner 合成 AgentProcessRequest（base cmd + stdin + env precedence + 回调）
  → runAgentProcess(request)   [= managedProcess adapter]
      ├─ capture.onLine → runner 落 nodeRunEvents / envelope 累积 / 行内观测捕获 (不变)
      └─ 行内(claude) 或 readInventory 后置(opencode) → verifyStartup(declared, obs)
  → runner 持久化 {declared, observation, verification} + 既有终态流程 (不变)
```

过渡期（plan T1–T6）：`driver.buildBusinessSpawn` **签名保留**，内部改为
「renderInjection + 本 driver 的 base-command 合成」的 adapter（P1-3——T1 可独立
落地且行为字节不变）；T7 runner 直接消费 A+B 层后才删除该接口。

## 4. 失败模式

| 失败 | 现状 | 统一后 |
|------|------|--------|
| 闭包内不同 id 同 enabled name | spawn 前 fail（`duplicate-name-in-closure`） | **保持 fail-fast 原样**（P1-1）；装配层重复断言防非 scheduler 调用方 |
| MCP 进程起不来（业务） | claude 仅日志 warn；opencode 无感 | 两 runtime 均落 `startup_verification_json`（含 status/hint 原因）+ UI banner；不改成败 |
| MCP 进程起不来（测试台） | turn“成功”，agent 口头找不到 | 进程 ok 时 → `mcp-test-mcp-unusable`；durable 失败码优先 |
| 观测源缺失/损坏（测试台） | 不存在观测 | `mcp-test-verification-unavailable`（P1-4：不 fail-open） |
| 观测源缺失/损坏（业务） | `captured:false` 存根 | observation=unavailable → 告警面注明「无法验证」 |
| 引用 disabled MCP | 静默 continue | declared.skippedDisabledMcps → 告警面 |
| claude 收到 variant/temperature | 静默丢弃 | declared.droppedParams → spawn 日志 warn + 告警面 |
| skill/subagent/plugin 未被 runtime 加载 | 无验证 | verification.{skillsMissing,subagentsMissing,pluginsMissing} → 告警面 |
| renderer files 越界 / 秘密文件无 0600 | 无契约 | B 层 containment + O_EXCL/0600 强制；违规 = spawn-failed（P1-7） |
| onSpawned 收据失败 | 测试台自有处理 | B 层定义：进入 TERM→KILL→reap，outcome='aborted'（P1-2） |
| cancel 与 timeout 竞态 | managedProcess 已锁「先 cancel 不得重标 timeout」 | 复用之（P2-1），agent 层不复制计时器 |

## 5. 兼容与迁移

- **argv/env 字节级兼容**是迁移的硬约束：A 层收敛以**现业务实现为 golden 基准**，
  既有 golden 测试必须不改断言通过；§7 列出的有意变更逐条改断言并在 commit message
  声明，**每条变更的 owning 任务在 plan.md「golden/source-lock 归属表」中指定**（P2-2）。
- 分 PR 推进（见 plan.md），每个 PR 独立全绿、独立可回滚；过渡采用
  **adapter 而非双轨**：旧接口签名保留、内部改走统一层（行为不变），最后一个消费方
  切换后同 PR 删除旧接口（P1-3）。
- DB 迁移：`node_runs` 加 `startup_verification_json TEXT NULL`（纯增量列，无 backfill）；
  `mcp_runtime_test_turns.failure_code` 新增 `mcp-test-mcp-unusable` /
  `mcp-test-verification-unavailable`（TEXT 列，无迁移；按 dev-gotchas「删枚举值」教训，
  新增码同时进入解析 union 与 i18n）。

## 6. 测试策略（Test-with-every-change）

1. **A 层纯函数矩阵**：每类资源 × 两 runtime × 边界（disabled / 同名冲突断言 / 空 /
   oauth / headers / userinfo URL 放行 / prototype-key 名）→ 渲染快照 + declared 断言。
   现 4 套 MCP 转换的既有测试聚拢为一套，**先以双实现对拍测试证明等价，再删旧实现**
   （同 PR）。同名 fail-fast 语义沿用 `rfc223-pr6-injection-identity.test.ts` 原断言
   不动，装配层断言另加用例。
2. **C 层纯函数**：declared × observation 差集判定全分支（三态 × 各资源面 ×
   unobservable 透传）。
3. **B 层**：以 managedProcess 既有测试为底（cancel/timeout 竞态、drain 语义不动），
   新增 adapter 面：stdin 投递、beforeSpawn 拒绝即不 spawn、onSpawned 抛错 →
   aborted、files containment（`..`/绝对路径/secret 0600/O_EXCL）、reap 后才 cleanup、
   workdir 两策略。
4. **行为变更回归锁**：测试台三个 fail 分支（unusable / verification-unavailable /
   durable 优先级不被覆盖）；业务告警列落库 + UI（frontend inline 测试）；disabled
   引用告警；claude droppedParams 告警；userinfo URL 在测试台放行（原拒绝分支删除的
   回归锁反转）。每个测试文件头注明锁定的 RFC-280 行为与两起故障背景。
5. **死代码防回归**：源码层断言 `parseStartupInventory` 在统一层有调用点。
6. **e2e**：mcp-runtime-playground 用例扩一条「MCP 起不来 → UI 显示 fail + 原因」。

## 7. 有意变更清单（golden/source-lock 影响面，owning 任务见 plan.md）

1. claude 业务路径 `--mcp-config`：内联 JSON 字符串 → 文件路径。
   受影响断言：`rfc143-business-spawn.test.ts:265-280`、
   `runtime-claude-e2e.test.ts:291-300`（`JSON.parse(argv[i])` → 改为断言 argv 为
   attemptRoot 内路径 + 文件内容/权限）。
2. opencode 系统 agent / 测试台 inline agent 条目：手搓 `{prompt,model}` →
   `buildInlineAgentEntry` 统一产出（多出 description/permission/options 字段，
   对 runtime 语义等价）。受影响断言：`runtime-buildspawn.test.ts:52-72`。
3. runner / distiller 源码 grep 锁（`opencode-spawn-pwd-env.test.ts:36-44/68-99`
   要求两文件直接存在 `Bun.spawn`/`buildSpawn` 字样）：收编后改锁统一执行器的
   `cwd/PWD/env` 契约（锁的意图——PWD 钉在 worktree——不变，锁的位置迁移）。
4. 测试台 remote MCP userinfo URL：拒绝 → 放行（用户拍板，能力扩张）。
   受影响断言：`mcpTestExecutionMaterial` 相关用例反转。

其余 argv/env 必须字节不变。

## 8. 与 RFC-243 的关系（设计门 P2-1 复核结论）

RFC-243 是任务层四原语（其 proposal.md:114-117 明确排除 system agent 与 MCP
playground），本 RFC 是进程层——边界成立，正交推进。两者共享
`services/execution/` 命名空间：RFC-243 的 Executor 面向 taskId，本 RFC 的
agentProcess 面向一次 spawn；managedProcess 是两者共同的进程可靠性底座。

## 9. 设计门 findings 落点索引

| finding | 落点 |
|---|---|
| P1-1 同名 fail-fast | §1.1、§2.1、§4 行 1、§6.1 |
| P1-2 spawn 契约不完整 | §2.2 全部、§4 行 11、§6.3 |
| P1-3 任务依赖缺口 | §3 过渡期、§5、plan.md T1/T3/T7 修订 |
| P1-4 测试台 fail-open + 失败码优先级 | §2.3 消费语义、§4 行 3-4 |
| P1-5 观测丢原因/丢 plugin | §2.3 结构、DeclaredManifest.plugins/unobservable |
| P1-6 URL userinfo | §2.1（用户拍板全放行）、§7.4、proposal §7 |
| P1-7 files 归属契约 | §2.1 files、§2.2 硬性语义 4、§2.4 |
| P2-1 managedProcess 复用 | §1.4、§2.2、§8 |
| P2-2 golden 归属 | §7、plan.md 归属表 |
