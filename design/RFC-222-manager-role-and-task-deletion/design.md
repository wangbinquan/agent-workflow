# RFC-222 · manager 角色与任务删除 — 技术设计

状态：Draft（2026-07-22）。产品决策见 proposal.md §4（D1-D5）。

## 0. 设计总纲

三条需求共用一次权限/删除体系改造，拆三条主线：

- **A 线（manager 角色）**：纯代码改动、**零 migration**（`users.role` 是 text 列，db/migrations 建表 SQL 无 CHECK 约束；zod 侧全部派生自 `RoleSchema`）。核心动作是把散落的 `role === 'admin'` 判定按语义拆成两个谓词：**资源域** → 新谓词 `isResourceAdminActor`（admin ∪ manager）；**系统域** → 保持 `isAdminActor` / `requireAdmin()`（仅 admin）。
- **B 线（任务删除）**：新权限点 `tasks:delete`（仅 admin）+ 新端点 + 新服务 `deleteTask` + 预埋 WS 帧 `task.deleted` 的首个发送方。
- **C 线（删除强确认，D5）**：任务 + 六类 ACL 资源共 7 个 DELETE 端点统一接入 type-to-confirm——请求体携带用户输入的名称文本，服务端比对当前名称、不匹配拒绝；前端 `ConfirmDialog` 最小扩展输入模式（§7）。

依赖：B 依赖 A（权限点目录）与 C（确认 helper + Dialog 扩展）；C 独立可先行。

## 1. shared 权限目录（单一事实源）

`packages/shared/src/schemas/permission.ts`：

```ts
export const PERMISSIONS = [
  // …existing…
  'tasks:delete',            // NEW — admin only（需求②）
] as const

export type Role = 'admin' | 'user' | 'manager'
export const RoleSchema = z.enum(['admin', 'user', 'manager'])

// manager = user 基线 + 资源域越权三点。
// row 级 bypass 不在权限点体系里（见 §2 谓词），这里只挂路由粗门。
const MANAGER_EXTRA: ReadonlyArray<Permission> = [
  'repos:write',        // D3：仓库属资源
  'tasks:read:all',     // D2
  'tasks:cancel:all',   // D2
]

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  admin: [...PERMISSIONS],
  user: USER_BASELINE,
  manager: [...USER_BASELINE, ...MANAGER_EXTRA],
}
```

要点：

- `admin: [...PERMISSIONS]` 自动纳入 `tasks:delete`，无需点名。
- **Drizzle 角色闭集同步（设计门 P1-1）**：`db/schema.ts:1664` 的 `text('role', { enum: ['admin','user'] })` 必须同步加 `'manager'`——否则 create/patch 把三值 `Role` 赋给二值列 typecheck 不过（services/users.ts:62/229）。SQL 列无 CHECK（0018_rfc036_users.sql），**A 线仍零 SQL migration**，这是纯 Drizzle 类型层变更。
- **PAT 高危点显式化（设计门 P1-3）**：`buildActor`（actor.ts:33-41）现状是"空 scopes 的 PAT = 完整角色基线"——历史 admin 空 scope PAT 会静默继承新增的 `tasks:delete`，变成全权删除令牌。不改动空 scope 的既有语义（那是独立的全体 PAT breaking 决策），但引入 `PAT_EXPLICIT_ONLY_PERMISSIONS = ['tasks:delete']`：`buildActor` 对 `source === 'pat'` 且未显式列出该点的一律剔除（含空 scope 情形）。效果：任务删除对 PAT 是 opt-in；又因 RFC-221 计划全局关闭 PAT 新建（存量只退不进），**实际上任务删除成为 session-only 能力**——两 RFC 交互在 §12 联合清单登记。测试：admin 空 scope PAT DELETE → 403；admin 显式含 tasks:delete 的 PAT → 200；user PAT 列 tasks:delete → 403（narrow 不 widen）。
- **`ADMIN_ONLY_PERMISSIONS` 现定义为 `PERMISSIONS − USER_BASELINE`，manager 出现后该名字语义失真**（其中 `repos:write` 等三点已非 admin 独有）。处置：保留该导出与现有 user 负集锁不动（它锁的是"不得泄漏给 user"，依然成立），另加显式常量 `MANAGER_DENIED_PERMISSIONS = ['users:read','users:write','settings:read','settings:write','oidc:read','oidc:configure','backup:run','tasks:delete']`，供快照测试双向锁定（∈ admin、∉ manager）。命名沿用现状不重命名，避免无谓涟漪；语义由注释与测试钉住。
- `memory:*` 五点已在 USER_BASELINE（RFC-099 D12 行级模型），manager 无需加点——repo/global 域的放开发生在 §3 的行级谓词，不在权限点层。
- PAT：`buildActor` 的 narrow 语义（actor.ts:35-38，"narrows; never widens"）天然适配 manager——manager 的 PAT 至多是 manager 基线的子集。PAT scope 选择 UI 若展示了 manager 不持有的点，选了也无效（narrow 交集），无泄漏；不专门改 UI。

## 2. 身份谓词拆分（A 线核心）

### 2.1 新谓词

`services/resourceAcl.ts`：

```ts
/** 全局 admin 身份（系统域：users/settings/oidc/backup/runtimes/任务删除）。 */
export function isAdminActor(actor: Actor): boolean {
  return actor.user.role === 'admin'
}

/** RFC-222 — 资源域管理身份：admin 与 manager 共享全部资源 row 级 bypass。 */
export function isResourceAdminActor(actor: Actor): boolean {
  return actor.user.role === 'admin' || actor.user.role === 'manager'
}
```

`auth/permissions.ts` 增配套中间件——**身份与权限点双门（设计门 P1-4）**：`requireAdmin()` 的纯身份判定是既有缺口（一个只列 `agents:read` 的窄 admin PAT 现在也能进 distill-jobs 路由），本 RFC 不复制该缺口：

```ts
/** 403 unless (admin|manager) AND actor.permissions.has(perm)。
 *  身份门挡 user；权限门让 PAT scope 收窄真实生效。 */
export function requireResourceAdmin(perm: Permission): MiddlewareHandler
```

distill-jobs 路由族与 WS 频道门取 `requireResourceAdmin('memory:approve')`（记忆运维面最贴切的既有点；memory:approve 在 user 基线，故身份门仍是主判别，权限参数专为 PAT 收窄）。谓词本体 `isResourceAdminRole(role)`（纯函数）下放 shared，`isResourceAdminActor` 与中间件、WS 判定全部从它派生——资源域身份判定单一事实源（设计门 P2-3），G-1 守卫升级为全仓禁止资源域手写 role 联合（§9）。

### 2.2 替换清单（isAdminActor → isResourceAdminActor）

逐处核对过语义（资源域才换，系统域不动）：

| 文件 | 位置 | 判定语义 | 处置 |
| --- | --- | --- | --- |
| services/resourceAcl.ts | isVisibleRow:93 / discloseRefs:131 / filterVisibleRows:164 / canViewResource:177 / isResourceOwner:208 | 六类资源可见/owner bypass | **换** |
| services/resourceAcl.ts | resolveTaskRole:242 | 任务关系角色快照 | **改写**（§4，manager 单列） |
| services/memory.ts | canViewMemory:734 / canManageMemory:749 / filterMemoriesByScopeVisibility:765 / listWithCanManage:815 | 记忆行级可见/管理 | **换**（D3：repo/global 域随之对 manager 放开） |
| services/fusion.ts | 169 / 444 / 897 / 958 | fusion owner-or-admin | **换** |
| routes/fusions.ts | 78 / 89 / 99 | fusion 列表/详情可见 | **换** |
| services/taskCollab.ts | 115 / 138 | 协作者名单管理权（owner-or-admin） | **换**（任务域操作，D2 全给） |
| services/workflow.ts | 531 | 工作流引用披露 | **换** |
| services/agent.ts | 262 / 265 / 409 / 412 | agent 引用闭包授权 | **换** |
| services/resourceRefs.ts | 69 | 保存时新增引用校验短路 | **换** |
| routes/scheduledTasks.ts | requireWriteAccess:36 | schedule owner-or-admin 写权 | **换** |
| ws/registry.ts | 766（adminShortCircuit 判定） | workflows/memories 频道免过滤 | **换**（row 级语义，见 §2.3 PAT rationale） |
| ws/registry.ts | 621（memory-distill-jobs upgradeGate） | 蒸馏 job 频道门 | **换**（D3；双门：身份 ∧ memory:approve） |
| routes/memoryDistillJobs.ts | 5 × requireAdmin() | 蒸馏 job 路由族 | **换成 requireResourceAdmin('memory:approve')**（D3+P1-4） |
| routes/runtimes.ts | 7 × requireAdmin() | runtime 管理 | **不动**（系统域） |
| routes/restore.ts | 3 × `role !== 'admin'` | 恢复操作 | **不动**（备份域；且外层已挂 backup:run） |
| services/users.ts | countOtherActiveAdmins 等 | last-admin 保护 | **不动**（manager 不计入 admin） |
| services/clarifyAutoDispatch.ts | SYSTEM_DISPATCH_ACTOR role:'admin':871 | daemon 派发者快照 | **不动**（__system__ 恒 admin） |

替换后 **`isAdminActor` 在资源路径零残留**由守卫测试锁定（§8 G-1）。

`requireResourceOwner` 的 403 文案 `only the ${type} owner or an admin can modify it`（resourceAcl.ts:226）改为 `…owner or a resource admin…`，前端如有透传展示不受影响（纯 message 字段）。

### 2.3 有意不对称点（明示）

- `discloseScheduleRefs`（resourceAcl.ts:140-150）与任务/schedule 可见性统一走 `tasks:read:all` **权限点**而非身份谓词——manager 经 §1 授点自动获得，代码不动。同理 taskCollab.canViewTask:36、routes/tasks.ts:143-157、routes/clarify.ts:125/178、routes/reviews.ts:120/162、services/overview.ts:53、services/scheduledTasks.ts:205、ws/registry.ts:643（scheduled-tasks 帧过滤）——**全部零改动自动跟随**，这正是权限点体系的红利；测试对这些路径以 manager actor 断言行为而非断言实现。
- **任务生命周期操作（cancel/resume/retry）的真实门是 `visibilityCheck` 中间件**（routes/tasks.ts:166-177 挂 `/api/tasks/:id` 与 `/api/tasks/:id/*` 全族：成员 or `tasks:read:all`，canViewTask 语义）。`tasks:cancel:own` / `tasks:cancel:all` 两个权限点在 HTTP 层**零消费**（历史死点）——现状行为 = "对任务可见即可操作生命周期"。manager 拿到 `tasks:read:all` 后 cancel/resume/retry 对全量任务自动可用（与 D2 的疏导意图一致，US-3）；`tasks:cancel:all` 仍按 D2 授予 manager 保持权限目录的语义一致性，但**测试必须断言行为门（visibilityCheck）而非权限点**。本 RFC 不接活这两个死点、不改 cancel 语义（诚实登记；接活属独立清理）。
- **row 级 bypass 有意保持纯身份（对设计门 P1-4 的部分不采纳，rationale 明示）**：resourceAcl 头注释（resourceAcl.ts:8-11）是 RFC-099 的既定原则——"PAT narrow 只收路由 gate，不翻 row 可见性"（窄 scope PAT 仍属于 admin，行可见面不变）。workflows/memories 频道的 adminShortCircuit 是 row 级过滤的免计算短路，与 HTTP 列表路由 admin 直通 `filterVisibleRows` 同构，故随谓词换成 `isResourceAdminActor` 后**继续纯身份、不加权限点**。频道/路由级 gate（distill-jobs）才补双门。PAT 对资源写路径的收窄仍由 `resourcePermissionGate`（agents:write 等）承担，无绕过。已知现状登记（二轮自审）：workflows/memories 频道 upgrade 本就无 permission gate（对全体登录用户开放、靠帧过滤）——被剥夺 `workflows:read` 的窄 PAT 仍可连频道，此为 RFC-099 以来现状，本 RFC 不扩大也不在此修。
- daemon actor（`__system__`）role='admin'：不受影响，runner/scheduler 注入路径结构性不变（resourceAcl.ts 头注释既有承诺）。

## 3. 记忆域（D3 落地）

`canManageMemory`（memory.ts:749）换谓词后：repo/global scope 从"admin-only"变为"admin|manager"；agent/workflow scope 维持"scope 资源 owner or (admin|manager)"。`canViewMemory` / 列表过滤同步。蒸馏 job 路由 + WS 门换 `requireResourceAdmin`。**permission.ts:96-99 的 D12 注释同步改写**（"repo/global-scoped rows still reject non-admins" → non-resource-admins）。

## 4. 任务关系角色快照（TaskActorRole 第四值）

现状 `TaskActorRole = 'owner' | 'user' | 'admin'`（shared），resolveTaskRole 非成员 admin → 'admin'。manager 以非成员身份越权进任务（回答反问、评审留言）时**如实记 `manager`**——归属审计不冒充 admin：

```ts
export function resolveTaskRole(actor, taskOwnerUserId, isMember): TaskActorRole | null {
  if (taskOwnerUserId !== null && taskOwnerUserId === actor.user.id) return 'owner'
  if (isMember) return 'user'
  if (actor.user.role === 'admin') return 'admin'
  if (actor.user.role === 'manager') return 'manager'   // NEW
  return null
}
```

涟漪面（全部为类型加值，DB 列均为无约束 text，**零 migration**）：

- shared 中央定义：`TaskActorRoleSchema`（shared/src/schemas/resourceAcl.ts:34，`z.enum(['owner','user','admin'])`）加 `'manager'`。
- **shared 六处手抄三值闭集（设计门 P1-2，漏一处 manager 帧/响应就会被 zod 拒收）**：shared/src/schemas/review.ts:333/373/556、clarify.ts:445/453、ws.ts:183——全部改为复用 `TaskActorRoleSchema`（消灭手抄），并加 review/clarify/WS 三条 manager round-trip 解析测试；实现时另 grep `'owner', 'user', 'admin'` / `'owner'|'user'|'admin'` 全仓确认再无第七处。
- backend 类型注解：review.ts:1605/1750/2008、clarifyAutoDispatch.ts:252、taskQuestionDispatch.ts:71（若显式联合字面量则加值；若引 shared 类型则自动）。
- frontend：`AttributionChip`（AttributionChip.tsx:12 联合类型 + :32 分支）加 manager 案例；`useClarifyWs.ts:35` editor.role 类型；i18n `en-US`/`zh-CN` 加 `attribution.role.manager`（Manager / 资源管理员）。
- **prompt 隔离铁律**：RFC-099 双层锁（rfc099-prompt-isolation）保证归属记录不进 agent prompt——manager 值同受约束，测试扩一个 manager 案例（§8）。

## 5. users 域与角色授予

- zod：`CreateUserBody` / `PatchUserBody` 的 role 派生自 `RoleSchema`（shared/schemas/user.ts:15/41/52）→ **自动接受 manager，零改动**。
- last-admin-protection（users.ts:153/212/220）：`countOtherActiveAdmins` 只数 `role='admin'` **保持不变**——manager 管不了用户，不能充当最后管理员；把唯一 admin patch 成 manager 命中现有 `patch.role !== 'admin'` 分支被拒，**无需新代码，只需新测试**。
- 角色即时收放：patchUser 已 `triggerRevalidation(db, 'user-patched')`（users.ts:243），RFC-212 revalidation 承接 manager↔user 切换的 WS 可见面收窄（AC-11 走既有机制，测试断言行为）。
- CLI（设计门 P2-4 实锤：cli/user.ts:54 是裸 `consume() as Role` 强转、**任意字符串可写库**，usage 文案仍是 `admin|user`）：改 `RoleSchema.safeParse` 运行时校验（非法值报错退出、零写入）+ usage 更新为 `admin|user|manager`；测试 manager 成功 + 非法值拒绝。
- 前端 users 页（routes/users.tsx）：`'admin' | 'user'` 联合类型 ×5（26/53/79/250/259）+ 两处 `Select` options（171-190/312-325）加 manager 项 + i18n 角色显示名。与 RFC-221 的合并约定见 proposal §7。

## 6. 任务删除（B 线）

### 6.1 端点契约

```
DELETE /api/tasks/:id            gate: requirePermission('tasks:delete')
  body: { confirm: string }                       — C 线强确认（§7）：须精确等于 task.name
  200 { ok: true, taskId }                        — 已删除（幂等考量见下）
  400 delete-confirm-required / delete-confirm-mismatch — confirm 缺失 / 与 task.name 不符
  404 not-found                                   — 任务不存在
  409 task-not-terminal { status }                — 状态 ∉ {done, failed, canceled, interrupted}
  403 forbidden                                   — 权限点缺失（user/manager/owner 皆然）
```

- 判定顺序：403（路由 gate）→ 404（行不存在）→ **400（confirm 校验，§7 helper）→ 409（状态门）**。confirm 先于状态门：名称都对不上说明调用方连删的是什么都没确认，不该泄露状态信息（虽对 admin 无实际泄漏，取此序保持 7 端点统一：load → confirm → 业务门）。
- **无软删除/回收站**（proposal §3 非目标）；不做批量端点。
- 幂等：删除后重放同请求得 404 —— 对 DELETE 而言可接受且诚实（资源确已不在）。

### 6.2 状态门与并发防护

活跃态集合 `{pending, running, awaiting_review, awaiting_human}` 一律 409（awaiting_* 虽无进程在跑，但任务在等人、生命周期未收场——先 cancel 再删，避免删除路径卷入调度器/评审流的中间态）。

**终态 ≠ 静默（设计门 P1-5）**：cancel 等待 5s 后可把仍挂 controller 的任务直接标成 `canceled`（task.ts:2054/2073），重启后还可能有残存 PID（task.ts:2293 kill-fail gate 先例）——只看 status 会删掉活跃写入者脚下的 worktree。删除前置门四连（全部 409 `task-active`，按序）：

1. **内存活跃表**：`activeTasks`（task.ts:117）含该 task → 拒。
2. **写锁**：按 `taskWriteLocks`（taskWriteLocks.ts:23）统一锁序取得该任务写锁，全程持有至 DB 事务完成——与在途 node 写路径互斥。
3. **残存进程**：node_runs 记录的存活 PID（复用 task.ts:2293 的探测/拒绝定式）→ 拒（不代杀，让用户走 cancel 的既有 kill 路径）。
4. **fusion internal 任务（设计门 P1-6）**：承载 Fusion 审批流的 internal task（`fusions.currentTaskId` 无 FK 活引用 schema.ts:1915；其 worktree 是 approve 的 proposal 来源 fusion.ts:1065，GC 亦有意不清 gc.ts:22）→ 409 `task-internal`，v1 一律拒删（Fusion 生命周期自会收敛其任务）。判定以 fusions 表反查 currentTaskId 为准。

终态判定与 DB 删除在**同一个 `dbTxSync` 写事务**内完成（重读 status → 校验终态 → 删行），封死与 resume/retry 的 TOCTOU：并发 resume 若先行，事务内重读见非终态 → 409；若删除先行，resume 的 `trySetTaskStatus` CAS 因行不存在而失败（设计门核实：resume/retry 均先 CAS 再做 worktree 副作用 task.ts:2240/2742，scheduler 只从 pending claim，wake 归入 resume——事务论证成立）。lifecycle.ts 转移表不受影响，无需新状态——删除不是状态转移，是行的消亡。

### 6.3 级联清理清单（数据面权威）

**FK cascade 自动清（12 张，`references(() => tasks.id, { onDelete: 'cascade' })`，`PRAGMA foreign_keys = ON` 已全局开启 client.ts:121）**：workgroupAssignments、workgroupMessages、workgroupTaskState、workgroupMemberCursors、taskRepos、nodeRuns、docVersions、clarifyRounds、taskNodeClarifyDirectives、taskCollaborators、lifecycleAlerts、taskQuestions。nodeRuns 的下游子表（若有挂 nodeRuns.id 的 cascade）随二级链清空——实现时全量 grep `references(` 核对二级链并在测试里抽查。

**同事务显式删（无 FK、taskId notNull、任务域用户输入）**：`task_feedback`（schema.ts:2019）——反馈的 scope 锚是任务本身，任务消亡随删；已被蒸馏转化的 memory 独立存活不受影响。

**有意保留（审计/记忆域，引用悬空可接受）**：`memory_distill_jobs`（记忆域产物，蒸馏历史不随任务抹除；detail 服务已有 `deletedOrMissing=true` 容错 memoryDistillJobDetail.ts:135——设计门核实，保留的是 dangling taskId 非置 null）、`recovery_events`（灾备审计）、**`lifecycle_repair_audit`（设计门 P1-7 纠正：v1 曾误列显式删——该表 schema 注释明确无 FK 是为了"outlives the task"的 append-only 审计合同 schema.ts:2061，且是 recovery_events 的人工操作对偶 schema.ts:2091，改为保留）**。

**逻辑任务引用矩阵（设计门 P2-1——非 `taskId` 字面名的语义引用）**：

| 列 | 处置 |
| --- | --- |
| `scheduled_tasks.lastTaskId`（schema.ts:919） | 保留 dangling；schedule UI 现会渲染指向 404 的任务链接（scheduled.tsx:226）→ 前端对已删任务降级为"已删除"文本（本 RFC 内修） |
| `memories.sourceTaskId`（schema.ts:1865） | 保留 dangling（记忆 provenance，明示不清洗） |
| `fusions.currentTaskId`（schema.ts:1915） | 不会悬空——internal task 拒删闭环（§6.2 门 4） |

**events 落定（已核）**：`node_run_events`（schema.ts:1472）经 `nodeRuns.id` cascade 二级链自动清；`memory_distill_events` 挂 `memory_distill_jobs`（保留链，随 job 留存）；`recovery_events` 见上。实现时仍全量 grep `references(` 复核一遍二级链无漏。

### 6.4 磁盘清理（cleanup outbox，先库后盘——设计门 P1-8 重设计）

v1 曾设计"DB 先删、磁盘尽力、GC 兜底"——设计门证伪了兜底断言：worktree GC 只从**现存 tasks 行**选候选（gc.ts:105），无行 orphan 扫描只覆盖 scratch 根（gc.ts:272）；删行后的 worktree 残留没有任何回收路径，且删行与清盘之间存在不可恢复的 crash gap。现有 GC 自身正是用 claim/delete/finalize 三阶段防崩溃丢重试（gc.ts:9）。重设计为 **cleanup outbox**：

- **migration（B 线新增一条，A/C 线仍零 migration）**：新表 `task_cleanup_queue`：`task_id`(pk)、`payload_json`（事务前读出的全部清理载荷：per-repo worktreePath+repoPath、快照 ref 名、logs/runs/scratch 路径）、`created_at`、`attempts`、`last_error`。遵循 [reference_journal_when_must_be_monotonic]（`when` 接合成轴）与 [reference_migration_statement_breakpoint]；migration 落地后 bump upgrade-rolling 计数锁（[reference_migration_bumps_journal_count_test]）并跑**全量** backend 套件（[feedback_full_suite_after_migration]）。
- **删除事务内原子完成**：删 tasks 行（cascade）+ 显式删 task_feedback + **插入 outbox 行**——行删除与清理承诺同生同灭，crash 后无论停在哪一侧都可收敛。
- **事务后立即执行一次清理**（同请求内，尽力）：worktree `removeWorktree({force:true})`+`rmSync` 兜底（gc.ts:181-201 定式）→ 快照 ref `deleteSnapshotRefs` → **logs 归档目录 `${logsDir}/{taskId}`（设计门 P2-2：node_run_events 会被 eventsArchive.ts:142 搬出 DB 落盘，v1 清单漏掉）** → runs/scratch 目录。全部成功 → 删 outbox 行、HTTP 200 `{cleanup:'done'}`；任一失败 → outbox 行留存（attempts+1、lastError）、HTTP 200 `{cleanup:'pending'}`（DB 删除已成立，删除动作本身不失败）。
- **hourly GC 收编 outbox**：每小时扫 `task_cleanup_queue` 重试（幂等：路径不存在即成功），复用/对齐 gc 的 per-repo removeWorktree 语义与 call-graph cache 失效（gc.ts:174）；成功删队列行。实现建议：把"按载荷清一个任务的全部产物"抽成共享 artifact-prune 原语，删除即时路径与 GC 重试路径共用（设计门 P2-2 的抽取建议）。
- 备份 staging 产物不清（备份是时点快照，不追溯）。

### 6.5 WS 与前端失效

- 删除成功后经 tasks 频道广播 `task.deleted`——帧 schema（ws.ts:235）、registry 转发 case（registry.ts:362）、前端 invalidation（useTasksSync.ts:15 → invalidate ['tasks']）三层预埋就绪，本 RFC 是首个真实发送方。
- **audience context 随帧携带（设计门 P1-9）**：registry 的 `cachedTaskVisible` 对已不存在的任务恒 false（registry.ts:285），`task.deleted` 走同一 gate（registry.ts:356/475）——删行后只有恰好缓存过 `true` 的 socket 能收到，帧对冷缓存连接全部丢弃、AC-9 不可达。修法沿用 workflow deletion context 先例（broadcaster.ts:97）：删除事务内读出 `ownerUserId` + collaborator ids，帧携带进程内 audience 上下文；registry 的 `task.deleted` case 改为**不查 DB**——`audience.includes(actor.id) || actor.permissions.has('tasks:read:all')` 直通。测试必须覆盖冷缓存的 owner / collaborator / manager / admin 连接。
- **per-task 频道删除合同（设计门 P2-8）**：`task.deleted` 现只存在于 list 频道 schema（ws.ts:228 族）；任务详情页只订阅 per-task 频道且终态后停止轮询（tasks.detail.tsx:170）——其他客户端删除后，停留在详情页的会话永远不知道。per-task 频道（`/ws/tasks/:id`）增加 `task.deleted` 终帧（upgrade 时已鉴权，后续帧不再 gate，直接发）；前端收到后清该任务缓存、提示已删除并导航回列表。
- 前端：任务详情页加「删除任务」按钮，`usePermission('tasks:delete')` 门控（权限点门控优于 useIsAdmin——语义即"谁持删除点"；且 PAT 剔除后自动正确）；`.btn--danger`；带 `confirmInput`（输入任务名，§7）的 ConfirmDialog；成功后失效 `['tasks']` 并导航回任务列表。v1 仅详情页放按钮，列表行不放（避免行动作拥挤，proposal §3）。

## 7. 删除强确认（C 线，D5）

### 7.1 覆盖面与 wire 契约

7 个 DELETE 端点统一接入（**有意的 breaking change**：`confirm` 必填，旧调用方——含既有测试与外部 PAT 脚本——会得 400；这正是"后台校验"的含义，发布说明明示）：

| 端点 | 定位方式 | confirm 比对对象 |
| --- | --- | --- |
| DELETE /api/agents/:name | :name | `:name`（路径参数即名称） |
| DELETE /api/skills/:name | :name | 同上 |
| DELETE /api/mcps/:name | :name | 同上 |
| DELETE /api/workgroups/:name | :name | 同上 |
| DELETE /api/workflows/:id | :id (ULID) | 行的 `name` 列（**价值最高**：id 与人类名分离） |
| DELETE /api/plugins/:id | :id | 行的 `name` 列 |
| DELETE /api/tasks/:id | :id (ULID) | 行的 `name` 列（tasks.name，RFC-037 launch 时命名） |

请求体统一 `{ confirm: string }`。`DELETE /api/skills/:name/file`（技能内文件）不纳入（D5 明示排除）。三点精确化（二轮自审 N-1/N-2/N-4）：

- **workflows 端点特殊性（N-1）**：它已有 `.strict()` 的 `DeleteWorkflowSchema`（expectedVersion OCC + clientMutationId，workflow.ts:306-312）与 safeJson 解析流——confirm 作为新必填字段**扩进该 schema**（strict 下另立解析必炸），与 OCC 并存；前端 client 对 DELETE 发 body 的兼容性由该端点既有行为实证，不是假设。
- **比对基准统一为"load（或排他段 fresh 重读）后的行 name"（N-2）**：:name 路由 load 键即 name，常态下等于路径参数；但 mcps 删除在 `mcpOperationCoordinator.runExclusive` 内 fresh 重读（mcps.ts:143-147），confirm 在 fresh 之后比对 → 打开确认框到提交之间资源被改名时自动 mismatch——改名 TOCTOU 被名称比对天然拦截，7 端点同语义。
- **空 body 解析统一（N-4）**：无 body/空 body 的 DELETE（全部旧调用方）不能落到底层 JSON 解析异常——统一 `readDeleteBody(c)` 定式：空/无 body → `{}`（随后 confirm 缺失 → 400 `delete-confirm-required`）；畸形 JSON → 既有 400 `invalid-json` 语义保留。workflows 端点例外：走既有 safeJson+schema 流（其空 body 本就 400，行为不回退）。

### 7.2 服务端校验（真正的门）

新 helper `assertDeleteConfirm(body: unknown, expectedName: string, resourceType: string)`（`packages/backend/src/services/deleteConfirm.ts`）：

- body 非对象 / `confirm` 缺失或非 string → 400 `delete-confirm-required`
- `confirm !== expectedName`（**精确比对**：大小写敏感、不做 trim/规范化——前端负责 trim 用户输入两端空白后提交）→ 400 `delete-confirm-mismatch`（error meta 携带 `resourceType`；不回显 expected——调用方本可读到名称，但不喂拼写）

**判定顺序统一（N-5，7 端点一致）**：可见性 404（loadVisible*）→ 授权 403 / builtin 拒绝（requireResourceOwner / assertNotBuiltin，既有顺序不动）→ **confirm 400** → 业务门（引用 refusal / OCC / 状态门）409/422 → 删除。confirm 排在授权后（越权者先见 403，不被 400 掩盖）、业务门前（名字都没确认对，不进入业务判定；deleteWorkflow 的 DisclosedRefs refusal 与 tasks 的终态门都在 confirm 之后）。mcps 的 confirm 在 runExclusive 排他段内 fresh 重读后执行（N-6）。expected 取值见 §7.1（load/fresh 后的行 name）。

**核心正确性点（黑体钉住）**：前端提交的 `confirm` 必须是**用户在输入框里敲的实际文本**，绝不允许前端代码把已知的资源名常量塞进请求——否则服务端校验退化为恒真传递，整个机制形同虚设。测试双向锁定（§9 C 组 + F 组）。

### 7.3 前端：ConfirmDialog 最小扩展

`ConfirmDialog`（RFC-198，自持 pending/error、onConfirm 返回 mutation promise）加可选 prop，不 fork 不新建组件：

```ts
export interface ConfirmDialogProps {
  // …existing…
  /** RFC-222 (D5) — type-to-confirm 模式：渲染名称输入框，
   *  输入（trim 后）精确等于 expected 才 enable 确认按钮。 */
  confirmInput?: { expected: string; label: ReactNode; placeholder?: string }
}
// onConfirm 演化为可选拿到输入值（现有消费者零改动）：
onConfirm: (ctx?: { typedConfirm?: string }) => void | Promise<void>
```

- 内部用公共 `<Field>` + `<TextInput>`（Form 原语，UI 一致性铁律）；open 翻转时清空输入（复用现有 open-session 重置 effect）。
- 确认按钮 disabled 条件追加 `trim(input) !== expected`；提交时 `ctx.typedConfirm = trim(input)`，调用方将其放进 DELETE body——**不是放 expected**。
- **重名消歧（N-3）**：workflows/plugins/tasks 的 name 不保证唯一（RFC-211 实锤过 workflow 同名；tasks.name 可重复）——确认框 description 必须带 id 短码（如 `name · #01JX…`），让用户确认的是"这一行"而不只是一个名字；:name 路由四类（name 即主键）无此问题。
- 服务端 400 mismatch 走 ConfirmDialog 既有 error 展示（ErrorBanner），i18n 映射两个新错误码。
- 7 个删除入口改造：六类资源 detail/edit 页（agents.detail / skills.detail / mcps.detail / plugins.detail / workgroups.detail / workflows.edit）+ 任务详情页（B 线新入口）。逐页核对现有交互（ConfirmDialog / ConfirmButton 两种既有模式），统一收敛到带 `confirmInput` 的 ConfirmDialog。
- i18n（en-US/zh-CN）：确认输入 label（"输入名称 {{name}} 以确认删除"）、placeholder、`delete-confirm-required` / `delete-confirm-mismatch` 错误文案。

### 7.4 既有测试会红清单（诚实登记）

六类资源的既有 DELETE 测试（backend route 测试、若干 e2e 删除流）在 confirm 必填后会 400 红——实现时全量 grep `app.request(.*DELETE` / `method: 'DELETE'` 与 e2e 删除步骤，逐处补 `confirm`。这属于 breaking 的自然涟漪，**不允许**为让旧测试过而把 confirm 做成可选。

## 8. 失败模式盘点

| 场景 | 行为 |
| --- | --- |
| manager 调 DELETE /api/tasks/:id | 403（无权限点）——**含任务 owner 是 manager 本人的情形** |
| admin 空 scope PAT 调 DELETE | 403（PAT_EXPLICIT_ONLY 剔除 tasks:delete，§1） |
| admin 删 running 任务 | 409 task-not-terminal，先 cancel |
| status=canceled 但 controller/PID 仍活（cancel 5s 超时残留） | 409 task-active（§6.2 门 1/3） |
| 删 fusion internal task | 409 task-internal（§6.2 门 4） |
| 删除与 resume 并发 | 写锁 + 事务内重读，二者必有一方干净失败（§6.2） |
| worktree/logs 清理失败（占用/权限） | 200 `{cleanup:'pending'}`，outbox 留存、hourly GC 重试至收敛（§6.4） |
| 删行后 daemon crash（清盘未跑） | outbox 行与删除同事务落库，重启后 GC 收敛（§6.4） |
| 删除后其他客户端停留在任务详情页 | per-task 频道 task.deleted 终帧 → 提示并导航（§6.5） |
| manager 的 PAT 请求 admin-only 点 | 403（narrow 交集不含该点） |
| manager 被降级后已连 WS | RFC-212 revalidation 收窄（user-patched 触发） |
| 唯一 admin 被降为 manager | 400 last-admin-protection（既有分支覆盖） |
| manager 访问 /settings、/users 直链 | 后端 403；前端路由守卫按权限点隐藏入口（现状机制） |
| __system__ daemon actor | role='admin' 不变，全链路零影响 |
| DELETE 不带 confirm（旧脚本/绕过前端） | 400 delete-confirm-required，删除不发生 |
| confirm 与名称不符（删错对象/名称已被并发改名） | 400 delete-confirm-mismatch，删除不发生——改名与删除的竞争天然被名称比对拦截 |
| 资源在确认框打开期间被他人删除 | 提交时行已不在 → 404，ConfirmDialog error 展示 |

## 9. 测试策略（随改动落地，缺一不可）

**shared（`packages/shared/tests/`）**
- S-1 角色快照锁：`ROLE_PERMISSIONS.manager` 正集（含 repos:write/tasks:read:all/tasks:cancel:all + user 基线逐点）与负集（`MANAGER_DENIED_PERMISSIONS` 逐点 ∉ manager、∈ admin）；`tasks:delete` ∈ admin、∉ user、∉ manager；RoleSchema 三值。
- S-2 既有 user 负集锁（ADMIN_ONLY_PERMISSIONS）不回归。

**backend（`packages/backend/tests/rfc222-manager-role.test.ts`）**
- M-1 六类资源矩阵：manager 对他人 private 行 list 可见 / 详情 200 / PUT 改 / DELETE 删 / GET+PUT acl（owner 转移、visibility、grants）——六类各至少覆盖 list+detail+write，一类全深度。
- M-2 fusion / scheduled task 他人行读写；M-3 repos:write（POST /api/repos 201）。
- M-4 记忆：repo/global 行 canManage=true 且 approve/delete 生效；distill-jobs 路由 200；WS upgrade 通过（对照组 user 403）。
- M-5 任务域：list all 全量、他人任务详情 200、cancel 他人任务、resolveTaskRole(manager 非成员)='manager'、成员时 'user'/'owner' 优先。
- M-6 拒绝面：users*/settings/daemon/oidc/backup/restore/runtimes 写族逐条 403。
- M-7 防锁死：唯一 admin →manager 被拒；manager 不计入 countOtherActiveAdmins。
- M-8 prompt 隔离：扩 rfc099-prompt-isolation——manager 快照值不进 prompt。
- M-9 WS：workflows/memories 频道 manager 收到他人 private 资源帧（adminShortCircuit 路径）。
- M-10 PAT 矩阵（P1-3/P1-4）：admin 空 scope PAT → distill-jobs 403（未列 memory:approve 时）/ DELETE task 403；显式 scope 才通；user PAT 列 admin 点不 widen；manager 窄 PAT 资源写被 resourcePermissionGate 拦。
- M-11 shared round-trip（P1-2）：review/clarify/WS 三处 schema 对 manager 快照值 parse 通过。
- **G-1 结构守卫（P2-3 升级版）**：资源域禁手写角色判定——除 shared 谓词定义处与系统域 allowlist（users/restore/runtimes/backup 域文件）外，`packages/backend/src`（**含 ws/registry.ts、auth/permissions.ts**）不得出现 `isAdminActor` 残留或 `role === 'admin'` / `'admin' || … 'manager'` 手写联合；资源域身份判定唯一入口 = shared `isResourceAdminRole` 派生族——变异实证：任一处换回/手写即红。

**backend（`packages/backend/tests/rfc222-task-delete.test.ts`）**
- D-1 admin 删终态：200；tasks 行消失；cascade 抽查（nodeRuns/node_run_events 二级链/clarifyRounds/taskCollaborators/workgroupMessages）；task_feedback 消失；**memory_distill_jobs/recovery_events/lifecycle_repair_audit 三表保留**（P1-7）；worktree/快照 ref/logs/{taskId} 消失；outbox 行已收敛删除。
- D-2 四终态各 200；四活跃态各 409。
- D-3 403 面：user/manager/任务 owner（user 角色）各 403；404 不存在；重放 404；PAT 面见 M-10。
- D-4 WS task.deleted：list 频道**冷缓存**的 owner/collaborator/manager/admin 四类连接都收到（audience context，P1-9）；per-task 频道终帧送达（P2-8）。
- D-5 清理失败注入（mock removeWorktree 抛）→ 200 `{cleanup:'pending'}`、DB 已删、outbox 行留存；GC 重试后收敛删行。
- D-6 并发/前置门：先 resume 后 delete（409）；先 delete 后 resume（CAS 失败不炸）；activeTasks 占用 → 409；存活 PID → 409；fusion internal → 409（P1-5/P1-6）。
- D-7 crash 语义：构造"事务已提交、清盘未执行"的 outbox 行 → hourly GC 扫描清干净（P1-8）。
- D-8 逻辑引用（P2-1）：删除后 scheduled_tasks.lastTaskId / memories.sourceTaskId 保留 dangling、schedule 详情接口不炸、schedule UI 已删任务降级展示。

**backend（`packages/backend/tests/rfc222-delete-confirm.test.ts`，C 线）**
- C-1 helper 单测：缺 body / confirm 非 string / 空串 / 大小写不符 / 前后带空格（服务端不 trim → mismatch）/ 精确匹配各分支。
- C-2 端点矩阵：7 端点各至少「缺 confirm 400 + 错 confirm 400（行未删）+ 对 confirm 200（行已删）」三例；workflows/plugins/tasks 断言比对的是行 name 而非 id。
- C-3 竞争：mismatch 后行仍在（删除未发生）；改名后用旧名删 → mismatch。
- **G-2 覆盖面守卫（AC-14）**：结构性断言 7 个 DELETE handler 源码均调用 `assertDeleteConfirm`（表级清单式，六 routes 文件 + tasks 路由）——变异实证：注释掉任一调用即红。

**frontend（vitest）**
- F-1 users 页角色 Select 三选项、提交 manager 值；F-2 AttributionChip manager 渲染（中英文案）；F-3 任务详情删除按钮：admin 显示、manager/user 不渲染、确认 Dialog 流程、成功后失效导航；F-4 memory distill-jobs tab：manager 可见（现 isAdmin 判定改造点）。
- F-5 ConfirmDialog confirmInput 模式：未输入/输错 → 确认按钮 disabled；输对（含两端空格 trim 后）→ enable；**提交给 onConfirm 的 typedConfirm === 输入框实际值**（锁"不许传常量"——mock onConfirm 断言收到手敲文本）；open 翻转清空。
- F-6 至少一个资源删除入口集成断言：错名提交不发请求、对名提交 DELETE body 携带输入值。

**e2e**（设计门 P2-5 证伪了"无角色穷举"假设）：至少三组 helper 手写 `'admin' | 'user'` 闭集——`e2e/rfc099-ownership-acl.spec.ts:28`、`e2e/auth-isolation.spec.ts:51`、`e2e/collab-multi-user.spec.ts:32`——helper 类型扩为三值（additive 不破坏既有用例）；新增至少一条 manager 浏览器旅程（UI 授予 manager → 越权改他人资源正例 → /users 与 /settings 拒绝负例 → 删除任务 403）。**C 线 breaking**——grep e2e 全部 DELETE 流（资源删除步骤）补 confirm 输入交互（[reference_e2e_outside_workspace_typecheck] 教训：e2e 在 workspace typecheck 外，漏改只在 CI Playwright 红）。

## 10. 实现涟漪自查清单

- 全仓 grep `'admin' | 'user'`（TS 联合字面量）逐处加 `'manager'`：useActor.ts:20、users.tsx ×5、后端零散注解。
- 全仓 grep `role === 'admin'` / `role !== 'admin'`：逐处按 §2.2 表归类（换/不动），不允许漏网。
- `useIsAdmin()`（useActor.ts:77-79）语义保持 admin-only（供 backup/restore 等系统域 UI）；新增 `useIsResourceAdmin()`；memory.tsx:84 与 memory.distill-jobs.$jobId.tsx:47 改用新 hook。
- i18n：en-US 与 zh-CN 同步加键（角色名、删除任务按钮/确认文案、confirm 输入 label/placeholder、400/409 错误提示）。
- **"admin only" 存量文案清查（设计门 P2-7）**：将开放给 manager 的路径上，用户可见文案仍写 admin——已实锤四处：taskCollab.ts:76（成员管理错误）、routes/memories.ts:62、fusion.ts:1071、前端 i18n en-US.ts:4688 / zh-CN.ts:8193（ACL/task hints）；实现时全仓 grep "admin"（error message + i18n 值）按"系统管理员/资源管理员"二分归类改写，en-US/zh-CN 键集对称测试锁定。
- docs/：若 docs 有权限矩阵文档则同步（实现时 grep 'admin' docs/）；API breaking（DELETE confirm 必填）写进发布说明。
- 既有 DELETE 测试与 e2e 删除流全量补 confirm（§7.4 会红清单）。
- 迁移面：**A/C 线零 migration；B 线一条 migration（`task_cleanup_queue`，§6.4）**；无新依赖。

## 11. 与 RFC-221 的联合落地清单（设计门 P2-6）

RFC-221（Draft v2）与本 RFC 的冲突面**不止 users.tsx 单文件**，逐项登记：

| 冲突面 | RFC-221 现设计 | 联合处置 |
| --- | --- | --- |
| users 页角色 filter | 二值 role filter（RFC-221 design.md:76） | 后落地者扩三值（含计数） |
| 角色 presentation map | 二值映射（design.md:137） | 同上（含 i18n 键与视觉基线） |
| 新建用户 ChoiceCards/Dialog | 二值结构（design.md:326） | 同上 |
| PAT 创建/scope UI | **全局删除**（design.md:254，POST 固定 403） | 与本 RFC P1-3 交互：`tasks:delete` 需显式 scope 而新 PAT 不可建 ⇒ **任务删除事实上 session-only**——两 RFC 都写明该合并语义；若 221 先落，本 RFC 的 PAT 显式化测试改断言"无可授予通道" |
| visual baseline | users/account 场景重刷 | 后落地者负责重生成（[reference_visual_baseline_stale_binary] 流程） |

落地顺序原则：**谁先批准谁先行，后落地者持有本表责任**；两 RFC 均为 Draft 期间，任何一方转入实现前在 STATE.md 声明占用 users.tsx。

## 12. 设计门修订账（Codex 第一轮，2026-07-22，needs-revision → v2 全采纳/部分采纳）

9 P1 + 8 P2；6 条"核实后不成立"确认 v1 自查（cancel 死点/12 表 cascade/last-admin/revalidation/distill 容错/无 SQL migration）。

| # | Finding | 裁决 | 落点 |
| --- | --- | --- | --- |
| P1-1 | Drizzle role enum 二值闭集漏改 | 采纳 | §1（schema.ts:1664，纯类型层） |
| P1-2 | shared 六处手抄 TaskActorRole 闭集 | 采纳 | §4（review/clarify/ws schema 复用中央 + round-trip 测试） |
| P1-3 | 空 scope PAT 静默继承 tasks:delete | 采纳（变体：不动空 scope 既有语义，PAT_EXPLICIT_ONLY 剔除高危点） | §1、M-10 |
| P1-4 | 纯身份门绕过 PAT 收窄 | 采纳（路由/频道级双门）+ 部分不采纳（row 级 bypass 保持纯身份=RFC-099 既定原则，rationale §2.3） | §2.1/§2.3、M-10 |
| P1-5 | 终态≠静默（cancel 超时残留进程/activeTasks/写锁） | 采纳 | §6.2 前置门 1-3、D-6 |
| P1-6 | fusion internal task 硬删破坏审批流 | 采纳（v1 一律拒删） | §6.2 门 4、D-6 |
| P1-7 | lifecycle_repair_audit 违反 append-only 审计合同 | 采纳（改保留） | §6.3、D-1 |
| P1-8 | GC 不兜底 worktree 孤儿 + crash gap | 采纳（重设计 cleanup outbox 先库后盘，+1 migration） | §6.4、D-5/D-7 |
| P1-9 | task.deleted 被冷缓存丢帧 | 采纳（audience context 随帧，仿 broadcaster.ts:97） | §6.5、D-4 |
| P2-1 | 三条语义任务引用漏盘 | 采纳（逻辑引用矩阵） | §6.3、D-8 |
| P2-2 | logs/{taskId} 事件归档漏删 | 采纳（清理清单 + artifact-prune 原语建议） | §6.4 |
| P2-3 | 谓词未下沉单一事实源、G-1 锁不住 | 采纳（shared isResourceAdminRole + G-1 升级全仓） | §2.1、G-1 |
| P2-4 | CLI 裸 as Role 强转任意串写库 | 采纳（RoleSchema.safeParse） | §5 |
| P2-5 | e2e 三组闭集 helper 实名 | 采纳 | §9 e2e |
| P2-6 | RFC-221 冲突面低估 | 采纳（联合清单） | §11 |
| P2-7 | "admin only" 存量文案失真 | 采纳（四处实锤 + 全仓清查） | §10 |
| P2-8 | per-task 频道无删除合同 | 采纳（终帧 + 前端导航） | §6.5、D-4 |

### §12.1 设计门二轮（2026-07-23，Claude 三镜头对抗自审接手）

二轮 Codex 复核两次发起两次 stall（resume thread 47 分钟日志冻结、fresh 精简版 30 分钟同形态，均 cancel；[reference_codex_rescue_stall_salvage] 判定，无中间产出可抢救），按 RFC-214/215 先例转 Claude 对抗自审（镜头：wire 契约 / 并发 TOCTOU / 覆盖面一致性），源码逐点核对产出 6 条修订全数落档：

| # | 发现 | 落点 |
| --- | --- | --- |
| N-1 | workflows DELETE 已有 `.strict()` DeleteWorkflowSchema（OCC）——confirm 扩进该 schema 而非另立解析；client DELETE-body 兼容性由此实证 | §7.1 |
| N-2 | confirm 比对基准统一为 load/fresh 后的行 name（mcps runExclusive fresh 定式）——改名 TOCTOU 天然 mismatch | §7.1/§7.2 |
| N-3 | workflows/plugins/tasks name 可重复——确认框带 id 短码消歧 | §7.3 |
| N-4 | 空 body 解析统一 readDeleteBody 定式（空→{}→confirm-required；畸形→invalid-json 保留；workflows 走既有 schema 流） | §7.1 |
| N-5 | 判定顺序精确化：404 → 403/builtin → confirm 400 → 业务门（refusal/OCC/状态）→ 删除 | §6.1/§7.2 |
| N-6 | mcps confirm 置于排他段内 fresh 后 | §7.2 |

一轮 5 条最硬 P1 的 v2 闭合抽验：① PAT_EXPLICIT_ONLY 对空/非空未列两情形均剔除、daemon/session 不受影响、requirePermission 层自然 403——闭合；② 双门闭合，row 级纯身份 rationale 成立（附带登记频道 upgrade 无 permission gate 的既有现状，§2.3）；③ 前置门四连闭合（重启后 activeTasks 清空由门 3 PID 探测兜住；写锁为进程内存，daemon flock 单实例前提成立）；④ outbox 同事务原子、GC 收编、D-7 crash 测试在册——闭合；⑤ audience 事务内捕获+权限点直通——闭合。
