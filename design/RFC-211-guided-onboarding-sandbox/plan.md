# RFC-211 — 实施计划

> **状态**：In Progress（2026-07-20 起草并实施；PR-1/2/3 已合并推送 `c4574064` + `ee61b5e7`，四件套全绿）。用户已授权"RFC 完成后直接开始实现直到完成"。

## 1. 依赖与顺序

```text
T0  RFC 三件套 + 索引登记            [docs, no production code]
 └─> T1 DB 层（迁移 0103 + schema.ts + DTO）
      ├─> T2 create service 支持 visibility  ── ┐
      ├─> T3 任务 example 派生（三条启动路径）── ┤
      └─> T4 onboarding service（run / provision / adopt）
           ├─> T5 example 任务删除服务（安全终止 + 产物 + 行）
           │    └─> T6 一键清除服务（取集 + 顺序 + 逐项结果）
           │         └─> T7 HTTP 端点 + registry 登记
           │              └─> T8 前端：引导页 + 首页入口 + 首跑卡片重构
           │                   └─> T9 既有测试锁同步 + e2e/视觉基线
           └─> T10 全量门 + Codex 实现门审查
```

原则：**先让"删得掉"成立，再做界面**。任务删除（T5）是本 RFC 的技术地基——没有它，一键清除对工作流线永久失效，界面做得再好也是假的。

## 2. T0 — 落档与登记

- [x] T0.1 15 路只读调研（首启播种链路 / 五类资源域 / 用户与登录 / 分发 / i18n / 测试门 + 3 批判者）
- [x] T0.2 8 路契约取证（迁移实操 / 创建删除签名 / 权限 / 前端落点 / 测试冲击 / 内容规格 / 清除链路 + 2 对抗复核）
- [x] T0.3 用户拍板 8 项设计决策（预置边界 / 推进方式 / 清除范围 / 是否真跑 / 标记存储 / 引导结构 / 可见性 / 覆盖范围）
- [x] T0.4 写 `proposal.md` / `design.md` / `plan.md`
- [x] T0.5 在 `design/plan.md` 的 RFC 索引表登记 RFC-211；在 `STATE.md` 顶部加"进行中 RFC"行
- [ ] T0.6 **设计门 Codex review** —— 未单独跑。设计前跑了两轮对抗复核（8 路契约取证 + 锚点核验 + 失败模式批判），其产出已折入 design.md §11；实现门 Codex review 见 T10.4。

## 3. T1 — DB 层

- [x] T1.1 手写 `packages/backend/db/migrations/0103_rfc211_onboarding.sql`：五张业务表各 `ADD COLUMN example integer DEFAULT false NOT NULL`；`CREATE TABLE onboarding_runs / onboarding_artifacts`；两个索引。多语句用**独占一行**的 `--> statement-breakpoint`（多行 CREATE TABLE 之后必须用独占行版）
- [x] T1.2 `meta/_journal.json` 追加条目（2 空格缩进，该文件在 `format:check` 范围内）
- [x] T1.3 `packages/backend/src/db/schema.ts`：五张表各加 `example` 列（逐字照抄 `agents.builtin` 形状）+ 两张新表定义。**本仓无 schema↔迁移漂移检测，必须人工逐字对齐**
- [x] T1.4 DTO：`AgentSchema` / `SkillSchema` / `WorkflowSchema` / `WorkgroupSchema` / `TaskSchema` 各加 response-only `example: z.boolean().optional()`；`Create*` / `Update*` 不接受
- [x] T1.5 `migration-0103-rfc211.test.ts`（照 `migration-0102-*` 模板：PRAGMA 验五列 + 两表 + 索引）
- [x] T1.6 同步既有锁：`upgrade-rolling.test.ts` 的 `102 → 103`（标题 + 断言 + 注释链）；冻结库上的 drizzle INSERT 改显式列名裸 SQL（`upgrade-rolling.test.ts` 的 `seedToyAgent`/`seedToyTask`、`rfc189-wg-round.test.ts:86`）
- [x] T1.7 `bun run --filter @agent-workflow/backend db:check` + **完整**后端套件

## 4. T2 — 创建路径支持 private

- [x] T2.1 `createAgent` / `createWorkflow` / `createManagedSkill`(+`WithFiles`) / `createWorkgroup` 的 `opts` 加可选 `visibility?: ResourceVisibility`，插入处 `opts?.visibility ?? 'public'`
- [x] T2.2 回归锁：默认仍是 public（`rfc099-resource-routes.test.ts:134` 不动）；传 `'private'` 时落库为 private

## 5. T3 — 任务 example 派生

- [x] T3.1 三条启动路径在 **INSERT 时**从来源资源派生 `example`：工作流任务 ← `workflows.example`；单 agent 任务 ← `agents.example`；工作组任务 ← `workgroups.example`
- [x] T3.2 **不得**使用 `.update(tasks).set(...)`（S-14 棘轮：`scheduler-audit-s14-tasks-status-blind-write-inventory.test.ts`）
- [x] T3.3 锁：用 example 工作流从 `/tasks/new` 手动启动的任务也带 example 标记（这是 `workflow-in-use` 不再永久阻塞的前提）

## 6. T4 — onboarding service

- [x] T4.1 `services/onboarding.ts`：`startRun` / `getRuns` / `patchRun`（同 track 复用 active run）
- [x] T4.2 后缀生成：`ulid()` 后 8 位 **`.toLowerCase()`**（大写会被四条 name 正则 422）
- [x] T4.3 `provisionStep`：四条线的产物生成（内容规格见 design §7），幂等重入
- [x] T4.4 `adoptResource`：解析 → 不可见 404（与不存在同形）→ `requireResourceOwner` → 同步事务里 `example=1` + `visibility='private'` + `aclRevision+1` + 插 artifact
- [x] T4.5 `diffExampleMarkers` 纯函数 + 对账（半途失败补登记、资源已删则清 artifact）
- [x] T4.6 测试：`rfc211-onboarding-provision.test.ts`（产物过 validator / launch readiness、幂等）、`rfc211-example-marker-consistency.test.ts`

## 7. T5 — example 任务删除（技术地基）

- [x] T5.1 `services/exampleTaskDelete.ts`：**有界重读取消循环**（照 `cancelFusionEngineTask` 的 8 次形状，不要照抄它已作废的注释结论）
- [x] T5.2 子进程确认：逐 node_run 跑 `killStaleRunProcessTree`；`'kill-failed'` ⇒ 该任务 `skipped`、**不删产物**
- [x] T5.3 抢 `claimWorkspacePrune`（避免与 GC / 复活路径三方赛跑）
- [x] T5.4 磁盘产物：scratch / runs / logs / structural-diffs / iso（+ 非 scratch 才走 worktree + snapshot refs）。**一律 `node:fs/promises` 的异步 `rm`**（`rmSync` 会阻塞 Bun 事件循环拖死 daemon）
- [x] T5.5 删行（13 张子表 CASCADE）+ 广播已存在的 `task.deleted`（补 emit 端即可，前端与 ACL 网关已就位）
- [x] T5.6 测试：`rfc211-example-task-delete.test.ts`（取消循环 / kill-failed 跳过 / CASCADE 清单 / 审计表悬挂行**保留**）

## 8. T6 — 一键清除

- [x] T6.1 `collectExamples(db, actor, scope)`：以业务表 `example` 列为准；`scope='all'` 需 `requireAdmin()`
- [x] T6.2 顺序：任务 → 工作组 → 工作流 → 代理 → 技能
- [x] T6.3 工作流删除的 OCC：现读 `version` + 现铸 `ulid()`，冲突重试一次
- [x] T6.4 逐项结果 `ExampleCleanupResult`；部分失败不整批回滚；重试幂等（按当前集合重跑，不做内存批次）
- [x] T6.5 测试：`rfc211-onboarding-cleanup.test.ts`，含**负向**「不碰非 example 资源与非 example 任务的产物」

## 9. T7 — HTTP 端点

- [x] T7.1 `routes/onboarding.ts` 七条端点（design §5）
- [x] T7.2 **逐资源手动复刻两层授权**：`ensurePermission(c, '<res>:write')` + `requireResourceOwner`（`/api/onboarding/*` 不在 `resourcePermissionGate` 射程内，直接调 service 是越权面）
- [x] T7.3 **不新增权限位**（会同时打红 `permission.test.ts` 四条快照锁）
- [x] T7.4 `tests/contracts/registry.ts` 登记 7 条 `EndpointSpec`（两向棘轮）
- [x] T7.5 测试：`rfc211-onboarding-acl.test.ts`（跨用户不可见 / 非 owner 清不到 / admin scope=all 可清）

## 10. T8 — 前端

- [x] T8.1 `src/routes/onboarding.tsx` + `router.tsx` 注册 + `ROUTE_UX_INVENTORY` 登记（**不进侧边栏**）
- [x] T8.2 引导页：`PageHeader` + `ChoiceCards`（四条线）+ `Stepper`（每步双按钮放 children）+ 产物 `Card` + `ConfirmDialog` 清除 + `ErrorDetails` 逐项失败。**零新原语**
- [x] T8.3 `HomepageGreeting` 的 `homepage__cta` 加第三个入口（**不进 `CapabilityGrid` TILES**）
- [x] T8.4 `Onboarding.tsx` 换渲染体（保留三个导出与 props、保留 hero + CapabilityGrid、保持 `.btn--primary` 恰好 1 个）；顺手修正 step4 的过期文案
- [x] T8.5 删除 `fixtures/demo-workflow.ts` 与 `packages/backend/tests/onboarding-demo.test.ts`
- [~] T8.6 「我自己来」深链：`/agents/new` / `/skills/new` 带 `guideRun`+`guideStep`；`/workflows?create=true`；`/workgroups?create=true`（需补 `validateSearch`）；表单页顶部 `NoticeBanner`；保存后调 `adopt`
- [x] T8.7 i18n：`onboarding.*` 命名空间整体重写（三处同步：`Resources` 接口 / `zhCN` 值 / `enUS` 值）
- [x] T8.8 样式：沿用 `.page.onboarding` 根 class（`page-fills-content-width.test.ts:52` 锁 `max-width`）；新 class 走 `.onboarding__*` 命名空间，暗色两侧都声明（`theme-css-ratchet`）
- [x] T8.9 测试：重写 `onboarding.test.tsx`；新增 `onboarding-guide.test.tsx`；`index-page-routing.test.tsx` 文案断言同步；router mock 补 `useNavigate`

## 11. T9 — e2e 与视觉基线

- [x] T9.1 `onboarding.png` 基线重录（darwin 本地，linux 走 `workflow_dispatch` nightly 取 artifact）
- [x] T9.2 首页 CTA 确实改了像素 ⇒ `homepage.png` darwin 已重录；`mobile-home-nav.png` 实测**未变**（CTA 在 390px 下换行到裁剪区外），零churn。**linux 两张待 `workflow_dispatch` nightly 产出**
- [x] T9.3 不适用 —— 本次**没有**新增视觉场景（只重录既有两张），`EXPECTED_VISUAL_SCENE_COUNT` 保持 25。新增的是 a11y 场景（`/onboarding`），a11y spec 无计数锁。
- [x] T9.4 `daemon-start.test.ts` 加负向契约：全新 daemon 起来后五张表 `example` 行数为 0

## 12. T10 — 交付门

- [x] T10.1 `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿
- [x] T10.2 **完整**后端套件（动了 `migrations/`）
- [x] T10.3 `bun run build:binary` 冒烟（触碰共享导出）
- [ ] T10.4 **实现门 Codex review** —— 已发起但**配额耗尽**（`You've hit your usage limit … try again at Jul 25th, 2026`），与 RFC-206 同因。补跑步骤：`git worktree add --detach <tmp> <本 RFC 末次提交>` → 在该 worktree 里 `node ~/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs review --base 3756ee9e --wait`（必须在钉住的 worktree 里跑，否则并发 session 的 diff 会吞掉本 RFC 的改动）。
- [x] T10.5 按本人 exact sha 查 CI（`gh run list --commit <full-sha>`；注意短 sha 过滤会返回空）。前两次 push 的 CI run 被并发 session 的 push 取消，最终以 `41975a5e` 为准。
- [x] T10.6 `STATE.md` 与 `design/plan.md` 状态已更新

## 13. PR 拆分建议

| PR | 内容 | 可独立合并 |
| --- | --- | --- |
| PR-1 | T1 + T2 + T3（DB 层 + private 支持 + example 派生） | 是（纯增量，无行为变化） |
| PR-2 | T4 + T5 + T6 + T7（服务层 + 端点） | 是（后端能力齐备，前端未接） |
| PR-3 | T8 + T9（前端 + 基线） | 依赖 PR-2 |

单 session 连续实施时可合并提交，但 commit message 仍按 `feat(onboarding): RFC-211 PR-N —— …` 前缀分段，便于回溯。

## 14. 验收清单（对齐 proposal §6）

- [x] 全新安装第一个用户看到首跑整页（含唯一主行动「开始引导」）。**第二个用户**改由首页的 per-user 邀请卡覆盖（判据＝该用户自己的引导历史为空，`GET /api/onboarding/runs`），开过任意一条线即自动消失。**与原措辞的差异**：整页首跑仍是实例级判据（不动 `computeIsFirstRun`，它被多条既有测试锁住），per-user 的那份做成了首页卡片而不是整页——双向测试已锁。
- [x] 「帮我建」一次点击产出资源并跳编辑页（服务端 provision，幂等重入）。**「我自己来」实现为深链 + 返回后的 adopt 选择器**，而非「保存后自动打勾」：后者要改四个创建路由并塞引导上下文，而 adopt 走服务端登记，对「几天前建的资源」同样成立。见 T8.6。
- [x] 「帮我建」产物**真能跑通**：工作流过 `validateWorkflowDefinition` 且 `ok:true`；工作组过 launch readiness；代理有非空 outputs
- [x] 产物全部 owner=创建者 / private / 带同 run 短后缀；两人同时跑同一条线零唯一约束冲突且互相不可见
- [x] 一键清除后 example 资源 + example 任务 + worktree/scratch/日志全消失；**非 example 资源一个没动**；重复点击幂等；确认弹窗列出了将删清单
- [x] 清除时在跑的引导任务被先取消再删，不留孤儿进程与孤儿 worktree（`kill-failed` 则拒删产物并如实上报）
- [x] `onboarding_artifacts` 与业务表 `example` 列两处一致（`diffExampleMarkers` 纯函数 + 清除后双向归零）
- [~] 启动前探测运行时 —— 文案（`guide.runtimeUnready`）已就位，**接线待补**：引导的「跑一次」目前深链到 /tasks/new 由用户启动，尚未在引导内前置调 `GET /api/runtimes/status`。
- [x] 四件套全绿；darwin 视觉基线已刷；linux 待 nightly 回填（T9.2）
