# RFC-215 — free_collab 双轨调度与批量认领（design）

- 状态：Draft v2（2026-07-21，设计门修订版）
- 修订对象：RFC-164 design §4.2（唤醒集）/ §4.3（失败重派口径）/ §6.3（消息唤醒轮）的
  free_collab 分支；leader_worker / dynamic_workflow 零改动。
- v1→v2：3 镜头对抗设计门（调度并发 / 协议数据 / 兼容测试）判 needs-revision，
  修订账见 §12。

## 0. 探针证据（本设计的事实基线）

对 `deriveWakeSet`（`packages/backend/src/services/workgroupWake.ts:158`）的纯函数探针
（2026-07-21，本仓 HEAD `3a1c43ea`）：

| 场景 | 输入 | 实测输出 | 判定 |
| --- | --- | --- | --- |
| S1 | 成员 A 空闲 + A 有未读 @ + 2 张 open 卡 | `message_turn(A)` **和** `fc_claim(A,T1)` 同 pass 派出 | 同 pass 双重占用 bug（同成员两个并发 run、游标双推进） |
| S2 | 全员 in-flight 消息回合 + 3 张 open 卡 | `items=[]`，outcome `running` | 消息轨排他占用成员 ⇒ 认领饥饿 |
| S3 | 预算剩 2 格 + 3 条未读 @ + 2 张 open 卡 | 2 × `message_turn`，0 认领，`capExceeded=true` | 预算末端讨论压倒任务 |

## 1. 总体方案

三条正交改动，全部收敛在 fc 分支：

1. **双轨拆分**（wake 层）：成员占用判定拆成任务轨 / 消息轨两个独立集合；同轨互斥、
   轨间并行。
2. **批量认领**（wake + engine + 协议层）：`fc_claim` 从单卡变一批（均分 + 上限 5），
   一批一个 run，新端口 `wg_task_results` 逐卡汇报。
3. **游标移交**（engine + 注入层）：fc 任务 run 不再消费 @ 消息、不再推进游标；游标
   归消息轨独有。

## 2. 调度层（`workgroupWake.ts`）

### 2.1 双轨占用集合

`WakeInput.inFlight` 增加一个 **optional** 集合（先例：`leaderClarifyParked?`，
`workgroupWake.ts:44-46`——optional 让 9 处既有测试字面量免改直过 typecheck，缺省
空集；见 §11 既有测试清单）：

```ts
inFlight: {
  leaderRunning: boolean
  runningAssignmentIds: ReadonlySet<string>    // 既有：in-flight 的卡 id（批 = 批内全部卡）
  messageTurnMemberIds: ReadonlySet<string>    // 既有：消息轨 in-flight 成员
  taskTurnMemberIds?: ReadonlySet<string>      // 新增（optional，缺省空集）：任务轨 in-flight 成员
}
```

两个占用维度职责区分（v2 澄清——v1 在这里自指矛盾，见 §12-1）：

- **配对候选排除**（决定谁能领新批）：`taskBusyMemberIds(input)` = { active 卡
  （dispatched/running/awaiting_human）的 assignee } ∪ `taskTurnMemberIds`。
- **恢复判定**（决定 dispatched 卡是否失驱、需重新集结）：只看 **in-flight 维度**
  （`runningAssignmentIds` / `taskTurnMemberIds`），**不**看卡状态腿——dispatched 卡
  自身就会把 assignee 放进 taskBusy，若用 taskBusy 判恢复则恢复集恒空（v1 bug）。
- `messageBusyMemberIds(input)` = `inFlight.messageTurnMemberIds`。
- **lw 保持合并语义**：lw 的 step 2 继续用 `taskBusy ∪ messageBusy`（与现
  `busyMemberIds` 逐位一致——AC-8 回归锁）；只有 fc 的 step 2 改用 `messageBusy`。

### 2.2 fc 派发顺序与批量配对

fc 分支的派发顺序重排为（G4：预算末端保任务）：

1. **fc_initial**（不变，`nothingStarted` 时全员规划轮，`workgroupWake.ts:233`）。
2. **任务轨——批量配对**（取代现 step 1-fc 与 step 4fc）：
   - **恢复批**（优先）：`dispatched` 且 `卡 ∉ runningAssignmentIds` 且
     `assignee ∉ taskTurnMemberIds` 的卡（= 无任何 in-flight run 驱动；覆盖
     "CAS 后 mint 前崩" 与 reconcile 打回的 redispatch 卡），按 assignee 分组，每组
     一个恢复批 item（上限 = 常数 `WG_FC_CLAIM_BATCH_LIMIT`，超出部分该成员下一
     pass 继续）。恢复批成员不参与下面的均分（它已有批）。
   - **新配批**：候选卡 = `open` 卡按 id 升序（创建序）；空闲成员 = agent 成员 −
     `taskBusyMemberIds` − 本 pass 恢复批成员，roster 序。
     边界短路：`idle.length === 0 || open.length === 0` ⇒ 跳过（除零守卫）；
     `batchSize = min(WG_FC_CLAIM_BATCH_LIMIT, ceil(open.length / idle.length))`；
     成员 k 拿 `open.slice(k*batchSize, (k+1)*batchSize)`，**空切片不产 item**
     （idle > open 时多余成员本 pass 无批）。
   - item 形态：`{ kind: 'fc_claim', memberId, assignmentIds: string[] }`（非空）；
     预算逐批检查 `roundsUsed + items.length >= maxRounds`（一批一格），超出置
     `capExceeded` 并停止。
3. **消息轨**（现 step 2 的 fc 变体）：候选 = 有未读 @ 的 agent 成员 −
   `messageBusyMemberIds`（**不再**扣任务轨成员）；预算检查在批之后逐格进行。

lw 分支（step 1 dispatched / step 2 合并 busy / step 3lw leader）原样保留。

### 2.3 终局判定

`decideWorkgroupOutcome` 逻辑**零改动**（fc 收敛 / fc-deadlock / capExceeded /
salvageable 逐位不变）。v1 曾提议把 `taskTurnMemberIds` 补进 in-flight 检查——
经查唯一调用点位于 `if (inflight.size === 0)` 之下（`workgroupRunner.ts:1113-1114`），
markInflight 与 inflight map 严格对称，调用时该集合恒空，补充是虚防护（§12-17），
不做。

## 3. 引擎层（`workgroupRunner.ts`）

### 3.1 shardKey 编码与 in-flight 登记

- **shardKey 编码**：`batch:${memberId}:${id1}+${id2}+...`——**memberId 编入**（v2，
  §12-4）：领养/收尾/登记路径无需反查 DB 即可恢复成员归属；纯 DB 反查在
  autonomous requeue 置 `assigneeMemberId: null`（`workgroupLifecycle.ts:331`）后
  失效，会漏登记 `taskTurnMemberIds` 击穿同轨互斥。解析函数
  `parseBatchShardKey(s): { memberId, assignmentIds } | null` 落 shared，所有消费点
  共用（禁 fork）。
- `wakeKey(fc_claim)` → `claim:${memberId}`（成员维互斥：同成员至多一个 in-flight 批）。
- `markInflight(fc_claim)`：`runningAssignmentIds` add 批内全部卡 id +
  `taskTurnMemberIds` add memberId；`assignment`（lw）同时 add assignee。清理对称。
- 领养/收尾路径（`workgroupRunner.ts:1062-1069`）：`batch:` 前缀 ⇒ 解析登记批内卡
  ids + memberId；顺手补既有缺口（§12-16）：领养的 `msg:` 行同样登记
  `messageTurnMemberIds`（现状漏登记 ⇒ 领养消息回合在飞时同成员可被派第二个消息
  回合、双推游标）。

### 3.2 批量 drive（`driveWakeItem` fc_claim 分支 → `driveBatchTurn`）

1. 逐卡 CAS `open→dispatched`（`assigneeMemberId`）；恢复批里已是 dispatched 且
   assignee=本成员的卡直接纳入；CAS 失败（被并发领走）跳过。成功子集为空 ⇒ return
   （不 mint、不烧预算）。
2. **认领即计数**：`open→dispatched` CAS 成功的卡 `attempt_count` 自增。实现形态
   （v2 明示，§12-10）：`casAssignmentStatus` 的 `set` 参数是 drizzle 字面量
   `Partial<$inferInsert>`（`workgroupLifecycle.ts:93-105`），表达不了 SQL 自增——
   扩展专用可选参 `bumpAttempt?: true`，内部拼 `sql\`attempt_count + 1\``；禁用
   「快照值+1」字面量（丢增窗口）。恢复批纳入**不**自增（只在 open→dispatched 计）。
3. mint **一个** host 行：`nodeId=__wg_member__`、`cause='wg-assignment'`、
   `shardKey = 'batch:${memberId}:' + ids.join('+')`。协议重试行同 shardKey、
   `cause='wg-protocol-retry'`（round 账本排除照旧，`workgroupRounds.ts:121`）。
4. 逐卡 CAS `dispatched→running` + 写 `nodeRunId`（协议重试 mint 新行时逐卡刷新
   `nodeRunId` 指向最新行，现状同语义 `workgroupRunner.ts:1826-1830`）。
5. prompt = `composeMemberPrompt`（§4 批量形态）+ 协议块（§6 批量协议）。
6. `hooks.runHostNode` 一次；结果处理：
   - `canceled` ⇒ 批内卡逐张 `running→canceled`。
   - `awaiting`（human clarify park）⇒ 批内卡逐张 `running→awaiting_human`（整批同泊，
     答案回注后整批续跑——clarify shard 即批 shardKey，per-shard 路由等值匹配即可，
     `taskQuestionDispatch` 对键内容不透明）。
   - `failed`（结构化可重试码）⇒ 沿用既有 followup 重试环（卡保持 running）；耗尽 ⇒
     整批 `running→failed`，失败消息落房间，`attempt_count < DEFAULT_PROTOCOL_RETRY_BUDGET`
     的卡回 `open`（清 assignee/nodeRunId），达预算的留 `failed`。
   - `done` ⇒ 解析 `wg_task_results`（§6）：
     - 解析失败 / 覆盖缺卡 ⇒ errorNotice 指名缺哪几张，走协议重试；耗尽 ⇒ 已合法
       汇报的卡照落，未汇报的按"整批失败"回 open 规则处理。批 run 里误发的
       `wg_result` 是 undeclared 端口（envelope kept-but-flagged，不进 outputs）——
       该 run 必然缺 `wg_task_results` 而进入本重试路径，errorNotice 同时点名
       「本 run 用 wg_task_results，不用 wg_result」（§12-14）。
     - 逐卡落库：`status:'done'` ⇒ postAssignmentMessage(result, 该卡 summary) →
       CAS `running→done`（resultMessageId）；`status:'failed'` ⇒ 失败系统消息 →
       CAS `running→failed` → 预算内回 `open`。
     - `wg_messages` / `wg_tasks_add` 端口照旧消费（批 run 也能发言/造卡）。
7. **不调用** `advanceMemberCursor`（G3；lw 分支保留，现 `workgroupRunner.ts:1969`）。
8. **throw 收口批量化**（`workgroupRunner.ts:1398-1408`，v2 §12-13）：drive 自身
   throw（mint/DB 异常）的 catch 分支从单卡 CAS 改为逐卡
   `dispatched/running→failed` + 预算内回 open——与步骤 6 的失败路径共享同一收尾
   子例程（否则批下 5 卡留 failed 终态 ⇒ fc 收敛 openOrActive=false ⇒ 任务假 done）。

### 3.3 消息回合

`driveMessageTurn` 逻辑不变（含游标推进 `workgroupRunner.ts:2058`）；变化只有 wake 层
的占用判定（§2.1）——成员在跑任务批时也能被唤起消息回合。同成员双 run 并发的
worktree 合并由既有 per-run 隔离 + `writeSem` 串行 merge-back 兜底（RFC-130/210 语义）；
消息回合常规不落盘，真冲突走既有冲突路径，设计上接受。

### 3.4 崩溃恢复（v2 全面改写，§12-2）

事实基线：daemon 崩溃后 boot reaper 把 pending/**running** host 行统一打成
`interrupted`（`workgroupRunner.ts:269-271` 注释、orphans reaper）；领养环只收
`pending` 行（`workgroupRunner.ts:1044-1046`）——真崩溃后**没有** pending 批行可
领养（领养只服务 clarify-answer rerun / revive 重 mint 的行）。真实恢复通道：

- **`reconcileRunningAssignments`**（`workgroupRunner.ts:351-370`）——引擎重入时对
  `running` 卡按其 run 终态裁决。现按 `r.shardKey === a.id` 匹配，批 shardKey 下
  恒空 → 误判 `redispatch`（重跑已完成工作）。**适配**：匹配改为按
  `a.nodeRunId` 直查 host 行（卡上的 `nodeRunId` 恒指向最新 run，单卡/批同式；
  连带取代脆弱的 shardKey 等值匹配）。`decideAssignmentReconcile` 表不动。
- **wake 恢复批**（§2.2）——`dispatched` 失驱卡重新集结。

| 崩溃点 | 落库状态 | 恢复路径 |
| --- | --- | --- |
| CAS dispatched 后、mint 前 | 卡 dispatched、无 host 行 | wake 恢复批重新 drive（重 mint；attempt 不再 +1——只在 open→dispatched 计数） |
| mint 后、run 结束前 | 卡 running、host 行 → interrupted（boot reaper） | reconcile：`interrupted` ⇒ `redispatch` → 卡回 dispatched → wake 恢复批重跑 |
| run 后、逐卡落库中 | 部分卡 done、剩余 running、host 行 done | reconcile：`done` ⇒ 逐卡收 `done`（不重跑；崩溃窗口内没落上 result 消息的卡收 done 无 result——与单卡现状同语义，接受） |
| drive throw（非崩溃） | 卡 dispatched/running | §3.2-8 throw 收口逐卡 failed→预算内回 open |

### 3.5 单卡 `assignment` item 的去留

fc 不再产生单卡 `assignment` item（dispatched 恢复并入恢复批）；lw 的 `assignment`
item 与 `driveAssignmentTurn` 保持原语义（单卡、注入 mentions、推游标）。
`driveAssignmentTurn` 与 `driveBatchTurn` 共享结果落库/失败收尾/重试子例程，禁止
fork 两份（dedup 审计红线）。

### 3.6 房间视图（`workgroupRoom.ts`，v2 新增，§12-5）

`runKindOf`（`workgroupRoom.ts:80-90`）对 `__wg_member__` 行按「`msg:` 前缀 or
assignmentIds 集合命中」二分，`batch:` 行两者皆不中 → 被剔除：批 run 在
runHistory 不可见、成员批执行期 presence 显示空闲、clarify park 投影
（`openClarifySourceRunIds`）丢失。**适配**：`batch:` 前缀 ⇒ kind='assignment' 形态
（经 `parseBatchShardKey` 关联批内卡），`deriveMemberCurrentRuns` / clarify 投影
随之修复。

## 4. 注入层（`composeMemberPrompt`，`workgroupRunner.ts:864`）

- 签名扩展：`assignment: WorkgroupAssignment | null` → `assignments:
  readonly WorkgroupAssignment[] | null`（null=消息回合，现状）。
- **形态按调用方劈开**（v2 澄清 N=1 矛盾，§12-9）：
  - lw `driveAssignmentTurn`：恒长度 1，渲染 `## Your assignment`——与现状逐字
    一致（`workgroupRunner.ts:888-899`），协议仍 `wg_result` 单对象。lw 零 diff。
  - fc `driveBatchTurn`：**无论 N**（含 N=1）渲染
    `## Your assignments (batch of N)` + 逐卡 `### Task k: <title>` +
    `fenceUntrusted('assignment-brief', ...)`，协议恒 `wg_task_results` 数组——
    prompt 的 Task k 锚点与协议序号永远同在，模型不会在 N=1 时找不到引用。
- fc 任务 run 的切片（`selectMemberSlices`，`workgroupContext.ts:128`）：
  - `mentions` **不注入**（消息轨专职——AC-5）；
  - `peerResults` / `blackboard` 注入改**尾窗模式**：`cursorMessageId=''` 全量起算 +
    既有 char budget 裁剪（`clipTailByCharBudget`）——游标不再影响任务 run 的上下文，
    只读、不消费。
  - lw worker run 切片行为不变（cursor 语义照旧）。
- 实现形态：`selectMemberSlices` 增加可选 `opts: { omitMentions?: boolean }`，调用侧
  fc 任务 run 传 `omitMentions:true` + `cursorMessageId:''`；不 fork 第二个切片函数。

## 5. 数据层（migration 0105）

```sql
ALTER TABLE workgroup_assignments ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
```

- 语义：该卡被**编入批次**（open→dispatched CAS 成功）的累计次数；失败回 open 的
  预算判据 `attempt_count < DEFAULT_PROTOCOL_RETRY_BUDGET`（=3，`shared/prompt.ts:1079`），
  取代现按 `shardKey=assignment.id` 数 node_runs 行（`workgroupRunner.ts:1907-1918`，
  确认在 `mode==='free_collab'` 门内、lw 无涉）——批量 shardKey 下该查询失效，且新
  口径把「协议重试不算新预算」修准（协议重试同一批不重复 +1）。自增实现形态见
  §3.2-2（`bumpAttempt` 专用参，禁快照+1）。
- 存量卡 `attempt_count=0` 起步：语义上多给一次机会，可接受（一次性宽限）。
- 迁移工程纪律：`when` 接合成轴（journal 尾 0104 `when=1786377600000` ⇒ 0105
  `when=1786464000000`）；单语句无需 breakpoint；`upgrade-rolling.test.ts:230,304`
  计数 104→105 bump。**冻结 fixture 实锤**（v2 点名，§12-11）：
  `rfc189-wg-round.test.ts:151` 在 0094 冻结库上对 `workgroupAssignments` 做 drizzle
  INSERT（HEAD 全列生成）——0105 后必炸 `no column named attempt_count`，须改显式列
  裸 SQL（先例：[reference_new_column_breaks_frozen_migration_tests]）。

## 6. 协议层（`shared/schemas/workgroupRuntime.ts` + `workgroupContext.ts`）

### 6.1 新端口 `wg_task_results`（fc 任务批 run 专用）

现 `wg_result` 是单对象（`WgResultSchema`，`workgroupRuntime.ts:255-257`），同端口双
schema（消息回合单对象 / 批 run 数组）会让模型与解析两头混乱——**端口拆分**：

```ts
export const WG_PORT_TASK_RESULTS = 'wg_task_results'
export const WG_FC_CLAIM_BATCH_LIMIT = 5

export const WgTaskResultItemSchema = z.object({
  task: z.number().int().min(1),                      // 批内序号（prompt 的 Task k）
  status: z.enum(['done', 'failed']).default('done'), // failed = agent 自报无法完成
  summary: z.string().trim().min(1).max(16384),
  detail: z.string().max(65536).optional(),
})
export const WgTaskResultsPortSchema = z
  .array(WgTaskResultItemSchema)
  .max(WG_FC_CLAIM_BATCH_LIMIT)
```

`parseWgTaskResultsPort(raw, batchSize)`：JSON/schema 校验 + `task ∈ [1, batchSize]` +
序号去重 + 覆盖检查——返回 `{ ok, value, missing: number[] }`，缺卡由 drive 层决定
重试或回 open（§3.2）。

### 6.2 角色端口与协议块

- `wgHostRolePorts`（`workgroupContext.ts:485`）按"是否带批"分流：
  - fc 任务批 run：`[WG_PORT_TASK_RESULTS, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]`
  - fc 消息回合：`[WG_PORT_RESULT, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]`（现状）
  - leader / lw worker：现状。
  - 实现：函数增**可选**参 `batch?: { count: number }`（arity 兼容，镜像锁
    `workgroup-host-output-isolation.test.ts:100-104` 平移扩展批量分支断言）。
- `renderWgProtocolBlock` fc_member 批量版：逐卡汇报规则（每张 Task k 必须出现一次、
  status 语义、禁漏卡、**明示本 run 不用 `wg_result`**）、`wg_task_results` JSON
  示例；消息回合版保持现协议（`wg_result` 单对象）。两种 run 的协议块各自只描述
  自己的端口，无并存歧义。

### 6.3 clarify askerKey 批下稳定性（v2 新增，§12-8）

`wgClarifyAskerKey` 对成员行返回 `asg:${shardKey}`（`shared/workgroup.ts:374-383`），
反问预算（`countWgClarifyAsks`）与人类 stop 指令（`workgroupLifecycle.ts:409-413`、
前端 `WorkgroupRoom.tsx:154-159`）都按此键记账。若直接用批 shardKey，卡回 open 重组
批次即产生全新 key——预算清零旁路 + stop 指令成孤儿（正是 RFC-207 R12 封堵的
「换 key 刷预算」在任务轨重开）。**规则**：`wgClarifyAskerKey` 对 `batch:` 前缀
返回 `asg:batch:${memberId}`（丢卡集合段）——fc 任务轨的反问预算/静默按**成员**
稳定，跨批不漂移；单卡（lw）语义不变。

## 7. 前端（`packages/frontend`，fanout 对等）

- **批徽记**：任务卡列表（WorkgroupRoom 内清单区）按 `nodeRunId` 分组（房间 API 逐卡
  返回 `nodeRunId`，`routes/workgroupTasks.ts:421-434`，前端类型未裁掉），同批 >1 时
  卡行加既有 chip 样式的"批 ×N"标识（复用既有 chip 类，不自写 chrome）；点击行为
  照旧。
- **房间 runHistory / presence**：后端 §3.6 适配后前端零改（分类修复在 API 层）。
- i18n：`workgroup.batch.*` zh/en 双语 key。
- vitest：批徽记分组渲染 + 逐卡 result 渲染回归。

## 8. 失败模式

| 模式 | 处置 |
| --- | --- |
| 批 run 超时/进程崩 | 整批 `failed` → 预算内回 open（爆炸半径 ≤ 5 卡，上限的存在理由） |
| drive 自身 throw（mint/DB 异常） | §3.2-8 catch 收口逐卡 failed → 预算内回 open（禁热循环重配） |
| 模型漏报/序号越界/重复/误发 `wg_result` | parse 层拦截 + errorNotice 点名重试；耗尽后已报卡照落、未报卡回 open |
| 批内卡被并发领走（恢复 vs 新配竞态） | 逐卡 CAS 丢失方跳过，成功子集继续；子集空不 mint 不烧预算 |
| 批 run 泊 clarify 后用户切 autonomous | `dismissOpenClarifyParksForAutonomous` 批适配（§9 清单）解析 `batch:` 逐卡 requeue |
| 同成员双轨 run 同时写文件 | 既有 per-run worktree + writeSem 串行 merge-back；消息回合常规零落盘，真冲突走既有冲突路径 |
| open 清单 > 空闲×5 | 剩卡下一 pass 继续配（认领批预算优先，无饥饿回路） |
| agent 成员全部任务轨忙 + 新卡持续入 | 卡等待；成员批结束即再配（idle=0 时配对短路，无除零） |

## 9. `batch:` shardKey 消费点适配清单（v2 全量盘点，§12-3/5/6）

| 消费点 | 现行为 | 适配 |
| --- | --- | --- |
| `workgroupRunner.ts:1062-1069` 领养/收尾登记 | 非 `msg:` 即当卡 id | `parseBatchShardKey` 解析登记（§3.1） |
| `reconcileRunningAssignments`（`:351-370`） | `r.shardKey === a.id` | 改按 `a.nodeRunId` 直查（§3.4） |
| `dismissOpenClarifyParksForAutonomous`（`workgroupLifecycle.ts:322-344`） | `eq(assignments.id, shard)` 单卡 requeue | `batch:` ⇒ 解析 ids ⇒ `inArray` 逐卡 requeue |
| `workgroupRoom.ts:80-90` `runKindOf` + presence + clarify 投影 | 非 `msg:` 非卡 id ⇒ 剔除 | `batch:` ⇒ assignment 形态（§3.6） |
| `wgClarifyAskerKey`（`shared/workgroup.ts:374-383`） | `asg:${shardKey}` | `batch:` ⇒ `asg:batch:${memberId}`（§6.3） |
| `deriveLeaderClarifyPark`（成员行恒 sharded 假设） | 只认 `__wg_leader__` 行 | 无需改（batch 行非 null 满足假设） |
| clarify per-shard 路由（`taskQuestionDispatch`） | 键等值匹配 | 无需改（键内容不透明） |
| `deriveRoundsUsed`（`workgroupRounds.ts:117-123`） | fc 按行计数 | 无需改（批行=1 行=1 格） |
| 前端 `node-history.ts:150-155` | 非 msg: 落「派发轮」标签 | 无需改（batch 行归派发轮正确） |

## 10. 测试策略（test-with-every-change 清单）

**纯函数（wake）** — `rfc215-fc-dual-track.test.ts`：
1. AC-1 正反两向（S2 反转锁：全员消息轨 in-flight ⇒ 批照发；任务轨 in-flight ⇒ 消息照发）。
2. 同轨互斥（taskBusy 成员不配批；messageTurn in-flight 不重复派）。
3. AC-2 均分矩阵：7 卡 2 闲 ⇒ 4+3；11 卡 2 闲 ⇒ 5+5 剩 1；3 卡 5 闲 ⇒ 1+1+1 且**无空批 item**；idle=0 / open=0 短路。
4. AC-6 预算末端：剩 1 格 ⇒ 批占格、消息 capExceeded（S3 反转锁）。
5. S1 反转锁：同成员同 pass 可同时有 `message_turn` + `fc_claim`（双轨合法并行），但各轨内无第二项。
6. AC-8 lw 回归：worker active assignment 时 @ 不唤（合并 busy 保留）。
7. 恢复批：dispatched 失驱卡按 assignee 集结、优先于均分、上限=常数、attempt 不重计。

**引擎（DB 级）** — 扩展 `rfc164-workgroup-engine.test.ts` 或新文件：
8. 批 drive 全链：CAS→mint 单行→逐卡 done→resultMessageId 逐卡正确。
9. 漏报卡协议重试→耗尽→缺卡回 open + attempt_count 断言；批 run 误发 `wg_result` ⇒ 走同一重试路径（不静默）。
10. 自报 failed 卡回 open；达预算留 failed。
11. run 整体 failed 整批回 open；drive throw 收口逐卡回 open（§3.2-8，防 2026-07-10 式热循环）。
12. AC-7 恢复矩阵（§3.4 v2 版逐行）：dispatched 失驱重配；host 行 interrupted ⇒ reconcile redispatch ⇒ 重配批；host 行 done + 卡 running ⇒ 逐卡收 done **不重跑**。
13. AC-5 游标：批 run 结束游标不动（消息回合对照组推进）；lw worker 照旧推进。
14. clarify park：批 run awaiting ⇒ 整批 awaiting_human，答案续跑后逐卡照落；用户切 autonomous ⇒ 批解析逐卡 requeue 回 open。
15. 同成员 `msg:` + `claim:` 双 run 并发的引擎级集成断言（两 run 各自完成、落库不互踩）。
16. askerKey：同成员跨两批反问 ⇒ 预算连续计数、stop 指令跨批仍命中。

**协议（shared 单测）**：
17. `parseWgTaskResultsPort` 全路径（坏 JSON/越界/重复/缺卡 missing 列表/failed 默认值）。
18. 镜像锁扩展：批量 role ports ↔ 协议块文本。

**迁移**：
19. journal 计数 bump；0105 回滚安全；`rfc189-wg-round.test.ts:151` 冻结 fixture 改显式列裸 SQL。

**源锁**：
20. fc 批 drive 路径不得出现 `advanceMemberCursor` 调用（结构 grep 锁，防回归）。

## 11. 既有测试改动清单（v2 新增，§12-7——「既有测试全绿」的诚实账）

| 测试 | 现锁 | 处置 |
| --- | --- | --- |
| `rfc164-workgroup-core.test.ts:564-573` claim pairing | 单卡 `assignmentId` 一人一张 | **改写**为批断言（3 卡 2 闲 ⇒ 2+1 均分），由 §10-3 取代原语义 |
| `rfc164-workgroup-core.test.ts:142,438-442,506-510` 等 9 处 `WakeInput` 字面量 | inFlight 三字段 | 字段 optional（§2.1）⇒ 免改直过 |
| `rfc164-workgroup-engine.test.ts:913-967, 969-1006` fc 收敛/确认门全链 | 成员脚本输出 `wg_result` | fixture 改输出 `wg_task_results`（批协议）；`:943` `toHaveLength(4)` 随批次数核改 |
| `retry-budget-single-source.test.ts:33` | 精确串 `priorRuns < DEFAULT_PROTOCOL_RETRY_BUDGET` | priorRuns 删除 ⇒ 锁同步改为 `attempt_count < DEFAULT_PROTOCOL_RETRY_BUDGET` 串 |
| `rfc186-resume-reconcile.test.ts:66` | `advanceMemberCursor(db, taskId` 恰 3 处计数锁 | fc 批路径不新增调用、lw 保留 ⇒ 计数按实核改（预期 3 处不变或 -0；改动后必须重数） |
| `rfc186-resume-reconcile.test.ts:19-24` | `decideAssignmentReconcile` 决策表 | 表不动（§3.4 只改匹配方式）⇒ 应保持绿 |
| `workgroup-host-output-isolation.test.ts:100-104,315-318` 镜像锁 | 渲染文本抽端口 ≥3 | 可选参 arity 兼容 + 批量分支平移扩展 |

## 12. v1→v2 修订账（3 镜头对抗设计门，全部坐实后修入）

1. 【①P1-1=②F1=③F1】§2.1/§2.2 恢复条件自指矛盾（dispatched assignee 恒在 taskBusy ⇒ 恢复集恒空、任务永楔 awaiting_human）⇒ §2.1 拆「配对排除」vs「恢复判定」两维度，恢复只看 in-flight。
2. 【①P1-2=②F4=③F1】§3.4 v1 矩阵与 boot reaper（pending/running→interrupted）/领养环（pending-only）不符，「pending 批行领养续跑」对真崩溃不可达 ⇒ 矩阵按真实通道改写。
3. 【同上】`reconcileRunningAssignments` 按 `shardKey===a.id` 批下恒空 ⇒ 误 redispatch 重跑已完成工作 ⇒ 改按 `a.nodeRunId` 直查 + 纳入 §9 清单。
4. 【①P1-4】shardKey 缺 memberId，requeue 置 assignee=null 后登记反查失效 ⇒ 同轨互斥可击穿（同成员双批并发、同卡双 run）⇒ shardKey 编入 memberId。
5. 【②F3】`workgroupRoom.ts` `runKindOf` 剔除 batch 行 ⇒ 批 run 房间全程隐形 ⇒ §3.6 适配。
6. 【①P1-3=②F2】`dismissOpenClarifyParksForAutonomous` 单卡 eq 匹配批键 0 行 ⇒ 整批永滞留 awaiting_human ⇒ §9 清单 inArray 适配。
7. 【③F2】「既有测试全绿」不成立（4 组既有锁必红/需改）⇒ §11 诚实清单。
8. 【②F6=③F4】批 shardKey 直入 askerKey ⇒ 重组批即刷反问预算 + stop 孤儿 ⇒ §6.3 按成员稳定。
9. 【②F8】N=1 批「prompt 与现状逐字一致」与批协议矛盾 ⇒ §4 按调用方劈开（fc 恒批形态含 N=1；单卡形态只属 lw）。
10. 【②F5】`casAssignmentStatus` set 参数表达不了 SQL 自增 ⇒ §3.2-2 `bumpAttempt` 专用参、禁快照+1。
11. 【②F7】冻结 fixture 实锤：`rfc189-wg-round.test.ts:151` 必红 ⇒ §5 点名改显式列裸 SQL。
12. 【①P2-6=②F9=③F6】均分公式 idle=0 除零 / 空切片 mint 空批 / 恢复上限未定义 ⇒ §2.2 边界补全。
13. 【①P2-7=③F8-1】driveWakeItem throw 收口单卡 CAS 不回 open ⇒ 批下 5 卡假终态+任务假 done ⇒ §3.2-8。
14. 【③F5】批 run 误发 `wg_result` 静默丢弃 ⇒ 缺 `wg_task_results` 必进重试路径 + errorNotice 点名 + 协议块明示（§3.2-6/§6.2）。
15. 【③F7】声称修订 RFC-164 §4.2/§6.3 但无落地任务、漏 §4.3 ⇒ 修订范围补 §4.3（attempt_count 取代 defaultNodeRetries 文字）、plan T7 加回写任务。
16. 【②F9-2】领养 `msg:` 行不登记 messageTurnMemberIds（既有缺口，同成员双消息回合双推游标）⇒ §3.1 顺手封口。
17. 【①P2-5】§2.3 v1 给 outcome 补 taskTurnMemberIds 的"窗口防护"是虚的（调用点集合恒空）⇒ 撤销，零改动。

## 13. 兼容性与范围核对

- `deriveRoundsUsed` 零改（fc 行计数：批行=1 行=1 格天然成立）。
- RFC-209 回合语义零改（fc 消息 round 恒 0）。
- RFC-099 prompt isolation 零涉（不新增任何用户身份进 prompt）。
- e2e shell 桩零涉（不动 spawn argv）。
- `dynamic_workflow` 零涉（`roundedModeOf` 分流在先）。
- envelope 层对新端口天然支持（`scheduler.ts:815-826` 将 hostOutputPorts 投影为
  agent.outputs，端口名无注册表约束）。
- node_runs 无覆盖 wg 行的唯一索引，同 shardKey 重铸安全。
- 单二进制冒烟必跑（workgroupRounds 模块环前科，`build:binary` 是唯一能抓的门）。

---

> **勘误指针（RFC-217，2026-07-22）**：本文 §9 shardKey 六消费点清单中位于
> `workgroupRunner.ts` 的条目已随 RFC-217 T3 解体迁移——codec 单源在
> `shared/src/schemas/workgroup.ts`（buildMsgShardKey/parseMsgShardKey，G7 锁），
> 重开预算判据 `attempt_count < DEFAULT_PROTOCOL_RETRY_BUDGET` 在
> `services/workgroup/lifecycle.ts`，协议重试常量在 `services/workgroup/turnExecution.ts`。
