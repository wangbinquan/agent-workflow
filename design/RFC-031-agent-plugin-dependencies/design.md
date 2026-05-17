# RFC-031 — 技术设计

## 0. opencode 端事实（实现前必读）

源码路径以 `/Users/wangbinquan/Documents/code/opencode` 为根。

### 0.1 plugin 在 opencode 进程内是**全局**的

`plugin/index.ts` 的 `init` 把所有 hooks 注册到一个进程级 `State.hooks` 数组，`trigger(name, input, output)` 顺序调用全部命中 hook。没有 per-agent / per-session scope —— 与 RFC-028 §0.1 描述的 MCP 完全同构。

### 0.2 plugin 配置合并语义

- 配置字段：`config.plugin: Spec[]`，定义在 `config/plugin.ts:11-13`：
  ```ts
  export const Spec = Schema.Union([Schema.String, Schema.mutable(Schema.Tuple([Schema.String, Options]))])
  ```
- 即每个 spec 要么是字符串（"my-plugin@1.0.0" / "file://..." / "github:org/repo"），要么是 `[spec, options]` 元组。
- `config/config.ts:480-510` 在多 config 文件合并时把 plugin 数组**拼接 + 去重**（按"npm 包名 / 文件 URL"作 key，见 `deduplicatePluginOrigins`）。
- **关键**：`OPENCODE_CONFIG_CONTENT` inline JSON 在合并顺序里**最后写入**（与 agent / mcp / skill 配置同栈），所以本框架闭包注入的 plugin 自动赢过 repo `.opencode/config.json`。

### 0.3 plugin spec → entry 解析路径

`plugin/loader.ts` 的 `resolve(plan, kind)`：
1. `resolvePluginTarget(spec)`（`shared.ts`）：
   - `isPathPluginSpec(spec)` true → `resolvePathPluginTarget`（直接当文件路径，不联网）；
   - 否则 `Npm.add(pkg)` → npm CLI 拉取（**支持 npm 包、git URL、github shorthand**，npm 内部走 npm-package-arg）。
2. `createPluginEntry`：拿 package.json 里 `opencode.server` / `opencode.tui` / fallback 默认 entry。
3. `checkPluginCompatibility`：版本范围校验。
4. 动态 `import(entry)`。

**本 RFC 利用 step 1 的两条路径**：
- 框架自己用 `npm install --prefix <pluginDir>` 把包安装到独占目录，落地后产物等价于 `Npm.add`（甚至更稳定，因为我们控制 prefix）；
- 注入时给 opencode 的是 `file://<entryAbsPath>`，opencode 走 `resolvePathPluginTarget` 完全跳过 npm。

### 0.4 plugin 执行时机

`plugin/index.ts:init` 在 opencode 进程 boot 早期跑（先 server context 建立、再 init plugins、再 spawn session）。失败的 plugin 会被记录但**不阻塞进程**（loader 的 `error` report 只 log，不 throw）。因此我们注入失败 plugin 不会让节点直接挂，但 hook 不生效——必须在 node_run_events 显式提示。

### 0.5 不要做什么

- **不**用 `OPENCODE_DISABLE_*` 类 flag（opencode 没这一档，与 MCP 设计一致）。
- **不**直接编辑 `~/.opencode/config.json` —— 与 skill/MCP/agent 一样靠 `OPENCODE_CONFIG_CONTENT`。
- **不**在 spawn 路径上做 npm install —— 那是急安装阶段的事。

## 1. 总体形状

```
┌─────────── UI ─────────────┐    ┌─────────── daemon ──────────────┐
│ /plugins 列表 / 详情表单    │ →  │ routes/plugins.ts                │
│   ↓ 保存 / 升级 → POST       │    │   → services/plugin.ts (CRUD)    │
│ /agents 编辑 → Plugins picker│    │   → services/pluginInstaller.ts │
│ AgentImportDialog 缺失提示   │    │       (npm install --prefix)    │
└──────────────────────────────┘    │   → services/pluginClosure.ts   │
                                    │       (闭包合并)                 │
                                    │   → services/runner.ts          │
                                    │       buildInlineConfig.plugin  │
                                    └──────────────────────────────────┘
                                              ↓ spawn
                                    ┌──────────────────────────────────┐
                                    │ opencode 子进程                  │
                                    │   读 OPENCODE_CONFIG_CONTENT     │
                                    │   .plugin = ["file://...", opts] │
                                    │   loader.resolve → 走本地路径    │
                                    └──────────────────────────────────┘
```

物理布局：

```
~/.agent-workflow/
  plugins/
    01HXXXXX...01/        ← plugin.id (ULID)
      node_modules/
        @mycorp/opencode-dd-trace/  ← 实际 package
          package.json
          dist/index.js
      package.json         ← npm install 自动生成的 host package
      package-lock.json
    01HXXXXX...02/
      ...                  ← file: plugin 不在这里，cachedPath 直接指 realpath
```

## 2. 数据模型

### 2.1 新表 `plugins`

`packages/backend/src/db/schema.ts`：

```ts
export const plugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),                          // ULID
  name: text("name").notNull().unique(),                // 引用名，regex /^[a-z0-9][a-z0-9_-]*$/
  spec: text("spec").notNull(),                         // 原始 spec
  optionsJson: text("options_json").notNull().default("{}"),  // JSON.stringify(options) 或 "{}"
  description: text("description"),                      // 可空
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),

  // install 产物（npm/git 时由安装器写；file: 时为 realpath）
  cachedPath: text("cached_path").notNull(),            // 绝对路径或 file:// URL
  resolvedVersion: text("resolved_version"),             // npm: package.json.version, git: commit sha, file: mtime hash
  sourceKind: text("source_kind", { enum: ["npm", "file", "git"] }).notNull(),

  installedAt: integer("installed_at").notNull(),       // unix ms
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
})
```

migration 文件：`packages/backend/db/migrations/00NN_rfc031_plugins.sql`。

### 2.2 agents 表追加 `plugins` 列

```ts
// schema.ts
plugins: text("plugins").notNull().default("[]"),  // JSON.stringify(["name1","name2"])
```

老数据迁移：默认 `'[]'`，无需 backfill。

### 2.3 shared zod schema 新增 `packages/shared/src/schemas/plugin.ts`

```ts
export const PluginNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).min(1).max(64)

export const PluginOptionsSchema = z.record(z.string(), z.unknown()).default({})

export const PluginSpecSchema = z.string().min(1).max(512)

export const SourceKindSchema = z.enum(["npm", "file", "git"])

export const PluginSchema = z.object({
  id: z.string(),
  name: PluginNameSchema,
  spec: PluginSpecSchema,
  options: PluginOptionsSchema,
  description: z.string().max(4096).optional(),
  enabled: z.boolean().default(true),
  cachedPath: z.string(),
  resolvedVersion: z.string().nullable(),
  sourceKind: SourceKindSchema,
  installedAt: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})

export const CreatePluginSchema = z.object({
  name: PluginNameSchema,
  spec: PluginSpecSchema,
  options: PluginOptionsSchema.optional(),
  description: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
})

export const UpdatePluginSchema = CreatePluginSchema.partial()

export const RenamePluginSchema = z.object({ newName: PluginNameSchema })

export const PluginUpdateCheckSchema = z.object({
  available: z.boolean(),
  current: z.string().nullable(),
  latest: z.string().nullable(),
})
```

`packages/shared/src/index.ts` 出口：`export * from "./schemas/plugin"`。

### 2.4 agent schema 追加 `plugins` 字段

`packages/shared/src/schemas/agent.ts`：

```ts
plugins: z.array(PluginNameSchema).default([]),
```

`AgentSchema` / `CreateAgentSchema` / `UpdateAgentSchema` 同步加。

## 3. 后端服务层

### 3.1 新文件 `packages/backend/src/services/plugin.ts`

```ts
listPlugins(db): Promise<Plugin[]>
getPlugin(db, idOrName): Promise<Plugin | null>
createPlugin(db, input): Promise<Plugin>          // 内部调 installer
updatePlugin(db, id, input): Promise<Plugin>      // spec/options 改了 → 重 install
renamePlugin(db, id, newName): Promise<Plugin>    // 同步替换 referencing agents.plugins
deletePlugin(db, id): Promise<void>               // 引用检查 + 清缓存目录
findAgentsReferencingPlugin(db, name): Promise<{ id, name }[]>
```

错误类型（仿 `services/skill.ts`）：

```ts
class PluginStillReferencedError extends Error { code = "plugin-still-referenced"; referencedBy: AgentRef[] }
class PluginNameConflictError extends Error { code = "plugin-name-conflict" }
class PluginInstallFailedError extends Error { code = "plugin-install-failed"; stderr: string; exitCode: number }
class PluginInstallTimeoutError extends Error { code = "plugin-install-timeout" }
class NpmUnavailableError extends Error { code = "npm-unavailable" }
```

### 3.2 新文件 `packages/backend/src/services/pluginInstaller.ts`

核心职责：把一个 spec 在专属目录里"安装好"，返回 `{ cachedPath, resolvedVersion, sourceKind }`。

```ts
interface InstallResult {
  cachedPath: string         // 绝对路径
  resolvedVersion: string | null
  sourceKind: "npm" | "file" | "git"
}

async function installPlugin(spec: string, pluginDir: string, opts?: { timeoutMs?: number }): Promise<InstallResult>
async function probeNpmBinary(): Promise<boolean>   // daemon 启动时调一次
async function checkForUpdate(spec: string, currentVersion: string | null): Promise<{ available: boolean; latest: string | null }>
async function cleanupPluginDir(pluginDir: string): Promise<void>
```

**实现要点**：

1. **sourceKind 推断**（参考 opencode `shared.ts:isPathPluginSpec`）：
   - 以 `file:` / `/` / `.` / `[A-Z]:\\` 开头 → `file`
   - 以 `git+` / `github:` / `gitlab:` / `bitbucket:` 开头 → `git`
   - 否则 → `npm`
2. **file**：`fs.realpath` 校验 + `stat` 拿 mtime → `resolvedVersion = mtime.toString(16)`；cachedPath = 真实路径。
3. **npm / git**：
   - `mkdirp pluginDir`
   - `await Bun.write(path.join(pluginDir, "package.json"), JSON.stringify({ name: "aw-plugin-host", version: "1.0.0", dependencies: {} }))`
   - `Bun.spawn(["npm","install","--prefix", pluginDir, "--no-audit","--no-fund","--silent", spec], { stdout: "pipe", stderr: "pipe", timeout: opts?.timeoutMs ?? 60_000 })`
   - 超时 → kill + 抛 `PluginInstallTimeoutError`
   - 非零退出 → 收集 stderr 头 2 KiB（过 `redactSensitiveString`） → 抛 `PluginInstallFailedError`
   - 成功后读 `pluginDir/package.json` → 拿 `dependencies` 唯一 entry 的 packageName → 读 `pluginDir/node_modules/<pkg>/package.json` → `resolvedVersion = pkg.version`；cachedPath = `pluginDir/node_modules/<pkg>` 的绝对路径。
4. **检查 npm 二进制**：`probeNpmBinary` 一次性 `Bun.spawn(["npm","--version"])`；daemon 启动时缓存结果到 module-local。
5. **redact**：错误响应 / 日志统一过 `redactSensitiveString`（RFC-024 已有），避免 spec 含 token 的情况（如 `git+https://x-token-auth:TOKEN@bitbucket.../repo.git`）泄漏。
6. **并发保护**：同一 plugin id 的 install 路径用 in-flight Map<id, Promise>，第二次调用 await 同一 promise，防止 npm install 并发互相破坏目录。

### 3.3 路由 `packages/backend/src/routes/plugins.ts`

```
GET    /api/plugins                       → listPlugins
POST   /api/plugins                       → createPlugin
GET    /api/plugins/:id                   → getPlugin
PUT    /api/plugins/:id                   → updatePlugin
DELETE /api/plugins/:id                   → deletePlugin
POST   /api/plugins/:id/rename            → renamePlugin
POST   /api/plugins/:id/check-update      → checkForUpdate
POST   /api/plugins/:id/upgrade           → 重新 install 当前 spec，覆盖缓存
```

错误映射：

| Error                              | HTTP |
| ---------------------------------- | ---- |
| PluginStillReferencedError         | 409  |
| PluginNameConflictError            | 409  |
| PluginInstallFailedError           | 422  |
| PluginInstallTimeoutError          | 422  |
| NpmUnavailableError                | 422  |
| 404 (not found)                    | 404  |
| zod                                | 422  |
| 缺 token                            | 401  |

挂到 `server.ts`：

```ts
app.route("/api/plugins", pluginsRoute)
```

### 3.4 agent 校验扩展

`services/agent.ts` 在 create / update 时：

```ts
for (const name of input.plugins ?? []) {
  const plugin = await getPlugin(db, name)
  if (!plugin) throw new ValidationError({ code: "plugin-not-found", name })
  if (!plugin.enabled) throw new ValidationError({ code: "plugin-disabled", name })
}
```

`services/workflow.validator.ts` 在闭包检查里追加：闭包内任一 agent 引用的 plugin 缺失 → 报 `plugin-not-found`。

### 3.5 闭包合并

新文件 `packages/backend/src/services/pluginClosure.ts`：

```ts
export function collectPluginNamesFromClosure(closure: AgentDescriptor[]): string[] {
  const set = new Set<string>()
  for (const a of closure) for (const n of a.plugins ?? []) set.add(n)
  return [...set].sort()  // 排序保证注入稳定，便于断言
}

export async function loadPluginsByNames(db: DbClient, names: string[]): Promise<Plugin[]> {
  if (names.length === 0) return []
  const rows = await db.select().from(pluginsTable).where(inArray(pluginsTable.name, names))
  return rows.map(rowToPlugin)
}
```

### 3.6 runner 注入

`services/runner.ts` 的 `RunNodeOptions` 加：

```ts
plugins?: Plugin[]
```

`buildInlineConfig` 改造：

```ts
function buildInlineConfig({ agent, dependsOnAgents, mcps, plugins, ... }): InlineConfig {
  const cfg: InlineConfig = { agent: {...} }
  if (mcps?.length) cfg.mcp = buildMcpInline(mcps)
  if (plugins?.length) {
    cfg.plugin = plugins.filter(p => p.enabled).map(p => {
      const pathSpec = p.cachedPath.startsWith("file://") ? p.cachedPath : pathToFileURL(p.cachedPath).href
      const opts = p.options && Object.keys(p.options).length > 0 ? p.options : undefined
      return opts ? [pathSpec, opts] : pathSpec
    })
  }
  return cfg
}
```

**关键不变量**：
- 注入 spec 必须形如 `file://...`（即使原 spec 是 npm）；
- 有 options → 元组；无 options → 字符串；与 opencode `Spec` union 一致；
- `enabled=false` 的 plugin 整条不进入 inline；
- 闭包去重已经由 `collectPluginNamesFromClosure` 保证；
- spawn log：`pluginCount` + `pluginNames`，**不** dump options（可能含 token）。

`services/scheduler.ts` 在调 `runNode` 前：

```ts
const pluginNames = collectPluginNamesFromClosure(closure)
const plugins = await loadPluginsByNames(db, pluginNames)
return runNode({ ..., mcps, plugins })
```

### 3.7 日志 redact + 失败兜底事件

opencode 子进程 stderr 里如果有 `[plugin] error` 类行（参考 opencode `loader.ts` 的 `error` report 输出格式），runner 在 stream 解析层 tag 成 `[rfc031/plugin-load-failed]` 写到 `node_run_events`。前端节点详情 events 列表（RFC-027 已有）渲染成 warning 卡片，含 plugin name + 错误一句话。

## 4. 前端

### 4.1 新页面 `/plugins`

`packages/frontend/src/pages/Plugins.tsx`，router 注册 `routes/plugins.tsx`。

列表列：
- name
- spec（截断，hover tooltip 全文）
- sourceKind chip（npm / file / git）
- resolvedVersion
- referencedBy count
- 操作：编辑 / 检查更新 / 升级 / 删除

表单字段：
- name（regex 校验）
- spec（textarea，placeholder 给三类示例）
- options（JSON 编辑器，必须能解析为 object）
- description（可选）
- enabled toggle

保存时显示 spinner（install 进行中），失败显示 stderr 截断到 2 KiB。

顶部 banner：`probeNpmBinary` 返 false 时显示"未检测到 npm 二进制，仅支持本地路径 plugin"。

### 4.2 Agent 编辑表单

`components/agents/AgentEditor.tsx` 在 MCPs picker 下追加 `<PluginPicker />`。
- 多选 chip
- 选项来自 `GET /api/plugins`（只列 enabled=true）
- 空状态："还没有 plugin？去创建" → /plugins
- 同 Skills/MCPs 风格

### 4.3 节点详情 Stats tab

RFC-022/028 已有的闭包资源段落里追加 Plugins 折叠区：列出闭包内所有 plugin 的 name + version chip。

### 4.4 agent.md 导入

`packages/shared/src/agentMdParser.ts`（RFC-018）识别 frontmatter `plugins:` 字符串数组。`AgentImportDialog` 缺失 plugin 提示与缺失 skill/mcp 共用模板。

### 4.5 i18n

zh-CN / en-US 新增 key 域 `plugin.*`：列表标题、表单字段、错误码、check-update 文案、升级确认对话框。

## 5. 兼容与迁移

- DB migration `00NN_rfc031_plugins.sql`：CREATE TABLE plugins + ALTER TABLE agents ADD COLUMN plugins TEXT NOT NULL DEFAULT '[]'。down migration：DROP TABLE plugins + ALTER TABLE agents DROP COLUMN plugins（sqlite 走 CREATE TABLE new ... + INSERT ... + DROP old + RENAME）。
- 不影响旧 agent / 旧 workflow（默认 `plugins=[]`）。
- shared schema 默认值兜底，前端旧 cache 数据反序列化时缺字段也能解析。

## 6. 失败模式

| 场景 | 表现 | 兜底 |
| --- | --- | --- |
| npm install 网络断 | 60s 超时 → 422 | UI 提示重试 |
| spec 拼错（包不存在） | npm exit != 0 → 422 + stderr | UI 显示 stderr 头部 |
| 本地路径不存在 | realpath ENOENT → 422 | 一致 |
| 缓存目录被外部删除 | spawn 时 opencode 读 entry 报错 → `[rfc031/plugin-load-failed]` 事件 | UI 在节点详情提示，引导用户去 /plugins 重 install |
| plugin 自身代码运行时抛错 | opencode 的 loader 写 stderr，不挂进程 | runner tag 成事件，节点详情可见 |
| 同 plugin id 并发 install | in-flight Map 串行化 | 单一 promise 复用 |
| daemon 重启时正在 install | 进程内事件，重启后无残留；DB 没落记录因为 install 失败抛错 | 无副作用 |

**不**主动屏蔽 repo `.opencode/config.json` 已有 plugin —— 同名时 opencode 用 deduplicatePluginOrigins 自然去重，inline 后写入会赢；不同名时两组都加载（与 MCP/skill 现有策略一致）。

## 7. 测试策略

### 7.1 必写单测（pure function）

- `packages/shared/tests/plugin-schema.test.ts`：
  - name regex 边界、spec 长度上限、options 必须 object、resolvedVersion 可空。
  - 断言 schema **不接受** spec 为 `["foo", "bar"]` 元组（因为 Spec 元组是 opencode 配置形态，不是 DB 存储形态）。
- `packages/shared/tests/agent-plugins.test.ts`：AgentSchema.plugins 默认 `[]`、非法 name 报错。
- `packages/backend/tests/services/pluginClosure.test.ts`：
  - 空闭包 → 空数组
  - 单 agent / dependsOn 闭包合并去重
  - 排序稳定（输出与输入顺序无关）
  - loadPluginsByNames：空数组 → 空、传不存在名 → 略过（不抛）。
- `packages/backend/tests/services/runner.buildInlineConfig.test.ts`：
  - plugins 空 → inline 对象不含 `plugin` key
  - 含 1 个无 options plugin → `plugin: ["file://..."]`
  - 含 options → `plugin: [["file://...", { foo: "bar" }]]`
  - `enabled=false` 整条不进入
  - 闭包合并：传入两份指向同一 plugin.name → inline 里只出现一次
  - **源码兜底锚**：grep `buildInlineConfig` 实现包含字符串 `'plugin'` + `'file://'` 前缀生成路径（防 refactor 误写为直接透传 spec）。

### 7.2 服务层 / 路由集成测

- `packages/backend/tests/services/pluginInstaller.test.ts`：
  - file: spec → realpath 成功 + resolvedVersion 是 mtime hash
  - 用 fixture local plugin（包含 package.json）走 `file://` 路径，断言不调 npm
  - npm path：用 `MOCK_NPM_BIN=./tests/mocks/fake-npm.sh` 注入假 npm，模拟成功 / 失败 / 超时三态
  - in-flight Map：并发 2 个同 id 调用，断言 npm 只被调一次
- `packages/backend/tests/services/plugin.test.ts`：
  - create → list → update → rename → delete happy path
  - delete 时存在引用 → still-referenced + referencedBy 列表
  - rename 时新名已被占 → name-conflict
  - rename 成功后 referencing agent 的 plugins 列字符串同步替换
  - delete 成功后 plugin 目录被清理（断言 fs 不存在）
- `packages/backend/tests/routes/plugins.test.ts`：
  - GET/POST/PUT/DELETE/rename/check-update/upgrade 全路径 200/201/204
  - 409 still-referenced + body shape
  - 422 zod 错 + plugin-install-failed + npm-unavailable
  - 鉴权：缺 token 401
- `packages/backend/tests/services/agent.test.ts` 扩展：unknown plugin → 422、disabled plugin → 422。
- `packages/backend/tests/services/workflow.validator.test.ts` 扩展：workflow 用了 agent，agent.plugins 缺失 → `plugin-not-found`。
- `packages/backend/tests/migration-00NN-plugins.test.ts`：跑完 migration 后 `plugins` 表存在 + `agents.plugins` 列存在 + 默认 `'[]'`。

### 7.3 e2e（playwright）

`tests/e2e/plugin.happy-path.spec.ts`：

1. 用 fixture 准备一个本地 plugin 目录（含 package.json + opencode hook 输出 `[fixture-plugin] loaded`）。
2. UI 进 /plugins → New → 填本地路径 → 保存 → 列表出现 + version 显示 mtime hash。
3. UI 进 /agents → 新建 agent → Plugins picker 勾上 → 保存。
4. UI 启动 task（mock-opencode 模式拦截 spawn env，把 `OPENCODE_CONFIG_CONTENT` 写到 stub 输出）→ 断言 stub 输出中 plugin 数组包含 `file://...`。
5. 删除 plugin（被引用）→ 弹 409 提示 + 引用 agent 列表。

### 7.4 源码层兜底断言

- `tests/locks/runner-inline-plugin.test.ts`：grep `services/runner.ts` 中 `cfg.plugin` 赋值附近必须出现 `file://` 字符串 + `enabled` 过滤。
- `tests/locks/plugins-page-uses-i18n.test.ts`：page 文件不含硬编码中英文标题字串。
- `tests/locks/plugin-installer-spawns-npm.test.ts`：grep `pluginInstaller.ts` 必须包含 `"--prefix"` 字符串（防未来误写到 `cwd: pluginDir` 致 npm install 到错误目录）。

## 8. 与其它 RFC 的相互作用

- **RFC-022 dependsOn**：plugin 闭包合并 piggyback 在 dependsOn 闭包之上，不引入新闭包计算逻辑。
- **RFC-028 MCP**：plugin 与 MCP 在 inline JSON 里**互不相干**（一个写 `mcp`，一个写 `plugin`），但二者都依赖同一份"闭包合并 → 加载 → 注入"骨架。两 RFC 的服务层文件 `mcpClosure.ts` / `pluginClosure.ts` 形态对齐，便于未来抽公共。
- **RFC-029 inventory snapshot**：opencode 自报的 plugin_origins 也会落 inventory，UI 详情页可对比"框架注入 vs opencode 看到"。本 RFC v1 不主动消费 inventory；后续可加"plugin 注入但 opencode 加载失败"红色 chip。
- **RFC-027 session view**：plugin load 失败事件 `[rfc031/plugin-load-failed]` 走 RFC-027 已有 events 渲染管道；本 RFC 只新增 tag 与文案。
- **RFC-018 agent.md 导入**：plugins 字段加进 parser 与缺失提示，复用现有 dialog 模板。

## 9. 安全 / 隐私

- plugin spec 可能含凭据（如 git URL with PAT）：DB 存原文，但 API 响应 / 日志走 `redactSensitiveString`。
- plugin options 可能含凭据：同上，禁止 dump 到 spawn log；inline JSON 通过 env 传给子进程，不写文件。
- plugin 目录权限：daemon 创建时 `chmod 700`，避免同主机其他用户读到。
- 删除 plugin 时显式删目录前再 stat 确认不在 DB 里有引用（双保险，避免 race）。

## 10. 开放问题（实现期再定）

- 是否给 plugin "全局 vs project-local" scope？目前 opencode `ConfigPlugin.Scope` 区分二者，本 RFC v1 默认全部当 global（仍按闭包注入），实践中若发现 project-local hook 行为差异再补字段。
- 自动更新检查节奏：v1 全手动；后续可加 cron + UI 红点。
- plugin 多版本并存：v1 用 plugin.id 隔离目录，天然支持同包不同版本两条 plugin 记录；UI 不强制 spec 去重，只强制 name 唯一。
