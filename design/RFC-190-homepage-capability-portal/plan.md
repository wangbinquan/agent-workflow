# RFC-190 · 任务分解（v2：设计门 P1-7/P2-5 折入——测试随任务落地、门禁命令完整化）

单 PR（RFC 默认）；commit 前缀 `feat(home): RFC-190 …`。每个任务的测试是任务本体的一部分（无「先实现后补测」段）。

| # | 任务（含测试） | 依赖 | 验收 |
| --- | --- | --- | --- |
| T1 | shared：`schemas/overview.ts`（三 schema）+ `index.ts` 导出 | — | `bun run typecheck` 绿 |
| T2 | backend：`services/overview.ts`（`buildOverview(db, actor, now=Date.now)`）+ `countCachedRepos` + 抽单源（`canViewScheduledTask` → `services/scheduledTasks.ts`；`taskVisibilityCondition` → `services/task.ts`，`listTasks` 改用）+ `routes/overview.ts` + `server.ts` 挂载 + **contracts/registry.ts 登记（happy fixture + 匿名 401）**；**同任务落** `tests/rfc190-overview-route.test.ts`（design §4.1 全部五组：口径 oracle × 3 actor / 固定时钟 7d 三点边界 / 权限真值表单元 / registry / generatedAt） | T1 | `bun test rfc190` + `api-contract-coverage` + scheduled/tasks 既有套件全绿 |
| T3 | frontend 基础：i18n 新键三处同改（design §3.8）+ `useOverview` hook + `Card` 加 `to` prop（含 Card 回归测试：div 用法不变 + Link 根渲染）+ `resourceIcons.tsx` 增 5 图标 | T1 | i18n symmetry + `card.test.tsx` 增量绿 |
| T4 | frontend：`PipelineHero.tsx`（含聚合节点）+ `.pipeline-hero` 样式（三动画 selector + reduce-motion 逐 selector 关断）+ `HomepageGreeting.tsx` 原地演进（hero 布局 + 脉搏行 + 新建工作流 CTA）；**同任务落** `pipeline-hero.test.tsx`（aria-hidden / aw-pipe id / aggregate 文案 / reduce-motion 源级三 selector 锁） | T3 | 新测试 + `homepage-runtime-status` 源级锁绿 |
| T5 | frontend：`CapabilityGrid.tsx`（六卡复用 Card + agents 副行 + null→「—」+ intro 变体）+ `.home-cap*` 布局样式 + `/memory` 路由 `tab` search 深链；**同任务落** `capability-grid.test.tsx`（计数/「—」/href 含 `?tab=all`/副行/intro 零请求）+ `/memory` 深链路由测试 | T3 | 新测试绿、memory 既有测试不红 |
| T6 | frontend：`TaskFeed.tsx`（单卡三子分组恒渲染，锁保持）+ `Homepage.tsx` 重排 + 删除 `HomepageSection.tsx`；**同任务迁移** `homepage.test.tsx`（增 `/api/overview` mock 分支，既有断言原样）+ `index-page-routing.test.tsx`（合法 overview fixture） | T4,T5 | 两测试文件全绿（断言强度不降） |
| T7 | frontend：Onboarding 翻新（hero + intro 网格 + heroTitle/heroIntro；四步/导入/skip 锁不动；max-width 960）；**同任务迁移** `onboarding.test.tsx` 增量 | T4,T5 | 既有断言不动、增量绿 |
| T8 | 全量交叉回归 sweep：前端 vitest 全量 + 后端 `bun test` 全量 + 漏锁补查（grep 新 symbol 的既有引用） | T2,T6,T7 | 双端全绿 |
| T9 | 视觉验证：dev server + Chrome 截图 **light / dark / 窄屏** 三态，与 /agents /workflows 并排对齐自查（feedback_frontend_visual_verify_repro） | T6,T7 | 截图存档、无视觉孤岛 |
| T10 | e2e：visual/a11y 拆两用例（空库 Onboarding 基线更名 + 种子后 Homepage 新基线，均含 axe）；darwin 本地 `RUN_VISUAL_REGRESSION=1 bun run e2e e2e/visual-regression.spec.ts --update-snapshots` 刷新；linux 按 `e2e/visual-regression.README.md` nightly 流程；`nav-redesign` 零改动跑绿 | T9 | e2e 相关 spec 绿、新旧 PNG 同 PR |
| T11 | 实现门：Codex review（detached worktree 定 commit）→ 完整门禁 `bun run typecheck && bun run lint && bun run test && bun run format:check` + `bun run build:binary` smoke → 精确 pathspec 一步提交 + push → 按本 commit sha 查 GitHub Actions | T8,T10 | 门禁与 CI 全绿 |
| T12 | 收尾（docs-only 后续提交）：`design/plan.md` 索引与 `STATE.md` 置 Done、验收清单勾选，推送后再看一轮 CI（实现 SHA 与状态 SHA 分离验证，设计门 P2-5） | T11 | 状态提交 CI 绿，RFC 记 Done |

## 验收清单（对 proposal §5 的映射）

- [ ] 首页 hero（含聚合节点）/六卡/任务动态结构 = proposal §5 条目 1（T4-T6）
- [ ] overview 契约（权限真值表 + 时钟注入）与 ACL 口径 oracle + contract registry = 条目 2（T1-T2）
- [ ] 卡片跳转表（含 `/memory?tab=all` 深链） = 条目 3（T5）
- [ ] Onboarding 翻新 = 条目 4（T7）
- [ ] 零依赖动画 + reduce-motion 逐 selector + 双主题 + 窄屏 = 条目 5（T4、T9）
- [ ] i18n 双语 = 条目 6（T3）
- [ ] 测试全绿 + 基线拆分刷新 = 条目 7（T2、T6-T8、T10-T12）
