# RFC-324 资源授权分档（只读 / 可编辑）—— design

- 研究基线：`main@d50ac65f2`（2026-08-25）
- 前置阅读：`design/RFC-294-backend-layered-target-architecture/proposal.md §1,§3`（已读，见 §1.2）

## 1. 概览

### 1.1 一句话

`resource_grants` 从"有没有"变成"有多深"：新增 `level ∈ {read, write}`；ACL kernel 把今天的
二值判据（可见 / 可治理）升为四值 `ResourceAccess ∈ {none, read, write, own}`，
所有写门按"内容写"与"治理写"分流；任务成员制补第三档 `observer`；定时任务接入同一张 grants 表。

### 1.2 目标架构落位（RFC-294 强制对齐）

- RFC-294 `proposal.md:160` 把 `resource-catalog` 定义为「agent/skill/MCP/plugin/workflow/workgroup
  六个聚合子模块；**共享 ACL/ref/revision/catalog kernel**」，`:175-178` 进一步明确"ACL catalog 已扩为
  13 类……仍由各自业务 owner 写，不能因为复用 ACL 行就转归 resource-catalog"。本 RFC 完全落在这条
  裁决内：**判据进共享 kernel，写命令留在各资源 owner**。
- 任务成员判据属 `collaboration`（`:161`「human gate、授权」），定时任务授权属 `integration`（`:163`）。
  本 RFC 不把这两者的判据搬进 ACL kernel，只让它们**复用同一张 grants 表与同一个档位值对象**。
- **本 RFC 承担的演进步**：把今天 `services/resourceAcl.ts`（770 行，判据 + DB IO + HTTP 端点服务混在
  一个文件）中的**纯判据**抽成零依赖模块 `services/resourceAccessPolicy.ts`——不 import Drizzle、
  不 import DbClient，只吃 `Actor` 与值对象。这是 G1「Domain 不依赖 Drizzle/SQLite」在 ACL kernel 上的
  第一步；`resourceAcl.ts` 保留全部现有导出面（re-export 纯函数）以免 300+ 调用点大改。
- **不建 `services/resourceAcl/` 子目录**：按 CLAUDE.md §services 目录组织轻规则（≥5 个文件且互引才
  立子目录），本次只产生 2 个文件，平铺即可。
- **留下的债（明示）**：13 类资源的写命令仍散在 `routes/*.ts` 与 `services/*.ts` 横向层，本 RFC 只改
  它们调用的门，不做模块搬迁；`scheduled_task` 的授权判据落在 `services/scheduledTasks.ts` 内，
  待 `integration` 模块化时随之迁移。

## 2. 数据模型与迁移

### 2.1 迁移 `0209_rfc324_grant_levels.sql`（落地时按当时的下一个序号）

```sql
-- 1) 授权档位。存量行全部落 'read'（= 今天的语义，零行为变化）。
ALTER TABLE `resource_grants` ADD COLUMN `level` text DEFAULT 'read' NOT NULL CHECK (`level` IN ('read', 'write'));

-- 2) 定时任务接入 ACL OCC 围栏（与 13 类资源的 acl_revision 同形）。
ALTER TABLE `scheduled_tasks` ADD COLUMN `acl_revision` integer DEFAULT 0 NOT NULL;
```

`level` **带 CHECK，而 `resource_type` 不带**，两者不是同一个判断：后者每加一类 ACL 资源
就要动一次值域，CHECK 会把每次新增变成一次建表重写（`schema.ts:505-509` 记着这个理由）；
前者是刻意封闭的两值域——本 RFC 选了两档而不是三档——第三个值只可能是 raw SQL 写错。

**没有第三条 DDL**，两处值域扩展都是零 DDL：

- `resource_grants.resource_type` 与 `task_collaborators.role` 在 SQL 里都是**没有 CHECK 的 plain
  text**（`packages/backend/src/db/schema.ts:505-509` 注释明写「this column is plain `text` in SQL with
  no CHECK, so the closed set lives in the type system only」；`:2825-2827` 同形）。因此
  `resource_type` 新增 `'scheduled_task'`、`role` 新增 `'observer'` 只需改 Drizzle 与 zod 的枚举。
- `scheduled_tasks` **不加 `visibility` 列**：D12 已定 public 不分档，而定时任务本就没有 public 语义
  （未授权者 404）。

### 2.2 存量语义等价（D11）

| 表                        | 存量回填                                  | 等价性                                                                 |
| ------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| `resource_grants.level`   | `'read'`                                  | 今天 grant = 可见可用不可改 ⇒ 迁移后判定逐条不变                       |
| `task_collaborators.role` | 不动（存量只有 `owner` / `collaborator`） | 今天 collaborator = 同权 ⇒ 迁移后不变；`observer` 只能由新 UI 显式选出 |

## 3. 判据内核

### 3.1 新值对象（`packages/shared/src/schemas/resourceAcl.ts`）

```ts
export const ResourceGrantLevelSchema = z.enum(['read', 'write'])
export type ResourceGrantLevel = z.infer<typeof ResourceGrantLevelSchema>

/** 四值访问级别，own > write > read > none。 */
export const ResourceAccessSchema = z.enum(['none', 'read', 'write', 'own'])
export type ResourceAccess = z.infer<typeof ResourceAccessSchema>
```

### 3.2 唯一判据函数（`packages/backend/src/services/resourceAccessPolicy.ts`，纯函数）

```ts
export function resolveResourceAccess(
  actor: Actor,
  row: AclRow,
  grant: ResourceGrantLevel | null,
): ResourceAccess {
  if (hasResourceAclBypass(actor)) return 'own'
  const isPublic = (row.visibility ?? 'public') === 'public'
  const privateOk = hasPrivateResourceAccess(actor)
  const ownerMatch = row.ownerUserId != null && row.ownerUserId === actor.user.id
  // public 行的 owner 不需要 account-range private 点（保持 isResourceOwner 现行分支）。
  if (ownerMatch && (isPublic || privateOk)) return 'own'
  if (!privateOk) return isPublic ? 'read' : 'none'
  if (grant === 'write') return 'write'
  if (grant === 'read') return 'read'
  return isPublic ? 'read' : 'none'
}

export const canViewAccess = (a: ResourceAccess): boolean => a !== 'none'
export const canEditAccess = (a: ResourceAccess): boolean => a === 'write' || a === 'own'
export const canGovernAccess = (a: ResourceAccess): boolean => a === 'own'
```

### 3.3 与现状的逐分支等价性（必须有测试锁，见 §13 T-EQ）

| 现状函数（`services/resourceAcl.ts`）    | 现状表达式                                          | 新表达式（grant 全为 `read` 时）   | 等价 |
| ---------------------------------------- | --------------------------------------------------- | ---------------------------------- | ---- |
| `isVisibleRow` `:296-302`                | `bypass ∨ public ∨ (privateOk ∧ (owner ∨ granted))` | `canViewAccess(resolve(...))`      | ✅   |
| `canViewResource` `:410-425`             | 同上（单行查询版）                                  | 同上                               | ✅   |
| `isResourceOwner` `:475-479`             | `bypass ∨ ((public ∨ privateOk) ∧ owner)`           | `canGovernAccess(resolve(...))`    | ✅   |
| `isVisibleToAudienceSnapshot` `:284-295` | 快照版可见性                                        | 快照版 `resolve` + `canViewAccess` | ✅   |
| `visibleRowsCondition` `:322-338`（SQL） | `public ∪ owned ∪ granted`                          | **不变**（只答可见性，与档位无关） | ✅   |

**唯一新增语义**：`grant === 'write'` 时 `resolve` 返回 `'write'`，`canEditAccess` 为真。
其余分支与今天逐字一致——这是"迁移后零行为变化"的机器可验证形式。

### 3.4 IO 层改造（`services/resourceAcl.ts`）

| 现有导出                                                              | 变化                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `listGrantedResourceIds` / `...InTx`                                  | **签名不变**（仍返 `Set<string>`）。设计初稿要把它升成 Map，实现时否掉了：它的调用点全是列表可见性过滤，只问"有没有"，升级会让每个调用背一个用不到的维度。需要深度的场景改用下面两个新函数 |
| `canViewResource` / `canViewResourceInTx`                             | 内部改走 `resolveResourceAccess`（行为不变）                                                                                                                                               |
| `isResourceOwner`                                                     | **改名 `canGovernResource`**（语义本就是"owner 或 bypass"，旧名误导），全仓替换，不留别名（CLAUDE.md：删除优于 deprecate）                                                                 |
| `requireResourceOwner`                                                | **改名 `requireResourceGovern`**；403 码由 `forbidden` 改为 `resource-govern-owner-only`                                                                                                   |
| **新增** `canEditResource` / `canEditResourceInTx`                    | `canEditAccess(resolveResourceAccess(...))`                                                                                                                                                |
| **新增** `requireResourceEdit`                                        | 先 `requireResourceView`（404 同形），再 `canEditAccess` 否则 403 `resource-read-only`                                                                                                     |
| **新增** `resolveResourceAccessFor(db, actor, type, row)` / `...InTx` | 一次查询取本行 grant 档位 → `ResourceAccess`（写门、`GET /acl` 的 `canEdit` 都从它派生）                                                                                                   |
| **新增** `loadGrantLevel(db, type, resourceId, userId)` / `...InTx`   | 单行档位查询。列表面只问"有没有"，继续走 `listGrantedResourceIds`（Set）；**实现期决定**：不把它升成 Map，否则每个列表调用都要背一个用不到的档位维度                                       |
| **新增** `listWritableGrantedResourceIds` + `canEditRow`（policy）    | 批量写判据。技能 ZIP 的覆盖候选在同步 `map/filter` 里决定，无法逐行 await——预取 `write` 档 id 集合一次，配 `canEditRow` 使用（与 `isVisibleRow` 对称）                                     |
| **新增** `listResourceGrants` / `listResourceGrantsInTx`              | 带档位的授权名单（面板读取与全量替换写入）                                                                                                                                                 |
| `getResourceAcl`                                                      | 响应 `users` → `grants: [{user, level}]`；新增 `canEdit`                                                                                                                                   |
| `updateResourceAcl`                                                   | body `userIds` → `grants: [{userId, level}]`；写入带 `level`；owner 转移时前任 owner 落 `read`（AC-5）                                                                                     |

**`filterVisibleRows` 不变**（只答可见性）。列表接口不因档位改变返回集合。

## 4. 动作分类表（13 类资源）

判据只有两种：**内容写 → `requireResourceEdit`**、**治理写 → `requireResourceGovern`**。
下表逐条给出现状锚点与改后归属；实现时以本表为准，不得遗留任何 `requireResourceOwner` 旧调用。

| 资源                | 路由 / 站点                                                     | 现状锚点                                                             | 改后                                                                                                                |
| ------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| agent               | `PUT /api/agents/:id`                                           | `routes/agents.ts:272`                                               | **edit** + 名字不变校验（§5）                                                                                       |
| agent               | `DELETE /api/agents/:id`                                        | `routes/agents.ts:301`                                               | govern                                                                                                              |
| agent               | `POST /api/agents/:id/rename`                                   | `routes/agents.ts:429`                                               | govern                                                                                                              |
| skill               | `DELETE /api/skills/:id`                                        | `routes/skills.ts:229`                                               | govern                                                                                                              |
| skill               | `POST /api/skills/:id/save`                                     | `routes/skills.ts:302`                                               | **edit** + 名字不变校验                                                                                             |
| skill               | `PUT /api/skills/:id/file`                                      | `routes/skills.ts:372`                                               | **edit**                                                                                                            |
| skill               | `DELETE /api/skills/:id/file`                                   | `routes/skills.ts:406`                                               | **edit**                                                                                                            |
| skill               | `POST /api/skills/:id/versions/:v/restore`                      | `routes/skills.ts:494`                                               | **edit**                                                                                                            |
| skill               | `PUT /api/skills/:id`、`PUT /api/skills/:id/content`            | `routes/skills.ts:208-214,268-274`                                   | 已 410 Gone，只做可见性，**不动**                                                                                   |
| mcp                 | `PUT /api/mcps/:id`                                             | `routes/mcps.ts:381`                                                 | **edit** + 名字不变校验（含 `config` 的 command/args/env，D7）                                                      |
| mcp                 | `DELETE /api/mcps/:id`                                          | `routes/mcps.ts:417`                                                 | govern                                                                                                              |
| mcp                 | `POST /api/mcps/:id/rename`                                     | `routes/mcps.ts:455`                                                 | govern                                                                                                              |
| plugin              | `loadFreshOwned` helper（PUT / DELETE / rename / upgrade 共用） | `routes/plugins.ts:51-58`                                            | **拆成两个 helper**：`loadFreshEditable`（PUT / upgrade / check-update）与 `loadFreshGovernable`（DELETE / rename） |
| workflow            | `PUT /api/workflows/:id`                                        | `services/workflow.ts:1008-1026`（preflight）、`:1029-1051`（in-tx） | **edit** + 名字不变校验（`assertChangedWorkflowName` `:1053-1060` 之前拒）                                          |
| workflow            | `DELETE /api/workflows/:id`                                     | `routes/workflows.ts:246`                                            | govern                                                                                                              |
| workflow            | `POST /api/workflows/:id/copy`                                  | `services/workflow.ts:258-272`                                       | 仍只要 view（D14）                                                                                                  |
| workgroup           | `PUT /api/workgroups/:id`                                       | `routes/workgroups.ts:195`、`services/workgroups.ts:857`             | **edit** + 名字不变校验                                                                                             |
| workgroup           | `DELETE /api/workgroups/:id`                                    | `routes/workgroups.ts:215`                                           | govern                                                                                                              |
| workgroup           | `POST /api/workgroups/:id/rename`                               | `routes/workgroups.ts:250`                                           | govern                                                                                                              |
| capability_template | `PUT /api/capability-templates/:id`                             | `routes/capabilityTemplates.ts:160`                                  | **edit** + 名字不变校验（`scripts`/`hooks` 字段仍受 `scripts:author`，D15）                                         |
| capability_template | `DELETE /api/capability-templates/:id`                          | `routes/capabilityTemplates.ts:204`                                  | govern                                                                                                              |
| capability_template | `POST /api/capability-templates/:id/upstream/merge`             | `routes/capabilityTemplates.ts:244`                                  | **edit**                                                                                                            |
| 五类研发配置资源    | 统一 helper                                                     | `routes/developmentConfig.ts:267-284`                                | helper 拆 edit / govern 两版；PUT→edit（+名字）、DELETE→govern                                                      |
| employee_definition | `requireOwnedEmployee` helper                                   | `routes/digitalEmployees.ts:100-107`                                 | 拆 edit / govern 两版；内容写与 **publish（D8）**→edit、删除→govern                                                 |
| 全部 13 类          | `PUT /api/{res}/:id/acl`                                        | `routes/resourceAcl.ts:159-201` → `updateResourceAcl`                | **govern**（授权面永远只有 owner，D3）                                                                              |

**事务内的第二道门必须同档改造（实现期发现）**：路由层分档只是第一层。`services/agent.ts`
的 `requireAgentMutationRevision` 是 update / delete / rename 三个调用方共用的 in-tx 复检，
改造前它固定判 owner——只改路由层会让 `write` 档在 HTTP 门放行后被事务内的旧门拦下，
症状是"授权了却仍然 403"。它因此取得一个**必填**的 `need: 'edit' | 'govern'` 参数
（给默认值等于给下一个调用方一个不必表态的选项，而这里最不该猜）。同型的
`assertPrincipalCanWriteInTx`（workflow / workgroup）在本 RFC 中各自一分为二。

**旁路写点（不在 HTTP 路由上，同样必须改）**：

| 站点                             | 现状                                       | 改后                                                                                      |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `services/skill-zip.ts:427`      | 导入覆盖候选筛选 `isResourceOwner`         | `canEditResource`（可编辑者可覆盖导入到该技能）                                           |
| `services/skill-zip.ts:547`      | 覆盖前二次校验                             | 同上                                                                                      |
| `services/fusion.ts:567,1228`    | 记忆→技能融合写 skill 前 `isResourceOwner` | `canEditResource`                                                                         |
| `services/memory.ts:816`         | `canManageMemory` 的 scope 写权            | `canEditResource`（D9，§8）                                                               |
| `services/systemResources.ts:75` | builtin 只读断言的注释                     | 文案随改名更新；`assertNotBuiltin` 行为不变（builtin 永远不可写，**优先级高于任何档位**） |

## 5. 名字不变校验（D3）

改名是治理动作，但 agent / skill / mcp / workflow / workgroup / capability_template / 五类研发配置
资源的名字同时躺在**内容写 body 里**。因此内容写门后追加一条纯函数校验：

```ts
export function assertNameUnchangedForEditor(
  access: ResourceAccess,
  currentName: string,
  submittedName: string | undefined,
): void {
  if (access === 'own') return
  if (submittedName === undefined || submittedName === currentName) return
  throw new ForbiddenError(
    'resource-rename-owner-only',
    'only the resource owner can rename it; the edit grant covers content only',
  )
}
```

- 校验在**写事务内**、对 in-tx 读到的 `cur.name` 做，不用请求开始时的快照——否则并发改名会漏判。
- `OWNER_NAME_UNIQUE_TYPES`（`services/resourceAcl.ts:157-176`）的 owner×name 唯一索引因此不受影响：
  可编辑者根本改不了 name，不会去占 owner 的名字域。

## 6. 任务侧（D5）

### 6.1 值域与判据

- `TaskCollaboratorRoleSchema`（`packages/shared/src/schemas/taskCollab.ts:8`）扩为
  `['owner', 'collaborator', 'observer']`。
- `task_collaborators` 主键是 `(task_id, user_id, role)`（`db/schema.ts:2832`），理论上允许同一用户两行。
  写入路径**全量替换**且写前 dedupe（同一 user 只保留一行，取更高档），读取路径若仍读到多行取更高档
  （fail-safe 收敛，不抛错）。
- `taskCollab.ts` 判据一分为二：

| 函数                                          | 现状                                       | 改后                                                                                              |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `canViewTask` `:33-41`                        | `tasks:read:all` ∨ owner ∨ `hasMembership` | **不变**（observer 天然可见）                                                                     |
| `hasMembership` `:71-80`                      | 任意 collaborator 行                       | 保留，用于可见性                                                                                  |
| **新增** `hasActingMembership`                | —                                          | 仅 `role ∈ {owner, collaborator}`                                                                 |
| `requireTaskMember` `:98-110`                 | `hasMembership`                            | 改走 `hasActingMembership`（observer → 403 `not-task-member`）                                    |
| **新增** `requireTaskOperator`                | —                                          | 与 `requireTaskMember` 同判据，用于操作面（分开命名是为了让"回答权"与"操作权"在代码里可分别演进） |
| `resolveTaskRole`（`resourceAcl.ts:508-517`） | owner / user / admin / manager             | **不变**——observer 产生不了任何写动作，不需要归属快照值                                           |

### 6.2 受影响的路由

| 路由                                                                                                                                                        | 现状门                                                                                                                                                                              | observer                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /api/tasks/:id`、`/node-runs`、`/diff`、`/structural-diff`、`/change-narrative`、`/file-content`、`/alerts`、`/recovery-events` 等全部 `tasks:read` 面 | `canViewTask`                                                                                                                                                                       | ✅ 可见（AC-7）                     |
| `POST /api/tasks/:id/cancel`、`/resume`、`/diagnose`、`/clear-recovery-suspension`、`POST /change-narrative`                                                | `tasks:execute` + `canViewTask`（`routes/tasks.ts:400,778,736,713,523`）                                                                                                            | ❌ 追加 `requireTaskOperator` → 403 |
| 评审决定 / 反问回答 / 澄清指令 / 变更叙事触发                                                                                                               | `requireTaskMember`（`routes/reviews.ts:79`、`routes/clarify.ts:86`、`routes/taskQuestions.ts:58,121,218`、`routes/taskClarifyDirective.ts:82`、`services/changeNarrative.ts:349`） | ❌ 自动 403（判据改造后一处生效）   |
| `PUT /api/tasks/:id/members`                                                                                                                                | owner ∨ bypass（`services/taskCollab.ts:171`）                                                                                                                                      | 不变                                |

### 6.3 Wire

```ts
export const TaskMembersSchema = z.object({
  taskId: z.string().min(1),
  ownerUserId: z.string().nullable(),
  owner: UserPublicSchema.nullable(),
  members: z.array(z.object({ user: UserPublicSchema, role: TaskCollaboratorRoleSchema })), // was: users
  canManage: z.boolean(),
  canOperate: z.boolean(), // 新增：本人是否可 cancel/resume/回答
})

export const UpdateTaskMembersBodySchema = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    members: z
      .array(z.object({ userId: z.string().min(1), role: z.enum(['collaborator', 'observer']) }))
      .max(256)
      .optional(),
  })
  .refine((b) => b.ownerUserId !== undefined || b.members !== undefined)
```

`role` 在 body 里排除 `'owner'`（owner 由 `ownerUserId` 单独表达，避免两处真源）。

## 7. 定时任务侧（D6）

### 7.1 为什么不列为第 14 类 ACL 资源

`ACL_RESOURCE_TYPES` 的成员会连带进 `ACL_TABLES`、`ACL_PERMISSION_PREFIX`、`OWNER_NAME_UNIQUE_TYPES`、
`BUNDLE_RESOURCE_TYPES` / `INTENT_RESOURCE_TYPES` 的判断面，而定时任务**没有 visibility、没有 builtin、
没有 owner×name 唯一域、不进配置包、不由 Intent 创建**。强行入列会给这四个集合各留一个"例外分支"。

改为把 grants 表的类型域**放宽一格**：

```ts
export const GRANT_RESOURCE_TYPES = [...ACL_RESOURCE_TYPES, 'scheduled_task'] as const
export type GrantResourceType = (typeof GRANT_RESOURCE_TYPES)[number]
```

- `resource_grants` 的 Drizzle enum 与所有 grant 读写函数（`grantsOfUserWhere` / `grantsOfResourceWhere` /
  `listGrantedResourceIds` / `listResourceGrantUserIds`）的类型参数从 `AclResourceType` 放宽为
  `GrantResourceType`。
- **13 类的 visibility/owner 判据仍只吃 `AclResourceType`**，编译期挡住"给定时任务算 visibility"这类错误。

### 7.2 判据

```ts
// services/scheduledTasks.ts —— 定时任务没有 public，未授权即不可见。
export function resolveScheduleAccess(
  actor: Actor,
  row: { ownerUserId: string },
  grant: ResourceGrantLevel | null,
): ResourceAccess {
  if (hasResourceAclBypass(actor)) return 'own'
  if (row.ownerUserId === actor.user.id) return 'own'
  if (grant === 'write') return 'write'
  if (grant === 'read') return 'read'
  return actor.permissions.has('tasks:read:all') ? 'read' : 'none'
}
```

`tasks:read:all` 分支保留在最后，等价于今天 `canViewScheduledTask`（`services/scheduledTasks.ts:207-215`）
的全局只读，不因新增 grants 而收缩。

### 7.3 端点与动作归属

| 动作                                                              | 现状                     | 改后                                 |
| ----------------------------------------------------------------- | ------------------------ | ------------------------------------ |
| 列表 / 详情 / 执行历史                                            | owner ∨ `tasks:read:all` | + 任意档 grant                       |
| 改 cron / 启停（`PUT` 的 `scheduleSpec` / `enabled`）             | owner-only               | **edit**（403 `resource-read-only`） |
| **改绑启动目标**（`PUT` 的 `launchKind` / `launchPayload`）、改名 | owner-only               | **govern**（见下方裁决）             |
| 立即运行                                                          | owner-only               | **edit**                             |
| 删除                                                              | owner-only               | **govern**                           |

**改绑目标为什么不是内容写（实现期裁决，与既有设计门 F-9 对齐）**：定时任务到点是以
**owner 的身份**发起的（`services/scheduledTasks.ts` 的
`buildInheritedActor(db, row.ownerUserId, 'schedule')`），所以"谁能改 `launchKind` /
`launchPayload`"等于"谁能借 owner 的身份跑任意东西"。`db/schema.ts:1267-1269` 记着设计门
F-9 当初正是以此把定时任务与 ACL grants 划开。RFC-324 保留那条结论，只把**不涉及执行
身份**的那半边（节奏与启停、以及触发 owner 已选定目标的 run-now）开放给 `write` 档——
这也正是用户在裁定 D6 时逐字写下的三件事。
| **新增** `GET/PUT /api/scheduled-tasks/:id/acl` | — | 粗门 `scheduled-tasks:read` / `scheduled-tasks:update`，`tokenAccess: 'never'`（与 13 类 ACL 端点同规矩，`routes/resourceAcl.ts:159-166`）；PUT 走 govern + `acl_revision` CAS |

定时任务的 ACL 响应**不含 visibility 字段**（没有 public 概念，AC-10）。

## 8. 记忆连带（D9）

`services/memory.ts:800-817` 的 `canManageMemory` 末行 `isResourceOwner(actor, row)` 改为
`canEditResource(...)`。其余分支（repo / repo_group / global 仅 bypass 可管）逐字不变。
`canViewMemory` / `filterMemoriesByScopeVisibility` **完全不动**（读面本就跟随可见性）。

## 9. Wire 契约变更汇总（I2–I4）

```ts
// GET /api/{res}/:id/acl
ResourceAclSchema = {
  resourceType, resourceId, ownerUserId, owner, visibility,
  grants: Array<{ user: UserPublic; level: 'read' | 'write' }>,  // was: users: UserPublic[]
  canManage: boolean,   // 语义不变：能否 PUT 本 ACL（= govern）
  canEdit: boolean,     // 新增：本人能否改内容
  aclRevision: number,
}

// PUT /api/{res}/:id/acl
UpdateResourceAclBodySchema = {
  ownerUserId?: string,
  visibility?: 'private' | 'public',
  grants?: Array<{ userId: string; level: 'read' | 'write' }>,   // was: userIds?: string[]
  expectedResourceId: string,
  expectedAclRevision: number,
}
```

- `grants` 保持**全量替换**语义（与 `userIds` 一致）。
- 三处 `refine`（至少一个字段）随之改为 `ownerUserId | visibility | grants`。
- `userIds` **删除，不保留兼容**：该端点 `tokenAccess: 'never'`，PAT 调不到；本仓单二进制分发，
  前后端同版本（CLAUDE.md「删除优于 deprecate」）。

## 10. 前端设计（D10）

### 10.1 档位的单一来源：`useResourceAccess`

新增 `packages/frontend/src/hooks/useResourceAccess.ts`：

```ts
export function useResourceAccess(resourceBaseUrl: string): {
  canEdit: boolean
  canManage: boolean
  isLoading: boolean
}
```

- 复用**已有**的 `GET {base}/acl` 端点，但**用自己的 query key** `['resource-access', aclUrl,
authRevision]`。初版与 `AclPanel` 共享 `['acl', …]`（省一次请求），实现期被 e2e 否掉：
  授权变更的通知帧会送到 **owner 自己**的浏览器，共享 key 一失效就把面板正在编辑的那份
  快照打成 `fetching`，绊倒 `AclPanel` 既有的「管理会话是否仍有效」守卫（要求
  `fetchStatus === 'idle'`），后果是 owner 每次保存权限后弹窗都不关闭。**两个消费者对
  「何时失效」的需求不同，就不该共享一个缓存条目**；多出来的那次 GET 打在一个本来就有读权的页面上。
- **不改 13 个 detail DTO**：那是 13 处平行改动 + 13 处平行测试，而档位是同一件事；单点 hook 是
  RFC-294 G6「同一种机制只有一个内核」在前端侧的对应做法。
- daemon token 模式下 `AclPanel` 本就整块隐藏（D19），hook 在该模式返回 `canEdit: true`
  （单用户模式无 ACL 语义），保持现状行为。
- **判定未到达时乐观（实现期反转）**：初版让 hook 在解析完成前返回 `canEdit: false`
  （fail closed）。实测下来那是错的选择——它凭空造出一种今天不存在的故障：`/acl` 一次
  抖动就会让 **owner** 被锁在自己的资源外面，而且界面不解释为什么。失败开放则退化成
  今天的行为（UI 可交互、后端拒绝写），对只读者不比现状更糟，对 owner 严格更好。
  代价是只读者在判定到达前的极短窗口里点得动控件——对**交互式**写入这是可接受的
  （后端仍然拒绝），但对**无人值守**的写入不是，所以：
  - 交互控件读 `canEdit`；
  - 工作流编辑器那发 heal 自动保存读 `isResolved && canEdit`——`docs/audit-backlog.md:489-499`
    记的正是这一发 PUT，它必须一次都不发出。
  - 只有**真布尔**才算判定：响应缺字段 / 出错 / 尚未到达一律 `isResolved: false`，
    于是任何不是 ACL 的形状都不可能悄悄把页面锁死。

### 10.2 权限面板（`components/AclPanel.tsx`）

- 成员列表由 `UserPicker` 单列改为**逐行控件**：用户 chip + `<Segmented>` 档位（只读 / 可编辑），
  复用既有 `components/Segmented.tsx`（CLAUDE.md §Frontend UI consistency：短列表互斥选择走
  `.segmented`，禁止自写 radio 组）。
- 新加成员默认 `read`（AC-12）。
- 被授权人若是 manager/admin（`UserPublic.role` 已在 payload 里），该行追加提示
  「该用户为管理员，只读档对其无效」（US-7）。
- 对 mcp / development_adapter 这类执行面资源，选择"可编辑"时在面板内联提示 I6 的风险。

### 10.3 详情页与编辑器只读态（AC-13，兼清 `docs/audit-backlog.md:108` 与 `:489-499`）

| 页面                                                                                                                                                                                                   | 只读态做法                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `routes/agents.detail.tsx`、`skills.detail.tsx`、`mcps.detail.tsx`、`plugins.detail.tsx`、`workgroups.detail.tsx`、`code.config.detail.tsx`、`code.policies.$id.tsx`、`digital-employees.$typeRef.tsx` | 表单 primitive 传 `disabled`（`components/Form.tsx` 既有 prop）；保存 / 删除 / 改名按钮**不渲染**；顶部显示只读徽标                                                                                                                                                                        |
| `routes/workflows.edit.tsx`                                                                                                                                                                            | 画布 `nodesDraggable={false}` / `nodesConnectable={false}` / `elementsSelectable={false}`；Inspector 全字段 `disabled`；**自动保存整条禁用**（`healLoadedDefinition` 的首发写必须不发出，这是 backlog 那条 403 的直接成因）；顶栏显示「只读授权」徽标与「另存为副本」入口（D14 允许 copy） |

### 10.4 错误文案分流（AC-14）

`packages/frontend/src/i18n/{zh-CN,en-US}.ts` 新增三条错误码文案，并在
`workflows.edit.tsx:1400` 的 `isWorkflowAccessLoss` 里把 `403` 从"访问丢失"分支剥离——
403 是"看得见但改不了"，与 404 的"没了"必须分开（backlog 明确点名这一处）。

| 码                           | 中文                                            |
| ---------------------------- | ----------------------------------------------- |
| `resource-read-only`         | 你对此资源只有只读授权，可另存为副本后修改      |
| `resource-govern-owner-only` | 删除 / 改名 / 转移 / 权限设置仅资源所有者可操作 |
| `resource-rename-owner-only` | 重命名仅资源所有者可操作，可编辑授权只覆盖内容  |

## 11. 失败模式

| 场景                                                                                          | 结果                                                                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 无任何 grant 的私有资源写请求                                                                 | 404（不可见与不存在同形，D1 铁律不变）                                                       |
| 只读 grant 写内容                                                                             | 403 `resource-read-only`                                                                     |
| 可编辑 grant 删除 / 改名 / 改 ACL                                                             | 403 `resource-govern-owner-only` / `resource-rename-owner-only`                              |
| 可编辑 grant 写 `scripts` / `hooks` / adapter 可执行 / verification 程序而无 `scripts:author` | 保持既有 403（字段级门，D15）                                                                |
| builtin 资源 + 任意档位                                                                       | 保持 `assertNotBuiltin` 的既有拒绝（优先级最高）                                             |
| 写请求进行中档位被降级                                                                        | 写事务内二次判据（所有门都在 tx 内复检，沿用 `assertPrincipalCanWriteInTx` 的既有形状）→ 403 |
| 并发 ACL PUT                                                                                  | 409 `acl-revision-conflict`（`aclRevision` CAS 不变）                                        |
| 同一 user 在 `task_collaborators` 出现多行                                                    | 取更高档，不抛错（§6.1）                                                                     |

## 12. 并发与事件

- ACL 写仍是 `dbTxSync` 单事务：CAS + 引用用户 active 检查 + grant 全量替换 + `afterWriteInTx`
  （`services/resourceAcl.ts:596-745` 的既有形状不变，只是 insert 多带一列 `level`）。
- 提交后仍 `triggerRevalidation(db, 'resource-acl-changed')`。**但那条路径原本不足以支撑 AC-15**：
  RFC-212 的重扫只回答「这条连接还能不能留着」——它对**降档**（`write → read`，仍然看得见）
  什么也不做，于是被降档的人会一直停在可编辑的界面上，直到他自己刷新，而他没有任何理由刷新。
  实现期因此补了缺的那个信号：
  1. 新增控制帧 `resource-acl.changed`（`shared/schemas/ws.ts` 的 `WsControlMessageSchema`）。
     刻意**不带 resourceId**：客户端要做的只是让本地判定失效，而它同时持有的判定至多是屏幕上
     那一两个；带上 id 就要服务端算出「谁关心这一行」，那份账比它防的问题贵。
  2. `ws/connections.ts` 的重扫在 `reason === 'resource-acl-changed'` 时给每条活连接发这一帧。
     丢帧的处置比 `authority.changed` 轻——那条丢了意味着客户端拿着已撤销的权限继续渲染，
     必须关连接；这条丢了只意味着某个页面的只读态晚到一次交互，关连接（进而重连风暴）
     比问题本身更贵，所以吞掉。
  3. 前端 `useWebSocket` 收到该帧 → `invalidateQueries({ queryKey: ['resource-access'] })`。
     **刻意不碰 `['acl', …]`**，理由见 §10.1。

  锁：`rfc212-revalidation-behavior.test.ts` 的两条（发帧 / 其它 reason 不发）+
  `e2e/rfc324-graded-grants.spec.ts` 的升档与降档两个方向。

- 定时任务 ACL PUT 复用同一形状（新增的 `acl_revision` 列）。

## 13. 测试策略

**后端（`packages/backend/tests/`）**

| 文件                                                            | 锁定内容                                                                                                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rfc324-access-policy-equivalence.test.ts`                      | **T-EQ**：`resolveResourceAccess` 在 `grant='read'` 下与旧 `isVisibleRow` / `isResourceOwner` 逐分支等价（穷举 bypass × private点 × public/private × owner/非 owner × grant/无 grant = 全组合表驱动） |
| `rfc324-grant-level-matrix.test.ts`                             | 13 类 × {无授权 / read / write / owner / bypass} × {读 / 内容写 / 治理写} 的 HTTP 状态矩阵（AC-2、AC-3）                                                                                              |
| `rfc324-editor-rename-refusal.test.ts`                          | 可编辑者改名 → 403 且**内容未落盘**（AC-4）；owner 改名照常                                                                                                                                           |
| `rfc324-acl-wire-contract.test.ts`                              | `grants` 全量替换、owner 转移后前任落 `read`（AC-5）、CAS 409（AC-6）、`canEdit` 计算正确                                                                                                             |
| `rfc324-task-observer.test.ts`                                  | observer 可读全部 `tasks:read` 面；cancel/resume/diagnose/评审/反问全 403（AC-7、AC-8）                                                                                                               |
| `rfc324-scheduled-task-acl.test.ts`                             | 定时任务两档 + 未授权 404 + 删除仍 owner-only（AC-9、AC-10）                                                                                                                                          |
| `rfc324-memory-editor-grant.test.ts`                            | 可编辑者可管 agent/workflow scope 记忆；只读者不可；repo/global 分支不变（AC-11）                                                                                                                     |
| `rfc324-bypass-unchanged.test.ts`                               | bypass 持有者在全矩阵中的判定与改造前逐条一致（AC-16）                                                                                                                                                |
| 既有 `rfc099-*` / `rfc170-*` / `rfc223-*` / `scheduler-audit-*` | 保持绿；只按 wire 改动更新夹具（AC-17）                                                                                                                                                               |

**前端（`packages/frontend/tests/`）**

| 文件                                       | 锁定内容                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `rfc324-acl-panel-levels.test.tsx`         | 逐行档位控件、默认 read、管理员提示、保存 payload 形状（AC-12）                                                  |
| `rfc324-readonly-detail-pages.test.tsx`    | 只读档下表单 `disabled`、保存/删除入口不存在（`getByRole` 断言，AC-13）                                          |
| `rfc324-workflow-editor-readonly.test.tsx` | 只读档下画布三个 flag 关闭、**零自动保存请求**（对 `PUT /api/workflows` 的 fetch 断言 0 次）、另存为副本入口存在 |
| `rfc324-forbidden-copy.test.ts`            | 三个新错误码有中英文案且不落回「可能已删除」（AC-14）                                                            |

**e2e（`e2e/`）**

`rfc324-graded-grants.spec.ts`：owner 授只读 → 被授权人看得见、改不了、能复制 → 升为可编辑 →
能改能存 → 降回只读 → **不刷新页面**，界面切回只读态（AC-15）。

## 14. 偏离项与风险登记（呈用户确认）

| 编号 | 偏离 / 风险                                                                                                    | 处置                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X1   | `scheduled_task` 复用 `resource_grants` 但不进 `ACL_RESOURCE_TYPES`，于是 grants 表的类型域比 ACL 资源域宽一格 | §7.1 已论证；用两个类型（`GrantResourceType` ⊃ `AclResourceType`）让编译器守住边界                                                                                                                                                                                                                                                                                                                                                       |
| X2   | 详情页档位靠额外一次 `GET /acl`，而非各 detail DTO 自带 `canEdit`                                              | §10.1 已论证（单点 > 13 处平行改动）；系统规模小、列表本就全表加载                                                                                                                                                                                                                                                                                                                                                                       |
| X3   | `isResourceOwner` → `canGovernResource`、`requireResourceOwner` → `requireResourceGovern` 是全仓改名           | 一次性完成，不留别名；改名本身由类型系统保证无遗漏                                                                                                                                                                                                                                                                                                                                                                                       |
| X4   | 可编辑者能改 MCP `config`（等价换命令）与技能可执行文件                                                        | 用户 D7 明确裁定；面板给风险提示（I6），`scripts:author` 字段门不变                                                                                                                                                                                                                                                                                                                                                                      |
| X5   | 任务 `task_collaborators` 主键含 `role`，同一 user 可能多行                                                    | 写入 dedupe + 读取取高档（§6.1），不改主键（改主键要迁数据且无收益）                                                                                                                                                                                                                                                                                                                                                                     |
| X6   | 本 RFC 不搬模块目录，只改门                                                                                    | RFC-294 演进步已在 §1.2 明示：本次只承担 ACL kernel 的纯函数抽离，其余债留给各资源模块化波次                                                                                                                                                                                                                                                                                                                                             |
| X7   | 定时任务的 `write` 档**不含**改绑启动目标与改名                                                                | §7.3 已论证（执行身份提权面，对齐既有设计门 F-9）。用户 D6 裁定的三件事（cron / 启停 / 立即运行）全部落在 `write` 档内                                                                                                                                                                                                                                                                                                                   |
| X8   | 前端判定未到达时**乐观**而非 fail-closed                                                                       | §10.1 已论证；无人值守写入（heal 自动保存）仍严格要求 `isResolved`                                                                                                                                                                                                                                                                                                                                                                       |
| X10  | 权限面板入口挂**方法级权限点**，不挂行级档位                                                                   | 实现期由 `rfc099-ownership-acl` 的 e2e 抓出：第一版把 ACL 入口一起挂在收紧后的 `canUpdate` 上，于是被授权者再也看不到权限面板——而那正是他确认「我是被谁、以什么档位授权的」的唯一地方。面板对只读者本就是只读视图（内部按 `canManage` 决定），入口因此维持改造前的条件                                                                                                                                                                   |
| X9   | `digital-employees.$typeRef` 类型页未接只读态                                                                  | 该页面对应的是**员工类型**（含多个员工定义），不是单一 ACL 行，`useResourceAccess` 的"一页一资源"形状套不上。后端写门已按档位生效；该页的逐卡只读态留给数字员工侧的下一个 RFC，登记在此不遗忘（**RFC-330 已关闭，2026-08-26**：列表项带 `access`，三类卡片按档位收敛、每卡挂 `AclDialogButton`）                                                                                                                                         |
| X11  | 「只读档对管理员无效」的提示按**账号角色**判断，而非按 `resource-acl:bypass` 权限点                            | 面板拿到的 `grants[].user` 是 `UserPublic`，只带 role、不带权限点。局限是真的：若有人把 manager 预设改成不含 bypass，这句提示会多提醒一次。取舍是「宁可多提醒」——漏提醒的代价是 owner 以为自己锁住了一个锁不住的人。根治方向是后端逐 grantee 回一个 `grants[].bypasses` 标记，未做，登记在此。该读法是纯渲染、不闸任何动作，已按 RFC-305 的规矩登记进 `rfc305-architecture-lock` 的两张清单（presentation 允许表 + account-role 读者表） |
