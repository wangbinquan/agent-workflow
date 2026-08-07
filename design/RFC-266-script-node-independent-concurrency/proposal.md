# RFC-266 · 脚本节点独立并发池 + 并发参数即时生效

> 状态：Draft（待用户批准）
> 作者：本 session（用户报障 + 三问拍板）
> 关联：RFC-103（`maxConcurrentNodes` 首次接线）、RFC-253（脚本执行节点）、RFC-130（每节点独立 worktree，writeSem 退化为短窗）

## 1. 背景

用户在设置页使用并发参数时报出两个 bug，并提出一条能力诉求。三者都落在同一片代码面（调度器的并发闸 + 设置到调度器的配置漏斗），因此合并为一个 RFC。

### Bug A —— 「Multi-process 子进程并发」保存了但从来没生效

设置页有这个输入框，值也确实写进 `config.json`，调度器也确实读 `opts.multiProcessSubprocessConcurrency`——但**中间没有任何一段代码把 config 里的值搬进 opts**：

| 环节                                       | 现状                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| 前端保存                                   | `packages/frontend/src/lib/settings-drafts.ts` limits 组含该键 ✅                        |
| 落盘                                       | `packages/shared/src/schemas/config.ts:78`（schema）/ `:595`（默认 4）✅                 |
| **config → StartTaskDeps**                 | `services/launchRuntimeConfig.ts` 读了 `maxConcurrentNodes` 等 8 项，**唯独没读它** ❌   |
| **StartTaskDeps → RunTaskOptions**         | `services/task.ts` 的 `runtimeConfigOpts` 同样没有这一项 ❌                              |
| 调度器消费                                 | `services/scheduler.ts:651` `new Semaphore(opts.multiProcessSubprocessConcurrency ?? 4)` |

结果：**任何部署上分片扇出的并发恒为硬编码的 4**，管理员怎么调都没用；全仓只有单测（直接构造 opts）能改到它。这与 `launchRuntimeConfig.ts` 注释里记载的 RFC-108 旧事故（`defaultPerNodeTimeoutMs` "threaded NOWHERE"）、RFC-103 的 `maxConcurrentNodes` 旧事故是**同一类漏接线**，第三次复发。

### Bug B —— 「最大并发节点数」改了不立即生效

全局闸是 daemon 级共享单例（`services/processNodeConcurrency.ts:12`，按 DbClient 弱引用键控），`Semaphore.resize()` 本身实现正确（`util/semaphore.ts:58-64`：增容会立刻 drain 排队者，缩容不抢占在飞者）。问题是**唯一的调用方是 `runTask`**（`scheduler.ts:645`）：

- 保存设置时没有任何代码 resize 这把闸；
- 只有**下一个任务启动**时才顺带把新值套上去；
- 若此刻没有新任务启动，改动**永远不生效**；正在排队等名额的节点也不会被放行。

`PUT /api/config` 已有热生效的先例与位置（`routes/config.ts:212` 的 `containmentCoordinator.setMode(updated.sandboxMode)`，RFC-233 明确写为线性化点），并发闸只是没接上去。

### 诉求 C —— 脚本节点不该和 agent 抢同一个闸

RFC-253 的脚本节点复用了 agent 路径的同一批原语，其中包括全局闸：`scheduler.ts:4059` 与 `scheduler.ts:5054` 取的是同一个 `globalSem`。用户诉求：**脚本节点独立限流**——脚本通常是秒级的纯计算/整理步骤，被 4 个多分钟的 agent 占满名额后要干等，属于不合理的相互阻塞。

## 2. 目标 / 非目标

### 目标

- **G1**：`multiProcessSubprocessConcurrency` 真正从设置生效到运行（补齐两级漏斗）。
- **G2**：三个并发参数**保存即生效**，含**正在运行的任务**与**正在排队等名额的节点**，无需重启 daemon、无需等下一个任务启动。
- **G3**：脚本节点使用**完全独立**的并发池，与 agent 池互不占用（用户 Q2 拍板：总量相加）。
- **G4**：设置页三个字段的文案能自解释——管辖谁、生效范围、默认值。

### 非目标

- **NG1**：**不**解除 `script-in-fanout-unsupported` 禁令（`services/workflow.validator.ts:1220`，RFC-253 明列非目标）。因此脚本侧**只加一个池参数**（用户 Q1 拍板 A），不为脚本造一个今天永远跑不到的扇出子池假门。
- **NG2**：不改 RFC-130 的 writeSem 模型（每节点独立 worktree，writeSem 只在快照/合并短窗持有）。
- **NG3**：不改 `call-workflow` / `call-workgroup` 「不占名额、由子任务自己的节点去占」的既有语义（`scheduler.ts:4863-4866`）。
- **NG4**：不引入第三个「daemon 总进程上限」兜底闸（用户 Q2 明确选「完全独立、总量相加」）。
- **NG5**：不改配置键名 `maxConcurrentNodes`（改名 = 存量 `config.json` 迁移，收益为零）；只收窄其语义并改 UI 文案。

## 3. 用户故事

- **US-1**：管理员把「分片扇出子进程并发」从 4 调到 8，下一个跑分片扇出的任务真的同时跑 8 个分片。（今天：恒 4）
- **US-2**：机器负载高，管理员把「最大并发节点数」从 8 调到 2 并保存。正在运行的任务立刻收敛到 2 个在飞节点（已在跑的不被抢占，跑完不再补位）。反过来从 2 调到 8，**正在排队的节点立刻被放行**，不必等下一个任务启动。（今天：两个方向都要等下一次 `runTask`）
- **US-3**：一条工作流里 4 个审计 agent 正满负荷跑着，同 DAG 层的一个脚本节点（拼 JSON、算分片清单）**立即开跑**，不排在 agent 后面。（今天：脚本要等 agent 让出名额）
- **US-4**：管理员在设置页看到三个并发框，光看文案就知道：哪个管 agent、哪个管脚本、哪个管扇出分片，以及改了之后什么时候生效。

## 4. 最终形态（管辖矩阵）

| 池                              | 配置键                              | 作用域        | 谁占用                                                                                          | 热生效 |
| ------------------------------- | ----------------------------------- | ------------- | ----------------------------------------------------------------------------------------------- | ------ |
| **Agent 类节点池**              | `maxConcurrentNodes`（默认 4）      | daemon 级共享 | agent 单节点、工作组主持节点、分片扇出的**每个分片**与聚合节点                                    | ✅ 即时 |
| **脚本节点池**（新）            | `maxConcurrentScriptNodes`（默认 4）| daemon 级共享 | RFC-253 脚本节点                                                                                  | ✅ 即时 |
| **扇出子池**                    | `multiProcessSubprocessConcurrency`（默认 4） | **每任务** | 同一任务内分片扇出的分片 / 聚合（**套在 agent 池之内**的二级闸）                        | ✅ 即时（新增注册表） |
| 每任务 worktree 写锁（不在本 RFC 范围） | ——                          | 每任务        | 每个节点的快照/合并短窗                                                                          | ——     |

不占任何名额：`call-workflow` / `call-workgroup`（NG3）、RFC-130 内建合并冲突 agent（`scheduler.ts:2779`，绕开防死锁）、wrapper 容器本身（git / loop / fanout 只是容器）。

## 5. 行为变更清单（批准即视为逐条确认）

本 RFC 不关闭任何既有能力，但有三条**面向部署者**的行为变更，按 `CLAUDE.md` §7 的精神逐条呈报：

- **B-1（并发总量上升）**：`maxConcurrentNodes` 语义收窄为「agent 类节点」。同样的配置数值下，daemon 峰值子进程数从 `N` 变为 `N + maxConcurrentScriptNodes`（默认 4 + 4 = 8）。资源紧张的部署应在升级后按需下调两者。**这是用户 Q2 明确选择的语义**（完全独立、总量相加）。
- **B-2（扇出并发从此真的按配置跑）**：存量部署里 `multiProcessSubprocessConcurrency` 一直空转在 4。修好之后，配置里写着大值（例如某人当年调到 16 后发现"没用"就留在那里）的部署，升级后扇出会**真的**按 16 跑。发布说明须提示复核该值。
- **B-3（缩容即时对运行中任务生效）**：调小任一并发参数会立刻影响**正在运行**的任务（不抢占在飞节点，但不再补位）。这是 US-2 明确要的语义，也是"立即生效"的必然含义。

零数据迁移：新配置键由 `mergeDefaults` 在读取时回填默认值（`backend/src/config/index.ts`），`$schema_version` 不变。

## 6. 验收标准

**接线（Bug A）**

- **AC-1** `resolveLaunchRuntimeConfig` 从 config 读出 `multiProcessSubprocessConcurrency` 与 `maxConcurrentScriptNodes`。
- **AC-2** `runtimeConfigOpts` 把两者摊进 `RunTaskOptions`；缺省不合成键（保持 wire 最小）。
- **AC-3** 一次真实启动（start / resume / retry 任一入口）里，调度器拿到的 opts 携带配置值而非默认值。

**热生效（Bug B / G2）**

- **AC-4** `PUT /api/config` 后，agent 池与脚本池的 `capacity` **在响应可观测时**已等于新值（与 `sandboxMode` 同一线性化点）。
- **AC-5** 增容时**正在排队**的取名额者被立刻放行（不必等任何持有者释放）。
- **AC-6** 缩容不抢占在飞持有者；释放后不补位到超过新容量。
- **AC-7** 正在运行的任务的扇出子池同样被 resize（daemon 级注册表遍历）。
- **AC-8** daemon 全程不重启；无新任务启动也生效。

**脚本独立池（诉求 C）**

- **AC-9** `maxConcurrentNodes: 1` 且该名额被一个 agent 节点占住时，同层脚本节点**立即开跑**（不等待）。
- **AC-10** `maxConcurrentScriptNodes: 1` 时，两个同层脚本节点串行；此时 agent 节点不受影响照常并行。
- **AC-11** 脚本节点的名额在整个「iso 建立 → 依赖安装 → 全部重试 → 合并回写」窗口内持有，`finally` 释放（与今天的持槽窗口一致，只是换了池）。

**文案（G4）**

- **AC-12** 设置页三个字段各带 hint，中英双语，写明：管辖对象、与其他池的关系、生效范围（保存即生效 / 含运行中任务）、默认值。
- **AC-13** 文档与代码注释里关于并发的过期断言全部改正（详见 design §7）。

**回归防护**

- **AC-14** 存在源码层锚点断言，防止「脚本节点又被接回 agent 池」「新的 config 键又漏接漏斗」再次漂移。
