# RFC-005 Plan — 实施任务分解

> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
>
> **PR 拆分建议**：5 个 PR。本 RFC 体量显著大于 RFC-001~004，单 PR 不可行；按"schema → 运行时 → 渲染 → 评审交互 → diff+收尾"五层切，每个 PR 自带完整测试 + 文档同步，CI 全绿单独可合。

## 0. 前置

- 用户已经在对话中批准本 RFC（ExitPlanMode 通过）。
- 在 `STATE.md` 顶部追加 `"进行中 RFC：[RFC-005](./design/RFC-005-human-review/proposal.md)"` 一行。
- `design/plan.md` RFC 索引追加 `RFC-005` 行，状态 `In Progress`。
- 由 PR1 开 branch；后续 4 个 PR 各自基于前一个的合并提交起新 branch。**不要拉长 branch 链**——每个 PR 合 main 后立即基于 main 开下一个。

## 1. PR 切分总览

| PR | 范围 | 关键交付 |
| --- | --- | --- |
| **PR-A** | Schema + Migration + Validator | shared schemas / DB 0002 migration / workflow validator 新规则 |
| **PR-B** | Runtime（scheduler / prompt / envelope / review service / REST / WS） | 后端全套 review 业务逻辑 + REST + WS 事件 |
| **PR-C** | Markdown 渲染管线 + Settings Rendering | `MarkdownView`、`PlantUmlBlock`、worktree files proxy、Settings 新 tab |
| **PR-D** | 评审交互（路由 / 侧栏 / 选词 / 草稿 / canvas 节点） | `/reviews/*` 路由、`CommentSidebar` / `CommentPopover`、`ReviewNode`、`NodeInspector` review 分支、Reviews tab + badge |
| **PR-E** | DiffView + e2e + 文档 + 收尾 | `DiffView` 三档粒度 + 标题锚滚动联动、`e2e/review.spec.ts`、`design/design.md` 同步、STATE 收尾 |

## 2. 任务清单

### PR-A：Schema + Migration + Validator

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-005-T1 | shared schemas：`workflow.ts` NODE_KIND 加 `review` + `WORKFLOW_SCHEMA_VERSION=2` + `ReviewNodeSchema`；`agent.ts` `outputs` 升级支持 `{name, kind}`；`task.ts` 状态枚举加 `awaiting_review`；新增 `schemas/review.ts`（DocVersion / ReviewComment / ReviewDecision）；`ws.ts` 加 4 个 review.* event；`config.ts` 加 `plantumlEndpoint?` / `plantumlAuthHeader?` | `packages/shared/src/schemas/*.ts`、`tests/schemas/review.test.ts`（新） | — |
| RFC-005-T2 | DB schema：`tasks.status` + `node_runs.status` enum 加 `awaiting_review`；`node_runs` 加 `review_iteration`；新表 `doc_versions` + `review_comments` + 索引；`bun run drizzle-kit generate` 产 `0002_*.sql`；migration test 用 0001 后的 v1 SQLite 文件跑 0002 → schema 一致 + 数据完整 | `packages/backend/src/db/schema.ts`、`packages/backend/db/migrations/0002_*.sql`、`packages/backend/tests/migration-0002.test.ts`（新） | T1 |
| RFC-005-T3 | Workflow validator 新规则：`review-input-source-missing` / `review-input-source-not-markdown` / `review-rerunnable-out-of-scope` / `review-rerunnable-empty-on-reject`(warning)；agent outputs 升级允许裸 string 也接受新 object form；6 case 测试 | `packages/backend/src/services/workflow.validator.ts`、`packages/backend/tests/workflow-validator.test.ts` | T1 |
| RFC-005-T4 | schema_version v1 → v2 自动 migrator：workflow GET 路径上检测 `$schema_version === 1` 时透明上提（v1 没 review 节点，纯字段追加无风险）；写回 DB 走既有 1s auto-save；3 case 测试 | `packages/backend/src/services/workflow.ts`（或 routes/workflows.ts，按现状）、`tests/workflow-schema-migrate.test.ts`（新） | T1, T3 |
| RFC-005-T5 | PR-A 收尾：`bun run typecheck && bun run test && bun run format:check` 全绿；commit + push；按 [feedback_post_commit_ci_check] 守 GH Actions | — | T2, T4 |

### PR-B：Runtime（review 业务逻辑）

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-005-T6 | `services/review.ts`（新文件）：`createReviewInstance` / `submitDecision` / `addComment` / `deleteComment` / `archiveCommentsForVersion` / `mergeIteratePortIntoLatest` / `cascadeSiblingInvalidation` 一组函数；纯函数尽量提前抽出便于测；20+ case | `packages/backend/src/services/review.ts`、`tests/review-state-machine.test.ts`（新）+ `tests/review-iterate-partial-merge.test.ts`（新）+ `tests/review-sibling-invalidation.test.ts`（新） | PR-A |
| RFC-005-T7 | `scheduler.ts` review dispatch + state 转移：node 完成时如果是 review 节点 → 落 doc_version + status=awaiting_review；接收 review decision → 触发上游 rollback + re-run；task-level `recomputeTaskStatus` 加 awaiting_review 分支；5 case 测试 | `packages/backend/src/services/scheduler.ts`、`tests/scheduler-review-dispatch.test.ts`（新） | T6 |
| RFC-005-T8 | `services/prompt.ts` 加 `{{__review_rejection__}}` / `{{__review_comments__}}` / `{{__iterate_target_port__}}` 三 builtin token；未引用追加章节；commentInjectTemplate 覆写优先级；源代码层兜底 grep 测试（防 token rename） | `packages/backend/src/services/prompt.ts`、`tests/review-prompt-injection.test.ts`（新） | T6 |
| RFC-005-T9 | `services/envelope.ts`（或同等位置）`resolvePortContent` 加 markdown_file 分支：读 worktree 相对路径 + path traversal 防护；md / string 路径不变；5 case 含攻击向量测试（`../`、绝对路径、symlink escape） | `packages/backend/src/services/envelope.ts`、`tests/envelope-parse-md-edge-cases.test.ts`（新） | T1 |
| RFC-005-T10 | `services/review.ts` anchor 校验 + occurrence_index 计算（backend 写 review_comment 时回填 occurrence_index 防客户端伪造）；3 case | `packages/backend/src/services/review.ts`、`tests/review-anchor-disambiguation.test.ts`（新） | T6 |
| RFC-005-T11 | REST `routes/reviews.ts`：6 个 endpoint（list / pending-count / detail / versions / decision / comments POST + DELETE）；乐观锁 `If-Match: review_iteration`；token 鉴权 / 7 case integration test | `packages/backend/src/routes/reviews.ts`（新）、`tests/routes-reviews.test.ts`（新） | T6, T7 |
| RFC-005-T12 | WS：`/ws/workflows` 加 review.created / decision_made / comment_added / comment_deleted 四 broadcast 路径；`tests/ws-review.test.ts` 4 case | `packages/backend/src/routes/ws.ts`（或现有 ws 文件） | T11 |
| RFC-005-T13 | 后端图片代理 `GET /api/worktree-files/:taskId/*`：限 GET / 限 worktree 内 / path traversal 防护；3 case 含攻击向量 | `packages/backend/src/routes/worktree-files.ts`（新）、`tests/worktree-files-proxy.test.ts`（新） | — |
| RFC-005-T14 | multi-process fanout 下的 review：scheduler 对 multi-process 上游 + review 下游，按 shard 自动 fan out review 实例；2 case（shard 全成 / 部分失败仅成功 shard 进 review） | `packages/backend/src/services/scheduler.ts`、`tests/review-multi-process-fanout.test.ts`（新） | T7 |
| RFC-005-T15 | wrapper-loop 内含 review 节点：每轮 iteration 落独立 doc_version；exit_condition 命中 approve；2 case | `tests/review-loop-nesting.test.ts`（新）（实现复用 T7） | T7 |
| RFC-005-T16 | PR-B 收尾：`typecheck && test && format:check` 全绿；commit + push；守 GH Actions；backend +25 case 达成 | — | T6-T15 |

### PR-C：Markdown 渲染管线 + Settings Rendering tab

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-005-T17 | `MarkdownView` 渲染管线：remark + remark-gfm + remark-math + rehype-katex + rehype-shiki + 自定义 rehype-mermaid（客户端） + 自定义 rehype-plantuml（外部端点）；DOMPurify 净化所有 SVG；图片相对路径解析走 `${API_BASE}/api/worktree-files/...`；6 case 测试 | `packages/frontend/src/components/review/MarkdownView.tsx`（新）、`tests/MarkdownView.test.tsx`（新） | PR-A 合并 / 后端 T13 |
| RFC-005-T18 | `PlantUmlBlock`：kroki GET 失败 fallback POST raw source；endpoint 未配置 → 源码 + muted 提示；3 case（GET 成 / GET 失 POST 成 / 两者都失败显错误 + 源码） | `packages/frontend/src/components/review/PlantUmlBlock.tsx`（新）、`tests/plantuml-block.test.tsx`（新） | T17 |
| RFC-005-T19 | Settings 新 tab "Rendering"：`plantumlEndpoint` + `plantumlAuthHeader` 两 input + 测试连通性按钮（POST `@startuml\nA->B\n@enduml` 看返回有无 `<svg`）；2 case | `packages/frontend/src/routes/settings.tsx`、`tests/settings-rendering-tab.test.tsx`（新） | T18 |
| RFC-005-T20 | i18n 加 `review.*` section（约 30 条 key，PR-C 用到的部分：plantuml endpoint hint / not configured fallback / settings rendering tab label/hint）；i18n 双语完整性测试 1 case | `packages/frontend/src/i18n/zh-CN.ts`、`en-US.ts`、`tests/i18n-phase-rfc005-c.test.ts`（新） | T17-T19 |
| RFC-005-T21 | PR-C 收尾：typecheck/test/format 全绿；commit + push；守 GH Actions；frontend +9 case 达成 | — | T17-T20 |

### PR-D：评审交互（路由 / 侧栏 / 选词 / 草稿 / canvas 节点）

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-005-T22 | `lib/review/anchor.ts` 纯函数：`makeAnchor` / `findOccurrenceIndex` / `reanchorInVersion` 四层 fallback；8 case 含重名 / 跨段落 / orphan | `packages/frontend/src/lib/review/anchor.ts`（新）、`tests/lib-review-anchor.test.ts`（新） | — |
| RFC-005-T23 | `lib/review/draftStore.ts`：IndexedDB 经 idb-keyval（已在 deps 或新添）；getDraft / setDraft / deleteDraft / listDrafts；3 case | `packages/frontend/src/lib/review/draftStore.ts`（新）、`tests/lib-review-draft-store.test.ts`（新） | — |
| RFC-005-T24 | `CommentPopover` 组件：textarea + 提交 / 取消 + Esc / 点外关闭保留 draft；3 case | `packages/frontend/src/components/review/CommentPopover.tsx`（新）、`tests/CommentPopover.test.tsx`（新） | T22, T23 |
| RFC-005-T25 | `CommentSidebar` 组件：按 anchor 位置排序 + IntersectionObserver scroll-spy 双向 + delete + 历史只读样式；4 case | `packages/frontend/src/components/review/CommentSidebar.tsx`（新）、`tests/CommentSidebar.test.tsx`（新） | T22 |
| RFC-005-T26 | `/reviews` 全局路由：`useQuery(['reviews','list'], filter)` + segmented filter + 按 task 分组 + 按节点拓扑序 + 未读 badge；3 case | `packages/frontend/src/routes/reviews.tsx`（新）、`tests/reviews-tab.test.tsx`（新） | PR-B 合并 / T22 |
| RFC-005-T27 | `/reviews/:nodeRunId` 详情页：MarkdownView + CommentSidebar + 三按钮 + 历史下拉 + worktree 修改 banner；approve 时 draft 数 > 0 弹 modal；reject 弹只读 rerunnable list modal；4 case | `packages/frontend/src/routes/reviews.detail.tsx`（新）、`tests/review-detail-route.test.tsx`（新） | T17, T24, T25, T26 |
| RFC-005-T28 | 左栏 `__root.tsx` 加 Reviews nav 项 + `useQuery(['reviews','pending-count'])` badge + WS 订阅刷新；1 case | `packages/frontend/src/routes/__root.tsx`、`tests/root-reviews-badge.test.tsx`（新） | T26 |
| RFC-005-T29 | Canvas：`nodePalette.ts` 加 "Human" 分类 + review 节点条目；`nodes/ReviewNode.tsx` 视觉（4 态色块）；`NodeInspector.tsx` review 分支：title / description / inputSource (nodeId + portName select) / rerunnableOnReject 多选 / rerunnableOnIterate 多选 / rollbackFilesOnReject Switch / rollbackFilesOnIterate Switch / commentInjectTemplate textarea；6 case | `packages/frontend/src/components/canvas/nodePalette.ts`、`nodes/ReviewNode.tsx`（新）、`NodeInspector.tsx` 加分支、`tests/canvas-review-node.test.tsx`（新）、`tests/node-inspector-review.test.tsx`（新） | T1 |
| RFC-005-T30 | 多 tab WS 同步 review 事件：`hooks/useReviewWs(nodeRunId)` + 自动重连 + since-id 续传；invalidate 相关 query；2 case（comment_added + decision_made 实时反映） | `packages/frontend/src/hooks/useReviewWs.ts`（新）、`tests/use-review-ws.test.tsx`（新） | T12, T27 |
| RFC-005-T31 | 键盘快捷键全集：`A/R/I` 三按钮 / `J/K` comment 跳转 / `Ctrl+Enter` 提交 popover / Esc 关闭 popover；2 case | `packages/frontend/src/routes/reviews.detail.tsx` 内 + 单独 hook `useReviewHotkeys`、`tests/review-hotkeys.test.tsx`（新） | T27 |
| RFC-005-T32 | i18n PR-D 部分约 30 key（review section / detail page / sidebar / popover / canvas review node）；双语完整性测试 1 case | `packages/frontend/src/i18n/zh-CN.ts`、`en-US.ts`、`tests/i18n-phase-rfc005-d.test.ts`（新） | T22-T31 |
| RFC-005-T33 | PR-D 收尾：typecheck/test/format 全绿；commit + push；守 GH Actions；frontend +25 case（累计 +34 与 PR-C 一起） | — | T22-T32 |

### PR-E：DiffView + e2e + 文档 + 收尾

| ID | 描述 | 关键文件 | 依赖 |
| --- | --- | --- | --- |
| RFC-005-T34 | `DiffView` 组件：左右两列 + 顶部粒度切换（词 jsdiff + Intl.Segmenter / 行 jsdiff / 节点 remark AST）；标题锚滚动联动；左侧旧 comments 只读 + 右侧可写新 comments；4 case | `packages/frontend/src/components/review/DiffView.tsx`（新）、`tests/DiffView.test.tsx`（新） | PR-D 合并 |
| RFC-005-T35 | review 详情页接 DiffView：v(n-1) vs v(n) toggle + 历史版本下拉切换 + Ctrl+1/2/3 切粒度；2 case | `packages/frontend/src/routes/reviews.detail.tsx` 更新、`tests/review-detail-diff.test.tsx`（新） | T34 |
| RFC-005-T36 | `e2e/review.spec.ts`：fixture 用 stub-opencode 返三种 envelope（v1 / v2-after-reject / v3-after-iterate），跑通：建 workflow（input → designer agent outputs markdown → reviewDesign）→ launch → 进 review 页 → reject 写理由 → review 重新 awaiting v2 → iterate 写选词意见 → review 重新 awaiting v3 → approve → task done | `e2e/review.spec.ts`（新）、`e2e/fixtures/stub-opencode-review.sh`（新 fixture）、`e2e/harness.ts` 扩展 | T35 |
| RFC-005-T37 | `design/design.md` 同步：§3 数据模型加 doc_versions + review_comments 表段 + review_iteration 字段说明；§5 加 review 节点 schema；§9 节点状态机加 awaiting_review；§11 配置表加 plantumlEndpoint + plantumlAuthHeader；§4.3 WS 频道加 review.* event；§7.4 envelope 解析加 kind 分支说明 | `design/design.md` | T35 |
| RFC-005-T38 | `STATE.md` 收尾：删"进行中 RFC"行；在"已完成 RFC"表追加 RFC-005 行（关键产出按 RFC-001~004 那种密度写）；更新"最近更新"日期；`design/plan.md` RFC 索引 RFC-005 状态改 `Done` | `STATE.md`、`design/plan.md` | T36, T37 |
| RFC-005-T39 | PR-E 收尾：`typecheck && test && format:check && build:binary smoke` 全绿；commit + push；守 GH Actions e2e job 全绿 | — | T34-T38 |

## 3. 执行顺序（依赖图）

```
PR-A:
  T1 (shared schemas) ─┬─ T2 (DB migration)
                       ├─ T3 (validator)
                       ├─ T4 (schema_version migrator)
                       └─ T5 (CI green)

PR-B:
  T6 (review service) ─┬─ T7 (scheduler)
                       ├─ T8 (prompt)
                       ├─ T10 (anchor backend)
                       ├─ T11 (REST)
                       │     └─ T12 (WS)
                       ├─ T14 (multi-process fanout)
                       └─ T15 (loop nesting)
  T9 (envelope)
  T13 (worktree files proxy)
  T16 (CI green)

PR-C:
  T17 (MarkdownView) ── T18 (PlantUmlBlock) ── T19 (Settings tab)
                                                  └─ T20 (i18n) ── T21 (CI green)

PR-D:
  T22 (anchor lib)
  T23 (draft store)
        └─ T24 (CommentPopover)
        └─ T25 (CommentSidebar)
              └─ T26 (/reviews route)
                    └─ T27 (/reviews/:id detail)
                          └─ T28 (left nav badge)
                          └─ T30 (WS hook)
                          └─ T31 (hotkeys)
  T29 (canvas review node + inspector) ── 独立可并行
        └─ T32 (i18n) ── T33 (CI green)

PR-E:
  T34 (DiffView) ── T35 (detail diff integration) ── T36 (e2e) ── T37 (docs) ── T38 (STATE) ── T39 (CI green)
```

PR-A 内部 T1 是 critical path；T3 / T4 可在 T1 后并行起。
PR-B 内部 T6 是 critical path（review service）；T7 / T8 / T10 / T11 都依赖 T6 但相互并行；T9 / T13 独立；T14 / T15 在 T7 后并行。
PR-C 内部线性。
PR-D 内部 T22 / T23 / T29 三条线在最前，可并行。
PR-E 内部线性。

## 4. 验收清单（对齐 proposal §4）

### 功能（对齐 proposal §4 功能段）

- [ ] **A1** input → designer → reviewDesign 三节点工作流 e2e（PR-E T36）。
- [ ] **A2** reject 回滚 + 重跑 + 新 doc_version_v2（PR-B T6/T7 + e2e T36）。
- [ ] **A3** iterate 部分接受合并（PR-B T6 `review-iterate-partial-merge.test.ts`）。
- [ ] **A4** multi-process fanout review 实例（PR-B T14）。
- [ ] **A5** anchor occurrence_index 单义（PR-B T10 + PR-D T22）。
- [ ] **A6** diff view 滚动联动 + 粒度切换（PR-E T34/T35）。
- [ ] **A7** comment sidebar 双向 scroll-spy（PR-D T25）。
- [ ] **A8** plantuml 外部端点 + 错误降级（PR-C T18/T19）。
- [ ] **A9** Reviews 全局 tab + 未读 badge（PR-D T26/T28）。
- [ ] **A10** 多 tab WS 同步（PR-B T12 + PR-D T30）。
- [ ] **A11** schema v1 → v2 透明 migrator（PR-A T4）。
- [ ] **A12** draft IndexedDB 关 tab 恢复（PR-D T23/T24）。
- [ ] **A13** worktree 外部修改 banner + approve 二次确认（PR-D T27）。

### 非功能

- [ ] **B1** 三命令全绿（每 PR 末尾 Tx）。
- [ ] **B2** RFC-001~004 测试无退化（每 PR diff 不动既有 spec 文件）。
- [ ] **B3** backend tests +25（PR-A 10 + PR-B 15）。
- [ ] **B4** frontend tests +34（PR-C 9 + PR-D 25）。
- [ ] **B5** Playwright `e2e/review.spec.ts` 跑通（PR-E T36）。
- [ ] **B6** 单二进制构建包体积不退化（PR-E T39 build smoke）。

### 回归防护

- [ ] **C1** `review-anchor-disambiguation.test.ts` 顶部注释链回本 RFC + B2 anchor contract（PR-B T10）。
- [ ] **C2** `review-iterate-partial-merge.test.ts` 顶部注释 + L2 partial-merge contract（PR-B T6）。
- [ ] **C3** `review-sibling-invalidation.test.ts` 顶部注释 + A2 sibling cascade（PR-B T6）。
- [ ] **C4** 源代码层文本断言：grep `{{__review_rejection__}}` + `{{__review_comments__}}` 在 prompt.ts（PR-B T8）。

## 5. 风险与回滚

| 风险 | 缓解 | 回滚路径 |
| --- | --- | --- |
| schema v2 migrator 在生产 v1 数据上失败 | T2 强制 migration test 用真实 v1 数据文件；上线前在自己机器跑过一次完整 migration | drizzle migration 0002 可直接 down（drizzle-kit 生成的 down SQL 保留） |
| iterate 部分接受语义在并发上游下错乱 | T6 把 merge 函数纯函数化；高并发不可能（同 task 单 daemon 串行调度） | 单 PR revert PR-B |
| PlantUML 端点上线后被滥用为代理 | T19 只在 Settings 配置；不暴露给非 Authenticated 路径 | revert PR-C；老 plantuml 块自动回到源码渲染 |
| 选词浮窗在大 md 上卡顿 | T17 / T24 异步 / debounce；大 md（>50KB）测试 | revert PR-D；用户仍能用旧 task 系统其它路径 |
| WS 多 tab 同步丢事件 | T30 hook 每次重连 refetch 当前 review 详情 | WS 仍有现有路径兜底（轮询 /api/reviews/:id） |
| `0002_*.sql` 在 SQLite enum 重建路径上 lose data | T2 必须用 `INSERT INTO __new__ SELECT * FROM old` 模式（drizzle 默认就是这种）；测试断言 v1 task 行 + node_run 行迁移后字段不变 | drizzle migration 0002 down |
| PR-D / PR-E 切到 main 时 PR-B / PR-C 已合，但 schema 漂移 | PR 间合并是顺序的；每个 PR 拉新 branch 时 rebase 最新 main | 单 PR revert |
| GPL 风险（PlantUML） | RFC-005 不内嵌 jar；只调外部端点；端点是用户自配（自托管 / kroki.io / plantuml-server）；产品 binary 完全 GPL-free | 无需 |

## 5b. Followup（已落地，inline，不另开 RFC）

- [x] **F1** envelope `markdown_file` 严格分支放宽：绝对路径在 worktree 内即可（agent cwd = worktree，`pwd` 自然产出绝对路径）。仅 `markdown-file-escapes-worktree` 仍抛 ValidationError。Tests: `envelope-resolve-port-md-path.test.ts` 翻面 + 增加 absolute-outside-worktree 兜底。
- [x] **F2** `runner.ts` + `scheduler.ts` 把 `buildReviewPromptContext` 接进 `renderUserPrompt`：`RunNodeOptions.reviewContext` 新增字段；scheduler agent-single 与 agent-multi 两路在调用 `runNode` 之前都查一遍。修复"评审意见持久化但从未进入迭代提示词"的断链。Test: `review-iterate-comments-in-prompt.test.ts`。
- [x] **F3** review comments 块增加 `**File**: \`<worktree-relative path>\`` 头：`doc_versions` 增 `source_file_path` 列（migration `0003_bizarre_doctor_octopus.sql`），`dispatchReviewNode` 通过新的 `resolvePortContentDetailed` 同时拿到 body + 路径并写入；`renderCommentsForPrompt(comments, { sourceFilePath })` 在 markdown_file 端口下渲染单行 header。Tests: `envelope-resolve-port-detailed.test.ts` + `review-render-comments-with-file-path.test.ts` + `review-iterate-file-path-in-prompt.test.ts`，并在 `review-state-machine.test.ts` 锁 inline-markdown 端口"无 header"的反向不退化。

## 6. 完工后

- `STATE.md`（T38）：把"进行中 RFC"行删；"已完成 RFC"表追加 RFC-005 行，关键产出列写：(a) shared schema bump v2 + agent outputs.kind + ReviewNodeSchema 等；(b) DB 加 awaiting_review status + review_iteration 字段 + doc_versions / review_comments 两表；(c) review service 全套（decision / doc_version / sibling cascade / iterate partial merge）；(d) MarkdownView + 外部 PlantUML 端点 + Settings Rendering tab；(e) /reviews 全局 + 详情页 + 评审侧栏 + 选词 popover + 草稿 IndexedDB；(f) DiffView 三档 + 标题锚滚动联动；(g) e2e/review.spec.ts 全链路 reject/iterate/approve 三路径覆盖；(h) backend +25 test、frontend +34 test、e2e +1 spec；(i) 5 个 PR 合并完成。
- `design/plan.md`（T38）：RFC-005 索引状态改 `Done`。
- 每个 PR 推完按 [feedback_post_commit_ci_check] 立即查 GH Actions 全绿（含 e2e job）。
- 不更新 `design/proposal.md`（产品规格层）和 `design/design.md` §1（架构层），新增的 review 节点视为 v1 之外的增量演化，不重写 v1 设计文档；仅 §3 / §5 / §7.4 / §9 / §11 / §4.3 六处增补。
