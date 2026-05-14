# 当前执行状态

> 这份文件让新 session 能立刻接上进度。每完成一批 issue 就更新它，与远端同步推送。

**最近更新**：2026-05-14（P-2-10 stage 2 完成后，M2 全部 16 个 issue 闭合 🎉）

---

## 路线图全局视图

文档：
- `design/proposal.md` — 产品规格（权威）
- `design/design.md` — 技术设计（权威）
- `design/plan.md` — 81 个 issue 的实施计划，按 M0 → M5 排
- `CLAUDE.md` — 仓约定与索引

```
M0 准备       [5/5   ✅]
M1 骨架       [18/18 ✅]  ← M1 完成
M2 编辑器     [16/16 ✅]  M2 收官 — 编辑器 / launcher / settings / task 详情全套就绪
M3 编排核心   [0/14]      ← 下一站
M4 高级编排   [0/11]
M5 打磨       [0/12]
```

---

## 已完成 issue（39 个）

### M0 全部完成（5/5）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-0-01 | opencode 兼容性验证 | 1.14.25 上 4 个隔离实验全过；最低版本 1.14.0 写入 `design.md` §18 |
| P-0-02 | monorepo 初始化 | Bun workspaces / `packages/{frontend,backend,shared}` / tsconfig / prettier |
| P-0-03 | CI skeleton | `.github/workflows/ci.yml`（matrix: ubuntu+macos，跑 format/lint/typecheck/test） |
| P-0-04 | ESLint + Prettier | `eslint.config.js` flat config + 跨包 import 边界规则（backend↮frontend 互斥） |
| P-0-05 | Drizzle schema | 8 张表完整定义 + WAL/NORMAL/busy_timeout + 启动时自动 migrate + in-memory 测试辅助 |

### M2 完成（16/16）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-2-10 (stage 2) | Launcher 富 picker | `components/launch/{FilesPicker,EnumPicker,GitPicker}.tsx`。FilesPicker 拉 `/api/repos/files`，client-side filter + checkbox + minCount/maxCount/accept 显示在 header；packed value 是 newline-joined paths（运行时 `{{port}}` 直接拼）。EnumPicker 单选 radio / 多选 checkbox + allowOther 自定义 input，多选 packed 成 JSON array、单选 packed 成裸字符串。GitPicker 看 `def.gitKind`：branch → /api/repos/refs `<select>`、commit-range → from/to 双 TextInput、pr → number，输出统一 `{kind, ...}` JSON。`workflows.launch.tsx` `DynamicInput` 按 def.kind 分支到对应 picker（text 仍是 stage 1 路径） |
| P-2-07 | 多选 + 复制粘贴 + 右键菜单 | `components/canvas/canvasClipboard.ts`：进程内 buffer + `buildSlice(def, ids)` 取 selection 切片（含 anchor = top-left）→ `applyPaste(def, slice, at)` 派生 id 重命名 (`${id}_copy[_N]`) + 内部边端点 re-route + 整数位置 + 边 id 重生。`components/canvas/ContextMenu.tsx`：absolute 浮层 + Escape / outside click 关闭。`WorkflowCanvas`：Cmd/Ctrl+C/V/A 键盘绑在 wrapper（tabIndex=0，不抢全局输入）+ `onNodeContextMenu` / `onPaneContextMenu` → 节点菜单 Duplicate/Copy/Delete，空白菜单 Paste/Select all；多选用 xyflow 的 `multiSelectionKeyCode=[Shift,Meta]` + `selectionOnDrag` 橡皮筋；delete 自己写避免裁断除选中外的孤儿边。tests 8 case（slice 选边 / 锚点 / paste 位置 / id 碰撞 / edge remap / repeat paste / passthrough field 保留 / null slice） |
| P-2-13 | Node detail drawer 4-tab（M2 简化版）| 后端：`NodeRunSchema` 加 `promptText / tokCacheCreate / tokCacheRead`，`getTaskNodeRuns` 改成把这几列也投影出去。新 service `getNodeRunEvents(db, taskId, nodeRunId, {since, limit})`：先 join 验 owner（防跨 task 泄露 node_run）→ `node_run_events` where `gt(id, since)` 取最多 limit (默认 500, 上限 1000) 行，JSON.parse payload。新 endpoint `GET /api/tasks/:id/node-runs/:nodeRunId/events?since=N&limit=M`，验证 since 非负、limit 正。tests +2 case（分页 cursor + 跨 task 404）。前端：`components/NodeDetailDrawer.tsx` 4 tab — Prompt（promptText `<pre>`）/ Events（拉新 endpoint + kind chips 过滤 + max-height 60vh 滚动）/ Output（端口卡片 + Copy）/ Stats（status/start/finish/duration/exit/iteration/retry/tokens × 5 + error）。Task 详情画布 onSelect 把 nodeId 映射到该 node 最新 node_run.id，渲染在画布右侧 480px 抽屉 |
| P-2-15 | Settings 页面 5 tab | `/settings` 改造：之前是只读 dl 卡片，现在 5 tab — Runtime（opencodePath / defaultModel / defaultVariant / defaultTemperature / maxConcurrentNodes / multiProcessSubprocessConcurrency / logLevel）、Limits（perTaskMaxDurationMs / perTaskMaxTotalTokens / perNodeTimeoutMs / largeOutputThresholdBytes）、GC（worktreeAutoGc 开关 + olderThanDays + onlyMerged + eventsArchiveThresholds.perNodeRunRows/globalRows）、Network（bindHost / bindPort 标 restart-required）、Connection（daemon URL + token + Sign out 按钮，从旧 settings 搬过来）。每个 tab 用 `useTabState` hook 切出 ConfigPatch 子集 → PUT /api/config（已有的 P-1-03 endpoint）→ react-query setQueryData 落回；统一 SectionForm 容器渲染 Save 按钮 + Saved/error 状态条 |
| P-2-12 | Task 详情状态画布 | `WorkflowCanvas` 新增 `nodeStatuses?: Record<nodeId, status>` prop，`toFlowNodes` 把 status 写到 `CanvasNodeData.status` → 触发 P-2-04 已有的 `canvas-node[data-status=...]` CSS 边框色。Task detail 路由新增 `<TaskStatusCanvas>` section：snapshot 拆 `WorkflowDefinition`、computes latest run-per-nodeId、`canvasStatus()` 把 NodeRunStatus 映射到 CanvasNodeData 子集（done/failed/running/pending/skipped/canceled），canvas 用 readOnly+任务高度 70vh。前端 tests +3 case |
| P-2-10 (stage 1) | Launcher 表单 | `routes/workflows.launch.tsx`：路由 `/workflows/$id/launch`。recent-repo `<select>` + 手填 path 双绑（选了就自动 set baseBranch = recentRepo.defaultBranch），baseBranch 通过 `useQuery /api/repos/refs` 拿到 branches 后 `<select>` 否则 fallback text input。`workflow.definition.inputs` 自动渲染：kind === 'text' 走 TextInput（含 multiline passthrough → textarea），其它 kind 暂留占位 + "stage 2 picker ships later" 提示。`missingRequired` 推断 disabled。提交 POST /api/tasks → 跳 /tasks/$id。editor 路由 header 新增 "Launch task →" 按钮。`stage 2`（file / git-object / enum picker + warning bar）后续单独 issue |
| P-2-11 | Output 节点配置 + 产出面板 | NodeInspector 的 output 节点改成可编辑列表（每行 name + bind.nodeId + bind.portName + Remove，底部 + Add port）。`components/TaskOutputPanel.tsx` 在 task 详情顶部渲染：`collectPorts(task.workflowSnapshot)` 解析 output 节点 `ports[]` + workflow-level `outputs[]` bindings → 拿 latest run per nodeId → 从 `node_run_outputs` 取对应 port 值 → 一张卡片含 name / bind / value，Copy 按钮（navigator.clipboard）。pending / empty / value 三态显示。tests 5 case for collectPorts |
| P-2-14 | Task list realtime via /ws/tasks | `hooks/{useTasksSync,useTaskSync}.ts` 订阅 `/ws/tasks` / `/ws/tasks/:id`，收到 task.* / node.* 事件 → invalidate 相应 react-query。tasks 列表轮询从 4s 调到 15s 兜底；详情页 task / node-runs / diff 三个 query 按事件类型分别 invalidate |
| P-2-09 | 自动保存 + 多 tab WS 同步 | `hooks/{useWebSocket,useWorkflowSync}.ts`：泛型 JSON-WS 订阅 hook 带指数 backoff 重连（base 500ms / cap 30s），最新-listener ref 避免每渲染重连；token / baseUrl 每次 connect 重读 `stores/auth`。`useWorkflowSync(workflowId, currentVersion, onRemoteUpdate, onRemoteDelete)` 过滤同 id 且 `version > current` 的 `workflow.updated` → toast + react-query invalidate。Editor 路由 auto-save 防抖 800ms → 1000ms 对齐 design.md §4.1；workflows.edit 新增 `.info-box` 提示横幅。tests 5 case（FakeWs stub 注入 listener，验证连接 URL + msg routing） |
| P-2-08 | 边连线 + 端口可视化 | `WorkflowCanvas` 打开 `nodesConnectable={readOnly !== true}` + `onConnect` 回调走新 helper `buildEdgeFromConnection(def, conn)`：检查 source/target/handle 全非空、拒绝 self-loop、拒绝完全重复的 edge（source.nodeId+portName / target.nodeId+portName 全等），通过时生成 `edge_${ulid 末 6 位}`。`PortHandles` 移除 `isConnectable={false}`，圆点变成可拖拽源/汇。tests 6 case |
| P-2-06 | 节点抽屉 Edit + Preview | `components/canvas/{NodeInspector,PromptPreview}.tsx`：右侧 480px 三栏（左 sidebar / 中画布 / 右 inspector）。Edit 表单按 kind 分支：agent 节点（agent selector、promptTemplate、retries、timeoutMs、model/variant/temperature overrides，agent-multi 多 sourcePort 字段）；input 节点（inputKey）；output 节点（端口列表显示 bind 来源）；wrapper-loop（maxIterations + exitCondition.kind）。Preview tab 调 `@agent-workflow/shared/prompt.ts` 的 `renderUserPrompt`（搬迁自 `backend/services/protocol.ts`，后者改为薄 re-export，保持 backend tests 不动）+ 用户编辑 mock port 值，实时拼接含协议块的 prompt。canvas 新增 `onSelect(nodeId|null)` prop。tests +5 case（template substitution、内置 meta、未引用 port section、协议块、缺失 port）|
| P-2-05 | 编辑器侧栏（拖拽创建源） | `components/canvas/{EditorSidebar,nodePalette}.tsx`：240px 左 sidebar 顶部 filter + 四组 (Agents / Fan-out / Wrappers / IO)，HTML5 draggable item via `PALETTE_MIME = application/x-agent-workflow-node`。canvas 上 `onDragOver/onDrop` 用 `useReactFlow().screenToFlowPosition` 转坐标，`makeNode(item, pos, {agents, existingIds})` 派生 kind 默认值（id 用短前缀 + ulid 尾部 6 位避免碰撞；wrapper-loop 默认 maxIterations=3 + exitCondition=port-empty 让 validator 一开就过）。tests 13 case（dataTransfer 格式 round-trip + 各 kind 默认值 + id 碰撞 fallback + buildPalette 结构）|
| P-2-04 | 节点类型自定义渲染 | `components/canvas/nodes/{AgentNode,InputNode,OutputNode,WrapperNodes,PortHandles,types}.tsx`：每种 kind 单独组件，xyflow `nodeTypes` 注册 `agent-single / agent-multi → AgentNode`、`input → InputNode`、`output → OutputNode`、`wrapper-git / wrapper-loop → 占位 wrapper`。`computePorts` 派生端口（input=输出 `inputKey`；output=输入 `ports[].name`；agent=`agent.outputs`，agent-multi 自动加 `errors`；wrapper-git→`git_diff`；wrapper-loop→`outputBindings[].name`；输入侧统一从入边汇聚）。`PortHandles` 在节点左右两侧均匀分布 `<Handle>` 圆点 + 端口名 chip；`canvas-node[data-status=...]` 留好状态色 hook（M2 编辑器仅默认色，task 详情画布在 M3 复用）。Editor 路由 `/workflows/new + /$id` 拉 `/api/agents` 喂给 canvas。tests 17 case（new +7：`computePorts` 各 kind + `toFlowNodes` 落 `type` / 端口 / wrapper innerCount）|
| P-2-03 | Workflow 编辑器 xyflow 画布骨架 | `components/canvas/WorkflowCanvas.tsx`（xyflow v12 + `ReactFlowProvider`，pan/zoom/minimap/Controls，`deleteKeyCode=['Backspace','Delete']`，nodesDraggable + edgesFocusable，`nodesConnectable=false` 因为连线编辑器在 P-2-07）。`toFlowNodes/toFlowEdges/toDefinition` 双向转换（落地坐标四舍五入；缺位置时按 4×N 方阵布局；删除节点级联清理引用边）。新路由 `/workflows/new`（创建后 redirect 到 detail）+ `/workflows/$id`（800ms 防抖自动保存 name/description/definition + “Validate” 按钮调 stub validate endpoint + Delete 确认；dirty/saved/saving 三态指示）。Workflows 列表页改成 DataTable + 行内 Open/Delete + “+ New workflow” 按钮。tests 10 case（位置/标签/边删/round-trip 等）|
| P-2-02 | WS 框架 + 三频道骨架 | `ws/broadcaster.ts` typed pub/sub（`taskBroadcaster / tasksListBroadcaster / workflowsBroadcaster`，每个 broadcaster 独立 channelKey set）+ `ws/server.ts` Bun.serve 适配器（`tryUpgrade(req, srv)` 返回 `true / false / Response` 三态，`websocket: { open, close, message }`）。三频道：`/ws/tasks/{id}`（含 `?since=N` 从 `node_run_events` JOIN `node_runs` 重放、`hello` 控制帧带 since）/ `/ws/tasks` / `/ws/workflows`。Token 走 `?token=` 常时比较。Wired calls：`createWorkflow/updateWorkflow/deleteWorkflow` 发 `workflow.{created,updated,deleted}`；`startTask` 发 `task.created`、scheduler/cancel 走新 helper `emitTaskStatus` 双频道一起发（`task.status` + `task.done` 终态）；scheduler 在每个 node insert / 结束时发 `node.status`。shared `schemas/ws.ts` 定义 `TaskWsMessage / TasksListWsMessage / WorkflowsWsMessage / WsControlMessage`。tests 7 case（404 / 401 / 各频道 hello / workflow created/updated/deleted / task.status+task.done / since 重放仅吐 id>since 的事件）|
| P-2-01 | Workflow 静态校验 5 项 | `services/workflow.validator.ts`：`validateWorkflowDef(def, {agents, skills})` 纯函数 + `validateWorkflowById(db, id)` 包装。5 项规则代码：`edge-source-node-missing / edge-source-port-missing / edge-target-port-missing / topology-cycle / wrapper-empty / wrapper-loop-max-iterations / wrapper-loop-exit-condition / agent-not-found / skill-not-found / agent-multi-source-port-missing / binding-{node,port}-missing / input-key-duplicate / prompt-template-unresolved`。port 集合：input.outputs={inputKey}、output.inputs={ports[].name}、agent.outputs=agent.outputs+(`errors` if agent-multi)、wrapper-git.outputs={`git_diff`}、wrapper-loop.outputs={outputBindings[].name}；agent-input 边的 portName 不约束（runner 暴露为 prompt var）；wrappers 不接受入边。topology：DFS 检测环、wrapper-loop 内 nodeIds 互通的边被剔除。prompt template：`{{ name }}` regex + 一组 builtin（`__repo_path__ / __base_branch__ / __task_id__ / __node_id__ / __iteration__ / __shard_key__`），其余必须匹配该节点的入边 target.portName（agent-multi 额外接受 sourcePort.portName）。tests 18 case（每项规则 valid + invalid）|

### M1 已完成（18/18）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-1-01 | Daemon CLI start + flock 单实例 | `start` 前台启动 / PID 文件 flock / SIGTERM graceful / `.daemon.info` 写盘 |
| P-1-02 | Token 鉴权 | 32 字节 hex token 自动生成（mode 0600）+ Hono middleware（Bearer 或 `?token=`）+ 常时比较 |
| P-1-03 | Config load/save + REST | `~/.agent-workflow/config.json` 完整 zod schema + 默认值回填 + atomic write；GET/PUT `/api/config` |
| P-1-04 | /health + opencode 版本探测 | 启动时 `opencode --version` semver 检查；`/health` 返 `{ok, opencodeVersion, dbVersion, uptime, runningTasks}` |
| P-1-05 | CLI 子命令 stop/status/doctor/config/migrate | 完整工具集；status 调 /health；doctor 6 项检查 |
| P-1-06 | 结构化 logger | level + ts + service + child + stdout + `~/.agent-workflow/logs/daemon.log`（10MB×5 rotate） |
| P-1-07 | API 错误统一 schema | `DomainError / NotFoundError(404) / ValidationError(422) / ConflictError(409) / UnauthorizedError(401)` + Hono `onError` |
| P-1-08 | Agents CRUD | 6 个 endpoint；DB 是真值源；frontmatter 字段拆 DB 列；JSON 字段在 service 层 marshal；删除/重命名引用拒绝 |
| P-1-09 | Skills CRUD + 文件树 | fs 真值源；managed + external 两种 source；SKILL.md frontmatter 通过 `yaml` 包解析；safeJoin 路径遍历防御；引用拒绝；12 个 endpoint |
| P-1-10 | 仓最近列表 + refs/files endpoint | `recent_repos` 表 upsert（含 defaultBranch 探测）；GET/POST `/api/repos/recent` + GET `/api/repos/{refs,files}?path=`；非 git 仓 422、路径不存在 404 |
| P-1-11 | Workflow CRUD | 6 个 endpoint（list/get/create/update/delete/validate-stub）；ULID URL；version+1；删除时**任何 task 引用都拒绝**（严于 design.md 文本，遵 round-18 答复）；validateWorkflow 是 stub（P-2-01 实装 5 项校验） |
| P-1-12 | Worktree helper（util/git.ts） | `runGit` / `requireGitRepo` / `repoSlug = sha1(8)+basename` / `createWorktree`（`agent-workflow/{taskId}` 分支，返 baseCommit）/ `removeWorktree`；并发 task 拿独立 worktree 验证 |
| P-1-13 | opencode runner | `services/{envelope,protocol,runner}.ts` 三件套：envelope 解析（last-wins / 单双引号 / 缺失补空）+ user prompt 拼接（`{{port}}` + 内置 `{{__var__}}` + 章节追加 + 英文协议块）+ runner（OPENCODE_CONFIG_CONTENT 注入 agent / OPENCODE_CONFIG_DIR 注入 skill / 流式写 events 表 / accumulate text events 提取 envelope / AbortSignal + timeout / 清理 runDir）；mock-opencode 端到端 9 case |
| P-1-14 | Task 启动 + 线性 DAG 调度 | `services/{scheduler,task}.ts` + `routes/tasks.ts`：Kahn 拓扑排序 / input 节点物化为虚拟 node_run / agent-single 调 runNode / output 节点跳过 / multi-process+wrapper+loop 拒绝 / 多入边到同 port 自动拼接（`---` 分隔）/ 失败节点 halt task；POST/GET endpoint，HTTP 创建后 scheduler 后台跑；tests 14 case |
| P-1-15 | Cancel task | `POST /api/tasks/:id/cancel` + service 层 `activeTasks: Map<taskId, AbortController>` + scheduler/runner 全链路 signal 传递；终态 task → 409 `task-not-cancelable`；无 controller 的孤儿（如 daemon 重启后）也能 flip 到 canceled；tests 5 case |
| P-1-16 | 前端骨架：路由 / Layout / API client | Vite + React 19 + TanStack Router (code-based) + TanStack Query；侧栏 `Agents/Skills/Workflows/Tasks/Settings`；`/auth` token 录入页 + 401 自动 clearToken；`api/client.ts` fetch wrapper (token + query + body 序列化 + DomainError → ApiError 映射)；`stores/auth.ts` localStorage + subscribe；vitest+happy-dom (root `bunfig.toml [test] root` 把 `bun test` 限定到 backend；CI 跑 frontend vitest 步骤独立)；frontend 16 case |
| P-1-18 | Tasks 简化视图 | 后端：tasks 表新加 `base_commit` 列 + migration 0001；shared 新增 `NodeRun / NodeRunOutput / TaskNodeRuns / TaskDiff` schema；service `getTaskNodeRuns`（join node_run_outputs）+ `getTaskDiff`（util/git.ts 新增 `worktreeDiff`：tracked `git diff <baseCommit>` + untracked `git diff --no-index /dev/null <file>`，1MiB cap）；新 endpoint `GET /api/tasks/:id/{node-runs,diff}`。前端：`routes/tasks.tsx` 列表（状态 chips 过滤 via search params + 4s 轮询）；`routes/tasks.detail.tsx`（元信息 + 节点 runs 表 + worktree diff）；组件 `DiffViewer`（按 `diff --git` 切分 + 行级 add/del/hunk/meta/ctx 着色）+ `TaskStatusChip`。tests 后端 +6 case，前端 +7 case（diff parser/classifier）|
| P-1-17 | Agents/Skills 列表 + 详情编辑 | `routes/{agents,agents.new,agents.detail,skills,skills.new,skills.detail}.tsx` + 组件 `AgentForm / SkillFileTree / MarkdownEditor / ChipsInput / JsonField / ConfirmButton / Form 原语`；数据表 + 行内 Open/Delete；agent form 全 frontmatter 字段（含 outputs/skills chips、permission/frontmatterExtra raw JSON、readonly switch、model/variant/temperature/steps/maxSteps、bodyMd markdown 编辑+预览）；skill 详情含 description 保存 + SKILL.md body 保存（external skill 只读展示）+ 文件树（列出 / 选 / 改 / 加 / 删）；自写极简 markdown 渲染器（headings / 段落 / bullet / 围栏代码 / inline code / bold-italic / HTML 转义）。frontend tests 35 case（新增 markdown 8 + chips 6 + json-field 5） |

---

## 测试积累

后端测试 **234 个 case**（`bun test` — 由 `bunfig.toml [test] root` 限定到 `packages/backend/tests`）；前端测试 **103 个 case**（`bun run --filter @agent-workflow/frontend test` → vitest + happy-dom + 自写 localStorage shim，因为 vitest 3 / happy-dom 15 在 node 25 下默认 storage 为空 `{}`）。后端 daemon 启动测试 spawn 子进程，~1-2s 每 case。git util / repos / tasks / 部分 workflow 测试初始化真实 git 仓 fixture。Runner / scheduler 测试用 mock-opencode 子进程脚本代替真 opencode。

测试文件：
```
packages/backend/tests/
├── agents.test.ts          (17 case)
├── auth-token.test.ts      (11 case)
├── cli.test.ts             (13 case)
├── config.test.ts          (9 case)
├── daemon-start.test.ts    (5 case，含 e2e daemon spawn)
├── db.test.ts              (2 case)
├── envelope.test.ts        (13 case)
├── errors.test.ts          (6 case)
├── fixtures/mock-opencode.ts (runner test fixture)
├── git.test.ts             (16 case，含 git init fixture + 并发 worktree)
├── log.test.ts             (7 case)
├── lock.test.ts            (6 case，跨进程 fork)
├── opencode-version.test.ts (4 case)
├── protocol.test.ts        (9 case)
├── repos.test.ts           (12 case)
├── runner.test.ts          (9 case，spawn mock-opencode + 检验 DB 写入)
├── scheduler.test.ts       (9 case，end-to-end runTask 含拓扑/拒绝/级联失败/cancel signal)
├── skills.test.ts          (22 case)
├── smoke.test.ts           (1 case)
├── tasks.test.ts           (10 case，HTTP 层 + 真 git fixture + cancel API)
└── workflows.test.ts       (15 case)
```

---

## 后端代码地图

```
packages/backend/src/
├── main.ts                 # CLI 入口；路由所有子命令
├── server.ts               # Hono app 工厂；接 AppDeps；挂载路由
├── auth/token.ts           # token 生成 / Hono middleware / 常时比较
├── cli/
│   ├── start.ts            # daemon 入口；装配 lock+log+config+opencode probe+db+token+http+signals
│   ├── stop.ts             # 读 lock PID → SIGTERM → 等 lock 文件 unlinked
│   ├── status.ts           # 读 lock + daemon.info → 调 /health
│   ├── doctor.ts           # 6 项健康检查
│   ├── config-cli.ts       # config get/set
│   └── migrate.ts          # 手动跑 drizzle migration
├── config/index.ts         # loadConfig / applyConfigPatch（atomic write）
├── db/
│   ├── client.ts           # openDb + createInMemoryDb（auto-migrate）
│   └── schema.ts           # 8 张表 Drizzle 定义
├── routes/
│   ├── health.ts
│   ├── config.ts
│   ├── agents.ts
│   ├── repos.ts            # /api/repos/{recent,refs,files}
│   ├── skills.ts
│   ├── tasks.ts            # /api/tasks list/get/start
│   └── workflows.ts        # /api/workflows + /:id + /:id/validate (stub)
├── services/
│   ├── agent.ts            # Agents CRUD
│   ├── envelope.ts         # extractLastEnvelope + parseEnvelope
│   ├── protocol.ts         # renderUserPrompt + buildProtocolBlock
│   ├── repo.ts             # recent_repos upsert + getRepoRefs / getRepoFiles
│   ├── runner.ts           # runNode: spawn opencode + stream events + envelope persistence
│   ├── scheduler.ts        # runTask: linear DAG (input→agent-single→output)
│   ├── skill.ts            # Skills CRUD + 文件树 + frontmatter
│   ├── task.ts             # startTask / listTasks / getTask (worktree创建 + 后台 scheduler)
│   └── workflow.ts         # Workflow CRUD + validate stub
└── util/
    ├── errors.ts           # DomainError 家族 + Hono onError handler
    ├── frontmatter.ts      # YAML frontmatter 解析（用 yaml 包）
    ├── git.ts              # runGit / requireGitRepo / repoSlug / createWorktree / removeWorktree + ref/file 解析器
    ├── lock.ts             # 单实例 PID 文件锁
    ├── log.ts              # 结构化 logger
    ├── opencode.ts         # 版本探测 + semver 比较 + 最低版本常量
    ├── paths.ts            # Paths.{db,lock,daemonInfo,...}
    └── safePath.ts         # 路径遍历防御
```

---

## 下一步：M2（编辑器 + 启动器）

M1 验收已 ready：`agent-workflow start` → 浏览器登 token → 创 agent + skill → curl 拼 workflow → 启 task → 看 task 详情节点 + diff → cancel 也跑通。M2 共 16 个 issue，按 `design/plan.md` §6 顺序。

第一批可以 parallel 的入手点：

| ID | 标题 | 依赖 | 复杂度 |
| --- | --- | --- | --- |
| P-2-07 | 右键菜单 + 多选 + 复制粘贴 | P-2-03 | M |
| P-2-07 | 右键菜单 + 多选 + 复制粘贴 | P-2-03 | M |
| P-2-10 (stage 2) | Launcher 的 file / enum / git 选择器 + warning bar | P-1-10 | M |
| P-2-13 | 节点详情抽屉 4 tab（Prompt/Events/Output/Stats） | P-2-02、P-2-12 | L |
| P-2-15 | YAML 导入/导出 | P-1-11 | M |
| P-2-16 | Settings 页面 4 标签 | P-1-03 | M |

M1 验收：跑通 `创 agent → 创 skill → 通过 API/curl 创线性 workflow → 启 task → 看 opencode 子进程跑完 → 输出 envelope 解析为 ports`。

---

## 已知 caveat / 后续 tech debt

> 这一列每次会增长，下次清理时一并 reconcile。

### 设计/实现偏差

- **Workflow 删除语义**：实装是"任何 task 引用都拒绝"（round-18 答复），但 `design.md` §4.2.2 / `plan.md` P-1-11 文本写的是"仅运行中 task 引用拒绝"。下次更新文档时把文本改严即可；或后续如要放开，需要把 `tasks.workflowId` 改为 nullable + `ON DELETE SET NULL`，附带 migration。

### 工程
- **CI bun 版本**：CI 锁 `1.3.x`、`package.json` 锁 `bun@1.3.13`、`engines.bun >= 1.3.0`。Bun 1.2+ 改了 lockfile 格式，本地若升级到不同主线版本要同步更新这三处。
- **前端 localStorage shim**：`packages/frontend/tests/setup.ts` 注入 in-memory `Storage` 实现到 `globalThis.localStorage` / `globalThis.window.localStorage`。Node 25 + vitest 3 + happy-dom 15 组合下默认 storage 是空 `{}`（Node 的 `--localstorage-file` 被 vitest 不带路径地塞进来）；如果升 vitest 4+ 或换 jsdom，可以重新尝试去掉 shim。

1. **opencode 最低版本** 现在保守地写为 1.14.0（P-0-01 仅在 1.14.25 实测过）。如需放宽，下沉到更老版本 bisect 即可（design.md §18 #1）。
2. **drizzle-orm 0.36.4 的 extraConfig 用对象形式**（`(t) => ({...})`）；如果未来升 ≥0.39，数组形式才支持，schema.ts 需要回看。
3. **bun.lock 文本格式** Bun 现在用 text JSON 而非二进制 bun.lockb。`.gitignore` 留 `bun.lockb` 仅为防御性。
4. **路由 `mountSkillRoutes` 在 mount 时捕获 `Paths.root`**，所以测试里改 `AGENT_WORKFLOW_HOME` 必须在 `createApp` 之前。如果未来要支持 daemon 运行中修改 home（不会），需要把它放到 AppDeps。
5. **没装 `Bun.Subprocess` 类型注解**（一些测试里）— Bun 类型签名版本敏感，让 TS 推断更稳。
6. **Skill 文件全是 utf-8** — v1 不支持二进制；plan.md §18 #8 已记录。
7. **eslint-plugin-react 在 flat config 下的 plugin recommended 没用**（仅手动添加 hooks 规则）—— P-1-17 前再补 recommended preset 即可。

---

## Git 状态

- 远端：`git@github.com:wangbinquan/agent-workflow.git`
- 分支：`main`
- 当前提交：见仓最新 commit（每次本文件更新时贴回这里）
- CI：M0 (P-0-03) 已经配，但还没在 PR 流程中触发过

---

## 给新 session 的 onboarding 清单

1. 读 `CLAUDE.md`、本文件、`design/plan.md`
2. `bun install` → `bun test` 验证开发环境
3. 看 `TaskList`（如果当前 session 有持久任务，否则按本文件"下一步"接力）
4. 选 issue → 创 TaskCreate → 进 in_progress
5. 完成一批 issue 后：commit + push + 更新本文件
