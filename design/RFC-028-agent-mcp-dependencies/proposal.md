# RFC-028 — Agent MCP 依赖：MCP 资源化 + 按需注入

| 字段 | 值 |
| --- | --- |
| 编号 | RFC-028 |
| 状态 | Draft |
| 作者 | binquanwang |
| 提交日期 | 2026-05-17 |
| 关联 | [RFC-017 skill source dir](../RFC-017-skill-source-directory/proposal.md), [RFC-022 agent dependencies](../RFC-022-agent-dependencies/proposal.md), [RFC-018 agent.md import](../RFC-018-agent-md-import/proposal.md) |

## 1. 背景

当前 agent 只能依赖两类外部能力：

- **Skill**（已支持）：通过 `frontmatter.skills: [...]` 引用；runner 在 `OPENCODE_CONFIG_DIR/skills/{name}/` 物理复制/symlink，opencode 自动扫描。
- **dependsOn agent**（RFC-022）：闭包合并到 `OPENCODE_CONFIG_CONTENT.agent.{name}`，让父 agent 可以 spawn 子 agent。

但生产工作流里越来越多场景要求 agent 接入 **MCP server**（Model Context Protocol）：

- 数据库 / 内部 API 查询（postgres-mcp、http-fetch、sentry-mcp 等）
- 团队私有知识库（vector-mcp、confluence-mcp）
- 第三方 SaaS（linear、jira、slack 的官方 MCP）

opencode 原生支持在 `config.mcp.{name}` 下声明 server，但目前 agent-workflow 没有任何机制让"某个 agent 在某次启动时挂上特定 MCP 集合"。用户必须把 MCP 写进仓库 `.opencode/config.json`，导致：

1. **MCP 跟着仓库走，不跟着 agent 走**：同一仓库里有 5 个 agent，但只有 1 个该用 `postgres-mcp`，其它 4 个会被无谓初始化（拖慢启动、占连接池、暴露面变大）。
2. **MCP 不可复用**：另一个 worktree / 任务想用同一组 MCP，必须复制配置块。
3. **MCP 凭据混入 git**：env / headers 里的 token、cookie 不该进仓库历史。
4. **没有 UI**：MCP server 配置只能手编 JSON。

## 2. 目标

- 把 MCP server 提升为**一等资源**（与 Agent / Skill 平级），可在 UI 增删改查、可被多个 agent 复用、可单独导入导出。
- agent 通过 `frontmatter.mcp: [...]` **按名声明依赖**；runner 启动时**只**把"主 agent + dependsOn 闭包成员引用到的 MCP"注入到 `OPENCODE_CONFIG_CONTENT.mcp`。
- 注入语义与 RFC-022 dependsOn 完全对齐（闭包合并 + 平台定义胜出 + 不需要 DISABLE flag）。
- 提供 Local（stdio：command/args/env）与 Remote（http/sse：url/headers）两种类型，覆盖 opencode `McpLocalConfig` / `McpRemoteConfig` 的全量字段。

## 3. 非目标

- **不**做 MCP server 的运行时状态监控 / 健康检查页面（v1 透传给 opencode 即可，opencode 自己有重试和日志）。
- **不**做 MCP 凭据的加密存储（v1 与 agent / skill 一致，文件权限 chmod 600 兜底；后续 RFC 单独做 vault）。
- **不**做 MCP 跨 agent 共享时的连接池复用（每个 opencode 子进程独立连接，保持现有进程隔离语义）。
- **不**做 ZIP 批量导入（参考 RFC-019 skill-zip，留作后续扩展）。
- **不**做 MCP source-directory 自动扫描（参考 RFC-017，留作后续扩展）。
- **不**改 review / clarify / loop / git wrapper 语义。
- **不**做"屏蔽 inherited MCP"（v1 不主动把 repo `.opencode/config.json` 已有 MCP 在 inline 里关掉，详见 design §6 末两行）。
- **不**做 OAuth 浏览器跳转 UX（用户先在主机上 `opencode mcp auth <name>` 一次让 token 落地 `~/.opencode/auth/...`，子进程都能复用；后续 RFC 单独接 UI）。

## 3.1 前提：opencode 端 MCP scope 与本 RFC 语义的对齐

opencode 进程内 MCP 是**全局**的（mcp/index.ts:524-549 全量 spawn，工具池暴露给该进程所有 agent）。本框架的「agent X 依赖 MCP Y」**不是**靠 opencode 做 scope，而是靠现有的**每节点一个独立 opencode 子进程**（runner spawn 一次 = 一个隔离 MCP 上下文）：

- 节点 N 运行 agent X → spawn 进程 P_N，P_N 的 `mcp:` 配置仅含闭包合并后的 MCP 集；
- 节点 M 运行 agent Z（不依赖 Y）→ spawn 进程 P_M，P_M 的 `mcp:` 配置不含 Y。

因此「agent X 自己 spawn 出来的 sub-agent / task 工具调用」在同一进程里**会**看到 X 的 MCP（不仅仅是 X）。这与 RFC-022 dependsOn 闭包注入的语义完全对齐：闭包内所有 agent 共享同一 inline JSON、同一 MCP 集。

## 4. 用户故事

### US-1 — 给 audit agent 接入 postgres-mcp

> Alice 在 `code-audit` agent 里要查线上 schema。她在 **MCPs 列表页**点 "New"，创建一个 `postgres-prod` MCP（type=local，command=`["uvx","postgres-mcp"]`，env={PG_URL: "postgresql://..."}）。回到 `code-audit` agent 编辑页，在 "MCPs" picker 多选里勾上 `postgres-prod`，保存。下次跑该 agent 时，runner 自动注入；其它 agent 不受影响。

### US-2 — dependsOn agent 自动带 MCP

> `code-audit` agent 通过 RFC-022 `dependsOn: [schema-explainer]` 引用了一个子 agent，`schema-explainer` 自己声明 `mcp: [postgres-prod]`。Alice 不需要在 `code-audit` 上也手动加 `postgres-prod` —— runner 闭包合并，子 agent 在它的 spawn 子会话里能用到 MCP。

### US-3 — agent.md 导入带 MCP

> Bob 从社区下载了一个 `incident-triage.md`，frontmatter 里写了 `mcp: [sentry, linear]`。他通过 RFC-018 的 AgentImportDialog 上传，前端弹"缺少 MCP: sentry, linear；是否跳过依赖 / 立刻创建桩"对话框（与 skill 缺失提示风格一致）。

### US-4 — Remote MCP（OAuth）

> Carol 接公司内部 `confluence-mcp`，type=remote、url=`https://mcp.corp.internal/sse`、headers={Authorization: "Bearer ..."}。直接用 Authorization header，无需 OAuth 流程（OAuth 走 opencode 原生支持，下一个 RFC 接 UI；v1 表单留 headers 输入即可）。

### US-5 — 删除被引用的 MCP 弹挡板

> Dave 删 `postgres-prod`，后端发现还有 `code-audit` agent 引用它，返回 409 + 引用列表（与 skill 删除一致：`still-referenced` 错误）。

## 5. 验收标准

1. **资源 CRUD**：`GET/POST/PUT/DELETE /api/mcps`、`POST /api/mcps/:name/rename`；列表分页与 `/api/agents` 一致。
2. **schema 校验**：
   - Local：`command: string[]`（至少 1 项）+ 可选 `env: Record<string,string>` + 可选 `cwd: string` + 可选 `timeoutMs: number`。
   - Remote：`url: string`（http(s)://）+ 可选 `headers: Record<string,string>` + 可选 `oauth: object|false` + 可选 `timeoutMs: number`。
   - name 与 agent / skill 同 regex `/^[a-z0-9][a-z0-9_-]*$/`。
3. **agent 表单**：Skills picker 下方新增 "MCPs" picker（与 Skills 完全对称：多选 chip、空状态、跳转到 /mcps 的快捷链接）。
4. **agent 校验**：保存 agent 时，`mcp: [...]` 里的每个名字必须在 DB 存在，否则返回 `mcp-not-found`（与 `skill-not-found` 一致）。
5. **运行期注入**：runner 在 `OPENCODE_CONFIG_CONTENT.mcp` 下注入主 agent + dependsOn 闭包成员引用到的所有 MCP 并集；未被引用的 MCP **不**注入。
6. **dependsOn 闭包**：与 RFC-022 一样走 `agentDeps.computeClosure`，MCP 合并基于闭包结果；同名 MCP 不会重复注入。
7. **agent.md 导入**：parser 识别 `mcp:` frontmatter，AgentImportDialog 弹出缺失 MCP 列表（参考 RFC-018 skill 提示）。
8. **删除挡板**：删除被任何 agent 引用的 MCP 返回 409，body 包含 `referencedBy: [agentName...]`。
9. **YAML 工作流导入导出**：workflow 不直接持有 MCP（MCP 属于 agent），所以 workflow YAML 不变；但 workflow validator 把 `mcp-not-found` 加入 agent 闭包检查里报错。
10. **测试**：
    - schema 单测覆盖 Local / Remote 边界值。
    - `agent.mcp` 闭包合并纯函数单测（参考 `agentDeps.test.ts`）。
    - runner 集成测试断言 `OPENCODE_CONFIG_CONTENT` 里 `mcp` 字段内容与期望并集一致。
    - e2e：创建 MCP → 给 agent 选上 → 启动 task → 断言子进程 env 里包含期望 inline JSON。
11. **i18n**：新增 zh-CN / en-US 文案；新页面 / 表单字段都走 i18next，不留硬编码字符串。
12. **CI 三件套**：`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions e2e 通过。

## 6. 风险与回退

- **凭据泄漏**：MCP env / headers 可能含 token。v1 通过 `redactSensitiveString`（已有，见 cachedRepo / RFC-024）在日志与 API 响应里掩盖典型 key（`token`/`password`/`secret`/`authorization`）。
- **OAuth UX 留坑**：opencode 的 `mcp oauth login` 流程涉及浏览器跳转，v1 不在前端做交互式 login —— 用户用 PAT/header 兜底；后续 RFC 单独接。
- **环境变量大小**：注入了 N 个 MCP 后 `OPENCODE_CONFIG_CONTENT` 体积膨胀。沿用 RFC-022 §B6 的 32 KiB 软警告，超过仅 log warn。
- **回退**：若发现 inline 注入与某些 opencode 版本冲突，可在 Settings 加 `mcp.injection: 'inline' | 'configDir'` 切换：fallback 路径写 `OPENCODE_CONFIG_DIR/mcp.json`。本 RFC v1 不实现这个开关，但 design 预留接口点。

## 7. 备选方案（已否决）

- **A. agent frontmatter 直接内嵌 MCP 配置**：每个 agent 自己写 command / env。否决：违反 DRY，凭据散落，无法跨 agent 复用。
- **B. 用 skill 包装 MCP（写一个壳 SKILL.md）**：尝试用现有机制。否决：opencode 把 mcp 和 skill 当两类完全不同的能力，skill 的 markdown 体不会触发 mcp server 启动；语义不通。
- **C. 仅在仓库 `.opencode/config.json` 维护**：保持现状。否决：所有 US 都没解。
- **D. 文件系统 source of truth（仿 skill）**：每个 MCP 落 `~/.agent-workflow/mcps/{name}/mcp.json`。否决：MCP 配置是几 KB 的结构化数据，DB 列直接装 JSON 更简单；也避免 SKILL.md 那种 `parse → write` 双向漂移。RFC-017 source-dir 模式以后想做可以再加。
