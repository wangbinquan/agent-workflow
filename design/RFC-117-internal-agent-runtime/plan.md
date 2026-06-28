# RFC-117 — 任务分解与 PR 拆分

配套 `proposal.md` / `design.md`。5 PR;**A 先行(B 依赖);C / D 独立可并行;E 依赖 B+C 的 config 字段**。每 PR 独立测试绿。**本 RFC 零 DB migration**(config 是 JSON 文件;`runtimes` 表/`node_runs.runtime_params_json` 列均 RFC-112/113 已在;迁移只插数据行不改 schema)。

---

## PR-A — `RuntimeDriver.buildSpawn` slice(行为不变)

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T1** | `runtime/types.ts`:加 `SystemAgentSpawnContext`(agentName/systemPrompt/model?/readonly?/prompt/worktreePath/runDir/resumeSessionId?/gitUserName?/gitUserEmail?/**runtimeBinary?**)+ `RuntimeDriver.buildSpawn(ctx):SpawnPlan`。 | — |
| **T2** | opencode driver `buildSpawn`:就地构造极简 inline config `{agent:{[name]:{prompt,model?}}}`(与 distiller 现状逐字等价)→ 调 `buildOpencodeSpawn` → `{cmd,env,stdin:{mode:'ignore'}}`;`runtimeBinary` 作为 head(对齐 `pickRuntimeHead`)。 | T1 |
| **T3** | claude driver `buildSpawn`:映射到 `buildClaudeSpawn`(systemPromptText/model/readonly/attemptDir=runDir)→ 直返 `SpawnPlan`(含 `stdin:pipe`)。 | T1 |
| **T4** | 单测:两 driver `buildSpawn` 的 cmd/env/stdin 形态;`runtimeBinary` 覆盖 head;opencode 极简 inline config 内容。**不动 runner 业务节点路径**(其 golden 不受影响,加一条源码断言锁 `buildInlineConfig`/runner spawn 分支未改)。 | T1–T3 |

**验收**:driver 暴露统一 `buildSpawn`;opencode/claude 各产出正确 SpawnPlan;runner 主路径与 RFC-111/112 golden 零回归。

---

## PR-B — distiller 收编 + `memoryDistillRuntime` + 迁移

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T5** | config 加 `memoryDistillRuntime`;`start.ts`/`memoryDistillScheduler.ts` thread `defaultRuntime`;`distillTick` 经 `resolveAgentRuntime(db, memoryDistillRuntime, defaultRuntime)` 解析 `{protocol,binaryPath,model}` 透传 `runDistill`。 | PR-A |
| **T6** | `defaultDistillerSpawn` 改用 `getRuntimeDriver(protocol).buildSpawn(...)` → `Bun.spawn`(**支持 stdin pipe**〔claude〕;保留临时目录 + 超时 SIGTERM)。 | PR-A,T5 |
| **T7** | `parseDistillerOutput(stdout,protocol)` 改逐行 `driver.parseEvent` 收 `.text`(null 行并入 raw),保留 `extractLastEnvelope`+candidates;**删 `extractEventText`**。 | PR-A |
| **T8** | 迁移 `memoryDistillModel`→opencode profile(profileKey 去重/复用/建 `opencode-N`)+ 指向 `memoryDistillRuntime` + 退役旧字段 + fail-loud 守卫(照 §5)。**实装首步 Read RFC-115 config 字段退役机制**定落地方式。 | T5 |
| **T9** | 测试:spawn 分支(protocol→driver cmd)+ 解析三形状(opencode/claude/mock envelope,回归 silently-`[]`)+ stdin pipe + 迁移幂等/守卫 + 源码断言(无 `extractEventText`/inline JSON 事件解析)。 | T5–T8 |

**验收**:distiller 走统一 driver、可选 runtime profile、消除约 150 行重复;旧 model 无损迁移;opencode 路径行为不变。

---

## PR-C — commit 接入 + `commitPushRuntime` + 迁移

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T10** | config 加 `commitPushRuntime`;`launchRuntimeConfig`/`SchedulerOptions` thread(替 `commitPushModel` thread);`maybeRunCommitPush.genViaOpencode` 在 `runNode` 前补 `resolveFrozenRuntime(db,sessionRunId,commitPushRuntime,defaultRuntime,null)` 并传 `runtime/runtimeBinary/runtimeParams`;`buildCommitAgent` 去 model(删 `scheduler.ts:1005`/改 `1042`)。 | — |
| **T11** | 迁移 `commitPushModel`→opencode profile + 指向 `commitPushRuntime` + 退役(与 T8 共用迁移 helper)。 | T10 |
| **T12** | 测试:`commitPushRuntime` 设了→runNode 收对应 runtime/params;留空→继承 defaultRuntime;全空→opencode(回归「曾写死 opencode」修复);迁移幂等。 | T10–T11 |

**验收**:commit message / push 修复跑在所选 profile(留空继承 defaultRuntime),第 4 派发点与其余 3 点对齐;旧 model 无损迁移。

---

## PR-D — fusion / skill-merger:放开 builtin agent runtime 编辑

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T13** | **Read 确认 RFC-104 锁实现**(`services/agent.ts` updateAgent / `routes/agents.ts` / `AgentForm.tsx`);放开 builtin agent 的 `runtime` 字段编辑(窄例外:仅 runtime 可 patch,其余字段仍 reject)。 | — |
| **T14** | 测试:builtin agent `runtime` 字段可 patch(`aw-skill-merger`)、其余字段 patch 仍 403;选定后 fusion 派发用该 runtime(透传断言)。 | T13 |

**验收**:用户经 `/agents` 给 `aw-skill-merger` 选 runtime profile,RFC-104 其余锁不破;fusion 用该引擎跑。

---

## PR-E — 前端 settings Select + `useRuntimesList` + i18n

| 任务 | 描述 | 依赖 |
|---|---|---|
| **T15** | 抽 `useRuntimesList()` hook(公共化 `AgentForm.tsx:73-84` 的 runtimes query + claude 过滤 + 内置 fallback);AgentForm 改用它(dedup)。 | — |
| **T16** | settings:`MemoryTab`/`LimitsTab` 两处 `<ModelSelect>`(`memoryDistillModel`/`commitPushModel`)→ runtime profile `<Select>`(`memoryDistillRuntime`/`commitPushRuntime`,含「继承默认」空值项);`useTabState` keys 增改。复用 `Field`+`Select`。 | T15,PR-B,PR-C |
| **T17** | i18n 加 `*Runtime` label/hint(zh/en 对称)+ 清废弃 model key;前端 vitest(两 Select `findByRole`+保存+留空=继承;源码断言不再用 ModelSelect for 这两项)。 | T16 |

**验收**:代理之外的两个内置功能也用统一运行时选择器;前台风格一致(仅公共组件);i18n 对称。

---

## 全局验收清单

- [ ] PR-A:`RuntimeDriver.buildSpawn` slice(opencode/claude)+ runner 主路径 golden 零回归。
- [ ] PR-B:distiller 走 driver buildSpawn+parseEvent、可选 profile、消除重复、旧 model 迁移、opencode 行为不变。
- [ ] PR-C:commit 第 4 派发点接 frozen runtime、可选 profile、旧 model 迁移。
- [ ] PR-D:builtin agent runtime 字段放开(窄例外)、RFC-104 其余锁不破。
- [ ] PR-E:settings 两处改 runtime profile 选择器 + `useRuntimesList` dedup + i18n。
- [ ] 迁移无损 + 幂等 + fail-loud 守卫;**零 DB migration**。
- [ ] 门禁全绿:`typecheck×3 + backend bun test + 前端 vitest + format + lint + binary smoke`。
- [ ] Codex 设计 gate + 实现 gate findings 全 fold;STATE.md/plan.md/proposal 索引登记。
- [ ] 行为变化(distiller/commit 从写死 opencode → 跟随 profile/defaultRuntime)在 STATE/release note 标注。

## 与 RFC-111~115 / 在途衔接

- **复用不改**:RFC-111 `RuntimeDriver`/`SpawnPlan`/`buildOpencodeSpawn`/`buildClaudeSpawn`/`parseEvent`/`getRuntimeDriver`;RFC-112 `runtimes` 表/`resolveRuntimeByName`/`runtimeHead`/`resolveFrozenRuntime`;RFC-113 `runtimeProfileOf`/`createRuntime`/`profileKey` 迁移模式;RFC-115 `assertConfigDefaultsMigrated` 守卫模式。本 RFC 只**加** `buildSpawn` slice + 两 config 字段 + 放开 builtin runtime 锁 + 迁移。
- **D14 修订**:本 RFC 推翻 RFC-111 D14 的「内部 agent 留 opencode」(opencode 仍硬要求那半条不动);RFC-113 Codex P1-4 排除内部 agent 的前提随之失效。
- **多人共享树**:零 migration 免去 journal 顺延;config schema 改 + i18n 纯新增/退役自有 key,不删他人 key;精确路径提交([feedback_shared_index_commit_race])。
- **RFC-116 在途**(runtime smoke 网络分类,In Progress):与本 RFC 零代码重叠(它改 `runtimeSmoke.ts` 分类,本 RFC 改 spawn/解析/config),互不阻塞。
