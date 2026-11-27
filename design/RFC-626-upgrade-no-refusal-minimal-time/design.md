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
  - `platform/persistence/migration`：源身份与轻量核对、转换引擎的自动处置与记账提速、PostgreSQL 的分批与搬运口径。
  - 模块侧：`task-execution`、`collaboration`、`system-operations` 各自贡献「结束任务时本模块的行怎么变」（§3.2），
    另有若干规则把阻塞改成保留或封存（§3.4）。
  - `task-execution`：任务停止原因（`domain/sourceTermination.ts`）加一种；应用层判断数字员工执行结果的地方
    （`application/digitalEmployeeExecution.ts`）把它与「用户取消」同等对待。前端加对应文案。
- **跨模块合同**：模块只通过既有的 `ConversionContribution`（`platform/persistence/migration/conversion/rule.ts:95-103`）
  向引擎贡献内容，本 RFC 给它加一个 `settlement` 字段（各表的改写，以及「一个任务结束还带上哪些任务」的扩展函数）。
  引擎不引用任何模块，模块之间不互相引用。任务生命周期的策略（哪些状态的子任务随父任务取消、每张表怎么收尾）
  全部写在拥有它的模块里；引擎只做通用的不动点迭代、排序与调用（RFC-294 proposal §6 C4：领域策略不进 platform）。
  引擎里已有的任务词汇（`TASK_FACTS` 的键定义在 `conversion/lookups/keys.ts`、`rowBlock` 从 `task_id` 取任务）是既有形状，
  本 RFC 不增加这类知识，也不在这次清理它。
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
前置：  环境检查（秒级，不通过即退出，不登记这次升级）
计划：  冻结 → 盘点 → 启动事实 → 前置计划（只有静态的表到规则映射，不读行）
批准（自动）
执行：  重开冻结副本（不重拷、不重算摘要）→ 备份 → 启动事实复核
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
规范排序）。它们进入计划摘要，从而进入运行绑定（`ConversionRunBinding.planDigest`）；人工模式不写这两个字段。
（转换器版本随本 RFC 递增，所以两种模式下计划摘要的取值都与升级前不同，见 §4.3。）
`trace --replay` 从运行记录里的转换计划取回它们（`bootstrap/epochMigration.ts:290-303` 已是这样重建请求的）。

`ConversionSummary` 增加 `resolutions`（**转换阶段**做出的全部决定，按种类分组）。人工模式下恒为空。
转换摘要在转换结束时定稿，此后不可改（`engine.ts:490-500` 先 `sink.finish(summary)` 再返回，
`metaStore.ts:702-708` 对同一轮运行的不同摘要报冲突）；收尾阶段的处置晚于它产生，另有去处（§3.3「收尾处置」）。

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
     /**
      * 这一行可能让哪些任务被结束。缺省：行上有文本的 task_id 时取它，tasks 表取 id，否则 undefined。
      * 返回 undefined 表示从行本身判断不了（发现时整行纳入）；返回空数组表示与任何任务无关。
      */
     tasksOf?(row: SourceRow, lookup: LookupResolver): readonly string[] | undefined
   }
   ```

   没有声明 `settles` 的规则或校验器调用 `blockExecutable` 时，收集器抛内部错误（两种模式都抛），
   所以漏声明会被既有用例直接发现。六处发出点所在的规则与校验器都加上声明。
   工作区准备的校验器阻塞的是 `admitted_task_id` 所指的任务，那张表没有 `task_id` 列（`task/validators.ts:12-17`），
   它的 `tasksOf` 显式返回 `admitted_task_id`。
   内容规则的 `tasksOf` 必须与它发阻塞项时用的任务集合是同一个推导：行有所属任务时取它，否则取**使用该资源的全部任务**
   （`platform/content/migration/receipts.ts:59-78` 的 `known` 与 `uses`）。两处改为调用同一个函数，不能各写一份——
   一份缺失的共享内容（例如 `development_object_artifacts` 的对象，行上没有任务，经 `resourceClosure.ts` 关联到若干任务）
   可以同时让多个可继续任务阻塞。
2. 用丢弃输出的收集器把这些规则跑一遍，只跑**与可继续任务有关的行**：按任务分组的规则只取可继续任务的组；
   按块读取的规则保留 `tasksOf` 为 `undefined` 的行，以及 `tasksOf` 里至少有一个可继续任务的行。
3. 收集 `blockExecutable` 指向的任务，加入结束集合；再调用各模块贡献的扩展函数（§3.2.3 的 `expand`），
   把随之结束的任务（父任务结束带来的可取消子任务）加入，直到扩展不再产生新任务。
4. 对结束集合里的任务应用 §3.2.3 的改写，重建来源包含被改写表的查找表（查找表的来源是声明过的，`conversion/lookups.ts:47`），
   回到第 2 步；直到没有新任务加入。每一轮集合严格增大，上界是可继续任务的个数。

引擎在这里只做通用的事：迭代到不动点、对集合排序、调用模块贡献的函数。哪些行与哪些任务有关、哪些任务随之结束、每张表怎么改，
都由模块声明。

规则只在与可继续任务有关的行上**执行**，执行次数与可继续任务的数量成正比。按块读取的规则仍要把它认领的表扫一遍来筛行
（`tasksOf` 拿到解码后的行才能判断），这部分读取与这些表的行数成正比；涉及的是任务、运行、澄清、门操作、工作区准备与内容各表，
不含事件类大表。参考数据上预计 2 轮、数秒。

正式转换时结束集合已固定。若正式转换里仍到达 `blockExecutable`，说明某条规则的 `tasksOf` 漏报了任务，
属于程序缺陷，以内部错误结束（§3.6），不做局部补救；`tasksOf` 与阻塞判定共用同一推导（上面第 1 步）就是为了让这种缺陷无从产生，
并由「一份缺失内容被两个可继续任务引用」的用例看守（§7）。

结束集合写进转换计划（§3.1）。进程中断后续做时 `prepareConversion` 重新发现一遍——同一份冻结数据得到同一个集合、
同一个计划摘要，与运行行里登记的一致；不一致即按既有路径报计划摘要不匹配。`trace --replay` 的请求里带着登记过的集合，
引擎先应用它，再照常做一遍发现并断言没有新增。

#### 3.2.3 结束时改什么

结束任务就是对它做一遍取消事务的写入，再升级。取消在当前实现里写哪些数据已逐条核对
（`task-execution/infrastructure/childTaskLifecycleParticipant.ts:817-929`、
`collaboration/infrastructure/humanGateTerminalSweep.ts:29-92`）；v0.19.2 的取消事务与门清扫写的是同样的列
（已核：`git show v0.19.2:packages/backend/src/modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts` 的 `:746-826`，
同一版本 `modules/collaboration/infrastructure/humanGateTerminalSweep.ts` 的 `:20-88`）。
产品只允许从 `pending / running / awaiting_review / awaiting_human` 取消（`packages/shared/src/lifecycle.ts:360-361`）；
转换器眼里可继续的任务还包括 `interrupted`（`conversion/lookups/keys.ts:45-52`），旧服务停下后留下的任务多半是这个状态，
产品不提供对它的直接取消。升级对它做同一组写入：任务变为已取消，它那些停在中断的运行不在改写范围内、保持原样。
「已取消的任务里有中断态的运行」是产品自己也会产生的状态（中断后只重试其中一个节点、再取消，其余节点的运行仍是中断）。
升级不能去改旧库，所以改写作用在**暂存行的解码值**上：行的原始证据（`canonical` / `raw`，回执里的来源摘要由它们计算）保持旧库原样，
规则读到的 `values` 是改写后的值。

改写与扩展由各模块贡献（`ConversionContribution` 新增的 `settlement` 字段），引擎负责调用：
发现阶段每确定一批任务，就对暂存库里这些任务的行重写一次解码值。

```ts
// conversion/rule.ts
export interface SettlementContribution {
  readonly settlers: readonly TaskSettler[]
  /** 已确定结束的任务还会带上哪些任务（如父任务结束带上可取消的子任务）。由拥有任务生命周期的模块提供。 */
  expand?(input: {
    readonly settled: ReadonlyMap<string, TaskSettlement>
    readonly staged: StagedReader
  }): readonly TaskSettlement[]
}
export interface TaskSettler {
  /** 本 settler 要读的表，及各表里指向任务的列（`tasks` 表是 'id'）；`write: false` 的表只读。 */
  readonly tables: readonly { readonly table: string; readonly taskColumn: string; readonly write?: boolean }[]
  /** 输入是该任务在上述各表里的全部暂存行；返回要改写的行及其新的解码值。 */
  settle(
    rows: ReadonlyMap<string, readonly SourceRow[]>,
    ctx: { readonly settlement: TaskSettlement; readonly planTime: number },
  ): readonly { readonly table: string; readonly key: EncodedKey; readonly values: DecodedSourceRow }[]
}
export interface TaskSettlement {
  readonly taskId: string
  readonly cause: 'unprovable-records' | 'parent-cascade'
  readonly originalStatus: string
  readonly blockCodes: readonly string[]     // 触发它的阻塞项代码，去重排序
  readonly parentTaskId: string | null       // 级联时的父任务
}
```

级联的选择规则（哪些状态的子任务随父任务取消：`pending / running / awaiting_review / awaiting_human`，与
`childTaskLifecycleParticipant.ts:905-911` 相同）写在 task-execution 的 `expand` 里，不进引擎。
一个 settler 一次拿到该任务在各表里的行，因为有的改写要跨表判断（下表第 2b、5 行）。

| # | 表 | 贡献模块 | 条件 | 改写 | 对应的取消行为（已核） |
| --- | --- | --- | --- | --- | --- |
| 1 | `tasks` | task-execution | 该任务 | `status='canceled'`；`finished_at` 取升级时刻；`error_summary`、`error_message` 为结束原因（§3.2.4） | `childTaskLifecycleParticipant.ts:858-884` |
| 2a | `node_runs` | task-execution | 状态为 `pending / running / awaiting_review / awaiting_human` | `status='canceled'`、`finished_at`=升级时刻、`error_message`=结束原因代码 | `:888-898`（取消事务先把这四种状态的运行全部取消，盖的是取消原因代码） |
| 2b | `node_runs` | task-execution（只读 `clarify_rounds`） | 该任务每个 `status='awaiting_human'` 的澄清轮的 `intermediary_node_run_id` 所指的运行，不论它是刚被 2a 取消还是早已取消 | `error_message='task-canceled'` | 门清扫按待答的澄清轮找到中间节点运行并盖上清扫原因，对已取消的运行只覆盖原因（`humanGateTerminalSweep.ts:36-66`、`humanGatePersistenceParticipant.ts:31-51`）；澄清页用它显示封闭原因 |
| 3 | `task_execution_intents` | task-execution | 状态为 `pending / claimed` | `state='canceled'`、`failure_code`=原因代码、`completed_at` 与 `updated_at`=升级时刻 | `taskExecutionIntentTerminalSequence.ts:20-51` |
| 4 | `task_execution_owners` | task-execution | `state='claimed'` | `state='revoked'`、`revision` 加一、`recovery_code='terminal-control-cancel'`、`updated_at`=升级时刻 | `childTaskLifecycleParticipant.ts:821-843` |
| 5 | `task_execution_lineage_operation_records` | task-execution | `record_kind='replay-decision'`、`decision_state='actor-replay-authorized'` 且 `bound_intent_id` 是第 3 行改写的意图之一 | `decision_state='requires-actor'`；`replay_authorization_id`、`authorization_scope_json`、`actor_user_id`、`authorization_source`、`bound_intent_id` 置空；`record_revision` 加一；`updated_at`=升级时刻 | `taskExecutionIntentTerminalSequence.ts:62-98` |
| 6 | `clarify_rounds` | collaboration | `status='awaiting_human'` | `kind='cross'` 的 `status='abandoned'`、`abandoned_at`=升级时刻；其余 `status='canceled'` | `humanGateTerminalSweep.ts:42-58`、`domain/clarifyAnswers.ts:209-219` |
| 7 | `lifecycle_alerts` | system-operations | `resolved_at` 为空 | `resolved_at`=升级时刻 | 取消本身不做这一步（见下） |

第 2b 行要在第 6 行改写澄清轮之前读到原来的 `awaiting_human`：settler 拿到的输入都是该任务改写前的行，
各 settler 的输出最后一起写回，互不影响。

**改写的留痕**。暂存库为每个被改写的行另存一份改写说明：属于哪个任务的结束、改了哪些列、各列改写前的值。
正式转换时，收集器对本单元消费到的每个被改写的行追加一条 `decision` 记录 `v2-task-settled-at-upgrade`，
载荷里写明这一行是谁（来源阶段、表、键）加上这份说明——决定记录本身只存代码与载荷，不存来源行
（`conversion/types.ts:176`、`metaStore.ts:690-698`），所以来源标识必须进载荷。
追溯现在不读决定记录（`application/epochSwitch/trace.ts:103-121`）；新增：普通追溯与回放追溯解释一个来源行时，
都列出它所在单元里来源标识与它相符的改写说明。这样逐行追溯能解释「来源是等人工、新库是已取消」；
报告里按任务汇总的 `settledTasks` 取自转换计划里的结束集合。行的处置种类仍由规则决定
（例如不可证明的运行照旧登记为只读历史），改写说明不占处置位。这一步是引擎的通用行为，不含任何表名或列名。

三点说明：

- **不追加生命周期事件，也不动 `lifecycle_event_revision`。** 取消追加的那条事件有六个消费者
  （已核，`task-execution/application/taskLifecycleConsumers.ts:28-158`）：关闭人工门（上表第 2b、6 行直接完成）；
  子任务名额与执行等待两项是进程内状态，启动时按表重建；工作区清理的催促只在申请了清理时才有，升级不申请，工作区保留
  （与「取消保留工作树」一致）；记忆提炼不处理已取消的任务；最后一项是向事件中心报告这次状态变化——升级**不报告**，
  所以用户配置的事件响应规则不会因为这些任务被结束而触发。修订号不加一，事件流与修订号保持一致，
  任务此后的下一次状态变化照常使用下一个修订号。
- **告警。** 真实的取消不会关掉该任务未解决的卡住告警，于是已取消的任务仍留在任务列表的「需关注」里（已核：
  卡住检查只看四种可取消状态的任务，告警的了结只在这些任务上做，`task-execution/infrastructure/taskRecoveryOperations.ts:433,973-990`）。这是产品既有的缺口，本 RFC 不修它；
  但升级一次结束几十个任务时不应留下一批清不掉的「需关注」，所以结束时顺手解决这些告警。
- **不处理的行**：`doc_versions` 的待定结论、`task_questions`、`task_feedback`、`workgroup_task_state`、
  非运行中的 `workgroup_assignments`——真实的取消同样不动它们（调研），升级保持一致。

#### 3.2.4 原因及其显示

新增一个任务结束原因，定义在任务停止原因的单一事实源 `task-execution/domain/sourceTermination.ts`
（`TaskStopCause` 加一种、`taskStopProjection` 给出下表两列；用户取消、随父任务取消都在这里定义，已核 `:49-76`）。
转换里的 settler 与数字员工的判断都取它，不各写一份字面量：

| 字段 | 值 |
| --- | --- |
| `error_summary` | `ended by upgrade` |
| `error_message` | `ended-by-upgrade` |
| 级联子任务 | 沿用既有的 `canceled by parent task` / `canceled-by-parent-cascade` |

前端 `packages/frontend/src/lib/task-failure.ts` 的原因表（按 `error_summary` 的字面量对应文案，已核 `:35-48`）加入它，
文案：「升级时结束：旧版本的运行记录无法在新版本继续。」
/ "Ended during the upgrade: its records from the previous version cannot be continued."。
任务详情的元信息栏在 `errorSummary` 非空时显示它（已有行为，已核 `routes/tasks.detail.tsx:1223-1238`）。

升级后没有被结束的 `interrupted` 任务不受影响：它们的 `error_summary` 仍是旧服务留下的 `daemon-restart`，
新版本启动时的自动续跑按这个值挑选候选（已核，`packages/shared/src/lifecycle.ts:236-240`、
`task-execution/infrastructure/taskRecoveryOperations.ts:748`），与平常重启之后相同；被结束的任务已是已取消，不在候选里。

数字员工推进工作项时按任务行判断执行结果：已取消且原因是用户取消的视为停止，其余已取消的视为执行失败并可能自动重试该轮
（已核，`task-execution/application/digitalEmployeeExecution.ts:602-632`；它读的是任务行，不依赖取消事件）。
被升级结束的任务多是几个月前的遗留，升级后不应自己重新跑起来，所以新原因与用户取消同等对待：视为停止，不重试。

#### 3.2.5 结束之后还能对它做什么

结束之后它就是一个已取消的任务，之后能做什么完全由产品对已取消任务的既有准入决定，本 RFC 不增不减：

- 任务状态：`canceled` 不能恢复，状态层允许重试（`packages/shared/src/lifecycle.ts:364-369`）。
- 节点与调用关系的条件：例如被父任务级联结束的子任务不能直接重试，要从父任务的调用节点重试；仓库准备节点只接受失败或中断态的重试，
  被取消后不能直接重试（已核，`task-execution/infrastructure/taskRouteOperations.ts:2075-2089,2138-2144,2191-2197`）。
- 只读历史限制：重试请求依赖到被登记为只读历史的运行时被拒绝（`taskRecoveryOperations.ts:1096-1137`）。
  限制按这次请求的依赖集合判定，不是按任务一刀切。

所以不对「被结束的任务能否重试」下统一结论。验证口径是**与先做取消事务的写入再升级等价**：同一份旧库，一份由升级结束某任务，
另一份先按 v0.19.2 取消事务与门清扫的写入把该任务改好再升级（这份种子照 v0.19.2 的源码手写，不从转换器的输出生成），
两边新库里该任务及其从属行的业务列逐表相同，例外有三类，各自单独断言：结束原因两列与各时间列；取消会多出的那条生命周期事件、
它的投递行与 `lifecycle_event_revision`（§3.2.3 说明了升级为什么不写它们）；旧证据里保存来源原貌的那部分
（通用证据的 `canonical` / `raw` 子文档，`conversion/evidence.ts:18-23`）——它们各自忠实于自己的来源，
一边是结束前的原状态，一边是已取消，本来就不该相同。运行证据（`node-run-evidence@2`）的 `sourceValues` 取自规则读到的值
（`task-execution/infrastructure/migration/run/evidence.ts:22-36,60-93`），两边都是已取消，除原因与时间外相同。再加上对具体重试请求的准入对拍（§7），两边其后的行为相同。
proposal §5 A1 按此表述。
自动重跑只有数字员工一处入口，由 §3.2.4 关闭。

与既有契约的关系：

- 逐行处置的契约只允许可继续任务上的只读历史带 `executionUse:'none'` 与唯一原因 `null-envelope-nonce-unselected`
  （`conversion/types.ts:54-71`、`conversion/receipts.ts:163-176`）。结束之后任务不再可继续，这条契约不需要放宽。
- 计划文件里的 `unfinishedTasks`（`planner.ts:330-348`）按改写后的状态统计。
- 限制清单（`restrictions`）照旧由只读历史处置生成，自动接受；被结束的任务另列在 `resolutions.settledTasks`。

### 3.3 封存

自动模式下，收集器（`conversion/receipts.ts`）收到行级阻塞项时不再把该行归为 `blocked`，而是：

- 归为 `archived`；把该行的原始内容（`canonical` 与 `raw`）写成一份归档（`ArchivePayload`，kind `source-journal`、
  format `logical-row@1`，与 `conversion/bootUpgradeFacts.ts:176-186` 的既有做法相同）；
- 写一条处置：`class:'archived'`、`kind:'archived'`、`targets:[]`、`decision` 为原阻塞项的代码与细节
  （`archived` 处置的既有契约要求归档引用与非空决定，已核，`receipts.ts:198-206`）；
- 该行已发出的目标行照旧被丢弃（既有行为，`receipts.ts:366-369`）；
- 追加一条 `decision` 记录 `v2-row-set-aside`，供报告汇总。

既有的组语义不变：按组转换的规则里一行在转换前被阻塞，整组不转换（`engine.ts:338-362`），于是整组被封存。

**目标契约不接受的行**（`v2-target-column / -null / -codec / -check / -document / -unique`，`receipts.ts:105-131`）
能对应到来源行的，按同样方式封存该来源行；对应不到来源行的（规则凭空生成的目标行）属于内部错误。

**装载被目标库拒绝**：sink 现在把整个单元记成 `load-blocked`（`infrastructure/epochSwitch/conversionSink.ts:96-126`）。
自动模式下：

1. sink 回滚该单元（不落任何记录），把这一次尝试里**全部**被拒的目标行返回给引擎：`loader.locate` 逐行试插，
   给出每个被拒行的目标表、目标键、约束名与库返回的消息（`target/loader.ts:138-164`）。
2. 每个目标行至多有一个来源行（规则发出目标行时给出，`conversion/rule.ts:75`）。引擎据此为每个涉及的来源行生成一条
   **装载拒绝决定**：来源的阶段、表、键，加上它在这次尝试里被拒的全部目标（目标表、目标键、约束名、消息），
   目标按（表、键、约束）排序。然后带着这些决定重新收集该单元：这些来源行走上面的行级封存，
   处置的决定代码为 `v3-target-load-rejected`，细节就是这条决定。重新提交。
   被封存的来源行不再有目标行，所以一个来源行只会有一条决定；被拒的目标行没有来源行时为内部错误；
   每次重试决定集合严格增大，上界是单元的来源行数。
3. 调整后的单元输出本身就带着这些处置，随单元在同一个事务里落库——**决定因此是持久的，而且是完整的**。
4. 续做时引擎会重新转换已提交的单元并由 sink 比对摘要（`engine.ts:363-366`、`conversionSink.ts:86-95`）。
   从冻结数据重新转换得到的是未封存的输出，直接比对会报摘要冲突；只知道哪些来源行被封存也不够——一个来源行可以生成多个目标行，
   处置的细节（哪个目标、哪个约束、什么消息）进了单元摘要，重算不出来。所以 sink 打开运行时除了已提交的单元编号，
   还把每个已提交单元里代码为 `v3-target-load-rejected` 的处置细节**原样**交回；引擎在转换该单元之前先把它们作为既定决定应用，
   不重新装载、不重新生成细节，得到与当初提交时逐字节相同的输出。`trace --replay` 没有真实的目标库，它从运行记录里读同一份决定传给引擎。

跨单元的唯一约束冲突（后一个单元的行与前一个单元已写入的行冲突）走同一条路：单元顺序是确定的，被拒的总是后来的那一行。

**悬空行**：封存一行可能让别的表里引用它的行悬空。目标库收尾时本来就逐个外键查悬空行
（`target/finalize.ts:11-47`，两种库通用）。自动模式下，收尾发现悬空行时不判失败，按这处引用**有没有保留办法**处置：

- **有保留办法的引用**：引用方保留，只处理这一处引用——置空，或改指一个固定存在的行。保留办法来自两处，合成一张表：
  - 目标结构里声明为「被引用的行删除时置空」的外键（`platform/persistence/schema/dsl.ts:199-211` 的 `onDelete: 'set null'`；
    新库 119 个外键里有 5 个：任务的属主、用户的创建人、记忆的两个前后任指针、工作组消息的触发消息）。
    结构本身已经说明引用方离开被引用的行仍然成立。这五个都是单列、可空，没有别的约束依赖它们。
  - 模块随转换贡献显式声明的（`ConversionContribution` 加一项）：就是转换时遇到「被引用的行在旧库里不存在」已经在用的那些
    （§3.4 第 11、11b 行：旧任务书的 `reopened_from_mission_id` 置空、协作者的 `added_by` 改指系统用户）。
  转换时的解除引用与收尾时用的是**同一张表**，所以结果不取决于被引用的行是在哪一步掉出去的——
  旧库里本来就没有它，与它在转换中被封存，引用方得到同样的处置。
  改指的目标只能是必需的种子行（`conversion/generic/seedPresence.ts:13` 的清单，现在用到的是系统用户 `__system__`），
  而**必需的种子行不允许被封存**：它在旧库里、ID 也读得出，却因为别的列解不出来或放不进新库而要被封存时，
  升级以错误结束并指出这一行与原因（§3.6）。这与「种子行不在旧库里」（§3.4 第 15 行）是同一类——任何发布版都依赖这一行，
  它带不过去，新库就没法正常工作。所以走到收尾时改指的目标必然在新库里，改指之后这处引用不再悬空。
- **其余引用**：引用方移入归档。它们是从属于被引用行的数据（任务的运行记录、技能的版本），被引用的行不在了，它们没有可以落脚的地方。

处置之后再查一遍，直到没有悬空行；每一轮要么清掉一处引用、要么移走一行，轮数有界。之后照常加外键约束或打开外键检查。

这一步发生在各单元提交之后，不改动已提交的单元回执（改了会破坏上一段的幂等比对）。它有自己的记录，称为**收尾处置**：

- 记录的单位是**一个目标行的一处引用**：目标表与目标键、外键及它指向的表、所做的处置（置空、改指、移入归档）；
  置空与改指的附该列原来的值，移入归档的附归档引用（当时的整行内容，`logical-row@1`）。
  同一个目标行可以有多条：两处引用先后被清掉，或者先清掉一处引用、下一轮又因另一处引用被移入归档
  （例如任务先因属主被封存而清掉属主，随后又因父任务被封存而随之归档）。
  收尾处置不强求来源键：现有的元数据只保存异常处置里的「来源 → 目标」对应，正常转换的行没有
  （`metaStore.ts:586-627`），而很多目标行的键与来源键不同（`node_runs` 生成的 `node_run_inputs` / `node_run_selections`、
  工作流的依赖索引、代理的引用行、任务的旧证据行都是）。只有规则声明为原样保留（`disposition: 'preserved'`，
  目标键即来源键）的表，记录里才附带来源键。
- 存放复用既有的迁移记录表与归档表，记录键为（运行编号，固定的收尾单元编号，目标表、目标键与外键名的摘要），每条写一次、不再改。
  一处引用的「记录 + 改列」或「归档 + 记录 + 删除」在同一个事务里完成；中途被杀后重做是幂等的——处置过的那处引用不再悬空，
  同一键的记录已在则跳过，同一行别的引用照常处置。
- **对账**：校验（`infrastructure/epochSwitch/validation.ts:104-126` 的回执守恒只核对来源计数，不看目标行是否还在）
  增加一项：各业务表的实际行数 = 各已提交单元回执里该表的写入行数之和（单元回执按目标表记行数，`conversion/receipts.ts:390-394`，
  整份回执存在运行记录里）− 该表被移入归档的目标行数（按目标行去重；置空与改指不改变行数）。不相等即校验失败。新库的业务表只由单元写入（建库与收尾不插业务行，已核
  `target/install.ts`、`target/finalize.ts`），迁移元数据表不在对账范围内。
- **两阶段结果在哪里合并**：转换摘要此时已经定稿（§3.1），收尾处置不写回它。收尾步骤（`TargetGenerationHandle.finalize`）
  的返回值增加一项「收尾处置清单」：从目标库里本轮运行的全部收尾记录读出，按（目标表、目标键、外键名）排序，附清单摘要。
  清单由记录导出而不是在内存里累计，所以中途被杀后重做、或在已经做完的库上再调一次，得到的都是同一份。
  执行步把它与转换摘要一起交给实际结果的计划文件（`runner.ts:675-689` 的 `buildEpochPlan`），
  计划文件的 `resolutions` = 转换摘要的 `resolutions` 叠加收尾处置清单；它计入批准摘要，随 `validated` 落盘。
  报告、回执、`db migration status` 都从这份计划文件取（§3.7），不从转换摘要取。
- **单元回执**仍只描述转换阶段（该来源行被转换、写入了哪些目标），不因收尾而改写。
- **追溯**：`trace` 现在对没有登记处置的来源行走快路径——拿来源键去猜目标键，命中一个目标就不再回放规则
  （`application/epochSwitch/trace.ts:123-161`）；只有真正回放才能得到一个来源行的全部目标（`conversion/trace.ts:56-69`）。
  一个运行行除了本体还生成异键的输入行，本体仍在而某个输入行被收尾移走时，快路径看不到那一行。
  所以这是一处**新增行为**：本轮运行有收尾处置、且该来源行所属规则不是原样保留时，`trace` 不走快路径，
  回放得到完整的目标集合，再叠加收尾处置——其中被移走的目标行报告为「已转换，随后因引用的行被封存而移入归档」并给出归档引用。
- 一个来源行生成多个目标行、只移走其中一个时，来源计数不变（它仍是「已转换」），只是它的目标少了一行并有对应的收尾处置。

**旧库里本来就悬空的行**：冻结时的完整性检查现在把「旧库存在外键悬空行」当作失败（`rawSourceReader.ts:161-168`，
离线补迁移之后还会再查一次，`offlineSourceUpgrade.ts:84`），整次升级以来源不可用结束，且没有可执行的处理办法。
自动模式下这一项不再判失败，只记录数量；这些行照常转换，随后由上面的悬空行处理按引用有没有保留办法处置（清掉引用或移入归档）。`quick_check` 不通过仍然是失败（库文件损坏）。

**PostgreSQL 工作副本的业务不变量检查**：把旧库拷到 scratch 之后、补迁移之前，现在会跑一组跨表的业务不变量检查
（`legacy/postgresqlLogicalTarget.ts:694-700` 的 `assertTargetBusinessInvariants`，定义在 `postgresqlLogicalTargetInvariants.ts`，共 15 条），
任何一条不满足就以 `postgresql-target-schema-finalize` 失败，进不到转换。这组检查是为旧版本「搬到 PostgreSQL」的验收写的；
工作副本只是旧库的一份私有拷贝，它该装得下旧库里的任何数据。自动模式下拷贝到 scratch 时不跑这组检查
（人工模式不变）；索引与约束照常安装——旧库本身就在同样的约束下，数据必然满足。
本机参考数据在 SQLite 形态下有 417 行不满足其中的 `committed-event-head`（有聚合头而没有事件），可见这类数据在实际的库里存在。

**PostgreSQL 搬运数据时不检查取值规则**：把旧库的行拷到 scratch 用的是严格的逻辑读取（`offlineSourceUpgrade.ts:189-209`、
`postgresqlSourceReader.ts:248-260`），写入后的回读核对用同一个编码器（`legacy/postgresqlLogicalTarget.ts:357-386`）；
冻结后的备份同样逐行经过它（`postgresqlSourceExport.ts:49-76`），备份读回核对时再编码一遍比对
（`legacy/logicalDatabaseRestore.ts:229-233,283-284`）。逻辑编码除了规定怎么表示一个值，还检查取值规则；
物理列装得下、规则不接受的值会让这三处中的任何一处失败，升级到不了转换——而转换读取对这种行本来是有出路的
（整表改走原值读取并把该行标成编码失败，`conversion/readSource.ts:189-195`，随后按本节的行级封存处理）。

按编码器的各个分支逐一核对（`legacy/logicalDatabaseArtifact.ts:170-222`），结构与发布版一致的 PostgreSQL 库里，
会因取值被拒的只有两种：声明为 JSON 文本的列里不是合法 JSON 的字符串（物理列是普通文本，没有合法性约束）；
实数列里的非数与无穷（PostgreSQL 的 `double precision` 存得下）。其余分支由物理类型与非空约束保证。

自动模式下，这三处**搬运**（拷到 scratch 及其回读、备份导出、备份读回核对）改用「搬运口径」：值的表示方式不变，只放开这两条取值规则——
JSON 文本列按普通文本处理；实数列允许非数与无穷，表示为它们的文本形式。JSON 文本与普通文本的编码本来就相同
（同为 `{type:'text'}`，`:203-216`），所以对规则接受的行，分块、游标、排序、分块摘要与备份文件逐字节不变，
既有的行数覆盖、序列校验与分块回执协议原样适用，不存在「中途换通道」。取值规则留给真正要用这些值的读取去检查（转换读取，以及下一段的三处），
由转换决定这一行保留还是封存。非数与无穷经产品所用的 PostgreSQL 客户端写入再读出，值与服务器端文本都往返一致
（实测，Bun 1.4.3、PostgreSQL 16，`double precision` 与 `real` 各试 `NaN`、`Infinity`、`-Infinity`）。
备份清单增加一个字段记下所用口径；任何读取这份备份的地方（本次升级的核对、此后的恢复）按清单里的口径读，
没有该字段的备份按严格口径读。人工模式不用搬运口径，行为不变。

**转换之前读取来源行的另外三处**（两种库都有）：启动事实采集（`freeze/bootUpgradeEnvironment.ts:46-60` 的 `bootSourceRows`，
读 `runtimes`、`cached_repos`、`scheduled_tasks`、`skills` 及其版本、条目、操作、锁共八张表）、计划文件里的未结束任务统计
（`application/epochSwitch/planner.ts:330-348`，读 `tasks`）、`trace` 定位一行所属的组（`bootstrap/epochMigration.ts:240-258`）。
它们都直接按严格口径读，没有转换读取那样的出路：这些表里只要有一行解不出来（SQLite 的列不强制类型，PostgreSQL 见上），
读取就抛错，升级在转换之前以错误结束——而这一行本来是要在转换时封存的。例如 `runtimes.extra_args_json` 不是合法 JSON，
启动事实采集在进入任何处理之前就失败（`runtime-management/infrastructure/migration/runtimeConfigRule.ts:60`）。

改为三处共用转换读取的那套读法（抽成一个函数：先严格读，编码失败时整表改走原值读取，逐行标出解不出的行）。自动模式下：

- 启动事实采集只对解得出的行计算事实。解不出的行不参与：它在转换时封存（按组转换的规则里它所在的整组封存），用不到它的事实；
  跨行的事实（例如默认运行时的取值）因此只取自会被带进新库的行，与转换结果一致。计划步与执行步用同一读法，环境摘要仍然可比。
- 未结束任务统计跳过解不出的行，并排除结束集合里的任务（它们在新库里已是已取消）；前置计划不含这一项
  （现在需要补迁移的来源在计划阶段本来也是空的，`planner.ts:601`）。
- `trace` 的定位同样跳过解不出的行；被封存的行本身有处置可查，不需要定位到组。

人工模式下这三处保持严格，行为不变。

拷贝之后在 scratch 上补的迁移不会再去解析这些值：v0.19.0 之后的 PostgreSQL 迁移（`db/postgresql-migrations/0001`～`0038`）
对已有的表只加了两处枚举检查（`0004`，`source_kind`）与一个建在新增列上的唯一索引（`0036`，`node_runs.seq`），
没有把文本列当 JSON 读的语句（已核，逐个文件检索）。SQLite 的工作副本与备份都是文件拷贝，不经逻辑编码；
v0.19.2 之后的 SQLite 迁移（`0259`～`0262`）同样只有新表与这个索引（已核）。

没有外键的逻辑引用（例如代理对技能的引用）不在悬空行处理之内：这类引用在产品里本来就允许指向已不存在的对象，
使用时明确报错（调研）。

封存只用于两类情况：数据本身已经不自洽（旧库里就悬空、无法解析、违反旧库自己的约束），或 §3.4 列为封存的已下线功能遗留。
正常使用留下的状态都有保留办法（§3.2、§3.4）。

**升级后的服务必须能启动。** 阻塞项此前顺带保证了一件事：新版本启动时那些「失败即不启动」的步骤
（`bootstrap/daemonLifecycleProgram.ts:24-63` 里策略为 `fail-closed` 的各步）不会遇到没见过的状态。
改成自动处置之后，这个保证要由处置本身给出：结束任务等价于一次取消（§3.2.3），产品对已取消任务的各种状态都处理过；
保留类的每一行都落在目标结构与产品已有的状态上（§3.4 逐行给出依据）；带操作日志的对象在处置时一并了结它的操作记录（§3.4 第 3c 行）。
验证上，发布版升级矩阵为每一类处置各备一份种子，升级后真实启动服务并通过健康检查（§7）。

### 3.4 逐类处置表

下表覆盖调研列出的全部行级、表级阻塞来源。标「已核」的我对着规则与目标结构读过；标「调研」的来自只读调研，
实现时逐项复核（plan T0）。选处置的原则：能照旧版本自己的处理方式带过去的，照它的方式；新库能表示的保留；其余封存。

| # | 阻塞项 | 情形 | 自动处置 |
| --- | --- | --- | --- |
| 1 | `v2-content-required-missing` | 必需内容文件不在磁盘上，所属任务可继续 | 结束该任务（§3.2）。任务不可继续时规则已有路径（已核，`platform/content/migration/receipts.ts:92-123`、`convert.ts:102-117`）：行照常转换，内容引用保留，产物回执登记 `missing`（缺失原因与依据），任务登记限制 |
| 2a | `v2-content-lost-at-freeze` | 盘点时在、读取时不在或已变 | 不阻塞，按缺失处理：引用保留，回执登记 `missing-at-freeze`；属于必需内容时并入第 1 行的路径 |
| 2b | `v2-content-bytes-unprovable` | 磁盘上的内容与登记的大小或摘要不符（文件被人改过），或读取中途变化 | 不阻塞，按「登记的内容已不可得」处理：引用保留，回执登记缺失并写明依据（现有字节与登记不符）；磁盘上的文件不动。不把改过的内容当作登记的那份呈现。属于必需内容时并入第 1 行的路径 |
| 2c | `v2-content-task-unprovable` | 必需内容缺失且找不到所属任务 | 走规则给「没有任务」的既有路径：记录决定，行照常转换（`receipts.ts:92-105`） |
| 2d | `v2-content-catalog-metadata-missing`、`-object-conflict`、`-source-invalid`、`-required-null` | 内容目录条目缺大小与摘要、同一对象登记冲突、目录解码失败 | 封存该行（§3.3） |
| 3a | `v2-boot-skill-main-missing`、`-snapshot-missing`、`-snapshot-hash-conflict`、`-authority-conflict`、`-path-identity`、`-root-conflict`、`-ownership-conflict`、`-tree-invalid`、`-file-path-invalid`、`-content-unavailable`、两个 `-reference-missing` | 技能的目录或版本快照缺失、被改动、与登记不一致 | **保留并隔离**：技能行与各版本行照常转换，`version_state='quarantined'`，内容引用指向实际找到的位置（找不到则指向规范位置，技能行可为空），不生成内容对象，逐行登记 `v2-boot-skill-kept-unavailable`。这与 v0.19.2 启动时对这类技能的处理相同（置为隔离，调研），目标结构已有该状态（已核，`resource-catalog/.../schema.ts:1247-1251`）。新版本每次启动都会重新核对隔离的技能，目录恢复完整即自动恢复可用（调研，`resource-catalog/infrastructure/legacy/skillBootVerify.ts:339-364`）。内容引用只能为空或合法的技能路径引用，否则会让全部代理的保存失败（调研，`agentResourceInventory.ts:84-91`） |
| 3b | `v2-boot-skill-husk-references`、`-reservation-unsettled`、`-orphan-version` | 从未发布成功的空壳技能（没有内容也没有版本）、没有技能行的版本行 | **封存**，沿用规则对空壳技能的既有做法（`skillBootRules.ts:148-186`）。留着它只会永久占住名字且永远通不过核对 |
| 3c | `v2-boot-skill-operation-unsettled`、`-operation-residue` | 旧服务被强行终止时技能的创建、保存、删除、导入停在半途 | 按该操作的恢复方向处置（纯函数，`legacy/skillOpRecovery.ts:48-60`，调研）：尚未落库的创建按 3b 封存，其余按 3a 隔离。**同时必须了结操作记录**：凡被本表处置（隔离或封存）的技能，它的 `skill_operations` 行以 `active=0` 转换，`skill_operation_locks` 行封存。否则新版本启动时的技能操作恢复步骤会因「操作没有对应的技能行」等不一致而拒绝启动（已核：该步骤失败即不启动，`bootstrap/daemonLifecycleProgram.ts:35`；判定见 `resource-catalog/infrastructure/skillCatalogBootAdapter.ts:93-179`）。为此这两张表从通用复制改为技能规则的组成员（按 `skill_id` / `locked_skill_id`），随技能一组处置 |
| 3d | 其余 `v2-boot-skill-*`（采集到的事实与冻结的行自相矛盾）、`v2-skill-*`（只出现在没有本地磁盘的部署形态） | 程序内部不一致，不是数据状态 | 归入 §3.6 |
| 4 | `v2-boot-url-*` | 缓存仓库的地址无法还原（密钥缺失或换过、旧格式地址损坏） | **缓存仓库照常转换**，地址列保持旧库原样并登记 `v2-boot-url-kept-unreadable`（目标列可空，已核，`source-control/.../schema.ts:20-21`）。**任务、挂载、定时任务按地址哈希关联缓存仓库，不再受该仓库地址能否还原影响**——旧版本启动时就是这样关联的（调研），于是任务规则里的这处阻塞不复存在（已核它现在会让整个任务什么都不产出，`task-execution/.../task/rule.ts:106-125`）。同一地址对应多个缓存仓库的分支不可达：地址哈希在旧库与新库都有唯一约束（已核，`epoch1/definitions.ts:7148`）。产品对读不出地址的缓存仓库显示为地址不可用、拒绝刷新（调研） |
| 5 | `v2-boot-schedule-*` | 定时任务的载荷无法解析、字段类型不对、本地路径无法探测 | **保留并停用**：行照常转换，载荷逐字节不变，`enabled=false`、`next_run_at` 置空、`last_error` 写明原因（git 无法探测时沿用旧版本的 `rfc165-local-path-retired: <路径>`），登记 `v2-boot-schedule-kept-disabled-invalid`。目标列允许（载荷是纯文本，调研）。详情页会显示迁移错误与最后错误，手动运行明确失败（调研，`integration/application/scheduledTasks.ts:180-218,882-899`） |
| 6a | `v2-boot-runtime-defaults-unmigrated` | 家目录 `config.json` 里还留着旧的默认值键，而没有运行时条目带着这些值 | **照常转换运行时条目**（含二进制路径的继承），登记 `v2-boot-runtime-defaults-not-carried` 并列入报告；去掉运行时表为空时的表级阻塞。这些键旧版本运行时本来就不读，只在启动时检查（调研）；新版本启动不再做这项检查（已核，`runtime-management/application/runtimeRegistryBoot.ts:14-23`） |
| 6b | `v2-boot-runtime-config-unproven` | `config.json` 读不了或不是合法 JSON | 环境问题，前置检查里报（§3.5）；旧版本遇到这样的文件同样无法启动（调研） |
| 7 | `v2-boot-fusion-source-unproven`、`v2-boot-fused-memory-unproven` | 技能融合所依据的版本行无法解析 | 走规则已有的隔离结果：融合记为来源已隔离、未完成的融合记为失败，已融合的记忆指向隔离标记（`knowledge-evolution/.../fusionProvenanceRule.ts:137-165`、`memory/.../legacyBootMemoryRule.ts:52-60`，调研）。两条规则必须一起改 |
| 8 | `v2-code-history-unfinished`、`-package-blocked` | 已下线的旧代码工作里未完结的条目 | 自动确认归档：自动模式下 `ctx.operatorDecisions` 对每个这样的行返回一条由引擎生成的确认决定（确认人 `automatic-upgrade`、时间取升级时刻、行摘要取当前行），规则照既有的已确认路径归档整表（已核，`archives/codeHistory.ts:92-99,123`、`archives/unfinishedWork.ts:71-110`）。生成的决定并入转换计划的 `operatorDecisions` |
| 9 | `v2-agent-reference-shape`、`-name-unproven` | 代理的技能 / MCP / 插件 / 依赖引用里有无法确认的条目（不是数组、条目形状不对、只写了技能名没写编号） | 保留代理，跳过无法确认的那一条引用，逐条登记（已核：引用是逐条展开成引用行的，`resource-catalog/.../agentsRule.ts:59-125`；悬空的引用本来就照常保留并登记，`:158-170`，引用列没有外键）。整列不是数组时按空列表处理并登记 |
| 10 | `v2-intent-artifact-undecodable`、`v2-bundle-artifact-undecodable` | 应用日志的产物无法解析且不在失败态 | 封存该日志行（§3.3）。规则已把原文写入归档（已核，`resource-catalog/.../bundleAppliesRule.ts:119-125,180-197`）；不照搬失败态「清空产物后保留」的路径，因为非失败态的日志可能被恢复流程当作可继续的应用 |
| 11 | `v2-dangling-reference` | `users.created_by`、`development_missions.reopened_from_mission_id` 指向不存在的记录 | 解除引用：该列置空并登记，沿用既有的解除做法（已核：目标列可空，`identity-access/.../schema.ts:427`、`development-automation/.../schema.ts:1369`；做法见 `conversion/alignment/memories.ts:13-25`） |
| 11b | `v2-dangling-reference` | `task_collaborators.added_by` 指向不存在的用户 | 目标列不可空（已核，`collaboration/.../schema.ts:786`）。协作者行保留，`added_by` 改为系统用户 `__system__` 并登记原值——不能因为「谁加的」查不到就让协作者失去成员资格 |
| 12 | `v2-task-owner-dangling` | 任务属主用户不存在 | 任务保留，属主置空并登记（已核：目标列可空，`task-execution/.../schema.ts:1336`）。属主为空的任务只有资源管理员与协作者可见 |
| 13 | `v2-writer-not-os-active`、`v2-writer-state-missing` | 旧任务书（v0.19.2 里称「旧 Mission」，由数字员工新流程逐步排空；`terminal_at` 为空即未终结）尚未终结 | 新版本的写入状态恒为「新流程已接管」、不再接纳旧任务书，也没有「排空中」这个状态可以带入（已核，`digital-employee/infrastructure/writerCutoverPersistence.ts:23-25`、`development-automation/application/writerCutoverGates.ts:1-4`、`development-automation/application/missionOperationHandlers.ts:199`）。未终结的旧任务书逐条封存，它的从属行经 §3.3 的悬空行处理一并封存（已核：带 `mission_id` 的表都在 development-automation 模块内）；写入状态记录为已接管并列出被封存的任务书。全局状态行缺失时同样按已接管处理并登记。封存后新版本的任务书驱动器找不到它们，不会在升级后继续推进几个月前的旧任务书。参考数据里旧任务书为 0 条 |
| 14 | `v2-family-cutover-not-dispatchable` | 事件族的切换模式不是可分发 | 保留该行，按一次模式切换处理：`epoch` 加一、`changed_at` 取升级时刻、`change_ref` 记升级操作编号，并登记。投递只认「事件的生产代际等于该行的 `epoch`」的事件（已核，`platform/events/committed/deliveryPersistence.ts:80`），所以旧模式下记下的事件升级后不会被补投，新事件照常投递。v0.19.2 的生产代码从不改这个模式（已核：`changeCommittedEventCutover` 只有测试调用），参考数据 4 行全是可分发 |
| 15 | `v2-required-seed-missing` | 系统用户 `__system__` 或全局登录策略行不在旧库里，或者在但带不过去（解不出来、放不进新库） | 不自动处置，归入 §3.6：这两行由迁移写入、任何发布版都依赖它们，缺失或损坏只可能是被人动过，旧版本自己也无法正常工作。带不过去的情形不封存这一行，直接以错误结束（§3.3「悬空行」） |
| 16 | `v2-identity-sequence-invalid`、`v2-source-generation-invalid` | 序列值或代际记录异常 | 封存该行；序列高水位改按最大行号推导（既有的 `max-row` 依据） |
| 17 | `v2-run-sequence`、`v2-lease-reset-without-run`、`v2-clarify-task-facts-missing`、`v2-gate-task-facts-missing`、`v2-orphan-group`、`v2-intent-event-unique`、`v2-source-codec`、`v2-undecided-source-codec`、`v2-host-not-placeholder`、`v2-host-still-referenced`、`v2-workflow-definition-shape`、`v2-host-grant-deletion-blocked` | 违反旧库自身约束、无法解析或被手工改坏的行 | 封存（§3.3） |
| 18 | `v2-task-workspace-preparation-in-flight`（未指向任务）、`v2-task-hosted-workspace-command-in-flight` | 准备操作停在进行中但没有对应任务；托管命令在途 | 前者走规则给「任务不存在」的既有路径（原文归档 + 记录，行照常复制，`task-execution/.../task/validators.ts:17-40`）；后者只在托管形态出现，自动模式按封存处理 |

`v2-operator-decision-stale / -unused` 在自动模式下不会出现（决定由引擎针对当前行生成）。

### 3.5 环境前置检查

现在的自动会话取得锁之后先登记意图、再做各种准备（`autoUpgrade.ts:84-187`），其中 PostgreSQL 的 `provisioning.prepare`
会先写分配文件、再可能建库（`postgresqlProvisioning.ts:200-346`）。本 RFC 在这之前插入一段**只读的前置检查**：
取得锁之后、登记意图之前依次检查，任何一项不通过即以**拒绝**结束（退出码 3），不写会话记录、不创建操作目录、不写分配文件、不建库。
这些检查都与数据量无关。承诺的边界就是这四样：会话锁自己的活动标记文件在取得锁时写下、释放时删除，它所在的目录可能留下
（`infrastructure/local/autoUpgradeSessionLock.ts:35-49,179-188`）；只读打开一个缺 `-wal` / `-shm` 的 WAL 库时 SQLite 会创建它们
（RFC-398 §5 的既有行为）。这两样不在「无新增物」之内。

| 检查 | 做法 | 文案包含 |
| --- | --- | --- |
| 家目录 `config.json` 合法 | 读取并解析 | 文件路径与解析错误 |
| 旧库可打开 | 只读打开并读出目录；PostgreSQL 连通与版本 | 失败的原因 |
| 结构来自发布版 | 只取目录与迁移日志算结构指纹并识别，**不数行**（现在的指纹采集对每张表做精确计数，`sourceCatalog.ts:38-72`，且要等第一次整库摘要与拷贝之后才做）。未知表是否为空用「是否存在一行」判断。这是前置检查专用的轻量结果，不替代冻结时带行数的正式指纹 | 逐条列出多出、缺少、被改动的对象 |
| 磁盘空间 | 按**有效数据量** L 估算：SQLite 取（页数 − 空闲页数）× 页大小，而不是文件大小（现在取文件大小，`freeze/capacity.ts:29-33`）；PostgreSQL 取 `pg_database_size`。所需 = 冻结副本兼备份 1×L + 工作副本 1×L + 暂存 2×L + 新库 1.5×L（与操作目录同一文件系统时）+ 内容清单（每个文件按 250 字节，文件数取 `runs/` 等目录的条目估计）+ 10% 余量；工件库不能用硬链接的文件系统上另加 2×L。现行公式对参考数据给出 151.8 GB（当时可用 153.4 GB，只差 1.6 GB 就会被判为空间不足），实际新增占用峰值约 16 GB | 需要多少、可用多少、在哪个目录 |
| PostgreSQL 能建库 | 只读判断：当前角色是否有建库权限，或是否已通过环境变量给出目标库与 scratch 库（RFC-398 §3.1 的既有约定） | 既有的建库语句文案 |
| 旧版「搬到 PostgreSQL」操作未完成 | 既有判断（`autoUpgrade.ts:147-151`），提前到这里 | 既有文案 |
| 另有人工迁移操作在进行 | 既有判断（`domain/epochSwitch/autoUpgrade.ts:86-95`），本来就在写入之前 | 既有文案 |

前置检查通过之后才登记意图并进入既有流程。此后的 `provisioning.prepare` 仍可能因为 PostgreSQL 上的资源状况拒绝
（例如推导出的库名已被别的东西占用、库属性不一致）；那是既有路径，照旧保留会话记录与分配记录，本 RFC 不改。
完整性检查（`quick_check`）仍在冻结时做一次，耗时随库大小增长，不属于前置检查；不通过即库文件已损坏，以错误结束。

### 3.6 仍会以错误结束的情形

自动模式下，下列情况以**错误**结束（退出码 1，旧库不动，可再次启动续做或重试），不属于「因数据拒绝」：

- 转换器内部不变量被破坏（`ConversionContractError` 中与来源数据无关的那些、发现与正式转换不一致、目标行对应不到来源行）。
- 来源数据违反旧库自身的类型约束到无法建立查找表的程度（任务状态不在枚举内、主键不是文本、主键重复等，调研列出 5 处抛错点）。
  这些状态无法由发布版写出，且数据库自己的约束会拒绝它们；出现即视同库损坏。
- 系统用户 `__system__` 或全局登录策略行不在旧库里，或者在但带不过去（§3.4 第 15 行）。
- 升级过程中采集到的事实与冻结的数据自相矛盾（技能、地址、融合的各种 `*-fact-missing`、`*-source-changed`、
  `frozen-*-mismatch`）：只在采集与转换之间数据或文件被改动时出现，重试即可。
- 环境在升级中途变化（磁盘写满、PostgreSQL 断连、有程序改了旧库）。
- 新库没通过自检：自动撤回，之后启动需 `db migration auto --retry`（proposal §5 B2）。
- 激活回执已经发布之后换上了目标契约不同的二进制（§4.2「换了二进制」）：既有行为，本 RFC 不改。
  还没有切换时，用建新库时的那个版本再启动一次即可完成；已经切换而自检没做完时，按既有规则回滚，之后 `--retry`。

错误信息除原因外附带操作编号与工件目录，便于据此定位。原因必须是读得懂的文字：数据库客户端抛出的错误不是 `Error` 的实例，
现在的包装（`platform/persistence/migration/sourceTypes.ts:145-149`、`infrastructure/epochSwitch/sourceAdapter.ts:27-28`）
对这类值取 `String(error)`，得到 `[object Object]`（proposal §1.1 M5 实测如此）。改为统一用一个取错误文字的函数：
`Error` 取 `message`，带字符串 `message` 属性的对象取该属性，其余才取 `String`；自动升级的结论里同时带上错误代码。

### 3.7 报告与可见性

- **回执**（`database-migrations/auto-upgrade/sessions/<op>/receipt.json`）增加 `resolutions`：

  ```json
  {
    "settledTasks": [{ "taskId": "…", "name": "…", "originalStatus": "interrupted", "cause": "unprovable-records", "blockCodes": ["v2-run-null-nonce"] }],
    "missingContent": [{ "table": "doc_versions", "key": "…", "column": "body_path", "reference": "runs/…/v1.md", "taskId": "…" }],
    "setAside": [
      { "stage": "conversion", "sourceTable": "…", "sourceKey": "…", "code": "v2-dangling-reference" },
      { "stage": "finalize", "targetTable": "…", "targetKey": "…", "foreignKey": "…", "references": "…", "action": "set-aside" },
      { "stage": "finalize", "targetTable": "…", "targetKey": "…", "foreignKey": "…", "references": "…", "action": "detached" }
    ],
    "acknowledged": { "v2-code-history-unfinished": 12 },
    "kept": [{ "table": "scheduled_tasks", "key": "…", "code": "v2-boot-schedule-kept-disabled" }]
  }
  ```

  内容取自实际结果的计划文件（转换阶段的决定叠加收尾处置清单，§3.3）。每类最多列 1000 条，超出给总数并指向新库里的迁移记录表。
- **日志**：升级完成时逐类打印总数，并逐条打印被结束的任务（编号、名称、原状态）；其余类别逐条打印前 50 条。
- **界面**：被结束的任务在任务详情显示原因（§3.2.4）。缺失的内容沿用界面对「内容不存在」的既有显示。封存的行不出现在界面上。
- **`db migration status`**：照常显示计划文件里的限制清单；新增一段决定汇总。

## 4. 耗时

### 4.1 源身份与轻量核对

现在每个读取器把「旧库没变」实现为重算整库内容摘要：SQLite 的预检做 3 次（`sqliteSourceReader.ts:121,125`），
此后每次断言 2 次（`:241-242`）；组合后的句柄每次断言再乘以原库与工作副本两层（`freeze/sourceAccess.ts:639-650`）。
PostgreSQL 的断言是回滚、重开快照事务并把整库重新量一遍（已核，`postgresqlSourceReader.ts:186-213`）。

改为两种证据，各用在该用的地方：

- **内容身份**（整库内容摘要，定义不变，`rawSourceReader.ts:127-160`）：每份数据只算一次。
  冻结副本算一次，作为旧库在这次升级里的身份（水位）；工作副本补完迁移后算一次，作为转换输入的身份。
- **同一进程内的核对**：用来回答「自从算过身份之后它变没变」，不重算摘要。
  - SQLite 旧库：升级进程在冻结时对旧库保持一个只读连接，直到这次升级的进程结束。`PRAGMA data_version` 在别的连接
    （含别的进程）提交过修改之后会变，自己不写就不变；读它与数据量无关。冻结的做法是：取版本号 → `VACUUM INTO` 出冻结副本 →
    再取版本号，前后相同冻结才成立（不同就重来），身份取自冻结副本的摘要——旧库本身不再另算一遍
    （现在是旧库算两遍、副本算一遍，`sqliteSourceReader.ts:121-125`）。此后每次断言只比较版本号；读不出来按来源已变处理。
    实测：WAL 与回滚日志两种模式下，另一个进程提交一次修改并退出之后，持有的连接读到的版本号都变了。
  - 操作目录里的私有副本（冻结副本、工作副本、备份）：凭冻结记录（§4.2）与文件大小认定——它们由本操作创建，只有本操作会写。
  - PostgreSQL 旧库：各表行数与各序列的当前值（一条 `UNION ALL` 查询，既有的 `sourceCatalog.ts:57-86`）。
    它发现不了不改变行数与序列的更新；守护进程停着时没有程序会这样写（proposal §5 B5 已说明这一点）。
  - PostgreSQL scratch 库：既有的属主标记表与绑定记录（`freeze/postgresqlDatabases.ts:206-231`）。
- **进程重启之后**没有那个连接可比，也没有别的办法便宜而可靠地知道旧库在两次启动之间有没有被写过
  （文件大小、文件头、`-wal` 的内容都可能在一次提交被检查点吸收之后恢复原样）。所以续做时两种库都**重算一次旧库的内容身份**，
  与冻结记录里的比较：相同就沿用已有的冻结副本与工作副本，不同则报来源已变（走既有的新建一轮运行）。
  代价是一遍摘要（参考数据 SQLite 约 12 秒、PostgreSQL 约一分多钟），只发生在中断后重启这条路上。

同一进程内的核对不通过时同样退回到重算内容身份：身份相同则继续（并以重算前后一致的那个版本号、行数与序列值作为新的比较基准），
不同才报来源已变。所以它只影响速度，不改变「身份不同就不继续」的结论。

**SQLite 那个连接由谁持有。** 现在源适配器每次打开源都是新建的，句柄关闭时释放它的全部资源
（`bootstrap/epochMigration.ts:367-430`、`freeze/sourceAccess.ts:162,244`），而计划步结束必定关闭源句柄（`planner.ts:608-610`）。
监视旧库的连接不能跟着某一次打开的句柄走——关掉再开的连接，版本号与之前的不可比。所以它由**自动升级会话的装配**持有
（`bootstrap/epochMigrationAuto.ts` 建一个「旧库监视」对象交给源适配器），每次打开的源句柄只是借用：

- 第一次冻结时建立：打开连接，按上面的做法冻结，记下（内容身份、版本号）。
- 同一进程里之后每次打开源（重新计划、执行步）都问它：版本号没变，旧库的身份就是记下的那个；变了，重算身份并更新基准。
- 新建一轮运行不换监视对象（旧库还是那一个）；新一轮在自己的目录里重新冻结，连接沿用。
- 源句柄关闭时不关它；自动会话结束（成功、拒绝、出错都一样）时关闭。

人工模式没有这个对象：`plan` 与 `run` 各自在进程内建立基准、进程内比较，不跨进程比较版本号。`plan` 读的是独立快照，
允许守护进程继续写旧库，`run` 停写之后才冻结（`freeze/sourceAccess.ts:212`、`freeze/liveSnapshot.ts:18`），这一点不变。

另外三处纯重复一并去掉：读取器对已经是私有副本的输入不再另拷一份（`sqliteSourceReader.ts:122`）；
离线补迁移里丢弃不用的那次预检（`offlineSourceUpgrade.ts:103`）与重复的处置行采集（`:66`）；
写了从不读的 `preflight-<digest>.json`（`sourceAccess.ts:709-720`）。

人工模式同样受益：`plan` 与 `run` 是两个进程，各自确认一次身份，进程内用上面的核对，整库摘要次数从 157 降到个位数。

### 4.2 自动模式的单遍编排

自动会话全程持有守护进程锁，守护进程没有运行（`infrastructure/local/epochSwitchQuiesce.ts:56-66` 返回「已停止」），
所以不需要「先在活库上计划、停写后再来一遍」。`EpochSwitchDependencies` 增加 `direct?: boolean`，由自动升级的装配置为真
（`bootstrap/epochMigration.ts` 的 `autoUpgrade` 选项）；人工模式与托管形态不置。

**计划步（`planEpochOperation`，direct）**：

1. 冻结（用冻结模式的源访问，`sourcePort.freeze`，而不是活库快照）：打开旧库一次，取冻结副本，算内容身份，
   并保持对旧库的连接（§4.1）；补完 epoch-1 剩余迁移得到工作副本并算其内容身份。两份副本连同它们的身份写成**冻结记录**（见下）。
2. 盘点内容一次（§4.4），采集启动事实一次。
3. 生成前置计划：用 `planConversion` 得到静态的转换计划（表到规则的映射、拓扑、规则集摘要，不读任何行）代替预演结果；
   `restrictions` 为空，`blocks` 只可能含目标库层面的阻塞项，空间估算取 §3.5 的算法，`rehearsalMs` 为空。
4. 落盘并进入 `planned`。自动会话批准它。

**执行步（`runEpochSwitch`，direct）**：

1. `planned`：跳过「活库上再冻结、盘点、备份」这一段（`runner.ts:318-346`）。停写（已停止，立即返回）。
2. 冻结：同一进程内旧库的版本号未变（§4.1）时直接重开计划步留下的冻结副本与工作副本，不重新拷贝、不重算摘要；写 `frozen/preflight.json`。
3. 内容清单沿用计划步的那一份（计划文件记有它的路径与摘要，核对摘要后写成 `frozen/content-manifest.json`），不重新盘点。
4. 备份一次（§4.5）；依次保存 `backed-up → quiescing → frozen`，阶段顺序与人工模式相同（三次日志保存连续发生）。
5. 启动事实复核一次：与计划步的环境摘要不同则按既有路径新建一轮运行；相同则写 `frozen/boot-upgrade-facts.json`。
   跳过冻结后的预演与计划复核（`runner.ts:502-530`）。
6. `prepareConversion`（暂存、查找表、发现要结束的任务）；用得到的转换计划建新库并登记运行；转换并装载（自动处置，§3）；写 `summary.json`。
7. 收尾一次、校验一次（`target.validate` 内部不再重复收尾，`targetGeneration.ts:197-202`，改为使用第一次的结果）。
8. 导出回执，用实际结果生成计划文件并保存为 `validated`。有限制清单或自动决定时，它的批准摘要与前置计划不同，
   于是进入 `awaiting-approval`，自动会话评估后批准（既有的再批准路径，`autoUpgrade.ts:221-260`，改为幂等，见下）；
   没有时批准摘要相同，直接继续。
9. 准备切换、切换、自检，同现在。

**冻结记录**。现在读取器的冻结副本放在随机命名的临时目录里，源句柄一关闭就删除（`sqliteSourceReader.ts:58,295-306`），
而计划结束总会关闭源句柄（`planner.ts:608-610`）；既有的缓存只登记补完迁移后的工作副本（`sourceAccess.ts:428-600`）。
要让执行步重开而不重做，冻结副本也得持久：

- 位置（SQLite 来源）：`runs/<runId>/source-access/frozen/`，内含冻结副本 `original.sqlite` 与 `freeze.json`。
  `freeze.json` 记：旧库的内容身份与来源代际、结构指纹摘要、冻结副本的大小；
  工作副本仍在既有的 `upgrade/` 目录，由既有的 `binding.json` 登记，`freeze.json` 记下它对应的绑定摘要。
- 发布顺序：冻结副本写完并落盘 → 原子写 `freeze.json` → 生成工作副本 → 原子写 `binding.json`（既有）。
  没有 `freeze.json` 的目录视为未完成，下次进入时清掉重做；有 `freeze.json` 而没有匹配的 `binding.json` 时只重做工作副本。
- 关闭：源句柄关闭时只关它自己对这两份副本的连接，不删副本，也不关旧库的监视连接（§4.1）。
- 重开：`freeze.json` 在、两份副本的大小与记录一致，并且旧库没变——同一进程内看版本号，进程重启之后重算一次内容身份与记录比较
  （§4.1）——就直接在两份副本上打开读取器并采用记录里的身份，不重新拷贝、不重做补迁移。身份不同则报来源已变。
- 清理：本 RFC 不新增自动清理。新一轮运行有新的目录，旧目录按既有做法保留；`db migration complete` 只做保留登记，不删运行目录
  （`application/epochSwitch/completion.ts:99-118`）。备份硬链接的是同一个文件，不多占空间（§4.5）。
- **PostgreSQL 来源**没有文件形态的冻结副本：冻结是来源连接上的一个只读快照事务（`postgresqlSourceReader.ts:142-144`），
  句柄关闭即结束。它的 `freeze.json` 只记内容身份、来源代际、结构指纹摘要、各表行数与各序列值，以及 scratch 的绑定摘要。
  重开时在来源上新开一个只读快照事务：同一进程内比较各表行数与序列值（要数一遍各表的行，不是常数时间），相同就采用记录里的身份；
  进程重启之后重算一次内容身份与记录比较。
  执行步的备份从这个新开的快照导出（备份需要原始来源的行，`freeze/backup.ts:211-217`，这一遍读取本来就要做）；
  scratch 按既有方式凭属主标记与绑定重开（`sourceAccess.ts:489-513`）。
- 经桥接的来源（v0.18.18 / v0.18.19 的 PostgreSQL 基线，`sourceAccess.ts:265-408`）不在复用范围内，
  每次访问照旧重建；它们不享受单遍带来的全部提速，行为与现在相同。

**计划步可重入，执行步一开始就把计划钉住**。自动循环现在只要阶段不晚于 `planned` 就重新计划（`autoUpgrade.ts:215-220`）。
在执行步开始之前这一点保持不变——重新计划时目标库的条件会重新检查（`planner.ts:499-506`），所以先前因为目标库非空之类的原因
被拒绝的会话，在条件修复之后再启动就能继续；计划也总是由当前的二进制生成。

执行步一旦开始就不能再换计划：它在保存 `backed-up` 之前就要写下本轮运行的固定工件（`frozen/preflight.json`、
`frozen/content-manifest.json`、备份目录），这些工件只写一次，同名不同内容即冲突
（`application/epochSwitch/session.ts:386-387`、`infrastructure/epochSwitch/fileJournal.ts:83-89`）；
备份也只在清单摘要相同时才复用（`freeze/backup.ts:115-121`）。若这时被杀、重启后又按新的盘点重新计划，新清单就写不进去。
所以执行步做的第一件事是**钉住计划**：写一个只写一次的运行工件 `runs/<runId>/plan-pinned.json`，内容是已批准计划的摘要与批准摘要。
自动循环看到它就不再重新计划，读回被钉住的那份计划继续执行（读法与现在处理待批准计划相同，`autoUpgrade.ts:221-232`）。
能被钉住的只有已批准、没有阻塞项的计划，所以不会把一份因目标库条件被拒绝的计划钉死。
钉住之后盘点结果随之固定：此后才放回磁盘的文件不被这轮运行认到，与冻结之后的既有语义一致。

钉住之前的重新计划，要避免的只是把贵的步骤重做一遍，所以让计划步在同一轮运行里认得自己已经做完的部分
（重新计划不换运行，目录仍是 `runs/<runId>/`）：

- 冻结：冻结记录在且旧库没变时直接重开（上文），不重新拷贝、不重做补迁移。这是计划步里最贵的一段；
  进程重启之后为确认旧库没变要重算一次内容身份。
- 内容盘点、启动事实、目标库检查、静态计划：每次重做。盘点要把内容目录再遍历一遍（参考数据约半分钟到几分钟），
  只发生在中断后重启这条路上；不沿用上次的清单，是因为两次启动之间磁盘上的文件可能变了（例如把缺失的文件放了回去），
  旧清单证明不了新出现的文件，沿用会把它们当作缺失。同一个进程里从计划步到执行步不重复盘点（执行步第 3 步）。

重新计划每次生成一份新的计划文件（里面有计划时刻与当时的可用空间，`planner.ts:584-606`），各自评估、批准一次——与现在相同；
这个阶段没有次数上限（上限只管转换之后的再批准，见下）。运行要到执行步建好新库时才登记进目标库，那时阶段已晚于 `planned`，计划不再变。

**换了二进制**。计划由当前二进制生成，所以「计划已保存、执行未开始」时换二进制没有问题。执行步开始之后再换则不同：
已批准的计划与目标库里登记的运行都出自旧的二进制，而转换器版本、规则集、目标契约任何一项不同，都不能在旧运行上接着做。
现在这种情况在打开运行时以普通的 `v3-run-binding-mismatch` 抛出，被归为内部错误，会话每次恢复都停在同一处
（`metaStore.ts:268-298`、`domain/epochSwitch/autoUpgrade.ts:157-165`）。这恰恰是「先发的版本升级到一半出错、换上修复版再启动」
会遇到的路径，必须能自己走通。改为：

- 计划文件里的静态转换计划本来就带着候选构建与转换材料（转换器版本、规则集摘要、目标契约摘要；都与数据无关，
  `conversion/plan.ts:302-317`），已批准的计划因此记有生成它的二进制的这几项。
- **比较做在自动循环里，每一轮最先做**：只要本轮运行已经钉住计划、激活回执还没有发布（钉住后的 `planned`、备份、冻结、转换、
  `validated` 这几个阶段），就读日志与钉住的计划工件，拿其中的这几项与当前二进制的比较——当前二进制的这几项由规则与目标结构的
  静态声明算出，不需要来源数据；整个比较只读操作目录里的文件，不打开新库。不一致就直接走新建运行，与收到
  `v3-conversion-material-changed-new-run-required` 相同。
  不能只放在执行步里：转换做完、实际结果的计划等待再批准时（`validated`、状态为待批准，有自动决定的升级都会经过这里），
  自动循环会先调 `status` 取计划的引用，而 `status` 在新库已建好时会按当前目标契约打开它
  （`autoUpgrade.ts:221-222`、`status.ts:31-47`、`targetGeneration.ts:530-533`）；目标契约变了就在这里抛错，到不了执行步，
  也留不下可识别的失败记录，每次启动都停在同一处。
- 执行步恢复时与打开运行时保留同样的比较，作为自动循环之外的入口的保证；不一致即以
  `v3-conversion-material-changed-new-run-required` 结束这一步。
  比较必须先于写激活回执：现在回执用当前二进制的候选构建生成并先落盘，目标端随后才拿它与运行登记的候选构建核对
  （`runner.ts:246-258`、`targetGeneration.ts:233-261`）；不一致时回执已经在了，而有了它就不允许再新建运行
  （`runner.ts:271-276`），会话卡死。
- 激活回执发布之后只剩切换与自检，读回已发布的回执继续（`runner.ts:196-204`），不再做这项比较。
  这时换上的二进制若连**目标契约**也不同，则与现在一样走不下去：打开新库、准备切换、健康检查、自检都按当前二进制的目标契约核对
  （`runner.ts:695-700`、`targetGeneration.ts:213,250-251,312-326,530-533`、`completion.ts:20-25`），而回执已在，不能新建运行。
  本 RFC 不改这一段（归入 §3.6）。这个窗口在正常流程里只有几秒，旧库此时仍然完好，处理办法分两种情况：
  还没有切换（阶段在 `activated` 之前）——用建新库时的那个版本再启动一次，完成切换；
  已经切换、自检没做完——自检出错按既有规则转入回滚（`autoUpgrade.ts:203-212`），用建新库时的版本再启动完成的是这次回滚，
  之后重新升级要执行 `db migration auto --retry`（proposal §5 B2）。
  要让它自己走通，需要按代际登记的契约版本打开已建好的新库，属于另一项工作（plan「后续」）。
- 自动循环把以 `-new-run-required` 结尾的代码归为新建一轮运行（既有规则，`domain/epochSwitch/autoUpgrade.ts:157-163`；
  失败落盘后进程再死，恢复时仍按它走，`application/epochSwitch/autoUpgrade.ts:265-267`），
  于是退掉做到一半的新库、换一个新的目标位置并重新计划（既有的新建运行路径，`runner.ts:270-296`）。
  旧库没有被动过；新一轮有自己的目录，冻结与盘点重做一遍。
- **退掉旧的新库不能依赖当前二进制的目标契约。** 新建运行路径现在先按普通方式打开旧目标再退役，而普通打开要求该代际的
  契约摘要与结构摘要等于当前二进制的（`targetGeneration.ts:520-533`）；目标契约变了就打不开，已有 `target-installed.json`
  时直接重抛（`session.ts:283-301`），到不了退役。退役本身只动迁移元数据表（代际、首次写入标记、切换回执、运行，
  `targetGeneration.ts:331-353`），不碰业务表，所以给目标端口加一个「凭已保存的代际身份退役」：连上日志里登记的位置，
  只核对代际编号与库类型，不比较契约与结构摘要，然后执行同一段退役事务。因转换材料变化而新建运行时走它。
  迁移元数据表属于迁移机制本身，此后改动它时须保证这段事务对旧代际仍可用（§7 有对应用例）。
- 其余原因的绑定不一致（同一二进制下数据或计划对不上）仍是内部错误，不走这条路。

**再批准的幂等**。自动循环现在每次评估待批准的计划都落一条评估记录，并按「本轮运行里再批准评估的条数 ≥ 3」拒绝
（`autoUpgrade.ts:236-244`）。若进程在「评估已落盘、批准尚未写进日志」之间被杀，恢复后会对同一份计划再评估一次；
反复三次就会以 `approval-retry-limit` 拒绝——而计划并没有变。改为：同一轮运行里同一个批准摘要只评估、批准一次
（已有记录时直接复用），次数上限只统计**不同**的批准摘要。

中途崩溃的各个窗口：

| 被杀的位置 | 重启后 |
| --- | --- |
| 冻结副本已写完、`freeze.json` 未发布 | 清掉残留，重新冻结 |
| 冻结记录已发布、工作副本或 `binding.json` 未完成 | 复用冻结副本，重做工作副本 |
| 盘点做到一半 | 重新计划：冻结副本复用（重启后先重算一次旧库身份），重新盘点 |
| 计划已保存、尚未钉住 | 重新计划：冻结沿用，盘点、启动事实、目标库检查与静态计划重做，新计划评估、批准一次 |
| 计划已钉住、固定工件或备份写到一半、`backed-up` 未保存 | 仍在 `planned`，但不重新计划：读回钉住的计划继续执行步；已写的固定工件内容相同，`createBackup` 认出目录里已有的匹配备份并复用（`freeze/backup.ts:107-122`） |
| 计划钉住之后、激活回执发布之前换了二进制 | 候选构建或转换材料不一致，新建一轮运行（旧的新库凭代际身份退役），从计划步重做 |
| 激活回执发布之后换了二进制 | 目标契约相同：沿用已发布的回执继续切换与自检。目标契约不同：与现在相同，以错误结束（§3.6）；尚未切换时用建新库时的版本再启动完成切换，已切换而自检未完成时按既有规则回滚，之后 `--retry` |
| 转换中 | 重新发现（结果与登记的转换计划相同），已提交单元由 sink 跳过，其中带装载封存的单元按 §3.3 复现 |
| 收尾处置做到一半 | 重做，已移走的行与已有的记录跳过 |
| 实际结果的计划已保存、评估或批准记录未写全 | 复用已有的评估与批准记录，不消耗次数 |


转换结束仍有阻塞项（内部错误）时走既有的 `v3-conversion-blocked`，自动会话以错误结束。

**中断续做**与现在相同：阶段与工件都在。同一进程里从计划步到执行步，第 2 步重开副本不重拷、不重算摘要
（SQLite 比较版本号，与数据量无关；PostgreSQL 要重新数一遍各表行数并读序列值，`sourceCatalog.ts:65-84`，随行数增长但远小于重算摘要）。
进程重启之后的续做先重算一次旧库的内容身份（§4.1），副本本身仍不重拷、不重做补迁移。第 6 步由 sink 的幂等提交跳过已提交的单元。

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

约束与验收口径：

- **摘要的算法不变。** 单元回执摘要、来源摘要、键摘要、内容摘要、目标行摘要、查找表摘要的定义不改；
  对同一份绑定与同一份输出，新旧实现算出的值逐字节相同（属性测试对拍；现有 57 个测试文件也按这些定义重算并比对）。
- **取值会随版本变。** 自动处置改变了转换语义，`CONVERTER_VERSION` 递增；它进入计划摘要，计划摘要进入单元编号，
  单元回执摘要又包含单元编号（`conversion/plan.ts:309`、`engine.ts:363`、`receipts.ts:429`）。所以升级前后同一份数据的这些值不同，
  这是预期的，不是回归。
- **暂存库摘要改定义**：对「阶段、表、键、行摘要」求有序摘要。它只是同一轮运行内部的绑定值。
- **存放与证据分开。** 紧凑编码只用于暂存行的存放；单元输出与查找表摘要用到的 `encodeStagedValue`（规范编码）不动。
- **排序定义逐项保持。** 键摘要现在是把键放进数组按 JavaScript 字符串默认顺序（UTF-16 码元）排序后求摘要
  （`conversion/digest.ts:23-25`），与暂存库的 `COLLATE BINARY`（UTF-8 字节序）在增补平面字符上不同。
  所以键摘要仍在内存里按原定义排序，只是数据源改成暂存库的键列，不再解码整行；
  内容摘要按行摘要排序，行摘要是十六进制文本，两种顺序一致，可以让暂存库排好序流式读出。

暂存库体积预计从源库的约 9 倍降到 2 倍以内。

### 4.4 内容盘点

盘点（`platform/content/inventory/manifest.ts:63-158`）遍历 `skills / runs / logs / evidence` 并对每个文件取大小与修改时间
（不读文件内容）。参考数据上单纯遍历 82.8 万个文件约 36 秒（本机负载下实测）；现在一次盘点 215～370 秒，
其余是前后 12 次整库摘要与多遍 168 MB 的序列化。改动：

- 自动模式只盘点一次（在计划步，执行步沿用，§4.2）。
- 盘点前后的来源断言改用同一进程内的核对（§4.1）。
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
  目录取回时现在会把每个文件的修改时间重设为清单里记录的值（`freeze/artifacts.ts:99-105`）；硬链接之后工作文件与工件是同一个 inode，
  目标已是同一个 inode 时跳过这一步。核对不依赖修改时间（§4.1），这一步即使发生也不会触发重算摘要。
  这样在没有写时复制的文件系统（Linux 上常见的 ext4）上，不再为备份和工作副本各多占一份空间、多拷一遍。
- 备份目录的摘要在创建时算一次，同一进程内随回执传递，不再为核对而重读（现在创建后还要整份重读 4～6 遍，
  `backupAdapter.ts:76-86`、`runner.ts:436,440`）。进程重启后的续做仍按既有逻辑核对一次。

### 4.6 PostgreSQL

- **拷贝到 scratch**（R4①）：每批行数改为 `min(1000, floor(60000 / 列数))`，`tasks`（70 列）每批 857 行。
  批内逐行校验等既有协议不变。自动模式下不跑业务不变量检查（§3.3）。
- **核对**：按 §4.1，旧库的内容身份算一次，其后用行数与序列值；scratch 用属主标记与绑定。
- **保留的 RFC-349 归档目录**：整目录摘要与分块校验各做一次并在进程内缓存（现在约 36 次与 7 次，调研）。
- **写新库**：每条语句的行数上限按库类型取（PostgreSQL 取 `floor(30000 / 列数)`，上限 1000 行；SQLite 维持现值）。
  每个单元的元数据写入合并为按表的多行语句。
- **收尾**：外键反连接查询只做一次（§4.2 执行步第 7 步）。

### 4.7 内存与磁盘

- 内容清单：全程只保留一份条目数组与一份序列化文本（写完即释放）；索引按需建。
- 引擎：表回执不再解码整行，内容摘要由暂存库按行摘要有序读出流式计算，键摘要只把键列读进内存排序（§4.3）；
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
| `conversion/sink.ts` `ConversionSummary` | 加 `resolutions`（只含转换阶段的决定；定稿后不可改） |
| `conversion/sink.ts` `ConversionSink.commitUnit` | 自动模式下可返回被拒的目标行，而不是记为装载阻塞 |
| `conversion/sink.ts` `ConversionSink.open` | 除已提交的单元编号外，原样返回各已提交单元里的装载拒绝决定（来源的阶段、表、键，与被拒目标的表、键、约束、消息） |
| 目标库收尾（`TargetGenerationHandle.finalize`） | 自动模式下处理悬空行并写收尾处置（一个目标行的一处引用一条）；返回值增加由收尾记录导出的处置清单与其摘要；校验增加目标行数对账一项 |
| 源访问（`freeze/sourceAccess.ts`） | 新增持久的冻结记录 `runs/<runId>/source-access/frozen/freeze.json`（SQLite 另有冻结副本 `original.sqlite`；PostgreSQL 只有记录，重开时新开快照事务，同一进程内比较行数与序列值，进程重启后重算身份） |
| PostgreSQL 的搬运（`offlineSourceUpgrade.ts`、`legacy/postgresqlLogicalTarget.ts`、`postgresqlSourceExport.ts`、备份的读回核对） | 自动模式下 scratch 拷贝不跑业务不变量检查；拷贝、备份导出与读回核对用搬运口径（不检查 JSON 文本的合法性与实数是否有限）；备份清单加一个记录口径的可选字段 |
| 自动会话（`application/epochSwitch/autoUpgrade.ts`） | 前置检查在登记意图之前，失败不写记录；评估与批准记录按「运行 + 批准摘要」复用 |
| 计划步（`application/epochSwitch/planner.ts`，自动模式） | 同一轮运行里可重入：冻结记录在且相符时沿用；盘点等其余步骤重做 |
| 执行步与自动循环 | 执行步开始时写只写一次的 `runs/<runId>/plan-pinned.json`；有它时自动循环不再重新计划，读回钉住的计划 |
| SQLite 源读取器（`sqliteSourceReader.ts`） | 冻结后保持对旧库的只读连接，用 `PRAGMA data_version` 做同一进程内的核对；进程重启后续做时重算一次内容身份 |
| 自动循环（`application/epochSwitch/autoUpgrade.ts`） | 已钉住计划、激活回执未发布时，每轮先比较钉住的计划里的候选构建与转换材料和当前二进制的，在读取待批准计划与打开新库之前；不一致走新建运行 |
| 执行步（`application/epochSwitch/runner.ts`）与打开运行（`infrastructure/epochSwitch/metaStore.ts`） | 同样的比较作为第二道，不一致以 `v3-conversion-material-changed-new-run-required` 结束；比较先于写激活回执 |
| 自动升级的装配（`bootstrap/epochMigrationAuto.ts`） | 持有 SQLite 旧库的监视连接，源句柄借用，会话结束时关闭 |
| 目标端口（`infrastructure/epochSwitch/targetGeneration.ts`） | 加「凭已保存的代际身份退役」，不经当前目标契约的校验 |
| 来源行的读取（`freeze/bootUpgradeEnvironment.ts`、`application/epochSwitch/planner.ts`、`bootstrap/epochMigration.ts`） | 与转换读取共用一个读法（严格读，失败时整表走原值并标出解不出的行）；自动模式下跳过解不出的行 |
| `conversion/rule.ts` `ConversionContribution` | 加 `settlement`（`settlers` 与 `expand`）；加引用的保留办法声明（置空或改指），转换时的解除引用与收尾共用 |
| `conversion/rule.ts` `ConversionRule`、`RowValidator` | 加可选声明 `settles`（`tasksOf`） |
| `conversion/rule.ts` `RuleOutput` | 加 `blockExecutable(task, block)` |
| `conversion/rule.ts` `RuleContext` | 加 `resolution`，规则在有保留办法的阻塞点据此分支 |
| `conversion/types.ts` | `MigrationRecord` 的 `decision` 新代码：`v2-task-settled-at-upgrade`、`v2-row-set-aside`，以及 §3.4 各行登记的保留类代码；收尾处置另用自己的记录种类；`CONVERTER_VERSION` 递增 |
| 计划文件（`domain/epochSwitch/documents.ts`） | 加可选字段 `resolutions`（转换阶段的决定叠加收尾处置清单），计入批准摘要；旧文件没有该字段仍可解析 |
| 回执 | 加 `resolutions`（取自实际结果的计划文件） |
| `EpochSwitchDependencies` | 加 `direct` |
| `task-execution/domain/sourceTermination.ts` | `TaskStopCause` 加「升级时结束」，投影为 `ended-by-upgrade` / `ended by upgrade` |

新库的表结构与 schema history 不变：封存用既有的 `aw_meta_migration_archives`，决定用既有的 `aw_meta_migration_records`，
处置用既有的 `aw_meta_migration_row_dispositions`。

## 6. 失败模式

| 情形 | 行为 |
| --- | --- |
| 前置检查不通过 | 拒绝；不写会话记录、不创建操作目录、不写分配文件、不建库 |
| 前置检查通过后 PostgreSQL 的库准备被拒 | 既有路径：拒绝，保留会话记录与分配记录 |
| 冻结后、盘点或备份中进程被杀 | 再次启动续做；冻结副本不重拷、不重算摘要 |
| 转换中进程被杀 | 续做：重新发现（结果与运行行里登记的转换计划相同）、已提交单元由 sink 跳过 |
| 同一进程内旧库的核对不通过 | 重算内容身份；相同则继续，不同则新建一轮运行 |
| 进程重启后续做 | 重算一次旧库的内容身份与冻结记录比较；相同则沿用冻结副本与工作副本，不同则新建一轮运行 |
| 发现与正式转换不一致 | 内部错误；工件保留 |
| 单元装载被拒且被拒的目标行对应不到来源行 | 内部错误 |
| 带装载封存的单元已提交、确认返回前被杀 | 续做时按运行记录里的装载拒绝决定原样复现同一输出，sink 比对通过 |
| PostgreSQL 旧库里有取值规则不接受的值（文本列里的非法 JSON、实数列里的非数） | 拷贝与备份按搬运口径通过，升级继续；这些行在转换时封存 |
| 计划已保存、尚未钉住时进程被杀 | 重新计划（冻结沿用，盘点与启动事实重做）；目标库条件重新检查 |
| 计划已钉住、`backed-up` 未保存时进程被杀 | 不重新计划，读回钉住的计划继续执行步 |
| 先前因目标库条件被拒绝，修复后再启动 | 重新计划时条件重新检查，通过后继续 |
| 悬空行处理某一轮没有任何进展而仍有悬空行 | 内部错误 |
| 收尾处置之后目标行数对不上账 | 校验失败，既有路径 |
| 新库自检失败 | 既有路径：撤回，等待 `--retry` |
| 升到一半换了二进制 | 计划钉住之前：重新计划即可。之后、激活回执发布之前：自动循环在打开新库之前比较出不一致，新建一轮运行，旧的新库凭代际身份退役（§4.2）。激活回执发布之后：目标契约相同则沿用回执继续，不同则以错误结束（§3.6） |
| 启动事实要读的表里有解不出的行 | 自动模式下采集跳过该行，升级继续；该行在转换时封存 |

## 7. 测试策略

实现与全部用例写完后集中验证（仓库硬规则）。必写用例：

**结束任务**
- 发现过程：可继续任务带各类不可证明运行（逐个代码）→ 进入结束集合；数据完整的可继续任务不进入；不动点在第二轮收敛；
  传入已有集合时结果相同。
- **共享内容**：一份缺失的必需内容没有所属任务、经资源关联被两个可继续任务引用 → 两个任务都结束，正式转换不到达
  `blockExecutable`。另加一条断言：内容规则的 `tasksOf` 与发阻塞项用的是同一个函数（源码文本断言）。
- 没有声明 `settles` 的规则调用 `blockExecutable` → 两种模式都抛内部错误。
- 级联：`expand` 由 task-execution 贡献；四种可取消状态的子任务被带上，`interrupted` 等其它状态的不带；多层父子。
- 各 settler 的纯函数用例：每张表的条件与改写逐列对照取消实现；条件之外的行不变。其中 `node_runs`：
  四种状态取消并盖结束原因代码；待答澄清轮的中间节点运行盖 `task-canceled`，含它早已取消的情形。
- **与先做取消事务的写入再升级等价**（§3.2.5）：对每种结束情形（运行记录不可证明、只因工作区准备在途、只因门的打开操作在途、
  必需内容缺失、随父任务级联的子任务）与每种原状态（四种可取消状态与 `interrupted`）各备两份旧库——一份原样，
  一份先按 v0.19.2 取消事务与门清扫的写入改好（照源码手写）——分别升级，断言新库里该任务及其从属行的业务列逐表相同；
  三类例外单独断言：结束原因两列与各时间列取各自的值；升级那一份没有新增生命周期事件与投递行、`lifecycle_event_revision` 不变；
  通用证据的 `canonical` / `raw` 子文档各自与自己的来源行逐字节一致，运行证据的 `sourceValues` 两边除原因与时间外相同。
  另各做一次重试请求，断言两边的准入结果相同
  （含级联子任务须从父任务的调用节点重试、仓库准备节点被取消后不能直接重试）。数字员工不自动重跑任何一种；
  事件中心没有新增这些任务的状态变化观测。
- 端到端（发布版升级矩阵 L1 的新种子）：含遗留未结束任务的 v0.19.2 库自动升级成功；这些任务为已取消并带原因；
  其等评审 / 等人工的运行与澄清轮已收尾；未解决告警已解决；等评审的正常任务升级后能批准并走完。

**封存与保留**
- 行级封存：无法解析的行、悬空引用、目标契约拒绝各一例；归档内容与原行逐字节相同；报告条目齐全。
- 装载拒绝：被拒行封存后单元提交成功；**提交后、确认返回前杀进程**，续做得到相同的单元摘要且不报冲突；
  一个来源行生成的多个目标行里只有一个被拒；跨单元唯一冲突；被拒目标行对应不到来源行 → 内部错误；`trace --replay` 复现同一输出。
- 收尾处置：有保留办法的引用各一例（结构声明置空的、模块声明置空的、模块声明改指的）引用方保留，其余引用方移入归档；
  系统用户行的非键列解不出来 → 升级以错误结束并指出这一行，不会出现先登记改指、下一轮仍悬空；
  同一份声明在转换时与收尾时结果一致（被引用的旧任务书在旧库里不存在、与它在转换中被封存，引用它的任务书得到同样的置空）；
  同一个目标行两处引用先后被清掉；先清掉一处引用、下一轮又被移入归档；两层以上的外键级联；
  一个来源行生成多个目标行、只移走其中一个；被移走的目标行与来源不同键
  （`node_run_inputs` 引用的上游运行被封存）；目标行数对账通过，人为制造差一行则校验失败；
  做到一半杀进程后重做结果相同、收尾处置清单与其摘要相同；实际结果的计划文件、回执与 `status` 里都列出收尾处置，
  而转换摘要不变；`trace` 对「本体仍在、一个异键输入行被移走」的运行行给出完整的目标集合与那一行的归档引用。
- 旧库自带外键悬空行的 SQLite 库：自动模式冻结不失败，这些行最终在归档里；人工模式仍在冻结时失败。
- PostgreSQL 工作副本：旧库数据不满足某条业务不变量（有聚合头而没有事件）→ 自动模式拷贝到 scratch 成功并完成升级；
  人工模式仍失败。
- PostgreSQL 搬运口径：文本列里有一行不是合法 JSON、实数列里有一行是非数（坏行分别放在表的第一块与第二块之后）→
  拷到 scratch 成功、备份生成并读回核对通过、这两行在转换时封存、其余行正常转换；备份清单记有口径，按清单能再次读回；
  不含这类行的库，分块摘要与备份文件和严格口径逐字节相同；人工模式遇到同样的行仍失败。
- §3.4 每一行一例（保留类断言目标行的标记与登记的决定，封存类断言归档）。技能另加：隔离后启动服务通过技能操作恢复步骤；
  放回目录后重启恢复可用；`skill_operations` / `skill_operation_locks` 只由技能规则认领。
- 升级后可启动：发布版升级矩阵为结束任务、隔离技能（含操作停在半途）、封存、停用定时任务、地址读不出的缓存仓库各备一份种子，
  升级后真实启动服务、通过健康检查，并各做一个代表性操作（打开被结束的任务、用引用了隔离技能的代理发起任务得到明确报错等）。
- 人工模式语义不变：同一转换器版本下，`resolution` 缺省与不带自动处置时的阻塞项、处置与计划内容相同；
  既有用例除转换器版本带来的摘要取值变化外不改即通过。
- 新原因的前端显示与数字员工「视为停止」。

**环境前置**
- 磁盘不足、结构含多余对象、`config.json` 非法、PostgreSQL 无建库权限且未给出库：各断言被拒绝、文案含具体数值或对象，
  且家目录里没有新增的会话记录、操作目录、分配文件，PostgreSQL 上没有新建的库。
- 结构检查不数行：对查询做计数探针，断言没有全表计数；空间估算对稀疏库按有效数据量。
- 前置检查通过后库准备被拒：仍走既有路径并保留记录。

**耗时与编排**
- 单遍顺序：以计数探针断言自动模式下冻结、盘点、备份、转换、收尾各恰好一次，整库摘要恰好两次。
- 同一进程内的核对：没人写过旧库时不重算摘要，计划步关闭源句柄之后执行步仍用同一个监视连接；本程序自己的读取与工件取回不触发重算；
  会话以成功、拒绝、出错结束时监视连接都被关闭。SQLite：另一个进程在冻结之后提交一次修改
  （WAL 与回滚日志两种模式各一例，其中 WAL 一例让那次提交被检查点吸收、`-wal` 回到原样）→ 被发现，报来源已变；
  冻结过程中有提交 → 冻结重来。
- 进程重启后的续做：旧库没变 → 重算一次身份后沿用冻结副本；两次启动之间有人改过旧库（同样含「提交后被检查点吸收」的一例）→ 报来源已变并新建一轮运行。
- 冻结记录与续做：§4.2 表里的每个窗口各一例，SQLite 与 PostgreSQL 各跑一遍。「计划已保存、尚未钉住」：不重新拷贝、不重做补迁移，
  旧库身份重算恰好一次，两次启动之间放回去的缺失文件被重新盘点认到。「计划已钉住、冻结清单已写、`backed-up` 未保存」：
  重启前放回一个缺失文件，重启后不重新计划、不报只写一次冲突、升级完成，该文件仍记为缺失。
- 先因目标库非空被拒绝，清空后再启动能继续（重新计划时条件重新检查）。
- 换二进制：在「计划已保存、尚未钉住」「计划已钉住、未建运行」「转换中」「`validated`、实际结果的计划待批准」
  「`validated` 已批准、激活回执未写」五个位置换构建，分别断言：重新计划后继续；其余四个位置新建一轮运行
  （待批准那个位置在打开新库之前就比较出不一致，没有留下激活回执）——最终都完成。
  换的构建各试三种差别：只有候选构建不同、转换器版本不同、**目标契约不同**（旧的新库必须能凭代际身份退役）。
  「激活回执已发布、尚未切换」：换成目标契约相同的构建能沿用回执完成；换成目标契约不同的构建以错误结束、旧库不动，换回原版本后完成切换。
  「已切换、自检未完成」换成目标契约不同的构建：按既有规则回滚。
  同一二进制下的绑定不一致仍是内部错误。另加一例：上一版转换器建的代际能被当前代码退役。
- 启动事实的读取：`runtimes` 里一行 `extra_args_json` 不是合法 JSON、另一行 `temperature` 为非数（PostgreSQL），
  SQLite 里一行的整数列存了文本——自动模式下采集不失败，这些行在转换时封存，其余运行时照常带过去；
  计划步与执行步的环境摘要一致；`tasks` 里有解不出的行时未结束任务统计不失败；人工模式下采集仍失败。
- 再批准幂等：「评估已落盘、批准未落盘」「批准已落盘、日志未批准」各杀三次以上，仍能完成且不触发次数上限；
  计划确实变化三次以上时仍按上限拒绝。
- 摘要算法不变：对同一批绑定与输出，新旧实现的单元回执摘要、来源摘要、键摘要、内容摘要、目标行摘要、查找表摘要逐字节相同
  （属性测试，随机行，含增补平面字符的键）。
- 规范化 JSON 的键序缓存：与原实现逐字节相同（含数字样键、嵌套、`undefined`）。
- 工件库：硬链接登记；目标已是同一 inode 时取回不重算、不拷贝、不改时间；跨文件系统时退回拷贝。
- PostgreSQL：`tasks` 1000 行、2000 行的拷贝；各多行写入点的批大小不超过参数上限。

**回归守卫**
- 源码文本断言：自动模式的执行步里不出现预演调用。整库摘要的次数由上面的计数探针看守：正常路径恰好两次，
  核对不通过的回退与进程重启后的续做各多一次。
- 既有的 RFC-395 / RFC-398 用例全部保留。

**实测**（集中验证阶段，结果写入 plan 验收清单）
- 参考数据 SQLite 与 PostgreSQL 的自动升级：总耗时、各阶段耗时、峰值内存、新增磁盘占用的峰值与留存。
- M1 的原始数据（不预处理 37 个任务）升级成功；与 M2 的结果逐表对比，差异只在这 37 个任务及其从属行。
- 参考数据上新旧实现逐表对比。

## 8. 文档

- `docs/release-upgrade-rollback.md`：删去「升级前先处理未结束的旧任务」，改写为自动处置与报告的说明；更新耗时与资源参考表。
- `docs/dev-gotchas.md`：容量按有效数据量估算、PostgreSQL 参数上限两条。
- RFC-395 `migration.md` §4 与 RFC-398 `proposal.md` 加修订指针。

## 9. 设计门处置

### 9.1 第一轮（2026-11-27）

结论：不通过；1 项 P0、8 项 P1、4 项 P2。逐条核对源码后全部采纳，处置如下（检视只审功能）。

| # | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| 1 | P0 | 发现阶段按「行 → 单个任务」筛行，漏掉没有所属任务、经资源关联到多个任务的内容行，正式转换仍会到达「任务可继续所以阻塞」 | `settles.tasksOf` 改为返回任务集合，内容规则与发阻塞项共用同一推导（§3.2.2）；加共享内容用例（§7） |
| 2 | P1 | 只读历史限制不覆盖所有被结束的任务：只因工作区准备或门的打开操作在途而结束的、被级联结束的健康子任务仍可重试 | 不另加限制，按「等价于取消」如实表述：这些任务可由人手动重试；修订 proposal A1 与 §3.2.5，补三种情形的用例 |
| 3 | P1 | 装载被拒后封存的集合没有持久记录，带封存的单元提交后中断，续做会报摘要冲突 | 封存处置随单元同事务落库；sink 打开运行时返回各已提交单元的装载封存来源键，引擎转换前先应用；`trace` 从运行记录读同一集合（§3.3） |
| 4 | P1 | 收尾时移走悬空行没有来源处置的契约，回执与追溯描述失真，守恒检查也看不出 | 定义收尾处置：独立记录、与删除同事务、幂等；校验加目标行数对账；回执与追溯合并两阶段结果（§3.3） |
| 5 | P1 | PostgreSQL 在进入转换之前还有两处会因数据失败：经桥接的旧基线；拷贝到 scratch 后的业务不变量检查 | 自动模式下 scratch 拷贝不跑业务不变量检查（§3.3）；经桥接的 v0.18.18 / v0.18.19 基线明确不在本 RFC 的自动处置之内（proposal §3） |
| 6 | P1 | 冻结副本关闭即删，既有缓存只登记工作副本，「常数时间重开」没有持久的生命周期 | 新增冻结记录：位置、发布顺序、关闭与重开、清理、各崩溃窗口（§4.2）；桥接来源不复用 |
| 7 | P1 | 再批准的评估记录不幂等，同一份计划反复中断会耗尽次数 | 评估与批准按「运行 + 批准摘要」复用，次数上限只统计不同的批准摘要（§4.2） |
| 8 | P1 | 前置检查承诺「无新增物」，却发生在登记意图之后，且把会建库的 `provisioning.prepare` 当成检查 | 只读的前置检查挪到任何写入之前；`prepare` 仍是其后的既有步骤，其拒绝保留记录；验收口径相应修订（§3.5、proposal） |
| 9 | P1 | 子任务级联的选择规则落进了平台引擎，却写「无偏离」 | 级联由 task-execution 以 `expand` 贡献，引擎只做通用迭代；§1 写明（§3.2.3） |
| 10 | P2 | `node_runs.error_message` 的改写没有逐列复现取消清扫 | 拆成两步：四种状态取消盖原因代码；待答澄清轮的中间节点运行盖清扫原因，含已取消的（§3.2.3 第 2a、2b 行） |
| 11 | P2 | 「除暂存库外摘要取值不变」与转换器版本递增矛盾；流式排序的定义未区分 | 改述为算法不变、取值随版本变化；键摘要保持内存排序，内容摘要可流式（§4.3） |
| 12 | P2 | 结构检查用的指纹采集会全表计数，撑不起不设规模前提的秒级保证 | 结构识别只用目录与迁移日志，不数行；前置检查明确为与数据量无关的检查（§3.5） |
| 13 | P2 | 工件取回会改文件时间，硬链接后会连带改变被登记文件的标记 | 变更标记不用修改时间；同一 inode 时跳过时间重设（§4.1、§4.5） |

检视同时确认、无需改动的：六处直接发出点穷尽；没有规则从 `canonical` / `raw` 读被改写的状态列；取消表的各列与目标约束相容；
§3.4 各保留处置与目标结构相容；PostgreSQL 参数分批覆盖了自动路径上的多行写入。检视列出的会被触及的守卫已记入 plan「冲突面」。

第 2、3、4、5、6、8、11、13 条在第二轮复核中判为部分解决，上表保留第一轮当时的处置，进一步的修订见 §9.2。

### 9.2 第二轮（2026-11-27）

结论：不通过；没有 P0，5 项 P1、4 项 P2。第一轮的 13 条里 5 条判为已解决（1、7、9、10、12），8 条部分解决。
逐条对着源码核实后全部采纳（检视只审功能）。

| # | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| F1 | P1 | 「结束之后能否重试」仍按结束原因分类：父调用运行已取消的子任务直接重试会被 `call-row-finalized` 拒绝，仓库准备节点被取消后也不能直接重试；只读历史限制按请求的依赖集合判定，不能等同于「重试不了」 | 不再对重试下统一结论，改述为三层既有准入（任务状态、节点与调用关系、请求依赖上的历史限制）；验证口径改为「与先取消再升级等价」，逐表对比加准入结果对比（§3.2.5、§7、proposal §5 A1） |
| F2 | P1 | 续做时只恢复被封存的来源键，恢复不出首次拒绝的目标、约束等细节，这些细节进了单元摘要 | 重放的是完整的装载拒绝决定：sink 打开运行时原样交回，引擎直接应用、不重新生成；写明一次尝试返回全部被拒行、每个目标行至多一个来源行、一个来源行只有一条决定（§3.3、§5） |
| F3 | P1 | 收尾处置靠「普通行目标键即来源键」找来源，对运行输入、依赖索引、引用行、旧证据行等不成立，元数据也没有保存正常行的对应 | 收尾处置按目标行登记，不强求来源键；只有声明为原样保留的表附带来源键；追溯由规则回放得到目标集合后叠加收尾处置（§3.3） |
| F4 | P1 | PostgreSQL 拷贝到 scratch 用严格的逻辑读取与回读，物理上合法、逻辑编码不接受的值（文本列里的非法 JSON）会让拷贝失败，到不了封存 | 自动模式下该表整表走原值通道：读、写、回读核对都取原值；行数覆盖与序列校验不变（§3.3、§5、§7，plan T7） |
| F5 | P1 | 冻结记录没有 PostgreSQL 分支（快照事务随句柄关闭结束）；阶段为 `planned` 时自动循环无条件重新计划，「计划已保存、执行未开始」做不到直接续做 | PostgreSQL 的冻结记录只记身份与变更标记，重开时新开快照事务并比对，备份从新快照导出；自动循环在 `planned` 复用已保存的计划，证据由执行步核对（§4.2、§5、§6） |
| F6 | P2 | 发现阶段「与库总行数无关」不成立：按块读取的规则仍要扫表筛行；工作区准备的表没有 `task_id` | 分开写执行次数与读取成本，删去绝对的复杂度承诺；工作区准备的 `tasksOf` 显式取 `admitted_task_id`（§3.2.2） |
| F7 | P2 | 「任何写入之前、无新增物」超出实际边界：取得会话锁会写活动标记并建目录，只读打开 WAL 库可能创建旁路文件 | 承诺收窄为四样（会话记录、操作目录、分配文件、新建的库），写明锁的活动标记与旁路文件不在其内（§3.5、proposal G2 / B1 / 验收 4，plan T1） |
| F8 | P2 | 仍有「人工模式计划摘要与现在逐字节相同」的旧断言，与转换器版本递增矛盾 | 改为人工模式语义不变、同一版本下对拍，取值随版本变化（§3.1、§7） |
| F9 | P2 | proposal B5 仍写用修改时间做标记，与设计相反 | B5 改为文件大小、数据库文件头的变更计数与 WAL 检查点序号（proposal §5；此后自查把 SQLite 的标记进一步改为文件头加 `-wal` 的内容摘要，见 §4.1） |

检视同时提醒、已写入正文的：`db migration complete` 只做保留登记，不是自动清理器（§4.2）；前置检查的轻量结构结果不能当作正式的行数指纹（§3.5）；
取消清扫只覆盖待答澄清轮的中间节点运行，不扩大到其它终态运行（§3.2.3 第 2b 行）。

F1、F3、F4、F5 在第三轮复核中判为部分解决，上表保留第二轮当时的处置；其中 F4 的「整表走原值通道」与 F5 的「复用已保存的计划」
已被 §9.3 的做法取代。

### 9.3 第三轮（2026-11-27）

结论：不通过；没有 P0，5 项 P1、3 项 P2。第二轮的 9 条里 F2、F6、F7、F8、F9 判为已解决。逐条对着源码核实后全部采纳（检视只审功能）。

| # | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| N1 | P1 | 收尾处置产生得晚于转换摘要定稿，「在转换摘要里合并两阶段处置」做不到；直接补写又违反摘要幂等与工件只写一次 | 转换摘要只含转换阶段的决定、定稿后不改；收尾步骤返回由收尾记录导出的处置清单；两者在实际结果的计划文件里合并，报告、回执、`status` 从计划文件取（§3.1、§3.3、§3.7、§5） |
| N2 | P1 | 原值通道没有贯通 PostgreSQL 的备份及其读回：备份导出与读回核对仍走严格逻辑编码，文档自己举的例子会在备份这一步再次失败 | 放弃按表切换通道，改为「搬运口径」：拷到 scratch 及回读、备份导出、备份读回三处不检查取值规则（JSON 文本的合法性、实数是否有限），表示方式不变；备份清单记口径，读取方按清单（§3.3、§5、§6、§7，plan T7） |
| N3 | P1 | 坏行出现在第二块之后时，整表回退与已经提交的逻辑块及其回执冲突，没有定义切换与中断恢复 | 同上：搬运口径下分块、游标、排序与回执协议不变，不存在中途换通道（§3.3）；用例覆盖坏行在第一块与第二块之后（§7） |
| N4 | P1 | 带目标库阻塞项的 `planned` 计划会被反复复用，条件修复后仍被旧的阻塞项拒绝 | 撤回「复用已保存的计划」。保持「阶段不晚于 `planned` 就重新计划」，改为让计划步在同一轮运行里可重入：冻结与盘点沿用，目标库条件每次重查（§4.2、§5、§6、§7，plan T3） |
| N5 | P1 | 换了二进制之后没有完整的比较与新建运行分支；`v3-run-binding-mismatch` 是内部错误，不会自动新建一轮，§6 所称「既有路径」不存在 | 已批准的计划带有候选构建与转换材料；转换做完之前，执行步恢复与打开运行时拿它们与当前二进制比较，不一致以 `v3-conversion-material-changed-new-run-required` 结束，自动循环按既有的后缀规则新建一轮；执行步开始之前则由重新计划覆盖（§4.2、§5、§6、§7） |
| N6 | P2 | 「先取消再升级后逐表相同」的例外不全：生命周期修订号、旧证据行里的来源原貌也不同 | 例外改为三类并各自单独断言：原因与时间列、生命周期事件与修订号、保存来源原貌的旧证据行；保留重试准入对拍（§3.2.5、§7） |
| N7 | P2 | 「`trace` 本来就会回放得到完整目标集合」不成立：没有处置时走快路径，命中一个目标就不回放 | 写明这是新增行为：本轮有收尾处置且规则不是原样保留时不走快路径，回放后叠加收尾处置（§3.3、§7） |
| N8 | P2 | PostgreSQL 重开要重新数各表行数，不是常数时间 | 「常数时间」只用于 SQLite 私有副本；PostgreSQL 表述为免重算摘要、仍要数行与读序列值（§2、§4.2、§6） |

本轮之外我自查时另改了三处（都对着源码核过）：产品只允许从四种状态取消，`interrupted` 的任务旧版本不提供直接取消，
升级对它做同一组写入，表述相应改准（§3.2.3、proposal §5 A1）；取消事件的六个消费者逐个说明了升级为什么不需要它，
其中「向事件中心报告状态变化」是有意不做（§3.2.3）；结束原因的定义位置改为任务停止原因的单一事实源
`task-execution/domain/sourceTermination.ts`，数字员工判断执行结果的位置更正为 `task-execution/application/digitalEmployeeExecution.ts`（§3.2.4）。

N2、N5、N6 与 F4 在第四轮复核中判为部分解决，上表保留第三轮当时的处置，进一步的修订见 §9.4。

### 9.4 第四轮（2026-11-27）

结论：不通过；没有 P0，3 项 P1、2 项 P2。此前各轮的条目除 N2、N5、N6、F4 外都已判为已解决
（N1、N3、N4、N7、N8、F1、F3、F5 在本轮确认）。逐条对着源码核实后全部采纳（检视只审功能）。

| # | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| P1-1 | P1 | 搬运口径没有覆盖转换之前的启动事实读取：`bootSourceRows` 按严格口径读八张表，其中一行解不出来就在转换之前失败，文档自己的坏值用例到不了封存 | 启动事实采集、未结束任务统计、`trace` 的组定位三处与转换读取共用一个读法（严格读，失败时整表走原值并标出解不出的行）；自动模式下跳过解不出的行，它们在转换时封存；两种库都适用（§3.3、§5、§6、§7，plan T10） |
| P1-2 | P1 | 目标契约变了之后，新建运行路径要先按当前契约打开旧的新库才能退役，打不开就退不掉 | 目标端口加「凭已保存的代际身份退役」，只动迁移元数据表，不经当前契约的校验；加「上一版建的代际能被退役」的用例（§4.2、§5、§7，plan T3） |
| P1-3 | P1 | `validated` 之后跳过比较：回执用当前候选构建生成并先落盘，目标端核对不过，而有了回执又不能新建运行，会话卡死 | 比较覆盖到激活回执发布之前（含 `validated`），并且先于写回执；回执发布之后沿用回执继续（§4.2、§5、§6、§7） |
| P2-1 | P2 | 沿用内容清单时「新增文件没有任何行引用」不成立：两次启动之间放回去的缺失文件不被旧清单证明，会被当作缺失 | 撤回内容清单的跨进程沿用：重新计划时重新盘点，只有冻结沿用；同一进程里从计划步到执行步不重复盘点（§4.2、§7） |
| P2-2 | P2 | 旧证据的验收断言没有区分两种格式：运行证据的 `sourceValues` 取自规则读到的值，不是来源原貌 | 逐字节断言限定为通用证据的 `canonical` / `raw` 子文档；运行证据按其格式断言（§3.2.5、§7） |

检视标为「依据不足」的一点已实测补上：非数与无穷经产品所用的 PostgreSQL 客户端写入再读出往返一致（§3.3）。

本轮之外我自查时另改了三处：SQLite 的变更标记原先只看两个文件的大小与头部，WAL 模式下写进 `-wal` 已有空间的提交发现不了，
改为数据库文件头加 `-wal` 的内容摘要（§4.1、proposal §5 B5）；收尾时的悬空行原先一律移入归档，改为按外键声明的删除行为处置，
声明为置空的引用置空、行保留（§3.3、proposal §5 A4）；被结束任务的每一行改写如何留痕写明（§3.2.3）。

P1-3 与 N5 在第五轮复核中判为部分解决；上面自查改的前两处（SQLite 的变更标记、悬空行按外键声明的删除行为处置）在第五轮被指出不成立，
已由 §9.5 的做法取代。

### 9.5 第五轮（2026-11-27）

结论：不通过；1 项 P0、3 项 P1、2 项 P2，另有第四轮的 P1-3（连同 N5）仍是部分解决。第四轮的其余条目与 N2、N6、F4 判为已解决。
本轮的 P0 与两项 P1 都出在我上一轮自查时自己加的两处做法上。逐条对着源码核实（P0 另做了实验）后全部采纳（检视只审功能）。

| # | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| P0-1 | P0 | SQLite 的文件标记不能保证发现已提交的写入：WAL 模式下一次不动第 1 页的提交被检查点吸收、`-wal` 被删之后，文件大小、文件头、`-wal` 都与之前相同 | 撤回全部文件标记。同一进程内保持对旧库的只读连接、比较 `PRAGMA data_version`（实测两种日志模式都能发现别的进程的提交）；进程重启后续做时重算一次内容身份，两种库相同（§4.1、§4.2、§5、§6、§7，proposal §5 B5，plan T2） |
| P1-1 | P1 | 同一轮运行重新盘点得到新清单后，写不进已经发布的只写一次的冻结清单；备份也只在清单摘要相同时复用 | 执行步一开始就钉住计划（只写一次的 `plan-pinned.json`），此后不再重新计划；钉住之前重新计划照旧（§4.2、§5、§6、§7，plan T3） |
| P1-2 | P1 | 加入置空之后同一个目标行可能要处置多次，「按目标行登记一次、已有记录就跳过」不成立 | 收尾处置的单位改为一个目标行的一处引用，每条不可变；归档行数按目标行去重（§3.3、§5、§7） |
| P1-3 | P1 | 把「限制 / 不处理」的外键一律当作引用方不能独立保留，会把有保留办法的健康行封存；同一处引用在「旧库里本来没有」与「转换中被封存」两种情况下结果不同 | 改为按「这处引用有没有保留办法」处置：结构里声明置空的外键加模块显式声明的置空、改指合成一张表，转换时的解除引用与收尾共用；其余引用方移入归档；撤回「牵连范围与产品删除相同」的说法（§3.3、§5、§7，proposal §5 A4） |
| 第四轮 P1-3 / N5 | P1 | 激活回执发布之后换上目标契约不同的二进制仍走不下去：打开新库、准备切换、健康检查都按当前契约核对，而回执已在，不能新建运行 | 不扩大范围：表述收窄为目标契约相同才能沿用回执继续；目标契约不同是既有行为，归入仍会以错误结束的情形，并写明处理办法与后续工作（§3.6、§4.2、§6、§7，plan「后续」） |
| P2-1 | P2 | 改写留痕把 `record(record, origin)` 当成已有的持久来源关联；决定记录只存代码与载荷，追溯也不读它 | 来源标识写进载荷；普通追溯与回放追溯新增列出相符的改写说明（§3.2.3） |
| P2-2 | P2 | 失败模式表里还留着已撤回的「盘点沿用」 | 已同步（§6） |

本轮确认无误、供实现时参考的：现有五个声明置空的外键都是单列、可空，没有唯一、检查或复合外键妨碍置空；
两种库的收尾顺序都允许先处置悬空行再启用外键；启动事实等三处改用容错读法之后，没有发现转换之前还有别的严格读取来源行的地方。

P0-1、P1-3 与第四轮的 P1-3 / N5 在第六轮复核中判为部分解决，进一步的修订见 §9.6。

### 9.6 第六轮（2026-11-27）

结论：不通过；没有 P0，3 项 P1、2 项 P2。第五轮的 7 条里 4 条判为已解决（钉住计划、收尾处置的记录单位、改写留痕的接线、失败模式表）。
逐条对着源码核实后全部采纳（检视只审功能）。

| # | 级别 | 问题 | 处置 |
| --- | --- | --- | --- |
| R6-P1-1 | P1 | 监视旧库的连接要保持到进程结束，但计划步结束必定关闭源句柄，现有端口里没有跨调用持有连接的位置；关了再开的连接版本号不可比 | 连接由自动升级会话的装配持有，源句柄只借用；写明建立、重新计划、新建运行与会话结束时的规则；人工模式不跨进程比较（§4.1、§4.2、§5、§7） |
| R6-P1-2 | P1 | 改指的目标（系统用户）自己可能因为非键列解不出来而被封存，改指之后仍然悬空，处置不收敛 | 改指的目标只能是必需的种子行，必需的种子行不允许被封存：带不过去时以错误结束，与「种子行缺失」同类（§3.3、§3.4 第 15 行、§3.6、§7） |
| R6-P1-3 | P1 | 实际结果的计划待批准时换二进制：自动循环先调 `status` 取计划引用，`status` 会按当前契约打开新库而失败，到不了执行步里的比较 | 比较提到自动循环里每一轮最先做，只读日志与钉住的计划工件、不打开新库；执行步与打开运行处保留为第二道（§4.2、§5、§6、§7） |
| R6-P2-1 | P2 | 撤回文件标记之后，「中断续做」一段与源码守卫的表述没有同步 | 已同步：进程重启后先重算一次旧库身份；整库摘要次数改由计数探针看守（§4.2、§7） |
| R6-P2-2 | P2 | 「换回原版本即可完成」只在尚未切换时成立；已切换而自检未完成时走的是回滚 | 两种情况分开写（§3.6、§4.2、§6、§7） |

本轮起，门检视按仓库规则的修订（`CLAUDE.md` §工作准则「独立检视双门」，2026-11-27）改由本 session 派生的 subagent 执行。
