# RFC-117 — 内部 framework agent 接入运行时选择(技术设计)

配套 `proposal.md`(决策 D1–D8)。本文给接口契约、数据流、与现有模块耦合点、失败模式、测试策略、**待对照实装确认项**。

---

## 0. 现状锚(读源码核实)

- `RuntimeDriver`(`runtime/types.ts:108`):当前仅 `kind` + `parseEvent`;`types.ts:10-11` 注释明写「a later slice adds `buildSpawn`」——**本 RFC 实现该 slice**。
- spawn 装配(均叶子模块):`buildOpencodeSpawn(ctx)→{cmd,env}`(`runtime/opencode/spawn.ts:99`)、`buildClaudeSpawn(ctx)→SpawnPlan`(`runtime/claudeCode/spawn.ts:62`)。runner 业务节点路径手写 `if (runtime==='claude-code') buildClaudeSpawn else buildOpencodeSpawn`(`runner.ts:795-876`)+ `buildInlineConfig`(`runner.ts:1657`,含 skills/mcp/inventory/RFC-029/041 in-place mutate)。
- `SpawnPlan`(`types.ts:80`):`{cmd, env, stdin?: {mode:'ignore'}|{mode:'pipe',data}, cleanup?}`。
- distiller:`defaultDistillerSpawn`(`memoryDistiller.ts:937`)自拼 `opencode run … --agent aw-memory-distiller --format json` + 自拼 env(PWD/OPENCODE_CONFIG_DIR/CONTENT)+ 自管超时;`parseDistillerOutput`(`745`)逐行 JSON.parse + `extractEventText`(`792`,**自承「Mirrors runner.ts::extractTextFromEvent」**)→ `extractLastEnvelope` → `candidates` port。inline config = `{agent:{'aw-memory-distiller':{prompt,model?}}}`(`1040`)。
- commit:`buildCommitAgent(model)`(`commitPush.ts:29`)现造 agent;`maybeRunCommitPush`(`scheduler.ts:979`)的 `genViaOpencode`→`runNode`(`1038`)**不传 runtime**;model 来自 `state.opts.commitPushModel`(`1005`)→ `buildCommitAgent(model)`(`1042`)。
- fusion:`aw-skill-merger` 是 `agents` 表 builtin agent(`fusion.ts:201` `createAgent(...,{builtin:true})`),走标准 agent-single 派发(`scheduler.ts:2398` 经 `resolveFrozenRuntime` `2391`);`startTask` 透传 `defaultRuntime`(`fusion.ts:473`);无 model config。
- 运行时解析:`resolveRuntimeByName(db,name)→{name,protocol,binaryPath,model,variant,...}`(`runtimeRegistry.ts:147`);`resolveFrozenRuntime`(`nodeRunMint.ts:255`)冻结 `(protocol,binary,params)` 进 `node_runs`;`resolveAgentRuntime(db,agentRuntime,defaultRuntime)` 优先级 `agentRuntime ?? defaultRuntime ?? 'opencode'`(`175`)。
- config:`memoryDistillModel`(`config.ts:143`)、`commitPushModel`(`config.ts:228`);`launchRuntimeConfig.ts:20` 把 `commitPushModel`→`commitPush.model`。
- RFC-104 锁:`agents.builtin`(`schema.ts:78`「read-only lock」)。**锁的精确写路径以实装 Read 为准**(`services/agent.ts` updateAgent / `routes/agents.ts` / `AgentForm.tsx`)。

## 1. 核心:`RuntimeDriver.buildSpawn` slice(PR-A,行为不变)

### 1.1 接口(`runtime/types.ts`)

新增面向**系统 agent**(无 skills/mcp/plugins/inventory/inline-config-mutate)的精简 spawn 上下文 + driver 方法:

```ts
export interface SystemAgentSpawnContext {
  agentName: string
  systemPrompt: string // persona(opencode→inline config.prompt;claude→--append-system-prompt-file)
  model?: string | null // 来自所选 runtime profile;null/'' → 运行时自选
  readonly?: boolean
  prompt: string // user prompt
  worktreePath: string // 子进程 cwd(distiller:一次性临时目录)
  runDir: string // 配置目录(opencode:OPENCODE_CONFIG_DIR;claude:attemptDir)
  resumeSessionId?: string
  gitUserName?: string | null
  gitUserEmail?: string | null
}
export interface RuntimeDriver {
  readonly kind: RuntimeKind
  parseEvent(line: string): NormalizedEvent | null
  buildSpawn(ctx: SystemAgentSpawnContext): SpawnPlan // 新增
}
```

### 1.2 opencode driver(`runtime/opencode/`)

`buildSpawn(ctx)`:就地构造**极简 inline config**(与 distiller 现状逐字等价)`JSON.stringify({agent:{[ctx.agentName]:{prompt:ctx.systemPrompt, ...(ctx.model? {model:ctx.model}:{})}}})`,调已有 `buildOpencodeSpawn({opencodeCmd:undefined, agentName, prompt, worktreePath, runDir, inlineConfigSerialized, gitUserName, gitUserEmail, resumeSessionId})` 得 `{cmd,env}`,返回 `{cmd, env, stdin:{mode:'ignore'}}`(opencode prompt 在 argv)。

### 1.3 claude driver(`runtime/claudeCode/`)

`buildSpawn(ctx)`:调已有 `buildClaudeSpawn({claudeCmd:undefined, prompt, systemPromptText:ctx.systemPrompt, model:ctx.model??undefined, readonly:ctx.readonly, attemptDir:ctx.runDir, worktreePath:ctx.worktreePath, resumeSessionId, gitUserName, gitUserEmail})` 直接返回其 `SpawnPlan`(已含 `stdin:{mode:'pipe',data:prompt}`)。

### 1.4 边界

- **不动 runner 业务节点路径**(`runner.ts:795-876` + `buildInlineConfig`)。它的 inline config 带 skills/mcp/inventory/mutate,与 system-agent buildSpawn 不同;切它会动 RFC-111/112 golden 断言。新 `buildSpawn` 首个且唯一消费者 = distiller(PR-B)。commit/fusion 走 runNode,不用它。
- `getRuntimeDriver(kind)`(`runtime/index.ts:41`)已存在,distiller 用它取 driver。

## 2. distiller 收编(PR-B)

### 2.1 runtime 解析

- config 加 `memoryDistillRuntime?: z.string().min(1).optional()`。
- `distillTick`(`memoryDistillScheduler.ts`,持有 db)解析:`const rt = await resolveAgentRuntime(db, memoryDistillRuntime, defaultRuntime)`(优先级 = 字段 ?? defaultRuntime ?? opencode),把 `{protocol, binaryPath, model}` 透传进 `runDistill` 的 options(distiller 不直接依赖 db 做 runtime 解析;`defaultRuntime` 从 `start.ts` thread,见 §4)。

### 2.2 spawn 改造

`defaultDistillerSpawn` 改签名收 `{protocol, runtimeBinary, model, userPrompt, systemPrompt, cwd, timeoutMs, resumeSessionId?}`:

- `const driver = getRuntimeDriver(protocol)`;`const plan = driver.buildSpawn({agentName:'aw-memory-distiller', systemPrompt:DISTILLER_SYSTEM_PROMPT, model, prompt:userPrompt, worktreePath:cwd, runDir:cwd})`。
- `Bun.spawn` 用 `plan.cmd` + `{...process.env, ...plan.env}` + `cwd`;**stdin**:`plan.stdin.mode==='pipe'` 则写入 `plan.stdin.data`(claude),否则 `'ignore'`(opencode)。保留 distiller 特有的临时目录(`mkdtemp`)+ 超时 SIGTERM。
- 二进制 head:opencode driver 内 `opencodeCmd` 默认 `['opencode']`;**自定义 fork** 的 `runtimeBinary` 需作为 head——`buildSpawn` 的 ctx 暂无 binary 字段,故 §1.1 的 `SystemAgentSpawnContext` 加可选 `runtimeBinary?: string`,driver 以 `[runtimeBinary]` 覆盖默认 head(对齐 `pickRuntimeHead` 语义)。`AGENT_WORKFLOW_OPENCODE_BIN` 兜底保留。

### 2.3 解析改造

`parseDistillerOutput(stdout, protocol)`:逐行 `const ev = getRuntimeDriver(protocol).parseEvent(line)`;`ev` 非 null → 收 `ev.text`;`ev` 为 null(非结构化)→ 把原始行当 raw text 并入(保留 mock 直吐 envelope 的测试路径)。其余(`extractLastEnvelope` + `candidates` port 提取 + JSON 解析)**不变**。**删除** `extractEventText`(`792`)。

### 2.4 model 迁移:废弃 `memoryDistillModel`(见 §5)。

## 3. commit 接入(PR-C)

- config 加 `commitPushRuntime?: ...`;经 `launchRuntimeConfig` thread 到 `SchedulerOptions.commitPushRuntime`(替换 `commitPushModel` 的 thread 路径)。
- `maybeRunCommitPush` 的 `genViaOpencode`:`runNode`(`scheduler.ts:1038`)前补 `const frozen = await resolveFrozenRuntime(db, sessionRunId, state.opts.commitPushRuntime ?? null, state.opts.defaultRuntime, null)`,把 `frozen.protocol/binary/params` 作为 `runtime/runtimeBinary/runtimeParams` 传给 runNode(对齐其余 3 派发点)。commit session 不续跑 → `inheritFrom=null`。
- `buildCommitAgent` **去 model 参数**:model 归 profile,runNode 从 `opts.runtimeParams` 取(RFC-113 后 runner 单源 = runtimeParams)。删 `scheduler.ts:1005` `const model = …` + `1042` 改 `buildCommitAgent()`。
  - **实装确认**:RFC-115 已 DROP `agents.model` 列,确认 `Agent` 类型是否仍有 `model` 字段(`commitPush.ts:50` `...(model?{model}:{})` 是否还能/需要存在);若类型已无,直接删该行。
- `opencodeCmd` 透传(`1063`):保留(测试 mock 用);生产 commit 走 frozen runtime 的 binary。claude runtime 下 mock 需对应 cmd——本 RFC 测试用注入/真实即可,生产无 override。
- model 迁移:废弃 `commitPushModel`(见 §5)。

## 4. fusion / skill-merger 接入(PR-D)

- 后端已合规(标准派发跟随 `defaultRuntime`、参数归 profile、无 model config)——**零后端 spawn 改动**。
- 唯一缺口:`aw-skill-merger`(builtin agent)受 RFC-104 read-only 锁,`runtime` 字段不可编辑。
- 改:**放开 builtin agent 的 `runtime` 字段编辑**(RFC-104 锁的窄例外;其余字段〔name/persona/outputs/permission/…〕仍锁)。用户经 `/agents` 给 `aw-skill-merger` 选 runtime profile;`fusion.ts:473` 透传 `defaultRuntime` 不变(agent.runtime 优先)。
- **实装首步 Read** 确认 RFC-104 锁实现(`services/agent.ts` updateAgent 守卫 / `routes/agents.ts` / `AgentForm.tsx` 对 builtin 的禁用),据此选最小放开点:理想是 updateAgent 对 builtin 仅允许 `runtime` 字段 patch、其余 reject。

## 5. model 迁移 + config 字段退役(PR-B/C,照 RFC-113 + RFC-115)

目标态:`memoryDistillModel`/`commitPushModel` 的旧值 → 一个 `{protocol:'opencode', model:旧值}` 的 runtime profile;`memoryDistillRuntime`/`commitPushRuntime` 指向它;旧 model 字段退役。

- **建/复用 profile**:照 RFC-113 `migrateAgentParamsToRuntimes` 的 `profileKey` 去重(`(protocol,binary,model,…)` 规范化)+ 命名(`opencode-N` 跳占用名、key 字典序赋号);可复用 `listRuntimes`/`createRuntime`/`runtimeProfileOf`(`runtimeRegistry.ts`)。若已有等价 opencode profile 则复用其 name,否则新建。
- **幂等**:旧值已迁/已退役则跳过。
- **fail-loud 守卫**:照 RFC-115 `assertConfigDefaultsMigrated`(`runtimeRegistry.ts:466`),启动时若检测到旧 model 字段仍有值但未迁移 → ABORT(防跳级丢值)。
- **裸态跳过**:旧 model 字段为空 → 不建 profile,distiller/commit 直接走 `*Runtime ?? defaultRuntime ?? opencode`(对齐 RFC-113「裸 agent 跳过」)。
- **待确认(实装首步 Read RFC-115 的 config 字段退役机制)**:RFC-115 删 6 个 config 字段时,是「改写用户 config 文件」还是「schema 去字段 + loadConfig strip + 迁移读 raw config」?`loadConfig` 对未知键是 strip 还是 passthrough?据此决定本 RFC 是改写 config 文件指向新 profile,还是先 backfill profile + schema 标 `@deprecated` 一版再删。**迁移必须能读到旧值**(走 raw config),不能因 schema 先删而读不到。

## 6. 前端(PR-E)

- 抽 `useRuntimesList()` hook,公共化 `AgentForm.tsx:73-84` 的 `GET /api/runtimes` query + claude 过滤 + 内置 fallback(dedup,settings 与 AgentForm 共用,符合 dedup 原则)。
- settings:`MemoryTab` 的 `memoryDistillModel`(`settings.tsx:585`)、`LimitsTab` 的 `commitPushModel`(`265`)两处 `<ModelSelect>` → runtime profile `<Select>`(`memoryDistillRuntime`/`commitPushRuntime`),复用 `Field`+`Select`(`components/`),含「继承全局默认」空值项。`useTabState` keys 增改。
- fusion/skill-merger:经 `/agents` 编辑(`AgentForm` runtime 选择器),无独立 settings 项。
- i18n:加 `*Runtime` label/hint(zh/en 对称);清理废弃的 `memoryDistillModel*`/`commitPushModel*` key。
- **前台 UI 一致性**:仅复用 `Select`/`Field`,不自写控件(CLAUDE.md 强制)。

## 7. 失败模式

- **claude 跑 distiller/commit**:persona 走 `--append-system-prompt-file`(`buildClaudeSpawn` 已支持);candidates envelope 协议 runtime-agnostic,claude `parseEvent`(`runtime/claudeCode/events.ts`)提取 assistant text → distiller 拼 buffer 取 envelope。**实装用真 claude 跑一次 V 验证**(envelope 能到 `extractLastEnvelope`)。
- **distiller stdin(claude)**:claude prompt 走 stdin pipe,`defaultDistillerSpawn` 须写 stdin 并 close(否则 claude 挂起)。测试覆盖。
- **buildSpawn 行为漂移**:opencode `buildSpawn` 内部调 `buildOpencodeSpawn`,inline config 与 distiller 现状逐字等价 → distiller 行为不变(golden);runner 业务节点不碰 buildSpawn → 其 golden 不动。
- **迁移丢值**:§5 fail-loud 守卫。
- **自定义 fork 二进制**:`SystemAgentSpawnContext.runtimeBinary` 作为 head(§2.2),distiller 也能用注册表里的自定义 opencode/claude fork。
- **silently-`[]` 回归**:distiller 解析换 `parseEvent` 后,opencode 事件形状(`{part:{type:'text',text}}` 等)必须仍被 `parseEvent` 提取——回归测试锁(`memoryDistiller.ts:796` 注释记载的历史 bug)。

## 8. 测试策略(CLAUDE.md test-with-every-change)

后端:

- **buildSpawn**:opencode driver → 极简 inline config + argv(`run … --agent … --format json`)+ `stdin:ignore`;claude driver → `claude -p --output-format stream-json` + system-prompt-file + `stdin:pipe`;`runtimeBinary` 覆盖 head。
- **distiller**:注入 fake spawn 断言 protocol→对应 driver 的 cmd;`parseDistillerOutput` 对 opencode(`{part:{type:'text'}}`)+ claude(stream-json) + mock 直吐 envelope 三形状都提取 `candidates`(**回归** silently-`[]`);stdin pipe(claude)写入。
- **commit**:`commitPushRuntime` 设了 → runNode 收到对应 runtime/params;留空 → 继承 `defaultRuntime`;全空 → opencode(回归「曾写死 opencode」修复)。
- **fusion**:builtin agent `runtime` 字段可 patch、其余字段 patch 仍 403(RFC-104 窄例外锁不破)。
- **迁移**:旧 model 非空 → 建/复用 opencode profile 并指向、旧字段退役;同值复用不新建;幂等(跑两次 DB/config 不变);未迁移丢值守卫触发。
- **源码层文本断言兜底**:`memoryDistiller.ts` 不再含自写 `extractEventText` / inline 事件 `JSON.parse`(锁收编不被 fork 回去)。

前端(vitest):`useRuntimesList`;settings 两个新 `Select` 渲染 + 保存(`findByRole`);留空=继承;源码断言 settings 不再用 `ModelSelect` for 这两项。

门禁:`typecheck×3 + backend bun test + 前端 vitest + format:check + lint + build:binary smoke`(buildSpawn 是 shared/leaf 导出,防 module-init cycle)+ Codex 设计/实现 gate。

## 9. Codex 设计 gate fold 记录

**2026-06-28 设计 gate（codex-cli read-only，`--base f7f36bd` 框住三件套 commit `1015803`）= CLEAN**：对 RFC-117 三件套设计**零 findings**（codex 调研了 `runtimeRegistry`/`agent`/`fusion`/`schema`/`start`/migrations 等核实设计与现有代码吻合）。

**顺带发现（非本 RFC 范围）**：因 `--base f7f36bd...HEAD` 区间含协作者并行 commit `e8c796c`（RFC-111/F6 给 agent 保存加 runtime 引用校验），codex 报 1 个 P2——`validateRuntimeReference`（`agent.ts:363`）对内置名 `opencode`/`claude-code` 在 seed 行缺失时误拒（`resolveRuntimeByName` 有 builtin fallback、校验却只查表）。**属协作者 `e8c796c` 代码、不在 RFC-117 范围**；与本 RFC PR-D（放开 builtin agent 选 runtime）弱相关（正常 seed 在时不触发），已转交协作者 / RFC-118 处理。PR-D 实装若需豁免内置名，须与协作者 agent.ts 改动协调（CLAUDE.md 多人协作冲突调和）。

### 实现关键调整（vs 落档设计）

- **D2 迁移改两阶段 deprecated fallback**（非立即物理迁移/写 config）：在多人共享树写 config 文件做迁移有并发风险，照 RFC-113→115 先例——`memoryDistillModel`/`commitPushModel` 转 `@deprecated` 保留，`resolveInternalAgentRuntime`（`runtimeRegistry.ts`）解析优先级 `runtimeName → deprecatedModel`（opencode + 该 model）`→ defaultRuntime`；物理删字段留后续清理 RFC。无写 config、无损、幂等、fail-safe。
- **D7 fusion 入口 /agents → settings**：`aw-skill-merger` 在 `/api/agents` 列表隐藏（RFC-101 `excludeBuiltinAgents`），经 /agents 编辑不可达；改为后端放开 builtin 的 **runtime-only PUT**（`routes/agents.ts`，admin via `requireResourceOwner`），前端经 settings 专门选择器按 name 编辑——该 settings UI 选择器留后续（后端已就绪 + 测试锁）。
- **PR-E 不改 AgentForm**：协作者并行 RFC-118 正改 `AgentForm`（disabled 过滤），为避交织，`useRuntimesList` 新建给 settings 用；AgentForm 复用该 hook 的 dedup 留后续。
- **协作并发**：`resolveInternalAgentRuntime` 因与 RFC-118 共享 `runtimeRegistry.ts`，被协作者 `8d1df44` 的 commit gate 一并带入库（commit-race，内容无损）；顺手修协作者 RFC-118 的前端测试回归（`runtime-claude-frontend` mock 漏 `enabled`，用户拍板）+ PR-B lint（unused import）+ distiller PWD 断言随收编更新。

（实现 gate 各 PR 复审后续在此追加。）
