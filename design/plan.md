# Agent Workflow 实施计划

> 与 [`design.md` § 17 路线图](./design.md#17路线图) 配套，把每个里程碑展开为可单独认领的 issue。
> 编号规则：**P-{milestone}-{seq}**，例如 `P-1-03`。
> Size：S = ≤ 1 天 / M = 2–3 天 / L = 4–7 天。
> "Deps" 列出必须在它之前完成的 issue 编号。

## 总览

| 里程碑 | 目标 | 大致周期 (单人专注) | issue 数 |
| --- | --- | --- | --- |
| **M0** 准备 | 仓初始化 / opencode 兼容性验证 / CI 雏形 | 2–3 天 | 5 |
| **M1** 骨架 | 单 daemon + 鉴权 + Agents/Skills CRUD + 单节点线性 workflow + 端到端跑通一次 task | 2–3 周 | 18 |
| **M2** 编辑器 | xyflow 编辑器 + 启动表单 + 任务状态视图 + WS 三频道 + 静态校验 | 3 周 | 16 |
| **M3** 编排核心 | 多进程节点 + git wrapper + retry/resume + 节点 4 tab + 流式 events | 3 周 | 14 |
| **M4** 高级编排 | loop wrapper + 嵌套 + 资源限额 + interrupted 状态 + YAML 导入导出 + worktree GC | 2 周 | 11 |
| **M5** 打磨 | 事件归档 + 备份恢复 + i18n / 暗色 + e2e + 单二进制 + Release | 2 周 | 12 |
| **跨阶段** | 文档 / DX / 维护 | 持续 | 5 |

合计 **81 个 issue**，单人全职 ~13 周完成 v1（含测试）。多人并行可压缩。

## RFC 索引

v1 后续的产品 / 技术变更以 RFC 形式落档在 `design/RFC-NNN-{slug}/` 子目录下，每个 RFC 含 `proposal.md` / `design.md` / `plan.md` 三文件。RFC 编号独立于 P-X-XX issue 编号。

| 编号 | 标题 | 状态 |
| --- | --- | --- |
| [RFC-001](./RFC-001-runtime-status-and-model-select/proposal.md) | Settings → Runtime 状态卡片 + Model 下拉选择 | Done |
| [RFC-002](./RFC-002-agent-defaults-from-runtime/proposal.md) | Add Agent 表单：从 Runtime 默认值快照 + Skills 下拉选已有（含 Settings 新增 defaultSteps / defaultMaxSteps） | Done |
| [RFC-003](./RFC-003-canvas-input-port-wiring/proposal.md) | Canvas 输入端口连边可达性：catch-all 左侧 handle + onConnect 默认 portName=source + EdgeInspector 改名 | Done |
| [RFC-004](./RFC-004-input-port-contract/proposal.md) | Input 节点端口契约统一：scheduler portName=inputKey + 编辑器同步 `definition.inputs[]` + validator 新规则 | Done |

---

## M0 — 项目准备

### 目标

不写产品代码；做的是开工前的兜底验证。

### Issues

#### P-0-01 验证 opencode 最低版本与三 env var

- **Why**：`OPENCODE_CONFIG_CONTENT` / `OPENCODE_DISABLE_PROJECT_CONFIG` / `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `--format json` 必须在最低支持版本里都可用。如果不可用，整个隔离方案失效。
- **What**：手工跑实验：选一个 opencode 版本，在仓里准备一个 `.opencode/agents/code-auditor.md` + `.opencode/skills/foo`；同时设 `OPENCODE_CONFIG_CONTENT='{"agent":{"code-auditor":{...}}}'` + `OPENCODE_CONFIG_DIR=/tmp/x`，验证：(1) 平台定义的 agent 是否覆盖仓内同名 agent；(2) 仓内 skill 是否仍然被 agent 看到；(3) auth.json 是否仍然可用。从最近的 stable 往回找出最低兼容版本号。
- **Output**：在 `design/design.md` § 18 第 1 项中填入具体最低版本号，写 README 说明。
- **Size**：S
- **Deps**：—

#### P-0-02 仓初始化

- **What**：创建 monorepo 骨架。Bun workspaces。
  - `package.json` + `pnpm-workspace.yaml`/`bun workspaces` 风格的 packages 配置
  - `packages/frontend/` (Vite + React)
  - `packages/backend/` (Bun + Hono)
  - `packages/shared/` (zod + 类型)
  - `tsconfig.base.json` + 各 package tsconfig
  - `.gitignore`、`.editorconfig`、`.prettierrc`、`README.md`
- **Output**：能 `bun install` 不报错；`bun --filter frontend dev` / `bun --filter backend dev` 可启起空白 hello world。
- **Size**：S
- **Deps**：—

#### P-0-03 GitHub repo + CI 雏形

- **What**：建 GitHub repo，加 `.github/workflows/ci.yml`（lint + typecheck + bun:test）。设置 main 分支保护。
- **Size**：S
- **Deps**：P-0-02

#### P-0-04 ESLint + Prettier 与 lint script

- **What**：根级 eslint config（基于 typescript-eslint），所有 package 共用。
  - 根 `package.json` 加 `lint` / `format` 脚本
  - 加 husky / lint-staged 仅 lint 改动文件
- **Size**：S
- **Deps**：P-0-02

#### P-0-05 Drizzle schema 雏形 + bun:sqlite + 第一个 migration

- **What**：在 `packages/backend/db/` 建 schema 文件；定义 `agents / skills / workflows / recent_repos / tasks / node_runs / node_run_outputs / node_run_events` 全表的 Drizzle 模型；`drizzle-kit generate` 出 0001_init.sql；写一个 daemon 启动时自动跑 migration 的 helper。
- **Output**：跑 migration 后有空 db.sqlite。
- **Tests**：`bun:test` 验证 migration 可重复跑、各表 columns 与 design.md § 3 对齐。
- **Size**：M
- **Deps**：P-0-02

---

## M1 — 骨架与基础 CRUD

### 目标

跑通"创 agent → 创 skill → 创最简单的线性 workflow → 启 task → 看到 opencode 子进程跑完输出"的端到端 happy path，无 wrapper、无多进程、无 retry。前端只有最低限度可用（列表 + 启动 + task 详情打底）。

### Non-goals

- 不做 xyflow 编辑器（M2）
- 不做 wrapper / 多进程节点（M3）
- 不做 retry / resume（M3）
- 不做 WS 推送（M2 加）—— M1 用轮询

### 模块拓扑

```
packages/backend/
  src/
    config/        # config.json 读写, schema_version
    db/            # drizzle schema + migrations + 连接管理
    auth/          # token 生成与校验中间件
    util/log.ts    # 轻量结构化日志
    util/git.ts    # worktree / diff helper（M1 仅 createWorktree / removeWorktree）
    util/opencode.ts # PATH 寻找 + version 探测
    services/
      agent.ts     # CRUD
      skill.ts     # CRUD（含 fs 文件树）
      workflow.ts  # CRUD（仅最简校验，5 项校验 M2 加）
      task.ts      # 启动 task / 列表 / 详情
      runner.ts    # 单节点串行执行；spawn opencode；解析 envelope
      envelope.ts  # extractLastEnvelope / parseEnvelope
      protocol.ts  # 协议块 + prompt 拼接
    routes/
      health.ts
      config.ts
      agents.ts
      skills.ts
      workflows.ts
      repos.ts     # /repos/recent
      tasks.ts     # 含 /tasks/{id}/nodes/{nodeRunId}
    cli/
      start.ts stop.ts status.ts version.ts doctor.ts config.ts migrate.ts
    server.ts      # Hono 实例 + 中间件 + 路由挂载
    main.ts        # CLI 入口

packages/shared/
  src/
    schemas/       # zod schemas
      agent.ts skill.ts workflow.ts task.ts config.ts
    types.ts       # 派生 TS

packages/frontend/
  src/
    routes/        # TanStack Router 路由
    api/           # fetch wrapper（带 token）
    pages/Agents.tsx Skills.tsx Workflows.tsx Tasks.tsx Settings.tsx
```

### Issues

#### P-1-01 Daemon CLI start + flock 单实例

- **What**：`agent-workflow start` 前台启动；启动时拿 `~/.agent-workflow/.daemon.lock` flock；已被占则报错退出（打印现有 PID）。Daemon SIGTERM/SIGINT 接信号，30s graceful（M1 阶段先简化，无子进程时直接退出即可）。
- **Files**：`packages/backend/src/main.ts`、`src/cli/start.ts`、`src/util/lock.ts`
- **Tests**：bun:test 验证 flock 抢占逻辑（用 fork 起两个进程）。
- **Size**：S
- **Deps**：P-0-02

#### P-1-02 Token 鉴权 + ~/.agent-workflow/token

- **What**：daemon 启动检查 `~/.agent-workflow/token`：不存在则 `crypto.randomBytes(32).toString('hex')`，写入 chmod 600。Hono 中间件：所有 `/api/*` 与 `/ws/*` 校验 `Authorization: Bearer` 或 `?token=`。
- **Files**：`src/auth/token.ts`、`src/server.ts` 中间件
- **Tests**：bun:test 验证有/无 token、错误 token、过期 token 的行为。
- **Size**：S
- **Deps**：P-1-01

#### P-1-03 配置加载与 settings API

- **What**：`config.json` 读写；`$schema_version` + 默认值；缺字段补默认。GET `/api/config` / PUT `/api/config`。Settings 4 类字段（运行时/限额/GC/网络）落 schema。
- **Files**：`src/config/`、`packages/shared/src/schemas/config.ts`、`src/routes/config.ts`
- **Tests**：bun:test schema 校验、缺字段补默认、PUT 修改后回读一致。
- **Size**：M
- **Deps**：P-0-05、P-1-02

#### P-1-04 健康检查 + opencode version 探测

- **What**：`GET /api/health` → `{ ok, opencodeVersion, dbVersion, uptime, runningTasks }`。daemon 启动时 spawn `opencode --version`，semver 对比最低版本（来自 P-0-01），不达 → 启动失败 + 引导信息。
- **Files**：`src/util/opencode.ts`、`src/routes/health.ts`、`src/main.ts` 启动钩子
- **Size**：S
- **Deps**：P-1-03

#### P-1-05 CLI 子命令骨架

- **What**：`agent-workflow start / stop / status / version / doctor / config get|set / migrate / backup`（M1 实现 start/stop/status/version/doctor/config get|set；其余预留）。`stop` 读 lock 文件 PID 发 SIGTERM。`status` 打印 PID + 端口 + URL。`doctor` 跑全套健康检查不启 daemon。
- **Files**：`src/cli/*.ts`、`src/main.ts` 命令路由
- **Tests**：bun:test 模拟每个子命令（stub 文件系统）。
- **Size**：M
- **Deps**：P-1-01、P-1-03、P-1-04

#### P-1-06 Logger（结构化）

- **What**：`Log.create({ service })`，输出 stdout + 同步追加 `~/.agent-workflow/logs/daemon.log`，10MB rotate × 5。Level：debug / info / warn / error，受环境变量与 settings 控制。
- **Files**：`src/util/log.ts`
- **Tests**：rotate 验证、level filter 验证。
- **Size**：S
- **Deps**：P-1-01

#### P-1-07 错误响应统一 schema 与 Hono 错误中间件

- **What**：Hono error middleware 把所有错误归一化为 `{ ok: false, code, message, details? }` + 正确 HTTP status。NotFound / ValidationError / DomainError 三类基础错误类型。
- **Files**：`src/server.ts`、`src/util/errors.ts`、`packages/shared/src/schemas/error.ts`
- **Tests**：bun:test 验证各类错误产生正确响应。
- **Size**：S
- **Deps**：P-1-02

#### P-1-08 Agents CRUD（含 frontmatter 表单 + body markdown）

- **What**：服务层 `services/agent.ts` + 路由 `/agents`、`/agents/{name}`：GET 列表 / 详情、POST 创建、PUT 更新、DELETE（被引用拒绝；M1 仅检查 workflows 引用，task 不算）、POST `/rename`。frontmatter 字段全持久到 DB 列。`outputs / skills` 是 JSON array 列。
- **Files**：`src/services/agent.ts`、`src/routes/agents.ts`、`packages/shared/src/schemas/agent.ts`
- **Tests**：CRUD round-trip；DELETE 拒绝（造一个引用它的 workflow）；duplicate name 拒绝。
- **Size**：M
- **Deps**：P-0-05、P-1-07

#### P-1-09 Skills CRUD（含文件树 + 外部路径登记）

- **What**：服务层 `services/skill.ts` + 路由 `/skills`、`/skills/{name}`、`/skills/{name}/files/*`、`/skills/import-external`。Managed skill 写到 `~/.agent-workflow/skills/{name}/files/SKILL.md`；External skill 仅 DB 记录路径。文件树 endpoint 列出 / 读 / 写 / 删 支撑文件。
- **Files**：`src/services/skill.ts`、`src/routes/skills.ts`、`src/util/fs.ts`、`packages/shared/src/schemas/skill.ts`
- **Tests**：managed CRUD round-trip + 文件树读写；external 注册 + 路径不存在拒绝。
- **Size**：L
- **Deps**：P-1-07

#### P-1-10 仓最近列表 + ref / 文件树 endpoint

- **What**：`/api/repos/recent` (GET / POST upsert)；`/api/repos/refs?path=...`（调 `git for-each-ref`、`git log --oneline -n 50` 等）；`/api/repos/files?path=...`（worktree 当前文件树，启动表单文件选择器用）。
- **Files**：`src/services/repo.ts`、`src/routes/repos.ts`、`src/util/git.ts`
- **Tests**：起一个临时 git 仓，验证 ref 列表 + recent upsert。
- **Size**：M
- **Deps**：P-1-07、P-0-05

#### P-1-11 Workflow CRUD（仅基本字段）

- **What**：服务 + 路由 `/workflows`、`/workflows/{id}`。`definition` 字段是 JSON。M1 仅做最基本校验（JSON shape 通过 zod；不校验拓扑/端口连接 —— 那是 M2 的 P-2-01）。`POST /validate` 返回空（M2 实现）。
- **Files**：`src/services/workflow.ts`、`src/routes/workflows.ts`、`packages/shared/src/schemas/workflow.ts`
- **Tests**：CRUD round-trip + version+1。
- **Size**：M
- **Deps**：P-0-05、P-1-07

#### P-1-12 Worktree 管理 helper

- **What**：`createWorktree(repo, taskId, baseBranch)` + `removeWorktree`。在 `~/.agent-workflow/worktrees/{slug}/{taskId}` 下建 worktree，分支 `agent-workflow/{taskId}`。`repoSlug = sha1(path).slice(0,8) + '-' + basename`。
- **Files**：`src/util/git.ts`
- **Tests**：起临时仓 → createWorktree → 验证目录与分支 → removeWorktree → 验证清理。
- **Size**：S
- **Deps**：P-0-05

#### P-1-13 OPENCODE 子进程 spawn + 协议块 + envelope 解析

- **What**：核心 runner。函数 `runNode(task, nodeRun, agent)`：
  1. 准备 `runDir = ~/.agent-workflow/runs/{task.id}/{nodeRunId}/.opencode`
  2. 注入 managed skills 拷贝、external skills symlink
  3. 构造 `OPENCODE_CONFIG_CONTENT` inline JSON
  4. 拼接 user prompt（节点模板 + 章节拼接 + 英文协议块）
  5. spawn `opencode run "<prompt>" --agent <name> --format json --dangerously-skip-permissions`
  6. 流式读 stdout 行 → 解析 JSON event → 写 `node_run_events`
  7. 子进程退出后用 `extractLastEnvelope` + `parseEnvelope` 拿 outputs，写 `node_run_outputs`
  8. 清理 runDir
- **Files**：`src/services/runner.ts`、`src/services/protocol.ts`、`src/services/envelope.ts`
- **Tests**：用 stub bash 脚本模拟 opencode（输出预期 JSON 行 + envelope），验证 runner 完整产出 events + outputs；envelope 解析的边界（多个 envelope / 缺 port / 没 envelope）。
- **Size**：L
- **Deps**：P-0-05、P-1-09、P-1-12

#### P-1-14 Task 启动 + DAG 调度（线性版本）

- **What**：`POST /api/tasks` → 创 task 记录 → 创 worktree → 内存 DAG（M1 简化：只支持 input → agent-single → ... → 线性链）→ 顺序调度每个节点。**不**支持并发、wrapper、多进程、retry。`GET /api/tasks/{id}`、`GET /api/tasks` 列表。
- **Files**：`src/services/task.ts`、`src/services/scheduler.ts`、`src/routes/tasks.ts`
- **Tests**：建一个 2 节点线性 workflow + stub agent → POST /tasks → 轮询直到 done → 验证 outputs。
- **Size**：L
- **Deps**：P-1-08、P-1-11、P-1-12、P-1-13

#### P-1-15 Cancel task

- **What**：`POST /api/tasks/{id}/cancel` → 杀正在跑的 opencode 子进程 → 状态置 canceled → worktree 保留。
- **Files**：`src/services/task.ts`、`src/services/runner.ts`（增加 abort 信号）
- **Tests**：长跑 stub agent → cancel → 验证子进程被杀 + 状态变更。
- **Size**：S
- **Deps**：P-1-14

#### P-1-16 前端骨架：路由、Layout、API client

- **What**：Vite + React 19 + TanStack Router 起最小壳。Layout 含左侧栏（Agents / Skills / Workflows / Tasks / Settings）。`api/client.ts` fetcher（带 token，从 localStorage 读，没有则跳"输 token"页）。基础页面占位。
- **Files**：`packages/frontend/src/main.tsx`、`routes/__root.tsx`、`api/client.ts`、`pages/*.tsx`、`stores/auth.ts`
- **Size**：M
- **Deps**：P-0-02

#### P-1-17 前端 Agents / Skills 列表 + 编辑界面

- **What**：列表用 shadcn DataTable；行末"打开 / 复制 / 删除"。Agent 编辑：左 frontmatter 表单（含 outputs chips / readonly switch / model / variant / temperature / permission 表单 + raw JSON / steps / skills chips） + 右 Markdown Edit/Preview。Skill 编辑：文件树 + Edit/Preview。
- **Files**：`pages/Agents.tsx`、`pages/AgentDetail.tsx`、`pages/Skills.tsx`、`pages/SkillDetail.tsx`、`components/MarkdownEditor.tsx`、`components/SkillFileTree.tsx`
- **Size**：L
- **Deps**：P-1-08、P-1-09、P-1-16

#### P-1-18 前端 Tasks 简化版（列表 + 详情）

- **What**：列表表格 + 顶部状态 chips。详情页 M1 只展示 task 元信息 + 节点 status 列表 + 当前 worktree git diff。**不做** xyflow 画布（M2）。轮询刷新。
- **Files**：`pages/Tasks.tsx`、`pages/TaskDetail.tsx`、`components/DiffViewer.tsx`
- **Size**：M
- **Deps**：P-1-14、P-1-16

### M1 验收

跑通：
1. `agent-workflow start` 启动成功，stdout 打印 URL + token
2. 浏览器打开 → 创 1 个 agent（如 "echo-agent"，prompt 让它原样回 input → 输出 envelope）+ 1 个 skill
3. 通过 API（M1 不做编辑器，所以用 curl 或 prebuilt fixture）创一个 2 节点线性 workflow
4. 启动 task → 等到 done → task 详情看到节点 outputs + worktree diff（如果有变更）
5. cancel 一个长跑 task 也工作
6. 三层测试（bun:test 后端 + 简单 vitest + 一个 e2e 雏形）通过 CI

---

## M2 — 编辑器与状态视图

### 目标

可视化用户旅程闭环：用户**仅在 UI 里**就能完成 agent 创建 → workflow 拖拽 → 启动 → 看节点变绿 → 查节点详情。WS 推送到位，多 tab 同步生效。

### Issues

#### P-2-01 Workflow 静态校验完整 5 项

- **What**：`POST /api/workflows/{id}/validate` 返回错误列表。5 项：边端口存在性 / 拓扑（环只在 loop wrapper 内）/ wrapper 必填 / 引用合法（agent/skill/sourcePort/binding/inputKey）/ 节点 prompt 模板 `{{port_name}}` 引用合法。
- **Files**：`src/services/workflow.validator.ts`
- **Tests**：每项 invalid case + valid case 各一。
- **Size**：M
- **Deps**：P-1-11

#### P-2-02 WS 框架 + 三频道骨架

- **What**：Bun 内置 WebSocket。三个频道：`/ws/tasks/{taskId}` / `/ws/tasks` / `/ws/workflows`。订阅时验证 token。`/ws/tasks/{id}` 支持 `?since=` 重放（从 events 表回放 id > since 的事件）。建立一个全局 broadcaster：服务端任何修改 → broadcast 到对应频道订阅者。
- **Files**：`src/ws/server.ts`、`src/ws/broadcaster.ts`、`src/ws/protocol.ts`、`packages/shared/src/schemas/ws.ts`
- **Tests**：起 WS client 验证三频道连得上、收到正确事件类型。
- **Size**：L
- **Deps**：P-1-02、P-1-14

#### P-2-03 Workflow 编辑器：xyflow 画布骨架

- **What**：`<WorkflowCanvas>` 组件，xyflow v12。基础平移缩放、minimap、节点 drag move、删除按 Delete 键。布局自动从 workflow.definition 渲染。
- **Files**：`pages/WorkflowEdit.tsx`、`components/canvas/WorkflowCanvas.tsx`、`components/canvas/nodes/*`、`components/canvas/edges/*`
- **Size**：L
- **Deps**：P-1-11、P-1-16

#### P-2-04 节点类型自定义渲染

- **What**：`<AgentNode>` / `<MultiProcessAgentNode>`（M2 渲染但 multi-process 选项灰着，等 M3）/ `<InputNode>` / `<OutputNode>` / `<GitWrapperNode>` 占位（M3 实现）/ `<LoopWrapperNode>` 占位（M4 实现）。每种节点显示端口圆点 + agent 名 + 状态色（M2 编辑模式仅默认色）。
- **Files**：`components/canvas/nodes/AgentNode.tsx` 等
- **Size**：M
- **Deps**：P-2-03

#### P-2-05 编辑器侧栏（拖拽创建源）

- **What**：左侧 240px 宽 sidebar：Agents 分组（顶搜索框 + 列表）、Wrappers（git/loop）、IO（input/output）。HTML5 drag → onDrop 创建节点。
- **Files**：`components/EditorSidebar.tsx`、`stores/editor.ts`
- **Size**：M
- **Deps**：P-2-03、P-2-04

#### P-2-06 节点抽屉（Edit / Preview 双 tab）

- **What**：右侧 480px 抽屉，节点选中后弹出。Edit tab 字段：agent 选择器（搜索）、prompt template（Markdown 编辑器，支持 `{{port_name}}` 高亮）、model/variant/temperature 覆写、retries、timeout、dangerouslySkipPermissions toggle、（M3 加 multi-process toggle + 分片策略）。Preview tab：mock port 输入 + 实时拼接结果（含框架协议块）。
- **Files**：`components/NodeInspector.tsx`、`components/PromptPreview.tsx`
- **Tests**：vitest 测试 prompt 拼接逻辑（与后端共享算法 → 提到 shared 包）。
- **Size**：L
- **Deps**：P-2-03、P-1-08

#### P-2-07 编辑器右键菜单 + 多选 + 复制粘贴

- **What**：节点右键（复制 / 删除 / 组合为 wrapper / 解组 / 跳到 agent 详情）；边右键（删除 / 反转 / 重路由）；画布空白右键（粘贴 / 全选 / 自动布局）。Cmd+C / Cmd+V / Cmd+A / Delete 快捷键。撤销 / 重做（Cmd+Z / Shift+Cmd+Z）—— 仅画布操作。
- **Files**：`components/canvas/ContextMenu.tsx`、`stores/editor.history.ts`
- **Size**：L
- **Deps**：P-2-03、P-2-04、P-2-05

#### P-2-08 自动布局 + 网格吸附 + minimap

- **What**：自动布局：用 `dagre` 或 `elkjs`；按拓扑顺序重排节点。网格吸附：xyflow `snapToGrid`。Minimap：xyflow `<MiniMap>`。
- **Files**：`components/canvas/WorkflowCanvas.tsx` 增强
- **Size**：M
- **Deps**：P-2-03

#### P-2-09 自动保存 + 多 tab sync

- **What**：编辑器内修改 debounce 1s → PUT `/api/workflows/{id}` → 服务端 broadcast 到 `/ws/workflows`。其他 tab 收到 `workflow.updated` 且 version 较新 → toast"其他 tab 已修改" → 自动 refetch。
- **Files**：`stores/editor.ts`、`hooks/useWorkflowSync.ts`
- **Tests**：起 2 个 client 模拟多 tab。
- **Size**：M
- **Deps**：P-1-11、P-2-02、P-2-03

#### P-2-10 Workflow 输入节点配置 + 启动表单生成

- **What**：节点抽屉里输入节点的字段配置（kind / key / label / required / 各 kind 特有字段）。启动表单页根据 workflow.inputs 动态渲染：
  - 文本（单行 / Markdown） + placeholder + default + maxLength
  - 多文件路径选择器（相对仓根 + minCount/maxCount + file/dir/both）
  - 枚举（单/多选 + allowOther）
  - git 对象（branch / commit-range / pr；branch 实时调 `/repos/refs`）
  - 隐式必备：仓选择器（recent_repos） + base 分支选择器
  - "从以往 task 填充"下拉
  - 提示信息条：当前仓上正在跑的 task / 仓主未提交变更
- **Files**：`components/InputNodeConfig.tsx`、`pages/TaskLauncher.tsx`、`components/inputs/*Input.tsx`、`components/RepoPicker.tsx`、`components/RefPicker.tsx`、`components/RepoFilePicker.tsx`
- **Size**：L
- **Deps**：P-1-10、P-2-06

#### P-2-11 Workflow 输出节点 + Task 详情产出面板

- **What**：节点抽屉里输出节点的"展示用 port"配置（绑定到 (nodeId, portName)）。Task 详情页顶部"产出"面板：每个 port 一张卡片，可复制。Output 节点状态恒 done。
- **Files**：`components/OutputNodeConfig.tsx`、`components/TaskOutputPanel.tsx`、`pages/TaskDetail.tsx` 顶部区
- **Size**：M
- **Deps**：P-2-06

#### P-2-12 Task 详情页：三区布局

- **What**：`<TaskDetailPage>`：顶产出 + 中状态画布（70vh）+ 下 git diff（默认展开）。状态画布复用 `<WorkflowCanvas>` 但 readOnly + 状态色 overlay；点节点弹右抽屉。
- **Files**：`pages/TaskDetail.tsx` 改造、`components/canvas/StatusOverlay.tsx`
- **Size**：M
- **Deps**：P-2-03、P-2-11

#### P-2-13 节点详情抽屉 4 tab（Prompt / Events / Output / Stats）—— M2 简化版

- **What**：M2 实现 Prompt + Output + Stats（没有 retries history、没有子进程列表 — 那是 M3）。Events tab 实时通过 `/ws/tasks/{id}` 流推送，前端 200ms throttle render，按 kind 过滤 chips。Raw stdout 切换通过 `/api/tasks/{id}/nodes/{id}/stdout` 拉。
- **Files**：`components/NodeDetailDrawer.tsx`、`components/EventsTab.tsx`、`components/PromptTab.tsx`、`components/OutputTab.tsx`、`components/StatsTab.tsx`
- **Size**：L
- **Deps**：P-2-02、P-2-12

#### P-2-14 任务列表实时刷新

- **What**：`/api/tasks` 列表页订阅 `/ws/tasks` 频道；收到 `task.created/status/deleted` 事件 → invalidate 列表 query。筛选：状态 chips + 仓 + workflow + 时间范围；排序：启动时间 / 耗时。
- **Files**：`pages/Tasks.tsx`、`hooks/useTasksSync.ts`
- **Size**：M
- **Deps**：P-1-18、P-2-02

#### P-2-15 Settings 页（4 标签页）

- **What**：运行时 / 限额 / GC / 网络 4 标签页。每个保存后 toast "已保存" + 标注哪些重启后生效。"重生 token"按钮、"刷新 model 列表"按钮。
- **Files**：`pages/Settings.tsx`、`pages/settings/Runtime.tsx` 等
- **Size**：M
- **Deps**：P-1-03

#### P-2-16 浏览器登录流程 + token 处理

- **What**：URL 带 `?token=...` → 提取存 localStorage → 跳到 / 路径。无 token → "等待 token"页（指引用户从 daemon stdout 复制 URL）。401 → 清空 localStorage 跳"等待 token"。
- **Files**：`stores/auth.ts`、`pages/AwaitToken.tsx`、`api/client.ts` 拦截器
- **Size**：S
- **Deps**：P-1-16

### M2 验收

1. 用户全程 UI 操作：创 agent、创 skill、拖拽出 audit-after-worker workflow、保存、启动 → 看节点流式变绿 → 节点详情看 events 流。
2. 多 tab 编辑同一 workflow → 后写胜出 + 其他 tab 收到提示。
3. 启动表单 4 种控件全部能用，git 对象能拉出仓 ref。
4. 静态校验 5 项触发与不触发都验证。
5. WS 断线重连后能拿到错过的 events（`?since=`）。

---

## M3 — 编排核心（多进程 / wrapper / retry）

### 目标

实现"代码 → 审计（fan-out）→ 修复（fan-out）"这一 v1 招牌场景；retry / resume / single-node retry / cancel 全部完整。

### Issues

#### P-3-01 GitDiff 计算与三种分片

- **What**：`gitDiffSnapshot(wtPath, prev)` 返回包含 committed + working tree + untracked 的合并 diff。`splitDiffPerFile(diff)` / `splitDiffPerNFiles(diff, n)` / `splitDiffPerDirectory(diff, depth)` 三个分片函数。重命名 = 1 shard，二进制文件不进入分片但 list 跟随。
- **Files**：`src/util/git.ts` 增强、`src/util/diffSplit.ts`
- **Tests**：用真实 git fixtures（含 rename / binary / 多目录），各种分片策略产出符合预期。
- **Size**：L
- **Deps**：P-1-12

#### P-3-02 Multi-process 节点调度（fan-out）

- **What**：节点 kind=`agent-multi`：runtime 等 `sourcePort` ready → 调用分片 → 为每个 shard 创建子 node_run（parent_node_run_id 指向父）→ 父节点用独立 semaphore 调度子进程（容量 `multiProcessSubprocessConcurrency`，独立于全局）→ 等所有 shard 结束 → 聚合 outputs（按 shard_key 字典序拼接）+ 自动 errors port 输出。
- **Files**：`src/services/scheduler.ts` 扩展、`src/services/runner.ts` 增 fan-out 路径
- **Tests**：build a workflow with multi-process audit + stub agent → 验证 N shards 起 N 个子进程、聚合正确、空 diff 直接 done、部分 fail 时 errors port 输出。
- **Size**：L
- **Deps**：P-1-13、P-1-14、P-3-01

#### P-3-03 Git wrapper

- **What**：节点 kind=`wrapper-git`。runtime 在 wrapper 进入第一个内层节点前调 `gitDiffSnapshot` 拍快照；最后内层节点 done 后再拍；输出 = 后 − 前 的合并 diff。Wrapper 在画布上显示边界框 + 单个 `git_diff` 输出端口。
- **Files**：`src/services/scheduler.ts`（wrapper expand 子图）、`components/canvas/nodes/GitWrapperNode.tsx`
- **Tests**：workflow: input → git-wrapper{ worker → audit-multi } → 验证 audit-multi 的 sourcePort 拿到正确 diff。
- **Size**：M
- **Deps**：P-1-12、P-3-01、P-2-04

#### P-3-04 Wrapper UI：组合 / 解组 + 边界拖拽

- **What**：右键"组合为 wrapper"→ 子菜单选 git/loop → 自动建 wrapper 节点 + 把所选节点 nodeIds 加进 wrapper.nodeIds。"解组"反操作。Wrapper 边界可拖拽改大小（xyflow group nodes）。
- **Files**：`components/canvas/ContextMenu.tsx` 扩展、`stores/editor.ts` 增 wrapper ops
- **Size**：M
- **Deps**：P-2-07、P-3-03

#### P-3-05 写入串行 / 只读并发 调度

- **What**：调度器并发模型 — 全局 semaphore（max_concurrent_nodes）+ task 内写入 semaphore（容量 1，只对 `agent.readonly=false` 节点占用）。multi-process 子进程独立池。`runtime` 每次拿节点前申请相应 semaphore。
- **Files**：`src/services/scheduler.ts` 增强 + `src/util/semaphore.ts`
- **Tests**：构造 1 写 + 2 读 workflow → 验证写入完成前 2 读并发；构造 2 写 → 验证串行。
- **Size**：M
- **Deps**：P-1-14

#### P-3-06 节点 retries（无间隔立即重试，retry_index 独立 node_run）

- **What**：节点 status=failed 且 `retry_index < node.retries` → 新建 node_run（同 node_id、同 iteration、retry_index+1），prompt 完全一致。最后一次仍 failed 才 propagate。
- **Files**：`src/services/scheduler.ts` 失败处理增强
- **Tests**：stub agent 故意前 2 次 fail，retries=3 → 第 3 次 done，task done。
- **Size**：M
- **Deps**：P-1-14、P-3-05

#### P-3-07 节点 start 前 worktree 快照（用于 retry/resume rollback）

- **What**：写入节点 start 前调 `git stash create` 拿 sha → 写到 `node_runs.pre_snapshot` + `~/.agent-workflow/snapshots/{taskId}/{nodeRunId}.snapshot`。Retry / resume 时调 `rollbackBeforeRetry(wtPath, sha)`：`git reset --hard HEAD` + `git clean -fd` + `git stash apply <sha>`。
- **Files**：`src/util/git.ts` 增 snapshot/rollback、`src/services/runner.ts` 接入快照
- **Tests**：写入节点跑后改了文件 → retry 前回滚 → 验证文件回到 start 前状态。
- **Size**：M
- **Deps**：P-1-12、P-3-06

#### P-3-08 Resume from failed/interrupted

- **What**：`POST /api/tasks/{id}/resume`：找所有 status in (failed, interrupted) 的 node_runs → 写入节点回滚到各自 pre_snapshot → 这些 node_runs 状态 → pending → 重新启动调度。Done 节点保留不重跑。
- **Files**：`src/services/task.ts` 增 resume、`src/services/scheduler.ts` 配合
- **Tests**：人为 fail 节点 → resume → 验证 worktree 回滚 + 重跑 + 通过。
- **Size**：M
- **Deps**：P-3-06、P-3-07

#### P-3-09 Single-node retry（含级联下游）

- **What**：`POST /api/tasks/{id}/nodes/{nodeRunId}/retry?cascade=true|false`。cascade=true（默认）→ 该节点 + 它原本被它触发过的所有下游节点都回滚 + 置 pending。cascade=false → 仅该节点。
- **Files**：`src/services/task.ts` 增 retry-node、`src/services/scheduler.ts`
- **Tests**：cascade=true 验证下游也重跑；cascade=false 验证下游不动。
- **Size**：M
- **Deps**：P-3-08

#### P-3-10 节点详情 4 tab —— retries history + 子进程列表

- **What**：M2 已实现 Prompt/Events/Output/Stats 基本壳。M3 加：
  - Stats tab 加 token 5 项 + 耗时 + exit code + Retries history 列表（同节点其他 retry_index node_runs）
  - 多进程父节点详情：左侧子进程列表（shard_key / status / token / 点击进入子 shard 详情，子 shard 也有 Prompt/Events/Output/Stats 4 tab）
- **Files**：`components/StatsTab.tsx` 增强、`components/SubProcessList.tsx`
- **Size**：M
- **Deps**：P-2-13、P-3-02、P-3-06

#### P-3-11 节点 prompt 模板内置变量替换

- **What**：runner 拼接 user prompt 时支持 `{{port_name}}` + `{{__repo_path__}}` / `{{__base_branch__}}` / `{{__task_id__}}` 替换。模板里引用不存在 port 在校验阶段已拒绝 → 运行时如果还出现就 hard error（不应该）。
- **Files**：`src/services/protocol.ts`、`packages/shared/src/templating.ts`
- **Tests**：单元测试模板替换。
- **Size**：S
- **Deps**：P-1-13

#### P-3-12 资源限额：per-node timeout

- **What**：节点 spawn 时设 timeout（默认 settings.defaultPerNodeTimeoutMs，节点 override 优先）。超时 SIGTERM 子进程，节点 status=failed，error=`node-timeout`。
- **Files**：`src/services/runner.ts` 增 timeout
- **Tests**：stub agent sleep 长时间 → 验证 timeout 触发。
- **Size**：S
- **Deps**：P-1-13

#### P-3-13 stderr 持久化与 Raw stdout endpoint

- **What**：opencode 子进程 stderr 也读，每行写 `node_run_events`(kind=stderr)；stdout 全文（拼接所有行）超过 1MB 阈值的部分写 `~/.agent-workflow/logs/{taskId}/{nodeRunId}.jsonl`，DB 内仅存指针。`GET /api/tasks/{id}/nodes/{id}/stdout` 拼起来返回。
- **Files**：`src/services/runner.ts` 增 stderr handling、`src/routes/tasks.ts`、`src/util/largeOutput.ts`
- **Size**：M
- **Deps**：P-1-13

#### P-3-14 Task 失败处理与 UI 错误概述

- **What**：task.error_summary（短文本）+ task.error_message（详细）+ task.failed_node_id 字段。前端 task 详情页顶部红色错误条 + "跳到失败节点"按钮。任务启动失败（worktree 创建失败 / agent 不存在 / opencode 未安装等）也建 task 记录 status=failed。
- **Files**：`src/services/task.ts` 增 error 字段、`pages/TaskDetail.tsx` 顶部错误条
- **Size**：S
- **Deps**：P-1-14

### M3 验收

1. 完整 audit-after-worker pipeline：worker（写入）→ git-wrapper{ multi-process audit (fan-out per-file) → multi-process fix (fan-out) } → 全部跑通
2. fix 节点故意写入失败 → resume 触发 worktree 回滚 → 重跑通过
3. multi-process 节点的子进程列表正确展示，部分 shard 失败时 errors port 有内容
4. 节点 retries=3 + stub agent 前 2 次失败 → 第 3 次成功，UI Stats tab 看到 retries history
5. 长跑节点 timeout → 自动 cancel
6. stderr / Raw stdout 都能在 UI 看到

---

## M4 — 高级编排（Loop / 嵌套 / 资源限额 / 导入导出）

### Issues

#### P-4-01 Loop wrapper 调度

- **What**：节点 kind=`wrapper-loop`。调度器 loop 循环：每轮跑 wrapper 内子图 → 退出条件 evaluate（3 种内置）→ 满足则把 outputBindings 复制到 wrapper 输出 + 标 done；不满足 iteration+1 → 重跑；max_iterations 仍未满足 → 标 exhausted（task=failed）。
- **Files**：`src/services/scheduler.ts` 增 loop expand、`src/services/exitConditions.ts`
- **Tests**：3 种退出条件各一个 case；max_iterations 触发 exhausted。
- **Size**：L
- **Deps**：P-3-03、P-3-05

#### P-4-02 Loop wrapper UI

- **What**：节点配置抽屉支持配 `max_iterations`、`exit_condition`（kind 下拉 + nodeId/portName 选 + value/n 字段）、`outputBindings`（添加多组绑定）。Wrapper 边界 UI、节点状态色蓝色（loop body）。
- **Files**：`components/canvas/nodes/LoopWrapperNode.tsx`、`components/LoopWrapperConfig.tsx`、`components/canvas/StatusOverlay.tsx` 加蓝色逻辑
- **Size**：M
- **Deps**：P-3-04、P-4-01

#### P-4-03 Wrapper 任意嵌套（git in loop / loop in git / loop in loop）

- **What**：调度器递归 expand 嵌套 wrapper。git in loop 的 git_diff 输出 = 退出那一轮的 diff；loop in git 的 git_diff 输出 = loop 全部跑完后的总 diff。
- **Files**：`src/services/scheduler.ts` 嵌套处理
- **Tests**：构造 4 种嵌套组合（git-in-loop、loop-in-git、loop-in-loop、git-in-git），各自 happy path。
- **Size**：M
- **Deps**：P-3-03、P-4-01

#### P-4-04 资源限额执行：per-task duration + token

- **What**：daemon 内 1Hz 后台 tick 扫描所有 running task。`now - started_at > max_duration_ms` → 自动 cancel + error=`task-time-limit-exceeded`。`sum(node_runs.tok_total) > max_total_tokens` → 自动 cancel + error=`task-token-limit-exceeded`。
- **Files**：`src/services/limits.ts`、`src/main.ts` 起 tick
- **Tests**：mock 时间 / mock token sum，触发限额。
- **Size**：M
- **Deps**：P-1-14

#### P-4-05 Token 数据从 events 提取

- **What**：opencode JSON event 里有 token 字段（part.time + tokens 在 step-finish 等 event 中）。runner 在解析 event 时累加到 node_run.tok_*。父 multi-process 节点 token = 子 shard 之和。
- **Files**：`src/services/runner.ts` 增 token 累加、`src/services/tokenAggregate.ts`
- **Tests**：fixture event stream → 验证 tok 字段累加正确。
- **Size**：M
- **Deps**：P-1-13

#### P-4-06 Daemon SIGTERM/SIGINT graceful shutdown 30s

- **What**：daemon 收信号后先停接 API，给所有 running 子进程发 SIGTERM；30 秒内每个子进程退出后正常 mark canceled；30 秒后仍存活的 SIGKILL，对应 node_run mark interrupted。释放 lock 退出。
- **Files**：`src/main.ts` 信号处理、`src/services/runner.ts` 配合
- **Tests**：起一个长跑任务 → daemon SIGTERM → 验证 30s 内子进程被终止、状态正确。
- **Size**：M
- **Deps**：P-1-15

#### P-4-07 Daemon 重启扫描孤儿 + interrupted 状态

- **What**：daemon 启动时扫描 `tasks.status='running'` / `node_runs.status='running'`：检查 PID（kill -0）→ 存活则 SIGKILL → 全部标 interrupted。task.error_message=`daemon-restart`。
- **Files**：`src/services/orphans.ts`、`src/main.ts` 启动钩子
- **Tests**：模拟"上次运行"留 running 记录 → 启动 → 验证扫描结果。
- **Size**：S
- **Deps**：P-1-14

#### P-4-08 YAML 导入导出

- **What**：`GET /api/workflows/{id}/export` → YAML（人类友好缩进）。`POST /api/workflows/{id}/import` 接 YAML body：检测同名 / 同 ID 冲突 → 不直接处理，返回 `code=workflow-import-conflict` + details，让前端弹窗"跳过 / 覆盖 / 导为新件"。
- **Files**：`src/services/workflow.yaml.ts`（用 `js-yaml`）、`src/routes/workflows.ts` 增 endpoint、`pages/WorkflowImport.tsx` 弹窗
- **Tests**：round-trip：export → import → 同 ID 触发冲突弹窗。
- **Size**：M
- **Deps**：P-1-11

#### P-4-09 Worktree GC 后台任务

- **What**：daemon 每小时扫一次 worktrees。如果 settings.worktreeAutoGc.enabled：满足 olderThanDays 或 onlyMerged 条件的 worktree → 删除（保留 task 记录）。
- **Files**：`src/services/gc.ts`、`src/main.ts` 起任务
- **Tests**：fixture worktree + mock 时间，验证 GC 逻辑。
- **Size**：S
- **Deps**：P-1-12

#### P-4-10 Task 详情：cancel 后行为 + 启动失败显式记录

- **What**：UI 完善：cancel task 后 worktree 保留，UI 提示"worktree 仍在 X 路径"。task 启动失败的原因（worktree 创建失败 / agent 不存在）也展示在 task 详情错误条。`POST /api/tasks` 即使失败也返回新 task id（ status=failed 直接落库）。
- **Files**：`src/services/task.ts` 失败路径、`pages/TaskDetail.tsx` cancel UI
- **Size**：S
- **Deps**：P-1-14、P-3-14

#### P-4-11 Loop 反馈语义文档化

- **What**：v1 不支持跨轮反馈端口，但要在 UI 与 docs 里明确：跨轮状态完全靠 worktree 文件传递。编辑器配 loop 时给提示气泡。
- **Files**：`components/LoopWrapperConfig.tsx`、`design/proposal.md`
- **Size**：S
- **Deps**：P-4-02

### M4 验收

1. 反馈循环 audit→fix→audit pipeline 跑通：fix 写文件 → 下轮 audit 读到新内容 → 满足 port_count_lt 退出
2. 嵌套 4 种组合（git-in-loop / loop-in-git / loop-in-loop / git-in-git）各跑一次
3. per-task 时长 / token 限额触发自动 cancel
4. daemon SIGTERM 30s graceful 验证
5. YAML 导出 → 重新导入 → 冲突弹窗工作
6. worktree GC 触发 → 旧 worktree 被清

---

## M5 — 打磨与发布

### Issues

#### P-5-01 events 表归档后台任务

- **What**：每小时跑一次：扫 `node_run_events`，按 `node_run_id` 分组；每组超 `eventsArchiveThresholds.perNodeRunRows` 或全局超 `globalRows` → 把这部分 dump 到 `~/.agent-workflow/logs/{taskId}/{nodeRunId}.jsonl` → 从 DB 删除。读 endpoint 自动 fallback 到 jsonl。
- **Files**：`src/services/eventsArchive.ts`、`src/routes/tasks.ts` events endpoint 增 fallback
- **Tests**：构造大量 events → 触发归档 → 验证 endpoint 能从 jsonl 读回。
- **Size**：M
- **Deps**：P-1-13

#### P-5-02 备份 / 恢复 CLI + Settings 按钮

- **What**：`agent-workflow backup` + Settings "导出备份"按钮 → 触发后台：SQLite `.backup TO` 事务 dump + skills/ tar + workflows/ YAML dump + config.json → 一并打到 `~/.agent-workflow/backups/{date}.tar.gz`。**不含** worktrees / runs / logs / token。
- **Files**：`src/services/backup.ts`、`src/cli/backup.ts`、`pages/Settings.tsx` 增按钮
- **Tests**：执行 backup → 解压验证内容。
- **Size**：M
- **Deps**：P-0-05

#### P-5-03 i18n + 中文 locale 完整化

- **What**：i18next + react-i18next。建 `locales/zh-CN.json` 完整覆盖 UI 文案。错误码 → i18n key 映射。预留 en-US（v1 仅占位）。
- **Files**：`packages/frontend/src/i18n/`、所有 React 组件文案外提
- **Size**：L
- **Deps**：所有 UI issue

#### P-5-04 暗色主题适配

- **What**：默认跟随系统主题；settings 切 system / light / dark。所有 shadcn 组件 + 自定义组件加 dark mode 样式。xyflow 节点配色双套。
- **Files**：`packages/frontend/src/styles/`、`hooks/useTheme.ts`
- **Size**：M
- **Deps**：所有 UI issue

#### P-5-05 Bun build 单二进制 + 嵌入前端 dist

- **What**：脚本 `bun run build:binary`：先 `bun --filter frontend build`，把产物拷到 backend/embed/，backend 用 `Bun.embeddedFiles` 嵌入 + `Bun.build({ compile: true })` 出二进制 `dist/agent-workflow-{platform}-{arch}`。
- **Files**：`scripts/build-binary.ts`、`packages/backend/src/embed.ts`
- **Tests**：CI 跑构建 + smoke test（启动二进制 → 调 /health）。
- **Size**：M
- **Deps**：所有

#### P-5-06 GitHub Releases 自动发布

- **What**：`.github/workflows/release.yml`：tag `v*` 触发 → matrix（macos-arm64 + linux-x86_64）→ 跑 `build:binary` → 上传二进制到 Release。
- **Files**：`.github/workflows/release.yml`
- **Size**：S
- **Deps**：P-5-05

#### P-5-07 Playwright e2e

- **What**：测一条主线：daemon 启动 → 浏览器 → 创 agent → 创 workflow → 启动 task → 节点变绿 → 查节点详情。stub opencode 用一个 bash 脚本输出预期事件流。
- **Files**：`e2e/main.spec.ts`、`e2e/fixtures/stub-opencode.sh`、`playwright.config.ts`
- **Size**：M
- **Deps**：M2 全部

#### P-5-08 vitest 前端关键组件单元

- **What**：`<NodeInspector>` / `<TaskLauncher>` / `<WorkflowCanvas>` 几个交互密集组件加测试。Mock TanStack Query。
- **Files**：`packages/frontend/**.test.tsx`
- **Size**：M
- **Deps**：M2 全部

#### P-5-09 Settings 修改后 UI 提示哪些重启后生效

- **What**：保存 settings 后 toast：`bind host` / `bind port` 已修改，需重启 daemon 生效。其他项立即生效。
- **Files**：`pages/Settings.tsx`、`src/services/config.ts`
- **Size**：S
- **Deps**：P-2-15

#### P-5-10 用户引导 / first-run

- **What**：首次启动 daemon 没有任何 agent / workflow → 首页显示"快速开始"卡片：步骤指引（建 agent → 建 skill → 建 workflow → 启 task）。Demo workflow 一键导入（YAML fixture）。
- **Files**：`pages/Onboarding.tsx`、`fixtures/demo-workflow.yaml`
- **Size**：M
- **Deps**：P-4-08

#### P-5-11 README + 用户文档

- **What**：根 README：项目简介、快速开始（下载二进制 → start → 打开 URL）、最低 opencode 版本、常见问题。`docs/`：架构概览、agent.md / SKILL.md schema、workflow YAML schema 参考。
- **Files**：`README.md`、`docs/`
- **Size**：M
- **Deps**：所有

#### P-5-12 性能 + 稳定性 sweep

- **What**：手测：1000 events 的节点详情页是否流畅；100 个 task 的列表页性能；大 diff（10MB）分片性能；并发 10 个 task 的 daemon CPU/RAM 占用。出现瓶颈记录到 issue tracker（不一定在 v1 修）。
- **Output**：`docs/performance-notes.md`
- **Size**：M
- **Deps**：所有

### M5 验收

1. 单二进制下载即跑（macOS + Linux）
2. 暗色主题下 UI 完整可用
3. e2e 通过 CI
4. README 上手能让新人在 10 分钟内跑通 demo workflow
5. 备份还原一遍验证（手动流程）

---

## 跨阶段持续工作

### P-X-01 类型共享纪律

- 确保 `packages/shared/` 是前后端唯一的 schema 真值源
- 任何 endpoint 增/改都先动 `packages/shared/src/schemas/`
- ESLint 规则：禁止 `packages/frontend/` 引 backend，反之亦然

### P-X-02 错误码 enum 持续维护

- `packages/shared/src/error-codes.ts` 集中管理所有 `code` 枚举
- 后端抛错只能用此 enum，前端 i18n 只能引此 enum

### P-X-03 静态校验文档化

- 编辑器静态校验 5 项 + agent 保存校验 + skill 保存校验 + workflow YAML 导入校验 全部在 `design/validation.md` 集中说明（含每条对应的错误 code）

### P-X-04 schema_version 迁移函数 stub

- 所有顶层文档（workflow / agent.md / SKILL.md / config.json）的 `$schema_version` 字段；目前都 v1。预留 `migrations/{kind}/v1-to-v2.ts` 模板（v1 时这些文件不存在；只在 v2 出现时才写）

### P-X-05 安全 review

- 在 M5 之前由作者 self-review 一次：token 处理、CSP（前端不加 inline script）、文件路径校验（启动表单文件输入必须落在仓 root 下，防越权）、子进程 env 不泄敏感

---

## 关键依赖图（粗）

```
M0
 │
 ▼
M1 骨架 ─── 单节点串行可跑
 │
 ▼
M2 编辑器 ── UI 全闭环（无 wrapper / 无 fan-out / 无 retry）
 │
 ▼
M3 编排核心 ── audit-after-worker pipeline
 │
 ▼
M4 高级编排 ── 反馈循环 + 嵌套
 │
 ▼
M5 打磨 ── 单二进制 + Release
```

跨阶段持续：类型共享、错误码 enum、文档维护。

---

## 边界与风险

### 阻塞风险

1. **P-0-01 失败**：如果 opencode 关键 env var 在期望最低版本里不可用，需要回到 design.md 重新选择隔离方案。这是整个项目的硬依赖。
2. **`--format json` event schema 变动**：v1 强依赖 opencode 当前的 event 格式。如果 opencode 升级改 schema，runner 需跟进。
3. **Loop wrapper 实际收敛性**：用户写的 audit/fix 在 v1 没有跨轮反馈端口，仅靠 worktree。如果实际场景下 LLM 无法收敛（每轮 audit 都说一样的），用户体验差 → 可能要在 M4 后回炉做反馈端口。

### 推迟到 v1.5+ 的工作

- per-hunk 分片
- sub-workflow 节点
- claude-code runtime
- Windows 支持
- Token → USD 成本表
- 全文搜索 task events
- agent.permission 高级 raw JSON 不只 form
- skill 二进制文件内置编辑

### 单人专注 v 多人并行

- 单人专注：M0~M5 顺序做，~13 周
- 双人：M2 与 M3 之间有相对独立的前后端工作可并行（P-2-* UI 与 P-3-* 后端可有 1-2 周重叠）；e2e 在 M5 才需上手
- 三人+：每个里程碑内部多 issue 可并领，节省 ~30%

---

## 下一步

1. 走 P-0-01：在你本机用真实 opencode 跑一次隔离方案验证，确定最低版本号写入 design.md
2. 走 P-0-02：开 monorepo 仓
3. M1 启动 → P-1-01 ~ P-1-07 顺序串行 ~ 1 周；P-1-08 ~ P-1-14 后端可并行 ~ 1.5 周；P-1-15 ~ P-1-18 收尾 ~ 0.5 周

需要我把任意一个 issue 进一步细化（含关键函数签名、测试 case 列表），或者给某个里程碑画 mermaid 时序 / 数据流图，告诉我即可。
