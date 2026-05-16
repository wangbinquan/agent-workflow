# RFC-013 评审页面历史版本浏览 — 技术设计

> 与 [proposal.md](./proposal.md) 配套。任务拆分见 [plan.md](./plan.md)。

## 1. 总览

只动**前端**两个文件 + 一个共享小工具：

| 文件                                                       | 改动                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/frontend/src/routes/reviews.tsx`                 | 行内可展开子区 + 历史版本列表 + lazy `useQuery('versions')`              |
| `packages/frontend/src/routes/reviews.detail.tsx`          | 读 `?version=<vid>` query → 切只读模式（渲染历史 body / 隐藏决策与评论写按钮 / 禁用快捷键 / 不渲 diff toggle / 顶部只读 banner） |
| `packages/frontend/src/lib/review/readonly.ts`（新）       | 一个纯函数 `resolveReviewView({ versionQuery, currentVersionId, versions }) → { mode: 'current' \| 'historical' \| 'invalid', activeVersionId, decisionOfActive }` 供测试与 UI 共享 |

**零后端改动**。仅消费已有 endpoint：

- `GET /api/reviews/:nodeRunId/versions` — 列出 doc_versions 全部行（RFC-005 已实现）。
- `GET /api/reviews/:nodeRunId/versions/:vid` — 取某一历史版 body + meta（RFC-005 已实现）。
- `GET /api/reviews/:nodeRunId` — 详情（含 currentVersion + comments 按 currentVersion 切片）；本 RFC 在历史视图下用 versions endpoint 的 body 覆盖正文，评论侧栏需要按 `vid` 重新拉一次（详见 §4）。

零 schema / migration。

## 2. 数据契约

`DocVersion`（`packages/shared` 已有）字段：

```ts
type DocVersion = {
  id: string                // ULID
  reviewNodeRunId: string   // 链头 node_run id
  versionIndex: number      // 1, 2, 3...
  decision: 'pending' | 'approved' | 'rejected' | 'iterated'
  createdAt: number
  // body 不在列表 endpoint 返回，按需通过 /versions/:vid 拉
}
```

`ReviewSummary`（列表行）现有字段 `currentVersionIndex` 已经够用——决定子区展开后是否需要 "(current)" 标记不依赖 server-side commentCount per version；评论数走 `GET /api/reviews/:nodeRunId/versions/:vid` 的扩展字段返回（见 §3）。

## 3. 后端零改动确认

为了避免给 backend 加 endpoint，本 RFC 选择在前端用**两次请求**拼合：

1. `GET /api/reviews/:nodeRunId/versions` 返 `DocVersion[]`（不含 body，不含 commentCount）；
2. 历史版本"评论数 chip"：列表子区展开时**不**为每个版本预拉 comments（避免 N 次请求）；评论数 chip 显示为 `—`（dash）即可，等于"未加载"语义；详情页打开历史版本时才拉该版评论。

如果后续用户反馈"想在列表里看到每版评论数"，再走单独 issue 给 `/versions` endpoint 加 `commentCount` 字段（O(1) SQL aggregate）。本 RFC 不做。

**修订**：评论数 chip 改为可选，UI 直接不显示该 chip；version 行只显示 `v{N}` + decision chip + Open 按钮，避免上线后立刻产生"chip 永远 dash"的视觉噪声。如果 plan 阶段觉得有必要后续补，再单独 issue。

更新后的版本行：

```
v1  [rejected]   [Open]
v2  [iterated]   [Open]
v3  [pending] (current)  [Open]
```

## 4. 详情页：`?version=<vid>` 模式

### 4.1 路由

TanStack Router 的 `useSearch` 取 `version`（已有 `path: '/reviews/$nodeRunId'`，加 search schema）：

```ts
const searchSchema = z.object({ version: z.string().optional() })
Route.validateSearch = (s) => searchSchema.parse(s)
```

### 4.2 状态机

```ts
type ReviewView =
  | { mode: 'current' }                                            // 无 ?version 或 version === currentVersion.id
  | { mode: 'historical', vid: string, decision: Decision }        // ?version=有效历史 vid
  | { mode: 'invalid', requested: string }                         // ?version=非法
```

`resolveReviewView` 纯函数（`lib/review/readonly.ts`）：

```ts
export function resolveReviewView(
  versionQuery: string | undefined,
  currentVersionId: string,
  versions: DocVersion[],
): ReviewView {
  if (versionQuery === undefined || versionQuery === '') return { mode: 'current' }
  if (versionQuery === currentVersionId) return { mode: 'current' }
  const match = versions.find((v) => v.id === versionQuery)
  if (match === undefined) return { mode: 'invalid', requested: versionQuery }
  return { mode: 'historical', vid: match.id, decision: match.decision }
}
```

`invalid` 模式渲染时上抛 toast + 等价 `mode: 'current'`。

### 4.3 historical 模式数据加载

- `versions` 列表 query 复用 `['reviews', 'versions', nodeRunId]`（详情页本来就在拉，用于现有 prior-version diff toggle）；
- body 走已有 `['reviews', 'version-body', nodeRunId, vid]` query —— 当前 prior-version diff 那条 line 已经按 vid 缓存，零改动；只是把 enabled 条件从 `diffMode && priorVersion !== null` 扩展到 `viewMode.mode === 'historical' || (diffMode && priorVersion)`。
- 评论列表：现有详情 endpoint `GET /api/reviews/:nodeRunId` 返回的 comments 是按 currentVersion 切片的。历史模式下需要拉历史版评论。两个选项：
  - **方案 A（推荐）**：`GET /api/reviews/:nodeRunId/versions/:vid` 已经返回 `body + meta`，扩展返回 `{ body, comments }`——但这是后端改动，违反 §3 零改动约束。
  - **方案 B（零后端改动）**：前端复用 `GET /api/reviews/:nodeRunId` 的 comments 数组，本地按 `c.docVersionId === vid` 过滤。这要求详情 endpoint 返回所有评论而非仅当前版。**实测当前代码 `services/review.ts` `getReviewDetail` 用 `eq(reviewComments.docVersionId, currentVersion.id)` 切片，所以方案 B 走不通。**
  - **方案 C（零后端改动 · 选用）**：前端新加 query `['reviews', 'comments-by-version', nodeRunId, vid]`，URL 仍走现有 `/api/reviews/:nodeRunId` 但前端 query 后再过滤——绕不开 backend 已经切片。
  - **方案 D（零后端改动 · 实际选用）**：前端调 `GET /api/reviews/:nodeRunId/versions/:vid` 取 body；评论改用现有 `GET /api/reviews/:nodeRunId` 的 comments 字段——但因为后端会按 currentVersion 过滤，**这对本 RFC 不可行**。

**结论：必须给 backend 加一个零成本扩展**：

将 `GET /api/reviews/:nodeRunId/versions/:vid` 的返回从 `DocVersion & { body: string }` 扩展为 `DocVersion & { body: string, comments: ReviewComment[] }`，`comments` = 这个 `vid` 关联的所有评论（按 `eq(reviewComments.docVersionId, vid)`）。后端 1 行 SQL 加 1 行 zod schema 字段，影响面极小，**仅扩展返回，不破坏现有调用方**。

§3 的"零后端改动"承诺修订为"零 schema 改动 + 极小 endpoint 返回字段扩展"。`packages/shared/src/schemas/review.ts` 的 `DocVersionWithBody` 加 `comments: z.array(ReviewCommentSchema)` 字段。

### 4.4 渲染分支

```tsx
const view = resolveReviewView(searchVersion, detail.currentVersion.id, versions ?? [])

// historical body + comments come from /versions/:vid (now includes comments)
const historical = useQuery(['reviews', 'version-body', nodeRunId, vid], ..., {
  enabled: view.mode === 'historical',
})

const activeBody = view.mode === 'historical' ? historical.data?.body : detail.currentVersion.body
const activeComments = view.mode === 'historical' ? historical.data?.comments : detail.comments
const readonly = view.mode === 'historical'
```

#### 4.4.1 隐藏 / 禁用清单

| UI 元素                                             | historical 模式行为 |
| --------------------------------------------------- | ------------------- |
| Approve / Reject / Iterate 按钮                      | 不渲染（`if (!readonly)` 包裹整组） |
| 快捷键 A / J / K（approve / iterate / reject）        | `if (readonly) return` 在 keydown handler 顶部短路 |
| 评论侧栏 "Add comment" 按钮                          | 不渲染              |
| 单条评论 "Edit" / "Delete" / "Copy"                  | 不渲染              |
| 选词浮层 popover（select-to-comment）                | 选词监听器在 `readonly` 时不挂 |
| Diff toggle（off / word / line / block）             | 不渲染              |
| Ctrl+1 / Ctrl+2 / Ctrl+3 切 diff 粒度 快捷键          | `if (readonly) return` 短路 |
| 顶部 "Reject reason draft" / "Iterate confirm" modal  | historical 模式入口本就不可达，无需额外处理 |

#### 4.4.2 顶部 banner

```tsx
{view.mode === 'historical' && (
  <div className="readonly-banner" role="status">
    {t('reviews.historicalBanner', { version: ?, decision: ? })}
    <Link to="/reviews/$nodeRunId" params={{ nodeRunId }} search={{}}>
      {t('reviews.backToCurrent')}
    </Link>
  </div>
)}
```

CSS：`.readonly-banner { background: var(--amber-bg); padding: 8px 12px; display: flex; justify-content: space-between }`。

#### 4.4.3 invalid 模式

```tsx
useEffect(() => {
  if (view.mode === 'invalid') {
    toast.error(t('reviews.unknownVersion', { id: view.requested }))
    navigate({ to: '/reviews/$nodeRunId', params: { nodeRunId }, search: {}, replace: true })
  }
}, [view.mode])
```

## 5. 列表页：行可展开

### 5.1 状态

`/reviews` 顶层加 `const [expanded, setExpanded] = useState<Set<string>>(new Set())`（key 为 `nodeRunId`）。展开行 → toggle set。

不持久化到 storage（proposal US-1 已限定页面会话期内保留即可）。

### 5.2 表格结构

在现有表格里每个 `<tr>` 后插入"折叠子行"：

```tsx
<tbody>
  {g.items.map((r) => (
    <Fragment key={r.nodeRunId}>
      <tr>
        ...原有列...
        <td>
          <button onClick={() => toggle(r.nodeRunId)} aria-expanded={expanded.has(r.nodeRunId)}>
            {expanded.has(r.nodeRunId) ? '▾' : '▸'}
          </button>
        </td>
        <td>...Open 按钮原有...</td>
      </tr>
      {expanded.has(r.nodeRunId) && (
        <tr className="reviews-row__history">
          <td colSpan={6}>
            <HistoryRows nodeRunId={r.nodeRunId} currentVersionId={r.currentVersionId} />
          </td>
        </tr>
      )}
    </Fragment>
  ))}
</tbody>
```

注意 `ReviewSummary` 当前**没有** `currentVersionId` 字段（只有 `currentVersionIndex`）。`<HistoryRows>` 自己拉 versions 后用 `versionIndex === r.currentVersionIndex` 推断 currentVersionId，避免修 `ReviewSummary` schema。

### 5.3 HistoryRows 组件

```tsx
function HistoryRows({ nodeRunId, currentVersionIndex }) {
  const q = useQuery<DocVersion[]>({
    queryKey: ['reviews', 'versions', nodeRunId],
    queryFn: ({ signal }) => api.get(`/api/reviews/${nodeRunId}/versions`, undefined, signal),
  })
  if (q.isLoading) return <Skeleton rows={2} />
  if (q.error) return <ErrorRow onRetry={() => q.refetch()} />
  const sorted = [...(q.data ?? [])].sort((a, b) => a.versionIndex - b.versionIndex)
  return (
    <ul className="reviews-version-list">
      {sorted.map((v) => {
        const isCurrent = v.versionIndex === currentVersionIndex
        return (
          <li key={v.id}>
            <span>v{v.versionIndex}</span>
            <span className={`status-chip status-chip--${decisionColor(v.decision)}`}>
              {v.decision}
            </span>
            {isCurrent && <span className="muted">({t('reviews.currentTag')})</span>}
            <Link
              to="/reviews/$nodeRunId"
              params={{ nodeRunId }}
              search={isCurrent ? {} : { version: v.id }}
              className="btn btn--sm"
            >
              {t('reviews.openButton')}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
```

### 5.4 错误 / 空态

- 加载失败：行内 `<div role="alert">` + "Retry" 按钮（调 `q.refetch()`）。
- 无 versions：理论上不可能（每个 review 至少有 v1），保底显示 "No versions"。
- `currentVersionIndex` 在 versions 数组里找不到对应行：不崩溃；这种 race 出现于 server-side 新建 v(N+1) 与 list cache 未刷新之间，回落为"无 current 标记"渲染。

## 6. shared schema 改动

`packages/shared/src/schemas/review.ts`：

```ts
export const DocVersionWithBodyAndCommentsSchema = DocVersionSchema.extend({
  body: z.string(),
  comments: z.array(ReviewCommentSchema),
})
export type DocVersionWithBodyAndComments = z.infer<typeof DocVersionWithBodyAndCommentsSchema>
```

注意：`DocVersionWithBody`（仅 body）schema 若已存在，保留并叠加 `WithComments` 变体；后端 `GET /api/reviews/:nodeRunId/versions/:vid` 切到新 schema。前端 prior-version diff toggle 已经在用 `versions/:vid` endpoint，影响检查：现有 `priorBody = useQuery<{ body: string } & DocVersion>(...)` 接受新增字段（zod 不会因多字段拒绝；前端 TS 类型扩成新名）。

## 7. 后端改动（极小）

`packages/backend/src/services/review.ts` 新增 `getDocVersionDetail(db, appHome, nodeRunId, vid)`：

```ts
const dv = await getDocVersion(db, vid)
if (dv === null || dv.reviewNodeRunId !== nodeRunId) return null  // 防越权
const body = readDocVersionBody(appHome, dv)
let comments: ReviewComment[]
if (dv.decision === 'pending') {
  // Pending 版的评论仍在 review_comments 活表里
  comments = (await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.docVersionId, dv.id))
    .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
  ).map(rowToReviewComment)
} else {
  // 已决策版的评论已被 submitReviewDecision 归档到 commentsJson 并从活表删除
  comments = parseArchivedComments(dv.commentsJson)
  comments.sort(byParagraphAndOffset)
}
return { ...dv, body, comments }
```

**关键决策**：评论数据源**按 decision 状态分流**：

- `decision === 'pending'`：从 `review_comments` 活表读（用户还在写评论，活表是真值源）。
- 已决策（approved / rejected / iterated）：解析 `doc_versions.commentsJson` 归档字段。原因：`submitReviewDecision` 在决策落盘时把 `JSON.stringify(commentsArr)` 写入 commentsJson **且** `delete from review_comments where docVersionId = dv.id`，活表已空，归档 JSON 是历史评论的**唯一**真值源。

腐坏 JSON / 缺字段 / null 等异常 commentsJson 走 `parseArchivedComments` 兜底为空数组（带 log.warn），不让 500 把整个页面打死。

route 层 `packages/backend/src/routes/reviews.ts:100` `app.get('/api/reviews/:nodeRunId/versions/:versionId', ...)` 切到 `getDocVersionDetail` 调用，并把 nodeRunId 路径参数透传给 service 做防越权校验（之前仅按 vid 查不验 ownership）。

## 8. 测试策略

### 8.1 前端单元（vitest）

- `tests/review-resolve-view.test.ts`：`resolveReviewView` 五分支
  - empty query → `mode: current`
  - query === currentId → `mode: current`
  - query === 历史 vid → `mode: historical` + decision 对齐
  - query === 未知 vid → `mode: invalid`
  - empty versions 数组 + query → `mode: invalid`
- `tests/reviews-list-expand.test.tsx`：列表行可展开
  - 默认折叠；点击展开 → 触发 versions query；
  - 加载中显示 skeleton；
  - 加载完成显示 v1..vN 三行 + decision chip + Open；
  - current 行 Open 链接 search 为空对象；非 current 行 Open 链接 search 含 `version=<vid>`；
  - 加载失败显示 retry 按钮，点击触发 refetch；
- `tests/reviews-detail-readonly.test.tsx`：详情页只读
  - 注入 `useSearch` 返 `{}`：渲染 Approve / Reject / Iterate 按钮 + Diff toggle；
  - 注入 `{ version: <history-vid> }`：三按钮 + diff toggle + Add-comment + Edit / Delete / Copy 全部**不在 DOM**；只读 banner role=status 在 DOM；
  - 注入 `{ version: 'unknown' }`：触发 navigate replace 到无 query 路径 + toast；
  - readonly 模式下按 A / J / K 不触发 mutation（mock `useMutation` 验证 mutate 调用次数 0）；
  - readonly 模式下按 Ctrl+1 / Ctrl+2 不切 diff mode；
- `tests/reviews-detail-readonly-source.test.ts`（源码层兜底）：
  - 用 fs 读 `routes/reviews.detail.tsx`，正则断言：
    - 文件中存在 `resolveReviewView(` 调用；
    - 决策按钮 JSX 包裹在 `view.mode === 'current'` / `!readonly` 判定下；
    - keydown handler 顶端有 `if (readonly) return` 短路；
  - 防止"运行时测试都过、但开发者后来加了不被 readonly 包裹的新按钮"的回归。

### 8.2 后端单元（bun:test）

- `tests/reviews-version-comments.test.ts`：
  - 构造 review node_run + v1, v2, v3 三 docVersion + 每版各 2 条 comments；
  - `GET /api/reviews/:nodeRunId/versions/v2.id` 返 body + 仅 v2 的 2 条 comments（不是全部 6 条 / 不是 current 版的 2 条）；
  - 顺序按 createdAt asc；
  - 不属于此 nodeRunId 的 vid → 404；
  - 不存在的 vid → 404。

### 8.3 e2e（暂不扩）

不在本 RFC 范围。如果 RFC-005 e2e `e2e/review.spec.ts` 走 reject → iterate → approve 闭环已经 mint 出 v1/v2/v3，可以在 follow-up 单独加一个 step 验证列表行展开 + 历史版本只读 banner 出现。

## 9. 迁移与回滚

- **无 DB 迁移**。
- 前端：旧 URL `/reviews/:nodeRunId` 行为完全保留（`version` query 缺省即 current mode）。
- 后端：`/versions/:vid` 返回字段新增向后兼容；如需回滚仅去掉 `comments` 字段，前端在 historical 模式下回退到拉 `/api/reviews/:nodeRunId` + client-side filter（但 backend 现切 currentVersion 不可行，回滚还要一并 revert services 改动）。整体作为一个 PR 进退即可。

## 10. 失败模式

| 场景                                                     | 行为                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| versions endpoint 500                                    | 列表行展开内嵌错误 + retry；详情页历史模式回落为 invalid，提示 + 跳 current |
| 用户手敲 `?version=foo` 非法 vid                          | invalid 模式 → toast + navigate replace                    |
| versions 数组里没有任何 versionIndex 匹配 currentVersionIndex | 列表行展开仍能列出所有版本，仅不打 "(current)" 标记         |
| 历史版本的评论 anchor 因为 server-side body 被改而错位     | RFC-005 anchor 一次性持久化策略已保证：reject 触发新版时 anchor 已固化，历史版渲染只用持久化字段，不再重定位，所以不会错位 |
| 详情页同一时间多 tab 一个看 current、一个看 historical    | tanstack-query queryKey 区分 vid，两份缓存互不影响          |

## 11. 与并行 RFC 的关系

- **RFC-007 / RFC-008 / RFC-009 / RFC-010 / RFC-011 / RFC-012**：均与本 RFC 修改面零重叠。RFC-009 的评论侧栏增强（内联编辑 / 复制 / 数量 badge / 折叠 / 拖宽 / 行号）需要在 historical 模式下把"内联编辑" / "复制"按钮在渲染层隐藏；本 RFC 的实施 PR 与 RFC-009 落地 PR 谁先 merge 就把这些隐藏逻辑加在自己分支里（CLAUDE.md "Multi-person collaboration 并发改动保留原则"）。
- **RFC-005 PR-B / PR-D**：本 RFC 复用其建好的 endpoint / query key / anchor 渲染管线。无破坏性改动。
