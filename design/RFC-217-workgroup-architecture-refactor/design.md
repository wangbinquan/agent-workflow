# RFC-217 工作组架构重构（design）

> 读序：proposal → 本文 → plan。所有 file:line 锚点为 2026-07-22 探查时点（HEAD `dd763f05`），实现期以实码为准。
> 用户已拍板的八项决策（两轮澄清，2026-07-22）：
> ①范围=后端本体+clarify 收口+前端+跨仓收敛（整体看）②允许语义纠偏 ③单引擎+分层抽象 ④运行时状态提升真列/真表 ⑤单 RFC 内分期多 PR ⑥round 概念拆分 ⑦双数据源=读侧单投影+写侧收紧 ⑧clarify 全量归一。

## 0. 现状问题地图（缩略）

详见 proposal §1。本文按目标态组织；每节先给「现状病灶 → 目标态 → 迁移路径」。

## 1. D1 后端目标模块布局

### 1.1 目标目录

```
packages/backend/src/services/workgroup/
├── constants.ts        # WG_*_NODE_ID / WG_PORT_* / 预算常量（从 workgroupLaunch.ts:49-51 迁出，斩断初始化环）
├── oracle.ts           # kind 判别单一出口：isWorkgroupTask / dispatchOf（见 §6）
├── state.ts            # EngineDbState + loadDbState + workgroup_task_state 编解码/CAS（见 §2）
├── engine.ts           # runWorkgroupEngine 主循环：领养 / reconcile / revive / race / 终态裁决接线
├── turnExecution.ts    # mint→attempt 重试→runHostNode→端口解析→persist 公共骨架（见 §1.3）
├── strategies/
│   ├── types.ts        # WorkgroupStrategy 接口
│   ├── leaderWorker.ts # lw：wake 规则 + barrier + leader 聚合 + 派单落库
│   └── freeCollab.ts   # fc：双轨 + 批量认领 + wg_task_results 结算
├── prompts.ts          # composeLeaderPrompt / composeMemberPrompt（薄壳，块渲染仍在 context.ts）
├── context.ts          # ← services/workgroupContext.ts 平移
├── wake.ts             # ← services/workgroupWake.ts 平移（纯函数性质不变）
├── lifecycle.ts        # ← services/workgroupLifecycle.ts 平移（转换表 + CAS + 游标）
├── rounds.ts           # ← services/workgroupRounds.ts 平移（→ 更名 budget.ts，见 §3）
├── room.ts             # ← services/workgroupRoom.ts 平移，双数据源唯一读投影（见 §4）
├── messages.ts         # ← services/workgroupMessages.ts 平移
├── launch.ts           # ← services/workgroupLaunch.ts 平移（去常量后只剩启动合成）
├── taskActions.ts      # route 下沉层：房间写操作编排（见 §5）
├── hooks.ts            # WorkgroupEngineHooks 类型 + buildWorkgroupHooks 实现（从 scheduler.ts:718-1110 迁出）
├── clarifyGate.ts      # ← lifecycle 中的反问预算/抑制 oracle 拆出（resolveWgClarifyAllowed 族）
└── askerKey.ts         # ← services/wgAskerKey.ts 平移
services/workgroups.ts          # 资源层 CRUD 原地不动（非运行时）
services/dynamicWorkflowRunner.ts / orchestratorAgent.ts  # 原地不动，仅消费 hooks 类型与去重后的重试块
```

约束：**目录内单文件 ≤800 行**；`services/workgroup/` 之外禁止 import `constants.ts` 以外的引擎内部模块（route 只准进 `taskActions.ts` / `room.ts` / `oracle.ts`）。

### 1.2 模块环斩断（P0，PR-1）

现状环（`workgroupRounds.ts:12-17` 自认）：`workgroupLaunch → services/task → scheduler → workgroupRunner → workgroupRounds → workgroupLaunch`，根源是节点 id 常量寄居 launch。处理：

1. 常量迁 `workgroup/constants.ts`（零依赖叶模块），全部 import 点改指（含 `taskQuestionDispatch.ts:951`、`wgAskerKey.ts:15` 等 clarify 侧）。
2. `.dependency-cruiser.cjs` 增加 `no-circular` 规则（severity: error）。若既有环不止这一个，白名单登记 + 独立 issue，不许静默放行新环。
3. `buildWorkgroupHooks` 迁 `workgroup/hooks.ts`：它只依赖 scheduler 的执行原语（`prepareNodeRunInjection` / `createIsoUnderLock` / `resolveFrozenRuntime` / `runNode`）。若其中有 scheduler 私有符号，先把该原语抽到中立模块（`services/nodeExecution.ts`）再迁，**禁止** hooks.ts import scheduler.ts（维持引擎不依赖调度器的既有铁律，`workgroupRunner.ts:12-16`）。
4. 顶层 const 禁令解除条件：`no-circular` 绿之后，`WG_*_NODE_ID` 才允许出现在顶层派生 const 里；在此之前保持函数体内引用约定。

### 1.3 turnExecution 公共骨架

四个 driver（`driveLeaderTurn:1641` / `driveAssignmentTurn:1942` / `driveBatchTurn:2153` / `driveMessageTurn:2454`）+ `dynamicWorkflowRunner.ts:303-309` 共享的骨架收敛为一个函数：

```ts
interface TurnSpec {
  role: WorkgroupProtocolRole            // leader | worker | fc_member
  nodeId: string; shardKey: string | null
  rerunCause: WgRerunCause               // 新枚举，见 §7 命名
  retryPolicy: {                          // 设计门 P2：重试策略是入参，不是骨架常量
    maxAttempts: number                  //   leader/assignment/batch = WG_PROTOCOL_RETRIES；message turn = 1（现状单发不重试，锁死）
    retryCause: WgRerunCause             //   常规 'wg-protocol-retry'（不计预算，RFC-187 §2.1）
  }
  composePrompt(state, attempt: TurnAttemptCtx): string   // attempt>0 时注入协议错误重提示
  hostOutputPorts: string[]              // wgHostRolePorts(...)
  clarify: { allowed: boolean; forbiddenReprompt: string }  // resolveWgClarifyAllowed 结果
  parse(outputs): ParsedTurn             // 端口解析 + 交叉校验（策略提供）
  persist(parsed, tx): Promise<void>     // 落库（策略提供）
}
async function executeTurn(args, state, spec): Promise<TurnOutcome>
```

骨架统一持有：mint（`mintNodeRun`）、attempt 循环（按 `retryPolicy`）、`## Protocol errors in your previous reply` + `fenceUntrusted` 重提示（现 4 处逐字复制：`1713-1719` / `2017-2023` / `2276-2282` / dw）、`clarify-forbidden` 重提示（现 3 处：`1761-1768` / `2064-2069` / `2323-2327`）、`FOLLOWUP_POLICY` 分支（现 3 处：`1781` / `2074` / `2329`）、失败收尾 `settleCardAfterFailure` 接线。**语义不变式**：重试计数、followup 分类、`wg-protocol-retry` 不计预算（RFC-187 §2.1）逐条保持，由既有 rfc186/187 测试锁证。

**dynamicWorkflowRunner 的收编边界**（设计门 P2 勘误）：dw 生成轮的重试是**持久化总预算** `generateAttempts`（DwState 字段）且 cause 用 `dw-generate`，与回合引擎的进程内 attempt 循环语义不同——dw **不套用 executeTurn 的循环**，只复用**重提示文案构造器与端口解析助手**（G6 锁的是文案定义点唯一，四处消费仍成立）。message turn 单发语义与 dw 预算语义各配行为锁测试。

### 1.4 策略接口

```ts
interface WorkgroupStrategy {
  mode: RoundedWorkgroupMode
  deriveWake(input: WakeInput): WakeSet          // 现 workgroupWake.ts 的 lw/fc 分支各归各家
  decideOutcome(input: WakeInput): WorkgroupOutcome
  buildTurnSpec(item: WakeItem, state): TurnSpec
  settleTurn(item, outcome, state, tx): Promise<void>  // 派单/批结算/消息回合各自后处理
}
```

- `wake.ts` 保留纯函数底座（切片、占用集、游标推导等共享原语），**模式分支迁入策略**；`deriveWakeSet` 变成 `strategyOf(mode).deriveWake` 的转发壳，保住既有表测。
- engine.ts 主循环模式无关：`loadDbState → strategy.deriveWake → executeTurn(spec) → strategy.settleTurn → race`。
- `roundedModeOf(...) ?? 'free_collab'`（`workgroupRunner.ts:717,787`）删除：`strategyOf(mode)` 对 `dynamic_workflow` **抛错 fail-loud**（scheduler 分流已保证不可达，抛错是防御，配回归测试）。
- dispatch 分流维持 `deriveWorkgroupDispatchFromConfig` 三态（`dw-generate` / `dw-execute` / turn-engine），但改读 `workgroup_task_state.dw_state_json` 的 phase（见 §2）。

## 2. D2 运行时状态真表 `workgroup_task_state`

### 2.1 现状病灶

`tasks.workgroup_config_json` 一列混装四类东西：冻结 config（有 zod）、`gate` 槽（无 schema，手抠 `=== true`：`routes/workgroupTasks.ts:422-425,632-676`、`workgroupRunner.ts:595-605`）、`dw` 槽（有 zod）、`wgPause` 槽（无 schema）。三种写法两入口：引擎 tx-merge（`workgroupRunner.ts:657-689`）、route 全量覆写（`routes/workgroupTasks.ts:668-678`）、`json_set`（`workgroupRunner.ts:399-410` / `dynamicWorkflowRunner.ts:105-112`）；并发吞写风险自认（`workgroupRunner.ts:394-397`）。

### 2.2 表设计（migration 0106）

```sql
CREATE TABLE workgroup_task_state (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  gate_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (gate_status IN ('idle','declared','awaiting_confirmation','approved','rejected')),
  gate_summary TEXT,            -- leader declare 时的总结（原 gate.summary）
  gate_rejected_comment TEXT,   -- 驳回意见（原 gate.rejectedComment）
  pause_reason TEXT,            -- 原 $.wgPause.reason（NULL=未暂停）
  dw_state_json TEXT,           -- 完整 DwState 检查点（原 $.dw 整槽），zod 校验单写者
  updated_at INTEGER NOT NULL
);
```

- **新表而非 tasks 加列**：避免撞冻结旧 migration 的 fixture 断言（[reference_new_column_breaks_frozen_migration_tests]），且 1:1 运行时状态与 tasks 业务列分离。
- **dw 整槽平移而非拆列**（设计门 P1 勘误）：`DwStateSchema` 是完整幂等恢复检查点——除 `phase` 外还有 `generateAttempts` / `rejectRounds` / `rejectionComment` / `generatedDef`（`shared/dynamicWorkflow.ts:51-63`），生成、确认、save-as、executing UI 都在读。只落 phase/attempts 两列会让 awaiting_confirm / rejected 任务迁移后不可确认、丢失驳回预算。故 dw **保留 JSON 形态**（它本就有 zod）整槽迁入 `dw_state_json` 列：达成「出 config blob + 单写者」目标，不损一字段。`workgroupDispatchOf` 读该列 `json_extract('$.phase')`（或解码后传参）。
- 行创建时机：工作组任务 startTask 时随插（`startTaskImpl` 同事务）；migration backfill 存量。
- **gate 状态机**（转换表 + CAS，对齐 `workgroupLifecycle.ts:39` 范式；含设计门 P1 补的两条边）：
  - `idle → declared`（leader declare 且门开；写 summary。对应现状 `driveLeaderTurn` 落 `declaredDone` 与 `openCompletionGate` 落 `awaitingConfirmation` 是**两笔分离写**的前半窗口）
  - `declared → awaiting_confirmation`（完成门 holder run 开启成功）
  - `awaiting_confirmation → approved`（人工确认；终态）
  - `awaiting_confirmation → rejected`（驳回；写 comment）
  - `rejected → declared`（leader 重新 declare；再走 holder 开启）
  - `rejected → idle`（**驳回被消费**：leader 下一轮不再 declare 而是继续干活/派单——现状 `workgroupRunner.ts:1467` 的 `rejected:false` 消费写。comment 随之清空，其内容已在该轮 prompt 注入过，`workgroupRunner.ts:916-923`）
  - 门关（花名册无人工成员 ∨ completionGate=off）时 declare 不进 gate 状态机，任务直接收尾（现行为，`resolveCompletionGate` 判据不变，RFC-207）。
  - 旧字段派生：`declaredDone ≡ gate_status ∈ {declared, awaiting_confirmation, approved}`；`awaitingConfirmation ≡ gate_status='awaiting_confirmation'`（wire 形状不变）。
- 写路径唯一化：`state.ts` 暴露 `casGateStatus(tx, taskId, {from[], to, patch})` / `setPauseReason(tx,…)` / `setDwState(tx,…)`——**全部 tx 入参**。尤其 dw：**confirm/reject 的 phase 翻转必须与任务 `awaiting_review` resume CAS、workflow-snapshot swap 同事务**（现 `resumeTaskWithAtomicSideEffects` 语义，设计门 P1：孤立 `setDwPhase` 会在 preflight 失败/CAS 落败时把任务搁浅在错误 phase，使确认端点拒绝重试）。`persistGate` / route 全量覆写 / `json_set` 三写法全部删除。
- **`workgroupConfigJson` 退化为纯冻结 config**：读侧 `WorkgroupRuntimeConfigSchema` strict 化（拒绝未知键，防止状态槽复活）；config PUT 仍改它（成员/开关变更，reload-merge 语义保留）。

### 2.3 backfill 与兼容

migration 0106 步骤（multi-statement，`--> statement-breakpoint` 分隔；journal `when` = 1786464000000+86400000 接合成轴）：

1. CREATE TABLE。
2. `INSERT INTO workgroup_task_state SELECT id, CASE 派生 gate_status…` —— 用 `json_extract(workgroup_config_json,'$.gate.*')` 映射，**按此优先级**：`approved=1→'approved'`；`awaitingConfirmation=1→'awaiting_confirmation'`；`rejected=1→'rejected'`；**`declaredDone=1 且以上皆非 →'declared'`**（设计门 P1：升级前任务可能恰在「declare 已落、holder 未开」的两写窗口被打断——映成 idle 会丢 leader 的完成声明，AC-12 违约；此快照必须迁成 declared 并配中断窗口 fixture 测试）；其余 `'idle'`。summary/comment/pause 同法带出；`$.dw` 整槽原样搬入 `dw_state_json`。范围 `WHERE workgroup_id IS NOT NULL`。野值兜底：gate 布尔非法组合落 `'idle'` + 迁移测试用真实历史形状 fixture 覆盖。
3. `UPDATE tasks SET workgroup_config_json = json_remove(workgroup_config_json,'$.gate','$.dw','$.wgPause') WHERE workgroup_id IS NOT NULL`（物理剥离，含 `autonomous` 残留键一并 `json_remove`——RFC-207 遗留尸体清扫）。
4. 断言式收尾：无（SQLite migration 无断言原语），由 upgrade-rolling 测试补（见 §12）；`_journal` 计数测试同步 bump（[reference_migration_bumps_journal_count_test]）。

存量 `interrupted` / `awaiting_review`（gate 开着）任务：backfill 后 `resumeTask` / confirm 端点读新表，行为不变——AC-12 用「旧 JSON 冻结库 → 0106 → resume/confirm」集成测试锁。

## 3. D3 round 概念拆分（语义纠偏 #1）

一词三职拆成三个显式概念；**DB 列名不动**（`workgroup_messages.round` / `workgroup_assignments.round` / `node_runs.wg_round`），改 TS/API 命名与派生函数：

| 概念 | 定义 | 载体 | 对外命名 |
|---|---|---|---|
| **budgetUsed** | maxRounds 预算消耗（口径 = 现 `countRoundsUsed`，含 `wg-protocol-retry` 豁免、superseded-killed-clarify 豁免等既有裁定） | `node_runs` 派生（`rounds.ts` → 更名 `budget.ts`） | room 聚合字段 `roundsUsed` → **`budgetUsed`** |
| **displayRound** | 展示轮次（lw：`wg_round` 权威列单调水位；fc：**显式无轮次**） | `node_runs.wg_round` / `workgroup_messages.round` | 聚合内 `displayRound`；fc 返回 `null` |
| **dispatchRound** | 派单卡所属 leader 波次（卡片锚定） | `workgroup_assignments.round` | TS accessor `dispatchRound` |

- fc：消息/卡片 round 现恒 0（RFC-209「fc 无波次语义」）——纠偏为 API 层显式 `null`（DB 仍存 0，读投影翻译），前端删掉「fc 也画 round 分隔线但永远不触发」的隐式路径。
- **行为不变式**：预算准入判定（lw wrap-up、fc 批量准入硬杀 `roundsUsed + items >= maxRounds`）逐字保持，由 `rfc209-round-ledger` 互 oracle 锁 + 新增「拆分前后 budgetUsed 逐场景等值」回归测试证明。
- 资源配置字段 `maxRounds` 名称不动（用户可见语义「轮次预算」成立）。
- wire 变更点（`roundsUsed`→`budgetUsed`、fc round null）需同步：前端 `lib/workgroup-room.ts` / room 组件、**e2e 内联响应类型与断言**（[reference_e2e_outside_workspace_typecheck]，先 grep `e2e/` 再动手）。

## 4. D4 双数据源：读侧单投影 + 写侧收紧（语义纠偏 #2）

- **读侧**：`workgroup/room.ts` 成为 assignment×node_run 联合派生的唯一 oracle。收编三处旁路：
  1. `routes/workgroupTasks.ts:307-462` room 端点自拼的 3 路查询 + runHistory/memberRuns 派生 → 全部移入 `room.ts`（route 只剩 parse+ACL+调用）。
  2. wake 输入装配已单源（`loadDbState`），保持。
  3. reconcile / 领养（`reconcileRunningAssignments:412`、engine 领养循环 `1155-1203`）读取的 run↔assignment 匹配谓词统一从 `room.ts` / `state.ts` 导出（RFC-215 已修 `nodeRunId` 直查，锁死不再按 shardKey 反猜）。
- **写侧**：`update(workgroupAssignments)` 全仓只允许出现在 `workgroup/lifecycle.ts`（CAS 原语）内；调用面只允许 engine settle 点与 `taskActions.ts`（deliver/cancel/config 迁移）。表级 grep 锁 + 变异实证。
- presence / DispatchCard / TurnCard 状态由 room 投影字段直出，前端不再自行组合两源（`lib/workgroup-room.ts` 的派生保留但输入改为投影结果）。

## 5. D5 route 下沉 `taskActions.ts`

`routes/workgroupTasks.ts` 七个肥 handler（`room:307` / `messages:464` / `deliver:543` / `confirm:622` / `dw-confirm:743` / `config PUT:963-1329` / `cancel:1331`）的业务体全部下沉：

```
taskActions.ts:
  postRoomMessage(actor, taskId, body)      // @mention 解析→派单卡→消息→广播→kick
  deliverAssignment(actor, taskId, asgId, form)
  confirmGate(actor, taskId, approve, comment)   // casGateStatus + resumeTaskWithAtomicSideEffects
  confirmDynamicWorkflow(...) / saveDwAsWorkflow(...)
  updateTaskConfig(actor, taskId, patch)    // 366 行巨兽拆为：校验 / 成员镜像 / 状态机迁移 / 清扫 四个私有步骤函数
  cancelAssignment(actor, taskId, asgId)
  pendingCount(actor)
```

- 消息写入唯一走 `buildRoomMessageRow`（`messages.ts`），5 处裸 insert（`:514/:584/:703/:1314/:1360`）消灭；`ConfigPatchSchema` 内联 switches 定义（`routes/workgroupTasks.ts:116-121`）改复用 shared `WorkgroupSwitchesSchema`。
- route 文件目标 ≤400 行：每 handler = parse（zod）+ actor + service 调用 + 错误映射。
- WS 广播随写操作进 service（`broadcastWg` 迁 `messages.ts` 或 `taskActions.ts`），route 不再手播。

## 6. D6 kind 判别单一 oracle

**正典放 shared 层**（设计门 P2 勘误：前端/共享代码也在做同类判别，且禁止前端 import 后端——backend-only oracle 无法满足全仓 G4；shared 已有 `schemas/task.ts::taskExecutionKind` / `dynamicWorkflow.ts` 两个跨包分类点，应收敛而非另立第二 oracle）：

```ts
// packages/shared/src/（并入既有分类点，不新造平行体系）
export function isWorkgroupTask(row: { workgroupId: string | null }): boolean
export function workgroupDispatchOf(row): WorkgroupDispatch | null   // 收编 deriveWorkgroupDispatch（改读 dw_state）
// packages/backend/src/services/workgroup/oracle.ts —— 薄包装：drizzle 行形状适配 + re-export
```

- 全仓（含前端）`workgroupId !== null` / `!= null` / `=== null` 判别（`scheduler.ts:576,594`、`routes/tasks.ts:680`、`stuckTaskDetector.ts:317`、`task.ts:3651,3733`、`routes/workgroupTasks.ts:233`、前端 `tasks.detail.tsx:227` 等）改走 oracle；grep 锁覆盖 backend+frontend，只放行 shared 正典文件、`oracle.ts` 包装与 `db/schema.ts`。
- `launchKind === 'workgroup'`（scheduledTasks 面）是**另一概念**（定时启动信封类型），保留枚举 switch，不并入 oracle；在 oracle.ts 顶注写明这条边界，防误收敛。
- `mode ===` 直接比较收进 `strategies/`；shared 层保留 `roundedModeOf` / `workgroupModeOf` 纯函数（前端也用）。

## 7. 命名正字法与协议值枚举化

- **正字法**：文件/服务/API 用全称 `workgroup`；「房间」概念（任务运行时聊天室的 UI 与聚合层）保留 `room`；`wg` 前缀仅限 **wire 冻结物**——协议端口 `wg_*`、合成节点 `__wg_*`、WS 帧 `wg.*`、DB 列 `wg_round`——一律不改（存量快照/历史行兼容）；代码内部**不再新造** wg 缩写符号，既有的随触碰改全称（`wgAskerKey.ts` → `workgroup/askerKey.ts`）。
- **rerun cause 枚举化**：`'wg-leader-round' | 'wg-assignment' | 'wg-message-turn' | 'wg-protocol-retry' | 'wg-gate' | 'dw-generate' | 'dw-gate'` 收进 `constants.ts` 的 `WG_RERUN_CAUSES` 常量对象 + 类型；字符串字面量散点（`workgroupRunner.ts:1697,1991,2245,2472,1446`、`dynamicWorkflowRunner.ts:60,63`）全改引用。clarify 侧 cause（`clarify-answer` 族）在 C 阶段同样枚举化（`clarifyRerunLedger.ts` 已有 `CauseClass`，补齐字面量出口）。
- **shardKey codec 收口**：`batch:` 已有 codec（`workgroupRuntime.ts:439-457`）；补 `msg:` codec（现散写 `workgroupRunner.ts:2478` 构造、`1173,1607` 手工 split），`wgClarifyAskerKey` 改消费 codec。grep 锁：`services/` 内禁止对 shardKey 使用裸 `.split(':')`。
- **WG_NUDGE_BODY 双职拆分**：空转计数不再用消息体字符串相等（`workgroupWake.ts:132-140`），改在 system 消息行上落结构化 `kind:'nudge'`（`workgroup_messages.kind` 枚举加值，migration 0106 顺带把存量 body 精确匹配的行 UPDATE kind）；文案自由化。

## 8. D7 clarify 全量归一（四阶段）

### 8.1 C-A 读侧统一 + 写侧补齐 + 双盲调修复（先行，不动 DB）

- 读侧全部切 `clarify_rounds`：`listClarifySummaries`（`clarify.ts:292`）、detail、agent 队列投影（`clarifyQueue.ts` 已统一，核对）等逐点迁移；遗留表暂保双写（本阶段职责是「读单源」）。
- **写侧补齐**（设计门 P1：`lifecycleRepair/options-C1.ts` / `options-S2.ts` 今天**只 UPDATE `clarify_sessions`**——正是同 ID 双表分歧的制造源）：全部「只写遗留表」的修复路径改为同事务双写统一表，从此双表对同 ID 不再新增分歧。
- 答题路由双盲调（`routes/clarify.ts:342-361` 同时调 self/cross broadcast）修复：由 `clarify_rounds.kind` 精确路由单 broadcast。
- baseline 对称测试（`clarify-baseline-*` / `cross-clarify-baseline-*`）改断言统一读路径。

### 8.2 C-B T17 落地（migration 0107）

1. **字段级 reconcile 而非 INSERT OR IGNORE**（设计门 P1：同 ID 行可能双表分歧——8.1 之前的历史修复只动过遗留表，OR IGNORE 会把陈旧统一行原样保留，DROP 后修复永久丢失）：
   - 同 ID 皆在：**生命周期字段以遗留表为准 UPDATE 统一表**（status / answers / answered_at / directive——迁移时点遗留表仍是读权威），**统一表独有字段原样保留**（协作草稿、逐题归属等 RFC-099 列）。
   - 仅遗留表有：INSERT（映射沿用 migration 0031 的 INSERT FROM 子句）。
2. directive 垫片收编：把遗留表上仍为 `'stop'` 且 `task_node_clarify_directives` 无对应行的，写入 node/shard 级 directive 行（**收编 `clarifyMigration.ts:160` 垫片逻辑为一次性 migration**）；同法收编垫片另一半（`dispatched_at` 丢答案 reconcile）。
3. `DROP TABLE clarify_sessions; DROP TABLE cross_clarify_sessions;`
4. `clarify_rounds` 表重建：**只剥 `question_scopes_json` 休眠列**（`schema.ts:1666-1667`）。**`directive` 列保留**（设计门 P2 勘误：它是 **round 级处置记录**——`fetchDesignerParkEntries` 靠 `directive='continue'` 过滤已被 stop 的具体轮次；node/shard 级开关是「最新拨杆」，无法表达「旧轮已终止」，若只留开关，后来的 continue 会复活旧 stop 轮的 designer 行）。
5. 代码侧：双写删除（`clarify.ts:185+208` / `crossClarify.ts:207` / `clarifySeal.ts:347-349`）、`clarifyMigration.ts` 整删（boot 接线一并拆）、dual-write 一致性测试家族退役改为「单表不变式」测试。
- **directive 收敛后的终态 = 两个语义不同的真理源**（从 4 处收到 2 处）：`task_node_clarify_directives` = node/shard 级「还要不要问」开关（RFC-122/207 语义不变：per-shard 优先、回落节点级）；`clarify_rounds.directive` = 单轮回答时的处置记录。二者职责在 schema 注释里写明，防止再次误并。

### 8.3 C-C self/cross 服务合并

- `clarify.ts`（753）+ `crossClarify.ts`（721）→ `services/clarify/service.ts` kind 泛化：`createClarifyRound(kind, …)`、DTO `rowToRound` 单份、broadcast `broadcastClarify(kind, event, …)` 单份（现 3+4 个成对复制：`clarify.ts:549-661` vs `crossClarify.ts:583-688`）。
- status 枚举归一：统一表 4 值已并存（`schema.ts:1637`），读侧按 kind 的 CHECK 约束（`:1599`）保留；`canceled`/`abandoned` 语义差异在 DTO 层归一为 `terminatedAs` 判别字段，前端消费点同步。
- `clarifyFallback.ts`（RFC-026 inline 降级，纯函数、正交）**移出 clarify 命名空间**改名 `sessionModeFallback.ts`，不参与合并。
- `dispatchTaskQuestionsLocked`（620 行单函数）与 `autoDispatchClarifyRound`（~500 行）**本 RFC 只做文件内拆函数**（borrow 三态解析 / frontier 计划 / 锁编排各自成模块级私有函数），跨模块锁契约（A≻B 顺序、`RECOVERABLE_DISPATCH_CONFLICTS` 分类）**不动**——它们是 RFC-128/131/133 的活语义，重排锁序超出「纠偏」尺度。conflict code 15 个字面量枚举化（常量对象），分类集合改引用枚举。

### 8.4 依赖与顺序

C-A 不依赖任何 D；C-B 依赖 C-A（读已单源才能删表）；C-C 依赖 C-B（合并时不想再背双写）。C 线与 D 线（引擎）无代码耦合，可穿插交付，但**同 session 内串行**（多 session 并发风险，见 §13）。

## 9. D8 前端

### 9.1 房间拆分

```
components/workgroup/room/
├── WorkgroupRoom.tsx      # 壳：布局 + 数据下发（≤400 行）
├── RoomComposer.tsx       # draft/caret/@mention 6 state + 3 effect 全部下放（打字不再重渲全房间）
├── RoomTimeline.tsx       # timeline.map 三分支 + 回底按钮
├── RoomSideCards.tsx      # 右栏 6 卡拆件（成员/日志/暂停/门/fc 清单/组信息，可再细分文件）
├── DispatchCard.tsx / TurnCard.tsx / DeliverFormDialog.tsx / FcTaskListCard.tsx  # 现内联子组件出文件
└── RunStatusRow.tsx       # 运行日志行/TurnCard/DispatchCard 共用的 run 状态+时长行（第三份实现收敛）
```

- 数据流：`tasks.detail.tsx` 持有唯一 `useQuery(workgroupRoomKey)`（现 3 处声明：`tasks.detail.tsx:233` / `WorkgroupRoom.tsx:91` / `DynamicWorkflowPanel.tsx:53`），子组件经 props 接 data+refetch；15s 轮询与 WS 失效策略不变（`useTaskSync` 规则表零改动）。
- `node-runs` 共享缓存键维持（有意复用，注释已明示）。
- mention listbox 保持自写（多行 textarea 无法进 `Select`），但抽 `useListboxNavigation` 到 `hooks/`（active-descendant + 键盘导航），room 与未来复用者共用。

### 9.2 定义编辑器与原语对齐

- `useOwnedEditScope`（`workgroups.detail.tsx:84`）提炼 `hooks/useOwnedEditScope.ts` + 单测（乐观保存/歧义和解状态机是通用全量替换资源原语）。
- 原语违规修复（仅「映射到既有原语/最小扩展」档）：面板错误裸 span → `<ErrorBanner>`（`WorkgroupContextPanel.tsx:337,406` / `DynamicWorkflowPanel.tsx:318,360` / `WorkgroupMemberCards.tsx:51,89`）；`Card` 加 `title/actions` 可选 prop（最小扩展，惠及全仓），`.workgroup-room__side-title` 13px 硬编码淘汰；presence/类型 chip 统一 `<StatusChip>`/既有 chip 体系；`DynamicWorkflowPanel` 盗用 `.workgroup-room__*` class（`:162-290`）换中性 `.dw-panel__*` 命名空间；i18n 缺口修复（raw status 直出：`WorkgroupRoom.tsx:698,1129`）。
- **不做**（归原语审计路线）：`DialogActions` / `DescriptionList` / `QueryState` 迁移扩面。

### 9.3 前端测试

vitest：composer 下放后的重渲隔离断言（draft 输入不触发 timeline 重渲，用 render-count probe）、RunStatusRow 三消费点契约、room key 单 owner 源码锁、`workgroup-room` 纯函数测试随文件平移。视觉基线：settings 不涉及；若 e2e 快照场景含房间页则按 [reference_visual_baseline_stale_binary] 流程刷新。

## 10. 守卫矩阵（表级，每条变异实证）

| # | 锁 | 实现 |
|---|---|---|
| G1 | no-circular | dependency-cruiser 规则 + **接线**：`bun run depcheck` 加入 CI workflow 与 pre-push 门槛（设计门 P2：`package.json:29` 已有 depcheck 脚本但 `lint` 与 `ci.yml` 均不调它——只加规则不接线等于没锁） |
| G2 | route 禁裸写 | grep：`routes/` 内禁 `insert(workgroupMessages` / `insert(workgroupAssignments` / `update(tasks).set({ workgroupConfigJson` |
| G3 | 退役槽全禁 | grep：`declaredDone` / `awaitingConfirmation` 字面量只允 `workgroup/state.ts` + 测试；**并禁一切对 `workgroupConfigJson` 的 `$.gate` / `$.dw` / `$.wgPause` 键访问与 `json_set(workgroup_config_json` 模式**（设计门 P2：只锁两个 gate 布尔挡不住状态槽复活），migration SQL 显式白名单 |
| G4 | kind oracle | grep：`workgroupId !==` / `workgroupId !=` / `workgroupId ===` 覆盖 backend+frontend，只允 shared 正典 / `oracle.ts` / `schema.ts` |
| G5 | mode 收敛 | grep：`mode === '` 于 `services/workgroup/` 只允 `strategies/` 与 `oracle.ts` |
| G6 | 骨架去重 | grep：`Protocol errors in your previous reply` 字面量全仓唯一定义点 |
| G7 | shardKey codec | grep：`services/` 内 shardKey 相关 `.split(':')` 禁令（codec 文件白名单） |
| G8 | clarify 单地层 | grep：`clarify_sessions` / `cross_clarify_sessions` 标识符归零（migration SQL 除外） |
| G9 | 房间 query 单 owner | 前端源码锁：`workgroupRoomKey` 的 `useQuery` 声明唯一 |

守卫落一个文件族 `packages/backend/tests/rfc217-architecture-locks.test.ts`（+前端 `rfc217-locks.test.tsx`），表驱动；banned 表级不做文件级散点（[feedback_grep_locks_before_push]）。

## 11. 失败模式

- **初始化环触发**：搬家中途某 PR 引入新环 → `no-circular` 红 + `build:binary` smoke 红（PR-1 后每个结构 PR 必跑）。回退单 PR 即可。
- **migration backfill 失真**：gate JSON 形状野值（历史手写状态）→ backfill CASE 落 `'idle'` 兜底 + 迁移测试用「真实历史形状 fixture」（从 demo DB 采样脱敏）覆盖；0106/0107 各配 upgrade-rolling 断言。
- **双写删除早于读切换**（C-B 先于 C-A 的次序事故）→ plan 依赖硬编码；C-B PR 的前置检查脚本 grep 读侧引用归零才允许删表。
- **wire 改名漏改 e2e**：`budgetUsed` / fc round null → 先 `grep -rn roundsUsed e2e/ packages/frontend` 出清单再动（[reference_e2e_outside_workspace_typecheck]）。
- **并发 session 冲突**：结构大搬家 PR（PR-1/PR-3）期间他人在旧路径上开发 → 搬家 PR 当日完成当日推送；提交按精确 pathspec；发现真实冲突停下问用户（CLAUDE.md 多人协作原则）。
- **性能回退**：turnExecution 抽象引入每 turn 额外分配可忽略；room 投影收口后 room 端点仍 3 查询合 1 次派生，无 N+1 引入（room.ts 保持批量查询形态）。

## 12. 测试策略

1. **真子进程 e2e 铁律**：rfc186/187 工作组 e2e 家族全程保绿、不 stub 化（e2e 审计的 meta 教训：stub `runHostNode` 曾系统性掩盖 P0）。引擎结构 PR（PR-3/4/6）每个都跑全量 backend + e2e。
2. **策略表测**：`deriveWake`/`decideOutcome` 迁入策略后，`workgroupWake` 既有表测逐条平移（断言不变），fc/lw 各自新增策略级表测。
3. **turnExecution 单测**：fake hooks 驱动，覆盖 attempt 重试 / clarify-forbidden / followup 三分支 ×（成功/耗尽）矩阵——这是现 4 处复制的行为并集，先写「并集快照」测试再收敛，保证去重不改语义。
4. **等值回归**：round 拆分（§3）与 gate 真表（§2）各配「旧实现 vs 新实现逐场景等值」测试（budgetUsed 口径、gate 派生字段），红→绿留档。
5. **migration 测试**：0106/0107 各配冻结旧库 fixture（含 gate 各状态、双表尾数据、interrupted 任务）→ 迁移 → resume/confirm/列表可用断言；`_journal` 计数测试 bump ×2。
6. **守卫变异实证**：§10 每条锁提交前做一次反向变异（人为放一个违规样本证明测试红）。
7. **门槛**：每 PR `bun run typecheck && bun run lint && bun run test && bun run format:check` + 结构 PR 加 `build:binary`；push 后查 CI（[feedback_post_commit_ci_check]，按本人 sha 查——[reference_shared_ref_ci_attribution]）。

## 13. 与现有模块的耦合点（改动波及面清单）

| 模块 | 波及 | 说明 |
|---|---|---|
| `scheduler.ts` | −~390 行 | hooks 外迁；分流三元改读 oracle + dw_state phase；其余调度语义零改动 |
| `services/task.ts` | 小 | startTaskImpl 增 workgroup_task_state 插行；rowToSummary/Detail 改 oracle |
| `taskQuestionDispatch.ts` / `clarifyQueue.ts` / `clarifySeal.ts` | 中 | WG 常量 import 路径、shard codec、C 阶段读侧切换 |
| `autoResume.ts` / `stuckTaskDetector.ts` / `limits.ts` | 小 | oracle 化 |
| `routes/tasks.ts` | 小 | `:680` 特判改 oracle |
| shared `workgroupRuntime.ts` / `dynamicWorkflow.ts` | 中 | config strict 化、dispatch 改签名（读 dw_state phase 入参）、budgetUsed 命名 |
| WS `ws.ts` | 零 | 帧不变 |
| 前端 `useTaskSync.ts` | 零 | 规则表不变（room key 失效逻辑照旧） |
| e2e | 中 | wire 改名点 + 房间选择器随组件拆分调整 |

## 14. 明示的行为变化清单（「允许语义纠偏」的全部落点）

1. gate 并发写：route 全量覆写消灭 → 并发 config PUT 不再可能吞掉引擎的 gate/pause 写（原风险自认注释删除）。
2. round：API `roundsUsed`→`budgetUsed`；fc 的 round 对外显式 `null`（原恒 0）。
3. dynamic_workflow 误入回合引擎：静默按 fc 计数 → fail-loud 抛错。
4. nudge 空转计数：消息体字符串相等 → 结构化 kind（文案改动不再重置计数语义；存量 nudge 行 migration 打 kind）。
5. clarify 答题广播：双盲调 → 按 kind 单发（消费者收到帧减半，前端失效逻辑不变）。
6. clarify 终止态 DTO：`canceled`/`abandoned` 对外归一为 `terminatedAs`（原两字段并存的消费点简化）。
7. 其余一切（预算准入、双轨、fan-out、协议重试、清算）**行为保持**，由等值测试证明。
