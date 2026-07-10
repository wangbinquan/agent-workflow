# RFC-164 design——工作组（Workgroup）技术设计

> 配套 proposal.md（产品拍板 20 条）；本文定技术方案。所有对现有代码的断言均经源码核实，
> 引用 file:line 基于 2026-07-10 工作树。

## 0. 总览与关键抉择

工作组是**增量子系统**：新资源（workgroups 五表）+ 新启动路径（service 层）+ 新调度分支
（回合引擎，与 DAG frontier 并列）+ 新前端域（资源页 + 聊天室）。对既有工作流/任务路径
**零语义改动**，耦合点全部走已验证的扩展缝。

| 抉择 | 方案 | 理由 / 否决项 |
| --- | --- | --- |
| 组任务如何满足 `tasks.workflow_id`/`workflow_snapshot` NOT NULL（schema.ts:464-467） | **内置宿主工作流 + 启动时合成快照**：seed 一行 builtin workflow `__workgroup_host__`；每次启动把「宿主三节点图」写进 `workflow_snapshot` | 否决「放开 NOT NULL」：SQLite 去 NOT NULL 要整表重建 tasks（高危迁移）。builtin 行 + 合成快照零表改动；fusion 已有 service 层启动 builtin workflow 先例（taskLaunchGate.ts:9-10 注释明确该门只在路由层） |
| 成员 run 怎么挂到静态图上 | **宿主节点 + 借壳 + 派单键**：快照只有 3 个静态节点（`__wg_leader__` / `__wg_member__` / clarify 通道）；每次派单在 `__wg_member__` 上 mint 一行 node_run，`agentOverrideName`=成员 agent（RFC-127 借壳列 schema.ts:914），`shardKey`=assignment id 区分并行行 | 否决「每成员一个快照节点」：中途加成员要改快照（RFC-109 resync 面大）；借壳方案加/减成员**完全不动快照**。fanout 已示范同一 nodeId 多行并行 run（shardKey + parentNodeRunId，scheduler.ts:4289-4300） |
| 回合引擎接在哪 | `runTask` 内按 `task.workgroup_id` 分流到 `runWorkgroupTask`（新 service），**不走** `deriveFrontier`/`runScope` | `runOneNode`/`runNode` 与 frontier 解耦已核实（dispatchFanoutShard 绕过 frontier 直调 runNode，scheduler.ts:4420-4473）；DAG 引擎零改动 |
| leader 跨轮上下文 | **session 续接优先**（RFC-026 先例：`node_runs.opencodeSessionId` schema.ts:728、opencode `--session` spawn.ts:49-51、claude `--resume` claudeCode/spawn.ts）+ **游标增量注入**（游标持久化在 `workgroup_member_cursors`，§1.6）；无 session 时全量重注入 | 每轮上下文块设计为自足（全量态可重建），session 只是省 token 的优化，daemon 重启/换 runtime 不致断链 |
| 确认门状态 | **复用 `awaiting_review` 状态值**（task+node_run 双枚举已有，schema.ts:488/678）：确认门开启时**最终 leader run 同步泊 `awaiting_review`**（结构上满足生命周期不变式「task awaiting_review ⟹ 存在 awaiting_review node_run」，lifecycleInvariants.ts:349-367）；**不复用** review.ts 的 doc_versions/决策机（无文档语义），新轻量端点；并给两个 review 语义消费方加 workgroup 豁免 guard——`stuckTaskDetector` 的 S1 判定（无 pending doc_version 即判卡住）与 S1 自动修复（会误调 `dispatchReviewNode`）对 `task.workgroup_id` 非空的任务跳过（设计门 Finding-2） | 泊住-冒泡-resume-收件箱计数全链路现成（scheduler.ts:508-510）；否决「新增任务状态 `awaiting_group_confirmation`」：状态枚举扩散面（CAS 转移表/前端 chip/过滤器/修复链）远大于两处豁免 guard |
| 触顶语义 | 两模式一律 **failed + 房间系统消息**（与 loop wrapper 触顶→任务 failed 对齐，RFC-097 勘误同源） | 否决「强制收尾轮」：给 leader 特权轮引入第二种 leader 协议分支，v1 不值 |

## 1. 数据模型

### 1.1 `workgroups`（第六类 ACL 资源）

```sql
CREATE TABLE workgroups (
  id TEXT PRIMARY KEY,                 -- ULID
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',           -- 组章程，全员每轮注入（拍板 #18）
  mode TEXT NOT NULL DEFAULT 'leader_worker'
    CHECK (mode IN ('leader_worker','free_collab')), -- 扩展位（拍板 #4/#5）
  leader_member_id TEXT,                            -- FK workgroup_members.id；leader_worker 必填（应用层校验）
  share_outputs INTEGER NOT NULL DEFAULT 1,         -- 三开关（拍板 #6）
  direct_messages INTEGER NOT NULL DEFAULT 0,
  blackboard INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 20,           -- 拍板 #8
  completion_gate INTEGER NOT NULL DEFAULT 0,       -- 完成前人工确认门（拍板 #11）
  owner_user_id TEXT,                               -- RFC-099 同形
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','private')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

- ACL：`resource_grants.resourceType` 枚举（schema.ts:402）追加 `'workgroup'`；
  list/detail 过滤与 404 同形复用 `services/resourceAcl.ts` 单一事实源。
- `free_collab` 模式下三开关**存储照写、读取强制视为全开**（`resolveVisibility` 纯函数统一出口，
  避免脏数据歧义）；表单层直接禁用。
- 校验：`leader_worker` ⇒ `leader_member_id` 非空且指向本组 agent 成员；`free_collab` ⇒ 忽略 leader。

### 1.2 `workgroup_members`

```sql
CREATE TABLE workgroup_members (
  id TEXT PRIMARY KEY,
  workgroup_id TEXT NOT NULL REFERENCES workgroups(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK (member_type IN ('agent','human')),
  agent_name TEXT,                -- member_type='agent'：引用 agents.name（软链接，同 workflow 节点引用方式）
  user_id TEXT,                   -- member_type='human'：引用 users.id
  display_name TEXT NOT NULL,     -- 房间/花名册显示名 + @ 提及 token（human 必填别名，见 §11 prompt 隔离）
  role_desc TEXT NOT NULL DEFAULT '',  -- 组内职责描述，进花名册
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (workgroup_id, display_name)
);
```

- 同一 agent 在一组内只出现一行（多实例 = 同成员并行多单，不是多行）；`display_name`
  是组内唯一寻址 token（leader 派活单、@ 提及、花名册均用它）。
- agent 成员按 `agent_name` 软引用（与节点 `agentName` 同形）；agent 被删时启动/派单校验报错。

### 1.3 `tasks` 增列（migration，ADD COLUMN 无重建）

```sql
ALTER TABLE tasks ADD COLUMN workgroup_id TEXT;            -- NULL=非组任务；软链接（scheduled_task_id 同款，schema.ts:547 先例）
ALTER TABLE tasks ADD COLUMN workgroup_config_json TEXT;   -- 启动时组配置快照 + 运行时可变副本（§8.4）
CREATE INDEX idx_tasks_workgroup ON tasks(workgroup_id);
```

`workgroup_config_json` = `{ mode, leaderMemberId, switches, maxRounds, completionGate,
instructions, goal, members:[{id,type,agentName?,userId?,displayName,roleDesc}] }`。
**任务运行读它，不回读 workgroups 表**（组本体后续修改只影响新任务）；「中途改组配置」改的是
这份副本（拍板 #11，§8.4）。

### 1.4 `workgroup_assignments`（派单 / 自由协作任务清单，二合一）

```sql
CREATE TABLE workgroup_assignments (
  id TEXT PRIMARY KEY,             -- ULID；同时作成员 run 的 shard_key
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,          -- 创建时所在回合
  source TEXT NOT NULL CHECK (source IN ('leader','human','self_claim','system')),
  created_by_run_id TEXT,          -- source='leader'：leader node_run id
  created_by_user_id TEXT,         -- source='human'：审计列，绝不进 prompt（§11）
  assignee_member_id TEXT,         -- NULL=free_collab 未认领（open）
  title TEXT NOT NULL,
  brief_md TEXT NOT NULL DEFAULT '',   -- 任务书（objective/输出要求/边界，Anthropic 四要素模板）
  status TEXT NOT NULL CHECK (status IN
    ('open','dispatched','running','awaiting_human','delivered','done','failed','canceled')),
  node_run_id TEXT,                -- agent 成员当前执行 run（重试换行时更新）
  result_message_id TEXT,          -- 完成后指向结果消息
  dedup_key TEXT,                  -- free_collab 标题归一化去重键（§7.3）
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wg_assign_task ON workgroup_assignments(task_id, status);
```

状态机（`services/workgroupLifecycle.ts` 转移表 + CAS，风格照 lifecycle.ts）：
`open →(claim) dispatched → running → done|failed|awaiting_human(反问/人类待交付)`；
`awaiting_human →(答/交付) running|delivered`；人类单 `dispatched → delivered → done`
（delivered=交付内容已落，done=下一回合已消费）；任何非终态 → `canceled`（任务取消/成员移除）。

### 1.6 `workgroup_member_cursors`（每成员消费游标，设计门 Finding-3）

```sql
CREATE TABLE workgroup_member_cursors (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,               -- workgroup_config_json 内成员 id（含 leader）
  last_consumed_message_id TEXT NOT NULL DEFAULT '',  -- 该成员已消费的最大消息 id（ULID 序）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, member_id)
);
```

所有「未消费消息」判定（leader 增量注入 §4.5、@ 消息唤醒 §6.3、黑板尾窗起点 §8.4）统一以此表
为持久化事实源：**mint 该成员 run 的同一事务里把游标推进到本次注入所覆盖的最大消息 id**——
daemon 重启/重复唤醒判定天然幂等（游标之后无新消息 ⇒ 不唤醒），杜绝重复唤醒与漏唤醒。
leader 的水位线同样收编于此（member_id=leader 成员 id），不再存 `workgroup_config_json`。

### 1.5 `workgroup_messages`（房间消息 = 黑板 = 全量人类视图）

```sql
CREATE TABLE workgroup_messages (
  id TEXT PRIMARY KEY,             -- ULID（房间排序键：created_at,id）
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('member','human','system')),
  author_member_id TEXT,           -- author_kind='member'
  author_user_id TEXT,             -- author_kind='human'：审计+UI，不进 prompt（§11 用 display_name）
  kind TEXT NOT NULL CHECK (kind IN
    ('chat','dispatch','result','delivery','decision','system')),
  body_md TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',   -- [{memberId}]；@ 提及解析结果
  assignment_id TEXT,              -- dispatch/result/delivery 关联派单卡
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_wg_msg_task ON workgroup_messages(task_id, id);
```

- **消息即黑板**：无独立黑板表。派单卡 = `kind='dispatch'` 消息 + assignment 行（卡片实时状态
  从 assignment/node_run 读，消息行只存派单文案）。
- 回合边界 = `kind='system'` 消息（`round N 开始`），前端据此画分隔线。

## 2. 宿主工作流与合成快照

- seed 迁移插入 builtin workflow 行 `__workgroup_host__`（`builtin=1`，随既有 builtin 过滤
  规则对普通列表隐藏；`assertNotBuiltin` 挡路由启动，taskLaunchGate.ts:25-36——组任务从
  service 层启动，见 §3）。
- 每次启动合成 definition JSON 写入 `tasks.workflow_snapshot`（NOT NULL 满足，schema.ts:467）：

```jsonc
{ "$schema_version": N, "nodes": [
    { "id": "__wg_leader__", "kind": "agent-single", "agentName": "<leader agent>", ... },
    { "id": "__wg_member__", "kind": "agent-single", "agentName": "<占位，恒被借壳覆盖>", ... },
    { "id": "__wg_clarify__", "kind": "clarify", ... }   // wire 到两个宿主节点
  ], "edges": [] }
```

- 反问贯通的硬前置已核实：(a) 成员 run 是真实 `node_runs` 行（clarify_rounds 两个 FK
  cascade 到 node_runs.id，schema.ts:1257-1266）；(b) 宿主节点在快照里 wire clarify 通道
  （`agentHasClarifyChannel(definition, node.id)`，scheduler.ts:2247）。两点合成快照都满足
  ⇒ `<workflow-clarify>` → `createClarifySession`（clarify.ts:120）→ 收件箱 → 答后 mint rerun
  整条链路**零改动**复用（收件箱数据源 `/api/clarify/pending-count`，InboxFooterButton.tsx:31-35）。
- `free_collab` 快照无 leader 节点（只 member + clarify 两节点）。
- 任务详情的 workflow-status 画布 tab 对组任务隐藏（§10.3），宿主图不作为观测面。

## 3. 启动路径

- 新路由 `POST /api/workgroups/:id/tasks`，body = `StartWorkgroupTaskSchema`（shared 新增）：
  `{ name, goal, repoPath?/repoUrl?/ref?/repos?[], baseBranch?, fetchBeforeLaunch?,
  collaboratorUserIds?, gitUserName?/gitUserEmail?, workingBranch?, autoCommitPush?,
  maxDurationMs?, maxTotalTokens? }`——repo 相关字段与 `StartTaskSchema`（shared/schemas/task.ts:275-425）
  同形复用其子 schema 与 superRefine 规则。
- service `startWorkgroupTask(db, actor, workgroupId, input, deps)`：
  1. `canViewResource` 校验工作组本身可用（引用闭包隐式授权，RFC-099 D 同则；**不**逐个校验成员 agent 授权）；
  2. 快照组配置 → `workgroup_config_json`；校验成员 agent 均存在且启用；
  3. 合成宿主快照（§2），组装 `StartTask` 形状 + `buildStartTaskDeps(...)`（startTaskDeps.ts:34-49）
     扩展一个 `workgroupLaunch` dep（`scheduledTaskId` 同款注入法，task.ts:905 先例）→ 调 `startTask`
     （绕过 `assertWorkflowLaunchable`，fusion 同款 service 层启动 builtin）；
  4. `startTask` INSERT 时 stamp `workgroup_id` + `workgroup_config_json`；collaborators =
     用户勾选 ∪ 组内人类成员（人类成员自动获得任务成员身份 ⇒ 房间访问 + 作答权，proposal 目标 6）；
  5. `goal` 存 config JSON（不占 `tasks.inputs`，其保持 `'{}'`）。
- 前端启动页复用 `components/launch/` 的 repo source picker 全套；**注意 RFC-125 白名单教训**
  （launch-repo-source.ts:69-75 `stampLaunchExtras`）——工作组启动走**独立 endpoint 独立 body
  builder**（新 `buildWorkgroupLaunchBody`），新字段（goal 等）在该 builder 内显式组装，
  不借道 `buildLaunchBody` 白名单，从根上避开静默丢字段坑。

## 4. 回合引擎（`services/workgroupRunner.ts`）

> **现状 vs 新增**（设计门 Finding-1 措辞澄清）：本节全部为**本 RFC 新增**的实现承诺——当前
> `runTask`（scheduler.ts:311 `runTaskInner`）CAS 领取后直走 `runScope`，无任何 workgroup
> 分支；本 RFC 在 PR-3 T15 落地该分流。引用的既有符号（runOneNode/runNode/globalSem 等）
> 才是「已核实现状」。

**新增分流**：`runTask` 在进 `runScope` 前判 `task.workgroup_id` 非空 ⇒ `runWorkgroupTask(state)`，
不进 `runScope`/`deriveFrontier`。引擎是一个**事件驱动循环**（完成驱动，风格同 runScope 的
`Promise.race`，scheduler.ts:865）：

```
loop:
  wake = 计算唤醒集（§4.2）
  if wake 为空 && 无 in-flight run:
      outcome = 终止判定（§4.4）→ done / awaiting_review(确认门) / awaiting_human(全员等人) / failed(触顶)
  为 wake 中每个条目 mint node_run（§4.1）并发起（globalSem 封顶，scheduler.ts:458 同款信号量）
  race(in-flight) → 单个完成：
      解析 envelope（§5）→ 落 assignment 状态/结果消息/新派单/新消息
      continue loop
```

### 4.1 mint 成员/leader run

复用 `buildMintNodeRunValues`（nodeRunMint.ts:141-191）+ fanout 直调 `runNode` 模式
（scheduler.ts:4420-4473 为参照）：

- leader 轮：`node_id='__wg_leader__'`，`retry_index`=轮次序，`rerunCause='wg-leader-round'`（新枚举值）；
- 成员单：`node_id='__wg_member__'`，`agentOverrideName`=成员 agent（schema.ts:914），
  `shardKey`=assignment id，`rerunCause='wg-assignment'`；消息唤醒轮（无单，§6.3）
  `rerunCause='wg-message-turn'`、`shardKey='msg:'+messageId`；
- runtime 冻结列照写（`resolveFrozenRuntime` 同款，scheduler.ts:2899-2902）；
- prompt 不走边端口推导——上下文由 §6 注入器组装后经 `runNode`（runner.ts:395）下发；
- born-running 约束（nodeRunMint.ts:162-168）不触碰：一律 mint `pending` 再转 running。

### 4.2 唤醒集（谁该跑）

| 模式 | 条目 | 触发条件 |
| --- | --- | --- |
| lw | leader | 首轮；或「本轮全部 agent 派单到达终态/泊态 且 (有新结果∥新黑板消息∥新人类交付∥确认门驳回)」；leader 不与自己并发 |
| lw | 成员单 | assignment `dispatched`（leader/人 @ 派单即刻起跑，不等回合边界） |
| 两者 | 消息唤醒轮 | `direct_messages` 开 且 存在 id 大于该成员游标（§1.6）的 @ 该成员消息 且 该成员无 in-flight run（§6.3） |
| fc | 首轮 | 全员并行唤醒（无单规划轮，拍板 #17） |
| fc | 成员 | 空闲成员 + 存在 `open` 任务 ⇒ 平台**代领**（CAS 置 `assignee+dispatched`，先到先得原子化，杜绝并发认领竞态）|

lw 的「等本轮全清再唤醒 leader」= 拍板 #2 预览图的批语义；人类单未交付**不阻塞** leader 唤醒
（作为「等待中」注入，leader 可自行决策等待——输出 `decision=continue` 且无新派单时任务泊
`awaiting_human`，交付/答复到达再续，复用 `resumeTask` CAS 重入，task.ts:1256/1308）。

### 4.3 daemon 重启 / 取消 / 恢复

- 状态全落库（assignments/messages/node_runs），引擎无内存态依赖 ⇒ `interrupted` 后
  `resumeTask` 重入回合循环，按表重建唤醒集（与 DAG 任务同经 autoResume.ts）。
- 取消任务：in-flight run 走既有 kill；非终态 assignment → `canceled`。
- 成员 run 失败：assignment `failed` + 失败消息落房间；lw 由 leader 下轮决策（重派/放弃），
  fc 该任务回 `open`（重派次数上限 = 全局 `defaultNodeRetries`，launchRuntimeConfig.ts:98，
  超限置 `failed` 留在清单）。

### 4.4 终止判定与硬顶

- lw：leader `decision=done` ⇒（确认门开）task `awaiting_review` / （关）收尾 done；
  硬顶 `leader 轮数 > max_rounds` ⇒ **failed** + 系统消息（loop wrapper 触顶同语义）。
- fc：无 `open/dispatched/running/awaiting_human` 单 且 无未消费消息 ⇒ 平台合成总结系统消息
  （聚合各单 result）→ 确认门/收尾同上；硬顶 `成员 run 总数 > max_rounds` ⇒ failed。
- 收尾不新增合并动作：成员 run 的 worktree merge-back 逐 run 已完成（RFC-130 既有）。

### 4.5 leader session 续接与游标增量

- leader run 捕获 `opencodeSessionId`（runner.ts:939-940）；下轮 mint 时读上轮 leader run 的
  session id 填 `resumeSessionId`（opencode `--session` spawn.ts:49-51 / claude `--resume`）。
- leader 的消费游标存 `workgroup_member_cursors`（§1.6，member_id=leader）：**有 session** ⇒
  注入游标之后的增量（新消息/assignment 变更）；**无 session**（首轮/捕获失败/runtime 更换/
  重启后续接失败）⇒ 注入全量态。游标推进与 mint 同事务（幂等，§1.6）。上下文块自足性要求见 §6.1。

## 5. envelope 协议（组专用端口，JSON 载荷）

组内 run 的协议块**由注入器生成，替代** agent 自声明 outputs（agent 的 `outputs` 列在组上下文
不生效；`buildProtocolBlock` 挂载点 prompt.ts:573-623 / trailing 组装 prompt.ts:541-548 /
runner 调用 runner.ts:651——扩展 `RenderPromptInput` 增加 `workgroupProtocol` 分支）。

| 角色 | 端口 | 载荷（JSON，zod 校验） |
| --- | --- | --- |
| leader | `wg_assignments` | `[{ member: displayName, title, brief }]`（可空数组） |
| leader | `wg_messages` | `[{ to: displayName \| null, body }]`（null=黑板） |
| leader | `wg_decision` | `{ action: 'continue'\|'done', summary? }`（done 必带 summary，作组总结消息） |
| worker | `wg_result` | `{ summary, detail? }`（summary 落房间结果消息 + 供互见注入） |
| worker | `wg_messages` | 同上（受 `direct_messages`/`blackboard` 开关约束，违规条目丢弃+系统消息告警） |
| fc 成员 | 追加 `wg_tasks_add` | `[{ title, brief }]`（平台按 `dedup_key`=标题归一化去重，§7.3） |

- 校验失败（JSON 解析/schema/成员名不存在）→ 复用既有 malformed 重试语义（envelope.ts:163-191
  诊断 + fail-retry），错误说明注入重试 prompt；leader 派活单里未知 `member` ⇒ 整轮拒绝重试
  （不部分接受，保持派单原子性）。
- worker 在 lw 模式**没有** `wg_assignments` 端口 ⇒ 转派在协议层就不存在（拍板 #20）。
- `<workflow-clarify>` 与组端口互斥沿用既有判别（envelope.ts:223/278）。

## 6. prompt 注入器（`services/workgroupContext.ts`，纯函数优先）

### 6.1 上下文块组成（全角色公共 → 角色特有）

1. 组章程 `instructions`（全员，拍板 #18）+ 目标 `goal` + 花名册（displayName/type/roleDesc/
   当前状态 working|idle|等待交付）；
2. 协作协议块（leader 版：纯协调不动手、派活单四要素指引、验收职责；worker 版：只干活/反问/
   发消息、禁转派；fc 版：自取制、添加任务先查重）；
3. 角色态：leader=派单总账（各 assignment 状态+结果摘要+人类交付+新消息，按水位线增量/全量，
   §4.5）；worker=本单任务书 + 按开关注入的切片（§6.2）；
4. 既有注入照常叠加：Clarify Q&A（clarifyQueue.ts:296-327）、memory block（memoryInject.ts:219）。

### 6.2 三开关 ⇒ 注入切片（纯函数 `selectMemberSlices(config, member, state)`）

| 开关 | off | on |
| --- | --- | --- |
| `share_outputs` | 无同伴信息 | 注入同伴已完成单的 `{member,title,result.summary}` 列表 |
| `direct_messages` | worker 的 `wg_messages` 只许 `to:null` 且黑板开才可用；不注入 @ 消息 | 注入「@我的未读消息」；可 `to:成员` |
| `blackboard` | 不注入房间流 | 注入公共消息尾窗（黑板消息+系统消息，字符预算裁剪，clipByBudget 同思路 memoryInject.ts:286） |

全关=纯星型（成员只见任务书）；fc 恒全开（`resolveVisibility` 强制，§1.1）。
**该矩阵 6 态是测试主锚点**（§13）。

### 6.3 消息唤醒轮

`direct_messages` 开时，@ 消息投给**空闲**成员（判定=存在 id 大于其 `workgroup_member_cursors`
游标的 @ 消息，§1.6）⇒ mint 无单 run（§4.1）并同事务推进游标，prompt=「你收到组内消息，
可回复/记录，不领任务」；其 run 计入 fc 硬顶计数。同成员有 in-flight run 则消息并入该 run
结束后的下一次注入（不打断运行中进程——回合制边界投递，业界常驻系统的即时打断在本平台统一
退化为此语义）。游标持久化保证 daemon 重启后不重复唤醒、消息风暴下同成员至多一个待发唤醒轮。

## 7. 服务与 API

### 7.1 routes（`routes/workgroups.ts`，CRUD 照 mcps 抄）

- `GET/POST /api/workgroups`、`GET/PUT/DELETE /api/workgroups/:id`（ACL 过滤/404 同形）
- `GET/PUT /api/workgroups/:id/members`（整表替换式更新，编辑器保存）
- `POST /api/workgroups/:id/tasks`（启动，§3）
- 任务内（成员制门禁=任务成员，与反问作答权同边界）：
  - `GET /api/workgroup-tasks/:taskId/room`（消息+派单卡聚合分页）
  - `POST /api/workgroup-tasks/:taskId/messages`（人发言；解析 @ ⇒ 直派单转 §7.2）
  - `POST /api/workgroup-tasks/:taskId/assignments`（人 @ 派单显式端点，body 含 member+brief）
  - `POST /api/workgroup-tasks/:taskId/assignments/:id/deliver`（人类单交付：`{ body }` 或
    `{ fields: {...} }` 结构化表单，二者归一为 delivery 消息 + `delivered`）
  - `POST /api/workgroup-tasks/:taskId/confirm`（确认门：`{ decision:'approve'|'reject', comment? }`）
  - `PUT /api/workgroup-tasks/:taskId/config`（中途改配置，§8.4）
- 收件箱：`GET /api/workgroups/pending-count`（我的人类待办单 + 我可确认的待确认门数），
  InboxFooterButton 第三数据源（failure-soft same as InboxFooterButton.tsx:39-40）。

### 7.2 人 @ 派单与消息路由（拍板 #14）

`POST messages` body 解析 mentions：@agent 成员 ⇒ 每个提及生成一张 `source='human'` 派单
（brief=消息正文）＋消息落房间；@人类成员 ⇒ 人类待办单；无 @ ⇒ `chat` 消息进黑板（lw 下作为
leader 下轮注入的「人类指令」项，无论 blackboard 开关——人类指令对 leader 恒可见）。

### 7.3 free_collab 去重护栏

`dedup_key = normalizeTitle(title)`（NFKC + 去空白/标点 + 小写）；`wg_tasks_add` 命中已有
非 canceled 单 ⇒ 丢弃 + 系统消息标注（不 fail 该 run）。prompt 侧要求添加前对照清单（§6.1-2）。
局限（近义不同词）文档化：人类可在房间取消冗余单（v1 提供 assignment cancel 端点，房间卡上操作）。

## 8. 人类成员、确认门、中途介入

### 8.1 人类单

派给 human 成员 ⇒ assignment `dispatched` + 房间待办卡 + pending-count 计数；交付双形态
（拍板 #16）：房间对卡回复（`POST messages` 带 `replyToAssignmentId`）或结构化表单
（deliver 端点 fields）→ 统一落 `delivery` 消息、状态 `delivered`；下一 leader 轮（fc：全员）
按开关消费。无超时策略（v1）：一直等，任务泊 `awaiting_human` 时收件箱可见。

### 8.2 确认门（含生命周期不变式兼容，设计门 Finding-2）

leader `decision=done`（fc：清单收敛）且 `completionGate` 开 ⇒ **最终 leader run 泊
`awaiting_review`**（fc 无 leader：mint 一行 `__wg_leader__` 宿主节点上的轻量门 run 承载状态，
`rerunCause='wg-gate'`）+ task → `awaiting_review`（schema.ts:488）＋房间系统卡。
结构上满足既有不变式「task awaiting_review ⟹ 存在 awaiting_review node_run」
（lifecycleInvariants.ts:349-367），**不触** review.ts 决策机/doc_versions。
两个 review 语义消费方加 workgroup 豁免（`task.workgroup_id` 非空即跳过）：
- `stuckTaskDetector` 的 S1 判定（「awaiting_review 无 pending doc_version ⇒ 卡住」对组任务
  恒误报）；
- S1 自动修复链（会误调 `dispatchReviewNode`）。
`confirm` 端点（任务成员均可，作答权同边界）：approve ⇒ 门 run done + task done；
reject（必带 comment）⇒ 门 run done + 系统消息 + lw 唤醒 leader 新一轮（驳回意见作为高优
注入项）/ fc 全员消息唤醒。驳回不回滚 worktree（组内继续改）。

### 8.3 中途投递消息

即 §7.2 的人类发言，无需任务泊住——运行中随时可发；lw 下一 leader 轮消费（拍板 #11/#14）。

### 8.4 中途改配置

`PUT config` 允许改：加/减成员、role_desc、三开关、max_rounds、completion_gate（**不许改**
mode/leader/repo）。写 `workgroup_config_json` 副本 + 系统消息。语义：新配置自下一次注入/
唤醒判定生效；中途加入成员不补历史（msghub 语义，拍板 #11——其首次注入的黑板尾窗从加入时刻起）；
移除成员：in-flight run 跑完、其非终态单转 `canceled`（lw）或回 `open`（fc）。借壳方案下
加成员**不动快照**（§2）。

## 9. WS 频道（RFC-152 六触点，照 scheduled-tasks 全套）

1. shared：`WorkgroupRoomWsMessageSchema`（`message.created` / `assignment.updated` /
   `round.started` / `gate.opened` / `config.updated`，帧带 `taskId`）+ `WS_PATHS.workgroupRoom
   = '/ws/workgroup-room'`（ws.ts:348-354/389 同形）；
2. broadcaster：`WORKGROUP_ROOM_CHANNEL` + TypedBroadcaster（broadcaster.ts:72/90 同形）；
3. registry：`WS_CHANNELS['workgroup-room']`（registry.ts:443-455 样例）——`pathRe` 带
  `?taskId=`；**upgradeGate 做任务成员校验（连接时一次 DB）+ frameGate 按帧 `taskId` 匹配订阅参数**
  （帧内不带成员表，靠 upgrade 时已校验的 taskId 绑定）；admin `tasks:read:all` 短路；
4. 前端 `useWorkgroupRoomWs`：invalidation 规则表（room query / assignments / task detail）；
5. 挂载：聊天室组件 + tasks.detail；
6. 生产者：workgroupRunner（round/assignment/decision）+ routes（消息/交付/确认/改配置）。
互锁测试随 rfc152 双 bijection 计数 +1（rfc152-ws-channel-registry.test.ts）。

## 10. 前端

### 10.1 资源页 `/workgroups`（决策 #21 修订）

- 列表（workflows.tsx 骨架）；**创建=弹窗**，只填名称+描述（其余字段走 schema 默认值），
  成功即跳详情。
- 详情页 `/workgroups/$name` = 配置编辑 + **卡片式成员管理**（multica Members 风格）：
  就绪度横幅（`workgroupLaunchReadiness` 的 no-agent-member / leader-missing 提示）+
  配置区（description/`.segmented` mode/instructions/三开关〔fc disabled 显 on〕/
  NumberInput max_rounds/确认门 Switch）+ 成员卡片区（每成员一卡：类型 chip、引用、
  role_desc；卡上编辑/移除/lw 设为 leader；「添加 agent 成员」「添加人类成员」各自 Dialog，
  agent 引用可自由输入〔悬空引用启动时才校验〕、human 走用户搜索）。传输仍是 PUT 全文档
  替换（前端纯函数 add/remove/setLeader/patch 组合后整体保存）。**保存恒宽松**：lw 无
  leader / 零成员均可存，启动门与横幅共用 `workgroupLaunchReadiness` 单一事实源。
  nav：并入 `workflows` 组（同为「可启动编排物」，避免一级导航膨胀）。
- 启动页 `/workgroups/launch?workgroupId=`：goal 多行输入 + repo source picker 复用 + 名称。

### 10.2 聊天室（组任务详情主视图）

- `components/workgroup/WorkgroupRoom.tsx`：消息流（分页向上加载）+ 回合分隔线 + 派单卡
  （assignment 实时状态 chip、点开 NodeDetailDrawer 看 run/Session——tasks.detail 已有
  drawer/SessionTab 复用）+ 人类待办卡（回复框/「表单交付」按钮=Dialog）+ 底部输入框
  （@ 补全=成员花名册，textarea+发送）+ 右侧栏（成员状态 working/idle/待交付 + fc 任务清单
  面板 + 确认门操作卡）。全部复用公共原语（Dialog/Form/StatusChip/EmptyState/.btn），新样式
  收敛在 `.workgroup-` 命名空间。
- 接线：`TaskDetailTab` 加 `'chatroom'`（task-detail-tabs.ts:9-19/29-41），
  `availableTabs` 扩参 `isWorkgroup`——组任务 tab 集=`chatroom`(默认)+`outputs`(隐藏，无声明
  端口)+`task-questions`+`worktree-structure`+`details`，**隐藏** `workflow-status` 画布；
  非组任务完全不变（对照锁测试）。
- `/tasks` 列表：workflow 单元格旁工作组徽标（`StatusChip` 复用，tasks.tsx:118-142 两候选位
  取 workflow 单元格），`TaskSummarySchema` 加 `workgroupId`。

### 10.3 i18n / 视觉

- `workgroup.*` key 双语（en-US/zh-CN）齐上；无既有视觉基线影响（settings.png 仅锁 settings
  默认 tab；聊天室是新页面，e2e 基线另立）。

## 11. ACL 与 prompt 隔离

- 资源面：第六类 `workgroup`（§1.1）；启动校验=工作组本身可用（引用闭包隐式授权，与 workflow
  同则）；保存时校验**新增**成员 agent 引用（`services/resourceRefs.ts` 既有机制扩一类）。
- 任务面：组任务恒成员制私有（owner+collaborators；人类成员自动并入 collaborators，§3）。
- **prompt 隔离不变式沿 RFC-099**：`user_id`/任务关系角色**绝不进 agent prompt**——花名册与
  消息注入一律用 `display_name`（human 成员建组时必填别名，§1.2）；`created_by_user_id`/
  `author_user_id` 只落审计列与 UI。镜像 `rfc099-prompt-isolation` 加双层锁测试
  （注入器输出无 userId 字段 + 端到端 prompt 文本无用户 id）。

## 12. 失败模式盘点

| 失败 | 处理 |
| --- | --- |
| leader 畸形输出/未知成员名 | malformed 重试（§5）；重试预算耗尽 ⇒ leader 轮 failed ⇒ 任务 failed + 系统消息 |
| 成员 run 失败 | §4.3：lw 报 leader 决策；fc 回 open 限次重派 |
| 全员等人（人类单+反问悬置） | 任务泊 `awaiting_human`，收件箱可见；交付/作答 resume（CAS，task.ts:1308） |
| fc 清单死锁（无人能领：成员全 failed） | 唤醒集空+清单非空+无空闲可派 ⇒ failed + 系统消息 |
| 并发：人 @ 派单 vs leader 派单同成员 | 允许并存（同成员多单排队跑，globalSem 封顶）；无锁竞争面（assignment 各自独立行） |
| 并发：交付/确认/改配置 vs 引擎读 | 全走 DB 行级 CAS（workgroupLifecycle 转移表）；引擎每次唤醒判定重读表（无内存态，§4.3） |
| daemon 重启 | interrupted → autoResume → 回合循环按表重建（§4.3）；消费游标持久化 ⇒ 唤醒判定幂等（§1.6） |
| 消息风暴（agent 刷消息） | 每 run 消息条数上限（协议内声明+平台截断落系统告警）；黑板注入恒预算裁剪（§6.2）；游标保证同成员至多一个待发唤醒轮（§6.3） |
| 确认门被 stuck 检测/自动修复误伤 | §8.2：门 run 泊 awaiting_review 满足不变式 + stuckTaskDetector S1 与 S1 修复链对组任务豁免（各一 guard + 各自测试） |

## 13. 测试策略（改动即带测，逐块）

**纯函数（首选断言面）**
- `selectMemberSlices` 三开关 2³ 矩阵 × lw/fc（fc 强制全开）——切片内容逐字段断言；
- `resolveVisibility`（fc 覆写）/ `normalizeTitle` 去重键 / 派活单与各端口 zod 校验
  （合法/未知成员/空数组/畸形 JSON）/ 唤醒集推导 `deriveWakeSet`（表驱动：lw 批语义、
  人类单不阻塞、fc 代领 CAS 前置态）/ 终止判定（done/收敛/触顶/死锁）/ 水位线增量切分；
- 协议块渲染快照（leader/worker/fc 三版，含禁转派文案锚点）。
**服务/集成（bun:test + 内存 sqlite，fake runner 桩沿 scheduler 测试先例）**
- 回合闭环：leader 派 2 单 → 并行完成 → leader 唤醒注入结果 → done（含确认门开/关两分支）；
- 借壳 mint：node_run 行 `agentOverrideName`/`shardKey`/`rerunCause`/runtime 冻结列逐格锁；
- clarify 贯通：成员 run 发问 → round 建行 → 答后续跑（合成快照 wire 有效性）；
- 人类单交付两形态归一、@ 解析路由（@agent/@human/无@ 三路）、驳回再起一轮、
  中途加成员不补历史（首次注入尾窗起点）、移除成员单转置；
- 触顶 failed + 系统消息；resume 重入幂等（CAS 双驱动防护）；游标幂等（重启后同一消息不
  二次唤醒、游标推进与 mint 同事务回滚一致）；
- 确认门生命周期：门 run 泊 awaiting_review 时 lifecycleInvariants 全绿（不变式兼容锁）、
  stuckTaskDetector 对组任务零 S1 误报、S1 修复链跳过组任务（三测分立）；
- migration：新表 + tasks 增列 + builtin seed；journal N→N+1（**bump upgrade-rolling
  计数锁 + tasks 全字段锁**，RFC-159 迁移同款教训）；
- WS：frameGate/upgradeGate 行为 + rfc152 双 bijection 计数 +1；
- prompt 隔离：§11 双层锁。
**前端（vitest）**
- WorkgroupRoom：消息渲染/回合分隔/派单卡状态 chip/待办卡交付两入口/@ 补全/输入框发送；
- 编辑器表单校验（lw 必 leader/fc 开关禁用）/启动页组装 body（含 goal 字段显式断言，
  防 RFC-125 型丢字段）/tabs：组任务默认 chatroom+隐藏画布、非组任务 tab 集不变（锁）；
- 徽标/收件箱第三源计数。
**源码级兜底锁**
- `renderUserPrompt` workgroup 分支不与 agent outputs 协议块并存（文本断言）；
- 组任务不进 `deriveFrontier`（runTask 分流断言）。

## 14. 兼容性、迁移与既有测试影响

- migration ×3（journal 各 +1）：A=workgroups/workgroup_members；B=workgroup_assignments/
  workgroup_messages/**workgroup_member_cursors**；C=tasks 两 ADD COLUMN + builtin seed INSERT
  + 索引；多语句 `--> statement-breakpoint` 分隔（手写迁移既有教训）。
- 受迫更新的既有锁：upgrade-rolling journal 计数、tasks 全字段锁、rfc152 bijection 计数、
  resource_grants 类型枚举锁（若有）。
- ~~定时任务（RFC-159）v1 **不支持**定时启动组任务~~（**已被 RFC-165 D11 取代**：
  `scheduled_tasks.launch_kind` 判别列 + 三主体 payload 封套已落地，组任务可定时启动，
  触发时按组资源当次配置冻结）。
- 现有工作流/任务/反问/评审路径零改动（分流点唯一：runTask 入口 + tabs 扩参 + 收件箱加源）。
