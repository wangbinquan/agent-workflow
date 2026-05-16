# RFC-013 评审页面历史版本浏览 — 实施计划

> 与 [proposal.md](./proposal.md) / [design.md](./design.md) 配套。

## 任务编号规则

`RFC-013-T{N}`。整 RFC 默认对应**单个 PR**（按 CLAUDE.md RFC workflow §5）。

## 任务列表

### RFC-013-T1 共享 schema 扩展

- **What**：`packages/shared/src/schemas/review.ts` 增 `DocVersionWithBodyAndCommentsSchema = DocVersionSchema.extend({ body: z.string(), comments: z.array(ReviewCommentSchema) })` + 导出 TS 类型。如果已有 `DocVersionWithBodySchema`，保留并在它之上叠加 `WithComments` 变体；如无则直接新增。
- **Deps**：—
- **Size**：S
- **测试**：现有 review schema test 跑绿；本 task 不单独加 case，由 T2 backend 测试覆盖序列化形状。

### RFC-013-T2 后端 `/versions/:vid` 返回评论

- **What**：
  - `packages/backend/src/services/review.ts`：`getDocVersion(nodeRunId, vid)` 内追加 `SELECT * FROM review_comments WHERE docVersionId = vid ORDER BY createdAt ASC`，拼进返回对象。
  - `packages/backend/src/routes/reviews.ts:100` 的 handler 返回 schema 切到 T1 新 schema。
  - 路径校验保持原状（vid 必须属于该 nodeRunId，否则 404，链头反查由现有 `resolveReviewChainHead` 处理）。
- **Deps**：T1
- **Size**：S
- **测试**：`tests/reviews-version-comments.test.ts` 5 case
  - v1/v2/v3 三版各 2 评论 → 拉 v2.id 仅返 v2 的 2 条；
  - 按 createdAt asc 排序；
  - 非本 nodeRunId 的 vid → 404；
  - 不存在的 vid → 404；
  - 链头反查：传 chain 中间某个 nodeRunId 也能正常拉到。

### RFC-013-T3 前端 `resolveReviewView` 纯函数

- **What**：新增 `packages/frontend/src/lib/review/readonly.ts`，导出 `resolveReviewView(versionQuery, currentVersionId, versions): ReviewView`（discriminated union: `current` / `historical` / `invalid`）。
- **Deps**：—（与 T1/T2 并行可写）
- **Size**：S
- **测试**：`tests/review-resolve-view.test.ts` 5 case（design §8.1 列出）。

### RFC-013-T4 详情页只读模式

- **What**：
  - `packages/frontend/src/routes/reviews.detail.tsx` 引入 `Route.validateSearch = z.object({ version: z.string().optional() }).parse`，`const { version: searchVersion } = useSearch({ from: Route.id })`。
  - 调 `resolveReviewView` 拿 `view`。
  - historical 模式下：`historicalQuery = useQuery(['reviews', 'version-body', nodeRunId, view.vid], () => api.get(\`/api/reviews/${nodeRunId}/versions/${view.vid}\`))`（T2 后该 endpoint 已返 body + comments）。
  - 渲染分支：
    - `body = historical ? historicalQuery.data?.body : detail.currentVersion.body`
    - `comments = historical ? historicalQuery.data?.comments : detail.comments`
    - `readonly = view.mode === 'historical'`
  - 顶部只读 banner（`{view.mode === 'historical' && <ReadonlyBanner ... />}`）含 "回到当前版" Link（search 传空对象）。
  - 按 design §4.4.1 表逐项加 `{!readonly && ...}` 包裹：决策按钮组、Diff toggle 整组、Add comment 按钮、comment 行的 Edit/Delete/Copy 按钮、select-to-comment popover effect。
  - keydown handler 顶端加 `if (readonly) return`（A / J / K / Ctrl+1/2/3 全短路）。
  - invalid 模式 useEffect：toast + navigate replace 到无 query 路径。
- **Deps**：T2、T3
- **Size**：M
- **测试**：
  - `tests/reviews-detail-readonly.test.tsx` 6 case（design §8.1 列出）。
  - `tests/reviews-detail-readonly-source.test.ts` 3 case 源码层兜底（design §8.1 列出）。

### RFC-013-T5 列表页行可展开 + 历史版本列表

- **What**：
  - `packages/frontend/src/routes/reviews.tsx` 顶层加 `const [expanded, setExpanded] = useState<Set<string>>(new Set())` + `toggle(id)`。
  - 表格 thead 加一列空 `<th>`（展开按钮列）。
  - 每一行外层用 `<Fragment>` 包裹原 `<tr>` + 条件渲染的子行 `<tr className="reviews-row__history"><td colSpan={6}>...</td></tr>`。
  - 子行内嵌新组件 `<HistoryRows nodeRunId currentVersionIndex />`，组件内 `useQuery(['reviews', 'versions', nodeRunId], ...)` lazy 加载（只在父展开时挂载）。
  - 渲染版本行 `<ul><li>`：`v{N}` + decision `status-chip` + 可选 `(current)` muted 标记 + `<Link>` Open。当前版 Open 跳 `params={{ nodeRunId }} search={{}}`；历史版跳 `search={{ version: v.id }}`。
  - 加载中：3 行 skeleton；加载失败：role=alert + retry 按钮。
- **Deps**：T4（让 history Open 跳过去时有只读 UI 接住，避免 PR 半态）
- **Size**：M
- **测试**：
  - `tests/reviews-list-expand.test.tsx` 5 case：默认折叠 / 点开触发 versions query / 显示 v1..v3 + chip + Open / current 行 search 为空 / 历史行 search 含 vid / 加载失败显示 retry。

### RFC-013-T6 i18n + CSS

- **What**：
  - `packages/frontend/src/i18n/zh-CN.json` + `en-US.json` 加 8 条 key：
    - `reviews.expand` / `reviews.collapse`（按钮 aria-label）
    - `reviews.historicalBanner`（模板含 `{{version}}` / `{{decision}}`）
    - `reviews.backToCurrent`
    - `reviews.loadVersionsFailed`
    - `reviews.retry`
    - `reviews.currentTag`
    - `reviews.unknownVersion`（toast 文案）
  - `packages/frontend/src/styles.css` 加：
    - `.readonly-banner { background: var(--amber-bg); padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px }`
    - `.reviews-version-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 16px; margin: 0; list-style: none }`
    - `.reviews-version-list li { display: flex; align-items: center; gap: 8px }`
    - `.reviews-row__history > td { background: var(--surface-2); padding: 0 }`
- **Deps**：T4 / T5（key 名 commit 一起）
- **Size**：S
- **测试**：随 T4 / T5 集成测试一起验证文案出现。

## PR 拆分建议

**单 PR**。T1 + T2 + T3 + T4 + T5 + T6 一起落，commit message 前缀 `feat(review): RFC-013 review 列表页历史版本浏览`。

理由：每个 task 单独提 PR 会出现"前端跳 ?version=vid 但只读模式还没接 → 详情页崩"或"后端 versions/:vid 已含 comments 但前端没消费 → schema test 红"这种半态。单 PR 让前后端契约一次对齐。

## 验收清单

PR 合并前必须全绿：

- [ ] `bun run typecheck`（workspace 全绿）
- [ ] `bun run test`（backend + frontend 全部测试 + 本 RFC 新增 case 全绿）
- [ ] `bun run format:check`
- [ ] CI Actions（含 build single-binary + Playwright e2e）全绿（按 [feedback_post_commit_ci_check] 推完后即查）
- [ ] 手测：
  - `/reviews` 列表展开任一行 → 看到 v1..vN，决策 chip 与 backend 一致；
  - 历史行 Open → 详情页顶部显示黄底 readonly banner；
  - 决策按钮 / Diff toggle / Add comment / comment 行 Edit / Delete / Copy 全部不在 DOM；
  - A / J / K / Ctrl+1/2/3 在历史模式下无效；
  - 选词不弹 popover；
  - 评论侧栏只展示该版评论；正文 anchor 高亮正确；
  - 点 "回到当前版" 跳无 query 路径，所有写按钮回来；
  - 手敲非法 `?version=foo` → toast + replace 到无 query。
- [ ] `STATE.md` 顶部"进行中 RFC"行加上 RFC-013（实施中）；merge 后翻为 Done 并在 plan.md RFC 索引 + STATE.md 已完成 RFC 表里加一行。
