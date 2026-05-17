# RFC-028 — 任务分解

> 子任务前缀 `RFC-028-T*`。默认单 PR，所有任务进同一分支；如需拆分会在底部「PR 拆分建议」里说明。

## 任务列表

### RFC-028-T1 — shared/zod schema + 类型导出
- **What**：新增 `packages/shared/src/schemas/mcp.ts`（Local / Remote 区分 union、CRUD schema、rename schema）。Local **不含 `cwd` 字段**（opencode `McpLocalConfig` 没有 cwd；stdio 子进程 cwd = opencode 进程 cwd = worktree）。在 `packages/shared/src/index.ts` 出口。`AgentSchema` / `CreateAgentSchema` / `UpdateAgentSchema` 追加 `mcp: z.array(McpNameSchema).default([])`。
- **Tests**：`packages/shared/tests/mcp-schema.test.ts` 覆盖：
  - Local：空 command 报错、非字符串 env 报错、正常通过、**断言 schema 不接受 `cwd` 字段**（防 future 回归）。
  - Remote：非 http(s) url 报错、headers 透传、oauth 既可为对象也可为 false。
  - Agent：`mcp` 字段默认 `[]`，包含非法 name 报错。
- **Deps**：—
- **Size**：S

### RFC-028-T2 — DB schema + migration
- **What**：在 `packages/backend/src/db/schema.ts` 新增 `mcps` 表；`agents` 表加 `mcp` 列。`drizzle-kit generate` 出 `00NN_rfc028_mcps.sql`。
- **Tests**：`packages/backend/tests/migrations.test.ts` 扩展：跑完 migration 后 `mcps` 表存在 + `agents.mcp` 列存在 + 默认 `'[]'`；老数据 select 行 `mcp === []`。
- **Deps**：T1
- **Size**：S

### RFC-028-T3 — services/mcp.ts CRUD + rename + 引用检查
- **What**：新文件 `packages/backend/src/services/mcp.ts`：listMcps / getMcp / createMcp / updateMcp / renameMcp / deleteMcp / findAgentsReferencingMcp。仿 `services/skill.ts` 错误类型（`MCP_STILL_REFERENCED` / `MCP_NAME_CONFLICT`）。
- **Tests**：`packages/backend/tests/services/mcp.test.ts`：
  - create → list → update → rename → delete happy path。
  - delete 时存在引用 → 抛 still-referenced + 含 referencedBy 列表。
  - rename 时新名已被占 → 抛 name-conflict。
  - rename 成功后 referencing agent 的 `mcp` 列字符串同步替换。
- **Deps**：T2
- **Size**：M

### RFC-028-T4 — routes/mcps.ts
- **What**：新文件 `packages/backend/src/routes/mcps.ts`，挂到 `server.ts`。错误 → HTTP 状态映射（409 / 422 / 404）。
- **Tests**：`packages/backend/tests/routes/mcps.test.ts`：
  - GET/POST/PUT/DELETE/rename 全路径 200/201/204。
  - 409 still-referenced + body shape。
  - 422 zod 错（无 command / 非法 url）。
  - 鉴权：缺 token 401。
- **Deps**：T3
- **Size**：S

### RFC-028-T5 — agent 校验扩展（mcp-not-found）
- **What**：`services/agent.ts` 在 create/update 里校验 `input.mcp` 存在性；新增错误类型 `mcp-not-found`。`services/workflow.validator.ts` 在已有 agent 闭包检查里追加 mcp 缺失检查。
- **Tests**：
  - `tests/services/agent.test.ts` 扩展：unknown mcp → 422。
  - `tests/services/workflow.validator.test.ts` 扩展：workflow 用了 agent，agent.mcp 缺失 → validator 错误码 `mcp-not-found`。
- **Deps**：T3
- **Size**：S

### RFC-028-T6 — 闭包合并纯函数
- **What**：`packages/backend/src/services/mcpClosure.ts`：`collectMcpNamesFromClosure(closure)` + `loadMcpsByNames(db, names)`。
- **Tests**：`tests/services/mcpClosure.test.ts`：
  - 空闭包 / 单 agent / dependsOn 闭包合并去重。
  - loadMcpsByNames：空数组 → 空，传不存在名 → 略过（不抛）。
- **Deps**：T3
- **Size**：S

### RFC-028-T7 — runner.buildInlineConfig 注入
- **What**：`services/runner.ts`：`RunNodeOptions` 加 `mcps?: Mcp[]`；`buildInlineConfig` 加 `mcps` 参数；字段名翻译（env → environment、timeoutMs → timeout，pruneUndefined 后再写入）；spawn log 加 `mcpCount` + `mcpKeys`（**不** dump 完整 mcp 配置体，env/headers 含凭据）。
- **Tests**：`tests/services/runner.buildInlineConfig.test.ts` 新增 case：
  - mcps 空 → 输出对象不含 `mcp` key。
  - 含 Local：`env: {A:"1"}` → inline `environment: {A:"1"}`；`timeoutMs: 5000` → inline `timeout: 5000`；undefined 字段被裁掉（不出现在序列化 JSON 里）。
  - **字段名兜底锚**：grep `buildInlineConfig` 实现确保出现字符串 `'environment'` 与 `'timeout'`（防未来 refactor 误写 `env`/`timeoutMs` 到 inline）。
  - 含 Remote 且 oauth=false → 直接透传 `oauth: false`。
  - 含 Remote 且 oauth={clientId:"x"} → 透传 object。
  - enabled=false → 整条不进入 inline（即 mcp map 里不出现该 key）。
  - 闭包合并：传入两份指向同一 mcp.name 的对象 → inline 里只出现一次（与 closure 去重对齐）。
- **Deps**：T1, T6
- **Size**：M

### RFC-028-T8 — scheduler 预加载
- **What**：`services/scheduler.ts` 在 spawn 节点前调用 `collectMcpNamesFromClosure` + `loadMcpsByNames`，传给 `runNode({ mcps })`。
- **Tests**：扩展 `tests/services/scheduler.test.ts`：mock runNode，断言传入的 `mcps` 数量与闭包合并一致。
- **Deps**：T6, T7
- **Size**：S

### RFC-028-T9 — 前端 /mcps 列表页 + 详情表单
- **What**：`packages/frontend/src/pages/Mcps.tsx` + `components/mcps/*`。Router 注册到 `routes/`。i18n（zh-CN / en-US）落 key。表单 Local 区**不出现 cwd 输入**（提示文案："stdio MCP 会在该 task 的 worktree 目录下启动"）。Remote 区 OAuth 折叠区说明 "v1：headers 中带 PAT/Bearer 即可；OAuth 浏览器跳转登录请在主机上跑 `opencode mcp auth <name>` 一次，token 落 `~/.opencode/auth/`"。表单字段顶部提示工具命名约定："此 MCP 暴露的工具在 agent 内会以 `{name}_{tool}` 出现（permission 里点名时使用）"。
- **Tests**：
  - `tests/mcps-page.test.tsx`：渲染列表、点击 New 弹出表单、保存调用 API。
  - `tests/mcp-form-validation.test.ts`：Local 空 command 报错、Remote 非 http 报错。
  - **断言表单不渲染 cwd 输入**（regression guard：grep `Mcps.tsx` 不含 `cwd` 字段）。
  - 源码兜底：`tests/locks/mcps-page-uses-i18n.test.ts` 断言 page 文件不含硬编码中英文标题字串。
- **Deps**：T4
- **Size**：M

### RFC-028-T10 — Agent 编辑表单加 MCP picker + 节点 Stats tab 显示闭包
- **What**：`components/agents/AgentEditor.tsx` 在 Skills picker 下追加 `<McpPicker />`。节点 Stats tab（RFC-022 已有）追加 MCP closure 折叠区。
- **Tests**：
  - `tests/agent-editor-mcp-picker.test.tsx`：选项来自 listMcps，多选可保存。
  - `tests/node-stats-mcp-closure.test.tsx`：给闭包 agent 列出 MCP 名。
- **Deps**：T9
- **Size**：S

### RFC-028-T11 — agent.md 导入识别 mcp
- **What**：`packages/shared/src/agentMdParser.ts`（按 RFC-018 现有路径）识别 frontmatter `mcp:` 字符串数组。`AgentImportDialog` 缺失 MCP 提示与缺失 skill 共用模板。
- **Tests**：
  - `tests/agent-md-parser-mcp.test.ts`：frontmatter `mcp: [a, b]` 解析为数组。
  - `tests/agent-import-dialog-missing-mcp.test.tsx`：缺失列表渲染 + 跳转链接到 /mcps。
- **Deps**：T9
- **Size**：S

### RFC-028-T12 — e2e + 文档同步
- **What**：
  - `tests/e2e/mcp.happy-path.spec.ts`（见 design §7.3）。
  - 更新 `design/plan.md` RFC 索引行（Draft → In Progress → Done）。
  - 更新 `STATE.md` 顶部「进行中 RFC」+ 完工后已完成条目。
  - `README.md` 增"MCP 资源"小节（一段话 + 截图占位）。
- **Tests**：e2e 通过；CI `bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions（含 build smoke + Playwright）全绿。
- **Deps**：T1–T11
- **Size**：M

## 依赖图

```
T1 ──┬─ T2 ── T3 ──┬─ T4
     │             ├─ T5
     │             └─ T6 ── T7 ── T8
     └────────────────────── T7
T4 ── T9 ──┬─ T10
            └─ T11
T1..T11 ── T12
```

## PR 拆分建议

默认**单 PR**（commit message：`feat(mcp): RFC-028 agent MCP 依赖`），原因：

- T1–T8（后端）+ T9–T11（前端）必须同时上线，否则前端 picker 无值 / 后端校验失败前端无对应错误展示。
- 单 PR 易回滚（一次 revert 全删）。

**如 PR 体量超过 ~1500 行 diff**，可拆为 2 PR：

1. PR-A：T1–T8（纯后端 + schema），UI 不暴露入口，feature flag `config.mcp.enabled = false` 默认关。
2. PR-B：T9–T12（前端 + e2e + 翻 flag），落地后清理 flag。

但**没有充分迹象前优先单 PR**。

## 验收清单（PR 合并前 self-check）

- [ ] T1–T12 全部完成，每条都有对应 commit + 测试。
- [ ] `bun run typecheck` ✅
- [ ] `bun run test` ✅（含新增单测 + 集成测）
- [ ] `bun run format:check` ✅
- [ ] e2e `mcp.happy-path.spec.ts` ✅
- [ ] zh-CN / en-US i18n key 同步，无 missing key warning。
- [ ] `design/plan.md` RFC 索引行状态更新。
- [ ] `STATE.md` 同步。
- [ ] PR 描述列出主要 API、UI 截图、回滚路径（drop column / drop table 的 down migration）。
- [ ] 推完后按 `[feedback_post_commit_ci_check]` 立刻查 GitHub Actions 状态，红的修绿再走。
