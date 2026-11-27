# RFC-626 技术设计

> 状态：Draft。产品口径见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。
> 本文引用的行号以提交 `384cf824e` 为准，路径相对 `packages/backend/src/`。标「已核」的是我对着源码读过的，
> 标「调研」的是只读调研给出、实现前须复核的结论。

术语：**自动模式**指自动升级（`start` / `migrate` / `db migration auto`）使用的转换与编排方式；**人工模式**指
`db migration plan / run --approve`。**冻结**指取得旧库一份不再变化的副本并确定它的内容身份。
**工作副本**指在冻结副本上补完 epoch-1 剩余迁移后、供转换读取的那份私有副本（SQLite 是文件，PostgreSQL 是 scratch 库）。

## 1. 落位（RFC-294 对齐）

- **所属 bounded context**：`system-operations`（升级编排、备份、校验、回执，RFC-294 §3 把备份 / 恢复 / 诊断编排划给它）。
  机制在 `platform/persistence/migration`（源读取、冻结、转换引擎、目标装载）与 `platform/content/inventory`（内容盘点）。
  各模块的转换规则仍在各自的 `modules/*/infrastructure/migration`。
- **各层改动**：
  - `system-operations/domain/epochSwitch`：自动模式的结论分类（环境前置 / 内部错误）、回执里新增的决定清单。纯函数。
  - `system-operations/application/epochSwitch`：`planner.ts` 增加自动模式的前置计划，`runner.ts` 增加单遍顺序，
    `autoUpgrade.ts` 把环境检查提前。
  - `system-operations/infrastructure/epochSwitch`：目标 sink 把装载拒绝回报给引擎、目标收尾时的悬空行处理、校验口径。
  - `platform/persistence/migration`：源身份与轻量核对、转换引擎的自动处置与记账提速、PostgreSQL 分批。
  - 模块侧：`task-execution`、`collaboration`、`system-operations` 各自贡献「结束任务时本模块的行怎么变」（§3.2），
    另有若干规则把阻塞改成保留或封存（§3.4）。
  - `shared` + 前端：一个新的任务结束原因及其文案；`digital-employee` 应用层把它与「用户取消」同等对待。
- **跨模块合同**：模块只通过既有的 `ConversionContribution`（`platform/persistence/migration/conversion/rule.ts:95-103`）
  向引擎贡献内容，本 RFC 给它加一个 `settlers` 字段。引擎不引用任何模块，模块之间不互相引用。
- **本 RFC 承担的演进**：把「阻塞项是否属于可继续任务」的判定（现在在 `system-operations/domain/epochSwitch/remediation.ts:6-17`）
  下沉到 `platform/persistence/migration/conversion`，引擎与编排共用一处定义。
- **偏离项**：无。不新增 facade，不新增跨模块内部引用，`bootstrap` 只做装配。
- **留下的债**：人工模式仍是三段式（计划、备份、冻结后复核各做一遍盘点与转换），只享受到 §4.1、§4.3 的提速。
  人工模式的重复处理不在本 RFC 范围（proposal §3）。

## 2. 总览

现在的自动升级（已核，`application/epochSwitch/autoUpgrade.ts:189-298`、`planner.ts:476-607`、`runner.ts:316-693`）：

```
计划：  冻结(活) → 盘点 → 启动事实 → 预演转换 ─┐
                                               ├─ 有阻塞项 → 拒绝
批准 ──────────────────────────────────────────┘
执行：  冻结(活) → 盘点 → 备份
        停写 → 冻结(冻) → 盘点 → 核对备份 → 启动事实 → 预演转换 → 计划复核
        建新库 → 转换并装载 → 启动事实 → 收尾 → 校验(内含再收尾一次) → 导出回执 → 切换 → 自检
```

改后的自动模式：

```
前置：  环境检查（秒级，不通过即退出，不留痕）
计划：  冻结 → 盘点 → 启动事实 → 前置计划（只有静态的表到规则映射，不读行）
批准（自动）
执行：  重开冻结副本（常数时间）→ 备份 → 启动事实复核
        建新库 → [发现要结束的任务] → 转换并装载（转不过去的行封存） → 收尾（悬空行封存） → 校验
        导出回执 → 生成实际结果的计划文件 → 有新增决定时再批准（自动）→ 切换 → 自检
```

状态机（`discovered → planned → backed-up → quiescing → frozen → converting → validated → activation-prepared →
activated → verified → completed`）与每个阶段落盘的工件名不变，`verify`、`rollback`、`status`、`complete`、`trace`
读到的仍是同样的日志与工件。变化在每个阶段里做多少事。

## 3. 不因数据而停

### 3.1 处置模型

转换规则发现一条数据无法按原样带过去时发出阻塞项（`ConversionBlock`，`conversion/types.ts:116-127`）。
人工模式下它们照旧进入计划，由人处理。自动模式下，引擎按下面的顺序把每条阻塞项变成一个**决定**，转换继续：

| 顺序 | 阻塞项的特征 | 自动处置 | 节 |
| --- | --- | --- | --- |
| 1 | 「任务可继续所以阻塞」的六处发出点（§3.2.1） | **结束该任务**，随后同一批行按「非可继续任务」的既有路径转换 | §3.2 |
| 2 | 规则为它定义了保留办法（内容缺失、技能目录缺失、引用悬空等） | **保留**该行，缺的部分做标记或解除引用 | §3.4 |
| 3 | 其余行级阻塞项，含目标库不接受的行 | **封存**该行 | §3.3 |
| 4 | 表级 / 全局阻塞项 | 逐个定义（§3.4）；属于环境的在前置检查里报（§3.5） | |

每个决定都留记录：结束的任务、封存的行、标为缺失的内容各有一条迁移记录（`MigrationRecord`，kind `decision`）
与对应的逐行处置（`RowDisposition`），进入升级报告（§3.7）。

引擎输入增加一个字段（`conversion/plan.ts` 的 `ConversionInput`）：`resolution?: 'operator' | 'automatic'`，
缺省 `operator`，行为与现在完全相同。

转换计划（`ConversionPlanSection`）在自动模式下多两个字段：`resolution: 'automatic'` 与 `settlements`（§3.2 得到的结束集合，
规范排序）。它们进入计划摘要，从而进入运行绑定（`ConversionRunBinding.planDigest`）；人工模式不写这两个字段，计划摘要与现在逐字节相同。
`trace --replay` 从运行记录里的转换计划取回它们（`bootstrap/epochMigration.ts:290-303` 已是这样重建请求的）。

`ConversionSummary` 增加 `resolutions`（本次转换做出的全部决定，按种类分组）。人工模式下恒为空。

结束集合要在打开目标 sink 之前确定（运行行里登记的转换计划必须与引擎使用的一致，否则 `v3-run-plan-digest-mismatch`），
所以引擎的入口拆成两步，暂存库在两步之间保持打开：

```ts
// conversion/engine.ts
export async function prepareConversion(input: ConversionInput): Promise<PreparedConversion>
export interface PreparedConversion {
  readonly plan: ConversionPlanSection          // 自动模式下已含 settlements
  run(sink: ConversionSink, observer?: ConversionObserver): Promise<ConversionSummary>
  close(): void
}
// 既有入口保持：runConversion(input, sink) = prepare → run → close
```

`prepareConversion` 做暂存、建查找表，自动模式下再做发现（§3.2.2）；`run` 做其余部分。预演（dry run）与人工模式仍调用既有入口。

### 3.2 结束任务

#### 3.2.1 哪些任务会被结束

判定不另写一套规则，直接用转换规则自己的判断：**在该任务仍被当作可继续时，规则会不会为它发出阻塞项**。
这样的发出点共六处（已核 / 调研），它们的共同形状是「任务可继续才阻塞，否则走不阻塞的路径」：

| 来源 | 位置 | 情形 |
| --- | --- | --- |
| 运行记录 | `task-execution/.../run/evidence.ts:118` | 运行的帧、身份、容器、选择结果无法证明；`envelope_nonce` 为空且该运行被执行链用到；检查点格式无法映射；输入的上游运行缺失 |
| 任务本体 | `task-execution/.../task/evidence.ts:25-41` | 工作流快照不符合当前定义结构、名称或工作组配置无法解析、父子关系无法解析、仓库挂载互相矛盾 |
| 澄清 | `collaboration/.../clarifyRule.ts:85,315-326` | 澄清轮的题目、答案、草稿、归属无法对应 |
| 评审门 / 澄清门的打开操作 | `collaboration/.../gateOperationsRule.ts:24-36` | 打开操作停在准备中（旧服务被强行终止时的中间态） |
| 工作区准备 | `task-execution/.../task/validators.ts:6-54` | 准备操作停在进行中且已指向该任务 |
| 必需内容 | `platform/content/migration/receipts.ts:78-91` | 该任务的必需内容文件不在磁盘上（§3.4 第 1 行） |

这些规则在任务**不可继续**时本来就走不阻塞的路径（保留为只读历史并登记限制）。所以把任务结束之后，同样的行按既有路径转换，
转换规则的判断逻辑不改。

六处里只有前两处在阻塞项的 `detail` 里带了 `executableTask`（`remediation.ts:6-17` 据此给出「结束或取消任务」的处理办法）；
内容那一处带的是 `{evidence, resourceUses}`，所以不能靠 `detail` 的形状识别。为此给规则输出加一个方法，六处各改一个调用：

```ts
// conversion/rule.ts RuleOutput
/** 「该任务可继续所以阻塞」。人工模式下等同 block(block)，输出逐字节不变。 */
blockExecutable(task: { taskId: string; status: string }, block: ConversionBlock): void
```

自动模式下它不产生阻塞项：发现阶段（§3.2.2）把 `task.taskId` 记入结束集合；正式转换阶段到达它即为内部错误（§3.6）。

#### 3.2.2 发现过程

在暂存与查找表建好之后、打开目标 sink 之前，引擎做一轮**发现**（自动模式才有）：

1. 取出**声明了会结束任务的规则与校验器**。规则与校验器各加一个可选声明：

   ```ts
   readonly settles?: {
     /** 该行属于哪个任务。缺省读行上的 task_id（tasks 表读 id）；返回 undefined 表示从行本身判断不了。 */
     taskOf?(row: SourceRow, lookup: LookupResolver): string | null | undefined
   }
   ```

   没有声明 `settles` 的规则或校验器调用 `blockExecutable` 时，收集器抛内部错误（两种模式都抛），
   所以漏声明会被既有用例直接发现。六处发出点所在的规则与校验器都加上声明；内容规则的 `taskOf` 复用它已有的
   「行 → 所属任务」推导（`platform/content/migration/receipts.ts:30-49`）。
2. 用丢弃输出的收集器把这些规则跑一遍，只跑**属于可继续任务的行**：按任务分组的规则只取可继续任务的组；
   按块读取的规则只保留 `taskOf` 指向可继续任务的行；`taskOf` 返回 `undefined` 的行照常纳入，返回 `null`（不属于任何任务）的行跳过。
3. 收集 `blockExecutable` 指向的任务，加入结束集合；再把这些任务的可取消子任务（`parent_task_id` 指向它且状态为
   `pending / running / awaiting_review / awaiting_human`）逐层加入，原因记为父任务级联。
4. 对结束集合里的任务应用 §3.2.3 的改写，重建来源包含被改写表的查找表（查找表的来源是声明过的，`conversion/lookups.ts:47`），
   回到第 2 步；直到没有新任务加入。每一轮集合严格增大，上界是可继续任务的个数。

发现只在可继续任务的行上运行规则，代价与可继续任务的数量成正比，与库的总行数无关。参考数据上预计 2 轮、数秒。

正式转换时结束集合已固定。若正式转换里仍到达 `blockExecutable`，说明发现过程与正式转换看到了不同的输入，
属于内部不变量被破坏，以内部错误结束（§3.6），不做局部补救。

结束集合写进转换计划（§3.1）。进程中断后续做时 `prepareConversion` 重新发现一遍——同一份冻结数据得到同一个集合、
同一个计划摘要，与运行行里登记的一致；不一致即按既有路径报计划摘要不匹配。`trace --replay` 的请求里带着登记过的集合，
引擎先应用它，再照常做一遍发现并断言没有新增。

#### 3.2.3 结束时改什么

结束任务等价于「在旧版本里取消它，再升级」。取消在当前实现里写哪些数据已逐条核对
（`task-execution/infrastructure/childTaskLifecycleParticipant.ts:817-929`、
`collaboration/infrastructure/humanGateTerminalSweep.ts:29-92`；v0.19.2 的同名实现写入相同，调研）。
升级不能去改旧库，所以改写作用在**暂存行的解码值**上：行的原始证据（`canonical` / `raw`，回执里的来源摘要由它们计算）保持旧库原样，
规则读到的 `values` 是改写后的值。

改写由各模块以 `settlers` 贡献，引擎负责调用：发现阶段每确定一批任务，就对暂存库里这些任务的行重写一次解码值。

```ts
export interface TaskSettler {
  readonly table: string
  /** 取该行所属任务的列；`tasks` 表用 'id'。 */
  readonly taskColumn: string
  settle(values: DecodedSourceRow, ctx: { settlement: TaskSettlement; planTime: number }): DecodedSourceRow | null  // null = 不改
}
export interface TaskSettlement {
  readonly taskId: string
  readonly cause: 'unprovable-records' | 'parent-cascade'
  readonly originalStatus: string
  readonly blockCodes: readonly string[]     // 触发它的阻塞项代码，去重排序
  readonly parentTaskId: string | null       // 级联时的父任务
}
```

| 表 | 贡献模块 | 条件 | 改写 | 对应的取消行为 |
| --- | --- | --- | --- | --- |
| `tasks` | task-execution | 该任务 | `status='canceled'`；`finished_at` 为空则取升级时刻；`error_summary` 为结束原因（§3.2.4）；`error_message` 为原因代码 | `childTaskLifecycleParticipant.ts:858-884` |
| `node_runs` | task-execution | 状态为 `pending / running / awaiting_review / awaiting_human` | `status='canceled'`、`finished_at`=升级时刻、`error_message`=原因代码 | 同上 `:888-898` 与门清扫 `humanGatePersistenceParticipant.ts:30-71` |
| `task_execution_intents` | task-execution | 状态为 `pending / claimed` | `state='canceled'`、`failure_code`=原因代码、`completed_at` 与 `updated_at`=升级时刻 | `taskExecutionIntentTerminalSequence.ts` |
| `task_execution_owners` | task-execution | `state='claimed'` | `state='revoked'`、`revision+1`、`recovery_code='terminal-control-cancel'`、`updated_at`=升级时刻 | `:817-838` |
| `task_execution_lineage_operation_records` | task-execution | 绑定该任务且处于已授权重放 | 改为需要操作者，清空授权字段 | 同一终结序列（调研，实现前复核列名） |
| `clarify_rounds` | collaboration | `status='awaiting_human'` | 跨任务澄清轮 `status='abandoned'`、`abandoned_at`=升级时刻；其余 `status='canceled'` | `humanGateTerminalSweep.ts:49-80`、`domain/clarifyAnswers.ts:210-219` |
| `lifecycle_alerts` | system-operations | `resolved_at` 为空 | `resolved_at`=升级时刻 | 取消本身不做这一步（见下） |

三点说明：

- **不追加生命周期事件，也不动 `lifecycle_event_revision`。** 取消追加的事件只为驱动上表这些后续动作与工作区清理；
  升级直接完成这些动作，工作区保留（与「取消保留工作树」一致）。
- **告警。** 真实的取消不会关掉该任务未解决的卡住告警，于是已取消的任务仍留在任务列表的「需关注」里（调研，
  `task-execution/infrastructure/taskRecoveryOperations.ts:433,973-990`）。这是产品既有的缺口，本 RFC 不修它；
  但升级一次结束几十个任务时不应留下一批清不掉的「需关注」，所以结束时顺手解决这些告警。
- **不处理的行**：`doc_versions` 的待定结论、`task_questions`、`task_feedback`、`workgroup_task_state`、
  非运行中的 `workgroup_assignments`——真实的取消同样不动它们（调研），升级保持一致。

#### 3.2.4 原因及其显示

新增一个任务结束原因，定义在 `packages/shared/src/lifecycle.ts`（与 `daemon-restart` 等既有原因同处）：

| 字段 | 值 |
| --- | --- |
| `error_summary` | `ended by upgrade` |
| `error_message` | `ended-by-upgrade` |
| 级联子任务 | 沿用既有的 `canceled by parent task` / `canceled-by-parent-cascade` |

前端 `packages/frontend/src/lib/task-failure.ts` 的原因表加入它，文案：「升级时结束：旧版本的运行记录无法在新版本继续。」
/ "Ended during the upgrade: its records from the previous version cannot be continued."。
任务详情的元信息栏在 `errorSummary` 非空时显示这条文案（已有行为，`routes/tasks.detail.tsx:1223-1238`，调研）。

数字员工把「已取消且原因是用户取消」视为停止、其余已取消视为执行失败并可能自动重试该轮
（`digital-employee/application/digitalEmployeeExecution.ts:618`，调研）。被升级结束的任务多是几个月前的遗留，
升级后不应自己重新跑起来，所以新原因与用户取消同等对待：视为停止，不重试。

#### 3.2.5 与既有约束的关系

- 逐行处置的契约只允许可继续任务上的只读历史带 `executionUse:'none'` 与唯一原因 `null-envelope-nonce-unselected`
  （`conversion/types.ts:54-71`、`conversion/receipts.ts:163-176`）。结束之后任务不再可继续，这条契约不需要放宽。
- 计划文件里的 `unfinishedTasks`（`planner.ts:330-348`）按改写后的状态统计。
- 限制清单（`restrictions`）照旧由只读历史处置生成，自动接受；被结束的任务另列在 `resolutions.settledTasks`。

### 3.3 封存

自动模式下，收集器（`conversion/receipts.ts`）收到行级阻塞项时不再把该行归为 `blocked`，而是：

- 归为 `archived`；把该行的原始内容（`canonical` 与 `raw`）写成一份归档（`ArchivePayload`，kind `source-journal`、
  format `logical-row@1`，与 `conversion/bootUpgradeFacts.ts:176-186` 的既有做法相同）；
- 写一条处置：`class:'archived'`、`kind:'archived'`、`targets:[]`、`decision` 为原阻塞项的代码与细节
  （`archived` 处置的既有契约要求归档引用与非空决定，`receipts.ts:198-206`，调研）；
- 该行已发出的目标行照旧被丢弃（既有行为，`receipts.ts:366-369`）；
- 追加一条 `decision` 记录 `v2-row-set-aside`，供报告汇总。

既有的组语义不变：按组转换的规则里一行在转换前被阻塞，整组不转换（`engine.ts:338-362`），于是整组被封存。

**目标契约不接受的行**（`v2-target-column / -null / -codec / -check / -document / -unique`，`receipts.ts:105-131`）
能对应到来源行的，按同样方式封存该来源行；对应不到来源行的（规则凭空生成的目标行）属于内部错误。

**装载被目标库拒绝**：sink 现在把整个单元记成 `load-blocked`（`infrastructure/epochSwitch/conversionSink.ts:96-126`）。
自动模式下 sink 回滚该单元并把被拒的目标行返回给引擎（`loader.locate` 已能定位到行，`target/loader.ts`）；
引擎按「目标行 → 来源行」的对应把这些来源行预先封存，重新收集并提交该单元，至多重试到该单元没有可封存的行为止。
被拒的目标行对应不到来源行时为内部错误。

**悬空行**：封存一行可能让别的表里引用它的行悬空。目标库收尾时本来就逐个外键查悬空行
（`target/finalize.ts:11-47`，两种库通用）。自动模式下，收尾发现悬空行时不判失败，而是把这些行从业务表移入归档
（读出整行、写归档与 `v2-row-set-aside-dependent` 记录、删除），再查一遍，直到没有悬空行；轮数上界是外键链的深度。
之后照常加外键约束或打开外键检查。被移走的行记入校验报告，供与回执里的来源计数对账。

封存只用于两类情况：数据本身已经不自洽（旧库里就悬空、无法解析、违反旧库自己的约束），或 §3.4 列为封存的已下线功能遗留。
正常使用留下的状态都有保留办法（§3.2、§3.4）。

### 3.4 逐类处置表

下表覆盖调研列出的全部行级、表级阻塞来源。标「已核」的处置我已对着规则与目标结构读过；第 3～7 行还在核对中（plan T0），
设计门之前补齐。

| # | 阻塞项 | 情形 | 自动处置 |
| --- | --- | --- | --- |
| 1 | `v2-content-required-missing` | 必需内容文件不在磁盘上，所属任务可继续 | 结束该任务（§3.2）。任务不可继续时规则已有路径（已核，`platform/content/migration/receipts.ts:92-123`、`convert.ts:102-117`）：行照常转换，内容引用保留，产物回执登记 `missing`（缺失原因与依据），任务登记限制 |
| 2a | `v2-content-lost-at-freeze` | 盘点时在、读取时不在或已变 | 不阻塞，按缺失处理：引用保留，回执登记 `missing-at-freeze`；属于必需内容时并入第 1 行的路径 |
| 2b | `v2-content-bytes-unprovable` | 磁盘上的内容与登记的大小或摘要不符（文件被人改过），或读取中途变化 | 不阻塞，按「登记的内容已不可得」处理：引用保留，回执登记缺失并写明依据（现有字节与登记不符）；磁盘上的文件不动。不把改过的内容当作登记的那份呈现。属于必需内容时并入第 1 行的路径 |
| 2c | `v2-content-task-unprovable` | 必需内容缺失且找不到所属任务 | 走规则给「没有任务」的既有路径：记录决定，行照常转换（`receipts.ts:92-105`） |
| 2d | `v2-content-catalog-metadata-missing`、`-object-conflict`、`-source-invalid`、`-required-null` | 内容目录条目缺大小与摘要、同一对象登记冲突、目录解码失败 | 封存该行（§3.3） |
| 3 | `v2-boot-skill-*`、`v2-skill-*` | 技能目录或版本快照缺失、技能操作停在半途、目录与登记不一致 | 保留技能条目并标为内容不可用（待 T0）；无法表示时封存该技能，引用它的代理条目按第 9 行处理 |
| 4 | `v2-boot-url-*`（缓存仓库与任务） | 同一地址对应多个缓存仓库、旧格式地址无法还原 | 任务保留其登记的地址、不关联缓存仓库（待 T0）；缓存仓库无法还原地址时封存 |
| 5 | `v2-boot-schedule-*` | 定时任务的载荷、仓库、路径无法确认 | 保留并置为停用，登记原因（规则已有 `kept-disabled` 结果，待 T0 确认可覆盖全部原因） |
| 6 | `v2-boot-runtime-config-unproven`、`-defaults-unmigrated` | 家目录 `config.json` 无法确认、其中的默认值没能并入运行时条目 | 运行时条目原样保留，登记默认值未带入（待 T0）；`config.json` 不是合法 JSON 属环境问题（§3.5） |
| 7 | `v2-boot-fusion-source-unproven`、`v2-boot-fused-memory-unproven` | 技能融合 / 已融合记忆的来源无法确认 | 走规则已有的隔离（quarantine）结果（待 T0） |
| 8 | `v2-code-history-unfinished`、`-package-blocked` | 已下线的旧代码工作里未完结的条目 | 自动确认归档：自动模式下 `ctx.operatorDecisions` 对每个这样的行返回一条由引擎生成的确认决定（确认人 `automatic-upgrade`、时间取升级时刻、行摘要取当前行），规则照既有的已确认路径归档整表（已核，`archives/codeHistory.ts:92-99,123`、`archives/unfinishedWork.ts:71-110`）。生成的决定并入转换计划的 `operatorDecisions` |
| 9 | `v2-agent-reference-shape`、`-name-unproven` | 代理的技能 / MCP / 插件 / 依赖引用里有无法确认的条目（不是数组、条目形状不对、只写了技能名没写编号） | 保留代理，跳过无法确认的那一条引用，逐条登记（已核：引用是逐条展开成引用行的，`resource-catalog/.../agentsRule.ts:59-125`；悬空的引用本来就照常保留并登记，`:158-170`，引用列没有外键）。整列不是数组时按空列表处理并登记 |
| 10 | `v2-intent-artifact-undecodable`、`v2-bundle-artifact-undecodable` | 应用日志的产物无法解析且不在失败态 | 封存该日志行（§3.3）。规则已把原文写入归档（已核，`resource-catalog/.../bundleAppliesRule.ts:119-125,180-197`）；不照搬失败态「清空产物后保留」的路径，因为非失败态的日志可能被恢复流程当作可继续的应用 |
| 11 | `v2-dangling-reference` | `users.created_by`、`development_missions.reopened_from_mission_id` 指向不存在的记录 | 解除引用：该列置空并登记，沿用既有的解除做法（已核：目标列可空，`identity-access/.../schema.ts:427`、`development-automation/.../schema.ts:1369`；做法见 `conversion/alignment/memories.ts:13-25`） |
| 11b | `v2-dangling-reference` | `task_collaborators.added_by` 指向不存在的用户 | 目标列不可空（已核，`collaboration/.../schema.ts:786`）。协作者行保留，`added_by` 改为系统用户 `__system__` 并登记原值——不能因为「谁加的」查不到就让协作者失去成员资格 |
| 12 | `v2-task-owner-dangling` | 任务属主用户不存在 | 任务保留，属主置空并登记（已核：目标列可空，`task-execution/.../schema.ts:1336`）。属主为空的任务只有资源管理员与协作者可见 |
| 13 | `v2-writer-not-os-active`、`v2-writer-state-missing` | 旧任务书（v0.19.2 里称「旧 Mission」，由数字员工新流程逐步排空；`terminal_at` 为空即未终结）尚未终结 | 新版本的写入状态恒为「新流程已接管」、不再接纳旧任务书，也没有「排空中」这个状态可以带入（已核，`digital-employee/infrastructure/writerCutoverPersistence.ts:23-25`、`development-automation/application/writerCutoverGates.ts:1-4`、`development-automation/application/missionOperationHandlers.ts:199`）。未终结的旧任务书逐条封存，它的从属行经 §3.3 的悬空行处理一并封存（已核：带 `mission_id` 的表都在 development-automation 模块内）；写入状态记录为已接管并列出被封存的任务书。全局状态行缺失时同样按已接管处理并登记。封存后新版本的任务书驱动器找不到它们，不会在升级后继续推进几个月前的旧任务书。参考数据里旧任务书为 0 条 |
| 14 | `v2-family-cutover-not-dispatchable` | 事件族的切换模式不是可分发 | 保留该行，按一次模式切换处理：`epoch` 加一、`changed_at` 取升级时刻、`change_ref` 记升级操作编号，并登记。投递只认「事件的生产代际等于该行的 `epoch`」的事件（已核，`platform/events/committed/deliveryPersistence.ts:80`），所以旧模式下记下的事件升级后不会被补投，新事件照常投递。v0.19.2 的生产代码从不改这个模式（已核：`changeCommittedEventCutover` 只有测试调用），参考数据 4 行全是可分发 |
| 15 | `v2-required-seed-missing` | 系统用户 `__system__` 或全局登录策略行不在旧库里 | 不自动处置，归入 §3.6：这两行由迁移写入、任何发布版都依赖它们，缺失只可能是被人删除，旧版本自己也无法正常工作 |
| 16 | `v2-identity-sequence-invalid`、`v2-source-generation-invalid` | 序列值或代际记录异常 | 封存该行；序列高水位改按最大行号推导（既有的 `max-row` 依据） |
| 17 | `v2-run-sequence`、`v2-lease-reset-without-run`、`v2-clarify-task-facts-missing`、`v2-gate-task-facts-missing`、`v2-orphan-group`、`v2-intent-event-unique`、`v2-source-codec`、`v2-undecided-source-codec`、`v2-host-not-placeholder`、`v2-host-still-referenced`、`v2-workflow-definition-shape`、`v2-host-grant-deletion-blocked` | 违反旧库自身约束、无法解析或被手工改坏的行 | 封存（§3.3） |
| 18 | `v2-task-workspace-preparation-in-flight`（未指向任务）、`v2-task-hosted-workspace-command-in-flight` | 准备操作停在进行中但没有对应任务；托管命令在途 | 前者走规则给「任务不存在」的既有路径（原文归档 + 记录，行照常复制，`task-execution/.../task/validators.ts:17-40`）；后者只在托管形态出现，自动模式按封存处理 |

`v2-operator-decision-stale / -unused` 在自动模式下不会出现（决定由引擎针对当前行生成）。

### 3.5 环境前置检查

自动会话在取得锁、登记意图之后，读取任何大块数据之前，依次检查（任何一项不通过即以**拒绝**结束，退出码 3，
不创建操作目录下的运行工件，不建库）：

| 检查 | 做法 | 文案包含 |
| --- | --- | --- |
| 结构来自发布版 | 只读打开旧库，取目录、迁移日志与各表行数算指纹并识别（`supportedSources.ts` 的 `identifySource`；现在要等第一次整库摘要与拷贝之后） | 逐条列出多出、缺少、被改动的对象 |
| 旧库可读且完整 | SQLite `quick_check` 与外键检查；PostgreSQL 连通与版本 | 失败的检查项 |
| 磁盘空间 | 按**有效数据量** L 估算：SQLite 取（页数 − 空闲页数）× 页大小，而不是文件大小（现在取文件大小，`freeze/capacity.ts:29-33`）；PostgreSQL 取 `pg_database_size`。所需 = 冻结副本兼备份 1×L + 工作副本 1×L + 暂存 2×L + 新库 1.5×L（与操作目录同一文件系统时）+ 内容清单（每个文件按 250 字节）+ 10% 余量；工件库不能用硬链接的文件系统上另加 2×L。现行公式对参考数据给出 151.8 GB（当时可用 153.4 GB，只差 1.6 GB 就会被判为空间不足），实际新增占用峰值约 16 GB | 需要多少、可用多少、在哪个目录 |
| PostgreSQL 目标库与 scratch 库 | 既有的 `provisioning.prepare`（RFC-398 §3），已在计划之前 | 既有文案 |
| 旧版「搬到 PostgreSQL」操作未完成 | 既有判断（`autoUpgrade.ts:147-151`） | 既有文案 |
| 另有人工迁移操作在进行 | 既有判断（`domain/epochSwitch/autoUpgrade.ts:86-95`） | 既有文案 |
| 家目录 `config.json` 不是合法 JSON | 读取并解析 | 文件路径与解析错误 |

新增的只是把结构与空间两项提前，并修正空间的算法；其余是既有判断。

### 3.6 仍会以错误结束的情形

自动模式下，下列情况以**错误**结束（退出码 1，旧库不动，可再次启动续做或重试），不属于「因数据拒绝」：

- 转换器内部不变量被破坏（`ConversionContractError` 中与来源数据无关的那些、发现与正式转换不一致、目标行对应不到来源行）。
- 来源数据违反旧库自身的类型约束到无法建立查找表的程度（任务状态不在枚举内、主键不是文本、主键重复等，调研列出 5 处抛错点）。
  这些状态无法由发布版写出，且数据库自己的约束会拒绝它们；出现即视同库损坏。
- 环境在升级中途变化（磁盘写满、PostgreSQL 断连、有程序改了旧库）。
- 新库没通过自检：自动撤回，之后启动需 `db migration auto --retry`（proposal C6）。

错误信息除原因外附带操作编号与工件目录，便于据此定位。

### 3.7 报告与可见性

- **回执**（`database-migrations/auto-upgrade/sessions/<op>/receipt.json`）增加 `resolutions`：

  ```json
  {
    "settledTasks": [{ "taskId": "…", "name": "…", "originalStatus": "interrupted", "cause": "unprovable-records", "blockCodes": ["v2-run-null-nonce"] }],
    "missingContent": [{ "table": "doc_versions", "key": "…", "column": "body_path", "reference": "runs/…/v1.md", "taskId": "…" }],
    "setAside": [{ "table": "…", "key": "…", "code": "v2-dangling-reference", "dependentOf": null }],
    "acknowledged": { "v2-code-history-unfinished": 12 },
    "kept": [{ "table": "scheduled_tasks", "key": "…", "code": "v2-boot-schedule-kept-disabled" }]
  }
  ```

  每类最多列 1000 条，超出给总数并指向新库里的迁移记录表。
- **日志**：升级完成时逐类打印总数，并逐条打印被结束的任务（编号、名称、原状态）；其余类别逐条打印前 50 条。
- **界面**：被结束的任务在任务详情显示原因（§3.2.4）。缺失的内容沿用界面对「内容不存在」的既有显示。封存的行不出现在界面上。
- **`db migration status`**：照常显示计划文件里的限制清单；新增一段决定汇总。

## 4. 耗时

### 4.1 源身份与轻量核对

现在每个读取器把「旧库没变」实现为重算整库内容摘要：SQLite 的预检做 3 次（`sqliteSourceReader.ts:121,125`），
此后每次断言 2 次（`:241-242`）；组合后的句柄每次断言再乘以原库与工作副本两层（`freeze/sourceAccess.ts:639-650`）。
PostgreSQL 的断言是回滚、重开快照事务并把整库重新量一遍（`postgresqlSourceReader.ts:186-213`，调研）。

改为两种证据，各用在该用的地方：

- **内容身份**（整库内容摘要，定义不变，`rawSourceReader.ts:154-185`）：每份数据只算一次。
  冻结副本算一次，作为旧库在这次升级里的身份（水位）；工作副本补完迁移后算一次，作为转换输入的身份。
- **变更标记**：用来回答「自从算过身份之后它变没变」。
  - 旧库文件（SQLite）：数据库文件与 `-wal` 文件各自的大小与修改时间，加数据库文件头里的变更计数。
    冻结之后本程序不再打开旧库文件，这些标记只会被别的程序改变。
  - 操作目录里的私有副本（冻结副本、工作副本、备份）：文件大小与修改时间；它们由本操作创建，只有本操作会写。
  - PostgreSQL 旧库：各表行数与各序列的当前值（一条 `UNION ALL` 查询，既有的 `sourceCatalog.ts:57-86`）。
  - PostgreSQL scratch 库：既有的属主标记表与绑定记录（`freeze/postgresqlDatabases.ts:206-231`）。

断言「没变」时比较变更标记。标记不一致时退回到重算内容身份：身份相同则继续并更新标记，不同才报来源已变（走既有的新建一轮运行）。
所以轻量核对只影响速度，不改变「身份不同就不继续」的结论。

另外三处纯重复一并去掉：读取器对已经是私有副本的输入不再另拷一份（`sqliteSourceReader.ts:122`）；
离线补迁移里丢弃不用的那次预检（`offlineSourceUpgrade.ts:103`）与重复的处置行采集（`:66`）；
写了从不读的 `preflight-<digest>.json`（`sourceAccess.ts:709-720`）。

人工模式同样受益：一次升级的整库摘要次数从 157 降到个位数。

### 4.2 自动模式的单遍编排

自动会话全程持有守护进程锁，守护进程没有运行（`infrastructure/local/epochSwitchQuiesce.ts:56-66` 返回「已停止」），
所以不需要「先在活库上计划、停写后再来一遍」。`EpochSwitchDependencies` 增加 `direct?: boolean`，由自动升级的装配置为真
（`bootstrap/epochMigration.ts` 的 `autoUpgrade` 选项）；人工模式与托管形态不置。

**计划步（`planEpochOperation`，direct）**：

1. 冻结（用冻结模式的源访问，`sourcePort.freeze`，而不是活库快照）：打开旧库一次，取冻结副本，算内容身份，
   记下旧库文件的变更标记；补完 epoch-1 剩余迁移得到工作副本并算其内容身份。沿用既有的缓存目录与绑定文件
   （`sourceAccess.ts:428-600`）。
2. 盘点内容一次（§4.4），采集启动事实一次。
3. 生成前置计划：用 `planConversion` 得到静态的转换计划（表到规则的映射、拓扑、规则集摘要，不读任何行）代替预演结果；
   `restrictions` 为空，`blocks` 只可能含目标库层面的阻塞项，空间估算取 §3.5 的算法，`rehearsalMs` 为空。
4. 落盘并进入 `planned`。自动会话批准它。

**执行步（`runEpochSwitch`，direct）**：

1. `planned`：跳过「活库上再冻结、盘点、备份」这一段（`runner.ts:318-346`）。停写（已停止，立即返回）。
2. 冻结：旧库的变更标记未变时直接重开计划步留下的冻结副本与工作副本，不重新拷贝、不重算摘要；写 `frozen/preflight.json`。
3. 内容清单沿用计划步的那一份（计划文件记有它的路径与摘要，核对摘要后写成 `frozen/content-manifest.json`），不重新盘点。
4. 备份一次（§4.5）；依次保存 `backed-up → quiescing → frozen`，阶段顺序与人工模式相同（三次日志保存连续发生）。
5. 启动事实复核一次：与计划步的环境摘要不同则按既有路径新建一轮运行；相同则写 `frozen/boot-upgrade-facts.json`。
   跳过冻结后的预演与计划复核（`runner.ts:502-530`）。
6. `prepareConversion`（暂存、查找表、发现要结束的任务）；用得到的转换计划建新库并登记运行；转换并装载（自动处置，§3）；写 `summary.json`。
7. 收尾一次、校验一次（`target.validate` 内部不再重复收尾，`targetGeneration.ts:197-202`，改为使用第一次的结果）。
8. 导出回执，用实际结果生成计划文件并保存为 `validated`。有限制清单或自动决定时，它的批准摘要与前置计划不同，
   于是进入 `awaiting-approval`，自动会话评估后批准（既有的再批准路径，`autoUpgrade.ts:221-260`，每轮运行至多一次）；
   没有时批准摘要相同，直接继续。
9. 准备切换、切换、自检，同现在。

中途崩溃的窗口与现在同构：例如备份已建好但 `backed-up` 尚未保存时被杀，重启后仍在 `planned`，执行步重开副本、
读到已有清单、`createBackup` 按既有逻辑认出目录里已有的匹配备份并复用（`freeze/backup.ts:107-122`）。

转换结束仍有阻塞项（内部错误）时走既有的 `v3-conversion-blocked`，自动会话以错误结束。

**中断续做**与现在相同：阶段与工件都在；第 3 步重开副本是常数时间；第 7 步由 sink 的幂等提交跳过已提交的单元。

### 4.3 转换引擎的记账

一次预演的 CPU 剖析（参考数据、不含内容文件，剖析下总计 2069 秒）：整库摘要 1145 秒；转换引擎约 900 秒，
其中规则的转换逻辑 22.5 秒。引擎其余时间的去向与改法：

| 去向 | 剖析耗时 | 位置 | 改法 |
| --- | ---: | --- | --- |
| 单元输出排序时反复序列化 | 257 s | `conversion/receipts.ts:363-377`（比较函数里调 `targetRowJson`）、`:401-408`（`encodeStagedValue`） | 每个元素先算一次排序键，再按键排序；同一个键串供随后的摘要复用 |
| 结束时重读暂存库算表回执 | 112 s | `conversion/engine.ts:455-489` | 行摘要在暂存写入时算一次并存成列，表回执直接对「键、行摘要」两列做有序扫描 |
| 暂存库摘要 | 106 s | `conversion/staging.ts:266-283` | 对「阶段、表、键、行摘要」做有序扫描，不再重读并重新序列化整行 |
| 暂存写入 | 100 s | `conversion/staging.ts:146-152` | 行内容改用紧凑编码存放（不排序、不缩进），同一事务内批量写 |
| 暂存读取 | 65 s + 94 s | `conversion/staging.ts:112-121,160-176` | 紧凑编码的解码 |
| 单元摘要算两遍 | 38 s + 38 s | `conversion/receipts.ts:429`、`infrastructure/epochSwitch/conversionSink.ts:81` | 同进程内由收集器刚产出的单元输出，sink 不再重算；其他来源的输出照常校验 |
| 关闭暂存库 | 37 s | `conversion/staging.ts:284-289` | 暂存库变小后自然消失 |
| 规范化 JSON 本身 | 贯穿上述各项 | `schema/canonical.ts:36-51` | 普通路径也使用按键集合缓存的键序（现在只有片段缓存启用时才用，`:53-65`）；输出逐字节相同 |

约束：**除暂存库摘要外，所有证据摘要的定义不变**——单元回执摘要、来源摘要、键摘要、内容摘要、目标行摘要的取值与现在逐字节相同
（现有 57 个测试文件按这些定义重算并比对）。暂存库摘要是同一轮运行内部的绑定值，定义改为「对行摘要求有序摘要」，
随 `CONVERTER_VERSION` 一起变更。

暂存库体积预计从源库的约 9 倍降到 2 倍以内。

### 4.4 内容盘点

盘点（`platform/content/inventory/manifest.ts:63-158`）遍历 `skills / runs / logs / evidence` 并对每个文件取大小与修改时间
（不读文件内容）。参考数据上单纯遍历 82.8 万个文件约 36 秒（本机负载下实测）；现在一次盘点 215～370 秒，
其余是前后 12 次整库摘要与多遍 168 MB 的序列化。改动：

- 自动模式只盘点一次（在计划步，执行步沿用，§4.2）。
- 盘点前后的来源断言改用变更标记（§4.1）。
- 清单在一次盘点里只做一遍规范化序列化：算摘要与写文件共用同一份文本；校验不再重新序列化。
- 遍历时不再对每个条目先 `existsSync` 再 `statSync`，改用带类型的目录读取，文件只 `stat` 一次。
- 打开清单时为「按目录前缀查找」建一次索引，取代每次树查询对全部条目的线性扫描（`freezeInventory.ts:99-104`）。

清单的内容与摘要定义不变。

### 4.5 备份与工件库

- **备份只做一份。** 自动模式只在冻结后做一份备份（现在是冻结前一份，冻结后核对两次、必要时重做）。
- **SQLite 备份直接取冻结副本。** 现在备份是对读取器的私有冻结副本再做一次 `VACUUM INTO`，然后两边各算一次整库摘要来确认相同
  （`freeze/backup.ts:155-178`）。冻结副本本身就是旧库的一份 `VACUUM INTO` 拷贝，备份改为把它硬链接进备份目录
  （不同文件系统时退回拷贝并比较文件摘要），内容身份沿用冻结时算出的那一个。
- **工件库用硬链接。** 本地工件库现在把每个登记的文件先完整拷一份再算摘要（`infrastructure/epochSwitch/fileJournal.ts:192-203`，
  文件系统支持写时复制时才是廉价的克隆），每次打开会话又把全部工件重算摘要并拷回原位（`:228-240`、
  `application/epochSwitch/session.ts:262-273`）。工件库与工作文件在同一个操作目录下，改为：登记时硬链接进工件库；
  取回时若目标位置已经是同一个 inode，直接返回，不重算、不拷贝。被登记的文件都是只写一次的（绑定文件靠改名原子替换，
  替换后是新的 inode，不影响已登记的版本）。不支持硬链接时退回现有的拷贝路径。
  这样在没有写时复制的文件系统（Linux 上常见的 ext4）上，不再为备份和工作副本各多占一份空间、多拷一遍。
- 备份目录的摘要在创建时算一次，同一进程内随回执传递，不再为核对而重读（现在创建后还要整份重读 4～6 遍，
  `backupAdapter.ts:76-86`、`runner.ts:436,440`）。进程重启后的续做仍按既有逻辑核对一次。

### 4.6 PostgreSQL

- **拷贝到 scratch**（R4①）：每批行数改为 `min(1000, floor(60000 / 列数))`，`tasks`（70 列）每批 857 行。
  批内逐行校验等既有协议不变。
- **核对**：按 §4.1，旧库的内容身份算一次，其后用行数与序列值；scratch 用属主标记与绑定。
- **保留的 RFC-349 归档目录**：整目录摘要与分块校验各做一次并在进程内缓存（现在约 36 次与 7 次，调研）。
- **写新库**：每条语句的行数上限按库类型取（PostgreSQL 取 `floor(30000 / 列数)`，上限 1000 行；SQLite 维持现值）。
  每个单元的元数据写入合并为按表的多行语句。
- **收尾**：外键反连接查询只做一次（§4.2 第 8 步）。

### 4.7 内存与磁盘

- 内容清单：全程只保留一份条目数组与一份序列化文本（写完即释放）；索引按需建。
- 引擎：表回执不再把每张表的全部键与摘要读进内存排序，改由暂存库有序扫描流式求摘要；
  「来源表 → 目标表的去重键集合」改记在暂存库里计数（`engine.ts:381-401`）。
- 暂存库：紧凑编码（§4.3）。
- 自动模式不再有三份冻结副本与两次预演的暂存库同时存在的时刻。

### 4.8 进度输出

`createMigrationProgressReporter` 与父进程的转发、静默提示不变。自动模式的阶段顺序变为
`freeze → offline-upgrade → content-capture → backup → conversion / load → validation → activation`，各出现一次。
新增两类逐条消息：发现阶段报告被结束的任务数；转换结束报告封存与缺失内容的条数。

## 5. 契约变化一览

| 位置 | 变化 |
| --- | --- |
| `conversion/plan.ts` `ConversionInput` | 加 `resolution` |
| `conversion/plan.ts` `ConversionPlanSection` | 自动模式下加 `resolution`、`settlements`（计入计划摘要） |
| `conversion/engine.ts` | 新增 `prepareConversion`；`runConversion` / `executeConversion` 保持 |
| `conversion/sink.ts` `ConversionSummary` | 加 `resolutions` |
| `conversion/sink.ts` `ConversionSink.commitUnit` | 自动模式下可返回被拒的目标行，而不是记为装载阻塞 |
| `conversion/rule.ts` `ConversionContribution` | 加 `settlers` |
| `conversion/rule.ts` `ConversionRule`、`RowValidator` | 加可选声明 `settles` |
| `conversion/rule.ts` `RuleOutput` | 加 `blockExecutable(task, block)` |
| `conversion/rule.ts` `RuleContext` | 加 `resolution`，规则在有保留办法的阻塞点据此分支 |
| `conversion/types.ts` | `MigrationRecord` 的 `decision` 新代码：`v2-task-settled-at-upgrade`、`v2-row-set-aside`、`v2-row-set-aside-dependent`；`CONVERTER_VERSION` 递增 |
| 计划文件（`domain/epochSwitch/documents.ts`） | 加可选字段 `resolutions`，计入批准摘要；旧文件没有该字段仍可解析 |
| 回执 | 加 `resolutions` |
| `EpochSwitchDependencies` | 加 `direct` |
| `packages/shared/src/lifecycle.ts` | 加结束原因 `ended by upgrade` |

新库的表结构与 schema history 不变：封存用既有的 `aw_meta_migration_archives`，决定用既有的 `aw_meta_migration_records`，
处置用既有的 `aw_meta_migration_row_dispositions`。

## 6. 失败模式

| 情形 | 行为 |
| --- | --- |
| 前置检查不通过 | 拒绝，10 秒内退出；无运行工件、无新库 |
| 冻结后、盘点或备份中进程被杀 | 再次启动续做；重开副本为常数时间 |
| 转换中进程被杀 | 续做：重新发现（结果与运行行里登记的转换计划相同）、已提交单元由 sink 跳过 |
| 续做时旧库的变更标记变了 | 重算内容身份；相同则继续，不同则新建一轮运行 |
| 发现与正式转换不一致 | 内部错误；工件保留 |
| 单元装载反复被拒且无法对应到来源行 | 内部错误 |
| 悬空行处理轮数超过外键链深度 | 内部错误 |
| 新库自检失败 | 既有路径：撤回，等待 `--retry` |
| 升级前后用的不是同一个版本的二进制（升到一半换了二进制） | 转换器版本不同，绑定不匹配，既有路径新建一轮运行 |

## 7. 测试策略

实现与全部用例写完后集中验证（仓库硬规则）。必写用例：

**不因数据而停**
- 发现过程：可继续任务带各类不可证明运行（逐个代码）→ 进入结束集合；数据完整的可继续任务不进入；子任务级联；不动点在
  第二轮收敛；传入已有集合时结果相同。
- 各 `settler` 的纯函数用例：每张表的条件与改写，逐列对照取消实现；条件之外的行不变。
- 端到端（发布版升级矩阵 L1 的新种子）：含遗留未结束任务的 v0.19.2 库自动升级成功；这些任务为已取消并带原因；
  其等评审 / 等人工的运行与澄清轮已收尾；未解决告警已解决；等评审的正常任务升级后能批准并走完。
- 封存：无法解析的行、悬空引用、目标约束拒绝、装载拒绝各一例；悬空行处理的多层级联；归档内容与原行逐字节相同；
  报告条目齐全。
- §3.4 每一行一例（保留类断言目标行的标记，封存类断言归档）。
- 人工模式不变：同样的数据在 `resolution` 缺省时产生与现在逐字节相同的阻塞项与计划（既有用例不改即通过）。
- 环境前置：磁盘不足、结构含多余对象、`config.json` 非法，各断言 10 秒内退出、文案、无残留；空间估算对稀疏库按有效数据量。
- 新原因的前端显示与数字员工「视为停止」。

**耗时**
- 单遍顺序：以计数探针断言自动模式下冻结、盘点、备份、转换、收尾各恰好一次，整库摘要恰好两次。
- 轻量核对：标记未变不重算；标记变而内容未变继续；内容变则报来源已变。
- 摘要定义不变：对同一批输入，新旧实现的单元回执摘要、来源摘要、键摘要、内容摘要、目标行摘要逐字节相同（属性测试，随机行）。
- 规范化 JSON 的键序缓存：与原实现逐字节相同（含数字样键、嵌套、`undefined`）。
- PostgreSQL：`tasks` 1000 行、2000 行的拷贝；装载批大小不超过参数上限。
- 中断续做：冻结后、转换中、校验后各杀一次。

**回归守卫**
- 源码文本断言：自动模式的执行步里不出现预演调用；`sqliteSourceReader` 的断言路径里不出现整库摘要调用。
- 既有的 RFC-395 / RFC-398 用例全部保留。

**实测**（集中验证阶段，结果写入 plan 验收清单）
- 参考数据 SQLite 与 PostgreSQL 的自动升级：总耗时、各阶段耗时、峰值内存、工作目录峰值。
- M1 的原始数据（不预处理 37 个任务）升级成功；与 M2 的结果逐表对比，差异只在这 37 个任务及其从属行。
- 参考数据上新旧实现逐表对比。

## 8. 文档

- `docs/release-upgrade-rollback.md`：删去「升级前先处理未结束的旧任务」，改写为自动处置与报告的说明；更新耗时与资源参考表。
- `docs/dev-gotchas.md`：容量按有效数据量估算、PostgreSQL 参数上限两条。
- RFC-395 `migration.md` §4 与 RFC-398 `proposal.md` 加修订指针。

## 9. 设计门处置

（待填）
