# RFC-214 任务分解与 PR 拆分

> 范围：用户拍板**全量清扫**——原语 + 全仓约 83 处手写 retry + 查询三态空态迁移。涉及约 89 个文件（`grep -lE "\.retry'|common\.retry|className=\"muted\""` 命中集；其中 `muted` 仅**空态子集**是目标，大量 muted 提示小字不动）。按域分 5 个 PR，单 RFC 对应一组 PR（design.md §6 多人并行纪律）。

## 任务列表

| 任务 | 内容 | 依赖 | PR |
|---|---|---|---|
| **T1** | `ErrorBanner` 加 `onRetry?`/`retryLabel?`：`action` 缺省时渲染 `.btn.btn--sm` 重试按钮进 `action` 槽（design.md §1.1）。`action` 显式传入时优先，保 RFC-203 零涟漪。**含 MAJOR-5**：`hasAction`/className 改基于 `resolvedAction` 重算（onRetry-only 不丢 `error-banner--with-action`） | — | PR-1 |
| **T2** | 新建 `components/QueryState.tsx`（design.md §1.2）：loading(**`isLoading` 优先**,MAJOR-4)→error(onRetry=refetch)→**`keepDataOnError` 叠加档**(BLOCKER-1)→empty(两档,默认轻量)→data(render-prop) | — | PR-1 |
| **T3** | `error-banner-retry.test.tsx` + `query-state.test.tsx`（design.md §5.1 全部 case，含 disabled 查询不转圈 / keepDataOnError 叠加 / onRetry-only with-action class） | T1,T2 | PR-1 |
| **T4** | 迁移 `components/home/*`（4）+ `components/memory/*`（8）。**BLOCKER-1**：memory 面板**必须传 `keepDataOnError`**，迁移后 `memory-panels-async-state.test.tsx` 的「保留缓存行」断言仍绿（不是「DOM 不变大概率绿」）；home 按钮 `.btn--xs → .btn--sm`（唯一 xs 查询 retry，只在 error 态可见，多半无需刷基线，见 design.md §5.3） | T1,T2 | PR-2 |
| **T5** | **收编列表页三壳**（MAJOR-6，非「迁移手写三态」）：`ResourceSplitPage`（`:344-347`→`:389`）/ `ResourceGalleryPage`（`:95-98`→`:123`）/ `tasks.preview.tsx` RetryAction 内部改用 `ErrorBanner.onRetry`（它们已 sm+common.retry，收编＝内部简化，消灭第 4 个并存 gate）。agents/skills/mcps 等**本就走壳**、随收编自动统一 | T4 | PR-3 |
| **T6** | 迁移**详情页 + 其余组件**：`routes/*.detail.tsx` / `*.by-id.tsx` + `components/{workgroup,review,node-session,launch,tasks,agents,clarify}/*`（**排除** `components/canvas/**` xyflow 区 + `NodeDetailDrawer`，carve-out）；`SkillFileTree.tsx` / `Onboarding.tsx` / `WorkflowImportDialog.tsx` / `components/shell/*`。注意 `enabled` 门控查询用 `isLoading`（MAJOR-4 已在原语兜底） | T4 | PR-4 |
| **T7** | i18n 键收敛：把 `home.section.error.retry` 等各域**查询** retry 键统一走默认 `common.retry`（或经 `retryLabel` 保留有意差异）；**不新增 key**；中英双 bundle 同步。**不碰 mutation retry 键** | T4-T6 | 随各 PR |
| **T8** | 落**源码守卫** `async-state-gate-source-guard.test.ts`（design.md §5.2，**结构信号 + 组件锚点，非文案子串**）：锁 A 禁非白名单文件手写 `<button onClick>…refetch()`（不碰 `mutation.mutate()`）；锁 B 约束显式空态键清单只经 QueryState 呈现；白名单 = 文件 + i18n 键级，`canvas/**` 与 `NodeDetailDrawer` carve-out，枚举 mutation-retry 豁免文件。前置：T4-T6 把命中集清到只剩白名单 | T4,T5,T6 | PR-5 |

## PR 拆分建议

- **PR-1｜原语**（T1+T2+T3）：只加两个组件 + 单测，零调用点迁移。风险最低，先合。
  - 验收：新单测全绿；`ErrorBanner` 既有调用点（RFC-203 的 22+3 处）**零 diff**、CI 原样绿；typecheck/test/format/vitest/单二进制冒烟全绿。
- **PR-2｜home+memory 试点**（T4）：density 最高、含派生空态与 memory stale-data 锁，先验证迁移范式 + `keepDataOnError` + 既有锁适配。
  - 验收：`memory-panels-async-state.test.tsx` 的「刷新失败保留缓存行」断言**迁移后仍绿**（memory 传 `keepDataOnError`）；home xs→sm error 态截图核对（多半无需刷基线）。
- **PR-3｜收编列表三壳**（T5+T7 分片）。验收：三壳内部改用 `ErrorBanner.onRetry`，其上层 agents/skills/mcps 列表页 page-wiring 测试原样绿；三壳暂入 §5.2 白名单待 PR-5 收口。
- **PR-4｜详情页 + 组件清扫**（T6+T7 分片）。验收：`canvas/**` 与 `NodeDetailDrawer` carve-out 并在 PR 描述点名；review/clarify/workgroup 三态迁移；`enabled` 门控查询不误转圈。
- **PR-5｜上锁**（T8）：命中集清零后翻开源码守卫。验收：守卫全绿且**四条变异各自必红**——① 非白名单文件手写 `<button onClick>…refetch()`；② 显式空态键清单里的键被手拼进 `<div className="muted">`；③ 绕过 QueryState 手拼 loading→error→empty 三态级联；④ 新增查询 retry 键但不走 `ErrorBanner.onRetry`/QueryState。（图标按钮 / `<Trans>` retry 属锁的已知盲区，design.md §5.2 已声明。）

> 每个 PR：`bun run typecheck && bun run test && bun run format:check` + 前端 vitest 全套 + 单二进制冒烟；push 后按 [feedback_post_commit_ci_check] 查 CI。提交按精确路径 `git commit -- <paths>`，绝不 `git add -A` / `--amend`。

## 验收清单（整 RFC）

- [ ] AC1 `ErrorBanner.onRetry` → `.btn.btn--sm` 重试按钮；`action` 优先（向后兼容锁）
- [ ] AC2 `QueryState` loading(`isLoading` 优先/disabled 不转圈)→error(retry)→empty→data；`data` 支持派生值；`isEmpty` 可自定义
- [ ] AC3 `emptyText`→muted 行；`empty`→重量级；都无→`null`
- [ ] AC4 `keepDataOnError` 叠加档（memory 缓存行契约）
- [ ] AC5 onRetry-only 时 `error-banner--with-action`（flex 不回归）
- [ ] AC6 源码守卫：结构信号锁 A（禁手写 `<button onClick>…refetch()`，不碰 mutation）+ 组件锚点锁 B（空态键走 QueryState）；文件+键级白名单；canvas/NodeDetailDrawer carve-out
- [ ] AC7 全量迁移后所有门 + 前端 vitest + 单二进制 + 视觉基线全绿（逐 PR）
- [ ] AC8 RFC-203 7 锚点原样绿 / `memory-panels-async-state` 保留缓存行断言迁移后仍绿 / `empty-state` 原样绿
- [ ] 单测：disabled 不转圈 + keepDataOnError 叠加 + onRetry-only with-action + 派生空 + action 优先 + 四条变异必红
- [ ] STATE.md 完工后置 Done、plan.md RFC 索引状态更新

## 风险与缓解（承接 design.md §4/§6）

1. **前端跑 vitest 非 `bun test`**——每 PR 单独跑前端全套，别被本地 `bun test` 绿骗过（[project_frontend_i18n_batch]）。
2. **RFC-203/198/035 测试锁**——迁移只改断言不删测试，注释写明 RFC-214 意图（[feedback_dont_delete_others_code_for_ci]）。
3. **home 视觉变化**（xs→sm）——唯一可见变更，PR-2 亮/暗截图 + 基线刷新（[reference_visual_baseline_stale_binary]）。
4. **canvas 排除**——xyflow 节点渲染内部的 muted 不在本 RFC；PR-4 描述显式点名，避免 reviewer 误判漏迁。
5. **多 query 联合点**——不硬套 QueryState，白名单豁免并注释，防 API config 地狱。
6. **门禁流程**（走 CLAUDE.md）：三件套 → **Codex 设计门 review**（配额恢复后，[feedback_codex_review_after_changes]）→ 用户批准 → 实现 → **Codex 实现门 review** → 每 PR CI 查绿。
