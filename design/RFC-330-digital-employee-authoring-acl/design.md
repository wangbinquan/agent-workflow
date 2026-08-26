# RFC-330 数字员工域授权面补齐 —— design（v7，功能核心版）

> 产品视角见 [proposal.md](./proposal.md)，任务分解见 [plan.md](./plan.md)。全部锚点基于 `main@da777913a` 的已提交 blob。v7 按用户 D21～D23 重切：只保留功能，判据只在路由层。

## 1. 概览

### 1.1 一句话

把 `employee_tool_registrations` / `employee_job_templates` 接进既有 ACL kernel（第 14 / 15 类），给案例补一张成员表（含 owner 转移）使其与编排任务同形，把三类卡片与
案例页的档位投到前端——**不新造任何判据**，全部复用 `resolveAccessFrom`（`services/resourceAccessPolicy.ts:89-104`）、`requireResourceEdit / requireResourceGovern` /
`filterVisibleRows`（`services/resourceAcl.ts`）与任务成员制的角色语义（`services/taskCollab.ts:39-48,164-174,333-367`）。

### 1.2 目标架构落位（RFC-294 强制对齐）

- **bounded context**：`digital-employee`（RFC-294 `proposal.md:163`）。工具、模版、员工定义、案例、**案例成员**五张表都归它（R5，
  `design/RFC-317-commons-boundary-hardening/design.md:195`）。
- **判据内核**仍是 `resource-catalog` 的共享 ACL kernel（`:167`；`:192-196`）。本 RFC 扩为 15 类；判据**只在路由层做一次**（`routes/digitalEmployees.ts` 的 transport helper，
  与今天 `loadVisibleEmployee` / `requireEditableEmployee`（`:79-122`）同形），模块层不引入 admission 端口、不 import kernel（D21）。
- **案例成员表归 DE 而非 `collaboration`**（`:168`）：成员是案例聚合的一部分；角色语义与 wire 的资源中立基础原样复用任务侧（§6）。
- **本 RFC 承担的演进步**：① kernel 新增列表级 `projectVisibleRowsWithAccess`；② kernel 的 owner-name 唯一表长出**分区列**声明（D17′）；③ 任务成员面板抽出薄适配器，案例复用。
- **留下的债（明示）**：13 类与 DE 域的写命令判据仍在路由层单门；案例派生的内部任务仍以 `SYSTEM_USER_ID` 启动、不进列表（`server.ts:598-601`、
  `digitalEmployeeExecution.ts:463,485`）；成员案例不进统一列表 mine / shared（D22）；§12 债务表登记 v2～v6 退出项。

## 2. 数据模型与迁移

### 2.1 迁移 `0211_rfc330_employee_authoring_acl.sql`（0210 已随 RFC-328 提交；序号以落地时为准）

```sql
-- RFC-330 (1/3): employee tools / job templates become ACL resources.
-- Existing rows backfill to 'public' so every reader keeps exactly the rows it
-- sees today (D12); new rows are created 'private' by the application
-- (initialPrivateResourceAcl) — same shape as 0045_rfc099_ownership_acl.sql:28-34.
ALTER TABLE `employee_tool_registrations` ADD COLUMN `name` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `employee_tool_registrations`
   SET `name` = CASE
     WHEN json_valid(`draft_json`) THEN COALESCE(json_extract(`draft_json`, '$.content.displayName'), '')
     ELSE '' END;--> statement-breakpoint
ALTER TABLE `employee_tool_registrations` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_tool_registrations` ADD COLUMN `acl_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_job_templates` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `employee_job_templates` ADD COLUMN `acl_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- RFC-330 (2/3): D17' —— the type-revision name partition gains an owner layer.
-- Today's index already forbids duplicates inside (type, revision, name), so
-- adding the owner column only LOOSENS the constraint: no row can collide.
DROP INDEX IF EXISTS `employee_job_templates_type_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `employee_job_templates_owner_type_name_unique`
  ON `employee_job_templates` (COALESCE(`owner_user_id`, ''), `type_id`, `type_revision`, `name`);--> statement-breakpoint
-- RFC-330 (3/3): D19/D20 —— employee case members (observer / collaborator). The
-- owner stays on employee_cases.owner_user_id and is never a member row.
-- user_id is RESTRICT like task_collaborators (schema.ts:3216).
CREATE TABLE `employee_case_members` (
  `case_id` text NOT NULL REFERENCES `employee_cases`(`id`) ON DELETE CASCADE,
  `user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE RESTRICT,
  `role` text NOT NULL CHECK (`role` IN ('collaborator', 'observer')),
  `added_by` text NOT NULL,
  `added_at` integer NOT NULL,
  PRIMARY KEY (`case_id`, `user_id`)
);--> statement-breakpoint
CREATE INDEX `idx_employee_case_members_user` ON `employee_case_members` (`user_id`, `case_id`);
```

- `draft_json` 的形状是 `{content, validationReceipt}`（`sqliteAuthoringStore.ts:288-306` 写入）；旧索引名来自 `0192_rfc310_digital_employee_os_authoring.sql:63`。
- drizzle schema（`db/schema.ts:5342-5364`, `:5388-5409`）同步补列与索引（`uniqueIndex(...).on(sql\`COALESCE(${t.ownerUserId}, '')\`, t.typeId, t.typeRevision, t.name)`与`:5464-5467` 同写法）；`employeeCaseMembers`紧挨`employeeCases`（`:5876`），`user_id` `onDelete: 'restrict'`（`:3216` 同）。

### 2.2 存量语义等价（D12）

迁移前后：**读判定不变**；**写判定收缩**（proposal §6 I1–I3）；**模版名字与唯一性逐行不变**。`rfc330-migration-backfill.test.ts`：三类 `draft_json` fixture（合法 / 缺 `displayName` /
`'not-json'`）迁移完成且后两类 `name=''`；迁移后「异 owner、同分区、同名」可插入，「同 owner、同分区、同名」UNIQUE 失败。

### 2.3 记录与 DTO

- `ToolDraftRecord`（`application/ports/authoringStore.ts:34-49`）+= `name` / `visibility` / `aclRevision`；`JobTemplateRecord`（`:79-89`）+= `visibility` / `aclRevision`。
  `toTool` / `toJobTemplate`（`sqliteAuthoringStore.ts:112-127`, `:142-155`）与 `createTool` / `createJobTemplate`（`:288-306`, `:411-435`）随之带列；`updateToolValidation`（`:308-322`）
  在 owner 改显示名时同步写 `name`。
- 平台工具（`#platformTools.list`，`authoringService.ts:1724-1733`）没有 DB 行：投影固定 `visibility: 'public'`、`aclRevision: 0`、`builtin: true`（D9）。
- 视图：`ToolRegistrationView`（`composition.ts:92-105`）、`JobTemplateView`（`:111-119`）、`EmployeeDefinitionView`（`:121-135`）各 += `visibility` 与 `ownerUserId`。
  **`access` 不由模块算**——transport 装饰（§3.4）。

## 3. 判据内核接线

### 3.1 登记点

**A. 编译穷尽点**

| 登记点                                                                      | 改动                                                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/shared/src/schemas/resourceAcl.ts:23-53` `ACL_RESOURCE_TYPES`     | += `employee_tool` / `employee_job_template`；`GRANT_RESOURCE_TYPES`（`:149`）自动跟随               |
| `packages/backend/src/db/schema.ts:502-538` `resource_grants.resource_type` | += 两项                                                                                              |
| `services/resourceAcl.ts:158-176` `ACL_TABLES`                              | += 两表                                                                                              |
| `services/resourceAcl.ts:179-197` owner-name 唯一表（§3.5 改形）            | += `employee_job_template`（分区 `typeId, typeRevision`）**与 `employee_definition`**（D-①，分区空） |
| `routes/resourceAcl.ts:96-129` `ACL_PERMISSION_PREFIX`                      | += 两项 → `'digital-employees'`（D5）                                                                |
| `packages/frontend/src/components/digital-employees/types.ts:235,307,343`   | 三类型 += `visibility` / `access` / `ownerUserId`                                                    |

**B. 行为矩阵与既有守卫（CI 会红，绕不开）**

| 登记点                                                                                                  | 改动                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/rfc099-acl-endpoints-matrix.test.ts:390` CASES                                                   | += 两行                                                                                                                                                                                                                                                                                                      |
| `tests/api-contract-coverage.test.ts:215-258` 精确 `/acl` base 清单                                     | += `/api/digital-employee-tools/:id`、`/api/digital-employee-job-templates/:id`                                                                                                                                                                                                                              |
| `tests/contracts/registry.ts:906-907` 邻近                                                              | += 4 条 `/acl` + 2 条 `/members`                                                                                                                                                                                                                                                                             |
| `tests/architecture/rfc317-acl-column-enrolment-guard.test.ts:27,57`                                    | 两表加 `visibility` 后**自动**要求登记（登记即满足）                                                                                                                                                                                                                                                         |
| `tests/architecture/rfc329McpSurfaceLedger.ts` `MCP_SURFACE_EXEMPTION_LEAVES`（`:36-`）                 | 6 条新路由：`GET …/acl` ×2、`GET …/members` → `not-in-scope`（与 `GET /api/digital-employees/:id/acl` 同组，`:219`）；`PUT` ×3 → `never`（`:78` 同）；新 group `/api/digital-employee-tools` 在 `EXEMPT_REASONS`（`:408`）写理由                                                                             |
| `architecture/e2e-endpoint-coverage.json`（nightly 逐条相等，`rfc319-endpoint-coverage.test.ts:88-96`） | 6 条新路由全部由 `e2e/rfc330-*.spec.ts` 打到，未覆盖集合不增                                                                                                                                                                                                                                                 |
| `architecture/e2e-capability-ledger.json`                                                               | 新增 DE 行（工具 / 模版 ACL、卡片只读态、案例成员制 + 转移）                                                                                                                                                                                                                                                 |
| `architecture/ledger-baselines.json`                                                                    | `bun run architecture:write` 后涨的账本具名 `allowGrowth`（预期：`transaction-callbacks` +1〔`updateCaseMembers`〕、`module-symbol-owners` + 新符号、`mcp-surface-exemptions` +6、`cross-context-observed-imports` / `architecture-exceptions` +1〔runtime store 新 import `employeeCaseMembers`〕；其余 0） |
| `tests/rfc223-owner-transfer.test.ts`                                                                   | += 分区转移用例（§3.5）                                                                                                                                                                                                                                                                                      |
| `architecture/commons-manifest.json:1278-1288` `aclresourcetype-acl-resource-types`                     | `claimAudit` 计数改 15                                                                                                                                                                                                                                                                                       |

### 3.2 transport helper（`routes/digitalEmployees.ts`，与 `:79-122` 同形；**唯一判据点**）

```ts
const loadVisibleTool = async (c, toolId) => {
  const row = module.queries.getToolAccessRow(toolId)   // 平台工具 → builtin 合成行；自定义 → 窄 select
  if (row === null) throw new NotFoundError('employee-tool-not-found', …)
  if (row.builtin) return row
  const [visible] = await filterVisibleRows(deps.db, actorOf(c), 'employee_tool', [row])
  if (visible === undefined) throw new NotFoundError('employee-tool-not-found', …)
  return visible
}
const requireEditableTool   = async (c, toolId) => { const row = await loadVisibleTool(c, toolId); assertNotBuiltin('employee_tool', row) /* services/systemResources.ts:78-84 */; const access = await requireResourceEdit(deps.db, actorOf(c), 'employee_tool', row); return { row, access } }
const requireGovernableTool = async (c, toolId) => { …requireResourceGovern… }
```

模版同形（`loadVisibleJobTemplate` / `requireEditableJobTemplate`）；员工定义沿用既有 helper。名字围栏：`assertNameUnchangedForEditor(access, row.name, body.displayName ?? body.name)`
（`resourceAccessPolicy.ts:175-187`）紧跟 `requireEditable*`。

### 3.3 模块窄查询（public queries，`composition.ts:218-226` 同形）

- `getToolAccessRow(id)`：访问判定用；平台工具 → `{ id, name, ownerUserId: null, visibility: 'public', builtin: true, retiredAt: null }`。
- `getToolAclMountRow(id)`：`mountAclEndpoints.load` 用；**平台工具返回 null** ⇒ GET / PUT `/acl` 都 404（D9）。
- `getJobTemplateAccessRow` / `getJobTemplateAclMountRow`；`getCaseAccessRow(caseId)` → `{ id, ownerUserId, employeeId }`；`getCaseMemberRole(caseId, userId)`。

### 3.4 列表：可见过滤 + 档位投影一次做完（kernel 新入口）

```ts
export async function projectVisibleRowsWithAccess<T extends AclRow>(
  db,
  actor,
  type,
  rows,
): Promise<Array<T & { access: ResourceAccess }>>
```

与 `resolveResourceAccessForInTx`（`:525-541`）同一套短路；否则一次 `IN` 查询（`loadGrantLevelsForUser`，`listGrantedResourceIdsInTx` `:226-240` 的带档位版，按 500 分块），
逐行 `resolveAccessFrom`，过滤 `none`。五处调用：`:374`（平台工具不入查询、固定 `read`）、`:501`、`:575` / `:614` / `:644`。

### 3.5 kernel：owner-name 唯一表长出分区列（D17′）

```ts
/** 每类资源的分区列 —— 以快照属性名为键、drizzle 列为值；select 与 equality 共用同一描述符。 */
export const OWNER_NAME_UNIQUE_PARTITIONS = {
  agent: () => ({}),
  skill: () => ({}),
  mcp: () => ({}),
  plugin: () => ({}),
  workgroup: () => ({}),
  capability_template: () => ({}),
  action_template: () => ({}),
  verification_profile: () => ({}),
  digital_employee: () => ({}),
  automation_policy: () => ({}),
  development_adapter: () => ({}),
  employee_definition: () => ({}), // D-①
  employee_job_template: (t: typeof employeeJobTemplates) => ({
    typeId: t.typeId,
    typeRevision: t.typeRevision,
  }), // D17′
} satisfies {
  readonly [K in AclResourceType]?: (table: (typeof ACL_TABLES)[K]) => Record<string, SQLiteColumn>
}
```

- in-tx 快照 select（`:790-800`）：`{ aclRevision, name, ownerUserId, visibility, ...descriptor }`；转移预检（`:852-866`）：`...Object.entries(descriptor).map(([key, col]) => eq(col, snapshot[key]))`。
  catch（`:900-915`）不变。`ownerScopedNameWhere`（`services/ownerScopedName.ts:8-16`）保持不变（服务无分区的 11 类）。

### 3.6 自动升级 successor（D18′）

- `#persistAutomaticToolRevision`（`authoringService.ts:841-902`）与岗位迁移（`:1094-1187`）在建 successor 行时把 **source 行的 `ownerUserId` / `visibility`** 一并写入
  （`createTool` / `createJobTemplate` 入参多两列；today 的 owner 已随 `automaticUpgradeResourceId` `:182-184` 派生，visibility 是新增列）。**grants 不复制**（D22）。
- 重入沿用今天的 deterministic id（`:182-184`）与同名 + digest 匹配（`:1101-1131`）；`job-template-migration-identity-conflict`（`:1152-1160`）原样。
- **命名**（D17′ 下）：successor 与 source 同名落在不同分区；既有回退 `automaticUpgradeJobName`（`:186-193`）只在「同 owner 在目标分区已有同名且内容不等价的模版」时触发。

## 4. 动作分类表（判据全在路由层）

判据：**view**（`loadVisible*`，404 同形）、**edit** / **govern**（`requireEditable*` / `requireGovernable*`）、**create**（`initialPrivateResourceAcl(actor)`）、**operator**（案例，§6）。粗门一律不变。

| 资源 | 路由                                                         | 现状锚点                | 改后                                                                                                          |
| ---- | ------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| 工具 | `GET …/work-items/:workItemRef/tools`                        | `:374`（无过滤）        | `projectVisibleRowsWithAccess`；平台工具恒在、`access='read'`                                                 |
| 工具 | `GET …/tools/:toolId`（authoring body）                      | `:392`                  | **view**（粗门保持 `:update`，X7）                                                                            |
| 工具 | `POST …/tools`                                               | `:411`                  | `initialPrivateResourceAcl(actor)` + `name = displayName`                                                     |
| 工具 | `PUT …/tools/:toolId`                                        | `:433`                  | **edit** + 显示名围栏（§5）                                                                                   |
| 工具 | `POST …/tools/:toolId/validate`、`/publish`                  | `:457`                  | **edit**                                                                                                      |
| 工具 | `POST …/tools/:toolId/retire`                                | `:482`                  | **govern**（D8）                                                                                              |
| 工具 | `GET/PUT /api/digital-employee-tools/:id/acl`                | 新增                    | `mountAclEndpoints({ type: 'employee_tool', base: '/api/digital-employee-tools', load: getToolAclMountRow })` |
| 模版 | `GET …/job-templates`                                        | `:501`                  | `projectVisibleRowsWithAccess`                                                                                |
| 模版 | `POST …/job-templates`                                       | `:516`                  | private 默认                                                                                                  |
| 模版 | `PUT /api/digital-employee-job-templates/:id`                | `:537`                  | **edit** + 名字围栏                                                                                           |
| 模版 | `POST /api/digital-employee-job-templates/:id/publish`       | `:556`                  | **edit**                                                                                                      |
| 模版 | `GET/PUT /api/digital-employee-job-templates/:id/acl`        | 新增                    | `mountAclEndpoints({ type: 'employee_job_template', … load: getJobTemplateAclMountRow })`                     |
| 员工 | 三个列表                                                     | `:575`, `:614`, `:644`  | `projectVisibleRowsWithAccess`（附 `access` / `ownerUserId`）                                                 |
| 员工 | `POST …/employees`、`PUT /api/digital-employees/:id`、`/acl` | `:593`, `:673`, `:702`  | 不变（既有 helper）                                                                                           |
| 案例 | `POST /api/digital-employees/:id/cases`                      | `:227`                  | 不变（D22；权限点级）                                                                                         |
| 案例 | `GET /api/employee-cases/:id`                                | `:215`                  | **view**（§6.2）                                                                                              |
| 案例 | `POST …/:id/resume`、`/terminate`、`/policy-upgrade-preview` | `:288`, `:303`, `:246`  | **operator**                                                                                                  |
| 案例 | `POST /api/employee-cases/policy-upgrade-apply`              | `:269`                  | 共用解码器取 `caseId`（§6.5）→ operator                                                                       |
| 案例 | `GET/PUT /api/employee-cases/:id/members`                    | 新增                    | GET（`digital-employees:read`）：view；PUT（`tasks:update`，含 `ownerUserId` 转移）：owner / bypass           |
| 案例 | `GET /api/digital-employees/outcome-summaries`、列表         | `:626`、`listCasesPage` | 不变（D22）                                                                                                   |
| 案例 | `POST /api/employee-cases/worker/run-one`                    | `:322`                  | 不变（内部 worker，`tokenAccess: 'never'`）                                                                   |

## 5. 名字不变校验（RFC-324 D3 同则；路由层一次）

| 资源        | 「名字」                                                       | 校验点                                                                                                                               |
| ----------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 工具        | `name` 列 ⇔ `content.displayName`                              | `PUT …/tools/:toolId`：`body.displayName`（`createToolRegistrationBodySchema.displayName`，`domain/model.ts:942-944`）vs 当前 `name` |
| 岗位模版    | `name` 列                                                      | `PUT /api/digital-employee-job-templates/:id`：`body.name`（`authoringService.ts:66-78`）                                            |
| 员工定义    | `name` 列                                                      | 既有路由层围栏（`routes/digitalEmployees.ts:684`）不变                                                                               |
| 旧 playbook | `employeePlaybookBody.name?`（`developmentConfig.ts:564-568`） | §9 D-②                                                                                                                               |

## 6. 案例侧（D19 + D20：与编排任务同形）

### 6.1 数据

`employee_case_members`（§2.1；DE 拥有；`user_id` RESTRICT 与任务同）。owner 只在 `employee_cases.owner_user_id`（可为 NULL），不进成员行；角色 `collaborator | observer`。

### 6.2 判据（与 `canViewTask` `taskCollab.ts:39-48` / `requireTaskOperator` `:164-174` 逐分支对齐；路由层）

```
canViewCase(actor, row, role)    = bypass ∨ actor.has('tasks:read:all') ∨ row.ownerUserId === actor.id ∨ role !== null
canOperateCase(actor, row, role) = bypass ∨ row.ownerUserId === actor.id ∨ role === 'collaborator'
canManageMembers(actor, row)     = bypass ∨ row.ownerUserId === actor.id
```

`loadVisibleCase`（404 `employee-case-not-found`）/ `requireCaseOperator`（403 `employee-case-observer-read-only`）/ `requireCaseOwner`。

### 6.3 成员 wire（`GET/PUT /api/employee-cases/:id/members`；D20 含转移）

- shared `schemas/taskCollab.ts:24-40` 抽出**资源中立基础** `MembersSchema = { ownerUserId, owner, members: [{user, role}], canManage, canOperate }`；
  `TaskMembersSchema = MembersSchema.extend({ taskId })`（既有 wire 不变）、`CaseMembersSchema = MembersSchema.extend({ caseId })`；请求体共用 `UpdateMembersBodySchema = { ownerUserId?, members: [{userId, role}] }`（`:64-78` 形状原样）。
- 规则与任务侧**共用同一 normalization helper**（从 `updateTaskMembers` `taskCollab.ts:333-367` 抽出纯函数）：引用用户 active 且非 `SYSTEM_USER_ID`（422 `members-user-invalid`）、
  owner 不进成员行、**重复用户 last-wins**、单事务全量替换；**转移**：新 owner 须 active 非系统，前任（非 null、非系统、未另列）自动降为 `collaborator`（`:356-366` 同）。
- 转移后果：运行中案例的每次执行都重读案例行（`runtimeService.ts:2052`）并以当前 owner 为发布主体（`:2128-2133`），所以从下一次执行起以新 owner 身份发布；上传认领保留历史。
- 粗门：GET `digital-employees:read` / allow；PUT `development-missions:interact` / never（对齐 `routes/tasks.ts:358-379`）。
- store：`updateCaseMembers`（新，`db.transaction` 内改 owner + 全量替换成员）、`getCaseMembers`、`getCaseMemberRole`；`sqliteRuntimeStore.ts` 新 import `employeeCaseMembers`。

### 6.4 广播

新增统一列表帧 `employee-case.members.changed { caseId }`（`shared/schemas/ws.ts:231-241` 判别联合 += 一项）与 `EmployeeCaseMembersChangedAudienceContext`
（`ws/broadcaster.ts:133-149` 同形，audience = before ∪ after 的 owner + 成员），registry 的 `'task.members.changed'` 分支（`ws/registry.ts:520,671`）旁增案例帧分支。
案例页订阅列表频道（`useTasksSync`），收到帧后失效 `['employee-case', caseId]` 与**页面级**成员查询（恢复按钮门）；成员面板的编辑快照 key（`['employee-case-members', …]`）与任务侧 `TASK_QUERY_KEYS.members` 同规则，**不被任何帧失效**。

### 6.5 policy-upgrade token

抽纯函数 `decodePolicyUpgradePreviewToken(token)`（从 `applyPolicyUpgrade` `runtimeService.ts:2783-2790` 提出来），peek `caseId` 与 apply 共用，使 `policy-upgrade-apply` 能走 operator 判据。

## 7. 前端设计

### 7.1 档位来源：列表 DTO 的 `access`

`components/digital-employees/types.ts:235,307,343` 三类型 += `visibility` / `access: ResourceAccess` / `ownerUserId`（与后端 View 同步，`api.get<T>` 直接断言，与今天相同）。
判定 helper 复用 shared 的 `canEditAccess` / `canGovernAccess`（`shared/schemas/resourceAcl.ts:172-175`；若只导出 schema，T13 补两个纯函数进 shared）。

### 7.2 三类卡片（`routes/digital-employees.$typeRef.tsx`）

| 卡片     | 现状                                                                                      | 改后                                                                                                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 工具     | `canUpdate && tool.editable` 编辑（`:777`）、`canArchive && tool.editable` 退休（`:789`） | 编辑 = `canUpdate ∧ editable ∧ canEditAccess(access)`；退休 = `canArchive ∧ editable ∧ canGovernAccess(access)`；`read` 档只读徽标；编辑弹窗显示名输入对非 owner `disabled`          |
| 岗位模版 | 打开即可编辑（`openExisting`，`:2380`）                                                   | 编辑 / 发布入口 = `canUpdate ∧ canEditAccess(access)`；名字输入对非 owner `disabled`；`read` 档只读徽标，仍可「基于此创建员工」；owner 徽标（`components/ResourceBadges.tsx:22-35`） |
| 员工定义 | 编辑 / 配置职责 / 新建任务（`:4174-4189`）                                                | 编辑 / 配置职责 = `canUpdate ∧ canEditAccess(access)`；名字输入对非 owner `disabled`；**新建任务保持对 `read` 档可用**；owner 徽标                                                   |

### 7.3 权限入口

三类**自定义**卡片对**所有可见者**渲染「权限」入口（RFC-324 design X10 `:499`；`AclPanel.tsx:11-13`）；平台工具与 daemon 模式不渲染。点击开 `<Dialog>` 内嵌
`<AclPanel resourceBaseUrl invalidateKey onSaved onCancel />`（`LaneAdapterBindingDialog.tsx:606` 形态）。

### 7.4 降档不刷新（AC-13）

`hooks/useWebSocket.ts:198-203` 追加失效前缀 `['digital-employee-tools']` / `['digital-employee-job-templates']` / `['digital-employees']`。

### 7.5 案例页成员面板：任务成员面板抽出薄适配器

`TaskMembersPanel`（`components/tasks/TaskMembersPanel.tsx:94-220`；`TaskMembersDialogButton` `:53-92`）的任务耦合点：`TASK_QUERY_KEYS.members(taskId, authRevision)`（`:103`）、
`api.get(url)`（`:113`）、`activeTaskIdRef` / `responseTaskIdRef`（`:126,128`）、`api.put<TaskMembers>`（`:158`）、`invalidateQueries(['tasks'])`（`:171`）、`data.taskId` 对等检查（`:187-189`）。
文案 key 全是资源中立的 `acl.*` / `members.*`。改成只经适配器访问这些点：

```ts
export interface MembersPanelAdapter {
  readonly resourceId: string
  readonly membersUrl: string // 任务：/api/tasks/:id/members；案例：/api/employee-cases/:id/members
  queryKey(authRevision: number): readonly unknown[]
  responseId(data: MembersBase): string // 任务：data.taskId；案例：data.caseId（既有 taskId 对等检查改走这里）
  readonly invalidateKeys: readonly (readonly unknown[])[] // 任务：[['tasks']]；案例：[['employee-case', id], ['tasks']]
}
```

默认适配器 = 今天的任务行为（任务页唯一变化：面板每次打开都重取判定 `refetchOnMount: 'always'`，避免全局 5s staleTime 让刚被转移为 owner 的人看到旧的只读态）；转移会话（state `:122-123`、Dialog `:344` 起）对两者都可用（D20）。`TaskMembersDialogButton` 同样收适配器；案例页 `PageHeader`
（`employee-cases.$caseId.tsx:577-601`）actions 里放入口。恢复按钮（`:574-636` 今天唯一的操作控件）= 权限点 ∧ `members.canOperate`；terminate 无 UI 控件，门在 API。

### 7.6 文案与错误域

新增错误域 `digitalEmployee`（`i18n/errors.ts:40-57` + `DOMAIN_PREFIXES` `:57-152` 加 `['employee-']`）；`employee-case-observer-read-only` 与既有 `employee-*` 码一起落该域。
工具 / 模版复用 RFC-324 三码。空态文案（I4）。

## 8. Wire 契约变更汇总

| 面                                                                                     | 变化                                                                           | 性质             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------- |
| `GET …/tools`、`GET …/job-templates`、三个员工列表                                     | 项 += `visibility` / `access` / `ownerUserId`（必填）；私有行按可见性过滤      | additive         |
| `GET/PUT …/digital-employee-tools/:id/acl`、`…/digital-employee-job-templates/:id/acl` | 新增，wire 与其余 13 类 `/acl` 相同                                            | additive         |
| `GET/PUT /api/employee-cases/:id/members`                                              | 新增，`CaseMembersSchema` / `UpdateMembersBodySchema`（含 `ownerUserId` 转移） | additive         |
| `/ws/tasks` 列表帧                                                                     | += `employee-case.members.changed { caseId }`                                  | additive         |
| 各写路由 / 案例读与操作路由                                                            | 新增 403 / 404 / 422 分支                                                      | 收缩（已呈确认） |
| `POST …/job-templates`、`PUT …/job-templates/:id`                                      | 同名冲突从「类型版本内全局」变「类型版本内 × owner」                           | 放宽             |

## 9. 两处顺手修

- **D-①** `employee_definition` 进 §3.5 的分区表（分区空）；测试加进 `tests/rfc223-owner-transfer.test.ts`。
- **D-②** `developmentConfig.ts:635` `requireGovernable` → `requireEditable`，对 `employeePlaybookBody.name`（`:564-568`）补 `assertNameUnchangedForEditor`；
  前端 `code.config.detail.tsx:92-96` 零改动；测试扩 `tests/rfc317-config-resource-write-gate.test.ts` 三态。

## 10. 测试策略（随改动落地；文件 ↔ AC 见 plan §3）

**后端（`packages/backend/tests/`）**

| 文件                                                                        | 覆盖                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rfc330-migration-backfill.test.ts`                                         | 三类 `draft_json` 回填；分区索引放宽 / 同 owner 撞名（AC-1）                                                                                                                  |
| `rfc330-tool-template-acl-matrix.test.ts`                                   | 工具 / 模版 × {stranger, reader, writer, owner, bypass} × {GET, PUT, validate, publish, retire, acl}；平台工具 `/acl` 404（AC-2～4、6、17）                                   |
| `rfc223-owner-transfer.test.ts`（扩）                                       | 模版跨分区转移成功 / 同分区撞名 409；`employee_definition` 撞名 409（AC-5）                                                                                                   |
| `rfc099-acl-endpoints-matrix.test.ts`（扩）                                 | 两类 `/acl` 行（AC-6）                                                                                                                                                        |
| `rfc310-type-package-auto-upgrade.test.ts`（扩）                            | successor owner / visibility 继承、grants 为空；D17′ 命名：同 owner 同名才加后缀（AC-7）                                                                                      |
| `rfc330-employee-case-access.test.ts`                                       | GET / resume / terminate / preview / apply × {owner, collaborator, observer, tasks:read:all, stranger, bypass}；members PUT 规则 / last-wins / 转移 / WS audience（AC-8～11） |
| `rfc317-config-resource-write-gate.test.ts`（扩）                           | playbook 三态（AC-16）                                                                                                                                                        |
| `api-contract-coverage` / `contracts/registry` / `rfc329-mcp-surface-guard` | 新路由登记（AC-18）                                                                                                                                                           |

**前端（`packages/frontend/tests/`）**

| 文件                                      | 覆盖                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `rfc330-type-page-access-gating.test.tsx` | 三类卡片 read / write / own 控件；名字 `disabled`；平台工具无权限入口（AC-12）                  |
| `rfc330-type-page-access-gating.test.ts`  | 深链按档位分流、`AclDialogButton` 接线、`useWebSocket` 失效前缀（AC-13）                        |
| `rfc330-case-members-panel.test.tsx`      | 适配器：任务默认行为不变（既有测试零改动）、案例 GET / PUT / 转移、observer 无恢复按钮（AC-14） |
| `rfc330-forbidden-copy.test.ts`           | `employee-*` 码落 `digitalEmployee` 域（AC-15）                                                 |

**e2e（`e2e/rfc330-digital-employee-acl.spec.ts`，两个浏览器上下文）**：alice 私有工具 + 模版 → bob 看不到 → 只读授权 → bob 看得见 / 无编辑 / 只读权限视图 / 可建员工 →
升可编辑 → bob 不刷新拿到编辑入口、发布、改名被拒 → 降回只读；bob 启动案例 → 加 alice 为 observer → alice 打开案例页无恢复按钮 → 升 collaborator → 有恢复按钮 →
bob 把案例转移给 alice → alice 成为 owner、bob 降为协作者。覆盖 6 条新路由。

## 11. 失败模式与协调

- 档位判定是路由层快照；WS 帧触发前端重取。
- `acl_revision` CAS：两个新类型走 `updateResourceAcl` 同一事务（`resourceAcl.ts:790-829`）。
- 迁移幂等：`ADD COLUMN` 由 journal 保证一次；`UPDATE name` 幂等；`DROP INDEX IF EXISTS`；模版不改名。
- 平台工具：无 DB 行 ⇒ `/acl` 404、写 403 `builtin-readonly`。
- 案例转移与运行中执行：owner 每次执行重读，无缓存。
- 单个原子 PR。

## 12. 偏离项与债务登记

| 编号 | 偏离 / 债务                                                                                                                                                                                                                                                                                                                          | 理由 / 去向                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| X2   | 案例成员表归 DE（案例聚合），不归 `collaboration`                                                                                                                                                                                                                                                                                    | 角色语义与 wire 基础复用任务侧；`collaboration` 保留人工门                                                                      |
| X3   | 列表 DTO 带 `access` / `ownerUserId`，与 RFC-324「hook 优于 DTO 字段」相反                                                                                                                                                                                                                                                           | 一页三列表 N 卡；三列表同源同 transport                                                                                         |
| X6   | 模版唯一域放宽到 owner 层（I15）会让同类型版本下出现异 owner 同名模版                                                                                                                                                                                                                                                                | DTO 带 `ownerUserId`，卡片 / 选择器复用 `ResourceBadges` owner 徽标并按 id 选择                                                 |
| X7   | `GET …/tools/:toolId`（authoring body）粗门仍是 `digital-employees:update`                                                                                                                                                                                                                                                           | 保持现状，只加 view 判据                                                                                                        |
| X8   | 案例派生的内部任务仍 system-owned、不进列表                                                                                                                                                                                                                                                                                          | 成员制建在案例上                                                                                                                |
| X9   | kernel 的 owner-name 唯一表从 Set 变成带分区描述符的 Record（§3.5）                                                                                                                                                                                                                                                                  | D17′；其余 11 类分区为空，行为不变                                                                                              |
| DEBT | v2～v6 退出项（D21 / D22）：事务内 admission、写点注册表守卫、新增引用可见性、案例启动过员工可见性、案例 mine / shared scope + `outcome-summaries` 按可见聚合、任务侧 `shared` null-safe（`taskAuthorization.ts:44-47` 对 NULL owner 不为真）、successor 继承 grants、owner-only 列守卫、前端 zod 边界校验、integration port subject | 按用户裁定不做；实现时把「任务侧 `shared` null-safe」「成员案例不进列表」两条作为功能缺口记入 `docs/audit-backlog.md`，其余不记 |
