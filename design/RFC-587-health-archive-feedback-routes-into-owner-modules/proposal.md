# RFC-587 健康探测、任务归档与任务反馈三个路由按 owner 归入模块 inbound（RFC-294 W9-D：`routes/` → 模块 `inbound/` 第九批）

- **状态**：Done（2026-11-25，落地 `3469a00e1`）。用户 2026-11-25「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」（此前 2026-11-02、
  11-09、11-17、11-24 同样下达；2026-11-10「当前RFC294的设计已经刷新，你按照最新刷新的设计，进行推进」；2026-11-19「你加速推进RFC294」）。这条是
  对本会话列出的待定事项（六个路由的落位、W5 的 `util/git`）的回复：本会话按 RFC-294 刷新后的总纲自行裁定落位，不新增 DAG 边；设计门免、不派
  Codex（用户 2026-10-31）；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) design §2、§3 与 plan §4.6 W9-D；上一批路由见
  [RFC-583](../RFC-583-system-operations-config-docs-plantuml-routes-and-http-helpers/proposal.md)。

## 1. 背景

`routes/` 里有三个路由此前因为“迁进归属表记的 owner 会产生 DAG 之外的边”而暂缓（RFC-582、RFC-583 条目）。逐个看它们取的东西，都是只用到对方
一个窄的读取或本就该在别的模块：

| 文件                     | 归属表记的 owner | 取的别的模块                                                              | 裁定                                                                                                                                                                               |
| ------------------------ | ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routes/health.ts`       | platform         | task-execution 的运行任务计数类型（只用 `countRunningTasks()`）           | 守护进程的存活 / 就绪探测归 system-operations；运行任务计数改为本绑定声明的窄端口（task-execution 照旧满足，DAG 上 task-execution → system-operations 是 required-implementation） |
| `routes/taskArchive.ts`  | task-execution   | system-operations 的配置查询类型（只读 `taskArchive` 一段）               | 归 task-execution；配置改为本绑定声明的中性形状（同 RFC-583 的 `publicOrigin`）                                                                                                    |
| `routes/taskFeedback.ts` | task-execution   | memory 的 `MemoryOperations`（只把 `distillCommands` 交给 collaboration） | 任务反馈的创建、列表与可见性都是 collaboration 的命令 / 查询，归 collaboration；memory 那一项改用 collaboration 自己的蒸馏端口类型（RFC-559 已有）                                 |

## 2. 目标

- **G1**：三个路由迁入各自 owner 的 `inbound/http/`（`system-operations/…/healthRoutes.ts`、`task-execution/…/taskArchiveRoutes.ts`、
  `collaboration/…/taskFeedbackRoutes.ts`），挂载函数经各自 composition 转出，`server.ts` 改从那里取；旧位置不留转出；挂载调用与顺序不变。
- **G2**：迁入后只被本模块用的 public 符号撤回模块内部：collaboration 的 `createTaskFeedback`、`canViewTaskFeedback`、`listTaskFeedback`（移进
  application），task-execution `public/commands` 对 `TaskArchiveMaintenanceCommand` 的转出删去。
- **G3**：`legacy-horizontal-files` 62 → 59；未消费 public 符号保持 0；其余计数不升；DAG 之外的边不增加；行为不变。

## 3. 非目标

- `routes/tasks.ts`、`agents.ts`、`workgroups.ts`（按端点拆分，下一批）；`registry` / `operationRoute` 与 identity-access 的路由；W5 的 `util/git`。

## 4. 能力影响清单

无。

## 5. 用户可见变化

无。

## 6. 验收标准

- **AC-1**：三个旧路径不存在，全部源码、用例与脚本不再取它们；三个绑定只改 import 与上面三处窄类型（逻辑逐行不变）。
- **AC-2**：行为不变：挂载调用与顺序不变；健康、就绪、归档与反馈的路由用例通过。
- **AC-3**：`legacy-horizontal-files` 上限 62 → 59；未消费 public 符号保持 0；public 类型偏差不升；DAG 之外的边与跨 context 内部文件对不增加；归属表
  删三行；新增 RFC-587 用例并登记 guard-manifest。
- **AC-4**：受影响用例全部通过；推送后 exact SHA 的 GitHub Actions 全绿（环境性红格逐格归因、如实记录）。
