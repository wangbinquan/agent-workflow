# RFC-241 — 技术设计（v2,设计门一轮修订后）

## 数据流(零后端改动,已实证)

`reviews.detail.tsx` 的 diff 分支已有:

- `priorVersion`:versions 按 versionIndex 降序取首个非当前版
  (`reviews.detail.tsx:117-122`)——多轮驳回后即上一轮被决策的那版,与
  diff 左栏是**同一版本对象**,侧栏意见与左栏文档天然对齐;该版可能是
  RFC-074 `superseded`(系统作废),意见为作废时点的冻结快照,同样展示。
- `priorBody = GET /api/reviews/:nodeRunId/versions/:priorVersion.id`
  → `DocVersionWithBodyAndComments`:已决策版返回冻结 `commentsJson`、
  pending 返回活表(`services/review.ts:1497-1517`),与该版本详情页
  一致;ACL 走同一 `ensureReviewVisible` 读门。

本 RFC 仅新增消费 `priorBody.data.comments` 与 `priorBody.data.body`
(行号标签需要 body,见下)。多文档评审(MultiDocReviewView)无 diff
功能,不在范围。

## 组件

新公共组件 `components/review/PriorCommentsSidebar.tsx`:

- **Props:`{ comments: ReviewComment[]; body: string; versionIndex: number }`**
  ——body 必传:行号标签复用现有
  `computeLineRange(body, offsetStart, offsetEnd)`(`lib/review/lineRange.ts`,
  越界由其内部钳制到末行),没有该版本 body 无法计算;标题
  「上一版 v{versionIndex} 的检视意见 · {count} 条」由组件内 i18n key +
  参数组装(count = comments.length,组件内算)。
- **排序**:与 ReviewDocPane 现有 `sortedComments` 完全一致——
  `offsetStart → occurrenceIndex`(`ReviewDocPane.tsx:263-270`)。该比较
  器抽成 `lib/review/commentOrder.ts` 纯函数,两处共用(plan T1 含此
  抽取;不存在"sectionPath → 行号 → createdAt"这样的现有语义,一轮
  设计门勘误)。
- **视觉**:复用 comment-bubble 命名空间,但必须加静态流覆盖——
  `.comment-bubble` 本体是 `position: absolute` + 由 DOM 测量注入
  `top`(`useCommentBubbles`),本侧栏无内联锚定、无测量,不覆盖则全部
  气泡叠压在容器顶(一轮 P1)。规范:
  `.prior-comments .comment-bubble { position: static; margin-bottom: 8px; }`
  (与 `styles.css` 720px 媒体查询先例同法)。**无** action 区
  (`comment-bubble__actions` 不渲染)。
- **a11y**:容器 `role="complementary"` + `aria-label` 含来源版本;逐条
  沿用 `<article>`;测试以 role 锚点断言。
- 空态 `<EmptyState>`;作者行沿用 AttributionChip + useUserLookup。

## 布局(diff 模式三列,一轮 P1 显式化)

现状:diff 开启时 ReviewDocPane 的**当前版**意见栏
(`.review-detail__bubbles` / 折叠 rail)照常显示(`diffActive` 不抑制
它)。本 RFC **不动它**(含折叠态)。新侧栏放在 body 列内:

```
.review-detail__layout
├─ body 列:.review-diff-layout(新,两栏 grid)
│   ├─ DiffView(主)
│   └─ PriorCommentsSidebar(固定 320px)
└─ 当前版意见栏(既有,原样)
```

即整屏三列:diff | 上一版意见(新,只读) | 当前版意见(既有)。
proposal 的「右侧」修正为「diff 主列右缘、当前版意见栏左侧」。
**渲染条件**:`diffMode && priorVersion !== null && 非 historical 视图`
——`diffMode` 是本地 state,进入 `?version=` historical 视图不会重置,
不加排除会在 historical 页冒出孤立侧栏(一轮 P1);实现放在
auxiliaryBodySlot 的 diff 分支内(historical 早退先行)并显式写明条件。
**响应式**:≤720px 外层已单列,`.review-diff-layout` 同步单列堆叠
(侧栏移至 diff 下方);320px 为写死值,不复用可拖拽的
`--review-sidebar-width`(「同宽」与「固定宽」二选一,取固定,一轮 P2)。

## 失败模式(一轮 P2 改写)

- priorBody **首次加载失败**:沿用现状——整个 bodySlot 被
  `review-diff-body-error` ErrorBanner 替换,diff 与侧栏同进退(侧栏
  不单独存在)。
- priorBody **stale 失败**(已有缓存、刷新失败):沿用
  `review-diff-body-stale-error` 现状——缓存 diff 保留 + 独立错误条,
  **侧栏随缓存数据保留**。
- 意见 offset 超出旧 body:`computeLineRange` 内部钳制(复用,不重写)。

## 测试策略

`packages/frontend/tests/review-diff-prior-comments.test.tsx`(渲染级):

1. diff on + prior 有 3 条意见 → 侧栏(role=complementary)3 条,正文/
   作者/行号标签/来源版本标注可见;排序与 `commentOrder` 比较器一致。
2. 只读性:**断言限定在 `.prior-comments` 容器内**(`within`),fixture
   同时含当前版与上一版评论——容器内无 `comment-bubble__actions`、无
   textbox;当前版侧栏的交互不受影响(容器外 actions 照常存在)。
3. 0 条意见 → EmptyState 文案。
4. diff off → 侧栏不存在;**historical 视图 + diffMode 残留 true →
   侧栏不渲染**(一轮 P1 专项)。
5. i18n key 存在性(zh/en)。
6. 布局:`.review-diff-layout` 存在时 `.diff-view` 仍可被既有测试选择器
   命中(不破坏 `review-diff-*` 既有连续性测试)。
