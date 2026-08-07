# RFC-266 · 技术设计

## 0. 现状锚点（全部为本次实读，行号以 `main` 当前 HEAD 为准）

| 事实                                                        | 锚点                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 全局闸构造（daemon 级共享单例，唯一调用方是 runTask）        | `backend/src/services/scheduler.ts:645` → `services/processNodeConcurrency.ts:12`      |
| 扇出子池构造（每任务 new，值来自从未被填充的 opts）          | `scheduler.ts:651`                                                                     |
| agent 单节点取名额                                          | `scheduler.ts:5054`                                                                    |
| **脚本节点取的是同一把 globalSem**                          | `scheduler.ts:4059`（持槽窗口至 `:4186` 的 `finally { releaseGlobal() }`）             |
| 工作组主持节点取名额                                        | `scheduler.ts:867`                                                                     |
| 扇出分片 / 聚合取 global + subprocess 两级                   | `scheduler.ts:7442-7443` / `:7903-7904`                                                |
| `call-*` 不取名额（子任务自己的节点去取）                    | `scheduler.ts:4863-4866`                                                               |
| 合并 agent 绕开 globalSem 防死锁                             | `scheduler.ts:2725-2726` / `:2779`                                                     |
| 锁序声明 `writeSem ≺ globalSem ≺ subprocessSem`              | `scheduler.ts:5046-5053`                                                               |
| Semaphore.resize 语义（增容 drain、缩容不抢占）              | `util/semaphore.ts:52-64`                                                              |
| 配置 schema / 默认值                                        | `shared/src/schemas/config.ts:76-78` / `:594-595`                                      |
| 配置补丁 = `ConfigSchema.partial()`；读盘回填默认            | `config.ts:648`；`backend/src/config/index.ts` 的 `mergeDefaults`                      |
| 配置漏斗 ①（config → StartTaskDeps）                        | `services/launchRuntimeConfig.ts` 的 `resolveLaunchRuntimeConfig`                      |
| 配置漏斗 ②（StartTaskDeps → RunTaskOptions）                | `services/task.ts` 的 `runtimeConfigOpts`（三处 kick 共用）                            |
| 现有热生效线性化点                                          | `routes/config.ts:212`（`containmentCoordinator.setMode`，RFC-233）                    |
| 脚本禁入扇出                                                | `services/workflow.validator.ts:1220`（`script-in-fanout-unsupported`）                |
| 每任务注册表的生命周期教训（**gc 只许在 runTask finally**）  | `services/taskWriteLocks.ts:12-19` 模块文档 + `:76-89`                                 |
| 设置页字段 / 草稿归属                                       | `frontend/src/routes/settings.tsx:530-545`；`frontend/src/lib/settings-drafts.ts` limits 组 |

## 1. 三池模型

```
                        ┌──────────────────────────── daemon ────────────────────────────┐
  agent 单节点 ────────►│ agentPool   cap = maxConcurrentNodes                            │
  工作组主持节点 ──────►│  (WeakMap<DbClient, Semaphore>)                                 │
  扇出分片 / 聚合 ─────►│                          └─► 再取 ─► taskFanoutPool(taskId)      │
                        │                                cap = multiProcessSubprocessConc.│
  脚本节点 ────────────►│ scriptPool  cap = maxConcurrentScriptNodes                      │
                        └────────────────────────────────────────────────────────────────┘
  call-workflow / call-workgroup ─► 不取（子任务自己的节点去取）
  RFC-130 合并 agent ────────────► 不取（防 writeSem↔pool 死锁）
```

**关键不变量**

- **I1**：一个执行者只会取 agentPool 或 scriptPool 之一，**永不同时持有两者** → 两池之间不存在锁序，不可能构成环。
- **I2**：锁序在池分裂后维持为 `writeSem ≺ (agentPool | scriptPool) ≺ taskFanoutPool`。脚本节点不取 taskFanoutPool（NG1），因此脚本路径只有 `writeSem ≺ scriptPool` 两层，与今天完全同构。
- **I3**：`taskFanoutPool` 只在持有 agentPool 名额后取（`scheduler.ts:7442-7443` 的既有顺序不变）。

## 2. 数据流（两处漏斗 + 一处热生效）

```
config.json
   │ ① resolveLaunchRuntimeConfig(configPath)            ← 补 multiProcessSubprocessConcurrency
   │                                                       + maxConcurrentScriptNodes
   ▼
StartTaskDeps
   │ ② runtimeConfigOpts(deps)                            ← 同上两项摊成 flat 键
   ▼
RunTaskOptions ──► runTask ──► SchedulerState { agentSem, scriptSem, fanoutSem }
                                    │
PUT /api/config ────────────────────┘ ③ 保存后就地 resize（agentPool / scriptPool / 全部 taskFanoutPool）
```

三段都必须落实，缺任何一段就退化成本 RFC 要修的 bug 之一。

## 3. 模块改动

### 3.1 `services/processNodeConcurrency.ts` —— 扩成双池

保留「一个 DbClient = 一个 daemon = 一份预算」的既有键控，把单 WeakMap 升成按池种类键控：

```ts
export type NodePoolKind = 'agent' | 'script'

/** daemonScope → { agent: Semaphore, script: Semaphore } */
const pools = new WeakMap<object, Partial<Record<NodePoolKind, Semaphore>>>()

export function getNodePoolSemaphore(
  daemonScope: object,
  kind: NodePoolKind,
  capacity: number,
): Semaphore
```

- `getProcessNodeSemaphore(scope, cap)` **保留为 `kind:'agent'` 的薄包装**（现有调用方与既有源码锚点测试 `process-node-concurrency.test.ts` 不必改写），或按实现门口味直接改调用点 + 同步更新那条锚点断言。取后者更干净：**本 RFC 选择直接改调用点并更新锚点断言**（面向代码最合理优于改动最小）。
- resize-on-read 语义不变（容量变了就 resize 同一实例，绝不换实例——换实例 = 预算分裂，正是该模块存在的理由）。
- 新增 `resizeAllNodePools(scope, {agent, script})` 供路由热生效调用（内部即两次 `getNodePoolSemaphore`）。

### 3.2 新模块 `services/taskFanoutPools.ts` —— 每任务扇出子池注册表

照抄 `taskWriteLocks.ts` 的形态与**它用血换来的生命周期纪律**：

```ts
const pools = new Map<string, Semaphore>()

/** getOrCreate + resize-on-read（同 processNodeConcurrency 的语义）。 */
export function getTaskFanoutSem(taskId: string, capacity: number): Semaphore

/** 设置保存时遍历 resize —— 让运行中的任务立刻感知（AC-7）。 */
export function resizeAllTaskFanoutSems(capacity: number): void

/** 仅允许 runTask 的 finally 调用；idle 守卫（available === capacity && queueLength === 0）。 */
export function gcTaskFanoutSem(taskId: string): void

/** 测试可见性。 */
export function taskFanoutPoolCount(): number
```

**为什么不能在 HTTP 侧 gc**：`SchedulerState.fanoutSem` 在整个 run 期间持有实例引用；HTTP 侧 delete + 下次 getOrCreate 会把同一任务的子池**裂成两个**，正是 `taskWriteLocks.ts:12-19` 记录的 S-9 病理。gc 只在 `runTask` 的 finally、且带 idle 守卫；泄漏上限是「每个异常退出的任务一个空闲 Semaphore 对象」，与既有写锁同等级、可接受。

**为什么不用 WeakMap<DbClient>**：键是 taskId（字符串）而非对象，且需要「遍历全部 resize」，WeakMap 不可枚举。与 `taskWriteLocks` 一致用模块级 Map；测试隔离靠 ULID 天然唯一 + `gcTaskFanoutSem`。

### 3.3 `services/scheduler.ts`

- `SchedulerState`：`globalSem` 拆成 `agentSem` + `scriptSem`；`subprocessSem` 改为从注册表取。
  ```ts
  agentSem:  getNodePoolSemaphore(db, 'agent',  opts.maxConcurrentNodes ?? 4),
  scriptSem: getNodePoolSemaphore(db, 'script', opts.maxConcurrentScriptNodes ?? 4),
  fanoutSem: getTaskFanoutSem(taskId, opts.multiProcessSubprocessConcurrency ?? 4),
  ```
- `runScriptNode`（`:4059`）改取 `scriptSem`；持槽窗口与 `finally` 释放**逐字不动**（AC-11）。
- agent 单节点（`:5054`）、工作组主持（`:867`）、分片（`:7442`）、聚合（`:7903`）改取 `agentSem`（纯改名，语义不变）。
- `runTask` 的 finally 增加 `gcTaskFanoutSem(taskId)`（与既有 `gcTaskWriteSem` 同处）。
- 更新 `:320` / `:5046-5053` / `:1449` 等注释里的池名与锁序声明。

### 3.4 `shared/src/schemas/config.ts`

```ts
/** Independent daemon-wide pool for RFC-253 script nodes (RFC-266). */
maxConcurrentScriptNodes: z.number().int().positive(),
```
+ `DEFAULT_CONFIG.maxConcurrentScriptNodes = 4`。`ConfigPatchSchema` 自动跟随（`.partial()`）；存量 `config.json` 由 `mergeDefaults` 回填 → **零迁移**。

### 3.5 `routes/config.ts` —— 热生效线性化点

紧邻既有 `containmentCoordinator.setMode(updated.sandboxMode)`（RFC-233 线性化点）之后：

```ts
resizeAllNodePools(deps.db, {
  agent:  updated.maxConcurrentNodes,
  script: updated.maxConcurrentScriptNodes,
})
resizeAllTaskFanoutSems(updated.multiProcessSubprocessConcurrency)
```

放在 `applyConfigPatch` **之后**：文件写失败时不得留下"已经按新值放行"的既成事实（与该处既有注释的取舍一致）。`deps.db` 与调度器的 `db` 是**同一个对象**（`cli/start.ts` 单例 `openDb` → `createApp` 与 `buildStartTaskDeps` 共用），因此 WeakMap 键控命中同一份预算——这一点由测试锁定（design §6 T-K）。

### 3.6 配置漏斗

- `launchRuntimeConfig.ts`：返回类型与实现各加两项读取（`multiProcessSubprocessConcurrency`、`maxConcurrentScriptNodes`），沿用既有 `!== undefined` 守卫写法。
- `task.ts`：`StartTaskDeps` 加两个可选字段；`runtimeConfigOpts` 的 `Pick<>` 与返回体各加两项。
- `scheduler.ts` `RunTaskOptions` 加 `maxConcurrentScriptNodes?: number`。

### 3.7 前端

- `settings-drafts.ts` limits 组加 `maxConcurrentScriptNodes`（**漏加 = 新字段保存不上去**，是本改动最容易踩的坑）。
- `settings.tsx`：三个字段都补 `hint`；新字段与现有两个同处 `form-grid--cols-2`（复用既有 `<Field>` / `<NumberInput>`，不新造 chrome）。
- i18n 双语：`maxConcurrentNodes(+Hint)` / `maxConcurrentScriptNodes(+Hint)` / `multiProcessConc(+Hint)`。zh-CN 的 interface 是键的单一事实源，漏写 en 即 typecheck 红。

## 4. 失败模式

| 场景                                                | 行为                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 配置缩容到小于当前在飞数                            | 不抢占；持有者跑完后不补位，自然收敛（`semaphore.ts:52-56` 既有语义）                    |
| 配置增容                                            | `resize` 内的 `drain()` 立刻放行排队者（AC-5）                                          |
| 配置写盘失败                                        | 抛在 `applyConfigPatch`，resize 不执行 → 不会出现「盘上旧值、内存新值」                  |
| 任务异常退出，未走 finally                          | 子池条目残留一个空闲 Semaphore；下次同 taskId（重试 / resume）getOrCreate 复用并 resize  |
| 两个并发 PUT                                        | 都在同一路由的既有 fence 内串行；最后一个写盘者的值也是最后一个 resize 者               |
| daemon 重启                                         | 全部池按 config 重新构造，无持久态                                                      |
| 脚本池设为 1、脚本节点在 loop 里跑 100 次迭代        | 逐次串行，与 agent 无关；loop 语义不变                                                  |

**死锁复核**：新增的 scriptSem 不与任何其他信号量嵌套持有（I1/I2）。既有 `writeSem ≺ agentSem ≺ fanoutSem` 链未变，`createIsoUnderLock` 内部的 writeSem 短窗仍在池名额之内取（与今天一致）。合并 agent 继续绕开池（`:2779`）。

## 5. 测试策略（§ 必写 case，PR 必须全绿）

**纯函数 / 单元**

- **T-A** `processNodeConcurrency`：同 scope 同 kind 复用同一实例；**agent 与 script 是两个不同实例**；resize 只影响本 kind；不同 scope 互不污染。
- **T-B** `taskFanoutPools`：getOrCreate + resize-on-read；`resizeAllTaskFanoutSems` 遍历生效；`gcTaskFanoutSem` 的 idle 守卫（有人持有/排队时**不**删）；`taskFanoutPoolCount` 归零。
- **T-C** `resolveLaunchRuntimeConfig`：两个新键从 config 读出；缺省不合成键。
- **T-D** `runtimeConfigOpts`：两个新键摊出（扩 `rfc103-launch-config-passthrough.test.ts`，它已是这条漏斗的既有回归锁）。

**路由 / 集成**

- **T-E** `PUT /api/config` 后 agent 池、script 池 capacity 立即等于新值（AC-4）。
- **T-F** 增容放行排队者：先占满 cap=1，另起一个 acquire 挂起，PUT 到 2 → 挂起者被放行（AC-5，不释放任何持有者）。
- **T-G** 缩容不抢占 + 不补位（AC-6）。
- **T-H** 运行中任务的扇出子池被 resize（AC-7：注册一个 taskId 的池 → PUT → 断言 capacity）。
- **T-I** 脚本与 agent 池独立：`maxConcurrentNodes:1` 被 agent 占住时脚本节点照跑（AC-9，沿用 `scheduler-boundary-fanout-concurrency.test.ts` 的 wall-clock 手法：串行会撑出倍数墙钟，并行塌回 ~1×）。
- **T-J** `maxConcurrentScriptNodes:1` 时两个脚本串行、agent 不受影响（AC-10）。
- **T-K** `deps.db` 与调度器 db 同一实例（否则热生效对不上号）——源码层断言 + 一条经路由 PUT 后读调度器所见 capacity 的集成断言。

**源码层锚点（防漂移，AC-14）**

- **T-L** `scheduler.ts` 中脚本分支必须取 `scriptSem`：断言 `runScriptNode` 区间内出现 `scriptSem.acquire()` 且**不**出现 `agentSem.acquire()`（补上上一轮盘点发现的空白：今天没有任何测试锁定脚本节点的取闸行为）。
- **T-M** 三个配置键都必须出现在 `resolveLaunchRuntimeConfig` 与 `runtimeConfigOpts` 里（防第四次漏接线复发）。
- **T-N** 更新 `process-node-concurrency.test.ts` 既有的 `getProcessNodeSemaphore(db, opts.maxConcurrentNodes ?? 4)` 文本锚点为新形态，并保留「不得 per-task new」的反向断言。

## 6. 需要同步改正的过期断言（AC-13）

| 位置                                          | 现状（错）                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `services/processNodeConcurrency.ts:1`         | "Daemon-wide **agent-node** concurrency budget"                             |
| `scheduler.ts:320`                             | "shared by **agent nodes** across tasks"                                    |
| `docs/agent.md:74-87`                          | 三信号量表：Multi-process 行写成 "Each child of an `agent-multi` fan-out"；写锁行写成 "Every `readonly: false` node"（RFC-130 已废除 agent 级 readonly 调度语义，`scheduler.ts:1449`）；其后两句 readonly 叙述同样过期 |
| `docs/architecture.md:65-71`                   | "per multi-process node sub-pool"（实际是 per-task 共用一池）+ 同款 readonly 叙述 |
| `design/design.md:769`                         | "父节点占 1 个全局名额，子进程……**不挤占其他节点全局名额**"（实际相反：父 wrapper 不占，每个分片各占 1 个） |
| `design/plan.md:745`                           | "独立于全局"（同上）                                                       |

`docs/agent.md` / `docs/architecture.md` 里超出并发范围的 `readonly` 叙述**一并改正**（它们与被改的表格同段，留半句错的比不改更糟）；不扩展到其余章节。

## 7. 与并发 RFC 的边界

- **RFC-253（脚本节点）**：本 RFC 只换脚本节点取哪把闸，不动其 iso / 依赖 / 围栏 / 端口任何一处。
- **RFC-265（agent env 通道）**：无交集。
- **RFC-233（containment 准入）**：只共用 `PUT /api/config` 的同一线性化点，不改其 setMode 行为。
- 共享索引文件（`design/plan.md`、`STATE.md`）按 `docs/dev-gotchas.md` 的 index-only 定式追加单行，绝不重排他人条目。
