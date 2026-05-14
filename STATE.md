# 当前执行状态

> 这份文件让新 session 能立刻接上进度。每完成一批 issue 就更新它，与远端同步推送。

**最近更新**：2026-05-15（M5 进行中 — P-5-01/02/03-s1/04/05/06 闭合，Release pipeline 就绪）

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
M3 编排核心   [14/14 ✅]  fan-out / 重试 / resume / git wrapper / 状态画布 / 抽屉增强
M4 高级编排   [11/11 ✅]  loop wrapper / 嵌套 / 资源限额 / orphan / GC / shutdown / YAML / token agg
M5 打磨       [5.5/12]    ← 进行中（P-5-01 + P-5-02 + P-5-03 stage 1 + P-5-04 + P-5-05 + P-5-06）
```

---

## 已完成 issue（69 个）

### M5 进行中（5.5/12）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-5-06 | GitHub Releases 自动发布 | `.github/workflows/release.yml`：`on: push tags v*` → ubuntu + macos matrix → `bun install --frozen-lockfile` → `bun run build:binary` → `softprops/action-gh-release@v2` 上传 `dist/agent-workflow-*` 单文件资产到对应 tag 的 Release。`prerelease: contains(github.ref_name, '-')` —— `v0.1.0-rc.1` 类带连字符 tag 标为 prerelease，纯 semver `v0.1.0` 标为正式版。`generate_release_notes: true` 自动从 commit / PR 拼 release notes。`permissions: contents: write` 让 GITHUB_TOKEN 能写 Release。同一 tag 重跑时 action 是幂等 append（首跑创建 release，后续 push 新 asset）。本地未实跑（需真 tag），逻辑沿用 build-binary CI job 已验证的同一脚本。|
| P-5-05 | Bun build 单二进制 + 嵌入前端 dist + 嵌入 drizzle migrations | `scripts/build-binary.ts`：1) `bun run --filter @agent-workflow/frontend build` → `packages/frontend/dist/`；2) walk frontend/dist + `packages/backend/db/migrations` 两棵树，把 `packages/backend/src/embed.generated.ts` 改写成每个文件一行 `import xx from '…' with { type: 'file' }`（identifier 用 `prefix_${rel-with-non-alnum-stripped}_${hashCode-base36}` 避免碰撞）+ 导出 `FRONTEND_FILES`/`MIGRATION_FILES` 路径表 + `IS_EMBEDDED = true`；3) `bun build packages/backend/src/main.ts --compile --target=bun --minify --outfile=dist/agent-workflow-<macos\|linux>-<arm64\|x86_64>`；4) finally 还原 stub 文件（dev 时 `IS_EMBEDDED=false` + 两个空 map），防止污染 working tree；5) 跑 `<binary> version` 烟雾测试。`packages/backend/src/embed.ts`：runtime helpers — `getEmbeddedAsset(urlPath)` 异步取 `Bun.file(filePath).arrayBuffer()` + 派生 mime（html/js/css/json/svg/png/woff2 等），`extractMigrationsTo(targetDir)` 同步重建目录树写每个 .sql + meta/_journal.json（drizzle migrator 需要文件系统路径，没法直接走 buffer）。`server.ts`：仅在 `IS_EMBEDDED=true` 时挂 `*` catch-all 路由，`/api/*` 和 `/ws/*` 仍然 404 走原 schema，其它路径先查 FRONTEND_FILES → 命中则回静态资源，未命中回 `index.html`（SPA 路由 hard-refresh 不会 404）。`cli/start.ts`：daemon 启动到 step 5 时，`IS_EMBEDDED=true` 就把 migrations 抽到 `~/.agent-workflow/runtime/migrations/` 再交给 drizzle，否则继续读 `Paths.migrationsDir`。`.github/workflows/ci.yml`：新 `build-binary` job，`needs: check`，ubuntu + macos matrix，跑 `bun run build:binary` → `actions/upload-artifact@v4` 把 `dist/agent-workflow-*` 上传（解锁 P-5-06）。`.gitignore` `dist/` 早就有，无需改。stub `embed.generated.ts` 已 commit，dev 不需要任何额外操作。本地实测：61 MiB 二进制，`/health` 正确、`/` 吐 index.html（467B）、`/assets/*.css` 吐真实 CSS（39 KiB），migrations 抽出 5 文件 + dbVersion=2，SIGTERM 干净退出。tests +4 case（IS_EMBEDDED stub 检查、空 frontend list、`getEmbeddedAsset` null、`extractMigrationsTo` 0 文件幂等）|
| P-5-04 | 暗色主题 | `styles.css` 把所有调色板变量迁到 `:root[data-theme='dark']` 选择器，旧 `@media (prefers-color-scheme: dark)` 只在 `:root:not([data-theme])` 时生效（覆盖 /auth 路由 + React mount 之前的空窗）。新 hook `hooks/useTheme.ts`：`resolveTheme(theme, system)` 纯函数；`useApplyTheme()` 拉 `/api/config`（仅有 token 时启用，staleTime 60s），订阅 `matchMedia('(prefers-color-scheme: dark)')` change 事件实时跟随；theme === 'system' → `removeAttribute('data-theme')` 把控制权交还给 @media，其它情况 `setAttribute('data-theme', resolved)`。`routes/__root.tsx` 在 RootComponent 顶部调用 `useApplyTheme()`，token 为空时 query disabled，hook 仍设上 system 行为。`routes/settings.tsx` 加 `AppearanceTab`：在 5 个原 tab 之间插入 `appearance`（label 走 i18n `settings.tabAppearance`），单字段 `<select theme>` 三选项（system/light/dark），走通用 `useTabState(['theme'])` PUT /api/config 通路。i18n bundle 同步加 `settings.{tabAppearance, themeLabel, themeHint, themeSystem, themeLight, themeDark}` 中英文本。tests +3 case（explicit dark/light wins + system follows OS）|
| P-5-03 (stage 1) | i18n 脚手架 + zh-CN/en-US bundle | `packages/frontend/src/i18n/{index.ts, zh-CN.ts, en-US.ts}`：i18next + react-i18next + i18next-browser-languagedetector，detector 顺序 `localStorage('aw-language') → navigator`，fallbackLng=zh-CN。`Resources` interface 把两个 bundle 锁成同一结构（nav / auth / settings / errors × 错误码→i18n key 映射）。`describeApiError(err)` 检测 `errors.{code}` 存在则吐 zh-CN 文案，否则 `'{fallback}: {raw message}'`。`main.tsx` `import './i18n'` side-effect 初始化。Stage 1 已迁文案：`routes/__root.tsx`（侧栏 brand + 5 个 nav）/ `routes/auth.tsx`（标题 + hint + url/token label + verifying/connect 按钮 + 错误用 describeApiError）/ `routes/settings.tsx`（页头三段 hint + 5 个 tab label + loading + BackupCard 全部 4 文案）。**Stage 2 未迁**（追加进列表）：agents/skills/workflows/tasks 列表 + detail + 编辑、launcher、所有 canvas 组件（NodeInspector / WorkflowCanvas / EditorSidebar）、forms (ChipsInput / JsonField / MarkdownEditor)、抽屉 tabs（NodeDetailDrawer 4 tab）、所有 task 详情 (TaskOutputPanel / DiffViewer / TaskStatusChip / TaskStatusCanvas)、settings Limits/GC/Network/Connection tab 内的 field labels + hints。tests +5 case（zh-CN default / en-US bundle reachable / 已知错误码本地化 / 未知错误码 fallback 拼接 / 非 ApiError stringify）|
| P-5-01 | events 表归档后台任务 | `services/eventsArchive.ts`：`archiveEvents(db, config, logsDir)` 两阶段扫描——先按 `nodeRunId` group，超 `perNodeRunRows` 的把最旧的 (n − threshold) 行 dump 到 `logsDir/{taskId}/{nodeRunId}.jsonl`（append + JSON.stringify 每行含 id/ts/kind/payload）→ 删 DB；再做全局 pass，循环找全表最旧的 event，按其 nodeRunId 一次砍最多 own 行直到 total ≤ `globalRows`。Orphan nodeRun 事件直接删（不写文件）。`startEventsArchiver(db, loadConfig, logsDir, intervalMs=1h)` 每 tick 重读 config，挂在 `cli/start.ts` 8 步背景 tickers，shutdown 时 stop。`readArchivedEvents(logsDir, taskId, nodeRunId, since, limit)` 流式 line-scan 返回 `{id, ts, kind, payload:string}` 列表（payload 保持 raw 不解析）。`getNodeRunEvents` 现签名加 `logsDir?` —— 先 read archive (id > since 取 limit) → 再 DB `id > max(archived_id || since)` 补齐 remainder；`getNodeRunStdout` 同理拼 archive + DB（stderr 两侧都 drop）。tests 7 case（无需归档 / per-group 归档+DB 剩余 / 全局阈值 / endpoint since=0 含 archived / endpoint since=mid 跨边界 / stdout 拼接顺序 / readArchive 无文件返 []）|
| P-5-02 | 备份 / 恢复 CLI + Settings 按钮 | `services/backup.ts` `createBackup({db, appHome?, now?})`：在 `{appHome}/backups/.staging-{stamp}/` 拼出 (1) `db.sqlite` —— `(db.$client as Database).exec("VACUUM INTO …")` 直接走 SQLite 一致性快照（对 in-memory & 文件库均生效）(2) `config.json` (3) `skills/` 整树 cpSync (4) `workflows/{id}.yaml` 复用 `exportWorkflowYaml`。然后 `tar -czf` 到 `agent-workflow-{stamp}.tar.gz`，finally 删 staging。stamp 用 ISO 时间去 `:.`。**不含**：worktrees / runs / logs / token。返回 `{path, sizeBytes, contents:{workflows, skills, config, db}}`。`cli/backup.ts` `backupCommand()` 打开 DB → createBackup → 打印 MB + 计数；`main.ts` 接入 `agent-workflow backup` 子命令。`routes/backup.ts` `POST /api/backup`（token 鉴权）。`routes/settings.tsx` GC tab 末尾插 `<BackupCard />`：信息文案 + 按钮 → POST /api/backup → 显示绝对路径 + MB。tests 6 case（layout 含 db.sqlite/config/skills/yaml × 2 workflows / 排除 worktrees+runs+logs+token / sqlite dump 可重新打开且 workflows 行数对 / 首次运行无 config 无 skills / staging 清理 / HTTP endpoint 完整 round-trip）|

### M4 完成（11/11）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-4-01 | Loop wrapper 调度 | `services/exitCondition.ts` 三种内置（port-empty / port-equals / port-count-lt）。scheduler.ts 重构成 **递归 scope 执行**：`runTask` 计算 `containerOf: nodeId→wrapper-id`，top-level 节点跑 `runScope`；wrapper-loop 在 parent scope 中作为节点，进 inner scope 后按 `maxIterations` 循环跑 → 每轮 `runScope(innerIds, iter=i)` → 求值 exitCondition → 满足则把 outputBindings 复制到 wrapper 输出 + done；超 max 标 `exhausted`，task=failed。每个内层 node_run 写 `iteration=i`。`resolveUpstreamInputs` 按 `iteration ≤ current` 选最新（top-level iter=0 自动可见）|
| P-4-02 | Loop wrapper UI | NodeInspector 中 `wrapper-loop` 整体重写：muted info-box 提示 "v1 无跨轮反馈 / 状态走 worktree 文件"；maxIterations / exitCondition.kind 下拉 / 目标 (nodeId, portName) / 按 kind 显示 value 或 n+separator；outputBindings 增删行（name + bind.nodeId + bind.portName）；inner ids 只读展示。`styles.css` 加 `data-status='exhausted/canceled/interrupted'` 边框色 + `data-loop-body='true'` 蓝色边。`WorkflowCanvas.toFlowNodes` 把 loop 内层节点标 `data.loopBody=true`，AgentNode/WrapperNodes 渲染 `data-loop-body` attribute |
| P-4-03 | Wrapper 任意嵌套 | scheduler.ts 的 `buildContainerMap` 多轮处理，innermost 拿到 containerOf；nested wrapper（git-in-loop / loop-in-git / loop-in-loop / git-in-git）通过递归 `runScope` 自然生效。`runGitWrapperNode` 现在自己 recurse inner scope 一次（baseline = HEAD before inner, diff = HEAD after inner）；wrapper-git 不再依赖 inner-as-top-level-upstream。tests 新增 git-in-loop case |
| P-4-04 | 资源限额 1Hz 后台 tick | `services/limits.ts` `enforceLimits(db)` 扫 `tasks.status='running'`，超 `maxDurationMs` → cancel + errorSummary=`task-time-limit-exceeded`；`sum(node_runs.tok_total) > maxTotalTokens` → cancel + errorSummary=`task-token-limit-exceeded`。`startLimitsTicker(db, intervalMs)` 1Hz interval（防 reentrant），daemon 启动时挂上，关闭时 stop。tests 5 case（空/duration/safe/tokens/disabled-with-0）|
| P-4-05 | Token aggregation | runner.ts `accumulateTokens` 扩展支持五种 candidate path（evt 顶层 / evt.part / evt.usage / evt.step / evt.message），字段支持 `input/output/cache_creation/cache_read`（snake_case 和 camelCase）、`input_tokens/output_tokens`（Bedrock）、`prompt_tokens/completion_tokens`（Anthropic 风）。scheduler.ts fan-out 父 `runFanOutNode` 完成时 `sumChildTokens(parentRunId)` 把子 node_runs 的 tok_* 累加写回父行（resource-limit + UI 同时受益）。`accumulateTokens` 导出，tests 6 case |
| P-4-06 | Graceful shutdown 30s | `services/shutdown.ts` `gracefulShutdown(db, budgetMs=30000)`：调 `abortAllActiveTasks()`（task.ts 新 export，遍历 activeTasks Map 触发 controller.abort）→ 轮询 DB 直到没 running task 或 deadline → 仍在 running 的 flip 到 `interrupted` + errorSummary=`daemon-shutdown`。`cli/start.ts` SIGTERM/SIGINT handler 调它（之前是直接 process.exit）。tests 2 case |
| P-4-07 | Orphan scan on restart | `services/orphans.ts` `reapOrphanRuns(db)` 在 daemon start 时跑：把所有 `tasks.status='running'` 标 `interrupted` + errorSummary=`daemon-restart`；把所有 `node_runs.status in ['running','pending']` 标 `interrupted`。挂在 `cli/start.ts` step 5b，DB 打开后立刻跑。tests 2 case |
| P-4-08 | YAML 导入导出 | `services/workflow.yaml.ts`：`exportWorkflowYaml(db, id)` 用 `yaml` 包 stringify {id, name, description, definition}；`importWorkflowYaml(db, yamlText, {onConflict: 'fail'\|'overwrite'\|'new'})` 校验后按策略落盘（fail → 409 `workflow-import-conflict` + details）；`previewWorkflowYaml` 纯函数。新 endpoint `GET /api/workflows/:id/export`（YAML body + Content-Disposition）/ `POST /api/workflows/import?onConflict=...`（text/yaml body）。前端 `workflows.tsx` 加 "Import YAML" file picker（409 时弹 prompt overwrite/new），`workflows.edit.tsx` 加 "Export YAML" 链接（query token auth）。tests 7 case |
| P-4-09 | Worktree GC | `services/gc.ts` `runWorktreeGc(db, config)` 扫 `tasks.status in [done,failed,canceled,interrupted]`，按 `worktreeAutoGc.{enabled, olderThanDays, onlyMerged}` 决定是否删 worktree（保留 task 行）；`onlyMerged` 用 `git merge-base --is-ancestor`。`startWorktreeGc(db, loadConfig, intervalMs=1h)` 每 tick 重新读 config。挂在 daemon。tests 3 case |
| P-4-10 | Task detail cancel + 启动失败 UI | startTask 早已在 worktree 创建失败时落库 status=failed + 返回 task 行（design.md §6.4）。tasks.detail 加 cancel/interrupt 状态下的 worktree-path 提示横幅 |
| P-4-11 | Loop 反馈语义文档化 | NodeInspector loop config 顶部 info-box-muted "v1 无跨轮反馈端口；状态完全靠 worktree 文件"；design/proposal.md 已有 §280/§683 callout |

### M0 全部完成（5/5）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-0-01 | opencode 兼容性验证 | 1.14.25 上 4 个隔离实验全过；最低版本 1.14.0 写入 `design.md` §18 |
| P-0-02 | monorepo 初始化 | Bun workspaces / `packages/{frontend,backend,shared}` / tsconfig / prettier |
| P-0-03 | CI skeleton | `.github/workflows/ci.yml`（matrix: ubuntu+macos，跑 format/lint/typecheck/test） |
| P-0-04 | ESLint + Prettier | `eslint.config.js` flat config + 跨包 import 边界规则（backend↮frontend 互斥） |
| P-0-05 | Drizzle schema | 8 张表完整定义 + WAL/NORMAL/busy_timeout + 启动时自动 migrate + in-memory 测试辅助 |

### M3 完成（14/14）

| ID | 标题 | 关键产出 |
| --- | --- | --- |
| P-3-01 | gitDiff snapshot + 3 sharding strategies | `util/git.ts` 拆 `gitDiffSnapshot(wt, fromCommit)` 返回 tracked+untracked 拼接 diff（无 cap，供分片用）；`worktreeDiff` 走它的 1 MiB 上限变种用于 HTTP。`util/diffSplit.ts` `parseDiff() / splitDiffPerFile() / splitDiffPerNFiles(n) / splitDiffPerDirectory(depth=1)` + rename 单 shard、binary 不进 shard 内容但 list 附加在 `binary files: …` 注释，shardKey = 桶内字典最小路径 |
| P-3-02 | agent-multi fan-out | 调度器新分支 `runFanOutNode`：等 sourcePort latest run.output → 选 shardingStrategy 切片 → 每 shard 起 child node_run (`parent_node_run_id` + `shard_key`) 走独立 `subprocessSem`（默认 4）；每 declared port 按 shardKey 字典序拼接 `\n`，自动 `errors` port 列出失败 shard。空 diff 直接 done 写空 ports；全 shard 失败 → 父 failed。`buildUpstreamMap` 把 sourcePort.nodeId 算作 upstream dep，否则 audit 会在 src 之前就绪 |
| P-3-03 | wrapper-git 节点 | 调度器执行 wrapper-git：`buildUpstreamMap` 把 `nodeIds[]` 设为 upstream → 所有内层 done 后才执行。取 baseline = `git rev-parse HEAD`，调 `gitDiffSnapshot(wt, baseline)` 写 `git_diff` port。空 nodeIds → wrapper-empty failed |
| P-3-04 | wrapper UI 组合 / 解组 | Canvas 右键菜单加 "Wrap in git wrapper / Wrap in loop wrapper / Decompose wrapper"。Compose 把当前 selection 包成 wrapper 节点（id=`wrap_git_<6>` / `wrap_loop_<6>` via ulid，position 比子节点左上角再左上偏 30，loop 默认 maxIterations=3 + exitCondition.kind=port-empty 让 validator 满意）。Decompose 删 wrapper 节点，子节点保留并自动 selection |
| P-3-05 | 写串行 / 只读并发 semaphore | `util/semaphore.ts` FIFO `Semaphore(capacity).acquire/release/run<T>(fn)`；scheduler 拆 strict for-loop 成 level-parallel：每轮收集 upstream done 的 ready batch → `Promise.all(runOneNode)`。每节点 acquire globalSem（cap maxConcurrentNodes，默认 4）+ writeSem（cap 1，仅 readonly=false 占用）+ subprocessSem（仅 fan-out 子进程）。tests 2 case（两 read 同 level 并发 < 550ms，两 write 串行 > 450ms）|
| P-3-06 | 节点 retries | scheduler runOneNode 内嵌重试循环：失败 + retry_index<retries 时 rollback 到当前 run.preSnapshot → 插新 node_run（retry_index+1）→ 重跑。每次拿同一组 semaphore 槽（write 不释放避免被其它 writer 插队）。tests 2 case（retries=2 fail→fail→done；retries=1 → 全失败 → task failed）|
| P-3-07 | 写节点 pre-snapshot | `util/git.ts` `gitStashSnapshot(wt)` 用 `git stash create`（不入 stash list，跨 task 安全）；`rollbackToSnapshot(wt, sha)` = reset --hard HEAD + clean -fd + stash apply --index；空 sha 走 reset+clean only。Scheduler 在每个非 readonly node start 前调 snapshot 写 `node_runs.pre_snapshot`。tests 6 case（clean / modified / 多次 stash / 回滚 / 空 sha / 错误 sha）|
| P-3-08 | Resume from failed/interrupted | `resumeTask(db, id, deps)`：遍历 latest 非 done 的 node_runs，对每个调 `rollbackToSnapshot(wt, preSnapshot)`，清 task error 字段、置 pending → 启动 scheduler。scheduler 主循环开头 pre-scan：把已 done 的 nodeId 放进 `completed` 集合并从 `remaining` 删，保证 done 节点不重跑。`POST /api/tasks/:id/resume`（终态 task 才允；其它 409 task-not-resumable） |
| P-3-09 | Single-node retry | `retryNode(db, taskId, nodeRunId, {cascade, deps})`：cascade=true（默认）走 edges DFS 找下游 + 仅自身；rollback + 给每个目标 insert 一个 failed row at retry_index max+1（scheduler 看到它会再次执行）；task → pending 启动 scheduler。`POST /api/tasks/:id/nodes/:nodeRunId/retry?cascade=true|false`，running task → 409 task-still-running |
| P-3-10 | 节点详情 4 tab — retries + 子进程 | `NodeDetailDrawer` 新增 `<SubProcessList>` 在 tabs 下渲染 fan-out 的子 node_run（按 shardKey 字典排序，每行 status chip + shardKey + tok），点击切换抽屉到该 child（通过新 prop `onSelectRun`）；`StatsTab` 末尾追加 Retries 列表（同 nodeId、不同 retry_index 的 parent runs），点击切换到对应 attempt |
| P-3-11 | prompt 模板内置变量扩展 | `shared/src/prompt.ts` BUILTIN_VARS 加 `__node_id__ / __iteration__ / __shard_key__`；scheduler 在 templateMeta 总是塞 `nodeId`，fan-out 子调用塞 `shardKey`；缺值时替换成空字符串（不报错）。tests +2 case |
| P-3-12 | per-node timeout | `RunTaskOptions.defaultPerNodeTimeoutMs` + node.timeoutMs passthrough；runOneNode 算出有效值传给 runner。runner 已有 timeout/SIGTERM + `node-timeout: exceeded Nms` 实现（P-1-13） |
| P-3-13 | stderr + raw stdout endpoint | stderr 持久化 runner 已经做了（kind=stderr 写 node_run_events）。新 service `getNodeRunStdout(db, taskId, nrId)` 串接非 stderr events.payload → 新 endpoint `GET /api/tasks/:id/nodes/:nodeRunId/stdout` 返回 text/plain。1 MiB 溢出到 logs/{taskId}/{nrId}.jsonl 推迟到 M5 |
| P-3-14 | Task 失败 UI 概述 + Jump | Task 已有 errorSummary/errorMessage/failedNodeId 列。TaskDetail 顶部红色横幅：summary 一句话 + 详情 `<details>` + 失败节点跳转按钮（取 failedNodeId 最新 node_run 写到 selectedNodeRunId → 抽屉自动打开）|

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

后端测试 **317 个 case**（`bun test` — 由 `bunfig.toml [test] root` 限定到 `packages/backend/tests`）；前端测试 **111 个 case**（`bun run --filter @agent-workflow/frontend test` → vitest + happy-dom + 自写 localStorage shim，因为 vitest 3 / happy-dom 15 在 node 25 下默认 storage 为空 `{}`）。后端 daemon 启动测试 spawn 子进程，~1-2s 每 case。git util / repos / tasks / 部分 workflow 测试初始化真实 git 仓 fixture。Runner / scheduler 测试用 mock-opencode 子进程脚本代替真 opencode。

M4 新增测试：scheduler 5 case（loop exit-immediate / exhausted / port-count-lt / port-equals / git-in-loop）+ limits 5 + orphans 2 + gc 3 + shutdown 2 + tokens 6 + workflow-yaml 7 = +30 case。

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

## 下一步：M5 续

P-5-01 + P-5-02 + P-5-04 + P-5-05 + P-5-06 闭合，P-5-03 stage 1 完成（脚手架 + nav/auth/settings）。后续工作：
- **P-5-03 stage 2**：把 stage 1 列表里"未迁"的所有路由/组件 hardcoded 英文外提到 i18n 键，覆盖剩余 ~38 个 .tsx（estimate L）
- P-5-06 GitHub Releases pipeline（S）— deps P-5-05
- P-5-07 Playwright e2e（M）
- P-5-08 vitest 前端关键组件单元（M）
- P-5-09 Settings restart-required toast（S）
- P-5-10 first-run onboarding（M）
- P-5-11 README + 用户文档（M）
- P-5-12 性能 + 稳定性 sweep（M）

---

## 历史下一步：M2（编辑器 + 启动器）

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
- **`.daemon.info` 终修复（2026-05-14）**：M4/M5 期间 `cli.test.ts:198` 在 Ubuntu / macOS CI 都偶发挂掉（`expect(existsSync('.daemon.info')).toBe(false)` after SIGTERM）。两次失败修复后才定位：`process.on('SIGTERM')` 注册时机太晚——在 `process.stdout.write('agent-workflow ready')` 之后。测试一读到 ready URL 立刻 SIGTERM，CI 高负载下信号常常先到，Node 默认动作直接 terminate，handler 还没装。修复 = 把 signal handler 移到 ready 行之前 + unlinkSync 写在 handler 同步入口（不要等 await import / await gracefulShutdown）。同时把 `.daemon.info` 的 writeFileSync 也排到 signal handler 之后。
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
