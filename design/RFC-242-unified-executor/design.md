# RFC-242 · 技术设计 —— 统一执行器与子工作流 / 工作组调用节点

- 状态：Draft **v2**（v1 经设计门一轮：2 P0 + 6 P1 + 14 P2，全部折入本版；
  门记录见 `./design-gate-2026-07-31.md`。配套 `proposal.md` 决策 D1–D16 及本轮勘误。）
- 本文所有 file:line 锚点基于 2026-07-31 的 main（RFC-241 合入后）。实现期若行号漂移，以符号名为准。

## 0. 摘要

三层交付：

1. **统一执行器**（`services/execution/`）：`ExecutionRef{kind,id}` 上的
   `startExecution / getExecutionOutcome / watchExecutionTerminal / cancelExecution`
   四原语 + 引擎分流注册表。收编 `POST /api/tasks`（含 multipart 分支）、
   `POST /api/agents/:id/tasks`、`POST /api/workgroups/:id/tasks`、`scheduleLaunch`
   五个既有调用面，wire 零变化。
2. **父子任务基建**：`tasks.parent_task_id / parent_node_run_id / invocation_depth /
   ref_closure_json` 与 `node_runs.child_task_id`；引用闭包启动冻结 + 环检测 + 深度守卫 +
   全局活跃子任务限额（可放行者扫描制）；跨任务活性证据（RFC-230 `delegated` 的
   child-task 扩展）；取消/删除/GC/恢复级联与人工门等待的计时扣除。
3. **两种新节点 kind**：`call-workflow` / `call-workgroup`。执行语义 = 把 RFC-130
   「wrapper 嵌套隔离」模式跨任务边界推广：调用节点在父视角与一个 agent 节点同构——
   `createIsoUnderLock` 派生 iso → 子任务以该 iso 为 canonical 运行 → 终态后
   `mergeBackAndSettle` 合回父 canonical → 输出回填端口。合并/冲突/replay/GC 机制全部复用。

## 1. 统一执行器（PR-1，行为零变化）

### 1.1 契约（`packages/backend/src/services/execution/types.ts`）

```ts
type ExecutionKind = 'workflow' | 'agent' | 'workgroup';   // 与 taskExecutionKind() 同域
type ExecutionRef = { kind: ExecutionKind; id: string };

type ExecutionInvoker =
  | { type: 'user' }                                        // HTTP 启动（actor 即 owner）
  | { type: 'scheduled'; scheduledTaskId: string }          // 定时启动
  | { type: 'node'; parentTaskId: string; parentNodeRunId: string;
      invocationDepth: number };                            // 调用节点（PR-3/4 启用）

type StartExecutionRequest = {
  ref: ExecutionRef;
  invoker: ExecutionInvoker;
  // kind 专属载荷原样透传（zod 校验后的 StartTask / StartAgentTask / StartWorkgroupTask）。
  // 统一层不重造输入 schema —— 三种 wire 保持不变（D10），统一的是动词与生命周期。
  payload: StartTask | StartAgentTask | StartWorkgroupTask;
};

type ExecutionOutcome = {
  taskId: string;
  status: TaskStatus;                                       // shared/schemas/task.ts:9
  terminal: boolean;
  outputs: Record<string, { content: string; kind: string | null }>; // §1.3 投影
  error?: { summary: string | null; message: string | null; failedNodeId: string | null };
};
```

对外函数（`services/execution/executor.ts`）：

- `startExecution(db, actor, req, deps): Promise<Task>` —— 按 `ref.kind` 分发到适配器：
  - `workflow` → 现 `startTask`（`services/task.ts:1336`）前的 `assertWorkflowLaunchable`
    （`services/taskLaunchGate.ts:30`）链；**multipart 上传分支
    `handleMultipartTaskStart`（`routes/tasks.ts:204-206` → `services/launchMultipart.ts`）
    同样收编**——其 service 层对 `startTask` 的直调改经执行器，上传清理路径不变；
  - `agent` → 现 `startAgentTask`（`services/agentLaunch.ts:320`）全链（JSON 与 multipart）；
  - `workgroup` → 现 `startWorkgroupTask`（`services/workgroup/launch.ts:179`）全链。
  适配器就是既有函数改名收编——**不改校验顺序、不改错误码/状态码、不改副作用**；
  `routes/tasks.ts:198`、`routes/agents.ts:229`、`routes/workgroups.ts:174`、
  `services/scheduleLaunch.ts:47-72` 的 kind-switch 全部换成 `startExecution`。
  源代码文本锁：routes 层与 scheduleLaunch、launchMultipart 不得直呼 `startTask` /
  `startAgentTask` / `startWorkgroupTask`（allowlist 只留执行器适配器自身）。
- `getExecutionOutcome(db, actor, taskId): Promise<ExecutionOutcome>` —— §1.3。
- `watchExecutionTerminal(taskId, {signal, pollMs}): Promise<ExecutionOutcome>` —— §1.4。
- `cancelExecution(db, taskId, opts?)` —— 委托 `cancelTask`（`services/task.ts:2095`）；
  PR-2 起附带子任务级联与级联标记（§4.3）。

### 1.2 引擎分流注册表

`scheduler.ts:620-664` 的 workgroup 分流（`runWorkgroupEngine` / `runDynamicWorkflowGenerate` /
`runScope`）改写为查注册表：

```ts
// services/execution/engines.ts
resolveTaskEngine(task): { kind: 'dag' } | { kind: 'workgroup-turns' } | { kind: 'dw-generate' }
```

内部仍用 `taskExecutionKind`（`shared/schemas/task.ts:456`）+ `deriveWorkgroupDispatch`
（`shared/dynamicWorkflow.ts:101-107`）；**不迁移引擎本体**（D3）。dw 的
`dw-phase-invariant` fail-fast（`scheduler.ts:626-641`）原样保留。

### 1.3 统一结果投影（含工作组最小输出，D4）

`getExecutionOutcome` 按 kind 投影 `outputs`：

- **workflow**（含 dw-execute 相位的工作组任务）：读 `output` 节点的 io-virtual run
  （`scheduler.ts:2720-2774` 铸 `cause:'io-virtual'` 行并写 `node_run_outputs`，
  `db/schema.ts:1388-1412`）。**行选取显式复用 `pickUpstreamSourceRun`
  （`services/freshness.ts:179-213`）口径**：done + `parentNodeRunId IS NULL` +
  最高 iteration + 同 iteration 内 `isFresherNodeRun`（iteration 窗口取 ∞，即任务全程
  最新交付代），与任务内下游读取语义一致；review 迭代多代行 / loop 多 iteration /
  fanout 子行排除由该口径统一保证，测试锁多代行矩阵。跨 output 节点重名端口按节点 id
  字典序后者胜出并带 warning（新定义由 §5.4 校验在 validate-draft 提示、launch 门强拦，
  历史快照按此兜底）。**不消费 `definition.outputs`**——它无运行时消费者
  （`workflow.validator.ts:354-355`）。
- **agent**：宿主快照唯一主节点 `__agent_main__`（`services/agentLaunch.ts:54-61`）
  按同一 `pickUpstreamSourceRun` 口径选行，取其 `node_run_outputs` 全量端口。
- **workgroup**（turn-engine 两模式）：单端口 `result`，载体见 §6.4：优先
  `workgroup_task_state.result_message_id`（本 RFC 新列）指向的房间消息 `body_md`；
  历史任务回退 `gate_summary`（lw）/ 空串 + warning（fc）。
- 非 done 任务：`outputs = {}`；`error` 从 `tasks.error_summary/error_message/failed_node_id`
  投影（`db/schema.ts:871-873`；仓内约定 summary=人话、message=机器码，照实透传）。

投影为纯函数 `projectExecutionOutcome(taskRow, rows...)`（shared 可测），DB 读在 service。

### 1.4 终态观察（新 seam：`executionWatch`）

现有 `registerTerminalTaskHook`（`services/lifecycle.ts:490-494`）**不可复用**：单槽覆盖式、
仅 `done|canceled` 触发（`lifecycle.ts:472-480`）、同步异常吞没——漏掉 `failed/interrupted`。
新增独立多播注册表：

- `services/execution/executionWatch.ts`：`watchTaskTerminal(db, taskId): {promise, dispose}`。
  **注册时立即同步读一次 task 行**——已终态直接 resolve（堵「子任务闪败早于注册」的
  空窗）；否则挂入 `Map<taskId, Set<resolver>>` 并启动 poll fallback（默认 20s 重读；
  行不存在视同终态，resolve 为 `child-row-missing` 标记，供 §4.2 第四分支消费）。
- 发射点：`setTaskStatus` / `trySetTaskStatus`（`services/lifecycle.ts:328/503`）CAS 落库后、
  现 hook 调用点旁，对 **全部四个任务终态**（done/failed/canceled/interrupted）发射
  `notifyTaskTerminal(taskId, to)`。发射是 post-commit、try/catch 包裹、不影响状态写，
  与 RFC-097 s14 直写守卫无交集（不新增状态写点）。
- 既有 `terminalTaskHook`（`cli/start.ts:643-645` 的 `sealOpenHumanGatesForTask`）不动。

PR-1 交付该 seam 与单测；PR-3 的调用节点是第一个真实消费者。

## 2. 数据模型与迁移

**PR-2**（`01XX_rfc242_parent_child_tasks.sql`）：

```sql
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE tasks ADD COLUMN parent_node_run_id TEXT;       -- 软链接，不设 FK（node_runs 级联序）
ALTER TABLE tasks ADD COLUMN invocation_depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN ref_closure_json TEXT;         -- §3 冻结闭包；无调用节点为 NULL
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
ALTER TABLE node_runs ADD COLUMN child_task_id TEXT;        -- 调用节点行 → 子任务
CREATE INDEX idx_node_runs_child_task ON node_runs(child_task_id);
```

**PR-4**（`01XX_rfc242_workgroup_result_anchor.sql`）：

```sql
ALTER TABLE workgroup_task_state ADD COLUMN result_message_id TEXT;   -- §6.4 结果锚
```

- `space_kind` 增加值 `'inherited'`（列为 text；zod 联合在 `shared/schemas/task.ts` 扩展）。
  语义：工作区由父任务的调用节点 iso 提供，本任务不拥有磁盘空间。消费点见 §4.4/§7.3。
- wire：`TaskSchema` / 列表投影（`shared/schemas/task.ts:346-446`）新增
  `parentTaskId / parentNodeRunId / invocationDepth`；`NodeRunSchema` 新增 `childTaskId`。
  **`ref_closure_json` 永不进 wire**（`TaskSchema` 白名单现不含，加回归锁），闭包内容
  只以子任务自身 `workflowSnapshot` 的既有回显面暴露给**子任务成员**（见 §11 决策记录）。
- `taskExecutionKind`（`shared/schemas/task.ts:456`）不变——父子链接是正交维度。零回填。

## 3. 引用闭包：冻结、环检测、深度与限额（PR-2 基建，PR-3/4 消费）

### 3.1 冻结（D9）

父任务启动时（`startTaskImpl`，`services/task.ts:1362`）若定义含 call 节点：

1. `collectExecutionRefs(defn)`（shared 纯函数）提取
   `{workflows: Set<selector>, workgroups: Set<selector>}`（selector 为 name，见 §5.1）。
2. 广度优先解析闭包：每个被引工作流读当前行（`getWorkflow`，`services/workflow.ts:92`），
   递归提取其 call 节点；每个被引工作组以
   `buildWorkgroupRuntimeConfig(group, '')`（`services/workgroup/launch.ts:98-129`）的
   资源快照部分冻结（goal 调用时渲染后注入，§6.3；`goal` 无 min 约束，空占位合法，
   `shared/schemas/workgroupRuntime.ts:73`）。**按需 lazy：只读被引 id，不全量加载。**
3. 冻结物写 `tasks.ref_closure_json`：
   `{ workflows: {name: {id, version, definition}}, workgroups: {name: {id, version, configTemplate}} }`。
4. **环检测**：闭包走查中路径上重现同一工作流 → 启动 422 `workflow-call-cycle`。
   **issue 只携带资源 id 与「本定义内的可见段」**——不含 name、不含超出发起者自有定义的
   路径细节（RFC-099 D1 回显纪律，`services/resourceRefs.ts:113-121`）。
5. 子任务启动时从父闭包取自己的 definition 与闭包子集写入子任务
   `workflowSnapshot` / `ref_closure_json` —— 递归形态统一，孙代不回读资源行。

不含 call 节点的定义零走查、`ref_closure_json` NULL —— 存量路径 byte-compat。

### 3.2 深度与限额（D7；v2 按 P0-1 重写放行规则）

- 深度：`invocation_depth = parent + 1`，超 `maxInvocationDepth`（配置，默认 3）→
  调用节点失败 `invocation-depth-exceeded`（防御闸；环检测已拦无限深）。
- **全局活跃子任务限额**（`services/execution/childBudget.ts`，daemon 级）：
  - **计数口径**：`parent_task_id` 非空且状态 ∈ `{pending, running}` 的任务。
    `awaiting_review / awaiting_human / interrupted` **不占额度**（人工门/中断不耗算力；
    resume 回 running 时直接计入、不重新排队——突发超额是接受的取舍，文档化）。
  - **簿记**：挂在任务状态转移层（`setTaskStatus`/`trySetTaskStatus` post-commit，与
    §1.4 同点），以「已计数 taskId 集合」保证增减幂等；boot 从 DB 重建。杜绝
    resume/retry 入活绕计数与双减漂移。
  - **放行规则（重写）**：申请时计算
    `effective = |counted ∖ ancestors(requester)| `，`effective < maxActiveChildTasks`
    （配置，默认 8）即放行。**不满足则入等待集；每次计数变化事件驱动地扫描整个等待集，
    放行任意一个此刻满足条件者**（FIFO 只作为「同时可放行者」之间的公平序，不构成
    队头阻塞）。祖先豁免保证：等待者只受非祖先活跃子任务约束，而非祖先子任务可独立
    终态化 ⇒ 必有前进。v1 记录已知残余：深树可反复插队造成浅层等待者饥饿——等待超
    60s 记 lifecycle alert + 指标，不做优先级老化（登记后续项）。
  - 等待挂 abort signal；等待不持有任何锁（§7.1 约定）。

## 4. 生命周期横切（PR-2）

### 4.1 活性证据（RFC-230 扩展）

`classifyRunLiveness`（`services/runLiveness.ts:123`）现判定序：pid→process；
wrapper/有子行→delegated；否则 none。**新增最高优先的 child-task 证据**：

- `node_runs.child_task_id` 非空 → `delegated` 证据（`livenessSourceOfKind` 对
  call kinds 取 `'delegated'`，`runLiveness.ts:94-112` 穷尽 switch 扩展）：
  子任务**非终态** → alive（reason `child-task-active`）；子任务已终态或行缺失 → 该证据
  不判活（落回原判定序）——父驱动脱离 + 子已终态时，调用行照常被 `orphanReconcile`
  （`services/orphanReconcile.ts:98`）收成 interrupted，收尾由父 resume 的 R 路径完成（§6.2）。
- `LivenessReason` 闭集（`runLiveness.ts:71`）加 `child-task-active`。
- `stuckTaskDetector`：S5（`services/stuckTaskDetector.ts:383-416`）对 `child_task_id`
  行的 freshness 委派为子任务事件新鲜度，**且子任务处于 `awaiting_*`（或存在开门
  holder 行）时直接判非 stuck**——人工门合法静默数日不告警（对齐任务级静默门
  `stuckTaskDetector.ts:311-314` 对 awaiting 任务的既有豁免思路）。S3 不需改。

### 4.2 恢复与重挂（re-attach；v2 折入 P1-2/P1-3/P2-1/P2-2/P2-8）

- **boot**：`reapOrphanRuns`（`services/orphans.ts:98-171`）照常把父任务与调用行翻
  interrupted（子任务作为独立 running 任务同样被翻）。零改动。
- **resume 父任务**（`resumeKick`，`services/task.ts:2237`）：
  `selectResumeRollbackTargets`（`task.ts:668`）**排除 `child_task_id` 非空的行**
  （调用行无 canonical 写入可回滚；其 interrupted 行留给 adoption）。既有任务级
  `replayPendingMerges`（`scheduler.ts:2418`）**不排除 call 行**——pending-merge 的
  调用行由它统一完成 M（按 `iso_node_tree` replay），行终态化仍归 adoption。
- **adoption**（调度器 call 分支入场）：**锚定本次被派发的行本身**（fanout 场景以
  `parentNodeRunId + shardKey` 定位，绝不用「该 node 最新行」跨分片互认）。分支：
  1. 行含 `child_task_id`，子任务**非终态** → 复用该行重挂等待（不 mint）。行状态若为
     interrupted，用 `setNodeRunStatus({allowedFrom:['interrupted'], to:'running'})`
     逃生舱复位（wrapper/fanout 恢复复位先例：`scheduler.ts:4522-4532 / 5425-5432 /
     5907-5913`）；**call 行 adoption 禁走 mint**（mint 咽喉的
     `abandonSupersededMergeStates`（`services/lifecycle.ts:708`）会作废子任务 canonical
     所在 iso 世代）——加源代码文本锁。
  2. 子任务 `interrupted` → 尝试 `resumeTask(child)`；**失败后必须重读子状态**：
     已非终态（他人已恢复：autoResume 候选谓词与本分支同集，`services/autoResume.ts:61-69`；
     或用户手点）→ 落回分支 1 重挂；仍 interrupted 且不可恢复（如 410
     `task-worktree-missing`）→ 节点 failed `child-interrupted`。**不依赖
     `autoResumeOnBoot`**（默认 OFF，`cli/start.ts:756-780`），父驱动子恢复。
  3. 子任务已终态 → 进入 R（下）。
  4. **子任务行缺失**（被删）→ 节点 failed `child-deleted`。
- **R（replay 收尾）按 `merge_state` 分段**（修 P1-3「二次 mark-merged 打非法转移」）：
  - `isolating`（子 done 但终态快照未落）→ `snapshotNodeIsoFinal + persistIsoNodeTree`
    → M → F → 行 done；
  - `pending-merge` → M（若任务入口 `replayPendingMerges` 已完成则跳过——以当前
    merge_state 重读为准）→ F → 行 done；
  - `merged` → 仅 F（幂等：`onConflictDoUpdate` + 归档覆写）→ 行 done；
  - `conflict-human / merge-failed / abandoned` → 沿既有语义（park / failed / 已被取代）。
  子任务非 done 终态 → 跳过 F/M，按失败映射收行（§6.2）。
- **重试调用节点**（`retryNode`，`task.ts:2756`）：目标为 call 行且旧子任务非终态 →
  先 `cancelExecution(child)`（级联、带级联标记）；`abandonSupersededMergeStates` 在
  mint 咽喉照常作废旧 iso 世代。新行入场即全新派生（现行 RFC-130 重试语义，
  `scheduler.ts:3257-3289` 同型）。
- **子任务侧闸**：owning call 行已终态后，子任务的 `resumeTask` / `retryNode` → 409
  `call-row-finalized`（调用已收尾，重跑子任务的产出无人合并；call 行非终态时的子任务
  resume——含 review confirm / clarify 应答内部触发——照常放行）。

### 4.3 取消级联（D12；v2 折入 P2-6）

- `cancelTask`（`services/task.ts:2095`）追加内部参数 `cascade?: {fromParent: true}`：
  级联取消的子任务落 `error_message = 'canceled-by-parent-cascade'`
  （`error_summary` 仍为人话；直接取消保持 `'canceled by user'`，
  `task.ts:2137-2141` / `scheduler.ts:6894`）。**持久标记**使父崩溃后 resume 的
  adoption 仍能区分「父级联」（→ 调用节点随父 canceled 收场）与「用户直接取消子任务」
  （→ 节点 failed `child-canceled`）。
- 本任务 cancel 落定后（协程路径或 `task.ts:2132` fallback CAS），枚举
  `parent_task_id = id` 且状态 ∈ `CANCELABLE_TASK_STATUSES`（`task.ts:2088`）的子任务
  递归级联（深度有 `maxInvocationDepth` 上界；`task-not-cancelable` 静默跳过，幂等）。
- 调用节点 handler 对 abort 的响应：用户取消 → best-effort 级联 `cancelTask(child)` 后
  以 canceled 收尾本节点；`DAEMON_SHUTDOWN_ABORT_REASON`（`scheduler.ts:6868-6876`）→
  **不**主动取消子任务（子任务自有 `activeTasks` 条目，`shutdown.ts:24-28`
  `abortAllActiveTasks` 会统一打断并翻 interrupted，保持可恢复）。

### 4.4 删除与 GC（v2 折入 P0-2 / P1-1）

- `deleteTask`（`services/taskDelete.ts:71`）前置门追加**双向**：
  - 删父：存在非终态后代 → 409 `task-has-active-children`；
  - **删子：`parent_task_id` 非空且 owning call 行非终态（或父任务非终态）→ 409
    `task-parent-active`**——堵「父收尾前删掉终态子任务」造成 `child_task_id` 悬空
    （现门只查子自身状态，`taskDelete.ts:86-105`）。
  删除父行时 FK `ON DELETE CASCADE`（运行时 `PRAGMA foreign_keys=ON`，
  `db/client.ts:122`）连带删子任务行；磁盘清理对 `space_kind='inherited'` 的后代
  **跳过 worktree 删除**（空间属父 iso；含直接删子路径——`taskDelete.ts:109-115/166-181`
  的逐仓 removeWorktree 对 inherited 一律跳过），仍清 `runs/{childId}`、`logs/{childId}`。
- `runWorktreeGc`（`services/gc.ts:92`）候选排除 `space_kind='inherited'`。
- **`runIsoWorktreeGc`（`gc.ts:377`）候选收紧**（修 P0-2）：容器 `{iso}/{taskId}` 仅当
  「任务终态 **且非 interrupted**（interrupted 可复活）**且**该任务不存在
  『`child_task_id` 指向非终态或 interrupted 子任务』的调用行」才回收；row-less 目录
  分支（任务行已删）不变。子任务侧的对偶保护：子 resume 的 worktree preflight
  （`task.ts:2286-2291`，410 fail-closed）+ §4.2 子任务侧闸已覆盖「iso 先没了」的
  残余窗口。既有缺口「taskDelete 不删 `{appHome}/iso/{taskId}`」维持现状。

### 4.5 父计时与人工门（v2 新增，修双镜头共同 P1「maxDurationMs 掐死人工门链」）

D6（父保持 running）与 RFC-207「parked 不计时」（`services/limits.ts:77-86` 注释明文）
在父任务 `maxDurationMs` 上冲突：子任务停人工门期间父 `runningMs` 持续累积，到点
limit-cancel 会级联砍掉停在完成门的子任务，且即便推迟击杀，累积时间也会在人答完后
立即触发——与 duration limit 的本意相反。解法（保 D6 不冒泡）：

- **等待扣时**：call 行在 `wrapper_progress_json`（`db/schema.ts` node_runs 既有 JSON 列）
  记 `humanWaitMs` 累计 + 当前段起点：handler 的 poll（§6.2 W）观察到子任务进入/离开
  `awaiting_review / awaiting_human` 时落账（20s 粒度误差可接受，崩溃后按持久段起点
  续算）。
- `enforceLimits`（`limits.ts:76-88`）的 duration 判定改为
  `elapsed − Σ(本任务 call 行 humanWaitMs 含在途段) > maxDurationMs`；
- **击杀缓冲带**：存在「子任务当前处于 awaiting_*」时本 tick 不执行 duration 击杀
  （补 poll 粒度空隙），只记 alert。token 限额不受影响（子任务预算独立，D13）。
- proposal D13 随本节勘误（人工门等待不计入父时长）。

## 5. 新节点 kind：定义层（PR-3 workflow、PR-4 workgroup）

### 5.1 kind 与 schema（不 bump `$schema_version`）

按 RFC-060 先例与审计 WFM-03（`design/arch-audit-2026-06-23/04-workflow-model.md:29`）
不 bump（`WORKFLOW_SCHEMA_VERSION` 保持 4）。旧 daemon 由闭集 `NodeKindSchema`
（`shared/schemas/workflow.ts:48`）把关 → 422 fail-closed（DB 读
`workflow-definition-corrupt`，YAML 导入 `workflow-yaml-invalid`，
`services/workflow.yaml.ts:117-122`）。**kind 枚举按 PR 分批入表**：PR-3 只加
`call-workflow`，PR-4 才加 `call-workgroup`——窗口期内含 workgroup 调用的定义无法保存/
导入/启动（枚举拒绝），`runCallNode` 对未知分支仍兜底硬失败（`scheduler.ts:2969-2975`
`unhandled-node-kind` 先例）。

```ts
const CallWorkflowNodeSchema = WorkflowNodeSchema.extend({
  kind: z.literal('call-workflow'),
  workflowName: z.string().min(1),        // 持久选择器（与 agentName 同构，YAML 可移植）
  workflowId: z.string().min(1).optional(), // 本地解析缓存；悬空时 launch fail-closed
  limits: z.object({ maxDurationMs: …, maxTotalTokens: … }).partial().optional(),
});
const CallWorkgroupNodeSchema = WorkflowNodeSchema.extend({
  kind: z.literal('call-workgroup'),
  workgroupName: z.string().min(1),
  workgroupId: z.string().min(1).optional(),
  goalTemplate: z.string().min(1).max(65536),   // {{port}} + 内建 token
  limits: 同上,
});
```

name 为权威选择器、id 为解析缓存（agent 节点 `agentName`/`agentId` 双字段先例，
「dangling until launch」语义同构，`services/resourceRefs.ts:10-13`）。
不进 `WRAPPER_NODE_KINDS`。`NODE_KIND_BEHAVIORS`（`shared/node-kind-behavior.ts:100-161`）：

| kind | retryCascade | isProcess | isAgent | settlesWithoutRow |
|---|---|---|---|---|
| call-workflow / call-workgroup | `mint-placeholder` | `true` | `false` | `false` |

`WORKFLOW_NODE_FIELD_KEYS`（`shared/schemas/workflow.ts:436-452`，**校验焦点键**枚举，
`'review-source'` 风格）新增 `call-ref / call-goal-template / call-limits / call-ports`。
`WORKFLOW_NODE_REFERENCE_INVENTORY`（`shared/workflow-node-references.ts:37-72`）为两
kind 登记 `NO_NODE_REFERENCES`——`workflowName/workgroupName` 是资源标量，不含节点/端口
引用，标量 walk 天然不触发 ratchet（`workflow-node-references.ts:369-400`），无需任何
豁免机制。

### 5.2 端口派生（`PORT_DERIVERS`，`shared/nodePorts.ts:140-227`）

deriver 上下文扩展一个可选 resolver（缺省行为不变，既有 kind 零改动）：

```ts
type PortDeriveContext = { …existing…,
  workflowByRef?: (nameOrId) => WorkflowDefinition | 'forbidden' | null };
```

- `call-workflow`：`dataInputs` = 子定义 `inputs[]` 的 `{name, kind}`（upload 类拒绝，
  §5.4）；`dataOutputs` = 子定义全部 `output` 节点 `ports[].name` 去重集。
- `call-workgroup`：`dataInputs = []`（端口全由入边派生，agent 节点同型
  `shared/nodePorts.ts:157`）；`dataOutputs = [{name:'result', kind:'text'}]` 固定。
- **五个 declaredPorts 消费面逐面交代**（`nodePorts.ts:1-29` 头注）：
  1. 画布 `computePorts`（`WorkflowCanvas.tsx:2689-2760`）——前端以 TanStack Query 拉
     被引工作流定义（单一共享 fetch 层）；
  2. validator `declaredPorts`（`workflow.validator.ts:638`）——targets 扩表，
     **按需 lazy 只读被引 id**（不沿 `loadWorkflowValidationContext` 全量先例）；
  3. `wrapperCandidates`（loop exitCondition 候选，`components/canvas/wrapperCandidates.ts:60/77`）
     ——与画布共用同一 query 缓存，保证「loop 包 call-workflow 直到审计干净」可配置；
  4. `controlFlowEdge`（`controlFlowEdge.ts:46`）——call 端口均为数据端口，自动正确；
  5. `dropTarget`（`dropTarget.ts:67-69`）——call-workflow 端口闭集不入
     `acceptsNamedInputs`；call-workgroup 入列（任意入边端口新建，agent 同型）。
- **loading 与 forbidden 两态区分**（修 P2-2）：resolver 对 404（无可见性——
  grandfathered 引用允许编辑者对被引资源无权，`resourceRefs.ts:52-54`）返回
  `'forbidden'`：Inspector/画布显示「引用不可见」占位（404 同形文案，不泄露存在性
  之外的信息）、端口保持上次保存形态只读、连线校验降级 warning 不阻断保存；
  `null`（加载中）显示加载态。测试锁两态。

### 5.3 跨资源引用（保存 ACL / 引用生命周期）

- 平行新增 `extractWorkflowWorkflowRefs` / `extractWorkflowWorkgroupRefs`
  （shared 纯函数，name 选择器域），四个 assert 点各加 RefCheckGroup：create 全量
  （`services/workflow.ts:149-152/162`）、update 仅新增（`:315-316`，
  `diffNewNames` 先例）、copy 源全量（`:233-234`）、路由段
  （`routes/workflows.ts:203-205`）。启动仍只校验工作流本身（闭包隐式授权，D11）。
- **自引用**：`workflowName === 本工作流名` 在 validate-draft 报 error、launch 门硬拦
  （环检测平凡情形）。
- 删除保护：不做删除阻断；悬空引用 launch fail-closed（422
  `workflow-call-ref-missing`；agent 同哲学，运行兜底同 `scheduler.ts:2988-2991`）。

### 5.4 静态校验（v2 勘误：校验展示于 validate-draft，强制于 launch 门）

仓内事实：`validateWorkflowDef` 只在 `/validate`、`/validate-draft` 展示端点跑
（`routes/workflows.ts:170/210`），**PUT 保存不阻断**；硬闸在 launch
（`taskLaunchGate.ts:42`）。本 RFC 全部「校验规则」均指该两点，v1 文稿的「保存期拦截」
措辞作废。`workflow.validator.ts` §4 尾部新增 `4f. call nodes`：

1. `workflowName/workgroupName` 存在性（targets 查表；不查可见性——与 §4-agent 同规则）。
2. `call-workflow` 端口完整性：子定义每个 `inputs[]` 恰有入边接同名端口（fan-in 合并
   语义沿用 `scheduler.ts:7197-7200`）；upload 类输入 → error
   `call-workflow-upload-input-unsupported`；output 端口重名 → error
   `call-workflow-output-port-collision`；零 output 节点 → warning（合法：纯写盘型）。
3. `call-workgroup`：`goalTemplate` 模板变量校验复用 §5 `BUILTIN_VARS` + 入边端口集；
   被引工作组 readiness 不 ready → warning（launch 与调用时 fail-closed）。
4. **跨定义环检测**：`detectCallCycles(rootDefn, workflowByRef)` DFS 着色；自环/A→B→A
   报 error `workflow-call-cycle`；resolver `'forbidden'`/`null` 的分支降级 warning
   （launch 冻结走查为权威第二道）；issue 载荷遵守 §3.1 的 id-only 纪律。
5. 入边规则：两 kind 接受数据入边（`workflow.validator.ts:699-838` else-if 链加分支）；
   拒绝 signal/系统通道端口。
6. wrapper 叠加：允许位于三类 wrapper 内层；`analyzeWorkflowScopeTree` 无需改。
7. **dw 生成物拒绝 call 节点**：dynamic_workflow 生成 DAG 的准入面追加「含 call 节点 →
   拒绝重生」——工作组是闭包叶，杜绝运行期绕过冻结闭包与环检测。

### 5.5 YAML 导入导出（v2 按 P1-3 重写）

- 导出：name 选择器本就持久在节点上（§5.1 双字段），导出仅剥 `workflowId/workgroupId`
  缓存字段（`workflowDefinitionToNameSelectors`，`shared/workflow-yaml.ts:26-38` 同点
  扩展；后端对应面 `services/workflow.yaml.ts:139/147/200/356/377/407`）。
- 导入：`IMPORT_REF_TYPES`（`shared/schemas/importRef.ts:12-14` 闭集）**扩展
  `'workflow' | 'workgroup'`** + `resolveImportRefs` 分支 + 前端映射 UI 复用既有
  `ImportRefSelection` 流程。**无候选/不映射 = 保留悬空 name 导入成功**（agent
  「dangling until launch」同构），launch fail-closed——不存在导入死锁。工作组资源
  本身不随 YAML 携带（与 agent 一致，仅引用）。

## 6. 调度执行层（PR-3/4 核心）

### 6.1 runOneNode 分支

`scheduler.ts:2713` if-chain 在 `:2969` 兜底守卫前加分支 → `runCallNode(state, args)`
（新文件 `services/callNode.ts`）。**不 acquire `globalSem`**（`scheduler.ts:3150` 仅
agent 路径）——调用节点不占 agent 进程槽，消解「父占槽等子」的信号量自死锁；
源代码文本锁：`callNode.ts` 不得出现 `globalSem.acquire`。

### 6.2 call-workflow 执行序（与 agent 节点同构）

```
[定位/复用行(§4.2 锚定规则)] → [D] derive iso → [L] launch child → [W] await
        → [F] finalize outputs → [M] merge-back → [done/failed/park]
恢复入口：[A] adoption（§4.2 四分支）→ 按子状态与 merge_state 跳转（R 分段表）
```

- **D**：`createIsoUnderLock`（`services/isolatedAgentRun.ts:57-82`；父 `writeSem`
  短窗口）+ `persistIsoBase`（`:91`）——与 `scheduler.ts:3160` 同型；`isoKeyRunId` =
  调用行 id。多仓/子模块/scratch 由 `createNodeIso`（`services/nodeIsolation.ts:177`）
  既有能力覆盖——scratch 任务是真 git repo（`task.ts:1016-1086` + `util/git.ts:83`），
  与 repo 父任务同一条路径（回答 proposal 开放问题 2）。
- **L**：组装内部 StartTask：定义 = 冻结闭包子定义；`inputs` =
  `resolveUpstreamInputs`（`scheduler.ts:7131-7202`）端口值；工作区注入 =
  `StartTaskDeps.preCreatedWorktree`（`task.ts:231`，`cleanup:{kind:'borrowed'}`，
  `task.ts:1320-1328`）单仓 / `materializedSpace`（`task.ts:253/791`）多仓，指向本行
  iso、`baseCommit` = iso baseSnapshot、`space_kind='inherited'`；
  `parent_task_id / parent_node_run_id / invocation_depth` 随 INSERT 原子写
  （`task.ts:1693`）；深度与限额闸在前（§3.2）；owner = 父 owner、collaborators =
  父成员（D11）；`workingBranch` 不设、`autoCommitPush=false` 强制；limits 取节点
  `limits`（D13）；`child_task_id` 同事务落列；子任务照常 `runTask` 踢起。
- **W**：`watchExecutionTerminal(childId, {signal, pollMs:20s})`（§1.4，注册即同步查）。
  poll 同时驱动 §4.5 的 `humanWaitMs` 落账与节点 live 信息（wire `childTaskId`，前端
  订阅子任务状态呈现）。abort → §4.3。子任务 awaiting 期间父行保持 running（D6）。
- **F**（幂等）：读子任务 outcome 投影（§1.3）→ 写调用行 `node_run_outputs`
  （`onConflictDoUpdate`，`runner.ts:2338-2360` 同型 helper 化）；path 端口内容为
  repo0 相对路径（`runner.ts:2305` 规范）——**其文件落地由 M 保证，F/M 完成前下游
  不会派发**（下游门同时要求行 done + `merge_state` settled，`scheduler.ts:2012` +
  `shared/lifecycle.ts:411`，行 done 是全序列最后一步）；产物以父 `(taskId, callRunId)`
  重归档（`services/portArtifacts.ts:165-248`，≤2MiB 规则不变），读取面零改动，
  `forcedPortPathsForTask`（`isolatedAgentRun.ts:71`）自然聚合。
- **M**：`snapshotNodeIsoFinal + persistIsoNodeTree`（`isolatedAgentRun.ts:171`）→
  `mergeBackAndSettle`（`:215`；父 writeSem 短窗口；conflictResolver 复用内置 merge
  agent 注入 `scheduler.ts:2600`）：merged → 行 done；conflict-human → 节点
  `awaiting_human`（`merge-conflict`）+ resolve-iso 保留，人工改完走普通 resume 的
  `replayConflictHumanResolutions`（`scheduler.ts:2518`）——机制零新增；merge 异常 →
  `markMergeFailed` + keepIso + 节点 failed（RFC-210 A1）。
- **失败映射**：子 failed → 节点 failed（`child-task-failed`，errorMessage 带子
  `error_summary/error_message/failed_node_id`）；子 canceled：读级联标记（§4.3）——
  `canceled-by-parent-cascade` → 随父 canceled 收场，否则 `child-canceled`；子
  interrupted 不可恢复 → `child-interrupted`；子行缺失 → `child-deleted`；发起前失败
  （深度/限额中止/闭包缺失）→ `invocation-depth-exceeded` / `workflow-call-ref-missing`，
  不建子任务。失败一律 keepIso（`scheduler.ts:3955-3979` 同规）。
- **叠加形态**：fanout 分片（`dispatchFanoutShard`，`scheduler.ts:5287`）与 loop 迭代
  对内层 call 节点透明；每分片独立子任务受 §3.2 限额背压；fail-all-after-join 不变。
  wrapper 嵌套隔离（`scheduler.ts:4571-4586/6603-6620`）下 call 行 iso 从 wrapper iso
  分叉、合回 wrapper iso——git wrapper 的 diff 窗口天然包含子任务改动（回答开放问题 4）。

### 6.3 call-workgroup 差异点

- **goal 渲染**：父侧以模板层（`shared/prompt.ts:464/510-553`）渲染 `goalTemplate`
  （`{{port}}` + 内建 token 域与 agent promptTemplate 一致：`__repo_path__` 等
  `BUILTIN_VARS`，fanout 内含 `__shard_key__`）；工作组运行时 literal-render 保护
  （2026-07-27 修复）保证端口内容中 `{{…}}` 不二次展开。
- **发起**：`startWorkgroupTaskFromFrozen(configTemplate, renderedGoal, …)`——跳过
  资源行重读与 OCC（冻结物为准），**保留** launch 门 ④–⑦（readiness / roster agent
  存在性 / `assertAgentIdsExecutionPolicy` / `assertAgentResourceIntegrity`，
  `services/workgroup/launch.ts:217-268`；agents 是活资源）；collaborators = 父成员 ∪
  工作组人类成员（`resolveWorkgroupCollaborators`，`launch.ts:162-170` 吃冻结
  config.members）。readiness 失败 → 节点 failed `workgroup-not-ready`。
- **等待**：完成门 `awaiting_review`、clarify、`max-rounds-wrapup` 全停在子任务（D6）；
  §4.5 计时扣除覆盖。
- **收尾**：done → `result` 投影（§6.4）写调用行唯一输出端口；工作树改动经 M 合回。
  dw 模式：dw-execute 相位产出按 workflow 投影，`result` = 各 output 端口按
  **name 字典序**拼接 `## {name}\n{content}` 文本（确定性；v1 单端口约定，未来端口
  透传为后续项），一并 M 合回。
- 失败映射追加：`max-rounds` / `fc-deadlock` / `dw-reject-exhausted`
  （`services/workgroup/engine.ts:601-612`、`services/workgroup/dwActions.ts:166-199`）
  → 节点 failed，errorMessage 透传。

### 6.4 工作组 `result` 投影载体（v2 按 P1-2 重设计：显式结果锚）

摸底事实：turn-engine 模式 `wg_*` 端口完全不落库（`persistDeclaredOutputs:false`，
`scheduler.ts:881` + `runner.ts:2338`；host run 零 `node_run_outputs` 是三处依赖的
不变量）；fc 的收尾汇总与 zero-delta 告警**同 kind 同 author**（汇总
`engine.ts:517-531`，告警 `strategies/leaderWorker.ts:160-167` 且时序在后），
「按 author/kind 过滤」不可判定。因此：

- **新列 `workgroup_task_state.result_message_id`**（PR-4 迁移）：engine done 分支
  显式落锚——lw 指向 leader 的 done decision 消息（`strategies/leaderWorker.ts:393-399`
  写入点返回 id），fc 指向收尾汇总消息（`engine.ts:523-530` 写入点）；完成门流程不改。
- 投影：`result_message_id` → `workgroup_messages.body_md`；历史任务回退
  `gate_summary`（lw；`declaredDone` 路径必经 `→declared` 落 summary）/ 空串 + warning
  （fc）。dw 不用该锚（workflow 投影）。
- 独立启动的工作组任务经 `getExecutionOutcome` 同样可读（proposal 验收 5）。

## 7. 并发与磁盘安全

### 7.1 锁边界（跨任务锁序约定，新增全仓约定）

- **约定：任何持有任务 A `writeSem` 的临界区不得等待任务 B 的任何锁或终态。**
  调用节点天然满足：writeSem 只在 D 与 M 两个短窗口持有（RFC-130 §7 纪律，
  `scheduler.ts:3142-3149`），W 阶段零锁；§3.2 限额等待亦零锁。落
  `docs/dev-gotchas.md` 条目 + `services/callNode.ts` 头注释。
- 子任务自有 `getTaskWriteSem(childId)`（`services/taskWriteLocks.ts:27`）互不嵌套。

### 7.2 `.git/worktrees` 注册表跨任务竞态（加固项）

子任务的节点 iso 从「父 iso（linked worktree）」再 `git worktree add`，注册表写落在
**共同 git dir**——与今天「同仓两个独立任务并发建 iso」同一竞态面（2026-07-27
半初始化 commondir 事故同类）。收口：

- daemon 级 `getRepoRegistrySem(canonicalCommonGitDir)`（keyed 互斥；键为
  `git rev-parse --git-common-dir` 归一路径，iso-from-iso 自动归属同一根），在
  `createIsolatedWorktree`（`util/git.ts:2163`）、`removeWorktree`、任务 worktree
  创建的 `git worktree add/remove/prune` 临界区内持有；锁序
  `writeSem ≺ repoRegistrySem`（writeSem 窗口内嵌套、永不反向）。
- 独立可测（并发 add 压力）；对既有路径纯收紧。设计门评估风险过高可降级为
  「仅新链路持锁」——默认全量收口。

## 8. 对外 wire 与前端（PR-5）

- 启动端点、定时任务 wire 不变；`GET /api/tasks/:id/node-runs` 增 `childTaskId`
  （additive）；任务列表增 `parentTaskId/invocationDepth` 字段与
  `include_children=true` / `parent_id=<taskId>` 查询参。**默认
  `parent_task_id IS NULL` 过滤与列表 UI（父行展开/筛选）同 PR 落地**（PR-5；避免
  「服务端先藏、前端后补」的窗口期把 awaiting 子任务藏没，修 P2-5(R1)）。
- **overview 计数口径**（修 P2-1(R2)）：`buildOverview`（`services/overview.ts:58-70`）
  的 running/awaiting/done7d/failed7d 计数同样排除 `parent_task_id IS NOT NULL` 行，
  与列表默认口径一致；决策记录：子任务活动不进首页卡片（父任务代表整树）。
- 前端触点按附录 A 清单执行；重点：
  - `NODE_TYPES` / 节点组件 / `PALETTE_DESCRIPTORS` + 新 section `calls` /
    `KIND_INSPECTORS` + 两个 Inspector（公共 `Select`/`TextArea`/`NumberInput` 原语，
    CLAUDE.md 前端强制原则）；
  - Inspector 的「引用不可见」占位态（§5.2 forbidden）与端口预览；
  - 任务列表：默认顶层 + 父行展开 + 「含子任务」筛选 + 子任务父徽章；任务详情调用
    节点卡片：子任务状态 chip + 直链（`StatusChip` 复用）；**子任务页对
    `parentTaskId` 的呈现按访问权降级**——无父任务可见性的成员（如工作组人类成员）
    显示中性「父任务不可见」占位而非死链（修 P2-8）；
  - i18n 双 locale（`editor.paletteXxx` 扁平键范式）。

## 9. 失败模式清单（错误码闭集）

| 码 | 层 | 触发 |
|---|---|---|
| `workflow-call-cycle` | validate-draft / 启动闭包走查 | 跨定义调用环（含自环；issue 载荷 id-only） |
| `workflow-call-ref-missing` | 启动闭包走查 / 调用节点发起 | 悬空 name / 资源不可读 |
| `call-workflow-upload-input-unsupported` | validate-draft / launch 门 | 子定义含 upload 输入 |
| `call-workflow-output-port-collision` | validate-draft / launch 门 | 子定义 output 端口重名 |
| `invocation-depth-exceeded` | 调用节点发起 | 深度守卫 |
| `workgroup-not-ready` | 调用节点发起 | 冻结配置 readiness / roster 失效 |
| `child-task-failed` / `child-canceled` / `child-interrupted` / `child-deleted` | 调用节点收尾 | 子任务终态映射（§6.2；级联标记判别） |
| `task-has-active-children` | deleteTask（父） | 有非终态后代 |
| `task-parent-active` | deleteTask（子） | owning call 行 / 父任务未收尾 |
| `call-row-finalized` | 子任务 resume/retry | 调用已收尾，禁止重跑子任务 |
| 既有 `merge-conflict` / merge-failed / `unhandled-node-kind` 等 | 原语层 | 复用不变 |

## 10. 测试策略（随各 PR 交付，命名锁定回归意图）

**shared 纯函数**：
- `execution-outcome-projection.test.ts`：三 kind × 四终态投影矩阵；
  `pickUpstreamSourceRun` 口径的多代行（review 迭代 / loop 多 iteration / fanout 子行
  排除）；workgroup `result_message_id` 锚 + 历史回退 + **fc zero-delta 告警行不串味**；
  dw 字典序拼接确定性。
- `workflow-call-refs.test.ts`：`collectExecutionRefs` / `detectCallCycles`
  （自环、A→B→A、菱形非环、forbidden/null resolver 降级）；环 issue 载荷 id-only。
- `call-node-ports.test.ts`：两 kind deriver（inputs 映射、upload 拒绝、output 重名、
  forbidden vs loading 两态）；`NODE_KIND_BEHAVIORS` 穷尽。
- `child-budget.test.ts`：**可放行者扫描制**（P0-1 死锁构造反例：树 A 8 分片饱和 +
  树 B 排队 + 孙代放行推进）；awaiting 不占额；resume 突发不排队；簿记幂等 + boot 重建；
  等待 60s 告警。

**backend 集成**（stub runtime）：
- `rfc242-executor-facade.test.ts`：五调用面（含 multipart）收编 wire/错误码逐字节回归；
  watch 四终态 + 注册即查 + poll fallback + 行缺失语义。
- `rfc242-call-workflow.test.ts`：D→L→W→F→M 端到端；未提交父改动对子可见；子改动合回；
  冲突 conflict-human + resolve-iso resume replay；merge 异常 keepIso；F 幂等重放。
- `rfc242-call-lifecycle.test.ts`：父取消级联（递归 + **级联标记持久判别**）；子直接
  取消 → `child-canceled`；重试作废旧子 + 全新派生 + **adoption 禁 mint 源锁**；
  boot reap → 父 resume 重挂四分支（子活 / 子 interrupted 且已被他人恢复（竞态回落
  re-attach）/ 子终态按 merge_state 分段 R（isolating/pending-merge/merged 三段 +
  与 `replayPendingMerges` 的所有权交接）/ 子行缺失 `child-deleted`）；
  orphanReconcile：`child-task-active` 不收、父失驱动 + 子终态收；S5 委派（子 awaiting
  不告警）；**iso GC 收紧**（interrupted 父不回收、活子/interrupted 子引用不回收）；
  deleteTask 双向门；`call-row-finalized` 子任务侧闸；**§4.5 计时扣除**（humanWaitMs
  落账 + duration 判定扣除 + awaiting 期击杀缓冲）。
- `rfc242-call-workgroup.test.ts`：goal 渲染字面性；冻结发起 + roster 失效 fail-closed；
  完成门停子任务、确认后父续；`result` 锚三模式 + `max-rounds` 映射。
- `rfc242-fanout-call.test.ts`：fanout per-shard 子任务（**分片行锚定不互认**、限额
  背压、fail-all-after-join 不变）；git wrapper 内子任务改动计入 diff 窗口。
- `rfc242-registry-mutex.test.ts`：并发 worktree add/remove 压力 + common-git-dir 键
  归属（iso-from-iso）+ 锁序断言。
- **源代码文本锁**：`callNode.ts` 无 `globalSem.acquire`；路由/scheduleLaunch/
  launchMultipart 不直呼 start*；call 行 adoption 无 mint 调用。

**frontend**：palette/inspector（含 forbidden 占位态）/画布端口/连线校验；列表嵌套
与筛选 + overview 口径；子任务页 parentTaskId 降级呈现；i18n 类型强制。
**e2e**：真实 daemon call-workflow 链 + call-workgroup 链（stub 模型）。

## 11. 兼容性、性能、安全

- **兼容**：无 `$schema_version` bump、wire additive、零回填迁移；不含 call 节点的
  定义与全部存量任务 byte-compat；旧 daemon 422 fail-closed（RFC-060 先例）。
- **性能**：闭包冻结仅含 call 节点的启动发生（lazy 按 id 读）；watch/budget 为进程内
  结构 + 状态转移层簿记；`ref_closure_json` 与 `workflowSnapshot` 同量级。
- **安全 / ACL 决策记录**：
  - 归属信息不进任何 agent prompt（RFC-099 不变量；子任务 prompt 面只有端口值与 goal）。
  - 子任务成员 = 父成员（∪ 工作组人类成员）。**显式记录两条扩权面并接受**：
    (a) 工作组人类成员经子任务成员资格可读父工作区派生 iso 内容（未提交变更、上游
    产物）——与「把工作交给该组」的授权意图一致；(b) 任务成员可经子任务
    `workflowSnapshot` 读到闭包内他人私有子工作流的定义全文（传递可见）——与既有
    「任务成员可读任务快照」一致，且 `ref_closure_json` 永不进 wire（§2）。两条均
    文档化为 D11 的边界注记。
  - 环检测 issue、校验文案 id-only（§3.1/§5.4）。
  - `inherited` 空间无新增磁盘暴露面。

## 12. 设计门记录与残余决策点

一轮双镜头（并发/生命周期 + 契约/ACL）findings：2 P0 + 6 P1 + 14 P2，全部折入本版；
逐条处置见 `./design-gate-2026-07-31.md`。残余登记（实现期复核，不阻塞批准）：

1. §3.2 深树插队饥饿的优先级老化（v1 只告警）。
2. §7.2 注册表互斥收口范围（默认全量；可降级新链路 only）。
3. dw `result` 端口透传（v1 拼接文本）。
4. 限额/深度默认值（8 / 3）与 Settings 暴露面。
5. `awaiting_*` 子任务不占限额导致的 resume 突发超额（接受，文档化）。

## 附录 A. 新增 node kind 全触点清单（沉淀自 2026-07-31 摸底，实现对表用）

**shared（8 处有 `satisfies Record<NodeKind,…>` 编译期兜底）**：
`NODE_KIND`（`shared/schemas/workflow.ts:33-43`）；kind 专属 zod 子 schema；
`NODE_KIND_BEHAVIORS`（`shared/node-kind-behavior.ts:100-161`）；`PORT_DERIVERS`
（`shared/nodePorts.ts:140-227`）；`WORKFLOW_NODE_REFERENCE_INVENTORY`
（`shared/workflow-node-references.ts:37-72`）；`WORKFLOW_NODE_FIELD_KEYS`
（`shared/schemas/workflow.ts:436-452`）；（如引入新系统端口才需）`SYSTEM_CHANNEL_PORTS`。

**backend**：kind 准入闸（`scheduler.ts:467-479`，填表即准入）；`runOneNode` if-chain
（`scheduler.ts:2713` 起，兜底 `:2969-2975`）；`isDispatchable` 仅容器需改
（`dispatchFrontier.ts:321-382`）；隐式依赖投影（`scheduler.ts:7666-7709`，call 节点
全走边、无需加段）；retry cascade 自动（`task.ts:2943`）；引用基建四 assert 点 +
extract（§5.3）；YAML（§5.5）。

**frontend**：`NODE_TYPES`（`WorkflowCanvas.tsx:141-153`）；节点组件
（`components/canvas/nodes/`）；`PALETTE_DESCRIPTORS/PaletteItem/PALETTE_SECTIONS`
（`nodePalette.ts:21-33/57-167/279-287`）；`KIND_INSPECTORS`（`NodeInspector.tsx:76-86`）
+ Inspector 组件（`components/canvas/inspector/`）；`nodeTitle.ts:28-36`；
`dropTarget.ts:67-69/101`；`controlFlowEdge.ts:46`；`wrapperCandidates.ts:60/77`；
（容器才需）`coordProjection/wrapperFit/wrapperOps`；i18n 类型 + 双 locale
（`zh-CN.ts:2678/7162`、`en-US.ts:3047`）。
