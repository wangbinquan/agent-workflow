# RFC-241 — 技术设计（v7,实现期机制修订:锚定迁至 hast 阶段)

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


## 阶段 2:上一版意见锚定(v7;v5 设计门修订 + v6 聚焦复核收口 + 实现期 hast 迁移)

### 实现期机制修订(v7,代码现实强约束)

v5/v6 的机制层写在 `wrapAnchorsInDom`(后挂载 DOM 突变)上;实现时发现
该函数是 **legacy 遗留物**——当前版锚定早已在 RFC-051 迁至
`rehypeWrapAnchors`(hast 插件),其文件头明确记载迁移原因:后挂载突变
在 **body 变化时崩掉 React reconciliation**。diff 视图恰恰频繁重建 body
(granularity / 版本切换),照 v6 原文实现会复活已知崩溃类。因此**全部
锚定语义保持不变,机制承载体从 DOM 层迁到 hast 层**:

- `rehypeWrapAnchors` 增加 opts
  `{ markClass?, strictOccurrence?, excludeClasses?, tableGuard? }`,全部
  缺省时与旧行为逐字节一致(当前版 Prose 调用零改动;既有
  prose-anchors 测试锁定)。excludeClasses 按 className token 剪整棵子树
  出流;tableGuard 在 hast 上按破例 1 的 (a)/(b) 条件判表并整锚放弃。
- `MarkdownDiffView` 新增 `priorAnchors` prop,在自己的 rehype 链尾
  (katex / autolink 的 className 落地之后)推入参数化插件;策略常量
  (mark class `prior-comment-anchor`、排除列表、word 档 tableGuard)
  集中在该文件。DiffView 透传。
- **unwrap / 幂等问题整体消失**(纯渲染,无后挂载突变);「未定位」分
  类改为**只读 DOM 查询**(mark 是否存在),无渲染期副信道。
- v5 机制 1 的「wrapAnchorsInDom 参数化 + unwrapAnchors 同步参数化」作
  废;legacy 文件与其测试原样保留(anchor.ts 选区计算仍引用其类型)。
- 帮助函数落 `lib/review/anchorMarks.ts`:`setActiveAnchorMarks`(整组
  data-active,React 不管此属性,既有 pane 同款模式)与
  `scrollToAnchorMark`(instant 滚动,RFC-082 fix 随迁)。

**成立面修正(v7)**:v5「fence/inline code(SKIP_TAGS 兜住)」一句作废
——hast 路径无 SKIP_TAGS,且**不应**排除 pre/code:锚创建侧的
`occurrenceIndex` 按 **sourceBody**(源码全文,含 code 文本)计数
(`anchor.ts` findAllOccurrences),排除 pre/code 会让「selectedText 同
时出现在行内 code 与正文」这一常见场景计数左移、错钉后一次出现。未变
更 code 保序入流,与创建侧计数域对齐。代价是新增破例 4(见下)。

**破例 4(v7 新增):变更 fenced code block。** RFC-010 的既有取舍是块
级原子还原不携带 marker(marker 落 fence 头部破坏解析、落内部只是 code
文本里的 PUA 字符),变更 fence 在 merged 里是"旧块 + 新块"两段无
marker 的普通代码块——**新 fence 内容以 context 形态进入文本流**。残余
风险面:「锚点位于变更 fence 之后 + selectedText 恰好出现在新 fence 内
容中」→ 计数右移(strict 兜不住次数增加)。处置:**接受为残余**并以
`markdown-diff-del-view-invariant.test.ts` 的破例锁定用例钉住形态——
若未来 markdownDiff 给 fence 携带 marker,该锁变红,届时回头收紧锚定侧。
锚在旧 fence 文本上的意见仍可命中(旧内容保序在流中)。

### 阶段 2 原设计(v5 语义 + v6 聚焦复核修订;机制段以 v7 修订为准)

### 语义基础(v5 改写:保序近似 + 破例清单,非「逐字等于」)

合并文档排除 `.diff-ins` 子树后的 del/context 文本流,相对上一版原文是
**保序近似**——大面成立、破例有限且可判定:

**成立面**(评审实证):word 档普通文本(diffArrays + trimCommonAffixes
保序)、line/block 档全部(含 repairBrokenLinePrefixes 拆行——DEL 行 =
del 视图 = 旧行逐字;repairMergedTableRuns 重建保序)、fence/inline code
(SKIP_TAGS 兜住)、结构裸行(零渲染文本)。

**破例清单与处置**(设计门一轮 P1×3):

1. **word 档配对表 / merged 重建表**:行相似度贪心与「未配对 DEL 前置」
   会重排旧行顺序;降级 cell 的垫片空格 / 色块 / 奇偶垫片会改写字面。
   **处置(聚焦复核修订):word 档下,锚定命中落在满足以下任一条件的
   `<table>` 内即回退未定位**——(a) 表含 `.diff-ins`;(b) 表含
   `.diff-del` **且**存在不属任何 diff 标记的 context 文本(纯删减词级
   配对表无 ins、但重排照发,仅此条件能拦)。纯 DEL 原子化整表(全部
   文本在 del 内、无 context)保序保字面,锚定保留。**分档生效**:此
   校验仅 word 档必要;line/block 档表内为行级/块级保序(同键表行级
   增删),不校验、不白丢锚定。
2. **word 档行内数学式**:正文 math 无原子化保护,marker 落入
   `inlineMath.value` 被 `resolveMarkedString` 解析成**仅新版**,新公式
   文本(含 KaTeX HTML 输出)不带 `.diff-ins` 包装、会污染文本流。
   **处置:排除选择器扩为列表 `['.diff-ins', '.katex', '.katex-error']`**
   (聚焦复核:ParseError 形态的类名是 `katex-error`,`.katex` 不匹配)
   ——KaTeX 输出整树不入流(旧公式本就被剥离,新公式随排除消失):
   锚在公式上的意见自然未定位回退,公式之后的锚不受计数污染。
   line/block 档 math 整体进 diffMark,天然安全。
3. **出现次数不足 / 次序漂移**:现 `wrapAnchorsInDom` 对次数不足 clamp
   到最后一次——那是「当前版=锚定源」的容错;prior 路径文档≠锚定源,
   clamp 会把该回退的**静默钉错**。**处置:新增 `strictOccurrence`
   选项——次数不足即放弃该锚(回退未定位),不 clamp**;现有调用不传,
   行为不变。`occurrenceIndex` 本为源码域计数、渲染域天然近似——
   strict + 表格校验双闸后,残余错位风险限于「同 selectedText 在
   非表格区域因删除减少出现次」一类,strict 直接回退,不错钉。

**不变量守卫测试**(聚焦复核修订,v7 定稿归一化规范——逐字节等式因
ins 行的 context 前缀/空行、removed 原子 pad、拆行修复插行而恒不成立):
属性测试改**归一化比较**,规则写死在
`markdown-diff-del-view-invariant.test.ts`:del 视图与 L 两侧同规则——
先按行丢弃「结构框架行」(仅由空白与结构前缀字符——`>` `#` `*` `+`
反引号 `-` 数字 `.` `=`——组成:空行、
ins 行剥掉内容后的 `- `/`### `/fence 框架残留、setext 下划线、pad 空
行),再 `tokenizeForWordDiff` 切词并丢纯空白 token,序列逐项相等
(word/line 两档,无表格/无 math 夹具)。该规则保住防污染方向:ins 内
容若漏进 del 视图,所在行含非结构字符,必不等。破例清单各配回退用例;
变更 fence 单列破例锁定(见破例 4)。

### 机制(v5:参数化契约,撤回「签名不变」措辞——设计门一轮 P1)

1. **`wrapAnchorsInDom(root, anchors, opts?)`**,
   `opts = { excludeSelectors?: string[]; markClass?: string; strictOccurrence?: boolean }`:
   文本遍历跳过匹配任一 excludeSelectors 的元素子树;mark class 取
   `markClass ?? 'comment-anchor'`;**unwrapAnchors 同步参数化**(按同
   一 class 查询,保证幂等——否则 prior mark 清不掉、重复调用嵌套堆
   积);`strictOccurrence: true` 时次数不足直接跳过该锚。现有调用
   (ReviewDocPane)不传 opts,行为逐字节不变(测 11)。
2. **`useCommentBubbles` 抽取为 `hooks/useCommentBubbles.ts`**,新增参数
   `{ markSelector, headerEl, orphanPlacement }`:mark 查询用
   `markSelector`(prior 路径 `mark.prior-comment-anchor[data-comment-id]`
   前缀);headerFloor 改传显式元素 ref(prior 侧栏标题 + 「未定位」
   分节高度计入 floor,不再硬编码 `.review-detail__sidebar-header`);
   `computeBubbleLayout` 增加 `orphanPlacement: 'top' | 'bottom'`(默认
   'bottom' 保 ReviewDocPane 现行为逐字节不变;prior 取 'top' 落实
   「未定位列于顶部」),纯函数用例双分支锁定。ReviewDocPane 改用抽取
   版并显式传等价默认参数。
3. **点击滚动/高亮**:抽 `scrollToCommentAnchor(root, commentId, markClass)`
   帮助函数,`querySelectorAll` **多节点**——active 时整组 mark 加
   `data-active`,滚动到第一段;ReviewDocPane 迁移到同一帮助函数(单
   节点场景行为不变)。
4. **接线**:diff 主列包 `.review-diff-doc` ref;effect 在 merged 渲染 /
   意见集变化后:unwrap(prior class)→ wrap(exclude
   `['.diff-ins', '.katex']`、markClass `prior-comment-anchor`、strict)
   → **表格校验(仅 word 档)**:mark 的 `closest('table')` 满足语义
   基础破例 1 的 (a)/(b) 条件 → unwrap 该意见全部 mark 并归入未定位。
5. **「未定位」分节**:置于侧栏标题之下、锚定气泡之前;内部排序沿用
   `compareReviewComments`;分节标题 i18n(「未能定位到原文 · N 条」)。
6. **样式**(设计门一轮 P2):`mark.prior-comment-anchor` 显式
   `background: transparent`(含 dark 主题变体,防 UA 黄底压 diff 红
   绿)+ 中性点状下划线(色 `var(--muted)`);落在 `.diff-del` 内与删
   除线叠加为「点下划线 + 删除线」,接受并写明;active 复用
   `data-active` 属性,flash 与现有 comment-anchor 同款。锚定气泡加
   `.comment-bubble--anchored`:`cursor: pointer` + hover 抬升恢复;
   未定位气泡维持 default。

### 测试(v5 拆分——JSDOM 无布局/滚动,断言面三分)

7. 渲染级:锚文本未变 → mark 存在于 context、data-comment-id 正确;
   点击气泡 → 整组 mark `data-active` + scrollIntoView spy 被调。
8. 锚文本被删 → mark 落 `.diff-del` 内;被词级切开 → 同 comment-id
   多段 mark,点击整组 active。
9. ins-排除 / strict:当前版新增相同字样不改变命中;**次数不足 → 未
   定位回退、绝不 clamp 错钉**;**含 ins 表格内命中 → 回退**(配对表
   重排反例);word 档 math 意见 → 回退且其后锚不受计数污染。
10. 未定位分节:位于顶部、排序、anchored/未定位的 cursor+hover 分别
    断言(类名级)。
11. 兼容:wrapAnchorsInDom 无 opts 行为逐字节不变;ReviewDocPane 经
    抽取 hook + 帮助函数后既有测试零回归。
12. 不变量属性测试(语义基础)+ computeBubbleLayout orphanPlacement
    双分支纯函数用例。

### 设计门记录(阶段 2)

- 实现期修订(2026-07-31,v7):发现 v5/v6 机制承载体 `wrapAnchorsInDom`
  是 RFC-051 已废弃的后挂载 DOM 突变(其替换动机——body 变化崩
  reconciliation——对 diff 视图同样成立),锚定迁至 hast 阶段
  (`rehypeWrapAnchors` opts 参数化),语义决策(strict / 排除 / 表格
  校验 / 未定位 / orphanPlacement)全部保留;成立面「SKIP_TAGS 兜住」
  作废(创建侧计数域含 code 文本,排除 pre/code 反错钉),新增破例 4
  (变更 fence 无 marker,新内容以 context 入流,接受为残余 + 破例锁
  定);测 12 归一化规范定稿(框架行丢弃 + 空白 token 过滤)。由实现
  门统一复核。
- 聚焦复核(2026-07-31,同代理,`NEEDS_REVISION`→折入本 v6 后收口;
  P1 2/3/4 全闭、P1-1 主体闭合):纯删减词级配对表残缝(无 ins、重排照
  发)→ 表校验条件扩为「含 ins,或含 del 且 context 共存」且分档生效
  (line/block 不校验);`.katex-error` 入排除列表;属性测试改归一化
  token 序列比较(逐字节等式因 context 前缀/pad/拆行恒不成立)。评审
  结论:折入后无需再评,可进实现,实现门按测 9/12 修订稿验证。
- 一轮(2026-07-31,独立子代理续评,`NEEDS_REVISION`,4 P1 + 2 P2):
  「逐字等于/精确匹配」与实码三处相悖(配对表重排+垫片改写、word math
  单版本化污染、clamp+源码域计数)→ 保序近似 + 破例清单 + strict 匹配
  + 表格校验回退 + `.katex` 排除;「签名不变」与四处硬编码冲突 → 全套
  参数化契约(markClass/unwrap 幂等/markSelector/headerEl/
  orphanPlacement/多节点 active);样式(透明底/暗色变体/删除线叠加)
  与测试三分拆分补全。
