# RFC-222 · manager 角色（资源管理员）与 admin 专属任务删除 — 产品提案

状态：Draft（2026-07-22）
发起：用户 2026-07-22 三条需求 ——
① 「给系统再增加一类角色，这类角色不可以管理用户、也不可以配置系统，但是具备系统内所有资源的权限，也就是可以操作、修改、删除等其他人的资源，能力就等于 admin 删除了配置用户和设置系统的能力」；
② 「给 admin 删除任务的权限，这个删除能力只能 admin 有」；
③ 「在删除元素的时候，要弹出删除界面，要求用户输入元素名称才能够删除，并且这个删除确认动作要在后台校验」。

## 1. 背景

当前系统只有两个全局角色（`users.role ∈ {'admin','user'}`，schema.ts:1664）：

- **user**：可创建六类 ACL 资源（创建者即 owner）、只能看 public 或被授权的资源、只能改删自己 own 的资源；任务域只能看/取消自己参与的任务（`tasks:read:own` / `tasks:cancel:own`）。
- **admin**：全权 —— 权限点全集（含用户管理 `users:*`、系统设置 `settings:*`、OIDC `oidc:*`、备份 `backup:run`、仓库 `repos:write`、任务越权 `tasks:read:all/cancel:all`），加上 row 级 ACL bypass（`isAdminActor`，resourceAcl.ts:74）与身份门（`requireAdmin()`：runtimes / memory-distill-jobs）。

两档之间缺一档：**团队里需要有人替大家整理资源**（修坏掉的 agent、清理废弃 workflow、接管离职成员的私有资源、处理卡死任务），但这个人**不应该拥有"造神"能力**——不能加删用户、改角色，也不能动系统级配置（runtime、OIDC、备份、全局设置）。目前只能把这类人直接提成 admin，权限过度授予。

另一个缺口：**系统完全没有删除任务的功能**（`routes/tasks.ts` 无 DELETE 路由）。任务终态后其 DB 记录、worktree、快照 ref 永久留存，只有小时级 GC 对 worktree 有条件回收；误建/试验任务无法从列表里清掉。

此外，manager 获得越权删除他人资源的能力后，误删风险显著上升；现有删除确认只是"点一下确认按钮"，且校验全在前端——直接调 API 无任何确认门槛。

## 2. 目标

1. 新增第三个全局角色 **`manager`（中文显示名：资源管理员）**，能力恒等式：**manager = admin − 用户管理 − 系统设置/系统运维 − 任务删除**。
2. 新增**任务删除**能力：`DELETE /api/tasks/:id`，权限点 `tasks:delete` **仅 admin 持有**（manager 也没有）；仅终态任务可删；删除连带清理 DB 关联数据与磁盘产物。
3. **删除强确认（type-to-confirm）**：任务与六类 ACL 资源的删除必须弹出确认界面、用户**输入元素名称**才能提交；名称匹配**在服务端强制校验**（请求携带用户实际输入的文本，后端比对当前名称，不匹配拒绝删除）——前端确认可被绕过，服务端校验不可。

## 3. 非目标

- 不引入按资源类型细分的自定义角色 / 角色编辑器（本 RFC 只加一个固定角色）。
- 不改变任务的成员制私有模型（D20）：user 的任务可见性规则不变。
- 不改变六类资源的 ACL 模型（owner / visibility / grants 语义不变），只是 manager 获得与 admin 相同的 bypass。
- 不提供任务批量删除、回收站 / 软删除、定时自动删除（删除是硬删，一次一个）。
- 不给 manager 开设置页的任何子集（settings:read 不给 ⇒ 整个 `/settings` 不可见，包括其中的 runtime tab；这是有意的粗粒度，避免为一个角色拆设置页）。

## 4. 角色能力矩阵（决策记录）

用户 2026-07-22 五项拍板（AskUserQuestion）：D1 命名 manager/资源管理员；D2 任务域全给（删除除外）；D3 边界能力 repos:write 与记忆全域管理给、备份/runtime/OIDC 不给；D4 删除仅终态、连带清理；**D5 type-to-confirm 覆盖范围 = 任务 + 六类 ACL 资源**（repos/用户/记忆等其他删除维持现状确认框；`DELETE /api/skills/:name/file` 属技能内文件管理、非资源删除，不纳入）。

| 能力 | user | manager | admin | 备注 |
| --- | --- | --- | --- | --- |
| 六类 ACL 资源（agent/skill/mcp/plugin/workflow/workgroup）：看/改/删/管 ACL **他人私有行** | ✗ | ✓ | ✓ | row 级 bypass（D1 核心诉求） |
| fusion（他人行读/改/删） | ✗ | ✓ | ✓ | fusion 是 owner-private 资源 |
| scheduled task（他人行写） | ✗ | ✓ | ✓ | 现状 owner-or-admin |
| 仓库管理 `repos:write` | ✗ | ✓ | ✓ | D3 拍板：仓库属资源 |
| 记忆 repo/global 域管理（approve/archive/delete/edit） | ✗ | ✓ | ✓ | D3 拍板：记忆属资源 |
| 记忆蒸馏 job 运维页 + WS 频道 | ✗ | ✓ | ✓ | D3 拍板（随记忆全域管理） |
| 任务越权：看所有人任务 `tasks:read:all` | ✗ | ✓ | ✓ | D2 拍板 |
| 任务越权：取消所有人任务 `tasks:cancel:all` | ✗ | ✓ | ✓ | D2 拍板 |
| **任务删除 `tasks:delete`** | ✗ | **✗** | ✓ | 需求②：仅 admin |
| 用户管理 `users:read/write`（增删改、改角色、重置密码） | ✗ | ✗ | ✓ | 需求①明确排除 |
| 全局设置 `settings:read/write`（含 `/settings` 页、daemon 信息） | ✗ | ✗ | ✓ | 需求①明确排除 |
| OIDC 配置 `oidc:read/configure` | ✗ | ✗ | ✓ | 属系统设置 |
| Runtime 管理（requireAdmin 路由族） | ✗ | ✗ | ✓ | 属系统设置 |
| 备份/恢复 `backup:run` + restore 路由 | ✗ | ✗ | ✓ | 属系统运维 |

其余与 user 基线相同的能力（创建资源、launch 任务、看自己任务、账户自服务、记忆读/反馈、users:search 选人器等）manager 全部继承。

## 5. 用户故事

- **US-1（授予）**：作为 admin，我在用户管理页把资深成员 A 的角色改为「资源管理员」；A 重新进入系统后能看到并管理所有人的资源，但用户管理入口和设置页对 A 不可见。
- **US-2（资源治理）**：作为 manager，我看到成员 B 一个 private 的 workflow 引用了已废弃的 agent，我直接打开修好它，或把 owner 转移给接手的同事；B 不在也不阻塞。
- **US-3（任务疏导）**：作为 manager，我在任务列表切到「全部」，发现 C 的任务卡在 awaiting_human 三天没人理，我进去替他回答反问（归属快照如实记录我的 manager 身份）或直接取消该任务。
- **US-4（删除，admin 专属）**：作为 admin，我删除一个 canceled 的试验任务：任务从列表消失，其 node runs / 评审 / 反问 / 房间消息等 DB 记录与 worktree、快照 ref 一并清掉。作为 manager 我尝试同样操作会得到 403。
- **US-5（防锁死）**：作为系统，当 admin 试图把「唯一的活跃 admin」降级为 manager 时我拒绝（沿用 last-admin-protection）——manager 管不了用户，不能作为最后一名管理员。
- **US-6（删除强确认）**：作为 manager，我删除他人的 workflow 时弹出确认框，必须一字不差输入该 workflow 的名称，删除按钮才可用；即使我用脚本直接调 DELETE API，不携带正确名称的请求也会被服务端拒绝。输错名称（比如删错了同前缀的资源）时服务端返回名称不匹配，删除不会发生。

## 6. 验收标准

- **AC-1** `manager` 可经 UI（用户管理页 Select）、API（POST/PATCH /api/users）、CLI（`user create --role manager`）授予与撤销；仅 admin 能操作（users:write 不变）。
- **AC-2** manager 对六类 ACL 资源的**他人 private 行**：列表可见、详情 200、PUT 修改、DELETE 删除、GET/PUT `/acl`（含 owner 转移、visibility 翻转、grants 全替换）全部可用；对 fusion 与 scheduled task 的他人行同样可读/写。
- **AC-3** manager 持有 `repos:write`：可注册/编辑/删除仓库。
- **AC-4** manager 记忆全域：repo/global scope 行 `canManage=true`（approve/archive/delete/edit 可用）；`/api/memory-distill-jobs` 路由族 200；`/ws/memory-distill-jobs` 升级通过。
- **AC-5** manager 任务域：任务列表 scope=all 返回全量；他人任务详情 200；取消他人任务成功；以非成员身份参与评审/反问时归属快照记 `manager`（不冒充 admin，不进 agent prompt）。
- **AC-6** manager 被拒面：`/api/users*`（search 除外）、`/api/settings`、`/api/daemon`、`/api/oidc/providers*`、`/api/backup*`、`/api/restore*`、`/api/runtimes` 写族全部 403；前端用户管理入口、设置页入口对 manager 不渲染。
- **AC-7** `DELETE /api/tasks/:id`：admin + 终态（done/failed/canceled/interrupted）→ 200；活跃态（pending/running/awaiting_review/awaiting_human）→ 409 `task-not-terminal`；**残存活跃性（activeTasks 占用 / 存活子进程）→ 409 `task-active`；fusion internal 任务 → 409 `task-internal`**；manager/user（含任务 owner 本人）→ 403；**PAT 未显式列 `tasks:delete` 的 admin 令牌 → 403**；不存在 → 404。
- **AC-8** 删除连带：12 张 FK cascade 表（node_runs 及其 events 二级链、clarify、workgroup 四表、taskRepos、docVersions、taskCollaborators、lifecycleAlerts、taskQuestions 等）随行清空；`task_feedback` 显式删除；`memory_distill_jobs`、`recovery_events`、`lifecycle_repair_audit` **保留**（记忆域/灾备/生命周期修复审计不随任务删）；worktree + git worktree 注册 + 快照 ref + logs/runs 归档目录经 **cleanup outbox（与删行同事务落库）**同步清理，失败或 crash 后由小时级 GC 重试收敛——磁盘残留不豁免、DB 删除不回滚。
- **AC-9** 删除成功广播 `task.deleted` WS 帧（预埋契约 ws.ts:235 的首个真实发送方），**携带事务内捕获的 audience（owner/协作者/越权者），冷缓存连接同样收到**；任务列表自动失效；停留在该任务详情页的其他客户端收到 per-task 终帧并导航离开。
- **AC-10** 防锁死：唯一活跃 admin 不能被降为 manager / 禁用（last-admin-protection 覆盖）；manager 不计入 admin 计数；manager 无法改任何人角色（无 users:write）。
- **AC-11** 角色变更即时生效：admin 把 manager 降回 user 后，其已连接 WS 会话经 RFC-212 revalidation 收窄可见面（patchUser 已触发 `user-patched`）。
- **AC-12** 全量测试：shared 权限快照锁（manager 正/负集）+ backend 行为矩阵 + frontend vitest（角色 Select、AttributionChip、删除按钮门控）全绿；`bun run typecheck && bun run lint && bun run test && bun run format:check` 通过。
- **AC-13** 删除强确认（D5）：任务 + 六类资源共 7 个 DELETE 端点，请求体不带 `confirm` → 400 `delete-confirm-required`；`confirm` 与元素当前名称不一致 → 400 `delete-confirm-mismatch`（删除不发生）；一致 → 正常删除。前端 7 个删除入口全部弹出输入名称的确认框，输入不匹配时确认按钮不可用，**请求携带的是用户输入框里的实际文本**（不是前端代码里的常量）。
- **AC-14** 强确认覆盖面守卫：结构性测试锁定"六类资源 + 任务的 DELETE handler 必须挂名称校验"，未来新增资源类漏挂即红。

## 7. 与并行工作的关系

- **RFC-221（Draft v2，账户安全中心与用户目录 UX 重构）**：冲突面不止 `routes/users.tsx` 单文件——角色 filter/presentation map/新建用户 Dialog 均冻结了二值 role，且 221 将全局关闭 PAT 新建（与本 RFC 的 `tasks:delete` PAT 显式化交互 ⇒ 任务删除事实上 session-only）。完整联合落地清单见 design.md §11；谁先批准谁先行，后落地者持有该表责任。
- RFC-099 资源 ACL 的 D1（404 不泄漏存在性）、D16（成员名单只读可见）、D20（任务恒私有）语义全部保持；本 RFC 只扩大"谁享有 bypass"的集合。
- 涉及一条 migration（B 线 `task_cleanup_queue` 清理收敛表，design.md §6.4）；A/C 线零 migration。
