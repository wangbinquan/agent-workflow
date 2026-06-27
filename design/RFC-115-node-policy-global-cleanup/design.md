# RFC-115 技术设计 — 节点执行策略全局化 + RFC-113 死资产彻底清理 + Agent 运行时列

> 读法：先 `proposal.md`，再本文，再 `plan.md`。
> 行号基于 HEAD `f81e381`，实现时以源码为准。

## 0. 现状盘点（三路只读审计结论）

### 0.1 节点 retries/timeout（G1 目标面）

- **节点 schema**：`WorkflowNodeSchema`（`packages/shared/src/schemas/workflow.ts:87-102`）是 `.passthrough()`，`retries` / `timeoutMs` **不是 zod 强字段**——它们松散挂在节点 JSON 上，前端用 `typeof rec.x === 'number'` 防御读取（`NodeInspector.tsx:1198-1199`）。
- **后端消费**：
  - 超时 3 处：`scheduler.ts:1714`（主路径 `runOneNode`）/ `:3686`（fanout inner）/ `:3956`（aggregator）= `pickNumber(node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs`。
  - 重试 1 处：`scheduler.ts:1721` = `pickNumber(node, 'retries') ?? 3`（仅主路径；fanout/agg 不读节点 retries）。
- **全局承载**：`config.defaultPerNodeTimeoutMs` 已存在（DEFAULT 30min，`resolveLaunchRuntimeConfig` 已 thread）；**重试无全局 config 项**，默认是 scheduler 内硬编码 `?? 3`（RFC-042）。

### 0.2 RFC-113 死资产（G2 目标面）

执行层迁移**已彻底完成**——runner 一律从运行时 profile 取生成参数（`runner.ts:1657-1661 buildInlineAgentEntry(agent, params)` 从 `params` 取、注释明确「NOT from the agent」；claude 分支 `runner.ts:820 model: opts.runtimeParams?.model`）。但下列契约层**全是死资产**：

**(a) agent 参数 DB 列**（`packages/backend/src/db/schema.ts:35,39,40,42,43`）`model / variant / temperature / steps / max_steps`：
- 写：`agent.ts:77-83`（createAgent insert）、`:135-140`（updateAgent set）。
- 读映射：`agent.ts:495-503`（rowToAgent → Agent DTO）。
- **隐式全列 SELECT 风险**：`agent.ts:17 listAgents` / `:22 getAgent` 用 drizzle 无投影 `select()`，列清单由 `schema.ts` 生成 → **DROP 列必须与 schema.ts 删列原子**，否则 `no such column` 崩。
- 运行时消费者：**零**。

**(b) 一次性迁移函数** `migrateAgentParamsToRuntimes`（`runtimeRegistry.ts:488-623`）+ 私有助手 `profileKey`（`:467-479`，仅本函数用）：读 agents 参数列、去重 re-home 到运行时行、清空 agent 列为 NULL。调用点 `cli/start.ts:218(import)` / `:226(await)`，每次启动跑（幂等）。**勿删** `runtimeProfileOf`(:85) / `resolveRuntimeByName`(:145)——RFC-112/113 活路径在用。

**(c) 节点 override 死链**（功能死代码，被算被传、最终只进日志）：
- `scheduler.ts:115` import `AgentOverrides`；`:4727-4738` `pickOverrides(node)`（读 `node.overrides.{model,variant,temperature}`）；`:1722/3687/3957` `pickOverrides(...)`；`:2423/3731/3998` `{overrides: nodeOverrides}` 传 `runNode`。
- `runner.ts:100-104` `interface AgentOverrides`；`:121` `RunNodeOptions.overrides`；`:872` `overrides: opts.overrides ?? null`（**唯一消费点是 `log.info` 字段**，`buildInlineAgentEntry` 不读它）。
- 回归锁 `scheduler-node-overrides.test.ts` 已被 RFC-113 翻转为「node param overrides are IGNORED」断言（用原始 JSON，不引用 `pickOverrides` 符号）。

**(d) shared schema + markdown**：`shared/schemas/agent.ts` `AgentSchema`(106/115/116/118/119) + `CreateAgentSchema`(173/177/178/180/181)（`UpdateAgentSchema:195` = omit+partial 自动继承）；`shared/agent-md.ts` `KNOWN_KEYS:34-38` + 解析体 `:135-194`（写 `partial.model = ...`，`partial: Partial<CreateAgent>`）。

**(e) 死 config 字段**（`shared/schemas/config.ts`）`defaultModel:57-58 / defaultVariant:59 / defaultTemperature:60 / defaultSteps:61-67 / defaultMaxSteps:68 / defaultClaudeModel:50-51`：
- 唯一生产消费者 = `migrateConfigIntoBuiltins`（`runtimeRegistry.ts:418-463`）的 backfill 读（`:453-457,461`）。
- **不在 DEFAULT_CONFIG**（schema-optional，无默认占位）→ 无需删 DEFAULTS 行。
- `/api/config` 泛型透传，zod **strip 未知键** → 删字段后老 config 残值静默丢弃（见 §5 P0 风险）。
- ⚠️ `migrateConfigIntoBuiltins` **别整删**——它还 backfill `opencodePath`(:452) / `claudeCodePath`(:460) 两个**活**字段。
- `settings.tsx` 已不再渲染这 6 字段（PR-C 清过）；对应 i18n key 是 PR-C 漏删的死字符串。

**(f) `doc_versions.agent_snapshot`**（`schema.ts:849`，在 **docVersions 表**〔Codex 设计 gate F1 纠正：审计误判为 node_runs，实为 `doc_versions`，migration `0002_melted_stryfe.sql` 创建〕，JSON `{model,variant,temperature}`）：写 `review.ts:783/807`（恒 `?? null`，**全仓无非 null 生产者**）、读 `review.ts:2408` → ReviewVersion DTO（`shared/schemas/review.ts:163`）。死列。doc_versions 约 22 列、2 FK（`task_id`→tasks、`review_node_run_id`→node_runs，均 cascade）、3 索引（`idx_doc_versions_review_run` / `_task` / `_review_item`）——比 node_runs 轻得多，非任务执行承重表。

### 0.3 Agent 运行时列（G3 目标面）

- `/agents` 列表 `routes/agents.tsx`：现有列 名称(`agents.colName`)/描述/输出/只读(`:colReadonly`)/操作。`agent.runtime` 字段已在 `['agents']` 返回（`AgentSchema:114 runtime?: string`）。
- **数据源（默认运行时名）**：`['runtimes']` 查询（`/api/runtimes` → `{runtimes: RuntimeView[]}`），取 `runtimes.find(r => r.isDefault)?.name`。`RUNTIMES_QUERY_KEY` 已从 `RuntimeList.tsx:28` 导出，复用。服务端据 `config.defaultRuntime` 恰好给一个运行时打 `isDefault`（空也落到内置 opencode），前端不会拿到 undefined。
- **`inventory/AgentsTable.tsx` 的 model 列**：读 `InventoryAgent.modelId / modelProviderId`（opencode 子进程实际 dump 的模型，`shared/inventory.ts:39-47`），**不是** `Agent.model`——语义正确、不 stale、**不动**。
- **真正会因删 Agent DTO 5 字段 TS 报错的生产残留只有 2 处**：`agents.detail.tsx:131-135`（agentToDraft 读写）+ `AgentImportDialog.tsx:113-117`（经 `Partial<CreateAgent>` 连带，根因 shared `agent-md.ts`）。`RuntimeList.tsx:229-236`（读 `RuntimeView.model` profile）/ `AgentForm.tsx`（RFC-113 已清）**不受影响、勿误清**。

## 1. 决策

- **D1 重试新增全局可配项**（用户拍板）：`config.defaultNodeRetries`（`z.number().int().nonnegative()`，**nonnegative 不是 positive**——`retries:0` 合法），DEFAULT = 3（对齐 RFC-042、行为不变）。Settings 执行限制页可配。
- **D2 节点不再覆盖 retries/timeout**：删前端控件；后端 scheduler 不再 `pickNumber(node, 'retries'/'timeoutMs')`，直接用全局 opts。节点 JSON 里残留字段被忽略（passthrough 天然容旧；下次保存经编辑器 state 自然不写回——节点抽屉不再产生这两个键）。**不**为旧定义写主动剥离逻辑（passthrough 字段无害、且无统一保存漏斗值得加；与 RFC-113「旧 override 残留忽略」同档）。
- **D3 override 死链整链删除**：`pickOverrides` / `AgentOverrides`(scheduler import + runner interface + RunNodeOptions 字段 + log 字段) / 三处 `nodeOverrides` 计算与透传，全删。`scheduler-node-overrides.test.ts` 简化为纯「忽略」断言（构造原始 JSON、不引用已删符号）。
- **D4 agent 参数契约收口 + DROP 列**：补做 RFC-113 T6 + DROP `agents` 5 列。shared schema / agent.ts / agent-md / 前端残留 / schema.ts 列定义**同一 PR 原子**落地（否则 typecheck / drizzle SELECT 崩）。`migrateAgentParamsToRuntimes` + `profileKey` 整删、`cli/start.ts` 调用删。
- **D5 agent.md 遗留键降级路由**（不丢数据）：旧 `agent.md` 的 `model:` / `variant:` 等 frontmatter 键，导入时**路由进 `frontmatterExtra`/`extras`**（`agent-md.ts` 对非法值已是此行为，`:140/150/160`），而非进 `partial`。前端 `AgentImportDialog` 删 `ROUTE_KEYS` 5 键 + `add()` 5 行；老定义不报错、参数进 frontmatterExtra 预览、不进 DB。
- **D6 config 死字段删除 + 迁移收敛**：删 6 字段 schema；`migrateConfigIntoBuiltins` 删这 6 字段的参数类型与 backfill 读、**保留** opencodePath/claudeCodePath backfill（函数不整删）。
- **D7 `doc_versions.agent_snapshot` 彻底删**（用户「死数据库列也同步清理」；Codex F1 纠正：在 `doc_versions` 非 node_runs）：删代码引用链（review.ts + shared review schema + ReviewVersion DTO 字段）+ DROP DB 列。重建 **doc_versions**（约 22 列，比 node_runs 轻；但**必须保留** 2 FK〔task_id→tasks、review_node_run_id→node_runs，均 cascade〕+ 3 索引〔idx_doc_versions_review_run/_task/_review_item〕），用 `PRAGMA table_info/index_list/foreign_key_list(doc_versions)` 守卫（见 §4.2）。降级方案 = 仅删代码引用、DB 列留 follow-up——plan 标可回退。
- **D8 运行时列展示**（用户拍板）：`a.runtime ?? <isDefault 运行时名>`；未指定时附公共 `StatusChip kind="neutral" size="sm"`「默认」标记。数据源 `['runtimes']` 的 `isDefault`。
- **D9 pre-drop fail-loud 守卫**（Codex 设计 gate F2 强化，取代原「硬切+记已知限制」）：0057 在重建 agents 去列**之前**先跑守卫——若 `agents` 任一参数列存在非 NULL 值（即该库尚未经 RFC-113 的 `migrateAgentParamsToRuntimes` re-home），migration **ABORT**（SQLite CHECK 技巧，见 §4.1），明确提示「先经 RFC-113 启动一次完成 re-home」。已 re-home 的库（参数列全 NULL）守卫通过 → DROP 无损。如此跨 RFC-113 跳级升级 **fail-loud、绝不静默丢 model 数据**（pre-prod 实际无 live 数据、守卫几乎恒通过，但机制上堵死数据丢失）。
- **D10 修复 `config.defaultRuntime` 接线 gap**（Codex F3）：审计发现 `config.defaultRuntime` 经 `resolveLaunchRuntimeConfig` 返回、scheduler `opts.defaultRuntime`(:199-204) 消费，但 **`StartTaskDeps` 缺该字段、`runtimeConfigOpts`(task.ts:481 `Pick<...'commitPush'|'maxConcurrentNodes'>`) 不转发** → 生产 startTask 路径上 `config.defaultRuntime` 从未生效（agent.runtime=null 的节点 fallback opencode 而非配置默认）。本 RFC 顺带修复：`defaultRuntime` + 新增 `defaultNodeRetries` 一并接进 `StartTaskDeps`→`runtimeConfigOpts` 单一漏斗（连既有 3 处手动 `defaultPerNodeTimeoutMs` spread 一并收编，§2.4）。这是 G3 运行时列「显示=实际执行」正确性的前提。

## 2. 接口契约

### 2.1 config schema（shared）

`packages/shared/src/schemas/config.ts`：
```ts
// 紧跟 defaultPerNodeTimeoutMs（:77）后新增：
defaultNodeRetries: z.number().int().nonnegative(),   // RFC-115: 全局节点重试次数（取代节点级 retries override）
```
`DEFAULT_CONFIG`（:314）紧跟 `defaultPerNodeTimeoutMs: 30*60*1000`（:322）后新增：
```ts
defaultNodeRetries: 3,   // RFC-115 / 对齐 RFC-042 默认
```
**删除**：`defaultModel / defaultVariant / defaultTemperature / defaultSteps / defaultMaxSteps / defaultClaudeModel`（schema 定义；DEFAULT_CONFIG 无对应行）。
**保留**（防误删）：`defaultRuntime / opencodePath / claudeCodePath / claudeCodeEnabled`。

### 2.2 producer（`resolveLaunchRuntimeConfig`）

`packages/backend/src/services/launchRuntimeConfig.ts`：返回类型与 `out` 对象各加 `defaultNodeRetries?: number`；try 块仿 timeout：
```ts
if (cfg.defaultNodeRetries !== undefined) out.defaultNodeRetries = cfg.defaultNodeRetries
```
（不加 `> 0` 守卫——0 合法。）

### 2.3 scheduler

`packages/backend/src/services/scheduler.ts`：
- opts 类型（`:167` 附近，与 `defaultPerNodeTimeoutMs` 并列）加 `defaultNodeRetries?: number`。
- `:1721`：`const maxRetries = pickNumber(node, 'retries') ?? 3` → `const maxRetries = opts.defaultNodeRetries ?? 3`（保留尾 `?? 3` 兜 mock/未注入；**去掉** `pickNumber(node,'retries')`）。
- `:1714/3686/3956`：`pickNumber(innerNode/aggNode/node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs` → `opts.defaultPerNodeTimeoutMs`（去掉 `pickNumber(...,'timeoutMs')`）。
- 删 `pickOverrides`(:4727-4738) + `:1722/3687/3957` nodeOverrides + `:2423/3731/3998` 透传 + `:115` import。

### 2.4 StartTaskDeps → runtimeConfigOpts 单一漏斗（Codex F3：收编 + 补 defaultRuntime）

**现状**：`runtimeConfigOpts(deps)`（task.ts:481-496，`Pick<StartTaskDeps,'commitPush'|'maxConcurrentNodes'>`）只转发 commitPush*/maxConcurrentNodes；`defaultPerNodeTimeoutMs` 反而是 task.ts 三处（:946/1371/1959）**手动 spread**（dedup 债）；`defaultRuntime` **既不在 StartTaskDeps 也不在 runtimeConfigOpts** → `config.defaultRuntime` 在生产 startTask 路径失效（F3，agent.runtime=null 时 fallback opencode）。

**改法**——把 timeout/retries/runtime 三者统一收进 `runtimeConfigOpts` 单一漏斗：
- `StartTaskDeps`（:124 区）补 `defaultNodeRetries?: number` + `defaultRuntime?: string`（`defaultPerNodeTimeoutMs` 已有）。
- `runtimeConfigOpts` 的 `Pick` 扩为含 `defaultPerNodeTimeoutMs | defaultNodeRetries | defaultRuntime`；返回里条件 spread 这三者（仿 commitPush）。
- **删** task.ts 三处手动 `defaultPerNodeTimeoutMs` spread（:946/1371/1959）——统一由 `...runtimeConfigOpts(deps)` 注入（三处已在调它）。
- `fusion.ts`（:70 类型 + :463/851 kick）与 `routes/fusions.ts:50,55`（显式解构入口）同步补三字段 / 改走漏斗。
- 上游 `resolveLaunchRuntimeConfig` 已返回 `defaultRuntime`（§2.2 再加 `defaultNodeRetries`）→ 确保进 deps。
- **G3 正确性前提**：修后 agent.runtime=null 节点冻结 `node_runs.runtime = config.defaultRuntime`，运行时列「默认」标记 = 实际执行运行时；回归测试见 §6。

### 2.5 runner

`packages/backend/src/services/runner.ts`：删 `interface AgentOverrides`(:100-104) / `RunNodeOptions.overrides`(:121) / log `overrides:` 字段(:872)。`buildInlineAgentEntry` 不变（已只读 runtime params）。

### 2.6 前端

- **NodeInspector.tsx**（agent-single 分支）：删 `:1198-1199` 变量 + `:1239-1255` 控件块（含 RFC-113 注释）；文件头 doc 注释（:6）去 `retries, timeoutMs`。
- **settings.tsx** LimitsTab：`useTabState` 字段数组（:166 附近）加 `'defaultNodeRetries'`；仿 `:207-214` perNodeTimeout 加一块 `<Field>+<NumberInput min={0}>`（紧挨超时）。
- **agents.tsx**：表头 `colReadonly`(:64) 后、actions 前插 `<th>{t('agents.colRuntime')}</th>`；行内只读 `<td>` 后、actions 前插运行时 `<td>`（`a.runtime ?? defaultRuntimeName` + 未指定时 `StatusChip`「默认」）。新增 `['runtimes']` 查询（复用 `RUNTIMES_QUERY_KEY`）取 `isDefault` 名。
- **agents.detail.tsx**：删 `agentToDraft` 的 `:131-135`（读 `a.model` 等 + 写 `out.model` 等）。
- **AgentImportDialog.tsx**：删 `ROUTE_KEYS` 5 键（:29-33）+ `describePreview` 的 5 行 `add('model'...)`（:113-117）。

### 2.7 i18n（中英对称，zh 类型块 + 值块两处）

- **新增**：`agents.colRuntime`（en `Runtime` / zh `运行时`）、`agents.runtimeDefaultTag`（en `default` / zh `默认`）、`settingsForm.nodeRetries`（en `Default node retries` / zh `默认节点重试次数`）（+ 可选 Hint）。
- **删除 17 死 key**：`inspector.fieldRetries / fieldRetriesHint / fieldTimeoutMs / fieldTimeoutMsHint`（4，**勿删 `mcps.fieldTimeoutMs`**）；`agentForm.importDialog.routedTo.{model,variant,temperature,steps,maxSteps}`（5，保留 name/description/permission/bodyMd/frontmatterExtra）；`settingsForm.{defaultModel,defaultModelHint,defaultVariant,defaultTemperature,defaultSteps,defaultStepsHint,defaultMaxSteps,defaultMaxStepsHint}`（8，**勿删 defaultRuntime* / defaultClaudeModel 的 runtime 相关项**）。

## 3. 数据流（节点重试解析，改后）

```
config.json defaultNodeRetries(3)
  └─ loadConfig → resolveLaunchRuntimeConfig → StartTaskDeps.defaultNodeRetries
       └─ task/fusion kick → scheduler opts.defaultNodeRetries
            └─ runOneNode: maxRetries = opts.defaultNodeRetries ?? 3   // 不再读 node.retries
                 └─ attempt loop: for (a = retryIndex; a <= retryIndex + maxRetries; a++)
```
超时同构（已存在的 `opts.defaultPerNodeTimeoutMs`，去掉 node 覆盖分支）。

## 4. 迁移策略（migration 0057 / 可选 0058）

### 4.1 agents 5 列 DROP（0057，PR-C）

- journal 追加 `idx:56, version:"6", when:<固定常量>, tag:"0057_rfc115_drop_agent_params", breakpoints:true`（`Date.now()` 不可用，用与 0056 同风格的递增常量）。
- **pre-drop fail-loud 守卫（D9 / Codex F2，置于重建之前、migration 首段）**：用 SQLite CHECK 技巧断言 agents 参数列已被 RFC-113 re-home（全 NULL），否则整个 migration ABORT、绝不静默丢 model 数据：
  ```sql
  CREATE TEMP TABLE __rfc115_guard (n INTEGER CHECK (n = 0));--> statement-breakpoint
  INSERT INTO __rfc115_guard SELECT COUNT(*) FROM agents
    WHERE model IS NOT NULL OR variant IS NOT NULL OR temperature IS NOT NULL
       OR steps IS NOT NULL OR max_steps IS NOT NULL;--> statement-breakpoint
  DROP TABLE __rfc115_guard;--> statement-breakpoint
  ```
  未 re-home 的库（跳过 RFC-113）COUNT>0 违反 `CHECK(n=0)` → ABORT，提示「先经 RFC-113 启动一次」；已 re-home（全 NULL）→ 通过后继续重建。
- bun:sqlite 无 `ALTER TABLE DROP COLUMN` → **12 步表重建**（0041/0035 模板）：`PRAGMA foreign_keys=OFF` → `CREATE __new_agents`（**显式列清单 = 当前全列 − 5 参数列**）→ `INSERT INTO __new_agents SELECT <显式列> FROM agents` → `DROP TABLE agents` → `ALTER RENAME __new_agents → agents` → `PRAGMA foreign_keys=ON`，每句 `--> statement-breakpoint`。
- agents 表**无二级索引**（仅内联 `name unique`、`owner_user_id` 为 app 层 FK 无真实约束）→ 无需重建 CREATE INDEX，重建轻。
- **schema.ts 同步删 5 列**（同 PR），否则 drizzle 无投影 `select()` 生成的列清单与 DB 不符。

### 4.2 doc_versions.agent_snapshot DROP（0058，PR-E，D7；Codex F1 纠正表名）

- 同 12 步重建，目标表 **doc_versions**（非 node_runs，约 22 列）。显式列清单 = doc_versions 当前全列 − `agent_snapshot`。
- **必须保留** 2 FK（`task_id`→tasks cascade、`review_node_run_id`→node_runs cascade）+ 3 索引（`idx_doc_versions_review_run` / `_task` / `_review_item`）——重建后逐一 `CREATE INDEX`。
- **守卫**：`migration-0058-*.test.ts` 用 `PRAGMA table_info(doc_versions)`（agent_snapshot 消失、其余列名集合不变）+ `PRAGMA index_list` / `PRAGMA foreign_key_list`（索引/FK 保留）+ 行数不变断言。
- 风险显著低于原误判的 node_runs（doc_versions 非任务执行承重表）；仍标可回退（仅删代码引用、DB 列留 follow-up）。

### 4.3 迁移退役顺序

`cli/start.ts` 启动序列：`migrate(db)`（应用 0057〔守卫→重建 agents〕/0058 SQL）→ `seedBuiltinRuntimes` → `migrateConfigIntoBuiltins`（收敛后保留）→ ~~`migrateAgentParamsToRuntimes`~~（删）。
- 已跑过 RFC-113 的库：参数列已 re-home 清空 NULL → 0057 守卫通过 → DROP 无损。
- 跳级库（pre-0056 直接 → 本版）：0057 守卫检出非 NULL → ABORT（fail-loud，§4.1），不静默丢；须先经 RFC-113 build re-home。
- 删 `migrateAgentParamsToRuntimes` 与 DROP 必须同 PR：该函数读被删的列，留它则 TS 编译错。

## 5. 失败模式与风险

- **P0 跨版本跳级数据丢失 → 已由 D9 pre-drop 守卫堵死**（Codex F2）：原「硬切+记已知限制」会让 pre-0056 直接跳本版的库在 re-home 前被 DROP 丢 model 数据。改为 0057 fail-loud 守卫（§4.1）：未 re-home 的库 migration ABORT 而非静默丢。**config 6 死字段**无列 DROP（仅 schema 删 + zod strip 残值），其值经 `migrateConfigIntoBuiltins` 已 backfill 进内置运行时行；跳级库 config.json 残值被 strip——同样依赖「先经 RFC-113」，但属值丢失非列丢失、pre-prod 可接受，PR-D 文档声明该前提（不另加 config 守卫，agents 守卫已覆盖更危险路径）。
- **DROP 与代码删除非原子 → typecheck/SELECT 崩**：schema.ts 删列、agent.ts、shared schema、agent-md、前端残留必须**同一 PR**。
- **误删活资产**：`claudeCodePath`（8+ 处活 fallback）/ `claudeCodeEnabled`（AgentForm gate）/ `defaultRuntime`（D10 接线后更不能删）/ `runtimeProfileOf` / `resolveRuntimeByName` / `migrateConfigIntoBuiltins`（托二进制 backfill）/ `RuntimeList` profile / `inventory` modelId / `mcps.fieldTimeoutMs` —— 逐一在 plan 标「勿删」。
- **doc_versions 重建漏列 / 丢 FK·索引**（D7/§4.2）：`PRAGMA table_info/index_list/foreign_key_list` 守卫。
- **NUL 守卫**：`runtimeRegistry.ts:468-478 profileKey` 用 `'\x00'`/`'\x1f'`（d15546d 修过），随函数删除；其余改动勿引入字面 NUL（`no-nul-bytes-in-source.test.ts` 守）。

## 6. 测试策略（必写 case）

- **G1 后端**：`config.test.ts` 加 `defaultNodeRetries` round-trip + 默认=3 + 缺字段 backfill（**必填+有默认**风格，非 optional）；scheduler 断言 node 无 retries 时取 `opts.defaultNodeRetries`、node 有 retries 时**被忽略**（锁 D2）；timeout 同构忽略断言。
- **G1 前端**：翻转 `node-inspector.test.tsx:309-322` 为 `queryByText('Retries'|'Timeout (ms)')` 均 `toBeNull()`（保留 promptTemplate/agent 选择正向断言）；源码文本兜底「`NodeInspector.tsx` 不含 `inspector.fieldRetries`」；settings 含 `defaultNodeRetries` 输入。
- **G2 死资产**：`scheduler-node-overrides.test.ts` 简化为纯「忽略」；删 `runtime-profile-migration.test.ts`（随 `migrateAgentParamsToRuntimes` 退役）；agent SELECT 不含 5 列（migration 列计数）；`config.test.ts` 删 default* 系列用例；`agent-md.test.ts` 加「遗留 `model:` 键路由进 frontmatterExtra、不进 partial」红→绿；源码文本「`agents.detail.tsx` 不含 `a.model`/`out.model`」防回潮。
- **G2 migration**：`migration-0057-*.test.ts`（agents 列名快照 / 行数不变 / 5 列消失；**pre-drop 守卫**：含非 NULL agent 参数的 pre-0056 fixture → 0057 **ABORT**〔Codex F2〕、已全 NULL → 成功）；`migration-0058-*.test.ts`（`PRAGMA table_info/index_list/foreign_key_list(doc_versions)` 列名/索引/FK 守卫 + 活列值保留，D7 doc_versions）；upgrade-rolling 计数更新。
- **G3 运行时列 + defaultRuntime 接线**（Codex F3）：`agents.tsx` 集成（`findByRole('columnheader',{name:/运行时|Runtime/})`；指定运行时行显名无 chip；未指定行显默认名 + 「默认」chip）；**后端冻结回归**：agent.runtime=null + `config.defaultRuntime='claude-code'` → 启动后 `node_runs.runtime` 冻结为 `claude-code`（证明 D10 接线生效、列显示=实际执行，否则该测试红）。
- **门禁**：`bun run typecheck && bun run test && bun run format:check` 全绿 + 单二进制 smoke（0057/0058 嵌入、无模块环）+ i18n parity。

## 7. Codex 设计 gate / 实现 gate 记录

### 设计 gate（adversarial-review，base HEAD~1，verdict needs-attention）— 3 findings 全 fold
- **F1 [high] agent_snapshot 表名错**：审计误判在 node_runs，实为 `doc_versions`（schema.ts:821-849 / migration 0002 创建；nodeRuns 无此列）。→ Fold：§0.2(f)/§4.2/D7/PR-E 全改 doc_versions 重建（保 2 FK + 3 索引、`PRAGMA table_info/index_list/foreign_key_list` 守卫），风险下调（非承重表）。
- **F2 [high] 硬切在 re-home 前删源列丢数据**：start.ts 先 SQL migrate（DROP agents 列）后 TS re-home（读列），跳级库丢 model。→ Fold：D9 改 0057 **pre-drop fail-loud 守卫**（§4.1 CHECK 技巧，未 re-home 则 ABORT、不静默丢）+ §5 P0 重写 + §6 升级测试（pre-0056 含非空 params → abort）。
- **F3 [medium] 运行时列显示执行不用的默认运行时**：`config.defaultRuntime` 未接进 StartTaskDeps→runTask（`runtimeConfigOpts` 只转发 commitPush/maxConcurrent，timeout 还是手动 spread），生产路径 fallback opencode。→ Fold：新增 D10 + §2.4 把 `defaultRuntime` + `defaultNodeRetries` 收进 `runtimeConfigOpts` 单一漏斗（收编 timeout 手动 spread）+ §6 加 `node_runs.runtime` 冻结回归；PR-B 标依赖 PR-A 接线修复。

### 实现 gate
（实现后跑，findings 在此登记。）
