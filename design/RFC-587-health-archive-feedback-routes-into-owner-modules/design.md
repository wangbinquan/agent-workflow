# RFC-587 技术设计

记号：`S/` = `packages/backend/src/`，`SO/`、`TE/`、`CO/` 分别是 system-operations、task-execution、collaboration 的模块目录。数字取 HEAD
`3c4a3cefb`。不改行为。

## 0. 架构落位（RFC-294 第 8 条）

- **bounded context / 层**：三个绑定进各自 owner 的 `inbound/http`；挂载函数经 `SO/composition/routes.ts`、`TE/composition.ts`、`CO/composition.ts`
  转出（各模块已有的形状）。
- **不新增** DAG 之外的边：三个绑定都只取本模块、platform、shared 与 legacy 的 `@/auth/actor`、`routes/registry`。原来取别的模块的三处，换成本绑定
  声明的窄形状或本模块已有的端口类型——调用方传的对象照旧满足它们（结构类型），`server.ts` 的接线不变。
- **偏离项**：无。`health` 的归属表记的是 platform，platform 不依赖模块（design §3），而它读 task-execution 的运行任务计数、identity-access 的诊断与
  数据库身份，是守护进程级的探测，归 system-operations（与 RFC-583 把 `config` / `docs` / `plantuml` 归 system-operations 同理）。

## 1. 文件去向与连接

| 原文件                     | 新位置                                  |
| -------------------------- | --------------------------------------- |
| `S/routes/health.ts`       | `SO/inbound/http/healthRoutes.ts`       |
| `S/routes/taskArchive.ts`  | `TE/inbound/http/taskArchiveRoutes.ts`  |
| `S/routes/taskFeedback.ts` | `CO/inbound/http/taskFeedbackRoutes.ts` |

- **`healthRoutes.ts`**：`TaskStatusCountQueries`（task-execution 的 public 类型）换成本文件声明的 `HealthRunningTaskQueries`（只有
  `countRunningTasks()`）；同文件已有的 `IdentityAccessHealthDiagnostics` 也是这种本地窄形状。
- **`taskArchiveRoutes.ts`**：`ApplicationConfigurationQueries` 换成本文件声明的 `TaskArchiveConfiguration`（`read()` 同步或异步给出
  `Pick<Config, 'taskArchive'>`，`Config` 来自 shared）；`TaskArchiveMaintenanceCommand` 改从本模块 `application/ports` 取。
- **`taskFeedbackRoutes.ts`**：依赖里的 `memoryOperations` 改类型为 `{ readonly distillCommands: CollaborationMemoryDistillPort }`（collaboration 的
  蒸馏端口，`createTaskFeedback` 本来就收这个类型）；三个反馈函数改从本模块 application 取。
- **撤回**：`createTaskFeedback`、`canViewTaskFeedback`、`listTaskFeedback` 与它们共用的 `taskFeedbackService` 逐字从 `CO/public/commands.ts`、
  `CO/public/queries.ts` 移进 `CO/application/taskFeedbackOperations.ts`；`TE/public/commands.ts` 删去 `TaskArchiveMaintenanceCommand` 的转出。用例里取
  它们的改取新位置。
- `server.ts` 的三条 import 并进各模块已有的 composition import，挂载调用与顺序不变。
- **memory 的级联撤回**（集中验证查出，见 plan）：反馈绑定不再取 `MemoryOperations` 之后，它在模块外没有消费者了，连带只经它的字段可达的五个
  类型（`MemoryDistillWorker`、`MemoryDistillWorkerOptions`、`MemoryDistillQueries`、`MemoryInjectionQueries`、`MemoryInjectionBudget`）一起逐字移进
  memory 的 `application/memoryOperationContracts.ts`；`MemoryCatalogOperations` 仍被 knowledge-evolution 消费，留在 public。

## 2. 门、用例与文档

- 架构报告归属表删三行；`counts.json` 的 `legacy-horizontal-files` 上限 62 → 59。
- 钉着旧路径的用例随改：`rfc442` 的绑定清单、`rfc445` 的计数器读取清单、RFC-576 用例的 `composition/routes.ts` 名单（加 `mountHealthRoutes`）、
  `rfc480` 的 collaboration public 账本（若列了撤回的名字）；直接 import 旧路径的用例由搬迁脚本改写（判据输入的字面量若被改写，还原）。
- 不改：e2e 注释里的行号锚点（同 RFC-579 design §2）。
- 新增 `T/rfc587-health-archive-feedback-routes-into-owner-modules-boundary.test.ts`，登记 guard-manifest：① 三个旧路径不存在，`src` / `tests` /
  `scripts` 的全部说明符不再解析到它们（带负对照）；② 三个绑定对模块的 import 只取本模块（带负对照）；③ 四个撤回的名字不在 public 面；④ `server.ts`
  从三个 composition 取三个挂载函数。

## 3. 检索与推算

同 RFC-578 design §3：在 `3c4a3cefb` 的报告上推算三个绑定进各自 owner（撤回 4 个，边的角色一起核对）；钉点检索用 `pins.py`（含 `architecture`、
`.github`）与 `design/`、`docs/` 的 Markdown 链接。

## 4. 失败模式

- **有人在旧路径重建文件或重新取它**：RFC-587 用例 ① 红，legacy 计数也红。
- **绑定又取别的模块的 public**：用例 ② 红；取 DAG 之外的 offered public 时 `rfc294-review-offered-edge-dag` 也红。
- **撤回的名字回到 public**：用例 ③ 与未消费计数同红。

## 5. 取舍（可推翻）

1. **窄形状而不是补 DAG 边**：三处都只用对方的一个读取或一个端口；补边会让 task-execution → system-operations、collaboration → memory 变成全面的
   offered 依赖，而 RFC-559 / RFC-561 的方向正是收窄成消费方自有的端口。
2. **`health` 归 system-operations**：见 §0。

## 6. 对 RFC-294 刷新后规则的对账

- **C10**：入站绑定进 owner 模块的 `inbound/http`。**C11**：collaboration 与 task-execution 的 public 面各收窄只被本模块用的符号。**C12**：RFC-587
  用例 ① 覆盖全部说明符，② ～ ④ 只读相关文件。**C13**：`legacy-horizontal-files` 62 → 59，其余计数不升。
- **留下的债**：`routes/` 余 13 个（`tasks`、`agents`、`workgroups` 下一批；传输工具与 identity-access 的路由；task-catalog）。
