# RFC-211 — 技术设计

> ⚠️ **§12 转向声明（2026-07-21，权威更正）**：本文以下描述的「example 沙盒」形态（example
> 产物 / 帮我建 / 一键清除 / onboarding 七端点）**已被用户拍板整体取代**：最终交付形态是
> **手把手 spotlight tour**——`/onboarding` 只是三卡片 tour 启动页，tour 在**真实界面**上
> 高亮引导、建的是**真实资源**，example 概念（DB 列、两张引导表、前后端全部 example 面）已由
> migration `0104` 与配套提交彻底删除。权威现状见 `STATE.md` RFC-211 §12 条目与
> `components/tour/SpotlightTour.tsx` / `tourScript.ts`；下文各章节**仅作历史存档**，与 HEAD
> 代码不符处以本声明为准。实现门对抗自评审（2026-07-21，Claude 接手）：AC 全达成；
> P1-1（方向键/ESC 无可编辑守卫会覆写用户输入）与 P1-2（持久化 tour 状态越界即全应用崩溃回
> 路）已修并带回归测试（`tour-guards.test.tsx`，变异实证）；P2（Dialog ESC 遮蔽 / 锚点缺失
> 逃生 Next + scrim 可穿透 / rAF 帧比较 / i18n 死键清理）同批落地。


> 本文的行号锚点取自 2026-07-20 的 HEAD（`0c15b845`）。实施前按 live source 重取，不要把本文行号当静态 oracle。

## 0. 设计要点速览

| # | 决策 | 依据 |
| --- | --- | --- |
| D-A | 不做开机播种；`example` 是**用户自己的**沙盒产物 | proposal §5 D1 |
| D-B | `example` 与 `builtin` **正交**：builtin=隐藏+只读+禁启动，example=可见+可改+可启动+可清除 | `systemResources.ts:54/60/75`、`taskLaunchGate.ts:34` |
| D-C | 双写标记：`onboarding_artifacts` 表（批次 / 清除入口）+ 五张业务表 `example` 布尔列（DTO 角标 / 过滤），带一致性测试锁 | 用户拍板 |
| D-D | 引导产物 `owner = actor`、`visibility = 'private'` | 用户拍板；`resourceAcl.ts:91` admin 仍可见 |
| D-E | **必须新建任务删除能力**，否则一键清除对工作流线永久失效 | `countReferencingTasksInTx`（`workflow.ts:401`）统计 `tasks.workflow_id` **不分状态** |
| D-F | 任务的 example 标记在**启动时由来源资源派生**，不做事后 UPDATE | `tasks` 表的 `.update()` 被 S-14 棘轮锁死（`scheduler-audit-s14-*.test.ts:37`） |
| D-G | 不新增任何权限位 | `permission.test.ts` 四条快照锁（33/23 计数 + admin-only 集合） |
| D-H | 清除 = 多个小事务 + 事务外异步 FS 删除 + 逐项结果 | `dbTxSync` 必须同步体（`txSync.ts:31`）；`rmSync` 会阻塞 Bun 事件循环（RFC-208，`gitRepoCache.ts:900`） |

## 1. 数据模型

### 1.1 迁移 `0103_rfc211_onboarding.sql`

手写 SQL（本仓 0013 之后全部手写，**不要跑 `drizzle-kit generate`**，`0049:1-3` 注释为证），多语句用独占一行的 `--> statement-breakpoint`（多行 `CREATE TABLE` 之后必须用独占行版，`0082` 为范式）。

```sql
-- RFC-211 引导式沙盒。纯增量：五张业务表各加一个 example 布尔列
-- （NOT NULL DEFAULT false ⇒ 所有存量行语义不变），外加两张引导表。
ALTER TABLE `agents` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `workgroups` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `example` integer DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onboarding_runs` ( … );
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `onboarding_artifacts` ( … );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_onboarding_runs_user` ON `onboarding_runs` (`user_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_onboarding_artifacts_resource`
  ON `onboarding_artifacts` (`resource_type`,`resource_id`);
```

列定义顺序照抄既有范式：`integer DEFAULT false NOT NULL`（不是 `NOT NULL DEFAULT`），见 `0093_rfc180_workgroup_autonomous.sql`。

`_journal.json` 追加 `{ "idx": 102, "version": "6", "when": <ms>, "tag": "0103_rfc211_onboarding", "breakpoints": true }`，保持 2 空格缩进（该文件在 `format:check` 范围内）。

### 1.2 `onboarding_runs`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | ULID |
| `user_id` | text NOT NULL | `REFERENCES users(id) ON DELETE cascade` —— 用户被删，其引导记录随之消失 |
| `track` | text NOT NULL | `'agent' \| 'skill' \| 'workflow' \| 'workgroup'` |
| `status` | text NOT NULL DEFAULT `'active'` | `'active' \| 'completed' \| 'abandoned'` |
| `current_step` | text | 步骤 key，null = 还在第一步 |
| `completed_steps` | text NOT NULL DEFAULT `'[]'` | JSON 字符串数组，已打勾的步骤 key |
| `suffix` | text NOT NULL | 该 run 的资源名后缀（见 §2.1） |
| `created_at` / `updated_at` | integer NOT NULL | `(unixepoch() * 1000)` |

### 1.3 `onboarding_artifacts`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text PK | ULID |
| `run_id` | text NOT NULL | `REFERENCES onboarding_runs(id) ON DELETE cascade` |
| `resource_type` | text NOT NULL | `'agent' \| 'skill' \| 'workflow' \| 'workgroup' \| 'task'` |
| `resource_id` | text NOT NULL | 资源主键（**不是** name；name 可改） |
| `resource_name` | text NOT NULL | 建档时的名字，仅供 UI 展示与审计（可能与当下不一致） |
| `created_at` | integer NOT NULL | |

`uq_onboarding_artifacts_resource(resource_type, resource_id)` 保证同一资源不会被两个 run 重复登记。

**不加指向业务表的 FK**：五类资源各在自己的表里，删除路径各不相同（skill 走 op 锁、workflow 走 OCC），用 FK 会把删除顺序焊死；改为在删除成功后由清除服务显式删 artifact 行，并由一致性测试锁住"两处同时归零"。

### 1.4 `schema.ts` 侧

五张表各加一行，逐字照抄 `agents.builtin`（`schema.ts:82`）的形状：

```ts
example: integer('example', { mode: 'boolean' }).notNull().default(false),
```

⚠️ 本仓**没有** schema.ts ↔ 迁移的漂移检测（无 `getTableConfig` 反射断言），`drizzle-kit check` 只验目录内部一致性 —— 两处必须人工逐字对齐，否则 `createInMemoryDb` 建出的库缺列而 typecheck 全绿。

### 1.5 DTO

按 `builtin` 的先例（`schemas/agent.ts:116`、`schemas/workflow.ts:211`）加 **response-only 可选布尔**：

```ts
example: z.boolean().optional(),
```

加在 `AgentSchema` / `SkillSchema` / `WorkflowSchema` / `WorkgroupSchema` / `TaskSchema`。`Create*` / `Update*` 一律不接受（zod 会 strip），**保证 e2e 的裸 body 播种不受影响**（`a11y.spec.ts:387` 等四个 spec 直接 POST 对象字面量）。

## 2. 命名与归属

### 2.1 后缀

四类资源的 name 正则完全一致：`/^[a-z0-9][a-z0-9_-]*$/`，长度 1..128（`agent.ts:93` / `skill.ts:7` / `workgroup.ts:19` / `workflow.ts:272`）。

- 后缀 = **每个 run 一个共享值**：`ulid()` 结果的后 8 位 **`.toLowerCase()`**。
  ⚠️ ULID 是大写 Crockford Base32，直接用会被四条正则一律 422 —— 必须转小写。
- 名字形如 `guide-coder-7f3a2bkx`。前缀 `guide-` 固定（不用 `example-`，与列名区分，避免 UI 文案歧义）。
- `agents.name` / `skills.name` / `workgroups.name` 是 UNIQUE，多人并发跑引导时后缀是**必需**而非优化；`workflows.name` 不唯一（`schema.ts:419`），后缀只为可读性一致。
- 工作组成员 `displayName` 另有 1..64 且禁 `@` / 逗号 / 空白的约束（`workgroup.ts:44`），后缀同样合法。

### 2.2 归属与可见性

- 全部资源 `ownerUserId = actor.user.id`。
- 全部资源 `visibility = 'private'`。

`createAgent` / `createWorkflow` / `createManagedSkill` / `createWorkgroup` 四处把 `visibility` **硬编码成 `'public'`**（`agent.ts:128`、`workflow.ts:81`、`skill.ts:188`、`workgroups.ts:130`）。最小改法：给它们的 `opts` 加一个可选 `visibility?: ResourceVisibility`，插入处改成 `opts?.visibility ?? 'public'`。

- 默认值不变 ⇒ `rfc099-resource-routes.test.ts:134` 的「新资源默认 public（D18）」锁不动。
- 不走"建完再 PUT /acl"：那样会 bump `aclRevision` 且存在**中间 public 窗口**，多人实例里别人能瞬间看到。

⚠️ 同一 run 内所有资源的 owner 必须一致：`assertNewRefsUsable`（`resourceRefs.ts:64`）对非 admin 会把"引用了自己看不见的资源"打成 422 `acl-missing-refs`。

## 3. 服务层 `services/onboarding.ts`

### 3.1 run 生命周期

```ts
startRun(db, actor, track): Promise<OnboardingRun>
getRuns(db, actor): Promise<OnboardingRun[]>            // 仅本人
patchRun(db, actor, runId, { currentStep?, completedSteps?, status? }): Promise<OnboardingRun>
```

同一用户同一 track 已有 `active` run 时复用它（不新建），避免"并发跑两个同名 run 各建一套资源"。

### 3.2 「帮我建」—— `provisionStep`

```ts
provisionStep(db, deps, actor, runId, step: OnboardingStepKey): Promise<ProvisionResult>
```

每个 step 是幂等的：先查该 run 是否已有该类型 artifact，有则直接返回既有资源（前端据此跳编辑页），无则创建。

创建后**在同一逻辑步骤内**登记 artifact 行。DB 事务只能同步（`txSync.ts:31`），而 `createAgent` 等是 async，所以：创建成功 → 单独一个同步小事务插 artifact 行。若插 artifact 失败（极罕见），资源已建但未登记 —— 由 §6 的对账函数兜底（`example=1` 但无 artifact 行 ⇒ 补登记）。

### 3.3 「我自己来」—— `adoptResource`

```ts
adoptResource(db, actor, runId, { resourceType, resourceName }): Promise<OnboardingArtifact>
```

1. 按 name 解析资源行；不可见 → `NotFoundError`（RFC-099 D1：与不存在同形，`rfc099-resource-routes.test.ts:145` 锁死）。
2. `requireResourceOwner`（`resourceAcl.ts:217`）。
3. 一个同步事务里：`example = 1`、`visibility = 'private'`、`aclRevision = aclRevision + 1`，并插 artifact 行。

`aclRevision` 必须 +1：ACL 面板走 OCC（`updateResourceAcl` 校验 `expectedAclRevision`），静默改可见性而不 bump 会让并发的 ACL 编辑基于陈旧快照提交。

### 3.4 任务的 example 派生（D-F）

不做事后 UPDATE。在三条启动路径上，从**来源资源**派生并在 `INSERT` 时落列：

| 路径 | 来源 | 位置 |
| --- | --- | --- |
| 工作流任务 | `workflows.example` | `startTask` 解析 workflow 行处 |
| 单 agent 任务 | `agents.example` | `agentLaunch.ts` 解析 agent 行处 |
| 工作组任务 | `workgroups.example` | `workgroupLaunch.ts` 解析 workgroup 行处 |

**这条派生同时解决了一个致命洞**：用户如果绕开引导、自己从 `/tasks/new` 启动 example 工作流，产生的任务也会带 example 标记，因而进得了清除范围；否则 `workflow-in-use` 会让这个 example 工作流**永远删不掉**。

任务同时登记 artifact 行（`resource_type='task'`），归属该 run。绕开引导启动的 example 任务没有 run 归属 —— artifact 表允许 `run_id` 指向该资源所属 run（由来源资源的 artifact 反查）；查不到则不登记，清除侧以 `tasks.example = 1` 为准（见 §4.1 的取集规则）。

## 4. 一键清除

### 4.1 取集

```ts
collectExamples(db, actor, scope: 'mine' | 'all'): Promise<ExampleInventory>
```

- `scope='mine'`：五张表 `example = 1 AND owner_user_id = actor.user.id`（tasks 用 `owner_user_id`）。
- `scope='all'`：仅 admin（`requireAdmin()`，按**身份 role** 判定 —— `permissions.ts:25-31` 明确警告：用 `requirePermission` 挂在已下放到 user 基线的权限点上会变成 no-op）。

取集以**业务表的 `example` 列**为准（不是 artifact 表）—— 列是资源自身的属性，artifact 表可能因 §3.2 的罕见半途失败而缺行。artifact 表用于展示批次与清除后对账。

### 4.2 顺序（实测引用图，逆序自底向上）

```
① 任务（先安全终止 → 删磁盘产物 → 删行）
② 工作组   （无反向守卫，任意时刻可删）
③ 工作流   （需 ① 已完成，否则 workflow-in-use）
④ 代理     （需 ③ 已完成，否则 agent-in-use；且需 ① 完成，否则 agent-tasks-active）
⑤ 技能     （需 ④ 已完成，否则 skill-in-use）
```

依据：`countReferencingTasksInTx`（`workflow.ts:401`，不分状态）、`agent-in-use`（`agent.ts:311`）、`agent-tasks-active`（`agent.ts:362`，仅非终态）、`skill-in-use`（`skill.ts:276`，**全表扫且不做 ACL 过滤**）、`deleteWorkgroup` 无任务守卫（`workgroups.ts:234`）。

### 4.3 任务删除（本 RFC 新建的能力）

`services/exampleTaskDelete.ts`：

**第 1 步 · 安全终止。** 照抄 `cancelFusionEngineTask`（`fusion.ts:1338`）的**有界重读循环**（8 次）：每轮重读状态 —— 在 `CANCELABLE_TASK_STATUSES`（`task.ts:2003`，含 `awaiting_review`/`awaiting_human`）内就 `cancelTask()`，已终态或行不存在就返回。
单次"读一次 + cancel 一次"会漏掉正在翻转的任务（`cancelTask` 只轮询 5s 就落 fallback CAS）。

**第 2 步 · 确认子进程真的死了。** `cancelTask` 返回 `canceled` **不保证**子进程已死 —— runner 的 `SIGTERM → grace → SIGKILL` 升级失败会走 `child-unkillable` 把整个 detached 进程组留着跑（`runner.ts:1178`）。对该任务的 node_runs 逐个跑 `killStaleRunProcessTree`（`util/process.ts:111`，自带 48h 窗口 + `pidCommandContainsBinary` 双闸防 PID 复用）；返回 `'kill-failed'` 视为**硬信号**：这条任务标记 `skipped`，不删它的产物（在活写者脚下抽地板是最坏的失败模式）。

**第 3 步 · 抢 GC claim。** 复用 `claimWorkspacePrune`（`gc.ts:76`）打 `workspace_pruning_at`。所有复活路径（resume / retry / lifecycle-repair / boot-auto-resume）的 CAS 都读 `workspace_pruning_at IS NULL AND workspace_pruned_at IS NULL`（`gc.ts:12-20`）。绕开 claim 直接 rm 会与 GC / 复活三方赛跑，出现"目录已删 → 任务被复活 → scheduler 在不存在的 cwd 上 spawn"。

**第 4 步 · 删磁盘产物**（全部用 `node:fs/promises` 的**异步** `rm`，绝不用 `rmSync` —— RFC-208 已在 `deleteCachedRepo` 上踩过：`rmSync` 阻塞 Bun 单事件循环，连超时定时器都跑不了，整个 daemon 停摆）：

| 产物 | 路径 |
| --- | --- |
| scratch 工作区 | `{appHome}/scratch/{taskId}`（`task.ts:994`） |
| 运行目录 | `{appHome}/runs/{taskId}`（含 `ports/`、`review/`） |
| 归档事件 | `{appHome}/logs/{taskId}` |
| 结构化 diff | `{appHome}/structural-diffs/{taskId}` |
| 隔离 worktree | `{appHome}/iso/{taskId}`（如有） |
| worktree | 非 scratch 任务走 `cleanupCreatedWorktree`（`git.ts:616`）+ `deleteSnapshotRefs`（`git.ts:1602`） |

引导任务恒走 scratch（`gc.ts:180` 明说 scratch 无 worktree 注册、无 snapshot ref），最后一行只对"用户拿 example 资源接真仓库跑"的情况生效。

**第 5 步 · 删行。** `db.delete(tasks).where(eq(tasks.id, id))` —— 13 张子表 CASCADE 带走（`workgroup_assignments` / `workgroup_messages` / `workgroup_member_cursors` / `task_repos` / `node_runs`（二级带走 `node_run_outputs`、`node_run_events`）/ `doc_versions`（二级带走 `review_comments`）/ `clarify_sessions` / `cross_clarify_sessions` / `clarify_rounds` / `task_node_clarify_directives` / `task_collaborators` / `lifecycle_alerts` / `task_questions`）。运行期 `PRAGMA foreign_keys = ON`（`client.ts:61`）。

**故意保留的悬挂行**：`recovery_events` / `lifecycle_repair_audit` / `task_feedback` / `memory_distill_jobs` / `memories.source_task_id` 无 FK —— 前两张是**故意**设计成活得比 task 长的审计行（`schema.ts:2113-2116` 明写）。不要顺手给它们加 FK（需重建表且会撞冻结迁移测试）。

**第 6 步 · 广播。** WS 线协议里 `task.deleted` **已存在但无生产者**：schema `ws.ts:235`、ACL 路由 `ws/registry.ts:274`、前端失效映射 `useTasksSync.ts:15`。只需补 emit 端，前端与 ACL 网关已就位。

### 4.4 逐项结果与部分失败

`dbTxSync` 必须同步体 ⇒ **不可能一个大事务包住整批**。返回逐项结果，形状按既有 `WorkspaceCleanupReport`（`task.ts:795`）扩展：

```ts
interface ExampleCleanupItem {
  resourceType: 'task' | 'workgroup' | 'workflow' | 'agent' | 'skill'
  name: string
  outcome: 'deleted' | 'skipped' | 'failed'
  code?: string          // 后端 DomainError code，例如 'skill-in-use'
  message?: string
}
interface ExampleCleanupResult { complete: boolean; items: ExampleCleanupItem[] }
```

**部分失败绝不整批回滚**。典型 `skipped`：
- `skill-in-use` —— 别人的正式 agent 挂了这个 example skill（`findAgentsUsingSkill` 全表扫且不做 ACL 过滤，details 因 ACL 只给 `{visible, hiddenCount}`，用户看不到是谁挡的）。
- `skill-operation-busy` —— skill 操作锁被并发编辑 / 版本写 / fusion 占用。**清除自身绝不去动 `.trash/` 目录**（中断态由 boot 的 `deleteRecoveryHandler` 修复）。
- `kill-failed` —— 子进程未死（§4.3 第 2 步）。

**重试必须幂等**：清除是"按当前 example 集合再跑一遍"，已删的自然不在集合里。不做内存批次对象（`repoBatchImport` 那套是内存态、会过期报 `batch-not-found`，不适合"重试幂等"的要求）。

### 4.5 工作流删除的 OCC

`deleteWorkflow` 强制 `{ expectedVersion, clientMutationId }`（`schemas/workflow.ts:306`，`clientMutationId` 必须是合法 26 位 ULID）。清除服务每次现读 `version`、现铸 `ulid()`；`workflow-version-conflict` 时重读重试一次，仍冲突则记 `failed`。

### 4.6 授权（这是最容易写成越权面的地方）

`/api/onboarding/*` **不在** `resourcePermissionGate` 射程内（`server.ts:141-164` 的前缀列表里没有它），直接调 service 会同时绕过：

1. 方法级权限门（`agents:write` / `skills:write` / `workflows:write`）；
2. route 级的 `loadVisibleX` + `requireResourceOwner`（`routes/agents.ts:172-180` 等，**service 层不查 owner**）。

因此清除端点必须**在 handler 里逐资源手动复刻这两层**：`ensurePermission(c, '<res>:write')` + `requireResourceOwner`。否则这是一个"只要打上 example 标记就能删任意人资源"的越权面。

`scope='all'` 额外 `requireAdmin()`；admin 走 `isAdminActor` 旁路时 `requireResourceOwner` 自然放行（`resourceAcl.ts:206`）。

## 5. HTTP 端点

全部登记进 `packages/backend/tests/contracts/registry.ts` 的 `ENDPOINTS`（两向棘轮 `api-contract-coverage.test.ts:79/93`），形状 `{method, path, public?, happy?}`。破坏性端点省略 `happy`（只生成 401 鉴权用例）。

| 方法 | 路径 | 授权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/onboarding/runs` | 认证 | 本人的 run 列表 + 进度 |
| POST | `/api/onboarding/runs` | 认证 | `{track}` → 新建或复用 active run |
| PATCH | `/api/onboarding/runs/:id` | owner | `{currentStep?, completedSteps?, status?}` |
| POST | `/api/onboarding/runs/:id/provision` | owner + 对应 `<res>:write` | `{step}` →「帮我建」 |
| POST | `/api/onboarding/runs/:id/adopt` | owner + 资源 owner | `{resourceType, resourceName}` →「我自己来」登记 |
| GET | `/api/onboarding/examples` | 认证（`?scope=all` 需 admin） | 清除预览清单 |
| DELETE | `/api/onboarding/examples` | 同上 + 逐资源 owner | 一键清除，返回逐项结果 |

**不新增权限位**（D-G）：新增任何一条会同时打红 `permission.test.ts` 的 33 计数、admin 全集、user 23 条逐条列表、admin-only 快照四条锁。

## 6. 两处标记的一致性

抽一个**纯函数**做可断言面（CLAUDE.md「首选可断言面」）：

```ts
export function diffExampleMarkers(
  artifacts: readonly { resourceType: string; resourceId: string }[],
  rows: readonly { resourceType: string; id: string; example: boolean }[],
): { markedWithoutArtifact: string[]; artifactWithoutMark: string[] }
```

对账时机：
- 清除后：两处必须同时归零。
- `provisionStep` / `adoptResource` 的半途失败：`example=1` 但缺 artifact 行 ⇒ 由 run 详情读取时补登记（幂等，靠 `uq_onboarding_artifacts_resource`）。
- 反向（有 artifact 行但资源已被用户手动删）：读取时过滤掉解析不到的行，并在清除时顺手删 artifact 行。

## 7. 引导内容规格（必须真能跑通）

### 7.1 example agent

```
name: guide-coder-<suffix>
outputs: ['result']；outputKinds: { result: 'markdown' }
bodyMd: 非空的真提示词
description: 一句人话
runtime: 不填（继承 config.defaultRuntime ?? 'opencode'）
```

- **outputs 必须非空**：`buildProtocolBlock`（`prompt.ts:751`）无条件追加"You MUST end your reply with a `<workflow-output>` block listing these ports:"，`outputs=[]` 时 bullet 与示例都空转，产出自相矛盾的指令 → 模型多半不吐 envelope → runner 判 `envelope-missing` 直接 failed（`runner.ts:1322`）。
- **端口越少越稳**：少吐一个已声明端口只 `log.warn`，但 `<port>` 开了不闭合是硬失败 `envelope-port-malformed`（`runner.ts:1338`）。只声明 1 个 markdown 端口。
- **不 pin runtime**：pin 了会受播种顺序与 runtime 存在性校验约束；不 pin 时 `resolveAgentRuntime = agent.runtime ?? config.defaultRuntime ?? 'opencode'`（`runtimeRegistry.ts:238`）。

工作流线额外需要第二个 agent `guide-auditor-<suffix>`（`outputs: ['finding']`）。工作组线额外需要 `guide-lead-<suffix>`。

### 7.2 example skill

`createManagedSkill` 会把 `{name, description, ...frontmatterExtra}` 作为 frontmatter、`bodyMd` 作为正文写进 `{appHome}/skills/{name}/files/SKILL.md`（`skill.ts:128-135`）。

⚠️ **description 必须写**：opencode 的 `fmt()` 在渲染 `available_skills` 时 `list.filter(skill => skill.description !== undefined)`（`opencode/packages/opencode/src/skill/index.ts:331`）—— 没有 description 的 skill **对模型完全不可见**，引导会呈现"建好了、挂上了、却永远没用上"的假成功。（已核实 opencode 源码，非记忆。）

### 7.3 example 工作流

`$schema_version: 4`。四节点三边：

```
input(task) ──task──▶ guide-coder ──result──▶ guide-auditor
                                                    │
                                              output(bind: auditor.finding)
```

validator 的两条关键规则（`workflow.validator.ts`）：
1. 每个 `{{token}}` 必须有同名入边端口（inbound 集合由 edges 的 `target.portName` 构成，`:1834-1869`）—— coder 的 `promptTemplate` 用 `{{task}}` 且入边 `target.portName='task'`；auditor 用 `{{artifact}}` 且入边 `target.portName='artifact'`。
2. `input` 节点的 `inputKey` 必须在 `definition.inputs[]` 里声明。

output 节点**不需要入边**：scheduler 把 `ports[].bind` 当隐式上游依赖（`scheduler.ts:7014-7028`）。

CI 必须锁死"生成的 definition 过 `validateWorkflowDefinition` 且 `ok:true`"——现有 `onboarding-demo.test.ts` 只验 YAML 能被 importer 吃下（而 importer 不校验 agent），等于没验可跑性。

### 7.4 example 工作组

`mode='leader_worker'` + **两个** agent 成员 + `leaderDisplayName` 指向其一。

- 只放 leader 一个成员时 `readiness.ready` 仍为 true，但带 advisory warning `no-non-leader-worker`（`workgroup.ts:293`）—— 运行时 leader 无人可派活，引导会给出"跑绿了但什么也没干"的示例。
- 启动第二道门：roster 里所有 `agentName` 必须在 agents 表存在，否则 422 `workgroup-not-ready {reasons:['agent-missing']}`（`workgroupLaunch.ts:243`）⇒ 必须先建 agent 再建组。
- `leader_worker` / `free_collab` 会把成员 agent 的 outputs 投影成 `wg_*` 协议端口（`workgroupRunner.ts:138`），所以成员的业务端口不参与；但 §7.1 的 outputs 非空要求仍然成立（同一个 agent 也用于单 agent 直跑与工作流线）。

### 7.5 真跑的任务

最小体 `{ name, description, scratch: true }`（`schemas/task.ts:1165`）。`scratch: true` 与所有 repo 源、`workingBranch`、`autoCommitPush` 互斥（`task.ts:565-586`）。

**启动前探测运行时就绪度**（`GET /api/runtimes/status`），未就绪直接给可读提示 —— `POST /api/tasks` 本身不校验 runtime 二进制是否存在（`routes/tasks.ts:191-247`），不探测的话新手第一跑会以晦涩的节点级 spawn 失败收场。

## 8. 前端

### 8.1 路由与入口

- 新增 `src/routes/onboarding.tsx`（**代码式路由**，`router.tsx` 是手写树、无 routeTree 代码生成）：在 `router.tsx` import 并加进 `rootRoute.addChildren([...])`。
- **必须**在 `tests/route-ux-inventory.test.ts` 的 `ROUTE_UX_INVENTORY` 登记一条（两向棘轮）。登记为 `classification:'standard'` 时测试会 AST 解析生产源码确认真的 import 并渲染了 `PageHeader`。
- **不进侧边栏**：`/onboarding` 落到 `resolveActiveNav` 末尾的全 null fallback（与 `/tasks/new` 同待遇），零改动。进侧栏会打红 `nav.test.ts:15-27` 的全量数组断言与 `e2e/ux-consistency.spec.ts:794` 的 11 个 href 锁。
- 首页入口：在 `HomepageGreeting` 的 `homepage__cta` 行加第三个 `<Link to="/onboarding" data-testid="homepage-onboarding">`。**不进 `CapabilityGrid` 的 TILES**（会打红 `capability-grid.test.tsx:102` 与 `homepage.test.tsx:408` 的六格锁）。

### 8.2 首跑卡片的重构

`routes/index.tsx` 的分支形状保持不变（源码守卫 `index-page-routing.test.tsx:243` 要求文件里字面包含 `'<Homepage />'` 与 `'useOnboardingProbe'`）。

`Onboarding.tsx` 保留三个导出（`computeIsFirstRun` / `useOnboardingProbe` / `Onboarding`）与 props 形状，**只换渲染体**：
- 保留 `PipelineHero` + `CapabilityGrid variant="intro"`（RFC-190 的价值表达）。
- 四步硬编码列表 + demo 导入按钮 → **一个**「开始引导」主行动 + 四条教程线的简述。
- ⚠️ `onboarding.test.tsx:189` 硬锁 `.btn--primary` 恰好 1 个 —— 新设计天然满足（唯一主行动就是「开始引导」），这条锁**不改**。
- 顺手修正过期文案：step4 的「本地 git 仓 + base 分支」（RFC-165 早已删除本地路径模式，只剩 remote URL ⊕ scratch）。

`fixtures/demo-workflow.ts` 与 `packages/backend/tests/onboarding-demo.test.ts` **删除**（「帮我建」取代了它，且它引用的 `coder` agent 从不存在、导入后启动必 `agent-not-found`）。删除优于 deprecate。

### 8.3 引导页构成（零新原语）

盘点确认既有公共原语已足够，**不新建任何原语**：

| 用途 | 原语 |
| --- | --- |
| 页头 | `PageHeader` |
| 四条教程线自选 | `ChoiceCards`（radiogroup + roving tabindex + `aria-checked`，天然过 axe） |
| 分步推进 | `Stepper`（受控；`nextEnabled` 由"该步已打勾"驱动，`maxReachable` 防跳步） |
| 每步双按钮 | 放 `Stepper` 的 **children**（`finalActions` 只在最后一步生效） |
| 产物清单 | `Card` |
| 清除二次确认 | `ConfirmDialog`（自带 pending/error，只有 `onConfirm` 兑现才关闭；`description` 传清单节点） |
| 逐项失败详情 | `ErrorDetails`（已内建 `{visible, hiddenCount}` 形状渲染） |
| 提示条 | `NoticeBanner` |
| 空态 | `EmptyState` |

根 class 沿用 `.page.onboarding`：`page-fills-content-width.test.ts:52` 显式断言 `.onboarding` 规则体含 `max-width: <n>px`，换根 class 而删掉该规则会直接红。

### 8.4 「我自己来」的完成检测

**不靠前端轮询猜**。深链带引导上下文：`/agents/new?guideRun=<id>&guideStep=<key>`（`/skills/new` 同理；工作流与工作组没有 `.new` 路由，深链到 `/workflows?create=true` 与 `/workgroups?create=true` —— 后者需照 `workflows.tsx:39-50` 的写法补 `validateSearch`）。

表单页顶部渲染 `NoticeBanner`（"你在引导第 N 步，保存后会回到引导"）。保存成功后前端调 `POST /api/onboarding/runs/:id/adopt`，由**服务端**登记并打标记。

实时性：`/ws/workflows` 可用；**agents / skills / workgroups 没有 WS 频道**（`ws.ts:403`），这三类靠 adopt 调用后的 query 失效即可（不需要轮询）。

⚠️ `onboarding.test.tsx:294` 断言首跑渲染期 `/api/overview` 请求数必须为 0 —— 引导页的新 query 不要挂在首跑卡片上。

## 9. 测试策略

### 9.1 必写（后端）

| 测试 | 锁住什么 |
| --- | --- |
| `rfc211-example-marker-consistency.test.ts` | `diffExampleMarkers` 纯函数正/负向；清除后两处同时归零 |
| `rfc211-onboarding-provision.test.ts` | 四条线的产物**能过 validator / launch readiness**（不是"创建成功"）；幂等重入不重复建 |
| `rfc211-onboarding-cleanup.test.ts` | 删除顺序；`workflow-in-use` 不再阻塞；部分失败逐项结果；重试幂等；**负向：不碰非 example 资源与非 example 任务的产物** |
| `rfc211-onboarding-acl.test.ts` | 别人的 example 资源不可见（列表过滤 + 详情 404 与不存在同形）；非 owner 清除不到；admin `scope=all` 可清 |
| `rfc211-example-task-delete.test.ts` | 有界取消循环；`kill-failed` ⇒ skipped 且不删产物；13 张子表 CASCADE；审计表悬挂行**保留** |
| `migration-0103-rfc211.test.ts` | 五列存在 + 两表存在 + 索引存在（照 `migration-0102-*` 模板） |
| `daemon-start.test.ts` 增一条 | **负向契约**：全新 daemon 起来后五张表 `example` 行数为 0（把"不做开机播种"变成可执行契约） |

### 9.2 必写（前端）

- 重写 `onboarding.test.tsx` 的结构断言（四步 → 教程线简述 + 单一主行动）；保留 `.btn--primary` 恰好 1 个 与 RFC-203「机器码不得作为文案泄漏」两条断言意图。
- 新增 `onboarding-guide.test.tsx`：ChoiceCards 选线、Stepper 推进、「帮我建」调 provision、「我自己来」深链带 run 上下文、清除确认弹窗列出清单。
- `index-page-routing.test.tsx:155` 的「导入示例工作流」文案断言随之改写。
- router mock 需补 `useNavigate`（现有 mock 只替换了 `Link`）。

### 9.3 必改（既有锁）

| 文件 | 改什么 |
| --- | --- |
| `upgrade-rolling.test.ts:230` | `102 → 103`（标题 + 断言 + 注释链三处都改） |
| `upgrade-rolling.test.ts:175/190` + `rfc189-wg-round.test.ts:86` | 冻结库上的 drizzle INSERT 改成**显式列名的裸 SQL**（drizzle 会发 HEAD 全列 → `no column named example`） |
| `contracts/registry.ts` | 新增 7 条 `EndpointSpec` |
| `route-ux-inventory.test.ts` | 新增 `'@/routes/onboarding#Route'` 条目 |
| `e2e/visual-regression.spec.ts` | `onboarding.png` 基线重录（`fixture:'clean'` 走首跑分支）；若首页 CTA 影响像素则 `homepage.png` / `mobile-home-nav.png` 同理。**新增场景要同时改 `EXPECTED_VISUAL_SCENE_COUNT`（模块加载期 throw，不是普通断言失败）** |
| `e2e/a11y.spec.ts:374` | 自动覆盖新引导页（critical/serious 零容忍）——走 ChoiceCards / Dialog 公共原语即可 |

### 9.4 交付门

`bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿。动了 `migrations/` ⇒ 必须跑**完整**后端套件（迁移子集绿而全量雪崩的先例）。前端测试跑 vitest（不在裸 `bun test` 里）。触碰共享导出后跑一次 `bun run build:binary` 验模块循环。

## 10. 失败模式清单

| # | 场景 | 处置 |
| --- | --- | --- |
| F1 | 用户在引导中途手动删掉某个 example 资源 | run 详情读取时过滤解析不到的 artifact，该步退回未完成，可重新「帮我建」 |
| F2 | 用户手动改名 example 资源 | artifact 按 **id** 关联，改名不影响；`resource_name` 仅展示 |
| F3 | 用户手动把 example 资源改回 public | 清除仍按 `example` 列取集，照删；ACL 面板改可见性不清 example 标记（两者正交） |
| F4 | 同一用户并发跑两个 run | 同 track 复用 active run；跨 track 各自独立，后缀不同 |
| F5 | 清除时引导任务还在跑 | §4.3 第 1-2 步：有界取消循环 + 子进程确认；`kill-failed` ⇒ skipped |
| F6 | daemon 重启后未完成的 run | run 是纯 DB 状态，无进程态，重启后原样继续 |
| F7 | 清除部分失败（DB 删了、磁盘没删干净） | 逐项结果标 `failed` + code；孤儿 scratch 目录由既有 `runScratchOrphanGc`（24h）兜底 |
| F8 | example skill 被别人的正式 agent 引用 | `skill-in-use` ⇒ skipped，如实展示 409 details（`{visible, hiddenCount}`），不吞掉 |
| F9 | 大写后缀 | ULID 必须 `.toLowerCase()`，否则四条 name 正则一律 422 |
| F10 | 跨用户引用 | 同 run 内 owner 恒为当前 actor；否则 `assertNewRefsUsable` 422 `acl-missing-refs` |
| F11 | 清除删了 example agent/workflow 后 `memories.scope_id` 悬挂 | 已知残留（无 FK 无清理）；本版**不处理**，记为扩展点 |
| F12 | 未装 opencode / 未配凭据 | 启动前探测 `GET /api/runtimes/status`，给可读提示；不改 daemon 的 fail-closed 启动策略 |

## 11. 对抗复核折入（设计门第二轮，全部已核实源码）

### C1 — admin 的「清我自己的」会退化成「清全实例」（最危险）

`isResourceOwner` 对 admin 恒返回 true（`resourceAcl.ts:206`），`requireResourceOwner` 因此对 admin 从不拒绝。若取集只按 `example = 1`、归属靠 ACL 守卫兜，**admin 点「清除我的引导产物」就等价于清掉所有人正在跑的引导**。

**硬约束**：归属过滤必须写进 SQL 的 `WHERE`：

```sql
WHERE example = 1 AND owner_user_id = :actorId    -- scope='mine'，admin 也不例外
```

ACL 守卫只能当第二道网，**绝不能当唯一判据**。配一条回归测试：「admin 点自清不影响他人 example」。

### C2 — example 行只对 owner 可见（新增的列表过滤）

`filterVisibleRows` / `isVisibleRow` / `isResourceOwner` 三处对 admin 无条件短路（`resourceAcl.ts:73/163/206`，前者连 grants 查询都跳过）。多用户实例里 admin 的 `/agents` `/skills` `/workflows` `/workgroups` 会混入**所有人**的 private 引导产物。

新增一条与 `builtin` 同层的列表过滤（放在 `systemResources.ts` 旁）：

```ts
// example 行是个人沙盒产物，只对 owner 出现在列表里（admin 也不例外）。
// 它不是安全边界（详情仍按 ACL 判定），是可用性边界。
excludeForeignExamples(actor, rows)
```

挂在四类资源的列表路由上，顺序在 `excludeBuiltin*` 之后、`filterVisibleRows` 之前。admin 仍能通过 `GET /api/onboarding/examples?scope=all` 看到全实例清单（按 owner 分组计数）。

### C3 — 后缀是安全必需项，不是可读性优化

`agents` / `skills` / `workgroups` 的 name 全局 UNIQUE，而三处创建撞名抛的 409 **完全不经过 ACL 且原样回显名字**（`agent.ts:63`、`skill.ts:167`、`workgroups.ts:99`）。固定名方案（`example-coder`）会同时造成：① 第二个用户跑引导直接 409 卡死；② 靠反复试名探测他人 private 资源是否存在，**直接违反 RFC-099 D1**。

### C4 — 复跑 / 定时任务这两条旁路

- **relaunch**：`relaunchFrom` 复跑会产出新任务。因为 example 是**从来源资源派生**（§3.4）而不是从请求体读，复跑出来的任务同样带标记 ⇒ 自动进清除范围。**这正是选择"派生"而非"请求体字段"的原因**（请求体字段会被启动 schema 与前端白名单双重剥离）。
- **定时任务**：`deleteWorkflow` / `deleteAgent` / `deleteWorkgroup` 都有 `*-scheduled-referenced` 守卫。用户若把 example 工作流挂了定时，清除该项记 `skipped` + 原因（提示先删定时任务）。**不替用户删定时任务**——那超出"清引导产物"的语义。

### C5 — 取消前必须先判终态

`'interrupted'` 是终态（daemon 重启后 `reapOrphanRuns` 会把 running 翻成它，`cli/start.ts:216`）但**不在** `CANCELABLE_TASK_STATUSES` 内（`task.ts:2001`）。直接 cancel 会拿到 409 `task-not-cancelable` 让整批失败。

**顺序**：`isTerminalTaskStatus(status)` 为真 → 跳过取消直接进删除；否则才进有界取消循环。

另注：`autoResumeInterruptedTasks` 精确按 `status='interrupted' AND error_summary='daemon-restart'` 自动 resume（`autoResume.ts:69`）。用户跑到一半关掉引导 + daemon 重启，这个 scratch 任务会自己复活继续烧 token —— 属既有行为，清除能把它删掉，不在本 RFC 改自动恢复策略。

### C6 — 三处磁盘产物没有任何 GC 兜底

`runs/{taskId}/**`（含 `ports/` 与 `review/` 的 doc_versions 正文）、`logs/{taskId}/*.jsonl`、`structural-diffs/{taskId}/**` **完全没有 GC**（只有 scratch 有 24h 的 `runScratchOrphanGc`）。漏删即永久垃圾，且 `doc_versions` 行已被 CASCADE 删掉、正文文件再也没有引用能定位。

⇒ 这三处必须逐条删，删失败**上报**而不是静默吞掉。

### C7 — 其它已核实的边界（记录不改）

| 项 | 结论 |
| --- | --- |
| owner 转移（`PUT /acl` 可改 `ownerUserId`） | 转走的资源不再属于我 ⇒ 我的清除**正确地**不删它。以 `owner_user_id = me` 为准 |
| 清除粒度 | 恒为**本用户所有 example**，不按 run 收窄（并发 run 会一起清），UI 文案写明 |
| 打勾判据 | 后端按 `(owner = me ∧ example ∧ 属于本 run 的 artifact id)` 实时重查；**绝不用裸列表长度**（会被别人的 public 资源与自己另一个 run 污染，admin 尤其严重） |
| `onboarding_runs` 的恢复语义 | run 是纯 DB 状态、无进程态、无租约 ⇒ 不需要开机对账；同 track 复用 active run 天然消化"僵尸 run" |
| `workgroups.maxRounds` | DB 列默认 20、zod 默认 1000（`schema.ts:492` vs `workgroup.ts:106`）⇒ **必须走 service，禁止直插表** |
| workgroup roster 跨用户驱动 private agent | `startWorkgroupTask` 的 roster 解析无 ACL 过滤（`workgroupLaunch.ts:249`）——既有设计边界，非本 RFC 引入，不在此修 |
| 任务快照透出 workflow definition | `TaskSchema.workflowSnapshot` 是 `z.unknown()` 原样透出、任务是成员制（`task.ts:242`）——协作者能读到 private 工作流定义。既有设计，显式承认 |
| `ChoiceCardsProps` 未 export | 前端不要 import 该类型（会 typecheck 红） |

## 12. 已知不做（与 proposal §3 对齐）

- 开机播种、产物转正、高阶主题、coachmark/tour 原语、降级启动、validator 软护栏、`memories` 悬挂行清理、通用 `DELETE /api/tasks/:id`（本 RFC 只给 **example 任务**开删除口，不开放通用任务删除）。
