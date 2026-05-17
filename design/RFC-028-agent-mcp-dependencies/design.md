# RFC-028 — 技术设计

## 0. opencode 端事实（实现前必读）

落码前对照过 `/Users/wangbinquan/Documents/code/opencode/packages/opencode/src/{config,mcp}/`，下列事实**钉死本 RFC 的注入策略**，未来如要偏离请先 verify。

### 0.1 MCP 在 opencode 进程内是**全局**的，不是 per-agent

`mcp/index.ts:513-549` 的 `InstanceState.make` 一次性枚举 `cfg.mcp` 所有条目并 spawn / connect；`tools()`（mcp/index.ts:657-690）把每个连接成功的 MCP 的 tool 列表挂到当前进程的工具池。opencode 没有 `agent.mcp` 字段，agent 配置里只能通过 `permission` 在工具名层面 allow/deny（`config/agent.ts:31` 的 `tools: Record<string, boolean>` 是 deprecated 路径，但仍在用）。

**这意味着**：框架层「agent X 依赖 MCP Y」不可能通过让 opencode 把 MCP Y 只暴露给 X 来实现 —— 必须依赖**每节点一个独立 opencode 子进程**的现有隔离（runner.ts:255-262 spawn 路径），由 runner 在 spawn 之前决定该进程的 `mcp:` 配置范围。dependsOn 闭包里的子 agent 与 task 工具触发的 sub-session **共享同一进程**，因此也共享同一组 MCP。

### 0.2 配置合并语义

`config/config.ts:48` `mergeConfig = mergeDeep(target, source)`；`config.ts:627-634` 在 `OPENCODE_CONFIG_CONTENT` 路径上调 `merge(source, next, "local")`，最终也走 `mergeDeep`。`remeda.mergeDeep` 对：

- **同名 `mcp.<key>`**：字段级深合并，inline 的值覆盖同字段。
- **数组字段**（`command`, primitive 数组）：整体替换，inline 完全胜出。
- 我们 inline 设全字段就等同于"完全覆盖"，无需 disable flag。

这也意味着**用户 repo `.opencode/config.json` 里已有的同名 MCP 会被深合并**：未在 inline 提供的字段（比如他设了 `oauth.scope`，我们 inline 没动）会留下来。这通常无害；如需强制屏蔽某 inherited MCP，未来 RFC 可以在 inline 里写 `mcp.<key> = { enabled: false }`（schema 接受 `Union([ConfigMCP.Info, { enabled: boolean }])`，config.ts:211-215），运行时直接 status=disabled（mcp/index.ts:533）。本 RFC v1 **不引入**屏蔽语义。

### 0.3 字段名（必须按 opencode 命名注入）

`config/mcp.ts`：

- **Local**：`type:"local"`, `command: string[]`（至少 1 项）, `environment?: Record<string,string>`, `enabled?: boolean`, `timeout?: number(ms)`。**无 `cwd` 字段** —— mcp/index.ts:417 取 `InstanceState.directory` 作为子进程 cwd，等于 opencode 进程当前 cwd（在我们这就是 worktree）。
- **Remote**：`type:"remote"`, `url: string`, `enabled?: boolean`, `headers?: Record<string,string>`, `oauth?: McpOAuthConfig | false`, `timeout?: number(ms)`。

我们对外（DB / API / UI）使用更直觉的名字：`env`（→ `environment`）、`timeoutMs`（→ `timeout`）。注入到 inline JSON 的瞬间做翻译；纯函数，单测覆盖。

### 0.4 工具命名

mcp/index.ts:684：`result[sanitize(clientName) + "_" + sanitize(mcpTool.name)] = ...`，`sanitize = s => s.replace(/[^a-zA-Z0-9_-]/g, "_")`。

我们的 MCP name regex `^[a-z0-9][a-z0-9_-]*$` 全部命中 sanitize 白名单 → **MCP name 在 opencode 工具池里保持不变**。用户在 agent.permission 里点名某具体工具可写 `permission: { "postgres-prod_query": "ask" }`。这点写进 UI 的 "Naming convention" tooltip 即可。

### 0.5 加载时机 & 关闭

`InstanceState.make` 是 lazy（首次 `state` 访问才执行），但 `opencode run` 模式启动后立刻会有 prompt 处理触发 `tools()`，因此**等价于每进程启动一次 MCP 创建开销**。`Effect.addFinalizer`（mcp/index.ts:551-572）确保进程退出时 stdio MCP 子进程被 SIGTERM 关闭，包含 `descendants(pid)` 兜底（防孙子进程泄漏）。runner 现有的 `safeKill` + 30s graceful 完全兼容，无须特别处理。

### 0.6 OAuth 凭据持久化

Remote MCP 的 OAuth 流程把 token 写到 opencode 的 `McpAuth.Service`（`~/.opencode/auth/...`）。这部分**进程级共享**：用户在主机上跑过一次 `opencode mcp auth <name>` 之后，所有 opencode 子进程都能复用 token。我们 v1 不在 UI 触发 OAuth；只为 "已经 PAT/header 的 Remote MCP" 提供 headers 字段。

---

## 1. 总体形状

```
┌───────────────────┐    name list      ┌───────────────────┐
│   Agent (frontmatter)   │ ───────────────▶ │   MCP (DB row)    │
│   mcp: [a,b,c]    │                   │   type + config   │
└───────────────────┘                   └───────────────────┘
         │ dependsOn 闭包                          │
         ▼                                         │
┌───────────────────┐                              │
│   agentDeps       │   union of mcp names         │
│   .computeClosure │ ─────────────────────────────┘
└───────────────────┘                              │
         │                                         ▼
         ▼                            ┌────────────────────────────┐
┌───────────────────┐                 │   buildInlineConfig        │
│   runner.runNode  │ ──────────────▶ │   { agent: {...},          │
│                   │                 │     mcp:   {...} } ←─新   │
└───────────────────┘                 └────────────────────────────┘
         │
         ▼
   spawn opencode  (env.OPENCODE_CONFIG_CONTENT)
```

数据流要点：

- MCP 资源完全独立于 workflow / task；**不在** workflow YAML 里出现。
- agent 只声明 MCP **名字**，配置体不重复存储；runner 启动时按名查 DB 拼装。
- dependsOn 闭包合并由现成的 `services/agentDeps.ts:computeClosure` 完成；我们只需要在闭包遍历同时收集每个成员的 `mcp[]` 并集。

## 2. 数据模型

### 2.1 新表 `mcps`

```ts
// packages/backend/src/db/schema.ts
export const mcps = sqliteTable('mcps', {
  id: text('id').primaryKey(),                  // ULID
  name: text('name').notNull().unique(),         // /^[a-z0-9][a-z0-9_-]*$/
  description: text('description').notNull().default(''),

  /** 'local' | 'remote' */
  type: text('type').notNull(),

  /**
   * Type-specific config serialised as JSON.
   *   local : { command: string[], env?, cwd?, timeoutMs? }
   *   remote: { url: string, headers?, oauth?, timeoutMs? }
   * 单一 JSON 列让两种类型共存又不引入空列；前端 / shared zod 区分。
   */
  config: text('config').notNull().default('{}'),

  /** opencode 上的 enabled，默认 true；和 opencode mcp.enabled 一致 */
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

  schemaVersion: integer('schema_version').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
```

迁移：drizzle-kit generate 出 `00NN_mcps.sql`，daemon 启动跑现有 migration runner。

### 2.2 agents 表追加 `mcp` 列

```ts
mcp: text('mcp').notNull().default('[]'), // JSON array of mcp names
```

与现有 `skills` / `dependsOn` 列完全平行。迁移：`ALTER TABLE agents ADD COLUMN mcp TEXT NOT NULL DEFAULT '[]'`。

### 2.3 shared zod schema 新增 `packages/shared/src/schemas/mcp.ts`

```ts
export const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const McpNameSchema = z.string().min(1).max(128).regex(MCP_NAME_RE, '...')

const NonEmptyStringArray = z.array(z.string().min(1)).min(1)

export const McpLocalConfigSchema = z.object({
  command: NonEmptyStringArray,
  env: z.record(z.string(), z.string()).optional(),
  // NOTE: 不暴露 cwd —— opencode 端无此字段，stdio 子进程 cwd 由 opencode 进程 cwd 决定（= worktree）。
  timeoutMs: z.number().int().positive().optional(),
})

export const McpRemoteConfigSchema = z.object({
  url: z.string().url().refine((u) => u.startsWith('http://') || u.startsWith('https://')),
  headers: z.record(z.string(), z.string()).optional(),
  oauth: z.union([
    z.object({
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
      scope: z.string().optional(),
      redirectUri: z.string().optional(),
    }),
    z.literal(false),
  ]).optional(),
  timeoutMs: z.number().int().positive().optional(),
})

export const McpSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    name: McpNameSchema,
    description: z.string(),
    type: z.literal('local'),
    config: McpLocalConfigSchema,
    enabled: z.boolean(),
    schemaVersion: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  }),
  z.object({
    id: z.string(),
    name: McpNameSchema,
    description: z.string(),
    type: z.literal('remote'),
    config: McpRemoteConfigSchema,
    enabled: z.boolean(),
    schemaVersion: z.number().int(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  }),
])

export const CreateMcpSchema = /* 同上去掉 id/timestamps，name 必填，enabled.default(true) */
export const UpdateMcpSchema = CreateMcpSchema.omit({ name: true }).partial()
export const RenameMcpSchema = z.object({ newName: McpNameSchema })
```

### 2.4 agent schema 追加 `mcp` 字段

```ts
// packages/shared/src/schemas/agent.ts
export const AgentSchema = z.object({
  // ... existing fields ...
  mcp: z.array(McpNameSchema).default([]),
})
```

`CreateAgentSchema` / `UpdateAgentSchema` 同步加 `.default([])`。

## 3. 后端服务层

### 3.1 新文件 `packages/backend/src/services/mcp.ts`

参考 `services/agent.ts` 风格，导出：

```ts
export async function listMcps(opts): Promise<Mcp[]>
export async function getMcp(opts, name): Promise<Mcp | undefined>
export async function createMcp(opts, input: CreateMcp): Promise<Mcp>
export async function updateMcp(opts, name, patch: UpdateMcp): Promise<Mcp>
export async function renameMcp(opts, name, newName): Promise<Mcp>
export async function deleteMcp(opts, name): Promise<void>
export async function findAgentsReferencingMcp(opts, name): Promise<{id, name}[]>
```

实现要点：

- `createMcp` / `updateMcp` 用 zod 解析 `config` 后再 `JSON.stringify` 存表。
- `deleteMcp` 先调 `findAgentsReferencingMcp`；非空抛 `MCP_STILL_REFERENCED`，HTTP 层映射 409。
- `renameMcp` 在事务里改 `mcps.name` 同时更新所有引用它的 `agents.mcp` JSON 列里的字符串（参考 `services/skill.ts` 的 rename 逻辑）。

### 3.2 路由 `packages/backend/src/routes/mcps.ts`

```
GET    /api/mcps                    -> McpSchema[]
GET    /api/mcps/:name              -> Mcp | 404
POST   /api/mcps                    -> Mcp        (body: CreateMcp)
PUT    /api/mcps/:name              -> Mcp        (body: UpdateMcp)
POST   /api/mcps/:name/rename       -> Mcp        (body: { newName })
DELETE /api/mcps/:name              -> 204 | 409 { referencedBy: [...] }
```

在 `server.ts` 挂载，复用现有 token 鉴权中间件。

### 3.3 agent 校验扩展

`packages/backend/src/services/agent.ts` 在 `createAgent` / `updateAgent` 里：

```ts
if (input.mcp && input.mcp.length > 0) {
  const existing = await db.select({ name: mcps.name }).from(mcps)
  const known = new Set(existing.map((r) => r.name))
  const missing = input.mcp.filter((n) => !known.has(n))
  if (missing.length > 0) throw new AgentValidationError('mcp-not-found', missing)
}
```

`workflow.validator.ts` 在 agent 闭包检查里同步加 `mcp-not-found` 报错类型，复用 agentDeps 闭包遍历的访问者钩子。

### 3.4 闭包合并

`services/agentDeps.ts:computeClosure` 已返回 `Agent[]` 闭包数组。新增纯函数：

```ts
// services/mcpClosure.ts
export function collectMcpNamesFromClosure(closure: readonly Agent[]): string[] {
  const set = new Set<string>()
  for (const a of closure) for (const m of a.mcp ?? []) set.add(m)
  return [...set]
}

export async function loadMcpsByNames(db, names: string[]): Promise<Mcp[]> {
  if (names.length === 0) return []
  return db.select().from(mcps).where(inArray(mcps.name, names))
}
```

两者均纯函数 / 单查询，方便单测。

### 3.5 runner 注入

`packages/backend/src/services/runner.ts` 改造点（**只**改 buildInlineConfig 与 runNode 的拼装路径）：

1. `RunNodeOptions` 追加 `mcps?: ResolvedMcp[]`（与 `dependents?: readonly Agent[]` 风格一致）。
2. `runNode` 在调用 `buildInlineConfig` 之前由 scheduler 注入 `mcps`，已经经过 `collectMcpNamesFromClosure → loadMcpsByNames` 解析。
3. `buildInlineConfig` 增 `mcps` 参数：

```ts
export function buildInlineConfig(
  agent: Agent,
  overrides: AgentOverrides | undefined,
  dependents: readonly Agent[],
  mcps: readonly Mcp[],          // NEW
): { agent: Record<string, Record<string, unknown>>; mcp?: Record<string, unknown> } {
  const agentMap = /* unchanged */
  const out: { agent: Record<string, Record<string, unknown>>; mcp?: Record<string, unknown> } = {
    agent: agentMap,
  }
  if (mcps.length > 0) {
    const mcp: Record<string, unknown> = {}
    for (const m of mcps) {
      // `enabled === false` 仍然写进 inline（schema 接受 `{enabled:false}` 半结构，
      // 让 opencode 把 status 直接置 disabled；与"完全不写"相比，能 shadow 掉同名
      // repo .opencode/config.json 里 enabled=true 的同名 MCP 的子集字段）。
      // 但为减少环境变量体积，本 RFC v1 默认 enabled=false 的 MCP 直接 skip（用户
      // 想"显式禁用 inherited 同名"时切到 enabled=true 然后再 toggle 即可）。
      if (m.enabled === false) continue
      mcp[m.name] = m.type === 'local'
        ? pruneUndefined({
            type: 'local',
            command: m.config.command,
            environment: m.config.env,              // env  → environment
            enabled: m.enabled,
            timeout: m.config.timeoutMs,            // timeoutMs → timeout
          })
        : pruneUndefined({
            type: 'remote',
            url: m.config.url,
            headers: m.config.headers,
            oauth: m.config.oauth,
            enabled: m.enabled,
            timeout: m.config.timeoutMs,
          })
    }
    if (Object.keys(mcp).length > 0) out.mcp = mcp
  }
  return out
}
```

注意 opencode 端字段名是 `environment` / `timeout`（见 `opencode/packages/opencode/src/config/mcp.ts`），平台 schema 用更直觉的 `env` / `timeoutMs`，注入时翻译。这层翻译纯函数，单测覆盖。

4. scheduler 调用 runner 之前预加载 MCP：

```ts
// services/scheduler.ts
const closure = await agentDeps.computeClosure(db, agent)
const mcpNames = collectMcpNamesFromClosure(closure)
const mcps = await loadMcpsByNames(db, mcpNames)
await runNode({ ..., dependents: closure, mcps })
```

5. 32 KiB 软警告复用：日志里新增 `mcpCount` 字段，定位"是不是哪个 MCP 把 env 撑爆了"。

### 3.6 日志 redact

`packages/backend/src/util/log.ts:redactSensitiveString` 已存在（RFC-024）。MCP env / headers 的值进入日志前过它一遍；spawn opencode 时 inline JSON 写日志的位置（`runner.ts:238` 那条 `spawning opencode`）追加：

```ts
mcpKeys: mcps.map((m) => m.name), // 只 log 名字，不 log config 体
```

不 dump 完整 inlineConfig.mcp 到日志。

## 4. 前端

### 4.1 新页面 `/mcps`

`packages/frontend/src/pages/Mcps.tsx`，与 `Skills.tsx` 同构：

- 顶栏：Title + 搜索 + "New MCP" 按钮。
- 列表：行 = name + description + type chip + enabled toggle + 编辑/删除按钮。
- 详情 drawer（点击行展开）：
  - Type radio（local / remote）切换表单字段。
  - Local 表单：command（chip 数组输入）、env（kv 列表）、cwd、timeoutMs。
  - Remote 表单：url、headers（kv 列表）、oauth（折叠区，留空即不开 OAuth）、timeoutMs。
  - 「Validate JSON」按钮：本地跑 zod 校验，给出友好错误。

### 4.2 Agent 编辑表单

`packages/frontend/src/components/agents/AgentEditor.tsx`（按现有路径推断）在 Skills picker 下方加 `<McpPicker />`：

- 多选 chip，选项来自 `useQuery(['mcps'], listMcps)`；空状态显示 "No MCPs yet —" + 跳到 /mcps 的链接。
- 与 Skills picker 共用同一行风格。

### 4.3 节点详情 Stats tab

复用 RFC-022 的「闭包依赖树」面板，在已有 agent 节点树下追加一个折叠区"MCP closure"：列出闭包合并后将注入的 MCP name + type。

### 4.4 agent.md 导入

`shared/agentMdParser.ts`（RFC-018 已落）识别 frontmatter `mcp:` 字段为字符串数组，类型同 `skills`。AgentImportDialog 把缺失 MCP 列在原"缺失 skill"区域旁边，文案模板复用，参数化 `missingResource: 'skill'|'mcp'`。

### 4.5 i18n

新增 key：`mcp.list.title`、`mcp.form.type.local`、`mcp.form.command`、`mcp.delete.referencedBy` 等。zh-CN 与 en-US 必须同步；CI 已有 i18n key 缺漏检查（按现有 lint 流）。

## 5. 兼容与迁移

- 现存 agent 的 `mcp` 列由 `DEFAULT '[]'` 填充；老 agent 保存时如果前端不传 mcp，仍是空数组。
- 现存 workflow 不变。
- 现存 task / node_runs 不变。
- 现存 YAML 导入导出不变。
- opencode 最低版本：MCP 自 opencode 0.x 起即支持（已在 P-0-01 锁的版本之内）；本 RFC 不再上抬最低版本。

## 6. 失败模式

| 场景 | 行为 |
| --- | --- |
| agent 引用了不存在的 MCP | save 阶段 `mcp-not-found` 422；workflow validator 同步报错 |
| MCP local command 启动失败 | opencode 子进程内 `connectLocal` 失败 → MCP status=failed（mcp/index.ts:412-444），错误进 opencode log；runner 端只看到子进程 stderr "local mcp startup failed" 行 → 落 node_run_events，不杀本 node（agent 仍可在没 MCP 的情况下工作） |
| MCP remote 401 / OAuth 缺凭据 | opencode 端落 status=needs_auth + bus toast；run 模式下进程退出码仍 0，agent 自行决定要不要用该 MCP。**用户应在主机上先 `opencode mcp auth <name>` 一次**，token 持久化到 `~/.opencode/auth/...` 后所有子进程复用 |
| OPENCODE_CONFIG_CONTENT 超大 | 已有 32 KiB warn，日志带 `mcpCount` + `mcpKeys` |
| 删除被引用 MCP | 409，body `{ code: 'mcp-still-referenced', referencedBy: [{id, name}] }` |
| rename 与他名冲突 | 409 `name-conflict`（参考 skill rename） |
| dependsOn 闭包合并里出现同名 MCP | Set 去重，幂等 |
| **repo `.opencode/config.json` 已有同名 MCP** | opencode `mergeDeep` 深合并；inline 字段胜出，未覆盖字段保留 repo 值。本 RFC v1 **不**主动屏蔽 inherited MCP；用户若要隔离，把 repo MCP 改名或删掉即可 |
| **agent 没声明 MCP，但 repo `.opencode/config.json` 里有 MCP** | 该 MCP **仍会被 opencode 加载**（process-global），其工具会出现在 agent 的 tool pool。这与现状一致（与 skill 的 `.opencode/skills/` 行为对齐：未在 agent.skills 里也照样被 opencode 扫描）。如要严格"agent 没声明 = 不可见"，需未来 RFC 在 inline 写 `mcp.<every-repo-mcp> = { enabled: false }`，本 RFC v1 不实现 |

## 7. 测试策略

### 7.1 必写单测（pure function）

- `shared/schemas/mcp.test.ts`：Local / Remote 正向 + 负向（空 command、非 http url、env 非字符串等）。
- `services/mcpClosure.test.ts`：
  - 空闭包 → 空 MCP 列表
  - 单 agent + 2 MCP → 2 MCP
  - 闭包内同名 MCP 去重
  - dependsOn 闭包 ABC，A→[m1] B→[m1,m2] C→[m3] → 合并 [m1,m2,m3]
- `services/runner.buildInlineConfig.test.ts`（扩展现有文件）：
  - mcps 空 → inline 不含 mcp 字段
  - 含 1 Local → mcp.{name} 字段名翻译正确（env → environment，timeoutMs → timeout）
  - 含 1 Remote + oauth=false → 透传
  - enabled=false → 跳过

### 7.2 服务层 / 路由集成测

- `routes/mcps.test.ts`：CRUD happy path + 409（still-referenced）+ 409（name-conflict）+ 422（schema 错）。
- `services/agent.test.ts`（扩展）：create agent with unknown mcp → 422。
- `services/agentDeps.test.ts`（扩展）：computeClosure 不动，断言闭包结果与 MCP 合并下游的 `mcpClosure` 行为可组合。

### 7.3 e2e（playwright）

- `tests/e2e/mcp.happy-path.spec.ts`：
  1. 在 /mcps 新建一个 local MCP（command=`["bash","-lc","echo hi"]`）
  2. 在 /agents 新建一个 agent 勾上该 MCP
  3. 在 workflow editor 拖该 agent，run task
  4. 断言 task 详情页 node-run 的 spawn 日志含 `mcpCount: 1`，且 worktree 实际执行无错

### 7.4 源码层兜底断言

- `tests/locks/mcp-no-inline-in-agent.test.ts`：grep `packages/backend/src/services` 不应出现"在 agent.ts 里直接 spawn"等违反单一注入点的字样。
- `tests/locks/redact-mcp-env.test.ts`：扫 runner.ts，断言 spawn log 行不直接 stringify mcp 配置体。

## 8. 与其它 RFC 的相互作用

- **RFC-022 dependsOn**：本 RFC 完全复用其闭包；如果 dependsOn 实现有调整，MCP 合并自动跟随。
- **RFC-023 Clarify** / **RFC-026 Clarify inline-session**：clarify 重跑路径走的也是 `runNode`，inline config 由 scheduler 重新计算，自动带上 MCP。
- **RFC-027 Node session view**：MCP 不产生新的 node_run_events 字段，只有 opencode 自己的 tool_use 事件会带 MCP server 名。session view 不需要改。
- **RFC-018 agent.md import**：parser 加 `mcp` 字段识别。
- **RFC-019 skill-zip**：本 RFC 不附加 zip 导入；后续如要做 mcp-zip 仿照此 RFC 的延伸 RFC。

## 9. 安全 / 隐私

- env / headers 值落 DB 明文（与 skill body 一致）；DB 文件在 `~/.agent-workflow/db.sqlite`，由 OS 用户级权限保护。
- API 响应里返回完整 config（用户自己看自己的配置）；日志只记 name。
- 后续 RFC（vault）会把 env / headers 改为引用 `${secret:name}`，本 RFC 预留 zod refine 钩子：值字符串以 `${secret:` 开头时不做长度强校验，方便平滑迁移。

## 10. 开放问题（实现期再定）

- MCP 是否需要 enable/disable 全局开关（settings 里"暂时禁用所有 MCP 注入"用于排障）？倾向 v1 不做，必要时把 agent.mcp 临时清空即可。
- 列表分页：v1 不分页（与 /api/skills 当前实现一致），数量上限纯靠 UI 提示。
- **是否屏蔽 inherited（repo `.opencode/config.json`）MCP**：见 §6 末两行。v1 不实现，但 design 已锚定"未来通过 `mcp.<name>={enabled:false}` 逐条 shadow"的兜底路径，schema 已经接受这个形态。
- **`agent.permission` map 是否要给 MCP 工具暴露专门 picker**：opencode 的 `permission` 用工具名（即 `{mcp-name}_{tool-name}`，§0.4）。v1 让用户在 agent 表单的 frontmatterExtra / permission 区手写；UI tooltip 提示命名规则即可。MCP 详情页可选展示该 MCP 暴露的工具名预览（v1 不实现，待后续 RFC）。
