# RFC-175 任务「再次启动」全参数预填 —— design

> 前置事实全部对着当前源码核过（file:line 见正文）。核心复用既有 `?editScheduled=` 种子管线，**主重建路径零 migration / 零 wire 破坏**；**唯 agent 身份闭合破例加 1 枚 targeted migration + 一处启动写路径改动**（§2e，用户 2026-07-13 拍板 B）。

## §0 关键抉择

| # | 抉择 | 结论 |
|---|---|---|
| A | 数据来源 | **复用现有持久化列重建**（用户 D2），不新增 `launch_payload` 列。`scheduled_tasks.launchPayload` 那套「整存 StartTask body」**不**引入到 `tasks`。**例外（用户 2026-07-13 拍板 B）**：为忠实闭合 agent ABA，破例加**1 枚 targeted migration**（`tasks.source_agent_id`，§2e）；其余重建路径仍零 migration。 |
| B | 覆盖范围 | **三 kind 统一**（用户 D1）。 |
| C | seed 管线 | 新增纯函数 `taskToLaunchPayload(task) → payload`，产出与 scheduled `launchPayload` **同形**的 payload，喂现成 `payloadToWizardSeed`（`lib/task-wizard.ts:219`）。**不**新写一套 task→seed。 |
| D | 后端改动面 | `rowToTask` 增**两枚派生投影** `workgroupName` / `goal`（从 `row.workgroupConfigJson`）。**无** migration、**无** 新端点、**无** 新 join。 |
| E | agent allowClarify | 前端从 detail DTO 已含的 `workflowSnapshot`（`task.ts:143`）用纯 oracle 推断，不落后端字段。 |
| F | 入口 | `/tasks/new?relaunchFrom=<taskId>`，镜像 `?editScheduled=`。**不设 isEdit**。 |
| G | 追溯性 | 读既有列 ⇒ **remote/scratch/local 空间**的历史任务 best-effort 重放（相对 launch_payload 列方案免 backfill）；**internal 空间 / 中途失败多仓 / workflow upload 输入 / 已改名或复用的主体**降级为**安全缺省**（永不静默错误值，见 §7），不谎称「全部参数全可重放」（设计门 R1-F4/F5 收窄）。 |

## §1 现状盘点：detail Task 已含 vs 缺口（全部核过源码）

`GET /api/tasks/:id` 返回 `TaskSchema`（`packages/shared/src/schemas/task.ts:130-231`），映射器 `rowToTask`（`packages/backend/src/services/task.ts:2938-2999`）。**已含**、可直接重建的字段：

| WizardSeed 字段 | 来源（file:line） |
|---|---|
| `name`（任务名） | `Task.name`（task.ts:134） |
| `workflowId`（workflow 主体） | `Task.workflowId`（task.ts:135）——**仅 workflow kind 有意义**；agent/workgroup 是 host id |
| `agentName`（agent 主体） | `Task.sourceAgentName`（task.ts:230） |
| space.kind | `Task.spaceKind`（task.ts:224）：`scratch`/`remote` |
| space.repos[] | `Task.repos[]`（task.ts:209，`TaskRepoSchema`）：`repoUrl`(脱敏,可空) + `baseBranch` + `workingBranch` |
| `inputs`（workflow 输入） | `Task.inputs`（task.ts:174） |
| `description`（agent 提示词） | `Task.inputs['description']`——host 输入键 `AGENT_HOST_INPUT_KEY='description'`（`services/agentLaunch.ts:41,84,96`） |
| `gitUserName`/`gitUserEmail` | `Task.gitUserName`/`gitUserEmail`（task.ts:192-193） |
| `workingBranch`（顶层） | `Task.workingBranch`（task.ts:165） |
| `autoCommitPush` | `Task.autoCommitPush`（task.ts:171） |
| `maxDurationMs`/`maxTotalTokens` | task.ts:175-176 |
| `workflowSnapshot`（推断 allowClarify 用） | `Task.workflowSnapshot: z.unknown()`（task.ts:143） |

**缺口 3 项**及补法：

1. **`workgroupName`**（工作组主体，向导按名键控）——detail DTO 无（只 `workgroupId`，task.ts:219；名字仅在 summary，task.ts:275）。→ **§2** 后端派生投影。
2. **`goal`**（工作组提示词）——detail DTO 无。冻结在 `workgroupConfigJson.goal`（`services/workgroupLaunch.ts:97`，schema `workgroupRuntime.ts:51`）。→ **§2** 后端派生投影。
3. **`allowClarify`**（agent 反问开关）——非列。启动时烤进快照：`allowClarify ⟺ 快照含 kind:'clarify' 节点`（`services/agentLaunch.ts:98-102`）。→ **§3** 前端 oracle 从已下发的 `workflowSnapshot` 推断。

协作者不入 DTO：走既有 `GET /api/tasks/:id/members`（`routes/tasks.ts` `getTaskMembers`），返回成员 + 角色。

## §2 后端：两枚派生投影 + 三枚可选启动守卫参数 + 一枚 agent 身份 migration（§2e）

`packages/shared/src/schemas/task.ts` — `TaskSchema` 增两字段（均向后兼容 optional，fixtures 免改）：

```ts
/** RFC-175: 工作组任务的冻结组名（= TaskSummary.workgroupName 同源，来自任务自有
 *  workgroupConfigJson，非 live join，RFC-099 安全）。非工作组任务为 null。供「再次
 *  启动」按名回填工作组主体。 */
workgroupName: z.string().nullable().optional(),
/** RFC-175: 工作组任务的冻结 goal（来自 workgroupConfigJson.goal）。非工作组任务为
 *  null。供「再次启动」回填工作组提示词。 */
goal: z.string().nullable().optional(),
```

`packages/backend/src/services/task.ts`：

- 新增对称 helper `frozenWorkgroupGoal(configJson: string | null): string | null`，镜像已存的 `frozenWorkgroupName`（task.ts:3014-3026）——`try { JSON.parse } catch → null`，读 `.goal`（非字符串 → null）。
- `rowToTask`（task.ts:2938）产物加：
  ```ts
  workgroupName: frozenWorkgroupName(row.workgroupConfigJson),
  goal: frozenWorkgroupGoal(row.workgroupConfigJson),
  ```
  （`frozenWorkgroupName` 目前只在 summary 映射用，task.ts:3046；detail 补上，一致。）

**ACL / prompt 隔离核查**：detail 端点已是**任务成员**门控（RFC-099）；`goal`/`workgroupName` 来自任务**自有**冻结配置（非 live 工作组资源 join），与 room 端点早已向成员暴露 `config.goal` 一致 —— **无新泄漏面**。这两字段只进 DTO → 前端向导表单，**绝不进入任何 agent prompt 构造路径**（本改动不碰 prompt 组装）。

**§2b 工作组启动 `expectedWorkgroupId` 守卫（R2-F1b + R3-F5）**：前端 seed 时的 id 检查（§4.7）挡不住「seed→提交」间工作组被删+同名重建 / cache 陈旧——启动仍按 URL name 重查（`workgroupLaunch.ts:151-160`）静默快照新组 id。补**服务端原子守卫**（零 migration）：
- `StartWorkgroupTaskSchema`（`shared/schemas/workgroup.ts:275`）增**可选** `expectedWorkgroupId: z.string().optional()`（缺省=现状，普通启动零改动）。
- `startWorkgroupTask`（`services/workgroupLaunch.ts:158`）：`getWorkgroup(db, name)` **已对 missing/invisible 同形 404**（`workgroupLaunch.ts:158-161`）；**在该 404 门之后**、`buildWorkgroupRuntimeConfig` 之前比对——`expectedWorkgroupId` 提供且 `group.id !==` 之 → `ConflictError('workgroup-id-mismatch')`。**顺序关键（R3-F5）**：先 ACL/存在性 404、再 id 比对，避免 409-vs-404 沦为私有组名存在性探针。
- **前端传**捕获在 state 的稳定 id**，非每 render 从 live query 重导（R4-F2 修正 R3-F5）**：R3 拟 `expectedWorkgroupId = workgroupsQ.find(name)?.id` 每 render 重算——但**这本身就被 ABA 打穿**：所选组被删+同名重建后，一次后台 query 刷新会**无用户操作地**把 `find(name).id` 悄悄换成新组 id，请求遂带新 id、服务端 post-ACL 比对通过，防护失效。正确：**捕获 `selectedWorkgroupId` 到 state**——① seed 时（`task.workgroupId` 经 §4.7 id 一致性验证通过后）捕获；② 用户在 Select 显式改选时捕获所选组当刻的 id。`expectedWorkgroupId = selectedWorkgroupId`（**不随 query 刷新变**）。若后台刷新发现 `name` 现映射到**不同** id → **清除选择**逼用户重选（陈旧 captured id 提交 → 409）。这样：仅刷新替身→captured 旧 id 与服务端新 id 不符→409（防护成立）；用户显式改选→捕获新 id→放行。`workgroupLaunchErrorMessage` 加 `workgroup-id-mismatch` 友好文案。
- **纯守卫、无 migration、不改写路径**（启动前多一次 id 比对）。

**§2c workflow 启动 `expectedWorkflowVersion` 守卫（R5-F1，关规范化→提交版本竞态）**：§4.8 规范化按 seed 时 `inputDefs`（`vN`），但 `workflows.version` 每 PUT 递增（`services/workflow.ts:82-91`）、`startTask` 提交时快照**最新** workflow（`task.ts:920-989`）——他标签页推 `vN+1` 后提交会把 `vN` 值塞进 `vN+1` 快照，重开非法输入路径。与 §2b 同款守卫（零 migration，`workflows.version` 已存）：
- `StartTaskSchema` 增**可选** `expectedWorkflowVersion: z.number().int().optional()`（缺省=现状）；`startTask` 加载 workflow 后 `wf.version !==` 之 → `ConflictError('workflow-version-mismatch')`（对**同一**将快照的 wf 比对）。前端 relaunch(workflow) 携带 `workflowQ.data.version`；409 → 重取+重规范化。

**§2d 三守卫是「即时提交专用 OCC」，绝不持久化进定时任务（R6-F1，关兼容性阻断）**：`expectedWorkflowVersion`/`expectedWorkgroupId`/`expectedAgentId` 是**提交瞬间**的乐观并发校验、**非持久 launch 参数**。若经共享 `buildImmediateBody`/`buildLaunchBody*` 发出，会被 `scheduledEnvelope = buildScheduledEnvelope(kind, buildImmediateBody(), …)`（tasks.new.tsx:437-438）**原样包进「保存为定时任务」payload 并持久化**——如 `expectedWorkflowVersion`：workflow 后续正常 PUT 到 `vN+1` 后 schedule 每触发命中守卫 409、累积禁用（定时本就**应触发时用最新 def**，钉版本语义错误）。故：
- 三守卫**只作即时提交 overlay**：在 immediate `start.mutationFn` 的 POST body 上 spread（各即时 POST 站点 workflow-JSON/multipart/agent/workgroup 一致），**绝不**进 `buildImmediateBody`/`buildLaunchBody*` → `scheduledEnvelope`（用干净 `buildImmediateBody`）天然不含。撤销 §2c 早稿的 RFC-125 白名单 stamp（守卫非 builder 字段）。定时 payload schema 显式**拒收**三字段。

**§2d-1 save-as-schedule 的主体身份 = 定时系统既有 name 定位，整体出范围（R8-F1 修正 R7-F1）**：relaunch 向导（非 isEdit）可经 `ScheduleDialog`（`tasks.new.tsx:1017-1024`）保存定时、**不过 `start.mutationFn`**；定时 payload **端到端按 name 定位主体**（`ScheduledWorkgroupPayloadSchema.workgroupName`；create 时 `assertScheduledTargetUsable` + fire 时 `scheduleLaunch` 均 `getWorkgroup(db, name)`——RFC-159 既有设计）。
  - **R7 曾拟前端 precondition 闭 seed→save 窗，但 R8 证其为 theater**：ScheduleDialog 直接 POST、服务端在 **INSERT 时按 name 解析当刻主体**（`scheduledTasks.ts:180-244`），前端拿陈旧 cache 比 captured id 挡不住「cache 见 A、POST 前 A 删+同名建 B」；**且即便 create 时校验了 id，schedule 触发仍按 name 重解析（fire-time）**——create-only 校验对一个 name 定位的持久 recipe **无持久效力**（纯 theater）。故**撤销该 precondition**。
  - **整体定位（create + fire）= 定时系统既有 name 语义**：所有 schedule（fresh 建 / relaunch 存）皆按 name 定位当刻同名资源。RFC-175 **不改**、**不新增** durable-id 定位（那是独立的「定时身份稳定化」scheduled-task RFC，牵动整条 create+fire 路径、影响所有 schedule）→ **出本 RFC 范围**、列可选 follow-up。
- **claim 订正（R8-F1）**：RFC-175 闭合的是**即时 relaunch 主体 ABA**（校验==launch 同一时点、有持久效力）；**save-as-schedule 的主体身份沿用定时既有 name 定位、不在本 RFC**（非回归——所有 schedule 皆然）。三守卫仍只即时 overlay、不进 schedule payload（§2d）。回归：「relaunch→保存 schedule→PUT workflow→触发」payload 不含 `expected*`、触发不 409。

**§2e agent `sourceAgentId` 持久化 + `expectedAgentId` 守卫（用户 2026-07-13 拍板：为忠实闭合 agent ABA，破例加 1 migration）**：R2-F1a 指出 agent 有稳定 id 但**任务只存 `sourceAgentName` 不存 id**、终态任务的 agent 可删+同名重建 → 零 migration 不可验证。用户选择「加 migration 忠实闭合」。方案（与 §2b/§2c OCC 同款，第三枚即时 overlay 守卫）：
- **migration（1 枚，number 实现期定，与 RFC-170 协调；journal bump → 同步 `upgrade-rolling.test.ts` [[reference_migration_bumps_journal_count_test]]）**：`ALTER TABLE tasks ADD COLUMN source_agent_id TEXT`（nullable；非 agent 任务 + 本 migration 前的**历史 agent 任务**均 NULL）。**不 backfill**——按 name 反查现存 agent id 恰恰会踩 ABA（同名可能已是别的 agent），宁可留 NULL 走 best-effort，也不 stamp 错 id。
- `schema.ts` 加列；`TaskSchema` +`sourceAgentId: z.string().nullable().optional()`。
- **身份守卫：早检 + 进程内身份 reservation（根因阻断，取代 R9-F2 深补偿）+ in-tx 不变式（R8-F2 + R9-F2 + R10-F1）**。`sourceAgentId` 由 `task.ts` **中央 INSERT** 写入（非 `agentLaunch.ts`——R8 勘误）。
  - **早检（materialize 前，堵常见面、零孤儿）**：`startAgentTask` ACL-404 解析 agent 得 `resolved.id` 后、**在 `materializeSpace` 之前**比对 `expectedAgentId != resolved.id → ConflictError('agent-id-mismatch')`。尚未建 worktree → 「启动/材料化前已被替换」fail-fast。
  - **进程内身份 reservation——引用计数 + acquire 后重验（R10-F1 根因 + R11-F1 并发订正）**：agent id 被**多个并发 launch 共享**（与 `materializingSpaces` 键=唯一 task id 不同），故**不能**用裸 set-delete（否则 L1 `finally` 删键时 L2 仍在 materialize→窗重开）。取**引用计数 registry** `Map<agentId, count>`（或 holder-token Set）：每个 launch acquire 时 `count++`、`finally` `count--`，**仅 count→0 才移除**；`deleteAgent`/`renameAgent` 检查 `count>0 → ConflictError('agent-launching')`。→ 并发同-agent launch 各持一份、delete/rename 须待**全部** release 才放行。
    - **acquire 后、materialize 前重验（补 resolve→acquire 窗，R11-F1）**：解析/ACL/校验跨多 await（`agentLaunch.ts:137-157`），若 delete 在 acquire **前**已完成，lease 只锁住陈旧 id。故 acquire 后**再做一次 ACL-safe 的 name→id 读取**、确认 == `resolved.id`（不符 → `agent-id-mismatch`，**零文件系统副作用阶段** fail）。
    - **`try { …早检+校验+materialize+INSERT… } finally { release() }`** 包全程——早检异常 / 校验异常 / materialize 异常 / INSERT 失败**都** release（不泄 lease）。
    - **daemon 单进程（flock）→ 进程内计数足够**（无 durable/崩溃面：崩溃即重启、计数与半途 launch 同灭，残留 worktree 归既有 interrupted/GC——非 RFC-175 新面）。有此 reservation + 重验后，「materialize 中被替换」窗根本不发生。
  - **in-tx name+id 不变式（belt-and-suspenders）**：仍把 `resolved.id` 线程进 `StartTaskDeps.agentLaunch`（`{ agentName, agentId, snapshotJson }`）；dbTxSync same-name re-check（`task.ts:1108-1123`，F17）**断言取到的 id == 线程 `agentId`**、`sourceAgentId` 从该 id 写。有 reservation 兜底后此断言**理应永不 fire**（reservation 已阻止替换）；万一 fire（不变式破）→ throw + 记录 + best-effort 清理（非主路径，故**不需 R9-F2 的深 ref-恢复补偿协议**——reservation 从源头消了该窗，规避了 `removeWorktree` 不删 ref / 不恢复 working-branch OID / 无 durable 重试锚点 的坑，R10-F1）。
- **前端 agent relaunch——用 captured `selectedAgentId`、非死绑 `task.sourceAgentId`（R8-F3，镜像 §2b workgroup）**：agent Select 可编辑（`tasks.new.tsx:660`），死绑 `task.sourceAgentId` 会让用户改选 B 时 `URL=B & expectedAgentId=A` 必 409。改：`selectedAgentId` state——**seed 时**（`task.sourceAgentId` 非 NULL 且 `agentsQ` 当前 name→id 一致时）捕获；**显式改选**时取所选 agent 当刻 id；**kind/清选**时清。即时 POST 携 `expectedAgentId = selectedAgentId`。`task.sourceAgentId` **为 NULL**（历史任务）→ 无 id 可验、退回 best-effort 按名。
- **闭合边界（如实）**：post-migration 的 agent 任务 ABA **闭合**；migration 前的历史 agent 任务仍 best-effort（NULL 无从验证）——与用户「只保护未来任务、不能 backfill 历史身份」的认知一致。

## §3 前端纯函数：`taskToLaunchPayload` + `snapshotClarifyState`

均落 `packages/frontend/src/lib/task-wizard.ts`（纯、可逐字段单测，符合本仓「首选可断言面」）。

**设计不变式（设计门 R1 折入）：预填只产**可信默认或**安全缺省，绝不产静默错误值**；任何无法**忠实且安全**重建的字段一律降级为向导的正常空/默认值，交由向导既有校验门（missingRequired / readiness / 分支校验）阻拦非法启动。

### `snapshotClarifyState(snapshot: unknown): true | false | 'unknown'`（**三态**，R1-F6）

```
无法解析（非对象 / nodes 非数组）                       → 'unknown'
结构有效 & nodes.some(n => n?.kind === 'clarify')       → true
结构有效 & 无 clarify 节点                               → false
```
`taskToLaunchPayload` 仅在结果 **=== false** 时才向 payload 写 `allowClarify:false`；`=== true` 或 `'unknown'` 时**省略**该字段 → `payloadToWizardSeed` 缺省 true（`task-wizard.ts:245-248`）。这样「结构缺失/损坏」不会被误当成「关了反问」（修正初版布尔把 unknown 塌成 false 的 bug）。clarify 节点仅在启动时 allowClarify=true 才注入（`agentLaunch.ts:98-102`）。

### `taskToLaunchPayload(task: Task): { payload; spaceResolvable }`

产出与 scheduled `launchPayload` 同形、可喂 `payloadToWizardSeed(taskExecutionKind(task), payload)` 的 payload，并回带 `spaceResolvable`（**仅** space 可从 Task 单参判定）。**主体是否可解析（R3-F3 勘误）不在此函数**——它只有 Task 参数、无当前资源清单，判不了「同名 agent/workgroup 当前是否存在/一致」；主体校验是 §4 向导侧的事（对 `agentsQ`/`workgroupsQ` 比对）。按 `taskExecutionKind(task)`（`shared/schemas/task.ts:289`，唯一判别点）分派。

**空间重建——`spaceKind` 是四态（R1-F4，`SPACE_KINDS=['local','remote','scratch','internal']`，task.ts:56）**，逐态定义、不再「非 scratch 即 remote」：
```
scratch  → { scratch: true }                              spaceResolvable=true
remote   → { repos: task.repos.map(toStartRepo) }         spaceResolvable=true
local    → repoUrl 非空 → { repos:[…] }（脱敏 URL）        spaceResolvable=true(best-effort)
           repoUrl 为空(纯 path 遗留) → 空间留向导默认      spaceResolvable=false（用户重选仓库）
internal → **入口已抑制（§5，R4-F1）**——fusion 任务不给 relaunch。此函数不应见到 internal；防御性 spaceResolvable=false + §4 seedFailed。
toStartRepo(r) = { repoUrl: r.repoUrl ?? '', ...(r.baseBranch ? { ref: r.baseBranch } : {}) }
```
> **多仓中途失败——检测靠 `failedNodeId`，不靠 `repoCount`（R3-F1 修正 R2-F4）**：materialize 在首个失败仓**停下**、`repoCount = Math.max(1, materializedRepos.length)`（`services/task.ts:1159-1162`），故「原 2 仓、第 2 仓失败」的任务落库 **`repoCount=1`**（回归 `start-task-multi-repo-materialize.test.ts:232-270` 实证）——`repoCount>1` 门**根本不触发**，唯一成功仓还能过 `sourceReady`，静默只跑子集。正确的**结构信号**：**materialize 发生在 scheduler / pre-validation 之前**，materialize 失败时任务以 early-error 直接落库、**从未有 node 运行 → `failedNodeId==null`**（R4-F5 订正措辞：不是「failedNodeId 只在 node run 写」——scheduler pre-validation 也可能给不支持节点/非法 wrapper-git 预置 nodeId；但那些都在 materialize **成功之后**、仓库完整，`failedNodeId` 有值 → 不 gate，正确）。故门 = **`status==='failed' && failedNodeId==null` 且 space 为 remote** → `spaceResolvable=false` + 「已确认仓库列表完整」显式勾选才放行。此信号**必抓** materialize partial（含 `repoCount=1` 那例），只**安全过度**覆盖「materialize 后、node 前因其它 early-error 失败」（罕见、仓库完整、多一次勾选无害）。**回归必须用 remote 两仓 fixture**（R4-F5：现有 B11 是 local repoPath、`spaceKind=local` 且不断言 repoCount，证不了 remote 案）：造「两 remote 仓、第 2 仓 worktree 创建失败」，断言 `status=failed` / `spaceKind=remote` / `repoCount=1` / 一行持久化 / `failedNodeId=null`，再验确认门。

**公共部分**（三 kind 共用）：
```
name: task.name
...space（上表）
...(task.gitUserName && task.gitUserEmail ? { gitUserName, gitUserEmail } : {})
...(task.workingBranch ? { workingBranch: task.workingBranch } : {})
...(task.autoCommitPush ? { autoCommitPush: true } : {})
...(task.maxDurationMs != null ? { maxDurationMs } : {})
...(task.maxTotalTokens != null ? { maxTotalTokens } : {})
```
（协作者**不入** payload——见 §4，kind 相关处理。）

**按 kind 追加判别式 + kind 专属字段**：
| kind | 追加 | 主体身份（R1-F1） |
|---|---|---|
| `workflow` | `workflowId: task.workflowId` · `inputs: 见下 upload 剔除` | workflow **有稳定 id**，`task.workflowId` 直用；主体是否仍存在由 §4 对 `workflowsQ`/详情查（详情 GET 404 → seedFailed）。 |
| `agent` | `agentName: task.sourceAgentName` · `description: task.inputs['description'] ?? ''` · clarify 三态 · `expectedAgentId: task.sourceAgentId`（非 NULL 时，§2e） | agent 有稳定 id、任务原只存 name（R2-F1a）；**用户拍板加 `source_agent_id` migration 忠实闭合**（§2e）。**post-migration 任务**：`task.sourceAgentId` 非 NULL → 按名 pre-select + 携 `expectedAgentId` 服务端 ACL-404 后比对（删+同名重建→409）。**历史任务**（`sourceAgentId` NULL）：无 id 可验 → best-effort 按名（§4 对 `agentsQ` 查、name 不在→不选）；form-review 仅 UX 缓释。 |
| `workgroup` | `workgroupName: task.workgroupName ?? ''` · `goal: task.goal ?? ''` | workgroup **有稳定 `workgroupId`**（task.ts:219）→ §4 用它做**同名 id 一致性守卫** + 启动时 `expectedWorkgroupId`（§2b）。守卫比对当前**所选**组 id 而非死绑源 id（R3-F5）。 |

**workflow 输入按当前 `inputDefs` 规范化（R4-F3 修正 R3-F2）**：种子 `inputs` 来自 `task.inputs`，但当前 workflow 定义可能已 sync 改版（`syncTaskWorkflow` 原地覆写 snapshot、不动 inputs，`task.ts:1987-1992`）——旧值对当前 def **未必合法**。**关键坑（R4-F3）**：upload-kind 值是 repo-relative 路径，若该键现改成 `enum`，`EnumPicker` 只渲染声明选项、旧路径**不显示为任何选中项（不可见）**，而 `missingRequired` 只看「非空字符串」→ 判为已填、**放过提交**，后端又接受任意字符串 → 用户**静默提交非法 enum 值**。故不是「可见可改」——要**主动规范化**（此为 bug 修复、**无需 migration**）：seed 后按**当前 `inputDefs`** 逐键校验，**清除**不满足当前 def 的值——upload-kind（不能重建 File）、enum 值不在当前 choices、multi-enum 非法 JSON、number 非法等——并**显式提示**「N 个输入无法沿用、已清空，请重新填写」；必填的走 `missingRequired` 门；multipart builder 防御剔除非新 File 支撑的 upload 值。**唯一真残留**（需 migration）：**精确恢复原上传文件**——但这与「必填 upload 本就要重选」等价，非新增损失。故 upload provenance **不再是 migration 决策项**（R4-F3 收窄）。AC3/AC4 明确**不含** upload 文件原样回放。

消费端 `payloadToWizardSeed`（`lib/task-wizard.ts:219-262`）逐字段对齐：判别式 → discriminant；`name`→taskName；`scratch`/`repos`→space（复用 `bodyToRepoSources`）；`inputs`；`description`；`goal`；`allowClarify !== false`；`gitUserName/Email`；`workingBranch`；`autoCommitPush === true`；`maxDurationMs/maxTotalTokens`。**逐字段闭合**。

> 注：`repoUrl:''` 占位行 `bodyToRepoSources` 保留为空 URL 行（`launch-repo-source.ts:156-171`），向导 Step-2 渲染为可修复空行——与 legacy schedule 修复同款体验，非报错。

## §4 前端接线：`/tasks/new?relaunchFrom=<taskId>`

`packages/frontend/src/routes/tasks.new.tsx`：

1. **search 参数**：`TaskWizardSearch` 增 `relaunchFrom?: string`；`validateSearch` 解析（`typeof === 'string' && length>0`，tasks.new.tsx:83-86 循环加键）。
2. **互斥**：`editScheduled` 与 `relaunchFrom` 互斥——`editScheduled` 存在时**忽略** `relaunchFrom`（isEdit 优先，文档 + 守卫）。
3. **query 集**（仅 `relaunchFrom` 非空且非 isEdit 时 enabled）：`relaunchTaskQ`(GET /api/tasks/:id) + `relaunchMembersQ`(GET /api/tasks/:id/members)；错误码：**已删 → 404 `task-not-found`（`routes/tasks.ts:186`）/ 不可见 → 403 `task-not-visible`（visibilityCheck `routes/tasks.ts:637-648`）**（R3 订正：二者非同形）。此外**按 kind 依赖既有清单查**：workflow→`workflowsQ`+选中 workflow 详情（`inputDefs`）；agent→`agentsQ`；workgroup→`workgroupsQ`。
4. **members 形状（R1-F3）**：`TaskMembers` 对象 `{ owner: UserPublic|null, users: UserPublic[], canManage }`（`taskCollab.ts:22-31`）；`users` 是 collaborators、**owner 单列**（`services/taskCollab.ts:94-121`）。非数组、无 toUserPublic。
5. **协作者集 = owner ∪ collaborators − launcher（R3-F4 修正 R2-F2）**：`members.users` **仅** collaborators，owner 在 `members.owner`；再次启动的新任务 owner=**当前点击者**（可能是原任务的 collaborator/admin）。若只填 `members.users` 会**静默丢原 owner**（原 owner 失去新任务访问权）。故 agent/workflow 的当前成员集 = `[members.owner, ...members.users]`，**排除**新 launcher（`actor.user.id`）+ 排除 inactive/`__system__`。语义如实标注「**当前成员**（含原 owner）作可编辑默认，非忠实原始 launch 集」。
   - **workgroup**：**不预填**（无 provenance 并集会越权授旧成员；启动按当前 roster 重派）。
   - **跨-kind 防漏**：`collaborators` 公共状态、`buildWorkgroupStartBody` 会发 → **kind 变更清 `collaborators`**（并入 kind-change handler tasks.new.tsx:600-606）。
6. **`relaunchPhase` 状态机——barrier 含全部必需异步、每条都有 error/retry（R4-F4 深化 R3-F3）**：`'idle'|'loading'|'applied'|'error'`。
   - **依赖 barrier**（success 才 apply）：`relaunchTaskQ` ＋ `relaunchMembersQ`(agent/workflow) ＋ kind 清单查（workgroup→`workgroupsQ`；agent→`agentsQ`；workflow→`workflowsQ`＋选中 workflow 详情`inputDefs`）＋ **`useActor()` 就绪**（协作者排 launcher 要它）。**actor 三态（R5-F2 修正）**：`useActor` 把所有 `/api/auth/me` 失败 catch 成 **`data:null` 的 success**（`useActor.ts:47-49`）——**永不 `isError`**！故不能只等「`actor.data` 非 null」（过期会话 / PAT 缺 `account:self` 会永挂 loading）。正确：`isPending`→loading；**`isSuccess && data===null`→可操作鉴权错误面**（`actor.refetch`/重登，非挂死）；`data` 非 null→读 **`actor.data.user.id`**（shape 订正）、排 `__system__`（daemon actor 用 `__system__` user、`MeResponse.user` 是必填——R5 订正：非「daemon 无 user」）。
   - `loading`（**冻结编辑 + 禁提交**，镜像 `TaskMembersPanel` dirty 74-81）：barrier 任一在飞不解冻。
   - `applied`（**一次性原子**）：barrier 全 success → `applyWizardSeed` ＋ 主体守卫（7）＋ 协作者集（5）＋ 输入规范化（8）＋ 多仓门（9）一次性写入解冻；置 `applied` 后**拒晚到写入**。`seed===null`/`spaceKind==='internal'`/主体不可解析 → `error`+seedFailed。
   - `error`——**每条必需 query 都有终态转移（R4-F4：否则某清单/详情 `isError` 会永挂 loading）**：task 403/404/网络 → 错误面+禁提交；**主体清单查 / workflow 详情 `isError` → 可操作错误面（重试）**，不悬挂；**members 失败**独有「弃协作者继续」（确认后清空 + 放行 `relaunchCollabReady`）——「弃继续」只给 members，主体清单/详情必须重试或报错。
   - `STEP_MODE` + `maxVisited=STEP_CONFIRM`。
7. **主体身份守卫**：
   - **workgroup**：`applied` 时用 `workgroupsQ` 查当前同名组，`found?.id !== task.workgroupId`（含未找到）→ 不 pre-select + 提示；**捕获** `selectedWorkgroupId`（§2b，R4-F2）；提交 body 带 `expectedWorkgroupId = selectedWorkgroupId`（捕获值，非 live 重导）→ 服务端 ACL-404 后原子比对；后台刷新使 name 改映射 → 清选择逼重选。
   - **agent（§2e，用户拍板 migration 闭合）——镜像 workgroup 三分支（R9-F1 修正）**：`task.sourceAgentId`
     - **NULL（历史任务）**：无 id 可验 → `agentsQ` 含 name 则 best-effort 按名 pre-select（无守卫、form-review 缓释）。
     - **非 NULL 且当前同名 id == sourceAgentId**：pre-select + **捕获 `selectedAgentId`**；即时 POST 携 `expectedAgentId=selectedAgentId`。
     - **非 NULL 但当前同名 id ≠ sourceAgentId（或 name 不在列表）= 主体不可解析（R9-F1 关键）**：**不 pre-select + 禁提交 + 提示显式重选**（原 agent 已被同名替身取代）——**绝不降级成「pre-select 名 + 空 token + 省略守卫」的 guardless 请求**（否则 seed 前就被替换的 B 会无守卫启动、绕过 OCC）。用户显式重选后捕获当刻 id、放行。
     `selectedAgentId` 显式改选更新、kind/清选清（R8-F3）。服务端 ACL-404 后比对 + in-tx 精确重验（§2e）。
8. **输入规范化 + 版本绑定（R4-F3 + R5-F1）**：seed 后按**当前 `inputDefs`** 逐键校验，**清除**不满足当前 def 的种子值（upload-kind〔不能重建 File〕、enum 不在 choices、multi-enum 非法 JSON、number 非法等）+ 提示「N 输入已清空、请重填」——堵 enum 静默非法提交；必填走 `missingRequired` 门；multipart 防御剔除。**捕获** `workflowQ.data.version`（规范化所依据），提交带 `expectedWorkflowVersion`（§2c）→ 服务端版本不符 409 → 重取详情+重规范化（关「规范化→提交」间 def 被改的竞态）。
9. **多仓失败门（R3-F1 修正）**：`status==='failed' && failedNodeId==null && space=remote` → `spaceResolvable=false`：仓库列待确认 + `sourceReady` 追加「已确认仓库完整」显式勾选才放行。
10. **`applyWizardSeed(seed)` 抽取**：把 editScheduled effect 的 `setKind/…/setMaxTotalTokens`（tasks.new.tsx:206-224）抽成函数两路**共用**；editScheduled 的 setKind-lock + collabLookup 路径保留在其 effect 内（回归 §6.8 锁）。
11. **不设 isEdit**：`relaunchFrom` **不**进 `isEdit`（tasks.new.tsx:103 不变）。主行动仍是 `start`、kind 不锁可改（改 kind 清主体+协作者、弃 kind 专属 seed）。

## §5 入口切换

`packages/frontend/src/routes/tasks.detail.tsx`：

- **relaunch `<Link>`**（tasks.detail.tsx:306-321，`task-detail-relaunch`）：`search` 从三分支主体深链 → **统一** `{ relaunchFrom: tk.id }`。gate = `isTerminal(tk.status)` **且 `tk.spaceKind !== 'internal'`**（R4-F1：internal=fusion 框架内部任务，其 workflow 是 builtin `aw-skill-fusion`、`/api/workflows` 不列、`assertNotBuiltin` 会 403——**不可用户 relaunch**，直接不给入口）。
- **resume 兜底 `<Link>`**（tasks.detail.tsx:350-366，`resumability==='worktree-missing'`）：同样切 `{ relaunchFrom: tk.id }` + 同 internal 抑制。
- 工作组不再传裸 `{kind:'workgroup'}`——**源码锁**（§6）防回归。
- **wizard 侧防御（R4-F1）**：即便被直接导航到 `?relaunchFrom=<internal 任务>`，seed 时检出 `spaceKind==='internal'` 或 workflow 主体不可解析（builtin/详情 404）→ `error`+seedFailed 面（不提交 builtin id）。e2e 证「fusion 任务无 builtin workflowId 能抵达提交」。

**工作组 room 入口（开放问题，§proposal 7）**：评估 `WorkgroupRoom` / `workgroups.detail` 是否为工作组任务主视图。默认沿用 tasks.detail 通用入口（工作组任务同样有 tasks.detail 页）；若需 room 内直达，加一枚指向同 `?relaunchFrom=` 的 `.btn`（复用现有样式，不新写 chrome）——列为可选增量，非本 RFC 验收所需。

## §6 测试策略（必写清单，PR 全绿才算交付）

纯函数（首选可断言面）：
- **§6.1 `taskToLaunchPayload`**：三 kind × spaceKind（scratch / remote 单仓 / remote 多仓 / local〔repoUrl 有 & 空〕）× {有/无 git、workingBranch、autoCommitPush、limits}，逐字段断言 payload + **`spaceResolvable`**（R4-F6：**只此一旗标**，`subjectResolvable` 已移除、主体校验归 §6.5 状态机）。专项：agent `description`←`inputs['description']`；workgroup `workgroupName`/`goal`←新 DTO；`repoUrl` 脱敏/空→占位空行；`ref=baseBranch`；空 local→`spaceResolvable=false`。
- **§6.2 `snapshotClarifyState`（三态，R1-F6）**：合法有 clarify → true；合法无 → false；null / 坏 JSON / nodes 非数组 → `'unknown'`；断言 `'unknown'`/true 均**不**写 `allowClarify`、仅 false 写。
- **§6.3 round-trip**：`taskToLaunchPayload(task)` → `payloadToWizardSeed(kind, ·)` → 断言 `WizardSeed`（含 space 经 `bodyToRepoSources` 重建、agent allowClarify 缺省 true 语义、workgroup goal/name）。
- **§6.4 后端 `rowToTask` 派生**：工作组任务行 → `workgroupName`/`goal` 有值；非工作组行 → 均 null；坏 `workgroupConfigJson` → 均 null（不抛）。`frozenWorkgroupGoal` 单测。

集成 / 接线：
- **§6.5 向导 relaunch 状态机（R1–R4-F3/F4）**：`?relaunchFrom=` → query 集；members 用 `.users`；**协作者集 = `[owner,...users]−launcher−inactive/system`**（含原 owner；三种发起者 owner/collaborator/非成员 admin），**workgroup 不预填**；`relaunchPhase` barrier 含 task+members+**kind 清单+workflow 详情+`actor.data` 就绪**（`actor.data.user.id` shape、daemon 无 user）才 apply（deferred 测：workgroupsQ 慢不误判、inputDefs 晚到不漏规范化、**某清单 `isError` 不永挂**〔R4-F4〕）、applied 后拒晚到；`relaunchCollabReady` 门、members 失败「重试/弃继续」、主体清单/详情失败可重试错误面；task **403/404/网络**→错误面禁提交；**输入规范化**（R4-F3）：**upload→enum 场景断言旧路径被清、不可静默提交**、非法 number/JSON 清、必填 upload 阻提交；**kind 切换清 `collaborators`**；未设 isEdit、kind 未锁、不污染 editScheduled。
- **§6.6 主体身份守卫（R1–R4-F1/F2）**：workgroup 当前同名组 id≠task.workgroupId（改名/删/同名重建）→ 不 pre-select+提示；**captured `selectedWorkgroupId`：后台刷新替身→提交仍带旧 id→409**（R4-F2）、**显式改选 Y→带 Y.id 放行**；agent：`agentsQ` 含 name→pre-select、不含→不选。
- **§6.7 后端启动守卫（workgroup `expectedWorkgroupId` R2-F1b/R3-F5 + agent `expectedAgentId` §2e）**：id/agent 匹配→放行；不符→409（`workgroup-id-mismatch` / `agent-id-mismatch`）；缺省→现状；**比对在 ACL/存在性 404 之后**（不可见仍 404、非 409 探针）。
- **§6.7b agent `sourceAgentId` migration + 持久化 + relaunch 闭合（§2e/R8/R9/R10）**：migration parse + journal N bump；`rowToTask` 投影；**早检**（materialize 前 id 不符→fail、零孤儿）；**进程内 reservation 引用计数**（R10-F1/R11-F1：launch 期间 `deleteAgent`/`renameAgent`→`agent-launching` 409；`Map<agentId,count>` acquire++/finally--、仅全释放行；acquire 后 name→id 重验；**确定性交错回归：并发同-agent L1 失败释放而 L2 仍在时 delete/rename 必续 409、resolve 后 acquire 前 delete+recreate 须零文件系统副作用阶段 fail**）；**in-tx name+id 不变式**（`sourceAgentId` 从重验 id 写、断言 == 线程 id〔有 reservation 后应恒真〕）；**seed 前替身→前端不 pre-select+禁提交+重选**（R9-F1 完整向导回归：A 任务→seed 前删 A 建同名 B→不得启动、显式重选后放行）；captured `selectedAgentId` 改选 A→B 放行；历史 NULL→best-effort。（不再测 R9-F2 深补偿——reservation 从源头消窗。save-as-schedule 主体身份属定时既有 name 定位、不测入本 RFC，§2d-1。）
- **§6.8 多仓失败门（R3-F1/R4-F5）**：**remote 两仓 fixture、第 2 仓 worktree 创建失败** → 断言 `spaceKind=remote/repoCount=1/failedNodeId=null` → 门要求「已确认仓库完整」勾选才放行；node run 失败（failedNodeId 有值）不触发。
- **§6.9 internal fusion 抑制（R4-F1）**：internal 任务 tasks.detail **无 relaunch 入口**；直接 `?relaunchFrom=<fusion 任务>` → seedFailed，**无 builtin workflowId 抵达提交**（e2e）。
- **§6.10 源码锁**：`tasks.detail.tsx` 工作组 relaunch **不再**出现裸 `{ kind: 'workgroup' }`。
- **§6.11 editScheduled 回归**：抽 `applyWizardSeed` 后 `?editScheduled=` 行为逐字段不变（现有用例全绿 + kind-lock/collabLookup 路径未受 kind-change-清协作者 改动影响）。
- **§6.12 三 OCC 守卫不泄漏定时（R6-F1）**：relaunch 即时 POST **含**三 `expected*`；`scheduledEnvelope()`/定时 payload **不含**（断言 + 定时 schema 拒收）；「relaunch→存 schedule→PUT workflow→触发」**不 409**。（save-as-schedule 主体身份=定时既有 name 定位、整体出范围，§2d-1/R8-F1——不测 create-time id precondition〔已撤〕。）

门槛：`bun run typecheck && bun run test && bun run format:check`（前端 vitest）全绿；`bun run build:binary` 冒烟；CI（typecheck/lint/test + build smoke + Playwright）绿；Codex 实现门。

## §7 失败模式与保真度取舍（设计门 R1 全折）

原则：**忠实且安全时预填真值；否则降级为向导正常空/默认，永不产静默错误值**；非法组合由向导既有校验门阻止启动。

| 情形 | 行为 |
|---|---|
| `relaunchFrom` 指**已删**任务 → 404 `task-not-found` / 指**不可见**任务 → **403 `task-not-visible`**（visibilityCheck）/ 网络错 | 统一 → 显式错误面 + 禁提交（不静默、不假成功）。 |
| **workgroup 主体 ABA + TOCTOU（R1/R2-F1b/R3-F5/R4-F2）** | seed 时 `workgroupId` 一致性守卫 ＋ 启动 body 带 `expectedWorkgroupId=`**捕获在 state 的 `selectedWorkgroupId`**（R4-F2：**非** live `find(name).id` 重导——那会被后台刷新悄悄换成替身 id；捕获值只在 seed-验证后/显式改选时更新，后台刷新改映射则清选择逼重选）→ 服务端 **ACL-404 后**原子比对。测试「刷新替身→409」+「显式改选→放行」+「不可见组仍 404」。 |
| **agent 主体 ABA——用户拍板 migration 闭合（B-full，§2e）** | 三分支 seed（R9-F1：NULL→best-effort / id 一致→捕获守卫 / **id 不符→不 pre-select+禁提交+重选**）+ captured `selectedAgentId`（R8-F3）+ **早检（materialize 前）** + **进程内 reservation（引用计数 + acquire 后重验）**（R10-F1 根因 + R11-F1：`Map<agentId,count>`、`deleteAgent`/`renameAgent` 拒 `agent-launching`、仅全释才放行〔并发同-agent〕、acquire 后 name→id 重验补 resolve→acquire 窗、`try/finally` 全程释放）+ in-tx name+id 不变式（belt-and-suspenders，理应永不 fire）。**取代 R9-F2 深补偿**（规避 removeWorktree 不删 ref/不恢复 OID/无 durable 锚点）。回归：seed 前替身→禁启动+重选 / launch 中删/改名→409 / **并发同-agent L1 失败释放、L2 未完时 delete 仍 409** / acquire 前替换→零副作用阶段 fail / 改选 A→B / 历史 NULL。 |
| **协作者集含 owner + 语义 + 跨-kind（R2/R3-F4）** | agent/workflow 预填 = `[members.owner, ...members.users]` − launcher − inactive/system（**含原 owner**，否则原 owner 失新任务访问权）；语义=「当前成员可编辑默认」非忠实原始集。**workgroup 不预填**。**kind 变更清 `collaborators`**。 |
| **异步依赖竞态 + 晚到 + 挂死 + actor 三态（R2/R3/R4-F4/R5-F2）** | barrier 含 task+members+kind 清单+workflow 详情+**actor 就绪**；applied 拒晚到；每条必需 query `isError` 有终态转移（不永挂）。**actor 特例（R5-F2）**：`useActor` 把 auth 失败 catch 成 `data:null` success、**永不 isError** → 不能只等 `data!=null`（会永挂）；`isSuccess&&data===null`→**鉴权错误面**（重登/refetch）、`data!=null`→`actor.data.user.id`+排 `__system__`。 |
| **workflow 规范化→提交版本竞态（R5-F1）** | 守卫：捕获 `workflowQ.data.version`、即时提交带 `expectedWorkflowVersion`、`startTask` 对将快照的同一 wf 比对不符 409（§2c）→ 重取+重规范化。 |
| **三 OCC 守卫泄漏进定时任务（R6-F1）** | `expected*` 若进共享 `buildImmediateBody` 会被 `scheduledEnvelope` 持久化 → def PUT 后 schedule 每触发 409、累积禁用。三守卫**只作即时 POST overlay、绝不进 buildImmediateBody**（§2d）→ scheduledEnvelope 天然不含；定时 schema 拒收。回归「relaunch→存 schedule→PUT workflow→触发」不 409。 |
| **save-as-schedule 主体身份=定时既有 name 定位，整体出范围（R8-F1 修正 R7-F1）** | relaunch 可经 `ScheduleDialog`（不过 `start.mutationFn`）存定时；定时 **create+fire 端到端按 name 定位**（RFC-159 既有）。R7 拟的前端 precondition 是 **theater**（服务端 INSERT 按 name 解析、且 fire 又按 name 重解析——create-only 校验对 name 定位的持久 recipe 无持久效力）→**撤销**。整体（所有 schedule 皆然）沿用定时既有 name 语义、**非 RFC-175 回归**；durable-id 定位=独立 scheduled RFC（可选 follow-up）。即时 relaunch OCC 守卫（校验==launch）仍有效。 |
| **多仓中途失败——按 `failedNodeId` 检测（R3-F1 修正 R2-F4）** | `repoCount>1` 挡不住（2 仓失败第 2 仓落库 repoCount=1）！用结构信号 `failed && failedNodeId==null && remote`（materialize 在 node 前、失败时 failedNodeId 恒 null）→ `spaceResolvable=false` + 「已确认仓库完整」勾选门。必抓 materialize partial，安全过度覆盖其它 pre-node 失败；node run 失败（failedNodeId 有值）不 gate、重试顺滑。回归含「原 2 仓、第 2 仓失败、repoCount=1」。 |
| 仓库 URL 含凭据（RFC-024 脱敏） | 显脱敏 URL；用户重填凭据或选 cached clone（RFC-110 匹配）。不重放凭据本就更正确。 |
| 原始字面 ref（或空→默认已丢） | 用解析后 `baseBranch` 作可编辑默认。 |
| **spaceKind=local（遗留 path，R1-F4）** | repoUrl 非空 → 脱敏 URL 行；repoUrl 空（纯 path）→ 空间留向导默认（`spaceResolvable=false`），用户重选仓库。 |
| **spaceKind=internal（fusion，R4-F1）** | **入口直接抑制**——fusion 任务的 workflow 是 builtin（`assertNotBuiltin` 会 403），不给 relaunch；wizard 侧 seedFailed 防御（无 builtin id 抵达提交）。 |
| **workflow 输入按当前 def 规范化（R4-F3 修正 R3-F2）** | 种子值按**当前 `inputDefs`** 逐键校验、清除不合法者（upload-kind / enum 不在 choices / 非法 number/JSON）+ 提示已清空——堵「enum 旧路径不可见却被 `missingRequired` 放过」的**静默非法提交**（此为 bug 修复、**无需 migration**）。唯一真残留=精确恢复原上传文件（=必填 upload 本就要重选，非新损失）→ **upload 不再是 migration 决策项**。 |
| agent 快照无法解析（R1-F6） | `snapshotClarifyState → 'unknown'` → **省略** `allowClarify` → 缺省 true（向导默认）；仅结构有效且证无 clarify 节点才写 false。三态测试锁 null/坏 JSON/非数组/合法无/合法有。 |
| 工作组已删/掉 agent 成员/丢 leader | seed 填 goal/space；Select 不列或标 not-ready（tasks.new.tsx:277-284）；启动时 `workgroupLaunchReadiness`/404 兜底（`lib/workgroup-launch.ts`）。 |
| 老任务（本功能前创建） | remote/scratch/local 空间 best-effort 完整重放；**internal 不给 relaunch**；多仓 materialize partial 加确认门；输入按当前 def 规范化。**不谎称「全部参数全可重放」**。 |

## §8 影响面 / 耦合点

- **shared**：`TaskSchema` +3 optional（`workgroupName`/`goal`/**`sourceAgentId`**）；`StartWorkgroupTaskSchema` +1（`expectedWorkgroupId`）；`StartTaskSchema` +1（`expectedWorkflowVersion`）；`StartAgentTaskSchema` +1（**`expectedAgentId`**，§2e）。**三守卫均即时 POST overlay、不进 `buildLaunchBody*`/schedule**（§2d）→ 无 RFC-125 白名单线程；定时 schema 拒收。均向后兼容。
- **backend**：**1 migration `tasks.source_agent_id`（§2e，用户拍板；journal bump→改 `upgrade-rolling.test.ts`）**；`schema.ts` 加列；`rowToTask` +2 派生投影 + `sourceAgentId` 直投影、+`frozenWorkgroupGoal`；`startAgentTask` 早检 `expectedAgentId` + **持久化 `sourceAgentId`（in-tx 重验 id 写，唯一写路径改动）** + **进程内 `launchingAgentIds` lease（镜像 `materializingSpaces`）**；**`deleteAgent`/`renameAgent` +reservation 检查→`agent-launching` 409**（R10-F1）；`startWorkgroupTask` +`expectedWorkgroupId`、`startTask` +`expectedWorkflowVersion` 比对。序列化器 + 三守卫 + reservation + migration 测试。**无新端点/join；启动前多三次纯值比对 + 一枚进程内 lease。**
- **frontend**：`lib/task-wizard.ts` +`taskToLaunchPayload`/`snapshotClarifyState`（三态）/`applyWizardSeed` 抽取；`routes/tasks.new.tsx` 接 `relaunchFrom` + `relaunchPhase` 状态机 + kind-change 清协作者 + 多仓失败门；`routes/tasks.detail.tsx` 两处入口切换。i18n：seedFailed / 错误面 / `workgroup-id-mismatch` / 「仓库可能不全确认」/「原组已替换」文案走 zh-CN+en-US 双补。
- **wire**：无破坏（仅新增 optional 响应字段 + optional 启动守卫参数）；启动 endpoint 矩阵（RFC-125 锁）**不动**（`expectedWorkgroupId` 是可选新增、缺省=现状）。

## §9 与并发工作的协调

- **RFC-170 正在加 migration（0090 已落，后续 0091+）**：本 RFC 现有 **1 枚 migration**（§2e `source_agent_id`，用户拍板）——**实现期取当时最新的下一个空号**（勿硬编码 0091，先看 `packages/backend/db/migrations` 与 journal 尾号），与 RFC-170 协调避免撞号；journal bump 同步改 `upgrade-rolling.test.ts` 的 N（[[reference_migration_bumps_journal_count_test]]、单条 ALTER 免 statement-breakpoint）。
- 多人树：按精确 pathspec 提交（[[feedback_shared_index_commit_race]]）；勿碰他人 `scheduler.ts`（RFC-172）/ skills\* （RFC-170）WIP。`STATE.md` 当前有他人未提修改，登记本 RFC 时只加自己一行、保留他人改动（[[feedback_dont_delete_others_code_for_ci]]）。

## §10 设计门记录（Codex 对抗评审）

### R1（2026-07-13，verdict=needs-attention，5 high + 1 medium，**全折**）

对着真实源码逐条核过后全部采纳（几条实锤了初版的过度承诺 / 契约错误）：

- **R1-F1 [high] 主体身份 ABA**：按名重建 agent/workgroup 主体，旧名被新资源复用会静默启动到错主体。折入：workgroup 用 `task.workgroupId` 做同名 id 一致性守卫（不一致不 pre-select）；agent 平台按名标识（无 sourceAgentId）、按名 pre-select 但主体可见可改、就绪度校验、rename-reuse 属既有平台性质出范围（§3 表 / §4.7 / §7）。
- **R1-F2 [high] 协作者 ACL 扩张**：回填工作组任务的成员并集会给已移出的 human 成员授新任务权。折入：协作者预填 kind 相关——agent/workflow 忠实预填、**workgroup 不预填**（启动按当前 roster 重派，最小权限）（§4.5 / §7）。
- **R1-F3 [high] members 形状 + 单锁固化空集**：`GET members` 返回 `TaskMembers` 对象（`.users: UserPublic[]`），非数组、`UserPublic.role` 是全局角色、无 `toUserPublic`；且单 seed ref 未分别等 task+members 成功、relaunch isEdit=false 绕过 `collabReady` 门。折入：用 `.users`（已是 collaborators）、双查询独立追踪 + `relaunchCollabReady` 提交门 + 404/403/网络错误态处理（§4.3–4.6 / §6.5）。
- **R1-F4 [high] 空间四态 + 中途失败多仓**：`spaceKind` 实为 `local/remote/scratch/internal`；初版「非 scratch 即 remote」会把 local 变空 URL、internal 变不可启动远程；多仓中途失败只存成功前缀不可逆。折入：逐态空间重建 + `spaceResolvable` 降级 + 收窄「全部可重放」承诺（§0-G / §3 / §7）。
- **R1-F5 [high] workflow upload 输入不可重放**：upload 输入存为旧 worktree 相对路径、浏览器不能重建 File。折入：`inputDefs` 到手清空 upload-kind 种子、必填走 `missingRequired` 门、AC 明确排除 upload 原样回放（§3 / §4.8 / §6.5）。
- **R1-F6 [medium] allowClarify 未知态误还原 false**：布尔把 unknown 塌成 false 并显式发 `allowClarify:false`，与「不可解析缺省 true」矛盾。折入：`snapshotClarifyState` 三态、仅证无 clarify 才发 false、unknown 省略（§3 / §7 / §6.2）。

### R2（2026-07-13，verdict=needs-attention，5 high + 1 medium，**全折**——多为 R1 折入的深化 + 两处勘误）

- **R2-F1a [high] agent 勘误**：agent **有**稳定 id（AgentSchema:106），只是**任务不存 id**、终态任务的 agent 可删+同名重建 → 零 migration 下不可验证身份。折入：更正 §3 表（撤「无 sourceAgentId」错述）；取 RFC-165 现状按名 pre-select、`subjectResolvable`=name 在当前列表；忠实修复=持久化 sourceAgentId（migration）出范围 → **向用户点明**（§3/§4.7/§7）。
- **R2-F1b [high] workgroup seed→提交 TOCTOU**：仅前端 seed 时 id 检查挡不住删+同名重建/陈旧 cache。折入：**服务端 `expectedWorkgroupId` 原子守卫**（§2b：`StartWorkgroupTaskSchema` 可选参 + `startWorkgroupTask` 同事务比对 → 409 `workgroup-id-mismatch`）。
- **R2-F2 [high] 协作者语义 + 跨-kind 绕过**：`members.users` 是**当前**成员投影（owner 转移/PUT 可改）非「原始显式集」；且 `collaborators` 公共状态在 agent/workflow→workgroup 切 kind 后会被 `buildWorkgroupStartBody` 带出、绕过「workgroup 不预填」。折入：语义如实标注「当前成员可编辑默认」；**kind 变更清 `collaborators`**（§4.5 / §7）。
- **R2-F3 [medium] 查询成功≠seed 安全应用 + 403/404**：无「已应用」态/dirty 保护 → 慢查询晚到覆盖用户已编辑 chips；且不可见任务实为 **403 `task-not-visible`**（visibilityCheck）非 404。折入：显式 `relaunchPhase` 状态机（loading 冻结、applied 拒晚到）+ 403/404/网络统一处理（§4.6 / §7 / §6.5）。
- **R2-F4 [high] 部分 materialize 前缀可提交**：预填成功前缀 + 仅提示不够，`sourceReady` 会放过 → 对仓库子集启动。折入：`repoCount>1 && failed` → `spaceResolvable=false` + 「已确认完整」显式勾选门（§3 / §4.9 / §7）；残留（不可区分「后失败」）属零 migration 取舍 → **向用户点明**。
- **R2-F5 [high] 仅按当前 inputDefs 清 upload 漏清**：workflow 可改版，旧 upload 键改成 text/files/enum 后旧路径值被保留。折入：清「`workflowSnapshot` upload 键 ∪ 当前 upload 键」+ multipart builder 防御剔除（§3 / §4.8 / §7）。

### R3（2026-07-13，verdict=needs-attention，2 high + 3 medium，**全折**——两处实锤 R2「已闭合」的反例 + 三处契约深化）

- **R3-F1 [high] 多仓检测反例**：`repoCount>1` 挡不住——2 仓任务第 2 仓 materialize 失败落库 `repoCount=Math.max(1,materialized)=1`（task.ts:1159-1162，B11 测试实证），门不触发、子集可提交。折入：改用结构信号 **`failed && failedNodeId==null`**（materialize 在 node 前、失败时 failedNodeId 恒 null）→ 必抓 partial（§3/§4.9/§7）。
- **R3-F2 [high] snapshot 非 provenance 权威**：RFC-109 `syncTaskWorkflow` 原地覆写 `workflowSnapshot`（task.ts:1987-1992）不动 inputs → 按快照识别 upload 键会被 sync 打穿。折入：改按**当前 `inputDefs`** 清（§3/§4.8）；synced-改类留 narrow 残留（用户可见可改，faithful=migration）。
- **R3-F3 [medium] 状态机漏异步依赖 + 契约错**：`taskToLaunchPayload(task)` 单 Task 参判不了「主体当前是否存在」（需清单）；四态机只等 task/members、漏 workgroupsQ/agentsQ/workflowsQ/workflow 详情 → 慢清单误判、晚到漏清。折入：`taskToLaunchPayload` 去 `subjectResolvable`；`relaunchPhase` 等齐**该 kind 全部异步依赖**再原子 apply + 显式 members 失败转移（§3/§4.6）。
- **R3-F4 [medium] 当前成员漏 owner**：`members.users` 仅 collaborators、owner 单列；非 owner 发起 relaunch 只填 users 会静默丢原 owner。折入：agent/workflow 集 = `[owner,...users]−launcher−inactive/system`（§4.5/§7）。
- **R3-F5 [medium] `expectedWorkgroupId` 死绑源 id**：永远带 `task.workgroupId` → 用户显式改选组必 409 死锁；且比对须在 ACL-404 后（否则成私有组名探针）。折入：`expectedWorkgroupId=当前所选组 id`（随选择更新）、ACL-404 门后比对（§2b/§4.7）。

### R4（2026-07-13，verdict=needs-attention，3 high + 2 medium + 1 low，**全折**——两处实锤「伪残留其实可修」+ 一处漏 task-class）

- **R4-F1 [high] internal fusion 任务不能走通用 relaunch**：fusion 任务 workflow 是 builtin `aw-skill-fusion`（`/api/workflows` 不列、`assertNotBuiltin` 403），我只降级了 space、没管**主体**不可 relaunch。折入：`spaceKind==='internal'` **直接抑制入口**（§5）+ wizard seedFailed 防御 + fusion e2e。
- **R4-F2 [high] live 重导的 `expectedWorkgroupId` 仍被 ABA 打穿**：`find(name).id` 每 render 重算 → 后台刷新会无操作地换成替身 id、post-ACL 比对通过。折入：**捕获在 state 的 `selectedWorkgroupId`**（seed-验证后/显式改选才更新；刷新改映射则清选择）（§2b/§4.7）。
- **R4-F3 [high] upload→enum 非「可见可改」而是静默非法提交**：`EnumPicker` 不显示未匹配旧路径、`missingRequired` 却放过非空串 → 静默提交非法 enum。**此为可修 bug、非 migration 残留**。折入：seed 后按**当前 `inputDefs`** 规范化、清非法值+提示（§3/§4.8）。**upload provenance 因此不再是 migration 决策项**（唯一真残留=精确复原上传文件=必填本就重选）。
- **R4-F4 [medium] 状态机漏「必需 query 失败」终态 + actor**：清单/详情 `isError` 会永挂 loading；协作者排 launcher 依赖 `useActor()`（shape 是 `actor.data.user.id`、可 daemon 无 user、需进 barrier）。折入：barrier 含 actor 就绪、每条必需 query 有 error/retry、「弃继续」仅 members（§4.6）。
- **R4-F5 [medium] R3-F1 证据用 local fixture**：B11 是 local repoPath（`spaceKind=local`、不断言 repoCount），证不了 remote 案；且「failedNodeId 只在 node run 写」措辞不准（pre-validation 也可预置，但那在 materialize 成功后）。折入：改 remote 两仓 fixture 断言 `spaceKind=remote/repoCount=1/failedNodeId=null`；措辞收窄为「materialize 失败→failedNodeId null」（§3/§6.8）。
- **R4-F6 [low] §6.1 仍要求 subjectResolvable**：与 helper 契约（去 subjectResolvable）矛盾。折入：§6.1 去之；proposal 残留列表对齐。

**结论（R4）**：三处「伪残留/缺口」经 R4 收敛为**可修 bug**（internal 抑制、captured token、输入规范化）——**均无需 migration**。**唯一剩下的零 migration 残留 = agent delete-recreate ABA**（任务不存 `sourceAgentId`，无法验证同一性；安全降级=按名 pre-select+form-review；忠实闭合需 migration）。

### R5（2026-07-13，verdict=needs-attention，1 high + 1 medium，**全折**——收敛至 2 findings，R4 三修全闭合）

R5 确认 internal 双门 / captured workgroup id / remote 两仓 fixture **全闭合**；仅剩两条：

- **R5-F1 [high] 输入规范化的 workflow-version TOCTOU**：规范化按 seed 时 `inputDefs`、但提交时 `startTask` 快照最新 workflow（版本每 PUT 递增）→ 他标签页推 `vN+1` 会把 `vN` 值塞进 `vN+1`，重开非法输入路径。折入：**`expectedWorkflowVersion` 守卫**（§2c，与 `expectedWorkgroupId` 同款；RFC-125 白名单须 stamp）。
- **R5-F2 [medium] actor null-success 挂死**：`useActor` 把 auth 失败 catch 成 `data:null` success、永不 isError → barrier 只等 `data!=null` 会永挂；且 daemon 用 `__system__` user（非「无 user」）。折入：actor 三态（pending→loading / success+null→鉴权错误面 / 非 null→`actor.data.user.id`+排 `__system__`）（§4.6）。

**结论（R5）**：两条均**可修、零 migration、无新用户决策**。折后**唯一用户可拍板残留仍 = agent delete-recreate ABA**。

### R6（2026-07-13，verdict=needs-attention，**1 high**，已折——收敛至 1 finding，actor 三态确认 sound）

- **R6-F1 [high] 两 OCC 守卫会泄漏进持久化定时任务**：`expected*` 经共享 `buildImmediateBody` 会被 `scheduledEnvelope` 包进「保存为定时任务」payload 持久化 → workflow 后续 PUT 到 `vN+1` 后 schedule 每触发命中守卫 409、累积失败乃至自动禁用（定时本应触发时用最新 def）。折入：两守卫改**只作即时 POST overlay、绝不进 `buildImmediateBody`/`buildLaunchBody*`**（§2d），scheduledEnvelope 天然不含 + 定时 schema 拒收 + 回归；顺带**撤销** RFC-125 白名单线程（守卫非 builder 字段）。

### R7（2026-07-13，verdict=needs-attention，**1 high**，已折）

- **R7-F1 [high] save-as-schedule 丢工作组身份守卫**：R6 把稳定身份守卫 `expectedWorkgroupId` 与可变 `expectedWorkflowVersion` 同等 strip，忽略 `ScheduleDialog` 另走 POST（不过 `start.mutationFn`）；relaunch 存的定时按 name 定位 → seed→save 间删+同名重建会静默排期错组。折入：厘清 fire-time 名定位 ABA=定时系统**既有性质**（RFC-175 不改、durable-id 定位=独立 RFC 出范围）+ ScheduleDialog 保存加**即时身份 precondition** 闭 seed→save 窗（§2d-1）；订正「只剩 agent ABA」claim（即时 relaunch + seed→save 已闭，fire-time 名定位既有）。

### R8（2026-07-13，verdict=needs-attention，2 high + 1 medium，**全折**——首评 migration 版本；general 结构判 sound，agent 机制 3 处精化）

R8 确认 nullable migration / 不 backfill / journal bump / OCC 不持久化 / fire-time name-targeting 出范围**原则成立**；agent 机制 3 精化：

- **R8-F1 [high] ScheduleDialog 前端 precondition 是 theater**：服务端 INSERT 按 name 解析、前端陈旧 cache 挡不住 check→POST 间替身；且 fire-time 又按 name 重解析→create-only 校验无持久效力。折入：**撤销 precondition**；save-as-schedule 主体身份=定时既有 name 定位（create+fire）**整体出范围**（§2d-1）。
- **R8-F2 [high] §2e 漏 in-tx name+id 重验、post-migration ABA 仍穿透**：只在初解析比 `expectedAgentId`，但 INSERT 前有长窗、既有 dbTxSync 只查 name、运行时按 snapshot name 取 agent → A 初检后删+同名建 B、事务接受 B 却写 `sourceAgentId=A.id`、跑 B；且写入点是 `task.ts` 中央 INSERT 非 `agentLaunch.ts`。折入：线程初解析 `agent.id` 进 `StartTaskDeps.agentLaunch`、dbTxSync 按 name 取 id 断言 == 线程值、`sourceAgentId` 从重验值写（§2e）。
- **R8-F3 [medium] `expectedAgentId` 死绑源任务、改选必 409**：agent Select 可编辑，死绑 `task.sourceAgentId` 会让改选 B 发 `URL=B&expectedAgentId=A`→409。折入：**captured `selectedAgentId`**（镜像 workgroup：seed 验证捕获、改选更新、清选清）（§2e/§4.7）。

### R9（2026-07-13，verdict=needs-attention，1 high + 1 medium，**全折**——schedule scope-out 确认正确；agent 机制再 2 精化）

- **R9-F1 [high] seed 前同名替身绕过守卫**：§4.7 原「id 一致才捕获、否则仍 pre-select 名」→ 替身 B 留空 token、可选 `expectedAgentId` 省略 → 无守卫跑 B。折入：三分支——**id 不符→不 pre-select+禁提交+重选**（不降级 guardless）（§4.7）。
- **R9-F2 [medium] in-tx 拒绝遗留孤儿 remote worktree**：in-tx throw 在 materialize 之后、失败处理只删 scratch → 遗留无锚点 remote worktree（GC 找不到 + `workingBranch` 后续 `branch-in-use`）。折入：**早检（materialize 前，零孤儿）堵常见面 + in-tx 末线失败触发全空间补偿**（逐仓 removeWorktree+释放 workingBranch）（§2e）。

**观察**：agent migration（B）经 R8+R9 已生 5 findings（captured token / in-tx TOCTOU / 早检 / 补偿 / 三分支 seed），复杂度远超「存 id+比对」初印象——**闭一个低频边界的真实成本已显现**；choice A（受 residual、agent best-effort 按名=RFC-165）无这些。**实现前就 B-full 真实成本向用户最终确认**（见 R10 后）。

### R10（2026-07-13，verdict=needs-attention，**1 high**，已折——三分支 seed + 早检 + in-tx 重验确认 sound；深补偿证不完整）

- **R10-F1 [high] R9-F2「全空间补偿」不完整**：`removeWorktree` 只 `git worktree remove`、**不删新建 ref、不恢复 working-branch 原 OID**（materialize 会建默认分支 / 把既有 working-branch fast-forward/merge 到 base，`util/git.ts:458-470,562-613,1053-1063`）→ 竞态可 409 却留孤立分支 / 静默推进用户 working-branch；且 INSERT 已回滚、remote worktree 无 orphan 扫描、`removeWorktree` 本身会抛 → 清理失败即永久失锚。Codex 荐**根因方案：materialize 前建阻止 agent 删/改名的 reservation，从源头消窗**。折入（**取用户 B-full 意图的更干净架构**）：**进程内 `launchingAgentIds` lease**（镜像 `materializingSpaces`，单进程 daemon 足够）+ `deleteAgent`/`renameAgent` 检查→`agent-launching` 409（§2e）——window 根本不发生、**无需深 ref-恢复补偿**；in-tx 重验降为 belt-and-suspenders 不变式。

**用户 2026-07-13 二次确认 B-full**（了解真实成本后仍选「连 materialize 窗竞态也闭」）；reservation 方案兑现该意图且规避 R10-F1 的补偿坑。

### R11（2026-07-13，verdict=needs-attention，**1 high**，已折——reservation 方向确认可行 + 源码证 delete/rename 是仅有身份变更入口；并发协议订正）

- **R11-F1 [high] 裸 set-delete lease 留两窗**：agent id 被多并发 launch **共享**（异于 `materializingSpaces` 键=唯一 task id）→（窗1）L1 `finally` 删键时 L2 仍 materialize、delete 可过；（窗2）resolve→acquire 跨多 await，delete 若在 acquire 前完成则 lease 锁陈旧 id。折入：**引用计数 registry**（仅全释放才移除，堵窗1）+ **acquire 后 name→id ACL-safe 重验**（零副作用阶段 catch acquire 前替换，堵窗2）+ `try/finally` 覆盖早检/校验/materialize 全异常释放（§2e）。

### R12（待跑）

> R11 fold（引用计数 + acquire 后重验 + finally 全覆盖）后重跑确认收敛。general 结构 R1–R11 反复 sound；agent B-full reservation 经 R11 并发订正。R12 通过/仅既有 scoped-out → 注册 + 实现。
