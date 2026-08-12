# RFC-285 — 技术设计（design）

> 锚点基于审计报告（基线 ≈ `e7361b02`），实现前逐锚复核。
> 依赖：RFC-284 批 C 先落（scheduled 扫描单点、快照式可见性、by-resource grant
> helper 是本 RFC B2/B6② 的地基）；RFC-283 完工后才动 webhook 相关文件（本 RFC
> 不直接碰，但 B4 的 token 收窄会过 webhook 路由的鉴权中间件——纯中间件层，无冲突）。

## B1 404 同形统一

- 触点：`routes/tasks.ts:1215-1227 visibilityCheck`（403 分支改 NotFoundError，
  形态照 `taskCollab.ts:53-70` 的 H9 姿势——响应体与真不存在**字节同形**）；
  `routes/reviews.ts:105-106`、`routes/clarify.ts:111-112` 同改；
  `taskQuestions.ts:41-44` 注释修正（它已是 404，注释却说 mirror 403）。
- 测试改判：`rfc142-review-rounds.test.ts:658`、`api-tasks-alerts-visibility.test.ts:134`
  等锁 403 的断言改 404 并注明「RFC-285 B1 改判」；新增 oracle 消除测试：
  同一路由对「不存在 id」与「存在但无权 id」的响应 status+body 逐字节相等。
- 前端：错误处理路径把 task 域 403 特判合并进 404 分支；i18n 文案改
  「任务不存在或你无权查看」。

## B2 删除引用中档统一

- 触点：`workflow.ts:682-695`（放宽：过滤条件加「仅非终态」）；
  `workgroups.ts:528-592`（收紧：新增任务引用检查，走 RFC-284 的
  `scheduledRowsReferencing` 同族 + tasks 表 workgroupId 非终态查询）；
  agent 现状即中档（`agent.ts:661-689`），不动、其注释升级为「三档统一后的
  单一档位」说明。终态集合以 `shared/lifecycle.ts` 的 terminal 集为单源
  （`terminal-status-single-source.test.ts` 已锁）。
- 横向文档：resourceAcl.ts 头注释的三档对照表（RFC-284 §2.6 写入）更新为
  「统一中档 + 历史沿革」。

## B3 InheritedActor 与失活拒启

- 触点：`scheduler.ts:3867-3870` 删 `as unknown as`；新增
  `auth/actor.ts` 导出 `buildInheritedActor(db, ownerUserId): Promise<Actor | null>`
  ——从 users 表重建（照 `scheduledTasks.ts:735-748` 的 rebuild 姿势），失活/
  不存在返 null。call 分支 null → 节点失败 `call-owner-inactive`（新错误码进
  shared error codes + i18n）。
- 类型：executor 的 actor 参数不再接受伪造形状；grep 锁「`as unknown as
Parameters<typeof startExecution>` 在 src 零命中」。

## B4 query token 收窄

- 触点：`auth/session.ts:257-259 extractRawToken` 增加路径谓词参数（或拆两个
  入口：`extractBearerToken` 供 REST、`extractUpgradeToken` 供 ws/server.ts）。
  设计取向：**拆两个显式入口**（比布尔参数可 grep、可锁）。
- 前置排查：rg `\?token=`/`token=` 在 frontend/cli/tests 的 REST 用法清单，
  逐一迁移（预计主要在测试与 curl 文档示例）。
- 测试：REST 带 query token → 401；`/ws/*` 升级带 query token → 放行；
  两入口的源码文本锁（REST 面不 import upgrade 入口）。

## B5 stale 错误码归一

- 触点：`workflow.ts`/`workgroups.ts`/`skill*.ts` 的 version-conflict、
  `*-copy-stale` 产出点改 `resource-operation-stale`（响应体附
  `resource: 'workflow'|'workgroup'|'skill'` 与既有 detail 字段，信息量不减）。
  按 Q1 拍板决定是否附 `legacyCode`。
- 前端：错误识别集中点改一处（`i18n/errors.ts` 域前缀表 + 各 detail 页的
  conflict 分支），i18n 双语。
- 测试：六类资源 stale 场景全部断言新码；grep 锁旧码字符串在 src 产出面归零
  （tests 里允许出现在改判注释）。

## B6 四洞

- ①review：`services/review.ts:1913-1940` `updateReviewCommentText`/delete 增
  actor 参数与作者比对（owner/admin 旁路走 `isResourceAdminRole` + task owner）；
  DELETE 前置 `assertReviewRoundWritable` 同款 decided 冻结。路由层传 actor。
- ②ws/repo-imports：`ws/registry.ts:658-670` spec 增 upgradeGate：batch 发起者
  （repo_import_batches.owner 列——实现前核实列名）或资源管理员；缺行为 404 同形。
- ③导入 visibility：`workflow.ts:54`、`skill-zip.ts:430` 改 `'private'`；
  bundle 路径已是 private（RFC-271），补回归锁三路（yaml 导入/zip 导入/bundle）。
- ④distill 门：`routes/`（memory distill jobs 详情/会话端点）gate 从
  `memory:read` 收紧为 `isResourceAdminRole`（RouteMeta 声明式改法）；列表页
  行级不含敏感载荷的摘要是否同门 → 保持与详情同门（管理工具面整体收紧，
  UI 本就 admin 入口）。

## B7 memory 模型

- 读面：`services/memory.ts` 的 scope 判定——repo/global 分支从 admin 判定改为
  「登录即可读」；资源 scope 分支不动。注入面（memoryInject）不动。
- 管理面：新增/编辑/审批/删除入口统一加 `isResourceAdminRole` 旁路（现状为
  admin 判定的点改谓词；scope 资源写权路径不动）。
- 前端：`memory.tsx:47` 与 `MemoryPendingBadge.tsx:35`/`memory.distill-jobs.$jobId.tsx:43`
  三点统一改 role 判定（admin+manager），删除恒 true 的 `usePermission('memory:approve')`
  误用（backlog:99）。
- 测试：AC-7 矩阵（见 proposal）；`rfc099-prompt-isolation` 双层锁复跑确认
  模型变化未引入归属进 prompt 的新面。

## 测试策略汇总

- 每组 B1-B7 独立批次：红→绿对（行为变更处）+ 矩阵测试 + grep/文本锁。
- E1-E10 之外零行为差异（对拍口径同 RFC-284）。
- 实现门：独立子代理对抗评审；findings 分「纯实现自修 / 方向题反问」两堆处置。
