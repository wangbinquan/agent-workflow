# RFC-241 — 技术设计

## 数据流(零后端改动)

`reviews.detail.tsx` 的 diff 分支已有:

- `priorVersion`(versions 列表里最近一条非当前版本);
- `priorBody = GET /api/reviews/:nodeRunId/versions/:priorVersion.id`
  → `DocVersionWithBodyAndComments`,其中 `comments: ReviewComment[]`
  迄今只用了 `body`。

本 RFC 仅新增消费 `priorBody.data.comments`。

## 组件

新公共组件 `components/review/PriorCommentsSidebar.tsx`:

- Props:`{ comments: ReviewComment[]; versionLabel: string }`。
- 视觉复用 comment-bubble 命名空间(`comment-bubble__section` /
  `__line-ref` 等既有 class,CLAUDE.md 前台一致性强制),外层新
  `.prior-comments`(只读侧栏容器)样式挂 `styles.css`,与
  `ReviewDocPane` 评论侧栏同宽同间距;**不含**任何 action 按钮区。
- 排序沿用现有侧栏语义(anchor sectionPath → 行号 → createdAt)。
- 空态用 `<EmptyState>`。
- 角色徽标沿用现有作者行渲染(UI-only,不进 prompt——RFC-099 隔离
  不变量不受影响,本组件纯展示)。

`reviews.detail.tsx` diff 分支布局:`diff-view` 外套两栏
(`.review-diff-layout`:主列 diff + 侧栏固定宽),仅 diff on 且
`priorVersion !== null` 时渲染侧栏;`priorBody` 加载中沿用现有
`<LoadingState>`。

## 失败模式

- priorBody 请求失败:沿用页面现有错误呈现(`<ErrorBanner>` 域),侧栏
  显示重试态而不是静默消失。
- 意见的 `anchor.lineStart/lineEnd` 超出旧文档(历史数据):行号标签
  按现有 `lineLabel` 容错逻辑显示(复用,不重写)。

## 测试策略

`packages/frontend/tests/review-diff-prior-comments.test.tsx`(渲染级):

1. diff on + prior 有 3 条意见 → 侧栏 3 条,正文/作者/锚点路径文本可见,
   来源版本标注可见。
2. 只读性:无 `comment-bubble__actions`、无编辑/删除按钮,`textbox`
   role 数为 0。
3. 0 条意见 → EmptyState 文案。
4. diff off → 侧栏不存在;正常模式评论交互测试(既有)零回归。
5. i18n key 存在性(zh/en)。
