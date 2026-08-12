# RFC-285 — 技术设计（design，v2）

> v2（2026-08-12 设计门大修后）。**每个 B 组实现的第一子任务=逐锚复核**（v1 教训：
> B6①③/B7 带着过期锚落档）。依赖：RFC-284 批 C 先落（快照可见性/by-resource grant
> helper）；全程不碰 RFC-283 的 webhook 路由文件。

## B1 404 同形统一

- 触点全集：`routes/tasks.ts` visibilityCheck（403 分支改 NotFoundError，形态照
  `taskCollab.ts:53-70` 字节同形）；`routes/reviews.ts:105-106`；
  `routes/clarify.ts:111-112`；`routes/worktree-files.ts:57-71`（自述不在
  visibility middleware 下，missing→404 / not-visible→403 双轨点）；
  `routes/port-artifacts.ts:61-72`（同构）；`routes/taskFeedback.ts:76`；
  实现前 `rg "task-not-visible"` 全量补漏。
- 保留面：成员制写门 403（member-gate 是另一层语义）；WS 面（ws/registry.ts:538
  已同码 + rfc152 测试锁定）不动。
- 连带改判：`rfc193-port-artifacts-api.test.ts:265` 源码文本锁（expect toContain
  'task-not-visible'——按新形态改写断言意图）；前端 `lib/clarify/durability.ts:310`
  `status===403` 停写分支改「403 或 404 且此前可见」判据（保持被撤权即停写）；
  后端 ≥8 测试文件 + 前端 parent-task-link 等 2 文件逐一改判并注明 RFC-285 B1。
- 新增测试：oracle 消除（不存在 id vs 无权 id 响应逐字节相等）× 触点全集；
  成员门 403 反例。

## B2 删除中档统一 + FK 软链化

- schema 迁移（新迁移号）：`tasks.workflow_id` 去 FK（12-step rebuild，对齐
  `workgroupId` "durable soft link" 先例与其列注释姿势）；列 NOT NULL 保持
  （软链仍必填，只是不再强制存在性）。迁移前后 quick/FK 检查照 RFC-278 姿势。
- 应用层：`workflow.ts:682-695` 过滤条件加「仅非终态」（终态集合单源
  shared/lifecycle.ts terminal 集）；`workgroups.ts` 删除守卫新增 tasks 非终态
  引用检查（`tasks.workgroupId` 软链查询 + 既有 assertNoScheduledReferencesInTx
  并列）；agent 不动、注释升级为统一档位说明。
- 披露：任务引用错误保持**聚合 count**（workflow.ts:689-694 的 task-ACL 论证
  推广到 workgroup 新检查）；scheduled 引用维持 discloseScheduleRefs。
- 展示层：终态任务详情对悬空 workflow 引用的容忍（与 agent 删除后同型——
  实现时核对前端 task detail 对 workflowId 解析失败的现有分支，缺则补）。

## B3 InheritedActor 三臂

- `auth/actor.ts` 增 `buildInheritedActor(db, ownerUserId: string | null)`：
  非 null → 照 scheduledTasks.ts:735-748 rebuild（active 检查）；失活/不存在 →
  null；**null 入参 → 按 Q5 裁决**（放行 `__system__` 或同拒）。
  scheduled 版是否收编到同一构造器：**收编**（三份 rebuild → 1），保持其
  `ValidationError('owner-inactive')` 码不变（构造器返回判定、调用方各自定错误形态）。
- 臂 1 新启 call-workflow（scheduler.ts:3867-3870）：伪造 actor 删除，null →
  节点失败 `call-owner-inactive`（新码进 shared error codes + i18n）。
- 臂 2 新启 call-workgroup（scheduler.ts:4043 `startWorkgroupTaskFromFrozen`）：
  同判定接入（该臂现无 actor 构造，按其入参形状接）。
- 臂 3 resume（scheduler.ts:3373）：**按 Q6 裁决**（同检 or 豁免+注释锁定）。
- grep 锁：`as unknown as Parameters<typeof startExecution>` src 归零。

## B4 query token 双入口

- `auth/session.ts` 拆 `extractBearerToken`（REST，仅 Authorization 头）/
  `extractUpgradeToken`（仅 ws/server.ts 消费）；**`routes/auth.ts:476-483` 本地
  extractRawToken 删除、改调共享 REST 入口**（其消费点 :177/:259 随迁）。
- 测试：REST 含 /api/auth/_ 带 ?token= → 401；/ws/_ 升级照常；
  「REST 面不 import upgrade 入口」文本锁。

## B5 stale 码归一

- 实现前先产全量对照表：`rg "version-conflict|copy-stale|overwrite-stale"`
  产出点 × 消费点。已知消费面：前端 i18n/errors.ts 域表 + 各 detail 页 conflict
  分支 + `useWorkgroupAutosave.ts:497` 状态机；后端 `skill-zip.ts:678-686`
  （overwrite outcome 分派）+ `services/fusion.ts:1442-1447`。
- 新码形态：`resource-operation-stale` + `resource` 字段 + 既有 detail；
  Q1 裁决 legacyCode 兼容期；Q7 裁决 repo-group 码与 skill-overwrite-stale 归属。
- 与 RFC-283 协调：其新增 webhook fence 码若在本 RFC 实现期出现，按同族命名
  对齐（实现时与该 RFC owner 对一次表）。

## B6 存量洞（v2 定界）

- ①review 作者校验：`updateReviewCommentText`/delete（review.ts:1913-1921 /
  :1988-2002）增 actor 参数；比对 `row.author === actor.user.id`，owner/admin
  （isResourceAdminRole + task owner）旁路；**author 为 LOCAL_DECIDER 兜底值的
  历史行走 owner/admin-only**。冻结现状（:1959-1964 / :2025-2030 对称）补回归锁。
- ②repo-imports ownership：`BatchRecord` 增 `ownerUserId`（repoBatchImport.ts:66-81）；
  `startBatchImport` 入参增 actor（routes/cached-repos.ts:140 传入）；
  `ws/registry.ts:657-673` spec 增 upgradeGate（ownerUserId 匹配 ∨
  isResourceAdminRole；batch 不存在/不匹配 → 404 同形拒升级）。内存 Map 语义
  不变（daemon 重启批次即逝，gate 随之自然失效——无持久化需求）。
- ③导入 visibility 回归锁三路（yaml 导入 / zip 导入 / bundle apply 各断言
  visibility='private'）+ backlog 过期条销账（原 :98/:100 区段的导入条目）。
- ④distill 门：`routes/memoryDistillJobs.ts` 全部读端点 RouteMeta 改
  `identity:'resource-admin'`；文件头 :7-8 过期注释同批更正。

## B7 memory（v2 定界）

- 现状矩阵回归锁：scope（agent 等资源 scope / repo / repo_group〔按 Q3〕/ global）
  × 角色（user/owner/manager/admin）× {读, 管理} 全矩阵断言现状（memory.ts:740-782
  的语义拍死，防将来漂移）。
- 前端：新 `useIsResourceAdmin()`（admin+manager）；`memory.tsx:85` 与
  `memory.distill-jobs.$jobId.tsx:47` 两点从 `useIsAdmin()` 换用；
  MemoryPendingBadge 无判定（现状正确）不动。
- candidate 读面按 **Q4** 裁决（收紧则动 routes/memories.ts:113-129 的 list/detail
  过滤器对 status='candidate' 行加管理员门——含 body 与不含 body 两读法都收）。
- 文档：CLAUDE.md「（repo/global 仍 admin）」句更正为现状；`rfc099-prompt-isolation`
  双层锁复跑。

## 测试策略

每 B 组：逐锚复核先行 → 红→绿对（真行为变更处）/回归锁（现状拍死处）→ 矩阵 →
grep/文本锁。E 清单（v2）外零行为差异；实现门=独立子代理对抗评审。
