# RFC-031 — 任务分解

> 子任务前缀 `RFC-031-T*`。默认单 PR，所有任务进同一分支；如需拆分见底部「PR 拆分建议」。

## 任务列表

### RFC-031-T1 — shared/zod schema + 类型导出

- **What**：新增 `packages/shared/src/schemas/plugin.ts`（PluginNameSchema / PluginSpecSchema / PluginOptionsSchema / SourceKindSchema / PluginSchema / CRUD schema / rename / check-update schema）。在 `packages/shared/src/index.ts` 出口。`AgentSchema` / `CreateAgentSchema` / `UpdateAgentSchema` 追加 `plugins: z.array(PluginNameSchema).default([])`。
- **Tests**：`packages/shared/tests/plugin-schema.test.ts` 覆盖：
  - name regex 边界（首字符必须 `[a-z0-9]`、长度上限、非法字符报错）。
  - spec 长度 1–512、空串报错。
  - options 必须 object；非 object 报错；默认 `{}`。
  - **断言 schema 不接受 spec 元组**（即 DB 里只存字符串 spec；元组是 opencode 注入态）。
  - resolvedVersion 可空。
  - AgentSchema.plugins 默认 `[]`、非法 name 报错。
- **Deps**：—
- **Size**：S

### RFC-031-T2 — DB schema + migration

- **What**：`packages/backend/src/db/schema.ts` 新增 `plugins` 表；`agents` 表加 `plugins` 列。`drizzle-kit generate` 出 `00NN_rfc031_plugins.sql`，**meta `_journal.json` 同步追加**。
- **Tests**：`packages/backend/tests/migration-00NN-plugins.test.ts`：跑完 migration 后 `plugins` 表存在 + 所有列名 / 类型符合 schema；`agents.plugins` 列存在 + 默认 `'[]'`；老 agent select 行 `plugins === []`。
- **Deps**：T1
- **Size**：S

### RFC-031-T3 — services/pluginInstaller.ts（核心）

- **What**：新文件 `packages/backend/src/services/pluginInstaller.ts`。导出 `installPlugin / probeNpmBinary / checkForUpdate / cleanupPluginDir`。sourceKind 推断、`npm install --prefix` spawn、file: realpath、in-flight Map 串行化、60s 超时、stderr 头 2 KiB 截断 + redact。
- **Tests**：`packages/backend/tests/services/pluginInstaller.test.ts`：
  - file: spec → realpath 成功 + resolvedVersion 是 mtime hash
  - 用 fixture 走 file:// 路径，断言 **不**调 npm（用 `which npm` mock 返失败 + 流程依然 OK 验证）。
  - npm path 用 `MOCK_NPM_BIN` 注入 `tests/mocks/fake-npm.sh`，模拟成功（写 node_modules/<pkg>/package.json）/ 失败（非零退出 + stderr）/ 超时（sleep 65 → 被 kill）。
  - in-flight Map：并发 2 个同 id 调 installPlugin，断言 npm 只被调一次。
  - **redact 锚**：spec 含 `https://x-token-auth:SECRET@host/...`，错误响应 stderr 字段不含 `SECRET` 字面量。
  - **源码兜底**：grep `pluginInstaller.ts` 必须包含 `"--prefix"`（防误写成 `cwd`）。
- **Deps**：T2
- **Size**：M

### RFC-031-T4 — services/plugin.ts CRUD + rename + 引用检查

- **What**：新文件 `packages/backend/src/services/plugin.ts`：listPlugins / getPlugin / createPlugin / updatePlugin / renamePlugin / deletePlugin / findAgentsReferencingPlugin。createPlugin / updatePlugin 内部调 installer；rename 同步替换 referencing agents.plugins 列；delete 引用检查 + 调 cleanupPluginDir。错误类型与 design §3.1 对齐。
- **Tests**：`packages/backend/tests/services/plugin.test.ts`：
  - create → list → update → rename → delete happy path。
  - delete 时存在引用 → 抛 plugin-still-referenced + 含 referencedBy 列表。
  - rename 时新名已被占 → 抛 plugin-name-conflict。
  - rename 成功后 referencing agent 的 plugins 列字符串同步替换。
  - delete 成功后 plugin 目录被清理（fs 断言 dir 不存在）。
  - create 时 installer 抛 PluginInstallFailedError → DB 不落记录（select count == 0）。
- **Deps**：T3
- **Size**：M

### RFC-031-T5 — routes/plugins.ts

- **What**：新文件 `packages/backend/src/routes/plugins.ts`，挂到 `server.ts`。8 条接口（list / get / create / update / delete / rename / check-update / upgrade）+ 错误 → HTTP 状态映射。
- **Tests**：`packages/backend/tests/routes/plugins.test.ts`：
  - GET/POST/PUT/DELETE/rename/check-update/upgrade 全路径返码正确。
  - 409 still-referenced + body shape。
  - 422 zod 错 + plugin-install-failed + plugin-install-timeout + npm-unavailable。
  - 鉴权：缺 token 401。
- **Deps**：T4
- **Size**：S

### RFC-031-T6 — agent 校验扩展（plugin-not-found / plugin-disabled）

- **What**：`services/agent.ts` 在 create/update 里校验 `input.plugins` 存在性与 enabled；新增错误类型。`services/workflow.validator.ts` 在已有 agent 闭包检查里追加 plugin 缺失检查。
- **Tests**：
  - `tests/services/agent.test.ts` 扩展：unknown plugin → 422、disabled plugin → 422。
  - `tests/services/workflow.validator.test.ts` 扩展：workflow 用了 agent，agent.plugins 缺失 → validator 错误码 `plugin-not-found`。
- **Deps**：T4
- **Size**：S

### RFC-031-T7 — 闭包合并纯函数

- **What**：新文件 `packages/backend/src/services/pluginClosure.ts`：`collectPluginNamesFromClosure(closure)` + `loadPluginsByNames(db, names)`。排序保证稳定。
- **Tests**：`tests/services/pluginClosure.test.ts`：
  - 空闭包 / 单 agent / dependsOn 闭包合并去重。
  - 排序稳定（不同顺序的 closure 输出相同）。
  - loadPluginsByNames：空数组 → 空，传不存在名 → 略过（不抛）。
- **Deps**：T4
- **Size**：S

### RFC-031-T8 — runner.buildInlineConfig 注入

- **What**：`services/runner.ts`：`RunNodeOptions` 加 `plugins?: Plugin[]`；`buildInlineConfig` 加 `plugins` 参数；按 design §3.6 形态生成 file:// + 元组 / 字符串；`enabled=false` 整条过滤；spawn log 加 `pluginCount` + `pluginNames`（**不** dump options）。
- **Tests**：`tests/services/runner.buildInlineConfig.test.ts` 新增 case：
  - plugins 空 → 输出对象不含 `plugin` key。
  - 含 1 个无 options plugin → `plugin: ["file://..."]`（字符串元素）。
  - 含 options → `plugin: [["file://...", { foo: "bar" }]]`（元组元素）。
  - `enabled=false` 整条不进入 inline。
  - **形态锚**：注入数组里每个元素的 spec 部分必须以 `file://` 开头；grep 实现含 `'file://'` 与 `enabled` 过滤。
  - 闭包合并：传入两份指向同一 plugin.name 的对象 → inline 里只出现一次（与 closure 去重对齐）。
- **Deps**：T1, T7
- **Size**：M

### RFC-031-T9 — scheduler 预加载

- **What**：`services/scheduler.ts` 在 spawn 节点前调 `collectPluginNamesFromClosure` + `loadPluginsByNames`，传给 `runNode({ plugins })`。
- **Tests**：扩展 `tests/services/scheduler.test.ts`：mock runNode，断言传入的 `plugins` 数量与闭包合并一致。
- **Deps**：T7, T8
- **Size**：S

### RFC-031-T10 — runner 事件 tag plugin-load-failed

- **What**：`services/runner.ts` 在 stderr stream 解析层加 plugin error 识别（参考 opencode `loader.ts` 错误前缀），打 `[rfc031/plugin-load-failed]` tag 写到 node_run_events。前端 `lib/rfc031-events.ts` 纯函数解析（仿 RFC-026 events 模式）。`NodeDetailDrawer.tsx` events 列表渲染 warning 卡片 + i18n。
- **Tests**：
  - `tests/lib/rfc031-events.test.ts`：parseRfc031Event 各 case。
  - `tests/runner-plugin-load-failed.test.ts`：注入 stub-opencode 模拟 plugin error stderr → 断言 node_run_events 含该 tag 行。
- **Deps**：T8
- **Size**：S

### RFC-031-T11 — 前端 /plugins 列表页 + 详情表单

- **What**：`packages/frontend/src/pages/Plugins.tsx` + `components/plugins/*`。Router 注册到 `routes/`。i18n key 落 zh-CN / en-US。表单含 spec textarea / options JSON 编辑器 / enabled toggle / sourceKind 自动推断显示。保存 spinner（install 中）+ 失败 stderr 截断显示。顶部 banner：`probeNpmBinary` false 时提示。
- **Tests**：
  - `tests/plugins-page.test.tsx`：渲染列表、点击 New 弹出表单、保存调用 API、显示 sourceKind chip。
  - `tests/plugin-form-validation.test.ts`：name 非法 / spec 空 / options 非 object 报错。
  - `tests/locks/plugins-page-uses-i18n.test.ts`：page 文件不含硬编码中英文标题。
- **Deps**：T5
- **Size**：M

### RFC-031-T12 — 检查更新 / 升级 UI

- **What**：列表行内"检查更新"按钮 → POST `/api/plugins/:id/check-update` → 显示 `current → latest` 或"已是最新"；"升级"按钮二次确认对话框 → POST `/upgrade` → spinner + 列表刷新。
- **Tests**：
  - `tests/plugin-check-update.test.tsx`：mock API 返 available=true，断言显示 latest version；点升级触发 POST 并刷新列表。
  - `tests/plugin-check-update.test.tsx`：available=false 时按钮 disabled / 显示"已是最新"。
- **Deps**：T11
- **Size**：S

### RFC-031-T13 — Agent 编辑表单加 Plugin picker + 节点 Stats tab 显示闭包

- **What**：`components/agents/AgentEditor.tsx` 在 MCPs picker 下追加 `<PluginPicker />`（选项只列 enabled=true）。节点 Stats tab（RFC-022/028 已有）追加 Plugin closure 折叠区，每条显示 name + version chip。
- **Tests**：
  - `tests/agent-editor-plugin-picker.test.tsx`：选项来自 listPlugins，多选可保存。
  - `tests/node-stats-plugin-closure.test.tsx`：给闭包 agent 列出 plugin 名 + version。
- **Deps**：T11
- **Size**：S

### RFC-031-T14 — agent.md 导入识别 plugins

- **What**：`packages/shared/src/agentMdParser.ts` 识别 frontmatter `plugins:` 字符串数组（按 RFC-018 现有路径）。`AgentImportDialog` 缺失 plugin 提示与缺失 skill / mcp 共用模板。
- **Tests**：
  - `tests/agent-md-parser-plugins.test.ts`：frontmatter `plugins: [a, b]` 解析为数组。
  - `tests/agent-import-dialog-missing-plugins.test.tsx`：缺失列表渲染 + 跳转链接到 /plugins。
- **Deps**：T11
- **Size**：S

### RFC-031-T15 — e2e + 文档同步

- **What**：
  - `tests/e2e/plugin.happy-path.spec.ts`（见 design §7.3）。本地 fixture plugin（`tests/fixtures/plugins/hello/` 含 package.json + index.js 一个 hook）走 file: 路径，避免 e2e 联网。
  - 更新 `design/plan.md` RFC 索引行（Draft → In Progress → Done）。
  - 更新 `STATE.md` 顶部"进行中 RFC" + 完工后已完成条目。
  - `README.md` 增"Plugin 资源"小节（一段话 + 截图占位）。
- **Tests**：e2e 通过；CI `bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions（含 build smoke + Playwright）全绿。
- **Deps**：T1–T14
- **Size**：M

## 依赖图

```
T1 ── T2 ── T3 ── T4 ──┬─ T5
                       ├─ T6
                       └─ T7 ── T8 ── T9
                                 │
                                 └── T10
T5 ── T11 ──┬─ T12
            ├─ T13
            └─ T14
T1..T14 ── T15
```

## PR 拆分建议

默认**单 PR**（commit message：`feat(plugin): RFC-031 agent plugin 依赖`），原因：

- T1–T10（后端 + schema + runner 注入）+ T11–T14（前端）必须同时上线，否则前端 picker 无值 / 后端校验失败前端无对应错误展示。
- 单 PR 易回滚（一次 revert 全删）。

**如 PR 体量超过 ~1500 行 diff**，可拆为 2 PR：

1. **PR-A**：T1–T10（纯后端 + schema + runner + 事件 tag），UI 不暴露入口，feature flag `config.plugin.enabled = false` 默认关。
2. **PR-B**：T11–T15（前端 + e2e + 翻 flag），落地后清理 flag。

但**没有充分迹象前优先单 PR**。

## 验收清单（PR 合并前 self-check）

- [ ] T1–T15 全部完成，每条都有对应 commit + 测试。
- [ ] `bun run typecheck` ✅
- [ ] `bun run test` ✅（含新增单测 + 集成测）
- [ ] `bun run format:check` ✅
- [ ] e2e `plugin.happy-path.spec.ts` ✅
- [ ] zh-CN / en-US i18n key 同步，无 missing key warning。
- [ ] 注入数组里每个元素 spec 部分都以 `file://` 开头（不会触发 opencode 子进程联网）。
- [ ] plugin 目录权限 700（手动 chmod 验一遍 ls -ld）。
- [ ] `design/plan.md` RFC 索引行状态更新（Draft → In Progress → Done）。
- [ ] `STATE.md` 同步（顶部"进行中 RFC"行 + 完工后已完成 issue 表）。
- [ ] PR 描述列出主要 API、UI 截图、回滚路径（drop column / drop table 的 down migration + 清缓存目录命令）。
- [ ] 推完后按 `[feedback_post_commit_ci_check]` 立刻查 GitHub Actions 状态，红的修绿再走。
