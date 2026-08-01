# RFC-247 · 技术设计：MCP 远程接入、路由元数据授权层与 API 文档界面

- 状态：Draft（2026-08-01）
- 配套：[proposal.md](./proposal.md) · [plan.md](./plan.md)

> 本文所有对既有实现的断言都带 `file:line` 锚点，且都是本轮实测读到的，不是记忆。
> 对 opencode 行为的断言取自本机 checkout（见 §2.4），遵循 CLAUDE.md「opencode 源码自取规则」。

---

## 1. 现状与边界

### 1.1 认证链路（不改）

`multiAuth`（`packages/backend/src/auth/session.ts`）挂在 `/api/*`（`server.ts:155`），按前缀
分派三轨：`aws_s_` → session、`aws_pat_` → PAT、其余 → legacy daemon token。令牌可来自
`Authorization: Bearer` 或 `?token=` 查询参数（`session.ts` 的 `extractRawToken`）。
`PUBLIC_PATH_PREFIXES`（`session.ts:41`）今天只放行 OIDC 登录三条前缀。

**本 RFC 不改这条链路**：前缀不变、分派不变、`extractRawToken` 不变。新增的收窄发生在
`multiAuth` 之后。

### 1.2 权限判定（大改）

- 目录：`packages/shared/src/schemas/permission.ts`，`PERMISSIONS` + `ROLE_PERMISSIONS` +
  `isResourceAdminRole`。
- 收窄：`auth/actor.ts:40` —— **只有 `patScopes.length > 0` 时才收窄**，空 scope 的 PAT
  静默拿到全量角色权限（`docs/audit-backlog.md:62`）。
- 显式点：`permission.ts:187` `PAT_EXPLICIT_ONLY_PERMISSIONS = ['tasks:delete']`。
- 方法映射：`auth/permissions.ts:108` —— GET/HEAD → `:read`，**其余全部 → `:write`**。
- 挂载：`server.ts:183-211` 手工挂，且只覆盖 6 类资源（`docs/audit-backlog.md:61`）。

### 1.3 资源 ACL（不改）

RFC-099 / RFC-231 的 `services/resourceAcl.ts` 是行级授权的单一事实源。本 RFC 的权限点是
**方法门**，行级判定完全不动：令牌以其属主身份行事，可见性与可写性仍由 ACL 决定。
两者是 AND 关系——**方法门通过不等于行级通过**。

### 1.4 删除确认（复用，但覆盖面小于 D4-4 的字面承诺）

`services/deleteConfirm.ts:43` `assertDeleteConfirm` 要求 DELETE 请求体 echo 资源当前名字。
设计注释明言「前端跳过对话框、或脚本省略 confirm，都要被拒」——MCP 通道天然落在「脚本」这一
侧，直接复用即可，无需新逻辑。

**但它只挂在 7 条路由上**（agents / skills / mcps / plugins / workflows / workgroups / tasks
的顶层 DELETE）。D4-4 写的是「MCP 删除工具保留 type-to-confirm」，字面上覆盖不了这 5 条也会
经 `resource_write method:delete` 暴露的删除：

| 路由 | 现状 | 本 RFC 处置 |
|---|---|---|
| `DELETE /api/skills/:id/file` | 无 confirm | **补** `assertDeleteConfirm`（echo 文件路径） |
| `DELETE /api/cached-repos/:id` | 无 confirm | **补**（echo 仓库 slug） |
| `DELETE /api/memories/:id` | 无 confirm | **补**（echo 记忆标题） |
| `DELETE /api/scheduled-tasks/:id` | 无 confirm | **补**（echo 计划名） |
| `DELETE /api/reviews/.../comments/:id` | 无 confirm | **不补**——它已按规则 ① 的例外归 `execute`，不是资源删除 |

补齐这 4 条同时惠及 Web UI（今天它们的删除没有二次确认），属正向收益而非本 RFC 的附带负担。

### 1.5 令牌存储（小改）

`user_pats` 表（`db/schema.ts:1852-1870`）：`id / userId / name / tokenHash / scopesJson /
createdAt / lastUsedAt / expiresAt / revokedAt`。本 RFC 只加一列 `purpose`。矩阵**就存在
`scopesJson`**——拆点之后矩阵本质上就是一组 Permission 点，UI 只是它的一个视图，不引入
第二套表示。

---

## 2. 权限模型

### 2.1 三类点

拆点后，权限目录里存在语义不同的三类点，必须在代码与文档里明确区分：

| 类别 | 含义 | 进令牌矩阵？ | 例子 |
|---|---|---|---|
| **动词档** | 对某类资源的某类操作 | ✅ 由用户勾选 | `agents:create` / `workflows:delete` / `tasks:execute` |
| **范围点** | 同一动词的可及范围 | ❌ 恒随角色继承 | `tasks:read:own` / `tasks:read:all` |
| **系统域点** | 平台管理能力 | ❌ **令牌恒不含** | `users:*` / `settings:*` / `oidc:*` / `backup:run` / `runtime:read` / `account:self` / `intent:*` |

**范围点**不进矩阵是因为它表达的是「这个人能看多远」，属于账户身份而非令牌授权；令牌的实际
范围 = 角色范围 ∩ ACL。这与「读恒开」用的是同一条原则。

### 2.2 令牌权限的最终公式

```
tokenPermissions =
    ( READ_POINTS                        // 读恒开：全部 :read 点 + 范围点
    ∪ matrix                             // 用户在矩阵上勾选的动词档
    )
  ∩ ROLE_PERMISSIONS[user.role]          // 永不放大角色（既有不变量）
  \ SYSTEM_DOMAIN_POINTS                 // D7：系统域恒不含
  \ ( DELETE_POINTS \ matrix )           // D4：删除档必须逐条显式勾选
```

其中 `matrix` 为空时结果就是只读——这就是 D3「空矩阵 = 只读」，同时关掉了
`docs/audit-backlog.md:62` 那个洞：`actor.ts` 的 `patScopes.length > 0` 短路被删除，
PAT 分支恒走收窄路径。

`DELETE_POINTS` 取代今天的 `PAT_EXPLICIT_ONLY_PERMISSIONS`（`permission.ts:187`）——那个
常量从「一个手工列的点」升级为「按后缀 `:delete` 派生的全集」，新增资源类型时自动纳入，
不会漏。

### 2.3 逐路由动词映射（D3 「按真实语义逐条归」的落地）

规则优先级（设计门修订版）：

**① `DELETE` 方法 → `delete` 档**，作用域限定为**矩阵域资源本身**。两条边界：
  - **系统域不适用**：`DELETE /api/oidc/providers/:id`（`oidc:configure`）、
    `DELETE /api/users/:id`（`users:write`）、`DELETE /api/runtimes/:name`（`requireAdmin()`）、
    `DELETE /api/restore/pending`（`backup:run`）、`DELETE /api/auth/pats/:id` 与
    `DELETE /api/auth/identities/:id`（`account:self`）、
    `DELETE /api/intent-sessions/:id/mounts/:handle`（`intent:write`）——共 8 条，
    它们的域**根本没有 `:delete` 点**，套用规则 ① 会凭空造出 7 个死点。
  - **「资源内交互记录」不适用**：`DELETE /api/reviews/:nodeRunId/comments/:commentId`
    归 `tasks:execute`（理由见上方粗糙面 2/2）。这是**唯一**一条业务域例外，逐条列出而非
    留一条口子。

**② 纯读 / 纯预览 / 纯校验的 `POST`** → 判据是**有没有落库副作用**：
  - 无副作用且**不消耗外部资源** → `read`（`agents/import-resolve`、`agents/closure-preview`、
    `skills/import-zip/parse`）
  - 无落库副作用但**跑了真实工作**（外部网络、子进程、模型调用）→ `execute`
    （`workflows/:id/validate`、`validate-draft`、`plugins/:id/check-update`、`mcps/:id/probe`）

  > 设计门指出初稿在这里不一致：`closure-preview` 归 read 而 `workflow validate` 归 execute，
  > 却没给判据。上面这条「是否消耗外部资源」就是判据——`closure-preview` 是纯内存图解析，
  > `validate` 会拉起校验管线。**这条判据同时保住了 `workflows:execute` 不变成死点**。

**③ 其余按语义**（见下表逐条）。

#### agents（`agents:*`）
| 路由 | 档 |
|---|---|
| `GET /api/agents`、`/:id`、`/:id/resource-status`、`/:id/closure`、`/builtins/skill-merger` | read |
| `POST /api/agents/import-resolve`、`POST /api/agents/closure-preview` | read（纯解析 / 纯预览，无副作用） |
| `POST /api/agents` | create |
| `PUT /api/agents/:id`、`POST /api/agents/:id/rename` | update |
| `DELETE /api/agents/:id` | delete |
| `POST /api/agents/:id/tasks` | **execute** |
| `GET/PUT /api/agents/:id/acl` | GET=read；**PUT 对令牌一律拒**（D5） |

#### skills（`skills:*`）
| 路由 | 档 |
|---|---|
| `GET /api/skills`、`/:id`、`/:id/content`、`/:id/files`、`/:id/file`、`/:id/versions*` | read |
| `POST /api/skills/import-zip/parse` | read（解析预览） |
| `POST /api/skills`、`POST /api/skills/import-zip/commit` | create |
| `PUT /:id`、`PUT /:id/content`、`POST /:id/save`、`PUT /:id/file`、`POST /:id/versions/:v/restore` | update |
| `DELETE /api/skills/:id`、**`DELETE /api/skills/:id/file`** | delete |

> **规则的已知粗糙面（1/2）**：删除技能里的一个附件文件与删除整个技能，落在同一个
> `skills:delete` 档上。这是 D4-3「严格按 HTTP DELETE」的直接后果。**不开例外**是刻意的：
> 可判定性优先于精细度——一旦开始按语义判「哪些 DELETE 其实是编辑」，规则就无法被机械
> 校验，也无法写进不会漂移的文档。此处如实标注，而非悄悄开口子。

#### mcps（`mcps:*`）
| 路由 | 档 |
|---|---|
| `GET /api/mcps`、`/probes`、`/:id`、`/:id/probe`、`/:id/runtime-test-session*`（GET） | read |
| `POST /api/mcps` | create |
| `PUT /:id`、`POST /:id/rename` | update |
| `DELETE /:id` | delete |
| `POST /:id/probe`、`POST /:id/runtime-test-sessions`（及其 messages / cancel-turn / end） | execute |

#### plugins（`plugins:*`）
| 路由 | 档 |
|---|---|
| `GET /api/plugins`、`/:id` | read |
| `POST /api/plugins` | create ⚠ 见 §5.4 |
| `PUT /:id`、`POST /:id/rename`、`POST /:id/upgrade` | update（`upgrade` ⚠ 见 §5.4） |
| `POST /:id/check-update` | execute（对外拉取，不改资源） |
| `DELETE /:id` | delete |

#### workflows（`workflows:*`）
| 路由 | 档 |
|---|---|
| `GET /api/workflows`、`/:id`、`/:id/export` | read |
| `POST /api/workflows`、`POST /:id/copy`、`POST /api/workflows/import` | create |
| `PUT /:id` | update |
| `DELETE /:id` | delete |
| `POST /:id/validate`、`POST /:id/validate-draft` | execute |

#### workgroups（`workgroups:*`）
| 路由 | 档 |
|---|---|
| `GET /api/workgroups`、`/:id`、`/:id/resource-status` | read |
| `POST /api/workgroups`、`POST /:id/copy` | create |
| `PUT /:id`、`POST /:id/rename` | update |
| `DELETE /:id` | delete |
| `POST /:id/tasks` | **execute** |

#### tasks（`tasks:*`）——**无 create 档**
| 路由 | 档 |
|---|---|
| 全部 `GET /api/tasks*`（含 page / node-runs / diff / structural-diff / alerts / worktree-* / port-artifacts / worktree-files） | `tasks:read`（范围由 `tasks:read:own\|all` 决定，见下方勘误） |
| **`POST /api/tasks`** | **execute** |
| `POST /:id/cancel`、`/:id/resume`、`/:id/diagnose`、`/:id/clear-recovery-suspension`、`/:id/alerts/:alertId/repair`、`/:id/nodes/:nodeRunId/retry`、`/:id/change-narrative` | execute |
| **`PUT /:id/members`** | **`tokenAccess: 'never'`**（见 §3.3——它转移 owner 并重写协作者集合） |
| `POST /:id/sync-workflow`、`POST /:id/nodes/:nodeId/clarify-directive` | update |
| `DELETE /:id` | delete |
| `POST /:id/questions/manual`、`/:entryId/confirm`、`/:entryId/reassign`、`/:entryId/stage`、`/questions/dispatch` | execute（人工门） |

> `POST /api/tasks` 归 execute 而非 create，是 proposal D11「执行档覆盖启动任务」的直接落地：
> 用户把「启动」明确划进执行档，因此 tasks 域**不存在** `tasks:create` 这个点。

> **勘误（设计门）：`tasks:cancel:own` / `tasks:cancel:all` 是死点，本 RFC 直接删除。**
> 本文初稿称取消的范围「由 `tasks:cancel:own|all` 决定」。**实测这是错的**：
> `services/task.ts:2219` 的 `cancelTask(db, id, opts)` **完全不接收 actor**，取消的唯一
> 边界是 `routes/tasks.ts:218-231` 的可见性中间件；全仓 `grep` 显示这两个点在
> `permission.ts` 之外**零引用**（对照：`tasks:read:all` 在 `routes/tasks.ts:183,188`、
> `clarify.ts:125,178`、`reviews.ts:120,162` 真实使用）。
>
> 若保留它们，§3.2 的反向自检会直接让 daemon 起不来（矩阵域点无路由引用）；而「随手给
> cancel 路由声明 `permissions: ['tasks:cancel:own']`」这个最自然的补救**会打穿 AC-5**——
> `READ_POINTS` 无条件并入范围点，于是**空矩阵的只读令牌也能通过取消门**，管理员的空矩阵
> 令牌更是拿到 `tasks:cancel:all` 可以取消全平台任务。
>
> 处置：**删除这两个点**，取消统一归 `tasks:execute`，范围沿用代码今天真正在用的
> `canViewTask`。另加一条回归：**空矩阵令牌对 `POST /api/tasks/:id/cancel` 必须 403**。
>
> 连带：GET 路由需要一个可声明的读点，故新增 `tasks:read`；`tasks:read:own` /
> `tasks:read:all` 保留为**范围点**（它们被 handler 内的 `actor.permissions.has()` 消费，
> 不被 `RouteMeta` 引用），因此反向自检必须把范围点算作「由 handler 消费」而非死点——
> 见 §3.2 的 `HANDLER_CONSUMED_POINTS` 白名单。

#### 人工门：reviews / clarify（归 `tasks:*`）
| 路由 | 档 |
|---|---|
| `GET /api/reviews*`、`GET /api/clarify*` | read |
| `POST /api/reviews/:nodeRunId/decision`、`POST /:nodeRunId/comments`、`PATCH /:nodeRunId/comments/:commentId`、`PATCH /:nodeRunId/documents/:docVersionId/selection` | execute |
| `POST /api/clarify/:nodeRunId/answers`、`PUT /:nodeRunId/draft` | execute |
| `DELETE /api/reviews/:nodeRunId/comments/:commentId` | **execute**（规则 ① 的唯一业务域例外，见上） |

> **规则的已知粗糙面（2/2）——设计门已修正为更严重的版本**：
> 删掉一条评审评论若归 `tasks:delete`，而 `tasks:delete` 在 D15 等价照搬下是 **admin 专属**
> （`MANAGER_DENIED_PERMISSIONS` 含它），后果**不止是令牌不能删**：
>
> 元数据派生的门跑在 handler **之前**、对**所有 actor** 生效，所以持 session 的普通 user /
> manager 也会 403 ——**Web UI 上的「删除评论」按钮当场坏掉**。初稿称「Web session 通道不受
> 影响，因为 session actor 走 handler 内的作者判定」，**两半都是错的**：`reviews.ts:352-358`
> 只调 `ensureReviewMember`，**根本没有作者判定**（`docs/audit-backlog.md:63` 早已登记
> 「review 评论 PATCH/DELETE 不验作者不留痕」）。
>
> **处置**：把评审评论从「tasks 域的 DELETE」中**豁免出去**，改归 `tasks:execute`——
> 理由是它和 `POST …/comments`、`PATCH …/comments/:id` 是同一个人工门交互的三个动作，
> 拆开归档没有任何业务含义。这是对规则 ① 的一条**显式例外**，写在这里而不是藏起来；
> 它也说明 D4-3「严格按 HTTP DELETE、不开语义例外」在跨越「资源」与「资源内交互记录」的
> 边界时确实需要一条边界定义（见下方规则 ① 的修订）。
>
> 「补上作者判定」不在本 RFC——那是 `audit-backlog:63` 的独立条目。

#### scheduled-tasks（`scheduled-tasks:*`）——**双点 AND**
| 路由 | 档 |
|---|---|
| `GET /api/scheduled-tasks`、`/:id` | read |
| `POST /api/scheduled-tasks` | create **AND `tasks:execute`** |
| `PUT /:id` | update **只此一点**（见下方「实现期修正」） |
| `POST /:id/run-now` | execute **AND `tasks:execute`** |
| `DELETE /:id` | delete |

> **实现期修正（2026-08-02，T3 迁移时实测）：`PUT` 不加 `tasks:execute`。**
> 本文初稿把 PUT 也列入双点 AND，**这会回归 RFC-165 N1-r3 有意授予的能力**。该 PUT 的门是
> **payload-conditional** 的：改名、以及对**已停用**计划的 spec 编辑对窄令牌开放，只有真正
> **武装启动**的编辑才要执行点——判定在 `services/scheduledTasks.ts:549-553`（`armsLaunchAgainst`）
> 与 `:594`，因为只有那里看得见请求体。
>
> 静态路由元数据**表达不了「取决于 body」**。声明更严的门看似安全，实则**静默撤销**了一项
> 既有能力，并且比现状更不精确。因此：`POST` 与 `run-now` 保留双点 AND（它们**无条件**武装
> 启动），`PUT` 只声明 `scheduled-tasks:update`，武装条件继续由服务层承担。
> `tests/rfc165-scheduled-kinds.test.ts` 的 K6 矩阵是这条区分的回归锁。
>
> 这也印证了事实核对评审对 AC-6 的那条 P2：**payload-dependent 的门不能从静态 `RouteMeta` 派生**。

> **这是本 RFC 发现的一个真实提权面**。现状里 `POST /api/scheduled-tasks` 的门是
> `tasks:launch`，`routes/scheduledTasks.ts:77-80` 的注释写明理由：「创建 schedule 武装了
> 未来的启动，所以用与启动相同的委派门」（RFC-165 N1-r3）。若拆点后只要求
> `scheduled-tasks:create`，那么一枚**没有** `tasks:execute` 的令牌就能通过「建一个 1 分钟后
> 触发的定时任务」绕过执行限制。因此这三条路由必须**同时**要求两个点。这是路由元数据层
> 必须支持「多权限点 AND」的直接理由。

#### cached-repos（仓库域 `repos:*`）
| 路由 | 档 |
|---|---|
| `GET /api/cached-repos`、`/imports/:batchId`、`GET /api/repos/refs`、`/api/repos/files` | read |
| `POST /api/cached-repos/batch-import` | create |
| `POST /:id/refresh`、`POST /imports/:batchId/rows/:rowId/retry` | execute |
| `DELETE /api/cached-repos/:id` | delete |

> `repos:*` 的写档在 D15 等价照搬下仍属 admin / manager（`MANAGER_EXTRA` 含 `repos:write`）。
> 普通 user 的矩阵 UI 因此不渲染仓库域写档（D3 / AC-23）。

#### memory（`memory:*`）——旧点退役
| 旧点 | 新档 | 路由 |
|---|---|---|
| `memory:read` | **read** | `GET /api/memories`、`/:id`、`GET /api/tasks/:taskId/feedback` |
| `memory:approve`（手工新建） | **create** | `POST /api/memories` |
| `memory:write_feedback` | **create** | `POST /api/tasks/:taskId/feedback` |
| `memory:edit` | **update** | `PATCH /api/memories/:id` |
| `memory:approve`（promote）/ `memory:archive` | **update** | `POST /:id/promote`、`/:id/archive`、`/:id/unarchive` |
| `memory:delete` | **delete** | `DELETE /api/memories/:id` |

旧的五个点全部退役，不双轨。等价性：user 基线今天同时拥有
`read/approve/archive/delete/edit/write_feedback`，映射后拥有 `memory:read/create/update/delete`
全集 —— 等价照搬成立（D15）。repo/global scope 的行级限制由 `services/memory.ts` 的
`canManageMemory` 继续承担，不受本 RFC 影响。

> **旧点退役的连带（两处，设计门补全）**：
>
> 1. `routes/memoryDistillJobs.ts:26` 等五条路由的门是 `requireResourceAdmin('memory:approve')`
>    （RFC-222 D3 的双门：身份 + 权限点）。`memory:approve` 退役后必须改写为
>    `requireResourceAdmin('memory:update')`——**身份门保持 admin/manager 不放宽**。
>    漏改会让蒸馏作业面在启动期自检时因引用不存在的点而失败。
> 2. **`ws/registry.ts:750-755` 的 `memory-distill-jobs` 频道 `upgradeGate` 用的是同一个点。**
>    退役清扫必须跑 `rg 'memory:(approve|edit|archive|write_feedback)' packages/backend/src`
>    覆盖**整个 backend**，不能只扫 `routes/`。并加一条测试：持 `memory:update` 的 manager
>    令牌仍能开该频道，普通 user 令牌不能。
>
> 另注意 `services/resourceAcl.ts:216` 与 `services/workflow.ts:636` 有 `as never` 形式的
> 权限点断言——它们**绕过 `Permission` 联合类型**，退役点在那里不会变成编译错误。清扫时必须
> 人工过一遍这两处。

#### memory-distill-jobs（`/api/memory-distill-jobs/*`）——**第四处跨域提权面**
| 路由 | 档 |
|---|---|
| `GET /api/memory-distill-jobs`、`/:id`、`/:id/…`（读） | read + `requireResourceAdmin` 身份门 |
| **`POST /:id/retry`**、**另一条 mutating 路由**（`routes/memoryDistillJobs.ts:40-56`、`:57-73`） | **`memory:update` AND `tasks:execute`** + 身份门 |

> `POST /api/memory-distill-jobs/:id/retry` 把作业翻回 `pending` 并置 `nextRunAt = now`，
> 调度器随即调 `runDistill`（`services/memoryDistillScheduler.ts:342`、`:448` 注释明写
> 「awaits a real LLM spawn」）**拉起真实模型进程**。一枚只勾了 `memory:update` 的
> manager/admin 令牌可以对每个失败作业反复 retry，产生无上限的算力与 token 消耗——
> 而 D16 明确不做速率限制，没有任何其它东西能兜住它。故并入跨域族，用双点 AND 收口。

#### runtimes（`/api/runtimes/*`）——**一条无门的系统域读**
| 路由 | 档 |
|---|---|
| `GET /api/runtimes`、`/api/runtimes/status` | `runtime:read`（系统域 ⇒ 令牌恒不含 ⇒ 令牌 403） |
| `POST /api/runtimes/probe`、`POST /api/runtimes`、`PUT /:name`、`POST /:name/enabled`、`POST /:name/probe`、`DELETE /:name` | `settings:write` + `requireAdmin()` 身份门（系统域） |

> **实测缺口**：`server.ts:246-247` 的门挂在 `/api/runtime` 与 `/api/runtime/*` —— **两个模式
> 都匹配不到 `/api/runtimes`（复数）**。于是 `GET /api/runtimes`（`routes/runtimes.ts:130-148`）
> **没有任何权限门**，返回每个运行时的 `binaryPath` / `configDirEnv` / `configDirName` 与缓存的
> `lastProbe` 回执——即宿主绝对路径与 RFC-227 的运行时身份。同文件的
> `GET /api/runtimes/status` 却是有门的，同一文件内自相矛盾。
> 本 RFC 借路由元数据层顺手收口：两条 GET 都声明 `runtime:read`，session 用户不受影响
> （`runtime:read` 在 `USER_RESOURCE_READS` 里），令牌按 D7 正确失去它。

#### workgroup-tasks（`/api/workgroup-tasks/*`，归 `tasks:*`）——**含一处跨域提权面**
| 路由 | 档 |
|---|---|
| `GET /api/workgroup-tasks/pending-count`、`/:taskId/room` | read |
| `POST /:taskId/messages`、`/:taskId/confirm`、`/:taskId/dw-confirm`、`/:taskId/assignments/:id/deliver`、`/:taskId/assignments/:id/cancel` | execute |
| **`PUT /:taskId/config`** | **`tokenAccess: 'never'`**（见 §3.3——它同时授予第三方任务访问权并踢引擎） |
| **`POST /:taskId/dw-save-as-workflow`** | **execute AND `workflows:create`** |

> **提权面 2/3**：`dw-save-as-workflow`（`routes/workgroupTasks.ts:67-73`）在 workgroup-task
> 域下**创建一个真实的 workflow 资源**。若只要求 tasks 域的档，一枚没有 `workflows:create` 的
> 令牌就能借聊天室把动态工作流固化成 workflow。与 scheduled-tasks 同类，同样用双点 AND 收口。

#### fusions（`/api/fusions/*`，RFC-101 memory→skill 融合）——**含一处跨域提权面**
| 路由 | 档 |
|---|---|
| `GET /api/fusions`、`/pending-count`、`/:id` | read |
| **`POST /api/fusions`** | **`tasks:execute` AND `skills:update`** |
| **`POST /:id/approve`** | **`skills:update` AND `memory:update`** |
| `POST /:id/reject`、`/:id/cancel` | `tasks:execute` |

> **提权面 3/3**：`POST /api/fusions` 会在临时 worktree 里跑内置写手 agent `aw-skill-merger`
> （`services/fusion.ts` 头部注释），`approve` 则**原子地 bump skill 版本并 fuse memory**。
> 今天 fusion 对 skill 的授权是**行级 ACL 检查**（`services/fusion.ts:502` 抛
> `fusion-skill-forbidden`），它只回答「你是不是这个 skill 的 owner」，**不回答「你的令牌有没有
> `skills:update` 档」**。因此一枚只勾了任务执行的令牌可以借 fusion 改写自己拥有的 skill，
> 绕过矩阵上没勾的 skill 修改档。用双点 AND 收口。
>
> ### 反例：启动端点**不是**跨域族，别机械套 `${resource}:execute`
>
> `POST /api/{tasks,agents/:id,workgroups/:id}/tasks` 三条看起来最像跨域 AND 的路由，
> **恰恰不是**。RFC-165 F15/N1 明文决定：「launching is a TASK operation on every subject
> face — 三条启动端点统一 gate 在 `tasks:launch`，且 agent 启动路径**豁免** agent 方法门」
> （`server.ts:180-186` 注释原文），并有具名回归 A9 锁着。
>
> T3 迁移时机械地写成 `agents:execute AND tasks:execute` **当场把 A9 打红**——这是与
> `PUT /api/scheduled-tasks/:id`（payload-conditional）**同一类错误的第二次实例**：
> **机械迁移会静默反转前序 RFC 的深思决定**，而 D15 明确要求「不改变 reach」。
>
> 连带后果：`agents:execute` 与 `workgroups:execute` 失去唯一候选路由 ⇒ 成为**死点** ⇒
> 按 §3.2 的规则**根本不该存在**，已从目录删除（60 → 58 点，user 基线 48 → 46）。
> `rfc247-cross-domain-escalation.test.ts` 里加了一条**统一性反例**断言这两条启动路由
> 「permissions 恰好等于 `['tasks:execute']`」，让下一次迁移不能再犯。
>
> **可迁移的判据**：跨域 AND 的成立条件是「路由产生了它所在域**之外**的副作用」，
> 不是「路由挂在某个资源的 URL 下」。启动端点的副作用**就在** tasks 域内——subject 只是
> 被启动的对象，不是被改动的资源。

> ### 跨域副作用族（本 RFC 迄今找到 5 处）
>
> **「A 域的路由产生 B 域的副作用，而门只看 A 域」**——这是本 RFC 最容易漏、也最容易被
> 「按 URL 前缀归档」的直觉害到的一类。§3.1 的 `permissions` 数组 AND 语义就是为它设计的。
>
> | # | 路由 | 表面域 | 真实副作用 | 收口 |
> |---|---|---|---|---|
> | 1 | `POST /api/scheduled-tasks`（及改 `launchPayload` 的 PUT、`run-now`） | schedules | 武装未来的任务启动 | + `tasks:execute` |
> | 2 | `POST /api/workgroup-tasks/:taskId/dw-save-as-workflow` | tasks | **创建 workflow 资源** | + `workflows:create` |
> | 3 | `POST /api/fusions` | tasks | 跑内置 agent 改写 skill | + `skills:update` |
> | 4 | `POST /api/fusions/:id/approve` | tasks | 原子 bump skill 版本 + fuse memory | + `skills:update`、`memory:update` |
> | 5 | `POST /api/memory-distill-jobs/:id/retry` | memory | **拉起真实 LLM 进程** | + `tasks:execute` |
>
> 另有两条不是「加点」能收的——它们改的是**授权本身**，故走 `tokenAccess: 'never'`
> （见 §3.3）：`PUT /api/tasks/:id/members`（转移 owner + 重写协作者）、
> `PUT /api/workgroup-tasks/:taskId/config`（插入 `task_collaborators` 行 **并踢引擎**）。
>
> **T3 的验收要求逐条路由回答「它到底导致了什么」**——路由名不自明时必须读它调用的 service。
> 上面 7 条里有 5 条是名字完全看不出来的。

#### 系统域与公开路由（令牌恒不可达，但**必须**有元数据）

前面的表覆盖矩阵域。**元数据层要求的是全量覆盖**，故以下也逐条声明——它们的共同点是
`SYSTEM_DOMAIN_POINTS` 里的点，令牌按 D7 一律拿不到：

| 文件 / 路由 | 点 | 备注 |
|---|---|---|
| `auth.ts` 13 条 | `account:self`；`login` / `bootstrap/status` / `bootstrap/admin` 用 `publicReason` | 全部 `tokenAccess: 'never'`（D6） |
| `oidc-auth.ts` 3 条 | `publicReason`（已在 `PUBLIC_PATH_PREFIXES` 内） | 登录流，先于认证 |
| `users.ts` 8 条 | `users:read` / `users:write`；`search`+`lookup` 用 `users:search` | |
| `oidc.ts` 8 条 | `oidc:read` / `oidc:configure` | |
| `runtimes.ts` 8 条 | 读 `runtime:read`；写 `settings:write` + `requireAdmin()` | 见上方 runtimes 小节的无门缺口 |
| `config.ts` 2 条 | `settings:read` / `settings:write` | |
| `daemon.ts` 1 条 | `settings:read` | |
| `backup.ts` / `restore.ts` 4 条 | `backup:run` | |
| `runtime.ts` 1 条 | `runtime:read` | |
| `intentSessions.ts` 16 条 | `intent:read` / `intent:write` | 非目标，令牌恒不可达 |
| `memoryDistillJobs.ts` 5 条 | 见上方独立小节 | |
| **`overview.ts` 1 条** | **今天无门**（`overview.ts:2-4` 自陈）→ 定为 `tasks:read` | 首页聚合读 |
| **`plantuml.ts` 1 条** | **今天无门** → 定为 `tasks:read` | 渲染服务，无资源语义 |
| `health.ts` 1 条 | `publicReason`（在 `/api/*` 之外） | |
| `worktree-files.ts` 2 条 | `tasks:read` | **路径是 `/api/worktree-files/*`，不在 `/api/tasks*` 之下**——初稿把它塞进 tasks 的 glob 行，是错的 |

**两处不在 36 个路由文件里、但必须覆盖的**：

1. **`GET /api/whoami`**（`server.ts:159`）——它在 `createApp` 里直接注册。T3 若只扫
   `routes/*.ts` 就会漏，而 §3.2 的正向自检会让 daemon 起不来。定为 `publicReason`
   （任何已认证 actor 都应能自省身份）。
2. **12 条 ACL 路由**——`mountAclEndpoints`（`resourceAcl.ts:63`）用模板
   `${cfg.base}/:${cfg.param}/acl` 为 6 类资源各生成 GET+PUT。§3.1 说 `path` 要「与注册时
   字面一致」，模板挂载没有字面量可绑。**T1 必须定义模板挂载如何声明元数据**：
   `mountAclEndpoints` 自己在生成路由时同步登记 `RouteMeta`（GET → `${res}:read`；
   PUT → `tokenAccess: 'never'`），而不是让调用方各写一份。

### 2.4 opencode 客户端行为（源码实测，影响 §4 的设计）

读自本机 checkout `/Users/wangbinquan/dev/code/opencode`（路径来自 per-user memory，不入仓）：

1. **`packages/opencode/src/mcp/catalog.ts:53-67`** —— opencode 调用 MCP 工具时传
   `{ resetTimeoutOnProgress: true, onprogress: () => {}, timeout }`，源码注释明言
   「MCP SDK 只有在这个 hook 存在时才发送 progress token，从而启用超时重置」。
   → **每条 progress notification 都会重置客户端的超时计时**。
2. **`packages/opencode/src/mcp/index.ts:38`** —— `DEFAULT_TIMEOUT = 30_000`。
   （注意：`packages/core/src/v1/config/mcp.ts` 的 schema 注解文案写的是「默认 5000」，
   与代码实际值不符——**以代码为准，注解文案已过期**。）该 `timeout` 同时用作连接超时
   （`index.ts:286`）与请求超时（`index.ts:662-664` `requestTimeout`）。
3. **`packages/opencode/src/mcp/index.ts:267-283`** —— 先试 `StreamableHTTPClientTransport`，
   失败再退 `SSEClientTransport`；`headers` 经 `requestInit` 下发。
   → 我们的 Streamable HTTP 端点 + `Authorization: Bearer` 可用。
4. **`packages/core/src/v1/config/mcp.ts:44-60`** —— `Remote.oauth` 不显式设为 `false` 时
   **默认开启 OAuth 自动探测**，opencode 会构造 `McpOAuthProvider` 对我们的端点做发现。
   → 配置片段必须带 `oauth: false`（AC-25）。
5. **`packages/opencode/src/mcp/catalog.ts:47`** —— opencode 强制给我们的 `inputSchema` 加
   `additionalProperties: false`。→ 工具入参 schema 必须完整闭合，不能依赖宽松字段。
6. **`packages/opencode/src/mcp/catalog.ts:69-75`** —— `isError` 时 opencode 把 text content
   拼接后 `throw`。→ 错误内容必须是自解释的纯文本，且**不得包含密钥**。

**由 1 + 2 推出的硬性设计要求**：`watch_task` 必须以 **≤10s** 的间隔发送心跳 progress
notification（即使任务状态毫无变化），否则 opencode 默认配置下 30s 就会断开一个还在正常
等待的 `watch_task`。这条写进 AC-15。

---

## 3. 路由元数据授权层

### 3.1 契约

新增 `packages/backend/src/routes/registry.ts`（名称待实现期定稿）：

```ts
export interface RouteMeta {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Hono 路径模板，与注册时字面一致 */
  path: string
  /**
   * 通过本路由所需的权限点。数组语义是 AND —— 全部满足才放行。
   * 空数组必须显式写成 `permissions: []` 并附 `publicReason`，不能省略。
   */
  permissions: ReadonlyArray<Permission>
  /** permissions 为空时必填：为什么这条路由不需要权限点 */
  publicReason?: string
  /** 令牌通道是否可达。'never' = 任何 PAT 一律拒（/api/auth/* 与 ACL PUT） */
  tokenAccess: 'allow' | 'never'
  /** wiki 用：一句话英文描述 */
  summary: string
  /** wiki 用：请求 / 响应 schema（zod），可选 */
  requestSchema?: ZodTypeAny
  responseSchema?: ZodTypeAny
}
```

### 3.2 挂载与穷尽性

- 所有路由改为经 `registerRoute(app, meta, handler)` 注册；该函数在挂 handler 之前先挂由
  `meta.permissions` 派生的门。
- `server.ts:183-211` 的手工 `resourcePermissionGate` / `requirePermission` 挂载**全部删除**。
- **启动期自检（双向穷尽）**：
  - **正向**：任何已注册但没有 `RouteMeta` 的路径 → 抛错，daemon 启动失败。
    这把「忘了挂 gate」从「靠 review 发现」变成「跑不起来」——G4 的全部价值所在。
  - **反向**：任何在 `PERMISSIONS` 里声明、却既没有被任何 `RouteMeta` 引用、也不在
    `HANDLER_CONSUMED_POINTS` 白名单里的**矩阵域**点 → 同样抛错。死点会出现在用户的授权矩阵
    UI 上，让人以为勾了它就获得了某种能力，实际上不对应任何端点——这是**授权界面在撒谎**，
    比漏挂 gate 更难被发现。
    - `HANDLER_CONSUMED_POINTS` 收录被 handler 内 `actor.permissions.has()` 直接消费、
      因而不出现在任何 `RouteMeta` 里的点：目前只有范围点
      `tasks:read:own` / `tasks:read:all`。**每一条都必须附一行注释指出消费它的 file:line**，
      否则这个白名单会退化成「反向自检的垃圾桶」。
  - 两向自检都有测试（AC-2）：分别注册一条无元数据的路由、声明一个无路由的点，断言启动失败。

> 反向自检不是理论洁癖，它当场就抓到了两个死点：本 RFC 初稿按「每类资源四动词」的对称直觉
> 会生成 `repos:update` 与 `skills:execute`，但实测 `routes/cached-repos.ts` + `routes/repos.ts`
> **没有任何 PUT/PATCH**，`routes/skills.ts` 的 5 条 POST 也**全是 create/update 语义**
> （`import-zip/parse` 是纯解析、`save` 与 `versions/:v/restore` 是更新）。这两个点若签发出去
> 就是纯粹的误导。**权限点按真实路由派生，不按资源类型对称补齐。**
>
> 反向自检只覆盖**矩阵域**点：系统域点（`account:self` 等）可能被非路由代码路径使用，
> 强行要求它们有路由会引入假阳性。

### 3.3 与 `tokenAccess` 的关系

`tokenAccess: 'never'` 是一道**独立于权限点**的门，用于表达 D5 与 D6：

- `/api/auth/*` 全部路由 → `never`
- `PUT /api/{res}/:id/acl`（`routes/resourceAcl.ts:75` 的统一挂载点）→ `never`
- **`PUT /api/tasks/:id/members`** → `never`
- **`PUT /api/workgroup-tasks/:taskId/config`** → `never`

> **后两条是设计门抓到的**。D5 的不变量是「令牌永不改变 owner / grants / visibility」，
> 而它把这条不变量**只表达成了一个 URL 形状**（`…/:id/acl`）。任务不属于 RFC-099 的六类
> ACL 资源，它有自己的一套等价授权面，挂在完全不同的 URL 上：
>
> - `services/taskCollab.ts:132-161` 的 `updateTaskMembers` 接受 `{ ownerUserId?, userIds? }`，
>   `canManage` 只要求「你是任务 owner 或资源管理员」。一枚**只勾了 `tasks:update`** 的令牌
>   即可把任务 owner 改成自己、把协作者集合清成自己——而按 CLAUDE.md，任务成员**就是评审 /
>   反问的回答权边界**。**吊销该令牌不能撤销这个授予**：它已经落进 `task_collaborators` 与
>   `tasks.owner_user_id`。
> - `services/workgroup/configActions.ts:333` 在 `addMembers` 时**插入 `task_collaborators` 行**
>   （其 `:172-175` 注释明说「中途加入的 human 成员必须同时成为 task_collaborators，
>   canViewTask / room 访问都以该表为准」）。同一枚 `tasks:update` 令牌即可把任意活跃用户
>   加进一个成员私有任务。
>
> 这两条与 ACL PUT 是**同一个不变量的不同 URL**，因此走同一道 `never`，而不是靠加权限点补。
>
> `PUT /api/workgroup-tasks/:taskId/config` 走 `never` 还顺带关掉第二个问题：同一个 handler 在
> `addMembers` 一个 agent 成员后会调 `kickResumeIfResumable`（`configActions.ts:493`）
> **把引擎踢起来跑**——即一条 `update` 路由产生 `execute` 副作用，正是 §2.3 命名的跨域族。

判定顺序：`multiAuth` 解析 actor → 若 `actor.source === 'pat'` 且 `meta.tokenAccess === 'never'`
→ 403，**在权限点检查之前**，且**在任何 handler 副作用之前**。

### 3.4 用途门（D2）

`purpose === 'mcp_only'` 的令牌命中任何 `/api/*` 业务路由 → 403 `token-mcp-only`。
该判定与 `tokenAccess` 同层，先于权限点。`/api/mcp` 自身不走这道门。

### 3.5 WebSocket（`/ws/*`）——**元数据层管不到的第二条通道**

**实测**：`/ws/*` 的升级判定发生在 `Bun.serve` 的 `fetch` 里（`cli/start.ts:551-556` 先调
`ws.tryUpgrade(req, srv)`，只有返回 `false` 才落到 `app.fetch`），因此它**完全在 `multiAuth`
之外**——`server.ts:155` 的 `app.use('/api/*', multiAuth(...))` 根本不覆盖它。
而 `ws/server.ts:110-135` 从 `?token=` 取凭据后直接调 `resolveActor`，注释明写「接受 session
token、**PAT** 和 legacy daemon token，与 HTTP multiAuth 同一集合」。

因此**令牌可以开 WebSocket**，而本 RFC 的三道新门（`tokenAccess` / 用途门 / 权限点）没有一道
作用于它。

**频道清单必须从 `WS_CHANNEL_KINDS`（`ws/registry.ts:816`）派生，不能目测**。实际有 **10 个**
频道，逐个给出令牌裁决：

| 频道 | 定义 | 既有 gate | 令牌裁决 |
|---|---|---|---|
| `task` | `:501` | `taskVisibleTo`，且 `rerunUpgradeGate` | `general` 允许 |
| `tasks-list` | `:538` | 有 | `general` 允许 |
| `workflows` | `:574` | 有 | `general` 允许 |
| `workgroups` | `:616` | 有 | `general` 允许 |
| **`repo-import`** | `:653` | **无任何 gate** | **一律拒绝 PAT** |
| `memories` | `:671` | 有 | `general` 允许 |
| `memory-distill-jobs` | `:730` | `memory:approve` + 资源管理员身份 | `general` 允许（点名随 §2.3 改 `memory:update`） |
| `scheduled-tasks` | `:757` | 有 | `general` 允许 |
| **`intent-sessions`** | `:777` | 有 | **一律拒绝 PAT**（D7：intent 是系统域，REST 侧已 403，WS 不能开后门） |
| **`mcp-runtime-tests`** | `:794` | 有 | `general` 允许，**但必须过脱敏**（RFC-238 的运行时试用会话最可能携带 §5.3 的密钥字段） |

> **`repo-import` 是一条实测的无门通道**。它的 spec 自己写着「no gate of any kind (RFC-152 D4
> leftover)」「Token-only channel. Batch-ownership validation is a registered leftover」
> （`ws/registry.ts:655-668`）。任何持有效凭据的人只要猜到 `batchId` 就能看别人的仓库导入进度。
> **这是既有缺陷，不是本 RFC 引入的**——但本 RFC 若照「general 令牌可开全部频道」放行，就等于把
> 一个原本要求交互式登录的缺陷降格成「一枚泄漏的令牌即可远程利用」。因此对 PAT 一律拒绝，
> 并把「补 batch-ownership gate」登记到 `docs/audit-backlog.md`（不在本 RFC 修：它需要重放
> RFC-152 D4 的设计讨论）。

**本 RFC 的处置**：

| 项 | 决策 |
|---|---|
| `purpose === 'mcp_only'` 的令牌开任何 WS | **拒绝**（401）。判定放在 `tryUpgrade` 解析出 actor 之后、频道 gate 之前 |
| `purpose === 'general'` 的令牌 | 按上表逐频道裁决；**默认拒绝、白名单放行**，新增频道必须显式声明令牌裁决（穷尽 switch 强制，与 §3.2 的路由元数据同构） |
| 令牌矩阵对 WS 的作用 | **不作用**。WS 是纯读通道，边界由各频道自己的 gate 承担——与「读恒开」同一条原则 |
| §5.3 的脱敏 | **必须同样覆盖 WS 帧**。脱敏若只挂在 REST 响应序列化上，WS 就是绕过路径。`services/tokenRedaction.ts` 必须同时被 `ws/broadcaster.ts` 的出帧路径调用，判据同为 `actor.source === 'pat'` |

---

## 4. MCP 服务端

### 4.1 传输与认证

- 端点：`POST /api/mcp`，`@modelcontextprotocol/sdk` 的 `StreamableHTTPServerTransport`，
  **无状态**（`sessionIdGenerator: undefined`）。SDK 已在 backend 依赖里
  （`packages/backend/package.json:24`，1.27.1），不新增依赖。
- 认证：复用 `multiAuth` 解析出的 actor，再加一道**只接 PAT** 的收紧
  （`actor.source !== 'pat'` → 401）。
- 全局开关关闭时：`/api/mcp` 与 `POST /api/auth/pats` 同时 403。
- 无状态 + `watch_task` 是相容的：`watch_task` 是**单个长 POST**，progress notification 在
  该请求自己的 SSE 响应流上推送，不需要服务端主动向客户端发起连接。

### 4.2 工具集

| 工具 | 档 | 说明 |
|---|---|---|
| `launch_task` | `tasks:execute` | 全量透传 `StartTaskSchema`；带 upload 输入的工作流 → 明确错误 |
| `watch_task` | 读恒开 | 阻塞 ≤240s，≤10s 心跳 progress，超时返回快照 + `stillRunning` |
| `get_task` / `list_tasks` / `get_task_diff` / `list_node_runs` | 读恒开 | |
| `cancel_task` | `tasks:execute` | |
| `retry_node` / `resume_task` / `diagnose_task` / `repair_alert` | `tasks:execute` | 描述里必须写明 retry 会回滚到 `pre_snapshot` 并级联下游 |
| `list_pending_gates` | 读恒开 | 哪些任务卡在 `awaiting_review` / `awaiting_human` |
| `answer_clarify` | `tasks:execute` | 逐题作答 + 提交冻结 |
| `submit_review` | `tasks:execute` | 逐文档评论 + 通过 / 打回 |
| `resource_read` | 读恒开 | `method: list \| get \| export \| …` |
| `resource_write` | 对应资源的 create/update/delete 档 | `method: create \| update \| delete \| copy \| rename \| …` |
| `describe_resource` | 读恒开 | 由 zod 派生该 kind 的 JSON Schema + 示例 |
| `describe_capabilities` | 读恒开 | 本令牌有哪些档、缺哪些（配合 `tools/list` 过滤） |

`tools/list` 按矩阵过滤（D10）。`resource_write` 的可见性取决于该令牌在**任一**资源类型上
是否持有写档；其 `method` 与 `kind` 组合在调用时二次校验。

### 4.3 错误语义

- 权限不足 → `isError: true`，纯文本内容含**缺失的权限点名**（供模型转告用户「请给令牌加
  `workflows:create`」）。
- 业务错误 → 透传现有 `{code, message}` 的 `code` 与 message 文本，不透传 `details`
  （可能含内部结构）。
- **任何错误文本都经 D9 脱敏**（§2.4 第 6 条：opencode 会把 text content 拼起来抛出，
  错误路径同样是泄漏面）。

### 4.4 `launch_task` 的 upload 检测

`StartTaskSchema` 的 `inputs` 是 `Record<string,string>`；upload 类输入由工作流定义里
`kind: 'upload'` 的输入声明表达，走 multipart 分支（`routes/tasks.ts:247-252`）。
`launch_task` 在启动前解析目标工作流的输入声明，若含 upload 类 → 直接返回不支持错误，
**不落任何 task 行、不建 worktree**（AC-17）。

---

## 5. 令牌

### 5.1 Schema 变更

`user_pats` 加一列：

```
purpose TEXT NOT NULL DEFAULT 'general'   -- 'general' | 'mcp_only'
```

矩阵仍存 `scopes_json`。**存量行按 D19 断代**：迁移时把所有既有 `user_pats` 行标记
`revoked_at`，不做 scope 语义转换。

### 5.2 创建时的校验

- 矩阵中越过 `ROLE_PERMISSIONS[user.role]` 的点 → **422 拒绝，不静默丢弃**（AC-7）。
  这与今天 `buildActor` 的静默 filter 行为不同：静默丢弃会让用户以为签出了一枚能建仓库的
  令牌而实际不能。
- 删除档必须在矩阵里逐条出现（D4-2）。
- 原始令牌只在创建响应里返回一次。

### 5.3 脱敏（D9）

新增 `services/tokenRedaction.ts`（单一事实源），在**响应序列化边界**统一施加：

| 数据 | 处理 |
|---|---|
| `mcps.config.env` | 保留键名，值 → `"***"` |
| `mcps.config.headers` | 同上 |
| `mcps.config.oauth.clientSecret` | → `"***"` |
| **`tasks.repo_url`** | → `redactGitUrl(...)` |
| **`task_repos.repo_url`** | → `redactGitUrl(...)` |
| `cached_repos.url` | 防御性断言（见下） |
| `getNodeRunStdout` 输出 | → 过既有 `util/redact.ts` 的 `redactSensitiveString` |

触发条件：`actor.source === 'pat'`。session / daemon 通道不变。
同一份函数同时用于 §6 的审计快照、§3.5 的 WS 出帧与 §4.3 的错误文本。

> **勘误（设计门）：初稿的脱敏清单挑错了字段。**
> `cached_repos.url` **今天已经不会上线**——`services/gitRepoCache.ts:214-228` 的 `rowToCached`
> 自 RFC-204 起只发 `urlRedacted`，明文列从不进 wire。把它列为脱敏目标是个 no-op，AC-12 的
> 「同一份数据经 Web session 读取保持明文」对它**根本无法测**。
>
> 真正在漏的是 **`tasks.repo_url`**：`services/task.ts:3997` / `:4102` / `:4136` / `:4162`
> 四处 `rowToTask` 直接 `repoUrl: row.repoUrl ?? null` **不脱敏**，而同一文件的兄弟路径
> （`:1194` / `:1827` / `:1898`）**特意调了 `redactGitUrl`**——足证该字段是带凭据的。
> `StartTaskSchema`（`shared/schemas/task.ts:143`）只拒**查询串**里的凭据，
> `https://user:ghp_xxx@host/repo.git` 这种 userinfo 形式照收照存。于是「读恒开」让任何令牌
> 都能从 `GET /api/tasks` 拿到它；持有 `tasks:read:all` 的管理员令牌能拿到**全平台**的。
>
> **`rowToTask` 的脱敏对所有通道生效，不只 PAT**——这是修一个既有泄漏，不是加一道令牌门。
> `cached_repos.url` 一条降级为防御性断言（测试断言它确实不上线），保留是为了防回归。

> **明确写进设计的不脱敏面**（避免账号页文案许下做不到的承诺）：
> `GET /api/tasks/:id/nodes/:nodeRunId/stdout`（`services/task.ts:3810-3839`）与
> `GET /api/worktree-files/:taskId/*`（`routes/worktree-files.ts:42-147`）是**自由字节流**。
> stdout 本 RFC 接上 `redactSensitiveString`（与 `pluginInstaller.ts:227` 既有做法一致），
> 但 **worktree 文件内容不做任何脱敏**——它就是仓库工作区本身，agent 写进去的
> `.env` / `.npmrc` 会原样读出。因此账号页与 wiki 的文案**不得**出现「只读令牌不会泄漏密钥」
> 这类表述；正确的说法是「令牌能读到你自己能读到的一切，其中受管资源的密钥字段被掩码」。

### 5.4 插件安装的生命周期脚本（设计门 P0，本 RFC 必须先修再开门）

**实测**：`services/pluginInstaller.ts:220-224` 执行

```
npm install --prefix <pluginDir> --no-audit --no-fund --silent <spec>
```

**没有 `--ignore-scripts`**，且 `:600-602` 的 `spawn` 用 `env: process.env` 传入 **daemon 的完整
环境**。npm 的 `preinstall` / `install` / `postinstall` 生命周期脚本因此以 daemon 用户身份执行，
**在 RFC-205/227/233 的所有 containment provider 之外**（containment 只包 opencode 子进程，
不包这条 `node:child_process` spawn）。

拿到执行的一方即获得：legacy daemon token、`~/.agent-workflow` 全量（所有 MCP `config.env`
密钥、所有 `cached_repos` 凭据、SQLite 库、每个 worktree）、以及改写 `config.json` 的能力——
恰好是 D7 用 `settings:*` / `users:*` / `backup:run` 排除项想保护的一切，外加宿主本身。

**这是既有缺陷**：`plugins:write` 在今天就属于整个 `user` 基线，任何登录用户都能触发。
但 RFC-247 把它从「需要交互式登录」降格成「一枚泄漏的令牌即可远程触发」，**曝光面实质变大**，
因此不能原样开门。

**本 RFC 的处置（三选一里取正解，不留过渡态）**：

1. **加 `--ignore-scripts`**——根因修复，一行，且按 D19「还没人用」零兼容风险。
   opencode 插件是纯 JS，不需要 install 期构建。
2. plugins 三档**保留在矩阵里**（不牺牲 D3），因为根因已修。
3. 残留项——「插件安装仍在 containment 之外、仍继承完整 daemon env」——登记
   `docs/audit-backlog.md`。它需要把 npm 安装纳入 provider 边界，是独立切片，不在本 RFC。

> 不采用「把 plugins 三档设为 `tokenAccess: 'never'`」：那是拿功能换安全，而根因一行可修；
> 留着未修的 RCE 只把它挡在令牌通道之外，等于承认「session 用户可以 RCE」是可接受的——不是。

---

## 6. 审计与删除快照

### 6.1 审计表

```
token_audit(
  id TEXT PRIMARY KEY,              -- ULID
  pat_id TEXT NOT NULL,             -- 不加 FK cascade：令牌删了审计要留
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,            -- 'mcp' | 'rest'
  tool_name TEXT,                   -- MCP 通道
  method TEXT, path TEXT,           -- REST 通道
  resource_kind TEXT, resource_id TEXT,
  status_code INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)
```

**不含请求体**（D16）。索引：`(user_id, created_at)`、`(pat_id, created_at)`。

### 6.2 删除快照

```
token_delete_snapshot(
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL,           -- 关联审计行
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,      -- 已脱敏
  created_at INTEGER NOT NULL
)
```

- 只在**经令牌**的 DELETE 上落，Web session 的删除不落（行为不变）。
- 快照内容 = 被删 DB 行（+ 直接从属行的摘要），经 §5.3 同一套脱敏。
- **任务删除只快照 DB 行**（任务元数据 + node_runs 摘要），**不含 worktree**——worktree 可达
  GB 级，装不进审计表。
- 与审计**同保留期**，同一个清理器一起清。
- 只作存证，**不提供一键恢复**（D16）。

### 6.3 保留期与清理

`config` 新增 `tokenAuditRetentionDays`（默认 90）。清理挂进既有的小时级后台任务
（`eventsArchive` 同一挂载点）。

### 6.4 可视面

- `GET /api/auth/pats/audit`：属主查自己令牌的调用历史。
- 管理员面：全平台令牌清单（属主 / 名称 / 矩阵 / 用途 / 时间）+ 全平台审计。
  **只读，无吊销按钮**（D8）。

---

## 7. wiki

### 7.1 数据来源

`GET /api/docs/api`（登录可读，按角色裁剪）返回：

- 路由清单：来自 §3 的 `RouteMeta`（method / path / permissions / summary / schema）
- MCP 工具清单：来自 §4.2 的工具注册表（name / description / inputSchema）
- 权限目录：来自 `shared/schemas/permission.ts`
- 错误码清单：来自各 `ValidationError` / `ForbiddenError` 的 code 常量

**裁剪**：只返回当前 actor 的角色基线能触及的条目（AC-23）。

### 7.2 页面

- 路由 `/docs/api`（含 MCP 与 REST 两个分区），入口在**账号页令牌区旁**与**设置页**各一个。
  `lib/nav.ts` 的 `NAV_GROUPS` 不动（D17）。
- 渲染：**复用 `components/prose/Prose.tsx`**——它已带 react-markdown 10 + remark-gfm +
  rehype-slug/autolink/external-links + shiki 代码高亮，且刻意不开 `rehype-raw`
  （XSS-safe by construction，见其头部注释）。**禁止新造 markdown 渲染器**（AC-27）。
- 版式复用 `PageHeader` / `Card` / `PageSectionNav` / `TabBar`，遵守 CLAUDE.md 的前端一致性
  强制原则。

### 7.3 语言（D17 / AC-26）

- 外壳（章节标题、导语、表头、步骤说明、按钮）走 i18n，中英双语。
- 生成内容（工具名、参数名、schema description、错误码、路径）**两种语言下都保持英文**。
  它们是标识符，翻译会让用户照抄时出错。

### 7.4 配置片段生成器

端点地址由 `window.location.origin` 推导（D 轮已定：不依赖 admin-only 的
`GET /api/daemon`）。令牌位置留占位符，不回显明文。

**opencode 片段**（形状取自 §2.4 的源码实测，`core/src/v1/config/mcp.ts` 的 `Remote`）：

```jsonc
{
  "mcp": {
    "agent-workflow": {
      "type": "remote",
      "url": "https://<your-host>/api/mcp",
      "headers": { "Authorization": "Bearer <YOUR-TOKEN>" },
      "oauth": false,          // 必需：否则 opencode 会对该端点发起 OAuth 探测
      "timeout": 60000         // 可选：watch_task 靠 progress 重置超时，非必需
    }
  }
}
```

同页另给 Claude Code、通用 MCP 客户端、裸 curl（`initialize` → `tools/list`）三份。

### 7.5 `/.well-known/mcp`（D18）

无需认证，返回：

```json
{ "mcpUrl": "https://<host>/api/mcp", "enabled": true, "protocol": "streamable-http" }
```

挂在 `/api/*` 之外，因此**不需要**往 `PUBLIC_PATH_PREFIXES`（`session.ts:41`）加条目。
必须挂在 SPA catch-all（`server.ts:296`）之前。

---

## 8. 失败模式

| # | 场景 | 期望行为 |
|---|---|---|
| F1 | 令牌过期 / 已吊销 / 属主被禁用 | 401；`lookupActivePatByHash` 既有逻辑已覆盖三者 |
| F2 | 令牌矩阵不含所需档 | 403，错误文本含缺失点名 |
| F3 | 令牌档位够但 ACL 行级不通过 | 与不存在同形（404），沿用 RFC-099 的不可观测约定 |
| F4 | 仅 MCP 令牌打 `/api/*` | 403 `token-mcp-only`，零副作用 |
| F5 | 任意令牌打 `/api/auth/*` 或 ACL PUT | 403，判定在权限点之前、副作用之前 |
| F6 | 全局开关关闭期间已建立的 MCP 连接 | 下一次请求即 403（无状态传输，无长连接需要清理） |
| F7 | `watch_task` 期间 daemon 优雅关停 | 请求终止；客户端重连后靠 `get_task` 拿最新状态（无状态传输天然可恢复） |
| F8 | `watch_task` 超过 240s | 返回快照 + `stillRunning: true`，**不报错** |
| F9 | 客户端未传 progressToken | 心跳 notification 静默跳过，阻塞与超时行为不变 |
| F10 | 删除工具 `confirm` 不匹配 | 422，零副作用（`assertDeleteConfirm` 在业务门之前，见其头部注释的 N-5 顺序） |
| F11 | 删除被引用的资源 | 沿用既有 refs refusal，不因通道不同而放宽 |
| F12 | 启动期发现无元数据的路由 | daemon 启动失败并指名该路径 |
| F13 | 审计写入失败 | **不阻断业务**，落 warn 日志；审计是旁路不是事务的一部分 |
| F14 | 删除快照序列化失败 | 同 F13，但额外在审计行标记 `snapshot_failed` |
| F15 | 创建令牌时矩阵越权 | 422，明示越权的点名 |

---

## 9. 测试策略

按 CLAUDE.md「测试用例随每次需求落地」，以下为必写清单（对应 plan.md 的 AC）：

### 纯函数 / 可断言面（首选）
- `resolveTokenPermissions(role, matrix, purpose)` —— §2.2 的公式，穷尽表驱动：
  空矩阵、越权矩阵、删除档未勾、系统域点、范围点继承。
- `routeMetaCoverage(app)` —— 返回缺元数据的路径集合；测试断言生产 app 上为空集。
- `verbForRoute(method, path)` —— §2.3 映射表的表驱动测试，**每一行都是一条 case**。
- `redactForToken(payload)` —— §5.3，四类密钥字段各一条，且断言键名保留。

### 权限门集成
- 每个矩阵内资源类型 × 四动词 = 一组「有档通过 / 无档 403」对照。
- `scheduled-tasks` 的**双点 AND**：只有 `scheduled-tasks:create` 无 `tasks:execute` 的令牌
  创建定时任务 → 403（AC-6，这是本 RFC 发现的提权面，必须有专属回归）。
- `tokenAccess: 'never'`：`/api/auth/*` 全方法 + ACL PUT。
- 用途门：`mcp_only` 令牌打业务路由。

### MCP
- `tools/list` 随矩阵变化的快照测试（至少三种矩阵：空 / 仅任务执行 / 完整含删除）。
- `watch_task` 心跳：假时钟推进 240s，断言 progress 条数 ≥ 24 且末次返回 `stillRunning`。
- 删除工具的 confirm 校验（红：不传 confirm 时资源仍在）。
- upload 类工作流的 `launch_task` 拒绝，**断言无 task 行落库**。
- 错误文本脱敏：构造一个 env 带密钥的 MCP，令其触发错误，断言输出不含密钥值。

### 审计
- 每种通道各一条：调用后审计行存在、字段正确、**不含 body**。
- 删除后快照存在且已脱敏。
- 保留期清理器：越期行被清、未越期行保留。

### wiki
- 派生关系锁定（AC-22）：新增一个假工具 / 改一条 `RouteMeta` 的权限点后，`GET /api/docs/api`
  的输出随之变化——**这条测试是 G7 的全部保障**。
- 角色裁剪：user actor 拿不到仓库域写操作与系统域端点。
- 源码层文本断言：`Prose` 之外不存在第二个 markdown 渲染入口（AC-27）。
- Playwright：390px 无页面级横向溢出（AC-28），代码块自身可滚。

### 回归防护命名
测试文件顶端注明它锁的是哪类回归与出处，例如
`rfc247-scheduled-task-launch-escalation.test.ts` 顶部写明「锁定 design §2.3 发现的
『只有 scheduled-tasks:create 可绕过 tasks:execute』提权面」。

---

## 10. 迁移

- **migration N**：`user_pats` 加 `purpose` 列；把全部既有行标记 `revoked_at`（D19 断代）。
- **migration N+1**：`token_audit` + `token_delete_snapshot` 两张新表。
- 权限点重构**无迁移**：`scopes_json` 里的旧点随存量令牌一起作废；`ROLE_PERMISSIONS` 是代码常量。
- RFC-221 的三个锁定测试（`tests/auth-routes.test.ts:330,387`、
  `e2e/auth-isolation.spec.ts:458`）改写为新语义，**不删除**——它们改为断言
  「关闭全局开关时创建被拒」，保留 RFC-221 关心的那条「不能绕过 UI 直接建」的意图。

---

## 11. 顺带发现（不属本 RFC，建议登记 `docs/audit-backlog.md`）

`packages/shared/src/schemas/mcp.ts:88-91` 的注释断言「opencode `McpLocalConfig` 没有 `cwd`
字段，所以我们故意不做」。本轮读源码发现 opencode 现在的 `Local` schema **确实有 `cwd`**
（`/Users/wangbinquan/dev/code/opencode/packages/core/src/v1/config/mcp.ts:11-13`，
描述为「MCP 服务器进程的工作目录，相对路径从 workspace 目录解析」）。该断言已过期。
不影响当前行为（我们不下发 `cwd`，opencode 用进程 cwd = worktree），但按 CLAUDE.md
「跨 session 先验证再继续」的要求应当记录，避免后续基于过期假设做决策。
