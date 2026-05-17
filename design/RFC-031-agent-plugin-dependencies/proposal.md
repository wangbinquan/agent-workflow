# RFC-031 — Agent Plugin 依赖：opencode plugin 资源化 + 急安装缓存 + 按需注入

| 字段 | 值 |
| --- | --- |
| 编号 | RFC-031 |
| 状态 | Draft |
| 作者 | binquanwang |
| 提交日期 | 2026-05-17 |
| 关联 | [RFC-017 skill source dir](../RFC-017-skill-source-directory/proposal.md), [RFC-022 agent dependencies](../RFC-022-agent-dependencies/proposal.md), [RFC-028 agent MCP deps](../RFC-028-agent-mcp-dependencies/proposal.md), [RFC-029 opencode inventory](../RFC-029-opencode-inventory-snapshot/proposal.md) |

## 1. 背景

opencode 的 plugin 系统（`packages/opencode/src/plugin/index.ts` + `loader.ts` + `config/plugin.ts`）允许用户在 `config.plugin: Spec[]` 下声明一组扩展模块，每个 spec 形如：

- `"my-plugin@1.2.3"` —— npm 包（通过 `Npm.add` 拉取，缓存到 opencode 的本地目录）；
- `"file:///abs/path/to/plugin.ts"` 或 `"./plugin.ts"` —— 本地文件（按 config 文件目录相对解析）；
- `"github:org/repo"` / `"git+https://..."` —— 借 npm CLI 原生 git 支持；
- `["spec", { ...options }]` —— 同上但带 options 对象。

加载顺序在 `loader.ts` 里：`resolve → install → entry → compatibility → load`，目标拿到 `entry` 后动态 import。在 `index.ts` 里 Plugin 模块可注册 hooks（`config` / `auth` / 各种 trigger）并暴露 server / TUI 适配器，对整个 opencode 子进程生效。

当前 agent-workflow 已经把 agent 的三类外部能力资源化了：

- **Skill**（RFC-017）—— 文件系统为权威；
- **dependsOn agent**（RFC-022）—— 闭包合并到 inline JSON；
- **MCP**（RFC-028）—— DB 为权威，闭包合并到 `OPENCODE_CONFIG_CONTENT.mcp`。

但 plugin 仍是空白。当下用户要让 agent 接入插件，只能写到仓库 `.opencode/config.json` 或全局 `~/.opencode/config.json`，问题与 RFC-028 §1 描述完全同构：

1. **Plugin 跟着仓库 / 主机走，不跟着 agent 走**：同一仓库 5 个 agent 只有 1 个该用 `opencode-plugin-analytics`，其它 4 个会被强制加载；
2. **Plugin 不可复用**：另一个 task / worktree 想用同一组 plugin，必须重复声明；
3. **Plugin 版本漂移**：opencode 自己每次 boot 会按 spec 重新解析（`Npm.add` 内部带 cache，但版本更新时机不可控、网络故障导致 spawn 失败）；
4. **没有 UI**：plugin 列表只能手编 JSON，没有"现在装了哪些版本 / 是否需要更新"这种基础观测。

## 2. 目标

- 把 opencode plugin 提升为**一等资源**（与 Agent / Skill / MCP 平级），可在 UI 增删改查、可被多个 agent 复用、可单独导入导出。
- agent 通过 `frontmatter.plugins: [...]` **按名声明依赖**；runner 启动时只把"主 agent + dependsOn 闭包成员引用到的 plugin"注入到 `OPENCODE_CONFIG_CONTENT.plugin`。
- **急安装 + 缓存复用**：保存 plugin 时 daemon 立刻把 spec resolve 到本地目录（`~/.agent-workflow/plugins/{id}/`），把 `cachedPath` / `resolvedVersion` 持久化；spawn 节点时注入的不是原 spec，而是 `file://<cachedPath>` —— **保证每次启动都能装上、不依赖运行时网络、版本一致**。
- 提供 **"检查更新 / 升级"** 操作：UI 可对单条 plugin 触发重 resolve，比对新版本与已缓存版本，确认后覆盖缓存。
- 注入语义与 RFC-022 / RFC-028 完全对齐：闭包合并 + 平台定义胜出 + 不需要 DISABLE flag。

## 3. 非目标

- **不**做 plugin 沙箱化（opencode plugin 是动态 import 的 JS/TS 模块，对其行为不做额外限制，与 opencode 自身策略一致）。
- **不**做凭据加密存储（plugin options 里可能含 token，与 MCP env 一致：v1 文件权限 chmod 600 + redact 日志兜底，后续 RFC 单独做 vault）。
- **不**做 plugin 间依赖闭包（plugin 自身的 npm dep 由 `Npm.add` 处理，不属于本 RFC）。
- **不**做 plugin marketplace / 浏览器集成。
- **不**做 ZIP 批量导入（参考 RFC-019 skill-zip，留作后续）。
- **不**做"屏蔽 inherited plugin"（v1 不主动把 repo `.opencode/config.json` 已有 plugin 在 inline 里关掉；与 RFC-028 MCP 策略一致）。
- **不**改 review / clarify / loop / git wrapper / fanout 语义。
- **不**做 plugin 自动检查更新（v1 全程手动触发"检查更新"按钮；不做后台定时任务）。

## 3.1 前提：opencode plugin 的进程内 scope 与本 RFC 语义的对齐

opencode 进程内 plugin 是**全局**的——所有 plugin hooks 在该 opencode 进程的所有 session / agent 上下文中都会触发（`plugin/index.ts` 的 `trigger` 把 hooks list 直接 fanout）。本框架的「agent X 依赖 plugin Y」**不是**靠 opencode 做 scope，而是靠现有的**每节点一个独立 opencode 子进程**（runner spawn 一次 = 一份隔离 plugin 集）：

- 节点 N 运行 agent X → spawn 进程 P_N，P_N 的 `plugin:` 配置仅含闭包合并后的 plugin 集；
- 节点 M 运行 agent Z（不依赖 Y）→ spawn 进程 P_M，P_M 的 `plugin:` 配置不含 Y。

因此「agent X 自己 spawn 出来的 sub-agent / task 工具调用」在同一进程里**会**看到 X 的 plugin（不仅仅是 X）。这与 RFC-022 dependsOn 闭包注入 / RFC-028 MCP 注入的语义完全对齐：闭包内所有 agent 共享同一 inline JSON、同一 plugin 集。

## 3.2 急安装策略（关键设计点）

opencode 自己的 `Npm.add()` 会把包装到 npm 的全局 cache（用户主机视图层面），但 plugin 解析逻辑里 **每次进程启动都要 resolve 一次**（即使有 cache 也可能去校验 registry）。考虑到 plugin 经常更新版本号且 task 可能在弱网 / 离线环境跑，本 RFC 走"框架托管缓存"路径：

1. **保存 / 更新 plugin 时**：daemon 立刻在 `~/.agent-workflow/plugins/{plugin-id}/` 下做 install
   - npm spec → `npm install --prefix <plugin-dir> <spec>` → 拿到 `node_modules/<pkgName>/package.json` 路径；
   - 本地路径 → 直接 `realpath` 校验存在；
   - Git URL → 也走 `npm install --prefix` 即可（npm 原生支持 git URL）。
2. 把 resolved entry 路径（绝对路径或 `file://...` URL）+ 解析出的 `version` + `installedAt` 写回 DB。
3. **spawn 子进程时**：runner 注入 `OPENCODE_CONFIG_CONTENT.plugin = [<file://cachedEntry>, options]`，**不**透传原 spec —— opencode 看到 file:// 就走 `resolvePathPluginTarget`，零网络，必装成功。
4. **检查更新**：UI 触发 `POST /api/plugins/:id/check-update` → daemon 用同 spec 重做 install 到临时目录，比 version 字段；如果新就回 `{ available: true, current, latest }`；用户点 "升级" → `POST /api/plugins/:id/upgrade` 覆盖缓存 + 更新 DB。
5. **首次 install 失败**：保存 plugin 时返 422 + error 详情；用户改 spec 或修网络后重试。**禁止把未安装成功的 plugin 写到 DB**（避免后续 spawn 用脏数据）。

> ⚠️ 该路径要求主机有可用 `npm` 二进制。daemon 启动时按 `which npm` 探测一次（与 RFC-022 dependsOn 不同：那个是纯 DB 闭包，无外部依赖）。npm 不存在时，**只**禁用 plugin install 路径（local file 仍可用）；UI 在 /plugins 顶端显示告警。

## 4. 用户故事

### US-1 — 给 audit agent 接入 analytics plugin

> Alice 在 `code-audit` agent 里要让 opencode 把每次工具调用写到自家 Datadog。她在 **/plugins 列表页**点 "New"，创建一个 `dd-trace` plugin（spec=`@mycorp/opencode-dd-trace@2.4.1`，options={ apiKey: env('DD_API_KEY') }）。保存后 daemon 立刻 npm install 到 `~/.agent-workflow/plugins/{id}/`，UI 显示 `version: 2.4.1`。回到 `code-audit` agent 编辑页，"Plugins" picker 多选勾上 `dd-trace`，保存。下次跑该 agent 时 runner 注入 file:// 路径；其它 agent 不受影响。

### US-2 — dependsOn agent 自动带 plugin

> `code-audit` 通过 RFC-022 `dependsOn: [schema-explainer]`，`schema-explainer` 自己声明 `plugins: [dd-trace]`。Alice 不需要在 `code-audit` 上也手动加 `dd-trace` —— runner 闭包合并，子 agent 在它的 spawn 子会话里也有 plugin。

### US-3 — plugin 升级

> 一周后 `@mycorp/opencode-dd-trace` 发了 2.5.0。Alice 在 `/plugins` 列表上点 "检查更新" → 行内显示 `2.4.1 → 2.5.0`，点 "升级" → daemon 重 install，UI 刷新；正在跑的 task **不**受影响（用旧 cachedPath，进程隔离），下次新 task 自动用新版本。

### US-4 — 本地开发中的 plugin

> Bob 在 `/Users/bob/dev/my-plugin` 下开发一个 plugin。他在 /plugins 新建 plugin，spec=`file:///Users/bob/dev/my-plugin`。daemon 仅做存在性校验，不复制（保持现场链接），runner spawn 时直接用该路径。Bob 改代码后下次 spawn 自动 reload。

### US-5 — Git URL plugin

> Carol 的 plugin 还没发 npm，只在公司 GitLab。她填 spec=`git+ssh://git@gitlab.corp/team/oc-plugin.git#v0.3.0`。daemon 走 `npm install` 路径（npm 原生支持 git），cache 到本地。

### US-6 — 删除被引用的 plugin 弹挡板

> Dave 删 `dd-trace`，后端发现还有 `code-audit` agent 引用它，返回 409 + 引用列表（与 skill / MCP 删除一致：`still-referenced` 错误）。同时清理缓存目录前确认无引用。

### US-7 — agent.md 导入识别 plugin

> Eve 从社区下载 `release-notes.md`，frontmatter 写 `plugins: [opencode-changelog]`。AgentImportDialog 弹"缺少 plugin: opencode-changelog；是否跳过 / 立刻创建桩"对话框（与 skill / MCP 缺失提示风格一致）。

## 5. 验收标准

1. **资源 CRUD**：`GET/POST/PUT/DELETE /api/plugins`、`POST /api/plugins/:id/rename`；列表与 `/api/agents`、`/api/mcps` 风格一致。
2. **schema 校验**（zod）：
   - `name` 与 agent / skill / mcp 同 regex `/^[a-z0-9][a-z0-9_-]*$/`，唯一；
   - `spec: string`（非空，长度上限 512），允许 npm / `file:` / `file:///` / 相对路径 / `github:` / `git+...://`；
   - `options?: Record<string, unknown>`（可空对象）；
   - `description?: string`（≤ 4 KiB）；
   - `enabled: boolean`（默认 true）。
3. **急安装语义**：
   - POST/PUT 调用时同步触发 install；失败返 422 + `code: "plugin-install-failed"` + stderr 摘要；DB 不落记录。
   - install 成功后 DB 字段 `cachedPath`（绝对路径）+ `resolvedVersion`（npm 时为 package.json version，file 时为 mtime hash，git 时为 commit short sha）+ `installedAt` 必须有值。
4. **更新流**：`POST /api/plugins/:id/check-update` 返回 `{ available, current, latest }`；`POST /api/plugins/:id/upgrade` 触发覆盖安装；同名 spec 若版本未变则 `available: false`。
5. **agent 表单**：MCPs picker 下方新增 "Plugins" picker（多选 chip、空状态、跳转 /plugins 的快捷链接，与 Skills/MCPs 完全对称）。
6. **agent 校验**：保存 agent 时 `plugins: [...]` 里的每个名字必须在 DB 存在 + `enabled=true`，否则返回 `plugin-not-found` 或 `plugin-disabled`（与 `skill-not-found` / `mcp-not-found` 一致）。
7. **运行期注入**：runner 在 `OPENCODE_CONFIG_CONTENT.plugin` 下注入主 agent + dependsOn 闭包成员引用到的 plugin 并集；注入的 Spec 形态：
   - 无 options：`"file://<cachedPath>"`（字符串）；
   - 有 options：`["file://<cachedPath>", <options>]`（元组）。
   - **不**直接透传 npm spec —— 保证零网络。
8. **dependsOn 闭包**：与 RFC-022/028 一样走 `agentDeps.computeClosure`，plugin 合并基于闭包结果；同名 plugin 不会重复注入。
9. **agent.md 导入**：parser 识别 `plugins:` frontmatter，AgentImportDialog 弹出缺失 plugin 列表（参考 RFC-018/028 skill/mcp 提示）。
10. **删除挡板**：删除被任何 agent 引用的 plugin 返回 409，body 含 `referencedBy: [agentName...]`；删除成功后清理 `~/.agent-workflow/plugins/{id}/` 目录。
11. **npm 不可用降级**：daemon 启动探测 `which npm`，缺失时仅允许 `file:` plugin（POST/PUT 非 file spec 返 422 + `code: "npm-unavailable"`）；/plugins 列表页顶部 banner 提示。
12. **YAML 工作流导入导出**：workflow 不直接持有 plugin（plugin 属于 agent），workflow YAML 不变；workflow validator 把 `plugin-not-found` 加入 agent 闭包检查里报错。
13. **测试**：
    - schema 单测覆盖 spec 类型 / options / name regex 边界。
    - `agent.plugins` 闭包合并纯函数单测（参考 `agentDeps.test.ts`）。
    - `services/pluginInstaller.ts` 集成测：mock `npm install`（真跑 `--prefix` 到 tmp），断言写入字段。
    - runner 集成测：断言 `OPENCODE_CONFIG_CONTENT.plugin` 内容与期望并集一致 + 形态是 `file://...`。
    - e2e：创建 plugin（用 fixture local plugin）→ 给 agent 选上 → 启动 task → 断言子进程 env 里含 `file://` 注入。
14. **i18n**：zh-CN / en-US 文案；新页面 / 表单字段都走 i18next，无硬编码字符串。
15. **CI 三件套**：`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions e2e 通过。

## 6. 风险与回退

- **install 时长**：npm install 大包可能 30s+，UI 表单需要 spinner + 30s 超时（与 RFC-024 git clone UX 一致）。后端 install 默认 60s 硬上限，超时返 422 `plugin-install-timeout`。
- **plugin 加载失败**：opencode 在 spawn 时若 plugin 抛错，会写 stderr 但不一定挂掉进程（详见 `loader.ts` 的 `error` report）。runner 在 node_run_events 里把 plugin load error 单独 tag 出来（`[rfc031/plugin-load-failed]`），用户可在节点详情看见。
- **凭据泄漏**：plugin options 可能含 token。日志输出 + API 响应都过 `redactSensitiveString`（RFC-024 已有）。env 注入到 inline JSON 也只走子进程 env，不写文件。
- **缓存目录膨胀**：每条 plugin 一份 `node_modules` 可能几十 MB。daemon 每 24h 后台扫一次，删除 DB 里已无引用的 `plugins/{id}/` 目录（与 worktree GC 同节奏；本 RFC v1 留 hook 不强制开启）。
- **回退**：若发现 inline 注入与某些 opencode 版本冲突，可在 Settings 加 `plugin.injection: 'inline' | 'configDir'` 切换：fallback 路径写到 `OPENCODE_CONFIG_DIR/config.json`。本 RFC v1 不实现这个开关，但 design 预留接口点。

## 7. 备选方案（已否决）

- **A. agent frontmatter 直接内嵌 plugin spec**：每个 agent 自己写 spec / options。否决：违反 DRY、凭据散落、无法跨 agent 复用，且没法管"版本升级"这个核心诉求。
- **B. 不做框架缓存，spec 原样透传**：让 opencode 自己 resolve。否决：弱网 / 离线下 spawn 失败率显著上升；用户没法在 UI 看 / 控制版本。
- **C. 用 skill 包装 plugin**：写一个壳 SKILL.md。否决：plugin 是 JS 模块，skill 是 markdown 体；opencode 把两类完全当不同能力，语义不通。
- **D. 文件系统 source of truth（仿 skill）**：每个 plugin 落 `~/.agent-workflow/plugins/{name}/plugin.json`。否决：plugin 配置（spec + options）是几 KB 结构化数据，DB 列直接装 JSON 更简单；缓存目录已经在文件系统了，配置元数据不再分散。
- **E. 全局 plugin 列表（不绑定 agent）**：所有 agent 一律加载同一组 plugin。否决：与"每个代理可配置插件"这个核心诉求矛盾；scope 控制丢失。
