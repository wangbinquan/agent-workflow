# RFC-241 — 技术设计（v4,阶段 2 锚定增补）

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
  `.prior-comments .comment-bubble { position: static; margin-bottom: 8px; cursor: default; }`
  (与 `styles.css` 720px 媒体查询先例同法),并抑制 hover 抬升阴影
  (`.prior-comments .comment-bubble:hover { box-shadow: 基线值 }`)——
  本体的 `cursor: pointer` + hover 阴影语义是"点击跳转文中锚点",本
  侧栏无锚定无 onClick,不覆盖会造成可点假象(二轮 P2)。**无** action
  区(`comment-bubble__actions` 不渲染)。**不显示时间戳**(既有
  comment-bubble 与版本详情页均不渲染 createdAt,proposal 已同步删
  "时间",二轮 P2 勘误)。
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
**响应式**(二轮 P2 补阈值):`.review-diff-layout` 两栏为
`minmax(0, 1fr) minmax(240px, 320px)`(侧栏可先压缩到 240px);视口
**≤1100px 即内层单列堆叠**(侧栏移至 diff 下方)——外层 body 列宽 ≈
内容区 − 318px(当前版侧栏拖宽时至 −558px),仅 ≤720px 堆叠会在
721~约 1100px 区间把 diff 主列挤到 <300px 不可读。320px 上限为写死值,
不复用可拖拽的 `--review-sidebar-width`(「同宽」与「固定宽」二选一,
取固定,一轮 P2)。

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

## 设计门记录

- 一轮(2026-07-31,独立子代理评审,`NEEDS_REVISION`,5 P1 + 4 P2):
  绝对定位气泡叠压、Props 缺 body、排序引用不存在语义、双意见栏共存
  未定义、historical 泄漏 + 失败模式矛盾、宽度矛盾、只读断言作用域、
  a11y——全部折入 v2。
- 二轮(2026-07-31,同代理续评,`NEEDS_REVISION`,0 P1 + 3 P2;一轮
  九项修订逐条核验**全部实闭**):proposal「时间」措辞矛盾(删)、
  721~1100px 区间 diff 被挤穿(minmax 侧栏先缩 + ≤1100px 堆叠)、
  `cursor: pointer` 可点假象(覆盖 cursor 与 hover 阴影)——折入本
  v3。评审结论:无需三轮全量,可进实现,实现门统一验证。


## 阶段 2:上一版意见锚定(2026-07-31 用户增补需求,推翻 v1「不做内联
锚定」拍板)

### 语义基础(为什么能精确锚定而非启发式)

词档 diff 的合并文档 = 上一版与当前版的交错,其中**排除 `.diff-ins`
子树后的文本流(context + del)逐字等于上一版原文**——这是 RFC-010/240
diff 管线的构造不变量(word/line 对以换行结尾输入逐字节还原的同一来
源)。因此上一版意见的 `selectedText + occurrenceIndex` 在「ins-排除
文本流」上有与原文完全一致的出现次语义,锚定是**精确匹配**:

- 锚文本未变 → 落在 context 区;
- 锚文本被删/被改 → 落在红色 del 区;变更把旧文本切成多段时(如
  `{D}a{d}{I}x{i}{D}b{d}`),匹配跨段成立,mark 分段包裹、整组高亮;
- 找不到(如锚落在整表原子化重排区、或非 word 档的行/块粒度重排)→
  该条意见回退 v1 无锚气泡形态(显示章节路径,不定位)。

line/块档的合并文档同样满足「ins-排除 = 旧文」不变量(diffLines/块级
同为交错构造),锚定机制三档通用。

### 机制(全部复用既有原语,最小扩展)

1. **`wrapAnchorsInDom` 扩展**:新增可选 `excludeSelector?: string`——
   遍历文本节点时跳过匹配该选择器的元素子树(本 RFC 传 `.diff-ins`)。
   既有调用(ReviewDocPane)不传,行为逐字节不变。SKIP_TAGS(PRE/CODE)
   语义保持:意见若锚在代码块内,与现状同样不匹配,回退无锚。
2. **`useCommentBubbles` 抽取**:从 ReviewDocPane 私有提为
   `hooks/useCommentBubbles.ts` 共享(签名不变),ReviewDocPane 与
   PriorCommentsSidebar 两处消费。
3. **diff 主列容器 ref**:`.review-diff-layout` 第一列包一层带 ref 的
   div(`.review-diff-doc`),effect 在 merged 渲染或意见变化后调用
   `wrapAnchorsInDom(ref, anchors, { excludeSelector: '.diff-ins' })`;
   mark 用独立 class `prior-comment-anchor`(与当前版 `comment-anchor`
   区分,样式同视觉但色调弱化,避免与 diff 红绿冲突——具体:中性
   下划线高亮,active 时同现有 flash 效果)。
4. **气泡对位与交互**:锚定成功的气泡随 mark 纵向对位(useCommentBubbles
   同款);点击滚动至 mark 并短暂高亮(复用 ReviewDocPane 的
   activeCommentId/flash 模式,抽同一份 scroll+flash 帮助函数);锚定
   失败的气泡集中列在侧栏顶部「未定位」分节(v1 形态)。cursor 规则
   更新:**锚定气泡 cursor: pointer(可跳转),未锚定 cursor: default**
   ——v3「全部 default」相应作废;hover 抬升仅锚定气泡恢复。
5. **只读不变**:锚定仅新增「跳转/高亮」,无任何编辑入口;marks 不参与
   当前版评论的划词选区(选区逻辑仅在非 diff 模式启用,现状已然)。

### 测试增补(阶段 2)

7. 锚文本未变 → mark 落 context、气泡随位、点击滚动高亮(scrollIntoView
   调用与 active class 断言)。
8. 锚文本被删 → mark 落 `.diff-del` 内;被词级切开 → 多段 mark 同
   comment-id、点击整组高亮。
9. ins-排除语义:当前版新增了与锚文本相同的字样时,occurrenceIndex 仍
   按旧文顺序命中(新增区不计入出现次)。
10. 找不到锚 → 回退无锚气泡且列于「未定位」分节;cursor/hover 按锚定
    与否分别断言。
11. wrapAnchorsInDom excludeSelector 单测:既有无参调用行为逐字节不变
    (ReviewDocPane 路径回归)。

### 设计门记录(阶段 2)

- 增补轮(待跑):对抗复核锚定语义(ins-排除不变量的三档成立性、跨段
  mark、occurrence 计数)、hook 抽取回归面、交互/样式规范完备性。
