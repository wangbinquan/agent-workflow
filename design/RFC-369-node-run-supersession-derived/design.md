# RFC-369 技术设计：node_run 旧代作废改由读侧推导

**状态**：**In Progress（2026-09-23 用户批准实施）**
**读法**：先读 [proposal.md](./proposal.md)。

---

## 1. RFC-294 目标架构落位

| 项 | 落位 |
| --- | --- |
| bounded context | `task-execution`（铸造、merge 状态机、入口重放）+ `resource-catalog`（工作组回合驱动） |
| 取代判据 | `task-execution/domain/`：纯函数判据 + `infrastructure/` 的一条共用 SQL 谓词 |
| 铸造 | `task-execution/infrastructure/nodeRunMintParticipant.ts`（删掉范围读与 abandon） |
| merge 状态机 CAS | `task-execution/infrastructure/mergeStateLifecyclePersistence.ts`（迁移前判「已取代」） |
| 入口重放 | `task-execution/composition/executionMergeRecovery.ts` 经 `nodeExecution.list` 端口 |
| 工作组内部错误 | `resource-catalog/application/workgroups/workgroupTurnsDriver.ts` 的 `executeHostTurn`：内部错误转成 `failed` 结果，走各调用方既有失败出口 |

不新增跨 context 边、不改任何 public 合同。

## 2. 现状盘点（2026-09-23，只读代理盘点，逐条 file:line 在 plan.md 附录）

**依赖「旧代已在铸造时 abandoned」的只有两类**：

1. **入口重放**：`executionMergeRecovery.ts:59-143`（`replayPendingMerges`）与 `:154-214`
   （`replayConflictHumanResolutions`）只按 `(task_id, merge_state)` 取行，不看代次与帧。旧代若停在
   `pending-merge` / `conflict-human`，它过期的 delta 会被写进 canonical——RFC-144 修掉的缺陷。
2. **状态机围栏**：`abandoned` 是终态（`shared/src/lifecycle.ts:518-536, 624-627`），被取代的旧代
   之后再发 `begin-isolation`（`isolatedAgentRun.ts:157-192`）、`mark-pending-merge`（`:237-258`）
   等迁移会抛 `IllegalMergeStateTransition`。live 路径在碰 canonical **之前**先过这两道 CAS，所以
   它是「仍在跑的旧代不能合并」的事前围栏。

**不依赖的**：frontier（`dagFrontier.ts:133-172, 414-450` 只看每帧最新行）、wrapper 复活与分片候选
（`wrapperMechanics.ts:545-632, 1609-1655`、`gitStrategy.ts:54-58`）、回滚选择器、GC / worktree 清理
（不按 merge_state 决策）、前端（不出 API）。铸造只 abandon id 更小的行，最新行从不因铸造改变。

## 3. 取代判据（唯一定义）

与现行铸造的取代闭包（`nodeRunMintParticipant.ts:90-125`）**逐字对应**，只是把「以新行为参照、
在铸造那一刻执行」改成「以旧行为参照、在读到时判定」（这一改动本身带来的收紧见 proposal §4 第 1 条，
用户已确认接受）。

**结构判据**——行 R **被结构性取代**，当且仅当：
- **(a) R 是顶层行**（`R.parent_node_run_id IS NULL`），且存在行 S：
  `S.task_id = R.task_id ∧ S.node_id = R.node_id ∧ S.iteration = R.iteration ∧
   (S.container_run_id = R.container_run_id ∨ 两者皆 NULL) ∧ S.id > R.id ∧
   (S.shard_key IS NULL ∨ S.shard_key = R.shard_key)`；
  **对 S 是否为顶层行不加约束**——今天铸造只约束旧行 `isNull(parentNodeRunId)`（`:104`），
  不看新行（设计门 P2-4：保持字面等价）。
- **(b) R 是（直接）子行**：R 的父行 P 按 (a) 被结构性取代。**只下探一层**（今天 `:121` 是
  `inArray(parentNodeRunId, priorIds)`，孙行不在内），不得实现成递归。**只看 P 的结构，与 P 自身的 merge_state 无关**
  ——今天 `priorIds` 取所有同帧旧顶层行、不看其状态（`:90-109`），状态过滤只作用于被写的子行
  （`:117-120`）；扇出 wrapper 父行常为 NULL / merged（设计门 P2-3）。

> `S.shard_key IS NULL ∨ S.shard_key = R.shard_key`：今天铸造按**新行**的 shard 收口——新行带 shard
> 时只取代同 shard 前代（`rfc172-dispatch-shard:734`），新行不带 shard 时取代全部前代（`:747`）。从
> 旧行视角就是「存在一个同帧更新行，它不带 shard 或与我同 shard」。

**生效判据**——结构性被取代的行，只在 `R.merge_state ∈ {isolating, pending-merge, conflict-human}`
时才被围栏 / 重放排除所作用（与今天铸造 UPDATE 的 `inArray(mergeState, ABANDONABLE)` 一致；
`ABANDONABLE_MERGE_STATES` 里不存在于 `MERGE_STATES` 的死值 `conflict-agent` 删除）。

实现为两份等价物：
- `task-execution/domain/nodeRunSupersession.ts`：`isStructurallySuperseded(row, rowsOfTask)` 纯函数；
- `task-execution/infrastructure/nodeRunSupersession.ts`：`structurallySupersededCondition(alias)` 生成
  `EXISTS (...)` 的 drizzle SQL 片段（NULL 相等写成 `(a = b OR (a IS NULL AND b IS NULL))`，两个引擎
  同一份 SQL；(b) 用 P、S 两个 alias 嵌套 EXISTS，先例 `collaboration/infrastructure/review.ts:1896-1911`）。
  **只用在 SELECT 里**，不放进 UPDATE 的 WHERE（drizzle 在 update 里渲染外层列可能不带表名，相关列会
  误绑到内层 alias）。双引擎用同一批 fixture 对拍两者的判定集合。

## 4. 数据流

### 4.1 铸造（G1）

`nodeRunMintProgram` 删去 `readPriorRows` 与 abandon 两步，只剩 scope / lineage 解析与 insert。
`ReadPriorRows` 回调与 W47 的阶段序列相应收缩。`taskQuestionDispatch.ts:1444` 的同步事务同理（它调同一个
参与者）。**T2/T3/T4 同一个 commit 落地**（设计门建议），共享 main 上不出现「铸造不 abandon、读侧也不判」
的中间态。

### 4.2 merge 状态机围栏（G2 之二）

`DrizzleMergeStateLifecyclePersistence.transition` / `tryTransition`（唯一的迁移写手；它走
`withTaskExecutionWrite` 的普通事务，不是 SERIALIZABLE——设计门 P3 更正）：

1. 读本行（既有），若事件不是 `abandon`、`from ∈ {isolating, pending-merge, conflict-human}`、
   且本行按 §3 **被结构性取代**（用 §3 的 SELECT 判定，按主键点查本行）⇒ 用**同一个** `.update`
   （blind-write 白名单里这个文件恰好 1 处，不新增写点）把本行 CAS 成 `abandoned`——**只写
   `mergeState`，不带 `input.extra`**（否则 `mark-pending-merge` 的 `isoNodeTree*`、begin-isolation
   自环的 base 列会覆写被取代行，设计门 r2 P2-3）——**事务正常提交**，返回内部结果「已取代」；
2. 事务提交之后，`transition` 在事务外抛 `IllegalMergeStateTransition(abandoned, event)`，
   `tryTransition` 返回 false——与今天「终态上迁移非法」的对外表现逐字一致，调用方既有的 catch /
   false 分支原样生效（如 `isolatedAgentRun.ts:473-484`）。（设计门 P2-1：在事务里先写再抛会被回滚。）

**前提**：`transition` 不在调用方的外层事务帧里执行（否则「提交后在事务外抛」仍在外层事务内，abandon
会随外层回滚）。现有调用点都在编排层；实现时在 `transition` 里断言「非复用帧」，并以测试锁住（设计门 r2 P3-3）。

`from = NULL` 的旧代 `NULL → isolating` 放行（NULL 不在可取代集，与今天一致）；它随后的
`mark-pending-merge`（`isolating` 起点）在碰 canonical **之前**被拦——live 合并路径在合并前都先走
`persistIsoNodeTree → mark-pending-merge`（`isolatedAgentRun.ts:340-343`、`wrapperMechanics.ts:1773-1780`）。
带 `nodeTrees` 的重放路径直到合并之后才迁移（`executionMergeRecovery.ts:112-122, 193-199`），那两处
靠 §4.3 的排除。

### 4.3 入口重放（G2 之一）

`nodeExecution.list` 的查询（`nodeExecutionPersistence.ts:23-44`）加可选过滤 `excludeSuperseded: true`，
生成 `NOT (structurallySupersededCondition)`；两段重放都带上它。被排除的行由重放方随即走
`tryTransition({kind:'abandon'})` 收成 `abandoned`（失败只记日志，不影响重放）。

### 4.4 工作组：内部错误即判这一轮失败（G3，完整版）

**问题**：`executeHostTurn`（`workgroupTurnsDriver.ts:521`）执行中抛出的内部错误今天被驱动 catch 成
`lost`（`:2700-2760`），这一轮作废；已铸 / 已采纳却没执行完的 run 留在 `pending`，下一圈被当作崩溃恢复
重新采纳（`:2684-2687` adoptable = pending ∧ 非本循环所铸），内存里的协议 / 瞬态预算重新给一份。

**做法（四件事，同一笔提交落账）**：

1. **转换**：`executeHostTurn` 整体包一层——执行过程中**抛出**的错误（铸 run 的 `commit`、adopted
   的 prepare 提交、`clarifyAllowed` 读、`runHost` 在进入 assembly 之前抛出的错误；assembly 内部抛错
   今天已由 `onUnhandledThrow` 转成 failed，`schedulerAssembly.ts:294-298`）转成
   `{ kind: 'failed', runId, message: 'internal error: …', internal: { started, orphanRunIds } }`：
   - `started`：本轮的**开跑提交**是否已落库（首铸时是带 `firstStartOperations` 的那笔 commit，adopted
     时是 prepare commit）。
   - `orphanRunIds`：本次调用里**铸出或采纳过的全部 run**——铸造成功后**立刻**记下 runId（不能等到
     `registerMint` / 广播之后，设计门 r2 P3-7）。是否真的是孤儿由第 2 步按库里状态判定：**仍是
     `pending` 的**才终结（覆盖「runHost 正常返回 failed 但宿主没落终态」的 run，设计门 r3 P2-4）。
     范围只限内部错误这条路径；生产里 `onIsoSetupFailure`（`nodeMechanics.ts:350-354`）与 `runNode` 之前
     的 `onUnhandledThrow`（`:758-762`）在**普通失败**路径上也会把 run 留在 pending，这是既有问题，不在本
     RFC 范围，登记进 `docs/audit-backlog.md`。
   - `runId`：最后一条已铸出 / 已采纳的 run；一条都没有时用合成 id `internal:<ulid>`，只作为调用方账本
     操作的幂等键（`:1045, :1397, :1403, :1637, :1649`），不据此读写 node_runs（设计门 r2 已核实）。
   - `runHost` 正常返回之后 executeHostTurn 内只剩纯函数 `spec.parse`，**不会把 host 已 done 误判为
     失败**（设计门 r2 P2-1 核实）。
2. **终结孤儿 run**：新增宿主账本操作 `fail-host-run { operationKey, runId, message }`（TE public
   `WorkgroupHostLedgerOperation` 联合新增一支；`isHostLedgerOperation`〔`workgroupTurnsOperations.ts:322-326`〕
   与 TE 参与者 `applyOperation`〔`workgroupHostLedgerParticipant.ts:98-164`，今天是「非 mint 即 stamp」〕
   都补显式分支，设计门 r3 P3-1）。TE 参与者**先点读 status，只有 `pending` 时**才调用既有事务内
   生命周期 CAS `setNodeRunStatusTx`（`nodeRunLifecycleTransition.ts`）做 `pending → failed`
   （`allowedFrom: ['pending']`），其余状态一律空操作——`setNodeRunStatusTx` 遇终态 / 不在 allowedFrom 会
   抛 ConflictError、把整笔提交带成 lost（设计门 r3 P2-1）。`failureCode` 为 NULL（`FAILURE_CODES` 是封闭
   列表、没有内部错误取值，列注释 NULL 为常态，设计门 r3 P3-2），`errorMessage` 与 `finishedAt` 走 extra。
   不新增 node_runs 直写点（`lifecycle-grep-guard` 不变）。**这一步单独先提交一笔**（它自身幂等），
   再提交第 3、4 步那笔——否则卡片 CAS 不中（用户中途取消卡、批次卡被并发改）会把终结一并回滚，孤儿仍
   pending 被再次采纳（设计门 r3 P2-2）。提交成功后对每条被终结的 run 调
   `host.broadcastNodeStatus(runId, nodeId, 'failed')`（设计门 r3 P3-3）。
3. **按实际状态落失败**：调用方对 `failed` 已有出口，但写死 `from: 'running'`（`:1043-1057`、
   `:1409-1417`）。`internal.started === false` 时改用卡片的**实际**状态作为 `from`：
   `dispatched → failed`、`awaiting_human → failed`（转移表 `:73-83` 允许）；批次认领中的 `open` 卡走
   `open → dispatched（bumpAttempt: true）→ failed` 两步——必须 bump，否则 free_collab 下
   `assignmentFailureOperations` 按 `attempts < budget` 把卡 `failed → open` 重开（`:920-933`），
   attemptCount 永不增长，稳定错误下成无界循环（与 `:1257-1265` agent-missing 分支同形，设计门 r3 P2-3）；
   批次里已是 `running` 的卡按 `running → failed`。消息轮没有卡，照常推进游标 + 失败系统消息（这批消息不再
   回复，与消息轮普通失败 `:1631-1656` 同形）。
4. **领队补房间消息**：领队 `failed` 出口（`:3057`）在 internal 分支里先提交 `internalDriveError` 系统
   消息（`templateParams.item = 'leader'`，同 `wakeKey :2029`），再返回 terminal failed（设计门 r2 P2-2 /
   r3 P3-4）。与今天 catch 分支（`:2733-2750`）的差别：任务错误文案从原始 message 变成
   `internal error: …`；adopted 领队今天在 catch 里（`:2710-2721`）不发消息，改后会发。

两笔提交（第 2 步单独一笔，第 3、4 步一笔）本身再抛错时仍走驱动既有 catch（`lost`）——那说明库在持续
故障：第 2 步落了而第二笔没落时孤儿已终结、只是卡片未落 failed，下一圈按既有语义重派；第 2 步也没落时
孤儿下一圈会被再次采纳。都只在「数据库持续不可写」时出现，此时任务本就无法推进；列为已知残余，不再加层。

「不自动重来」的准确含义：**孤儿 run 不再执行**。free_collab 下卡片落 failed 后按既有规则被重开、重新
认领并新铸 run（`:920-933`），这是卡片自身的尝试预算，照旧生效（设计门 r3 P2-5）。

**对两条间歇红用例的影响（设计门 r2 P2-5）**：G3 修不绿它们——`rfc185-leader-fanout:900-924` 断言调用
次数恰为 budget+1 与 4 条账本行，`rfc359-w4-d19c-adapters:363-423` 断言失败文案含
`member stream kept failing`；残余 40001 存在时，它们会以「调用次数变少 / 文案变成 internal error」的
新形态红。**AC-6 完全依赖 G1**。

### 4.5 调度器跳过已被取代的 pending 行（用户 2026-09-23 裁决）

`resolveSchedulerRunRow.ts:86` 今天取第一个（最老的）pending 顶层行。按 §3 收紧后，若同帧已有更新一代
（如 `taskRouteOperations.ts:2300` 铸的 failed 占位行），这一行必定在 `mark-pending-merge` 处被拦——白跑
一轮 agent 并让节点失败（设计门 r2 P2-4）。改为：候选 pending 行先用 §3 的纯函数判定，已被结构性取代的
不采纳；过滤后没有可采纳的行就按既有「新铸一行」路径处理（`node_runs` 无唯一索引，`retryIndex = max+1`
把占位行也算进去，`latestExisting` 取到占位行 ⇒ cause `revival`、属性继承自占位行，设计门 r3 已核实）。

实现要点（设计门 r3 P3-5）：
- 四个调用点按 `{taskId, nodeId, iteration}` 取行、**不按 container 过滤**（`nodeMechanics.ts:1311-1317 /
  2335-2341 / 2638-2643 / 3813-3817`），`topLevelRows` 是跨帧的——判定必须用 §3 的帧维度，且比较集合传
  **全部** `input.rows`（§3(a) 不约束 S 是否顶层，须与 §4.2 的 SQL 一致）；
- `SchedulerRunRowCandidate.containerRunId` 可选，undefined 按 NULL；候选类型补 `shardKey` 等 §3 需要的
  字段（nodeId / iteration 在该调用上下文里恒定，用同 node 同 iteration 的局部变体）。
- **被跳过的旧 pending 行**在同一步用生命周期 CAS 终结为 `canceled`，不让它永远挂在节点历史里
  （设计门 r3 P2-6）。

## 5. 失败模式

| 场景 | 行为 |
| --- | --- |
| 新一代已铸出，旧代停在 pending-merge，daemon 重启 | 入口重放按 §3 排除它、收成 abandoned；不重放（AC-3） |
| 旧代仍在跑，新一代已铸出，旧代走到合并 | `mark-pending-merge` 判已取代 ⇒ 收成 abandoned、提交后抛非法迁移 ⇒ 不合并（AC-3/AC-4） |
| 旧代在新一代铸出**之后**才进入隔离（今天会合并） | 收紧：`mark-pending-merge` 处被拦（proposal §4 第 1 条，AC-7） |
| 旧代已过 `mark-pending-merge` 正在 materialize 时新一代被铸出 | 与今天相同（今天铸造的 abandon 也拦不住已在进行的 materialize） |
| 同帧两个 shard 并发铸造 | 不再互读，零冲突；各自按 §3 只取代同 shard 前代 |
| 扇出 wrapper 父行（NULL / merged）被取代，分片子行 pending-merge | 子行按 (b) 被取代：重放排除、迁移被拦 |
| 工作组一轮内部错误（开跑前 / 开跑后 / 执行前抛错） | 先单独一笔终结仍 pending 的孤儿 run 并广播；再一笔：卡按实际状态落 failed、失败系统消息；孤儿不再执行（AC-5） |
| 终结孤儿时它已不是 pending | 空操作，不影响本笔（AC-5） |
| 卡片 CAS 不中（中途取消 / 并发改） | 第二笔 lost；孤儿已由第一笔终结，不会被再次采纳 |
| open 卡开跑前出错且错误稳定 | 每次 bump attemptCount，止于卡的尝试预算 |
| 工作组失败落账的提交本身抛错 | 走既有 catch（lost）——仅在库持续不可写时出现（已知残余） |
| 调度器遇到已被取代的较老 pending 行 | 不采纳、终结为 canceled、新铸一行（§4.5） |
| 存量库里已被铸造 abandon 的行 | 不变（仍是终态） |

## 6. 测试策略

- **纯函数**：`isStructurallySuperseded` 覆盖 §3 每一格——顶层 / 子行、父行状态为 NULL / merged /
  pending-merge、shard 两种（新行带 / 不带）、不同 node / iteration / container、id 边界、S 为子行。
- **SQL 谓词与纯函数对拍**（双引擎）：同一批 fixture，SQL 判定集合 = 纯函数判定集合。
- **RFC-144 行为锁改写、判据不放宽**：`rfc144-merge-state-cas`「铸行即取代」组改为「铸行后，读侧判定
  取代 + 迁移被拦且 abandoned 已落库 + 重放不捞」；`rfc144-stale-replay-regression` 场景 A/B/C、D19
  端到端保留「canonical 不出现旧产物」的断言，改的只是「何时落 abandoned」；两条源码锁改为锁新形状
  （铸造事务里**没有** abandon / 范围读）。`rfc172-dispatch-shard` 两条、`rfc326` / `rfc349` /
  `rfc359-t1` / `rfc359-w47` 中锁「同事务 abandon」的断言按新语义改写。
  `rfc144-merge-state-blind-write-inventory` 白名单去掉铸造那一处。
- **收紧三情形**（AC-7）：较老 pending 行被接管且同帧有更新 retry 占位行、id 更小提交更晚的行、存量
  遗留行——各一条，锁定「不合并 / 重放排除」。
- **冲突回归锁**（AC-2）：双引擎用例——同任务两个节点并发铸 run，用 serializable 重试计数器断言重放
  次数 = 0；外加「铸造事务里不读 node_runs」源码锁。
- **AC-5**（双引擎）。**注入接缝**：harness 的 `composeTestWorkgroupTurns` 不暴露 persistence，改用
  `createWorkgroupTurnsPersistence`（`workgroupTurnsOperations.ts:529`）包一层可注入故障的 persistence，
  再交给 `createWorkgroupTurnsOperations`。注入点——① 首次开跑提交失败（卡为 dispatched / 批次卡为 open /
  adopted 卡为 awaiting_human 各一条，断言按实际状态落 failed；open 卡断言 attemptCount 递增且止于预算）；
  ② 重试铸 run 事务失败（前一条正常返回 failed、harness 里仍 pending 的 run 也被终结）；③ 铸造成功后
  `clarifyAllowed` 抛错；④ `runHost` 在 assembly 前抛错——③④ 各含一条 **adopted** 变体（「同一次 drive
  不被采纳」只对 adopted 孤儿有意义）。每条断言：失败系统消息、孤儿 run 终结为 failed 且在同一次与下一次
  drive 都不再执行、成员调用次数 ≤ 按卡尝试预算计的上限。附加：孤儿已非 pending ⇒ 空操作；卡片 CAS 不中
  ⇒ 孤儿仍被终结；领队内部错误 ⇒ 房间里有 `internalDriveError`（item='leader'）且任务失败。
- **§4.2 附加**：被拦下的 `mark-pending-merge` 不写 `isoNodeTree*`；`transition` 在复用帧里被调用即报错。
- **§4.5**：同帧已有更新 failed 占位行时，调度器不采纳较老 pending 行、把它终结为 canceled、新铸一行，
  任务最终跑通。反向用例（设计门 r3 P3-6）：最新的 pending 行照常被采纳、不重复铸行；兄弟 shard 下有
  更新行时本 shard 的 pending 仍被采纳；另一帧的更新行不影响本帧；既有「铸 pending 再调度」路径（retry
  级联、clarify-answer 重跑、review 驳回重跑、中断续跑）采纳行为不变，各锁一条。
- **AC-2 样本量**：本地 PG 复跑 20 次、冲突 0；CI 的 PG 臂在该用例里统计重放次数并断言为 0。
- **变异验证**：删掉 §4.2 判定 ⇒ 场景 A 红；删掉 §4.3 过滤 ⇒ 重放用例红；删掉 (b) 子行闭包 ⇒ 扇出
  场景红；把 abandoned 收尾挪回事务内先写再抛 ⇒ AC-4 红；删掉 §4.4 的转换 ⇒ AC-5 红。

## 7. 本 RFC 承担的架构演进 / 留下的债

**承担**：取代判据收成一处定义（domain 纯函数 + 一条 SQL 谓词），不再散在铸造的 WHERE 与迁移 0076 的
SQL 里（0076 的判据比现行宽，不含 container / shard，作为历史迁移保留不动）。

**留下**：`isolatedAgentRun` 等 services/ 层读 merge 状态的代码不迁移（非本 RFC 范围）。
