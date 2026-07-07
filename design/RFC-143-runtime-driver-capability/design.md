# RFC-143 — 技术设计

> 现状测绘的完整 22 处旁路表 / 六类能力矩阵 / 三自由函数签名见 §2；接口设计见 §3；业务 spawn 收口（核心难点）见 §4；派生清理见 §5；失败模式 §6；测试策略 §7。所有 file:line 为 2026-07-07 快照，落地前逐项复核。

## 1. 设计原则

1. **能力内聚，判别归零**：每一处 `runtime === 'xxx'` 分支背后都是一种「能力差异」。把差异搬进 `RuntimeDriver`，调用点只「调方法 / 查字段」，不再知道 kind。driver 实现**内部**允许 kind 分支（那是能力本体）。
2. **收口 ≠ 重写**：opencode 的 spawn 输出被 `runtime-opencode-golden.test.ts` byte-for-byte 锁死。收口把 runner 的 `if/else` 分支体**整块搬进 `driver.buildBusinessSpawn`**，driver 内部仍调既有 `buildOpencodeSpawn` / `buildClaudeSpawn`——同参数 → 同输出 → golden 锁天然绿。这是「换组织方式，不换行为」。
3. **能力表达用混合机制**：
   - **optional 方法（null-object）** 表达「有/无」能力，消灭调用点的 if——`driver.startLiveCapture?.(ctx) ?? NOOP_HANDLE`、`driver.readInventory?.(ctx) ?? null`。claude 不实现 → 天然跳过。
   - **必需方法** 表达「两 runtime 各有一套实现」——`probe` / `listModels` / `captureSessions` / `buildBusinessSpawn` / `defaultBinary`。
   - **只读字段** 表达纯数据——`minVersion`。
   - **能力完全内化**：凭据桥不暴露成 capability——claude driver 的 `buildBusinessSpawn` 内部自己决定要不要 bridge（它知道自己是 claude + 是否 mock 环境）。runner 不再感知 `bridgeCredentials`。
4. **派生单源**：运行时集合（`RUNTIME_PROTOCOLS` / `BUILTIN_NAMES` / `ProtocolSchema`）从 `DRIVERS` 的 keys 派生，不再各处硬编码 `'opencode' || 'claude-code'`。

## 2. 现状测绘（浓缩）

### 2.1 二十二处旁路（按收口去向归类）

| 去向 | 旁路点 file:line | 现判别 |
|---|---|---|
| **buildBusinessSpawn**（业务 spawn） | `runner.ts:830`（claude vs opencode 主分支） | `if (runtime === 'claude-code')` |
| **buildSmokeSpawn**（或复用 business） | `runtimeSmoke.ts:99-128`（近乎重写 spawn）；`:139` 已持 driver 却只用 parseEvent | `if (protocol === 'claude-code')` |
| **readInventory?**（optional，opencode） | `runner.ts:536-540`（注入）+ `:1500-1504`（回读） | `runtime === 'opencode'` |
| **startLiveCapture?**（optional，opencode） | `runner.ts:1110-1146`（**无 gate 空转 bug**） | 无 gate，无条件启动 |
| **captureSessions**（必需） | `runner.ts:1455-1486` | `if (runtime === 'claude-code')` |
| **凭据桥内化进 claude driver** | `runner.ts:856-857` + `memoryDistiller.ts:938` | `runtimeCmd === undefined` / `protocol === 'claude-code'` |
| **defaultBinary**（必需，消 2 拷贝） | `runtimeRegistry.ts:234-242` + `routes/runtimes.ts:74-84` | `protocol === 'opencode' ? opencodePath : claudeCodePath` |
| **probe**（必需） | `routes/runtimes.ts:129-132` + `cli/start.ts:77-103,134-149` + `cli/doctor.ts` | `protocol === 'opencode' ? probeOpencode : probeClaudeCode` |
| **listModels**（必需） | `routes/runtime.ts:35-53` | `isClaude ? listClaudeModels : listOpencodeModels` |
| **defaultBinary + env override 内化** | `memoryDistiller.ts:925-927` | `protocol === 'opencode' ? AGENT_WORKFLOW_OPENCODE_BIN : null` |
| **派生清理：kind 集合单源** | `runtimeRegistry.ts:171`（旁路 `BUILTIN_NAMES`）+ `nodeRunMint.ts:307,373` | 硬编码 `n === 'opencode' \|\| n === 'claude-code'` |
| **派生清理：半死代码** | `runtimeRegistry.ts:204-227`（legacyModel 硬编码 opencode）+ `runtime/index.ts:32`（resolveRuntime 三元） | — |
| **dedup：resolveOpencodeCmd 5 拷贝** | `routes/{tasks:91,clarify:48,taskQuestions:39,reviews:135,fusions:33}.ts` | 逐字复制的 opencode-only 命令解析 |

### 2.2 三个自由函数当前签名（收口目标签名见 §3）

- **probe**：`probeOpencode(path?, opts?): Promise<OpencodeProbe>`（`util/opencode.ts:73`）/ `probeClaudeCode(path?, opts?): Promise<ClaudeProbe>`（`claudeCode/probe.ts:39`）。形态几乎逐字相同（`extractVersion` 同名正则 + `compareSemver` + MIN gate，两文件各一份重复）；claude 多 `apiKeySource?`。MIN 常量分处（opencode `'1.14.0'` `util/opencode.ts:22`；claude `'2.0.0'` `claudeCode/probe.ts:16`）。
- **listModels**：`listOpencodeModels(binary, opts?): Promise<...>`（`util/opencode-models.ts:77`，CLI `<bin> models --verbose`，binary-keyed in-memory cache）/ `listClaudeModels(): RuntimeModel[]`（`claudeCode/models.ts:24`，8 条静态表，同步无参无 cache）。**签名不对称**。
- **captureSessions**：`captureChildSessions({rootSessionId,nodeRunId,taskId,db,log,alreadyInsertedPartIds})`（`sessionCapture.ts:176`，opencode SQLite BFS）/ `captureClaudeSessions({...,configDir,worktreePath})`（`claudeCode/sessionCapture.ts:38`，JSONL 文件）。ctx 高度一致，可并集。live poll `startLiveSubagentCapture(opts): LivePollerHandle`（`subagentLiveCapture.ts:102`，opencode 专属，`pollMs=0` 返回 `NOOP_HANDLE`）。

## 3. 目标接口

`services/runtime/types.ts` 的 `RuntimeDriver` 扩展为完整能力对象（既有 `kind`/`parseEvent`/`buildSpawn`〔system-agent〕保留）：

```ts
export interface RuntimeDriver {
  readonly kind: RuntimeKind
  /** 该 runtime 二进制的最低兼容版本（probe gate 用）。 */
  readonly minVersion: string

  // —— 既有（保留）——
  parseEvent(line: string): NormalizedEvent | null
  buildSpawn(ctx: SystemAgentSpawnContext): SpawnPlan   // system-agent（distiller/commit/fusion）

  // —— 必需（两 runtime 各一套实现）——
  /** 业务节点 spawn：driver 内部完成本 runtime 的全部组装（opencode inline-config 构建+
   *  inventory/memory mutate+序列化；claude system-prompt-file+mcp/agents flags）。 */
  buildBusinessSpawn(ctx: BusinessNodeSpawnContext): SpawnPlan
  /** 默认二进制头：读 config 的 per-runtime path，回退到内建名。消 default-binary 2 拷贝。 */
  defaultBinary(config: Config): string[]
  /** 版本探测。RuntimeProbe 已在 types.ts:88（加可选 apiKeySource）。 */
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe>
  /** 模型列表（统一异步签名；claude 忽略 binary、恒 cached:true）。 */
  listModels(binary: string, opts?: ListModelsOpts): Promise<RuntimeModelList>
  /** run 后子代理会话捕获（并集 ctx，各取所需）。 */
  captureSessions(ctx: SessionCaptureContext): Promise<void>

  // —— optional（null-object 表达「有/无」能力，消灭 runner 的 if）——
  /** opencode 专属：run 期把 inventory dump plugin 注入 spawn（返回 outPath 供回读）。
   *  claude 不实现 → runner 跳过整段。实际注入内化进 buildBusinessSpawn，此方法只
   *  暴露「本 runtime 是否产 inventory」+ 回读位置。 */
  readInventory?(ctx: { runRoot: string }): Promise<InventorySnapshot | null>
  /** opencode 专属：run 期 live 轮询子代理 SQLite。claude 不实现 →
   *  runner: `driver.startLiveCapture?.(ctx) ?? NOOP_HANDLE`（天然消除空转 bug）。 */
  startLiveCapture?(ctx: LiveCaptureContext): LivePollerHandle
}
```

`DRIVERS` 注册表（`runtime/index.ts:35`）不变，仍是唯一注册点。新增 runtime = 新 driver 目录 + 表加一行 + widen `RuntimeKind` union（类型系统强制补全 `DRIVERS`）。

### runner 收口后（业务 spawn 段示意）

```ts
const driver = getRuntimeDriver(runtime)              // 已有
const plan = driver.buildBusinessSpawn(ctx)           // 消 runner.ts:830 if/else
// ... spawn（generic）...
const livePoller = driver.startLiveCapture?.(liveCtx) ?? NOOP_HANDLE   // 消空转 bug
// ... run（generic）...
const inventory = (await driver.readInventory?.({ runRoot })) ?? null  // 消 :539/:1503
await driver.captureSessions(captureCtx)              // 消 :1457
```

全段零 `runtime === xxx`。

## 4. 业务节点 spawn 收口（核心难点）

### 4.1 为什么难

`runner.ts:825-876` 两侧原材料形态从根不同（proposal 已述）：opencode 是「`buildInlineConfig`（含每个 dependsOn 闭包成员各自 resolve 的 runtime profile，`runner.ts:497-521`）→ 就地 mutate 两次（RFC-029 追加 inventory plugin `:550`、RFC-041 追加 memory block 进 `agent[name].prompt` `:593`）→ `JSON.stringify` 成 `OPENCODE_CONFIG_CONTENT`」；claude 是「`bodyMd+memory` 写 system-prompt-file + `toClaudeMcpConfig`/`toClaudeAgents` 转 `--mcp-config`/`--agents` flag」。`SystemAgentSpawnContext` 刻意排除了这些复杂度，所以 RFC-117 只收了 system-agent。

### 4.2 收口策略：分支体整块下移，spawn 函数不动

**关键洞察**：golden 锁锁的是 `buildOpencodeSpawn` 的输出，不是 runner 的组织方式。收口 = 把 `runner.ts:830` 的两个分支体**整块搬进各自 driver 的 `buildBusinessSpawn`**，driver 内部**仍调用既有的 `buildOpencodeSpawn` / `buildClaudeSpawn` 自由函数**（不改它们）。同参数 → 同 argv/env → golden 锁 byte-for-byte 绿。

- **opencode driver.buildBusinessSpawn**：把 `buildInlineConfig` + inventory plugin 追加 + memory block 织入 + `JSON.stringify` + `buildOpencodeSpawn` 调用一并搬进来。runner 只传原材料（agent / dependents / mcps / plugins / skills / injectedMemoryBlock / inventoryOutPath 需求 / resumeSessionId / worktree / runDir / git identity / runtimeBinary / 测试 binary override）。
- **claude driver.buildBusinessSpawn**：把 system-prompt-file 组装 + `toClaudeMcpConfig`/`toClaudeAgents` + 凭据桥决策 + `buildClaudeSpawn` 调用搬进来。

### 4.3 BusinessNodeSpawnContext（并集，各 driver 取所需）

```ts
export interface BusinessNodeSpawnContext {
  agent: Agent
  prompt: string
  injectedMemoryBlock: string | null      // opencode append inline / claude weave system-prompt
  skills: ResolvedSkill[]
  mcps: Mcp[]
  dependents: Agent[]                      // dependsOn 闭包
  plugins: Plugin[]                        // opencode only（claude 忽略）
  runtimeParams?: { model?: string | null; /* ... */ }
  resumeSessionId?: string
  worktreePath: string
  runRoot: string                          // opencode: OPENCODE_CONFIG_DIR / claude: attempt dir
  gitUserName?: string | null
  gitUserEmail?: string | null
  runtimeBinary?: string                   // custom fork（RFC-112）
  testBinaryOverride?: string[]            // 收敛 opencodeCmd/runtimeCmd 双字段（见 §5）
  envelopeFollowup?: boolean               // inventory 跳过判据
  nodeKind?: string                        // isAgentRunKind 判据
  wantsInventory: boolean                  // runner 已算好（isAgentRunKind && !followup），driver 自决是否产
}
```

### 4.4 两处耦合点（design 明示）

1. **诊断日志**（`runner.ts:882-905`）：spawn 后 runner 读 `inlineConfig.agent[name]` 的 model/variant/temperature 打诊断日志。inline-config 构建搬进 driver 后 runner 拿不到 → `SpawnPlan` 加可选 `diagnostics?: Record<string, unknown>` 字段，driver 回传，runner 照打。opencode driver 填 model/variant/temperature/mcpKeys/pluginNames；claude driver 填 model/mcpKeys/agentNames。
2. **inventory outPath 跨期串联**：注入在 spawn 期、回读在 run 后。opencode driver 的 `buildBusinessSpawn` 把 outPath 固定为 `runRoot/inventory.json`（现状即如此，`runner.ts:551`），`readInventory?({ runRoot })` 读同一固定位置——无需 runner 存中间态。

### 4.5 smoke spawn（#8）

`runtimeSmoke.ts:99-128` 的 `buildSmokePlan` 是同一反模式的第二现场（自己搭 spawn，却已持 driver 只用 parseEvent）。收口方案：smoke 复用 `driver.buildSpawn`（system-agent 路径，smoke 本就是一个最小 persona 的 system-agent），或新增 `buildSmokeSpawn`。**倾向复用 buildSpawn**——smoke 的 persona/agent 名可组成 `SystemAgentSpawnContext`，避免新增方法。若 smoke 有 buildSpawn 容纳不了的特殊性（如 aw-smoke inline agent），再评估。

### 4.6 PR-4 实现笔记（2026-07-07 深读发现，fresh session 接手要点）

PR-1/2/3 落地后深读 runner 业务 spawn，暴露 §4.2「分支体整块下移」比初稿描述的更大——固化如下，避免 fresh session 重新踩坑：

**A. `buildInlineConfig` 生态必须 move，不能留 runner 让 driver import（否则模块环）**
- `buildInlineConfig`（`runner.ts:1682`）+ 三个 helper：`AW_GLOBAL_PERMISSION`（`runner.ts:1627`）、`buildInlineAgentEntry`（`runner.ts:1654`）、`buildInlineMcpEntry`（`runner.ts:1765`）+ 常量 `EMPTY_RUNTIME_PROFILE`（`runner.ts` 内，`:501` 引用）。
- driver import runner 会成环：`runner → runtime/index(getRuntimeDriver) → opencode/driver → runner`。所以这套 inline-config 组装要 **move 到 driver 能 import 的新文件**，建议 `runtime/opencode/inlineConfig.ts`（它不 import runtime/index，无环）。
- **外部消费者 ~11 个要改 import 路径**（现从 `@/services/runner` 引 buildInlineConfig/helpers）：`services/memoryInject.ts`、`runtime/opencode/spawn.ts`，以及 8+ 测试：`runner-build-inline-config-multi` / `runner-mcp-inject` / `runner-permission-inject(-e2e)` / `runner-plugin-inject` / `mcp-end-to-end` / `migration-0014-plugins` / `migration-0011-mcps` / `rfc099-prompt-isolation` / `fixtures/mock-opencode.ts`。这些测试**直接把 buildInlineConfig 当纯函数锁**——move 后行为必须逐字不变（它们是 move 的保护网）。

**B. `buildBusinessSpawn` 必须 async**
- inventory 注入是 async（`materializeInventoryPlugin`，`runner.ts:548`）→ opencode 的 buildBusinessSpawn 内部 await → 接口签名 `buildBusinessSpawn(ctx): Promise<SpawnPlan>`（claude 内部无 async 但签名对齐 async）。这与 §4.2/§4.3 的同步草案不同，以此为准。

**C. `paramsByAgent` 的 async resolve 留 runner（第二个环规避）**
- `runner.ts:500-512` 为每个 dependent 调 `resolveAgentRuntime(db, dep.runtime)`（async DB）构建 `paramsByAgent: Map<name, RuntimeProfile>`。若搬进 driver，driver→runtimeRegistry→runtime/index→driver 又一个环。
- **解法**：runner 保留这段 async resolve，把 `resolvedParamsByAgent` 作为 `BusinessNodeSpawnContext` 的字段传给 driver（同步消费）。§4.3 的 ctx 要**加 `resolvedParamsByAgent: ReadonlyMap<string, RuntimeProfile>`**。opencode driver 用它调 `buildInlineConfig(agent, resolvedParamsByAgent, dependents, mcps, plugins)`；claude driver 忽略（只用 root 的 `runtimeParams.model`）。

**D. memory 织入**（`runner.ts:576-600`）：`injectMemoryForRun` 两 runtime 共用（留 runner，产出 `injectedMemoryBlock` + `injectedSnapshot`——后者要回 runner 落 `injected_memories_json` 列，见 RFC-046）；**织入方式**搬进各 driver——opencode append 到 `inlineConfig.agent[name].prompt`（`:593`）、claude weave 进 system-prompt-file（`:831`）。ctx 传 `injectedMemoryBlock`。

**E. 收口后 runner 业务 spawn 段**（约 `:481-905`）：保留 `prepareSkills` + async `resolvedParamsByAgent` + `injectMemoryForRun`（拿 block/snapshot）；删掉 inlineConfig 构建（:491-520）、inventory 注入（:534-561）、memory 织入 mutate（:593）、spawn if/else（:830-876）；改为一次 `const plan = await driver.buildBusinessSpawn(ctx)`。诊断日志（:882-905）改读 `plan.diagnostics`（§4.4）。inventory 回读（PR-3 已收）保持 `driver.readInventory?`。

**F. 已完成现状（PR-1/2/3，接手前 git log 确认）**：driver 已有 `minVersion`/`probe`/`listModels`/`captureSessions`/`defaultBinary`（必需）+ `readInventory?`/`startLiveCapture?`（optional）；`RUNTIME_KINDS`/`isKnownRuntimeKind` 已从 DRIVERS 派生；`resolveRuntime`/`runtimeHead` 半死代码已删。runner 只剩 **2 处** runtime 判别：业务 spawn（`:830`）+ inventory 注入（`:~539`，随 buildBusinessSpawn 搬迁）。`rfc143-runtime-driver-capability.test.ts` 已有派生锁 + 能力锁 + 空转锁 + mock driver 骨架——PR-4 完成后把 mock 骨架扩成「注册进 DRIVERS + 跑通 buildBusinessSpawn，零调用点改动」的完整集成证明（proposal 验收标准 4），并加旁路清零源码锁（T19）。

**G. golden 保护（验收硬约束）**：`runtime-opencode-golden.test.ts` 锁 `buildOpencodeSpawn` 输出。opencode driver.buildBusinessSpawn 内部调 buildOpencodeSpawn 时，传入的 `{opencodeCmd, agentName, prompt, resumeSessionId, worktreePath, runDir, inlineConfigSerialized, inventoryOutPath, gitUserName, gitUserEmail}` 必须与收口前 runner:861 完全一致 → 输出 byte-for-byte 不变。先跑基线绿，收口后逐字对拍。`runtime-buildspawn.test.ts`（system-agent）+ `memory-distiller.test.ts:633` 源码文本锁（getRuntimeDriver+buildSpawn）按需同步。

### 4.7 PR-4 落地勘误（2026-07-07 实现后固化，以此为准）

1. **§4.3/§5 的 `testBinaryOverride` 单字段收敛不可行，ctx 保留双字段**。实测 `opencodeCmd` 是**生产字段**（routes×5 经 `resolveOpencodeCmd(config.opencodePath)` 对所有 runtime 的 dispatch 无差别传入，claude 节点也会收到），`runtimeCmd` 才是纯测试字段。若合并成单字段：claude driver 要么吃到 opencode 的生产路径当自己的 argv 头（Codex P1-1 复活），要么因字段恒存在而永关凭据桥（bridge gate 依赖 `runtimeCmd === undefined`）。落地形态：`BusinessNodeSpawnContext` 同时带 `opencodeCmd?`（opencode 专属，其他 driver 必须忽略）+ `runtimeCmd?`（test-only，presence = mock 信号），runner 双双透传、零判别，各 driver 各取所需。真正的单字段收敛依赖 PR-5 把 launch 线程改为 per-runtime 解析（`driver.defaultBinary`）后再评估。
2. **smoke 收口落地**：`buildSmokePlan` 全体走 `driver.buildSpawn`，`runDir=attemptDir`（mkdtemp 已存在 → 满足 opencode 1.17 「OPENCODE_CONFIG_DIR 必须先存在」契约，协议特定的 `.opencode` 子目录形状对 smoke 不承载语义——与 distiller `runDir=cwd` 同形）。三个有意的行为对齐：opencode smoke 的 persona 统一为 claude 侧长句（`…Follow the user prompt exactly.`）；opencode smoke 现在会把 `model` 注入 inline config（修「opencode 探针忽略配置 model」的疏漏，probe 语义与 claude 对齐）；`SystemAgentSpawnContext` 增加可选 `log`（claude driver 转发给 buildClaudeSpawn，保 smoke 的 logger 上下文）。
3. **memoryDistiller 两处判别的收口方式**：`AGENT_WORKFLOW_OPENCODE_BIN` env 覆盖内化进 **opencode driver 的 buildSpawn**（无显式 binary 时的回退；语义从「distiller 专属」扩为「system-agent 通用」——smoke 恒传 binaryPath 不受影响，distiller 行为逐字不变）；`bridgeCredentials: true` 改为**无条件传**（opencode driver 忽略该字段，null-object 消判别）。
4. **buildBusinessSpawn 抛错处置落地**（§6 设计的实现）：runner 对 `await driver.buildBusinessSpawn(ctx)` 包同款 `runtime-spawn-failed` catch——收口前 buildClaudeSpawn 的同步 throw 会把行卡死在 running，现在干净落 failed（顺带修的行为改进）。
5. **源码文本锁随定义点搬迁**：runner-plugin-inject / runner-permission-inject / runner-mcp-inject 三处锁改读 `runtime/opencode/inlineConfig.ts`；runner-inventory-integration 的 materialize/outPath 锁改读 `runtime/opencode/driver.ts`（runner 侧改锁 `isAgentRunKind`+`wantsInventory` 业务门）。断言内容不变，只跟定义点走。
6. **诊断字段两 runtime 同形**：收口前 runner 对 claude 也从（无条件构建的）inline config 派生 `inlineModel/inlineVariant/inlineTemperature/mcpCount/mcpKeys/pluginCount/pluginNames` 日志字段——claude driver 的 `diagnostics` 按同公式回传（含 plugin 字段，尽管 claude 忽略 plugins），日志行 byte 级同形。§4.4 初稿的「claude 填 model/mcpKeys/agentNames」不准确，以此为准。
7. **claude 运行不再空跑 inline-config 构建**：收口前 runner 对 claude 也构建（然后丢弃）opencode inline config，`inline-config-large` 警告因此可能对 claude 误发——收口后该构建只存在于 opencode driver 内，claude 自然消失（无害的顺带清理；`resolvedParamsByAgent` 的 async 解析仍 runtime 无关地留在 runner，claude 依赖它取 root model）。

## 5. 派生清理（dedup + 半死代码）

| 项 | 现状 | 收口 |
|---|---|---|
| kind 集合单源 | `runtimeRegistry.ts:171`/`nodeRunMint.ts:307,373` 硬编码 `'opencode' \|\| 'claude-code'` | 改 `isKnownRuntimeKind(k)`（基于 `RUNTIME_PROTOCOLS`，从 `DRIVERS` 派生）；`runtimeRegistry:171` 改用同文件已存在的 `BUILTIN_NAMES` |
| ProtocolSchema | `routes/runtimes.ts:28` `z.enum([...])` 硬编码 | 从 `Object.keys(DRIVERS)` 派生 |
| default-binary 2 拷贝 | `runtimeRegistry:239`+`routes/runtimes:80` | 统一 `driver.defaultBinary(config)`（连带消 `runtimeHead`） |
| probe util 重复 | `extractVersion`/`compareSemver` 两文件各一份 | 提到 `util/semver.ts`（或 `util/opencode.ts` 现址）单份，两 driver import |
| resolveOpencodeCmd 5 拷贝 | `routes/{tasks,clarify,taskQuestions,reviews,fusions}.ts` 逐字 | 抽单一 `resolveOpencodeCmd`（或让 launch 走 `driver.defaultBinary`）；claude 无对应，opencode-only launch thread 保留语义 |
| opencodeCmd/runtimeCmd 双字段 | `runner.ts:843` vs `:865` fallback 字段不同 | 收敛成单一 `testBinaryOverride`（`BusinessNodeSpawnContext` 字段），driver 决定默认 head |
| resolveRuntime 半死三元 | `runtime/index.ts:32` 生产无调用者 | 确认（rg 生产引用）后删；仅 `runtime-resolve.test.ts` 引用则测试同步 |
| resolveInternalAgentRuntime legacyModel | `runtimeRegistry.ts:217-225` 硬编码 opencode 半死分支 | 确认无活数据（`assertConfigDefaultsMigrated` 已强制迁移）后删；有则显式标 opencode-only |

## 6. 失败模式

- **未知 frozen runtime kind**：`nodeRunMint` 现状 fail-closed（返回 null / re-resolve）——收口改查 `RUNTIME_PROTOCOLS` 后语义不变。
- **driver 方法抛错**：`probe`/`listModels` 失败 → 现有降级路径（probe gate warn/exit、models 空表）保持；`buildBusinessSpawn` 抛错 → runNode 现有 `trySpawn` catch（`runner.ts:929`）标 failed + `plan.cleanup?.()`。
- **optional 方法未实现**：null-object 兜底——`startLiveCapture?` 缺 → `NOOP_HANDLE`（post-run capture 的 `alreadyInsertedPartIds` 为空 Map，走 byte-for-byte 全量 BFS）；`readInventory?` 缺 → `null`（Outputs tab 无 inventory，现状 claude 即如此）。
- **golden 锁红**：任何使 opencode argv/env 变化的收口都会让 `runtime-opencode-golden` 红——这是**期望的保护网**，红即回滚该处收口重做（§4.2 策略保证不红）。
- **binary 模块环**：本 RFC 触 shared 导出（RUNTIME_PROTOCOLS 派生）+ runtime 模块重组——`build:binary` 可能暴露 typecheck/bun:test 漏掉的 init-cycle（memory `reference_binary_build_module_cycle`）。每 PR 必跑 binary smoke。

## 7. 测试策略

### 保护网（保持绿 / 按需同步）

- `runtime-opencode-golden.test.ts` — opencode 业务 spawn byte-for-byte，**必须逐字绿**（§4.2 验收硬约束）。
- `runtime-buildspawn.test.ts` — system-agent `buildSpawn` 契约；若 smoke 复用 buildSpawn 或 ctx 微调，同步。
- `runtime-spawn-head.test.ts` — `pickRuntimeHead`；收敛 opencodeCmd/runtimeCmd 双字段后同步。
- `runtime-resolve.test.ts` — `resolveRuntime`+`getRuntimeDriver`；删半死 resolveRuntime 则同步。
- `memory-distiller.test.ts:633-634` — 源码文本锁 `getRuntimeDriver`+`buildSpawn`；重构 buildSpawn 命名/路径则同步。
- `runner-inventory-integration.test.ts:293` — inventory 经 spawn 线程 outPath；readInventory 收口后验证注入/回读仍工作。

### 新增（本 RFC 的验收锁）

1. **mock driver 集成测试**（验收标准 4）：定义第三个 `RuntimeDriver`（`kind: 'mock'`，实现全部能力方法），注册进一个测试用 DRIVERS，跑通 buildBusinessSpawn + probe + listModels + captureSessions + startLiveCapture 一条集成路径，断言 runner/routes/cli 源码零 diff。这是「注册即扩展」的编译期+测试期证明。
2. **live poller 空转回归**：claude runtime 的 runNode 断言 `startLiveSubagentCapture` 未被调用（或 opencode SQLite `resolveOpencodeDbPath` 零 open）——锁死空转 bug 不复发。
3. **旁路清零源码文本锁**：`rg` 断言 `packages/backend/src`（排除 `runtime/` driver 实现 + tests）无 `runtime === 'claude-code'|'opencode'` / `protocol === 'opencode'|'claude-code'` / `isClaude`。
4. **派生单源源码锁**：`RUNTIME_PROTOCOLS`/`BUILTIN_NAMES`/`ProtocolSchema` 从 `DRIVERS` 派生的断言；`nodeRunMint`/`runtimeRegistry` 无硬编码 `'opencode' || 'claude-code'` 字面量集合。
5. **能力方法单测迁移**：probe/listModels/captureSessions/defaultBinary 各自的现有单测迁移到「经 driver 调用」形态；probe util（extractVersion/compareSemver）单份的等价性测试。

### 门禁

typecheck×3 / lint / format / 后端 bun test 全量 / 前端 vitest / **binary smoke（必跑，模块环）** / CI；Codex 设计门（本文档）+ 实现门（每 PR）。
