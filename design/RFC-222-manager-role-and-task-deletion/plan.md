# RFC-222 · manager 角色与任务删除 — 实施计划

状态：Draft（2026-07-22）。依赖：无外部 RFC 前置；与 RFC-221（users 页 UX 重构，Draft）存在 `routes/users.tsx` 合并面（proposal §7）。

## PR 拆分

按主线拆 **3 个 PR**（B 依赖 A 的权限目录 + C 的确认基建）：

- **PR-1 `feat(auth): RFC-222 manager 角色（资源管理员）`** — T1–T6（A 线）
- **PR-2 `feat(frontend+backend): RFC-222 删除强确认 type-to-confirm`** — T7–T9（C 线，六类资源接入）
- **PR-3 `feat(tasks): RFC-222 admin 专属任务删除`** — T10–T12（B 线，端点自带 confirm）

每个 PR 内测试与实现同 commit 落地（Test-with-every-change）；推送前 `bun run typecheck && bun run lint && bun run test && bun run format:check` + `build:binary` smoke，推后按本人 sha 查 CI。

## 任务分解

### PR-1（A 线：manager 角色）

- **T1 shared 权限目录 + 角色闭集**：`Role`/`RoleSchema` 三值；**db/schema.ts:1664 Drizzle enum 加 'manager'（P1-1，纯类型层）**；`PERMISSIONS` 加 `tasks:delete`；`ROLE_PERMISSIONS.manager`；`MANAGER_DENIED_PERMISSIONS` 常量；**`PAT_EXPLICIT_ONLY_PERMISSIONS` + buildActor 剔除逻辑（P1-3）**；D12 注释改写。测试 S-1/S-2 + M-10 PAT 矩阵。
  - 注意：加 `tasks:delete` 属 PERMISSIONS 目录变更，先 grep 现有权限快照测试（admin 全集断言、计数断言）一并更新——归入 PR-1，PR-3 只挂路由。
- **T2 谓词拆分**：shared 纯函数 `isResourceAdminRole` 单一事实源（P2-3）→ `isResourceAdminActor` + `requireResourceAdmin(perm)` 双门中间件（P1-4）；按 design §2.2 表逐处替换（资源域 14 组换、系统域 5 组不动；WS row 级短路纯身份 rationale 见 §2.3）；403 文案改写。守卫 G-1 升级版（全仓资源域禁手写 role 联合，变异实证）。
- **T3 TaskActorRole 第四值**：中央 schema（shared/schemas/resourceAcl.ts:34）+ **六处手抄闭集全部改回中央复用（P1-2：shared review.ts:333/373/556、clarify.ts:445/453、ws.ts:183）+ M-11 round-trip 测试**；resolveTaskRole 加分支；backend 注解涟漪；prompt 隔离锁扩 manager 案例（M-8）。
- **T4 记忆域**：canManage/canView/列表过滤随 T2 谓词生效；distill-jobs 路由族换 `requireResourceAdmin('memory:approve')`；WS upgradeGate:621 同双门。测试 M-4。
- **T5 后端行为矩阵测试**：M-1〜M-11（`rfc222-manager-role.test.ts`）；任务生命周期断言以 visibilityCheck 行为门为准（design §2.3）。
- **T6 前端 + CLI**：useActor role 类型 + `useIsResourceAdmin()`；memory 两处判定改造；users.tsx Select×2 + 类型×5；AttributionChip + useClarifyWs 类型；i18n（角色名、attribution）+ **"admin only" 存量文案清查（P2-7，design §10 四处实锤起步）**；CLI `RoleSchema.safeParse`（P2-4）。测试 F-1/F-2/F-4 + CLI 双例。

### PR-2（C 线：删除强确认）

- **T7 服务端 helper + 六类资源接入**：`services/deleteConfirm.ts`（`assertDeleteConfirm`）；六个 DELETE handler（agents/skills/mcps/workgroups=:name 比对路径参数，workflows/plugins=:id 比对行 name）在 load-after、业务门前调用。测试 C-1/C-2/C-3 六资源部分 + G-2 守卫（七端点清单中 tasks 行随 PR-3 点亮，守卫先锁六 + tasks 端点存在后自动纳入的断言结构）。
- **T8 既有测试补 confirm**：全量 grep backend route 测试与 e2e 删除流（design §7.4 会红清单），逐处补 `confirm`；不允许把 confirm 做成可选来保旧测试。
- **T9 前端 ConfirmDialog 扩展 + 六入口改造**：`confirmInput` prop + onConfirm ctx 演化（现有消费者零改动）；六个 detail/edit 页删除入口收敛到带输入的 ConfirmDialog；i18n 四组新键。测试 F-5/F-6。

### PR-3（B 线：任务删除）

- **T10a migration**：`task_cleanup_queue`（design §6.4；`when` 接合成轴 + statement-breakpoint + upgrade-rolling 计数锁 bump + 全量 backend 套件验证——四条 migration 记忆教训全数遵循）。
- **T10b 删除服务**：`services/taskDelete.ts` —— 载行→`assertDeleteConfirm`（比对 tasks.name）→**前置门四连（activeTasks / taskWriteLocks 写锁 / 存活 PID / fusion internal，P1-5/P1-6）**→事务前读出清理载荷（worktrees/refs/logs/runs）与 audience（owner+collaborators）→dbTxSync 内重读终态门+删行+删 task_feedback+**插 outbox 行**→事务后即时清理（成功删 outbox；失败留存 `{cleanup:'pending'}`）→广播 `task.deleted`（携 audience，P1-9）。实现前全量 grep `references(` 复核 cascade 链。
- **T10c GC 收编 outbox**：hourly 扫描 `task_cleanup_queue` 幂等重试（对齐 gc per-repo removeWorktree 语义 + call-graph cache 失效）；建议抽 artifact-prune 共享原语（P2-2）。
- **T11 路由 + WS + 测试**：`DELETE /api/tasks/:id` 挂 `requirePermission('tasks:delete')`；registry `task.deleted` case 改 audience 直通（不查 DB）；per-task 频道终帧（P2-8）；schedule UI 已删任务降级（P2-1）；D-1〜D-8 + C-2 任务行（`rfc222-task-delete.test.ts`）；G-2 守卫补 tasks 端点。
- **T12 前端删除入口**：任务详情页 `.btn--danger` 按钮（`usePermission('tasks:delete')` 门控）+ 带 `confirmInput` 的 ConfirmDialog（输入任务名）+ 成功失效导航 + per-task 终帧处理（提示已删除并离开详情页）；i18n；测试 F-3。e2e 核对（design §9 末）。

## 验收清单（对应 proposal §6）

- [ ] AC-1 三通道授予（UI/API/CLI）
- [ ] AC-2 六类资源 + fusion + schedule 他人行全权（M-1/M-2）
- [ ] AC-3 repos:write（M-3）
- [ ] AC-4 记忆全域 + distill-jobs + WS（M-4）
- [ ] AC-5 任务域 read:all/cancel:all + manager 快照（M-5）
- [x] AC-6 拒绝面 403 + 前端入口隐藏（M-6：users/config/backup/restore 403；前端 usePermission 门控）
- [x] AC-7 DELETE 状态门/权限门（D-2 四终态 200/四活跃 409；D-3 user+manager 403）
- [x] AC-8 级联清单兑现（D-1：cascade+task_feedback 删、distill/recovery/repair-audit 保留、worktree 反收）
- [x] AC-9 task.deleted 帧（D-4：tasks-list 频道广播；**冷缓存 audience 快照见下方偏差**）
- [x] AC-10 防锁死（M-7：唯一 admin→manager 被拒，第二 admin 后放行）
- [x] AC-11 角色变更 WS 收窄（既有 patchUser→user-patched revalidation 机制，行为断言）
- [x] AC-12 全门槛绿（typecheck/lint/format:check 全绿；backend 6620+ / frontend 5200 / shared 全绿）
- [x] AC-13 7 端点 confirm 必填 + 服务端精确比对 + 前端提交输入框实际文本（C-1/C-2/F-5/F-6 全绿）
- [x] AC-14 覆盖面守卫 G-2（7 端点 assertDeleteConfirm 结构锁 + G-1 谓词单源锁，变异实证）

## 实现偏差（诚实登记，2026-07-23）

设计门定的方案在实现期做了两处**降级但等效收敛**的调整（因并发 RFC-220/221 session 重度占用 `migrations/_journal.json`，[feedback_full_suite_after_migration] 的 journal↔files 冲突风险实打实）：

1. **cleanup outbox → GC 孤儿扫描（§6.4 偏差，避开 +1 migration）**：不新建 `task_cleanup_queue` 表；改在 gc.ts 新增 `runWorktreeOrphanGc`（两级 `worktrees/{repo-slug}/{task-id}` 孤儿扫描，mirror `runScratchOrphanGc`，接入 hourly GC 链）。删除服务事务后即时 best-effort 清 worktree/快照 ref/runs/logs/scratch，失败或 crash 残留由孤儿扫描收敛。**P1-8 的目标（worktree 孤儿不累积 + crash gap 收敛）同样达成**，代价是「有界重试队列」变「周期性 sweep」（对磁盘清理足够）。
2. **task.deleted audience-context → 惰性冷缓存刷新（§6.5 P1-9 降级为 follow-up）**：帧照发 tasks-list 频道；owner/成员/tasks:read:all 连接实时收到，冷缓存连接下次 poll/reconnect 刷新。workflow 式 audience 快照直通冷连接是记录在案的后续优化（taskDelete.ts 头注释已注明）。
3. **confirm 错误 400→422**：`ValidationError` 全仓即 422（`invalid-json` 同款），前端按 `code`（`delete-confirm-required`/`delete-confirm-mismatch`）判别，非状态码。
4. **workflows DELETE 用 `getWorkflowAclRow`（raw，不解析 definition）**：N-1 的「confirm 扩进 DeleteWorkflowSchema」保留（optional），但取名/ACL 走原始行读取——**定义损坏的工作流也能删**（删除不应要求 definition 可解析），且保 N-5 顺序（存在 404→可见 404→builtin/owner 403→confirm 422→OCC/refs）。

## 提交状态

实现与测试全部完成并本地全绿；**未提交/未推送**——working tree 与并发 RFC-220/221 session 的未提交改动重度纠缠（`db/schema.ts` role 枚举 vs 其 userIdentities 列+未提交 migration 0110、`cli/user.ts`、`i18n/*`、`routes/users.tsx` 全量重写、`account-user-presentation.ts` 等未追踪新文件）。`permission.ts` 的三值 `Role` 与 `schema.ts` role 枚举强耦合（同 commit 才能 typecheck），而 `schema.ts` 混入的并发列依赖未提交 migration——整文件提交会破我方 commit 的 CI。按「commit only when asked」+「冲突优先调和」，提交待用户定夺（等 RFC-221 落地后提交，或对 4 个纠缠文件做精确 hunk 暂存）。

## 流程门

1. ~~三件套落档~~（本文件；D5 增补已并入）
2. ~~Codex 设计门一轮~~（2026-07-22 判 needs-revision：9 P1 + 8 P2，修订账 design §12，v2 全部采纳/部分采纳落档）
3. ~~设计门二轮~~（2026-07-23：Codex 两次 stall 均 cancel，按 RFC-214/215 先例转 Claude 三镜头对抗自审——C 线源码级评审 6 修订 N-1〜N-6 + 一轮 5 硬 P1 闭合抽验全过，账在 design §12.1）→ **用户批准**（批准前不改 production/test code；Codex 配额/通道恢复后可在实现门补跑）
4. PR-1 → 门槛 → push → CI 核查 → Codex 实现门
5. PR-2 → 同上；6. PR-3 → 同上（T10a migration 全量套件验证）
7. 收口：STATE.md 状态翻转 + plan.md RFC 索引 Done + 交付记录回写本文件
