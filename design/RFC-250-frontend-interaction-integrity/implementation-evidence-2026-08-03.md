# RFC-250 · 实现与验收证据（2026-08-03）

- 状态：**Implementation Complete / Publication In Progress**
- 用户批准：2026-08-03 已明确批准 production 实施
- 设计门：[design-gate-2026-08-03.md](./design-gate-2026-08-03.md)，最终 0 P0 / 0 P1
- 独立实现门：[implementation-gate-2026-08-03.md](./implementation-gate-2026-08-03.md)，最终 0 P0 / 0 P1
- 发布边界：用户已授权“完整实现之后提交上库”；stage、commit、push、exact-SHA CI 与 hosted visual 尚待执行

## 1. 结论

RFC-250 自有 production scope 已实现，AC1–AC19 均有源码与门禁证据；最终 interaction matrix
Chromium 50/50 + WebKit 50/50、Darwin visual 40/40 和独立实现门 0 P0 / 0 P1 均已闭环。最终验收期间，
用户另行报告“选中远端仓时无法切换到记忆界面”；该问题属于 RFC-249 T31 的 `/repos` URL 边界，本轮按
显式反馈补了最小关闭增量，并在当前二进制的 Chromium、WebKit 390px 中通过。

RFC 当前为 Implementation Complete，但尚不能标 `Done / Published`：T46 的 commit、push、remote
ancestry、exact-SHA CI 与 hosted visual 尚未完成。冻结基线的 backend 红项已定位为 RFC-252 G1 回归，
与 RFC-250 staged paths 无交集；共享 main 后继 `9f296872` 已修，发布 SHA 由 exact-SHA CI 复核。

## 2. AC1–AC19 映射

| AC | Production 锚点 | 测试与结果 |
| --- | --- | --- |
| AC1 PAT 一次性凭据与 unknown outcome | `CreateTokenDialog.tsx`、`AccountTokensPanel.tsx`、`pat-reconciliation.ts`、`UnsavedChangesGuard.tsx`、`UserMenu.tsx` | token、reconciliation、logout focused tests；当前 binary PAT E2E 双浏览器通过。 |
| AC2 Task Wizard 防丢与 reconciliation | `tasks.new.tsx`、`task-wizard-draft.ts`、`ScheduleDialog.tsx`、`UnsavedChangesGuard.tsx` | 恢复、敏感字段不落盘、pending freeze、storage failure、unknown outcome 与零盲重试均有测试；当前 binary 双浏览器通过。 |
| AC3 Task 草稿清理 | `tasks.new.tsx`、`task-wizard-draft.ts`、`UserMenu.tsx` | 成功、放弃、登出、actor/flow/source/revision mismatch 均有锁。 |
| AC4 Clarify durability | `clarify/durability.ts`、`clarify/draftStore.ts`、`clarify.detail.tsx`、`CentralizedAnswerDialog.tsx` | 串行 IDB、旧 PUT 迟到、local-only/retry、unmount、save-and-leave、per-round partial settlement 通过。 |
| AC5 Memory mutation | `MemoryAllList.tsx`、`MemoryRow.tsx`、`ConfirmDialog.tsx` | fulfilled 才关闭、同步冻结 target、pending 防重复、失败保留上下文与 retry 通过。 |
| AC6 Inbox partial feed | `homepage.ts`、`InboxPreviewList.tsx` | 成功空源 + 失败源仍为 partial warning，不再显示假空态或 full error。 |
| AC7 Scheduled eligibility | `schedule-view.ts`、`ScheduledRunNowAction.tsx`、`scheduled.tsx`、`scheduled.$id.tsx` | list/detail 共用 eligibility、确认、pending/error/unknown outcome；列表错误位于 sibling `colSpan=6` 全宽反馈行。 |
| AC8 Dialog 焦点 | `Dialog.tsx`、`ConfirmDialog.tsx`、`ConfirmButton.tsx`、`UnsavedChangesGuard.tsx` | 默认焦点避开 ×、正反向 focus wrap、方向 token 清理、portal/topmost、restore fallback 通过。 |
| AC9 Select disabled/identity | `Select.tsx` | disabled 跳过、异步 reorder 按 value 保持 active；源为空、搜索无匹配、全 disabled 三态分别投影且无悬空 active descendant。 |
| AC10 触控目标与 overflow | `styles.css` 及共享 Checkbox/Switch、Task Wizard、PAT、Changes、Canvas caller | 390px 实测关键控件 ≥44px；无页面横向 overflow。 |
| AC11 Changes 语义边界 | `ChangeReviewPanel.tsx`、`styles.css` | group disclosure、file selector、viewed checkbox 分离；Arrow/Home/End/Space 与折叠焦点恢复通过。 |
| AC12 Workflow readable camera | `canvasCamera.ts`、`WorkflowCanvas.tsx`、`WorkflowCanvasEdge.tsx`、`useWorkflowEditorDraft.ts`、`workflows.edit.tsx` | complex fixture、camera、geometry 和真实浏览器通过；只有真实 remote adoption receipt 增 camera epoch；画布只有一个稳定 Add。 |
| AC13 Validate / Launch | `workflows.edit.tsx`、`ValidationPanel.tsx`、`useWorkflowEditorDraft.ts` | Validate 为 secondary、Launch 唯一 primary；exact-save/fresh validation 通过；1280 Launch/More 完整可见且 action rail 无裁切。 |
| AC14 公共反馈组件 | `AgentForm.tsx`、`workgroups.detail.tsx`、`styles.css` | 关键 blocker/advisory 使用 `ErrorBanner`、`NoticeBanner`、`FeedbackStack`；source ratchet 通过。 |
| AC15 PAT 390px 权限矩阵 | `TokenPermissionMatrix.tsx`、`CreateTokenDialog.tsx`、`styles.css` | 全部 scope 可发现、聚焦、点击；当前 binary 双浏览器通过。 |
| AC16 i18n / 术语 | `i18n/zh-CN.ts`、`i18n/en-US.ts` | 新增 key 成对；局部文案遵循“代理 / 远端仓库 / 所有者”。 |
| AC17 跨 RFC 移交 | RFC-235 handoff、RFC-211 follow-up、RFC-249 T31–T36 | 三个 owning plan 已接收；Intent/Onboarding 的 production closure 仍归原 RFC。Repos 用户回归按 RFC-249 所有权补最小增量，不冒充 RFC-249 整体 Done。 |
| AC18 Agent Runtime 稳定选择 | `AgentForm.tsx`、`runtime-claude-frontend.test.tsx`、`e2e/ux-consistency.spec.ts` | 单一 enabled runtime 仍可 inherit/pin；disabled pin、loading、error/retry 有组件锁；最终二进制双浏览器通过。 |
| AC19 总门 | 上述全部 | RFC-250-owned static/full、Chromium/WebKit、Darwin visual 与独立实现门均闭环；冻结 backend 基线例外单列，hosted Linux exact-SHA visual 归 T46。 |

## 3. 用户报告的 `/repos → /memory` 回归

### 根因

`ReposPage` 的非法 tab canonicalizer 读取 TanStack Router 的 optimistic `state.location`。离开
`/repos?tab=repos` 去 `/memory?tab=all` 时，旧页面尚未卸载，却把 Memory 的 `tab=all` 误判为非法仓库
tab，随后执行 replace，把目的地抢回 `/repos?tab=repos`。

### 修复

- `packages/frontend/src/routes/repos.tsx` 改读 `resolvedLocation ?? location`，并在 pathname 为 `/repos` 时
  才允许仓库 tab canonicalization。
- 关闭态不再挂载 `RepoGroupEditor`，因此没有编辑器时不会注册无意义的全局离开 blocker；打开且 dirty
  时仍沿用原 `UnsavedChangesGuard`。
- 没有保留 AppShell、Root、ShellNavigation 或 RouteTransitionState 的试验性时序改动。

### 回归证据

- `packages/frontend/tests/repos-operations.test.tsx`：canonicalizer pathname 门、真实 RouterProvider
  `/repos?tab=repos → /memory?tab=all`、关闭态 editor 不挂载。
- `e2e/ux-consistency.spec.ts`：390px 菜单真实点击 Memory，检查 URL、Memory 标题/面板和抽屉关闭。
- Focused unit：31/31 PASS。
- 当前 binary：Chromium 目标 E2E 1/1 PASS；WebKit 目标 E2E 1/1 PASS。
- 既有仓库组 dirty 保护：Chromium E2E PASS，确认打开的草稿仍会拦截离开。
- 最终三文件独立只读实现门：0 P0 / 0 P1。

## 4. 浏览器、几何与人工检查

| 门 | 回执 |
| --- | --- |
| 当前源码 E2E binary | `bun run build:binary:e2e` PASS；version smoke PASS。 |
| 最终 interaction matrix | Chromium 50/50 PASS；WebKit 50/50 PASS；总计 100/100。 |
| Workflow camera post-fix focused | 1280 desktop Chromium 1/1 + WebKit 1/1 PASS；锁唯一 Add、Launch/More 与 action rail 几何。 |
| Darwin visual | update 40/40、compare 40/40；6 张刷新 baseline 人工复核通过。 |
| 几何 | 低缩放 selection/validation marker ≥8px；390px canvas toolbar 与 React Flow controls ≥44px。 |
| Darwin 人工检查 | 390×844 controls ≥44px 且无横向 overflow；1280 light/dark Launch/More 完整，画布只有一个 Add。 |

独立只读终审先发现 2 项 P1（Scheduled 错误反馈宽度、Workflow 重复 Add/1280 裁切），修复后复审为
`APPROVED — P0=0 / P1=0`。post-fix focused Vitest 4 files / 51 tests、Chromium/WebKit 1280 camera 与
`git diff --cached --check` 均通过。

## 5. Workspace 门禁

| 命令/门 | 结果 |
| --- | --- |
| `bun run test:frontend` | PASS：696 files / 5912 tests，102.75s；seed `1785767521209`。 |
| `bun run test:shared` | PASS：148 files / 1617 tests；seed `1172831740`。 |
| `bun run typecheck` | PASS：shared、backend、frontend。 |
| `bun run lint` | PASS；仅 Node `MODULE_TYPELESS_PACKAGE_JSON` informational warning。 |
| `bun run format:check` | PASS。 |
| `bun run depcheck` | PASS：1230 modules；19/19 accepted；16 unresolved externals ignored。 |
| `git diff --check` | PASS。 |
| backend full（冻结基线） | 执行一次：990 files / 8306 tests；8269 pass、28 skip、9 fail，978.70s；seed `500898906`。 |
| backend 定向诊断 | 9 项全部归因 RFC-252 G1/RFC-165/RFC-210；RFC-250 无路径交集；后继 `9f296872` 已修。 |
| 独立实现门 | PASS：0 P0 / 0 P1。 |

Backend full 的 9 项失败不是瞬时波动：6 条为冻结 HEAD `40535c0e` 新增 `--checkout` 后旧 exact-argv
baseline 未同步，2 条为 hooks 压制改变 scratch/submodule publish 既有语义，另 1 条为 scratch lease
级联。RFC-250 staged backend 仅两份 test-only 文件，与失败路径无交集；共享 main 后继 `9f296872`
已经更新 baseline 并修复 commit hooks 语义。按冻结规则不追逐移动 main 重跑 16 分钟本地 full；最终发布
SHA 的 workspace full 由 T46 exact-SHA CI 给出终局回执。

## 6. 跨 RFC 证据

- RFC-235：[`rfc250-handoff-2026-08-03.md`](../RFC-235-intent-builder-ux/rfc250-handoff-2026-08-03.md)
  与 owning plan 已接收 Intent answer/action/mutation finding。
- RFC-211：[`rfc250-followup-2026-08-03.md`](../RFC-211-guided-onboarding-sandbox/rfc250-followup-2026-08-03.md)
  与 owning plan 已接收 step-scoped fulfilled receipt 和路线文案 finding。
- RFC-249：owning plan T31–T36 已接收 strict `/repos?tab=` 与 RepoGroupEditor dirty；本轮用户报告的跨页
  回归作为 T31 关闭增量实现并验证，RFC-249 的完整编辑链、hosted visual 与独立实现门仍按其计划收口。

## 7. 发布边界

用户已明确要求完整实现后提交上库，因此 RFC-250-T46 已获授权。仍须按精确路径 staging、真实 AI
co-author trailer、remote ancestry、exact-SHA CI 与 hosted visual 完成 publication closure；任一项未完成
都不得把本节改写为发布成功。
