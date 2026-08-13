# RFC-300 Webhook 终态工作区即时清理 — 技术设计

状态：**Accepted / Implemented / Publishing（2026-08-14；完整本地门禁已通过；用户要求跳过外部 Codex review 并直接提交）**

## 1. 当前实现锚点

| 事实                           | 当前源码                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| 配置 schema/default/deep merge | `packages/shared/src/schemas/config.ts`、`packages/backend/src/config/index.ts`                               |
| GC 设置 UI 与最小写入白名单    | `packages/frontend/src/routes/settings.tsx` 的 `GcTab`、`packages/frontend/src/lib/settings-drafts.ts`        |
| 任务来源与空间所有权           | `tasks.webhook_trigger_id`、`tasks.space_kind`、`tasks.parent_task_id`（`packages/backend/src/db/schema.ts`） |
| 唯一 task status CAS           | `packages/backend/src/services/lifecycle.ts` 的 `setTaskStatus` / `trySetTaskStatus`                          |
| 活跃 task driver 所有权        | `packages/backend/src/services/task.ts` 的 `activeTasks` 与三条 `runTask(...).finally(...)`                   |
| 既有两阶段 workspace prune     | `packages/backend/src/services/gc.ts` 的 `claimWorkspacePrune` / `runWorktreeGc`                              |
| remote/scratch 删除原语        | `removeWorktree`、`deleteSnapshotRefs`、scratch `rmSync`                                                      |
| 启动恢复                       | `cli/start.ts` 在 HTTP/auto-resume 前执行 workspace reconcile                                                 |
| 误导 UI                        | `tasks.detail.tsx` 仅凭 `status + worktreePath !== ''` 显示 `worktreePreserved`                               |

### 1.1 RFC-294 目标架构对齐

本 RFC 的领域 owner 与依赖方向按 RFC-294 归位，当前仓尚未完成对应迁移波次，因此同时记录
目标态与本次 legacy 落点：

| 能力                                  | RFC-294 最终 owner / 交互                                                                                | 本次分类与理由                                                                                                                                                                  | 删除 legacy 的波次                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 直接 Webhook 根任务候选判据           | `integration` 构造 source-specific launch/terminal policy，只输出中性 attribution/ownership 决策         | **目标语义一致、路径 transitional**：纯判据暂放 `services/webhook`，不反向导入 task/GC                                                                                          | W4 integration 迁移                                                                                                         |
| status + durable prune claim 单写     | `task-execution` canonical lifecycle writer；claim 与终态同事务，commit 后发 classified committed effect | **目标语义一致、路径 transitional**：复用现存唯一 lifecycle writer，不另造第二写源                                                                                              | W3 lifecycle / TaskExecutionModule 迁移                                                                                     |
| linked worktree/scratch 物理删除      | task-execution 通过 `ExecutionWorkspacePort` 调 `source-control`，删除为可重建、幂等 effect              | **目标语义一致、路径 transitional**：复用 RFC-165 `gc.ts` Git/FS 原语，避免迁移完成前复制删除内核                                                                               | W5 source-control 迁移                                                                                                      |
| config、boot/ticker、post-commit 装配 | instance-based module composition + managed background job；bootstrap 只构造注入                         | **显式债务**：当前 `lifecycle.ts` 仍没有 RFC-294 的 module instance，只能沿既有 bootstrap `registerX` seam 装配；provider 不做 DB/业务查询，唯一业务判据仍在 integration 纯函数 | W3 先替换为 `TaskExecutionModule` instance port；W4/W5 接入 integration/source-control adapter；W9 删除 global registration |

本 RFC 不新建跨域 `common` helper、不让 lifecycle 导入 Webhook/config、不让 Webhook 直接删除 Git 目录，
也不把 FS 删除塞进终态事务。`registerTerminalWorkspacePrune*` 不是目标态公共 surface；它只是在 W3 前保持
唯一 writer 与热配置能力的临时 composition seam，禁止新增第二个 consumer。

## 2. Config 与设置页

### 2.1 Shared config

`ConfigSchema` 新增顶层布尔值：

```ts
webhookTaskWorkspaceAutoCleanup: z.boolean().default(false)
```

`DEFAULT_CONFIG` 显式写 `false`；`ConfigPatchSchema` 由 `partial()` 自动获得该字段。它是顶层标量，
沿用现有 `mergeDefaults` 即可兼容旧 `config.json`，不升级 `$schema_version`、不做 config
migration。§3.1 另有一条只增加 nullable claim 来源列的 DB migration。

配置的时序线性化点是终态 CAS 开始前对原子替换后的 `config.json` 的一次读取。与设置保存并发时，
一次终态转换只观察旧值或新值之一，不拼接中间态。

### 2.2 Frontend

`SETTINGS_CONFIG_SCOPE_KEYS.gc` 加入该键，否则 GcTab 看似保存成功但 patch 会被最小白名单丢弃。

`GcTab` 在通用 worktree GC 开关之前增加公共 `<Switch>`：

- label：Webhook 任务完成/取消后清理工作区；
- hint：明确事件仓 worktree + scratch、失败/中断保留、历史不追溯、删除后不可 retry/sync/live diff；
- 不新增 CSS、不自造 checkbox。

保存后热生效；无需给 daemon ticker 单独 reconfigure，因为策略在每次终态转换读取当前配置。

## 3. 单一候选判据

新增纯判据（名称可在实现期按所在模块调整，但不得复制）：

```ts
interface TerminalWorkspacePolicyInput {
  to: TaskStatus
  webhookTriggerId: string | null
  spaceKind: SpaceKind
  workspacePruningAt: number | null
  workspacePruneCause: 'webhook-terminal' | null
  workspacePrunedAt: number | null
}

function shouldRequestWebhookWorkspacePrune(
  enabled: boolean,
  input: TerminalWorkspacePolicyInput,
): boolean
```

返回 true 的充要条件：

```text
enabled
AND to IN (done, canceled)
AND webhookTriggerId IS NOT NULL
AND spaceKind IN (remote, scratch)
AND workspacePruningAt IS NULL
AND workspacePruneCause IS NULL
AND workspacePrunedAt IS NULL
```

不读 `trigger_context_json`：RFC-292 会把同一 context 继承给调用子任务，而它不是磁盘所有权证明。
`webhook_trigger_id` 是 RFC-257 在根任务 INSERT 中原子写入的直接 fire 归属；调用子任务不继承该列。
`space_kind` 再提供第二层所有权防线，`inherited` 即便出现脏 attribution 也不能删。

### 3.1 Durable claim 必须带来源

既有 `workspace_pruning_at` 同时承载两种协议：RFC-165 canonical workspace GC 的持久 claim，及
`runIsoWorktreeGc` 删除 iso container 时短暂持有、finally 清空的瞬时 claim。若 daemon 恰好在
iso GC 写 claim 后、finally 前崩溃，仅凭 timestamp + Webhook attribution 做启动恢复，会把这枚
旧 claim 错当成管理员开启本功能后留下的清理决定。

因此 migration 新增 nullable `tasks.workspace_prune_cause`，当前唯一非空值为
`webhook-terminal`：

- 终态 CAS 同时写 timestamp + `webhook-terminal`；
- RFC-300 finalizer/boot/ticker 只接管该 cause；
- RFC-165 age/merge GC 与 iso GC 只认领 cause 为 NULL 的行，并继续留下 NULL；
- 升级前已有 claim 自然 backfill 为 NULL，绝不会因为升级或打开开关获得清理授权；
- finalization 后保留 cause 作为历史决策证据，不把它当 UI wire 字段。

这条列是 rolling-compatible nullable additive change；DB CHECK 只允许 NULL，或在
`workspace_pruning_at IS NOT NULL` 时写 `webhook-terminal`。

## 4. 终态 CAS 内写 durable claim

### 4.1 注入策略，不让 lifecycle 导入 config

`lifecycle.ts` 不直接读取 `Paths`/config。增加 daemon assembly 注册的同步策略 provider：

```ts
type TerminalWorkspacePrunePolicy = (
  row: Pick<
    TaskRow,
    | 'webhookTriggerId'
    | 'spaceKind'
    | 'workspacePruningAt'
    | 'workspacePruneCause'
    | 'workspacePrunedAt'
  >,
  to: TaskStatus,
) => boolean

registerTerminalWorkspacePrunePolicy(provider | null)
```

`cli/start.ts` 注册 provider；provider 每次读取当前 config 并调用 §3 纯判据。测试可注册/清空，避免
隐式依赖真实用户配置。

provider 异常不能把一个已经完成的任务改判失败：记录明确 warning，本次不认领。正常 daemon 的
config 已在启动/PUT 时通过 schema，此分支只覆盖磁盘被外部破坏等异常。

### 4.2 与 status 同一 UPDATE

`setTaskStatus` 初始 SELECT 补取候选字段。在构造 `writeStatus` 前计算一次 policy；当 true 时，
同一个 CAS UPDATE 同时写：

```ts
{
  status: to,
  finishedAt: ...,
  workspacePruningAt: now,
  workspacePruneCause: 'webhook-terminal',
}
```

不能在 status commit 后另跑 UPDATE，否则 daemon crash 会留下无法识别的“终态但未认领”行；不能
在 status CAS 前单独认领，否则 CAS 竞争失败会留下仍运行任务的孤立 claim。

既有 revival gate 已把 `workspace_pruning_at != NULL` 映射为 409、
`workspace_pruned_at != NULL` 映射为 410，因此 retry/sync 与清理的竞态已有单一赢家：

- 终态+claim CAS 先赢：后续 revival 被挡；
- 其它合法状态 CAS 先赢：本次终态 CAS 失败，claim 也不会落。

### 4.3 不做历史扫描

专用策略只在状态转换中写 claim。设置从 false 切为 true 时，不查询已有 done/canceled 行。因此
满足“开启后进入终态、历史不追溯”。

## 5. Claim 与文件删除分离

### 5.1 抽取现有 prune 原语

从 `runWorktreeGc` 抽出幂等的“删除一个已认领 workspace”原语，通用 GC 与本 RFC 共用：

```ts
finishClaimedWorkspacePrune(db, taskId, now, options)
```

它重新读取任务行并要求：

- `workspace_pruning_at IS NOT NULL`；
- `workspace_pruned_at IS NULL`；
- 调用方已证明没有活跃 task driver。

删除分派保持 RFC-165 原样：

- scratch：递归删 workspace 根 + invalidate call-graph cache；
- multi-repo：逐 `task_repos` remove worktree + delete snapshot refs，再删容器；
- single remote：`removeWorktree` + invalidate cache + `deleteSnapshotRefs`。

全部成功后写 `workspace_pruned_at=now`；任务行与 `worktree_path` 作为历史元数据保留。任一步失败，
保留 claim、记录 redacted warning，不改任务终态。

### 5.2 等执行所有权释放

终态 hook 只负责调度 finalizer，不能在 `setTaskStatus` 内直接跑 Git/rm。删除前必须通过
`isTaskActive(taskId) === false`：

- 正常 done/canceled：三条 task driver `runTask(...).finally(...)` 先 identity-delete
  `activeTasks` controller，再调用 claimed finalizer；
- cancel fallback / lifecycle repair 等没有 driver 的路径：终态 post-commit effect 在下一事件轮发现
  无 active owner 后执行；
- cancel fallback 抢先把仍退出中的任务写为 canceled：只落 claim；最终由那条 driver 的 finally 删除。

这保证“状态立即终态”与“磁盘删除不踩活进程”同时成立。

三处 `.finally()` 的共同逻辑应收为一个小 helper，避免 start/resume/retry 漏接其一；不在本 RFC
重构整个 scheduler ownership。

### 5.3 Crash 与失败续做

新增只扫**已有 claim**的专用续做：

```ts
runClaimedWebhookWorkspacePrunes(db, { isTaskActive, now, staleOnly })
```

候选限定 `webhook_trigger_id != NULL`、`space_kind remote|scratch`、status done/canceled、
`workspace_prune_cause='webhook-terminal'`、claimed、not-pruned。它不读取当前开关：claim 已是
历史线性化决定，关开关不能撤销；没有该来源的历史/iso claim 也绝不被接管。

调用点：

1. daemon boot 在 orphan reaping 后、HTTP/auto-resume 前续做旧进程留下的 claim；单实例锁已证明旧
   owner 不在，可立即重试；
2. worktree GC ticker 每轮先/后续做 stale claim，即使通用 `worktreeAutoGc.enabled=false` 也执行；
3. task driver finally 做低延迟单 task finalization。

同一进程内失败沿 RFC-165 `PRUNING_LEASE_MS` 后重试，避免多 worker 热循环；boot 可接管上一个已死
daemon 的 claim。重复调用只得到 already-pruned/claimed-noop，不重复删 refs。

## 6. 与通用 worktree GC 的组合

`runWorktreeGc` 的现有规则不变：

- enabled=false 仍不扫描未认领的普通终态；
- enabled=true 仍覆盖四个终态、年龄阈值与 `onlyMerged`；
- internal/inherited 仍排除；
- 其 claim/delete/finalize 改为调用 §5 公共原语，但候选集合和结果计数保持兼容。

专用即时策略不应用 `olderThanDays` 或 `onlyMerged`。若两者同时打开：终态 CAS 的专用 claim 先落，
通用扫描因 cause 非空不能抢占；专用恢复续做，不会双删。反向地，普通/iso GC 的 NULL-cause claim
也不能被专用恢复误删。

## 7. Task wire 与前端降级

为了不继续显示“worktree 已保留”的假信息，Task 详情投影新增兼容字段：

```ts
workspaceState?: 'available' | 'pruning' | 'pruned'
```

backend 从两个 tombstone 列计算；旧响应缺字段时新前端按 `available` 处理。它是能力状态，不暴露内部
claim 时间戳。

详情页：

- canceled/interrupted 的 `worktreePreserved` 只在 `workspaceState === 'available'` 渲染；
- `pruning/pruned` 使用公共 `NoticeBanner` 告知“工作区正在/已经清理，任务记录和归档结果保留”；
- `NodeDetailDrawer` 在 workspace 非 available 时不显示 retry；后端 revival gate 仍是权威；
- `WorkflowSyncBanner` 在 workspace 非 available 时不发无意义 preview 轮询；
- 文件/diff 面继续复用既有 410/missing 降级，不伪造空 diff。

## 8. 并发与失败矩阵

| 场景                               | 结果                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| done 与 cancel 竞争                | 仅一个 status CAS 胜出；claim 与赢家同写                       |
| terminal 与 retry/sync 竞争        | claim/revival 通过现有 tombstone CAS 互斥，单一赢家            |
| active driver 尚在退出             | claim 落库，删除推迟到 owner release                           |
| 两个 finalizer 同时执行            | task/claim 级互斥或条件更新保证一个删除 owner；另一个 no-op    |
| remote `git worktree remove` 失败  | 终态不变、claim 保留、lease 后重试                             |
| scratch 已被人工删除               | 幂等视为删除完成并写 pruned tombstone                          |
| daemon 在 claim 后崩溃             | boot reconcile 续做                                            |
| daemon 在删除后、finalize 前崩溃   | boot 看到目录已无，补写 `workspace_pruned_at`                  |
| iso GC 在 claim 后、finally 前崩溃 | cause 为 NULL；Webhook boot/ticker 不接管、不删 canonical 空间 |
| 设置随后关闭                       | 已认领任务继续；未来终态不再认领                               |
| trigger 行被删除                   | soft attribution 字符串仍在 task；清理不依赖 trigger 行存在    |
| 仅继承 trigger context 的 child    | `webhook_trigger_id=NULL` / `space_kind=inherited`，双重排除   |

## 9. 安全与权限

- 只有持有 `settings:write` 的现有管理员/manager 边界能切换配置，不新增权限点。
- 删除目标只来自已物化 task/task_repos 行和既有 containment/registered-worktree 原语；不接受请求路径。
- scratch 只删除受管 `space_kind='scratch'` 的任务根，不能把任意 path 当 scratch。
- linked worktree 删除继续通过 source repo 的 Git worktree registry；snapshot refs 使用 task ID 闭合前缀。
- 日志不输出凭据化 repo URL；错误沿现有 redaction。

## 10. 测试策略

### Shared/config

- 默认 false；旧 config backfill；PATCH true/false；CLI get/set round-trip。
- Config schema、default、frontend scope allowlist 的字段存在性棘轮。

### Backend 纯判据与 lifecycle

- 2 状态 × 2 空间正向矩阵。
- failed/interrupted/active 状态、manual/scheduled、local/internal/inherited、context-only child 反向矩阵。
- 状态 CAS+claim 原子：成功同写、CAS loss 同不写、provider false/异常不破坏终态。
- migration 保持旧 claim 的 cause 为 NULL；DB 约束拒绝未知 cause/无 timestamp 的专用 cause。
- 设置并发只观察完整 bool；已终态行在开关打开时不被追溯认领。

### Backend 文件系统与恢复

- 真实 linked worktree done/canceled 删除 + registry/snapshot-ref/tombstone 检查。
- 真实 scratch done/canceled 递归删除。
- active-owner defer；finally 后完成。
- remove 失败保持 claim；lease 前不热重试、lease 后重试。
- boot claim、delete-after-crash-before-finalize、双 finalizer 幂等。
- crashed iso/普通 GC 的 NULL-cause claim 不进入 Webhook boot/ticker/finalizer。
- 通用 GC 既有 age/onlyMerged/four-terminal tests 全回归。

### Frontend/E2E

- GcTab Switch 初值、切换、保存 patch 只含 gc scope 拥有键；双语与 a11y。
- workspace available/pruning/pruned 三态横幅；pruned 不显示 preserved/retry/sync。
- 真实 webhook remote 与 scratch 各一条 done；至少一条 canceled，证明 API 任务历史仍在、目录已无。
- failed/interrupted 与 inherited child 对照仍保留目录。

## 11. 回滚

关闭 `webhookTaskWorkspaceAutoCleanup` 即停止未来 claim，无需重启。已完成删除不可恢复；已认领但未
完成的删除继续，避免留下永久半清状态。DB migration 只增加 nullable、无默认值的
`workspace_prune_cause`，旧 binary 会忽略该列且旧写入继续合法；回滚代码时未知 config key 会被旧
schema 剥离。旧 binary 若启用了通用 GC，可按其原有年龄/合并规则续做已认领 workspace；否则保留
claim/目录，待恢复新版本后由专用 recovery 完成，不会把 NULL-cause 历史/iso claim 变成本功能授权。
