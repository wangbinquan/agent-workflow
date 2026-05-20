# RFC-051 — 收件箱页内跨条目导航的状态泄漏（产品视角）

## 背景

收件箱（`InboxDrawer`，RFC-032）落地后用户惯用流是「点开抽屉 → 一条
一条点进详情页处理 → 抽屉保持打开继续点下一条」。两类详情页在同一路由
下复用同一个 React 组件，仅 `$nodeRunId` 路径参数变化：

- `/clarify/$nodeRunId` —— `ClarifyDetailPage`
- `/reviews/$nodeRunId` —— `ReviewDetailPage`

实际部署中用户反馈两个稳定可复现的 bug：

1. **clarify 第二条空白**：先点开收件箱里反问 A，再点反问 B，B 的页面
   header + 上下文卡都正常渲染，但**问题列表整块空白**——没有任何
   `<QuestionForm>`。
2. **review 重入崩溃**：点评审 A → 点评审 B → 再点 A，页面整块崩溃；
   控制台抛 `NotFoundError: Failed to execute 'removeChild' on 'Node':
   The node to be removed is not a child of this node`，react 错误边界
   接住后页面变白。

两条本质上是同一类问题——**TanStack Router 在同一路由不同 params
之间默认不卸载组件**，而两个详情页的初始化 / DOM 处理都隐含
"一次挂载 = 一个 nodeRunId" 的假设：

- clarify：`draftLoaded` state 是一次性闸门，第一次 seed 后再也不重
  seed；`answers` 字典里堆着 A 会话的 question id，B 会话查不到键，
  全部 render null（`clarify.detail.tsx:80-128, 384-402`）。
- review：`wrapAnchorsInDom` 在 `useLayoutEffect` 里**直接 mutate**
  `<Prose>` 渲染出的 DOM，插 `<mark class="comment-anchor">` 包住
  文本节点（`reviews.detail.tsx:512-523` → `lib/review/wrapAnchorsInDom.ts:91`）。
  当 `currentBody` 变化（不止跨 nodeRunId，还包括同 nodeRunId 内
  `refetchInterval: 8000` 拉到新版本、或者 review iterate 后版本号
  bump）react-markdown 重渲染、react 在 commit 阶段试图 removeChild
  那些已被外部包进 `<mark>` 的 text node 时崩。

第一条仅造成"看不见问题"的功能性回归，但**第二条更危险**：root
cause 不限于跨 nodeRunId 重入，同 nodeRunId 内的轮询 refetch / 新版本
落地同样会触发崩溃——只是用户更难复现到。已有用户工单提到
"review iterate 后页面忽然白屏，刷新就好"，回看 stack 就是同一条
removeChild 崩溃。

## 目标

- **clarify**：在 `nodeRunId` 变化的瞬间复位本地草稿状态（`answers` /
  `draftLoaded` / `initialFocusedRef`），让收件箱里连续点击多条反问
  能依次正常渲染对应的问题列表 + 焦点行为。
- **review**：把"评审高亮"从外部 DOM mutation 路径搬进 React 渲染
  树——通过一个本地 rehype 插件让 `<mark class="comment-anchor"
  data-comment-id>` 直接出现在 `<Prose>` 输出的 hast → react 元素树
  里，由 react 自己管理；既治用户复现的"重入崩溃"，也顺手治 review
  detail 自身 refetch 路径下的同一类崩溃。
- **下游不动**：bubble 定位 / scroll-spy / `data-active` 切换 / 选区
  → anchor 计算仍然按 `mark.comment-anchor[data-comment-id]` 这个
  CSS 选择器从 DOM 读，**契约不变**；review-detail.tsx 只删
  `useLayoutEffect(wrapAnchorsInDom)` 那一处的外部 mutation。

## 非目标

- **不**改 anchor schema（`selectedText` + `occurrenceIndex` +
  `offsetStart/End` + `sectionPath`）、不改 comment / draft 序列化，
  不改 backend 任何端点；纯前台改造。
- **不**改 `<Prose>` 在非 review 调用方（编辑器 preview / memory
  审批 body / distill job detail / 任意 markdown 渲染场景）的行为。
  anchors 走可选 prop；未传 prop 的调用方 prose 渲染**字节级不变**。
- **不**在 RFC-051 范围里给 TanStack Router 加全局 `key={nodeRunId}`
  路由重挂载策略。仅对 clarify-detail 这一处做最小复位；review-detail
  通过去除外部 DOM mutation 自然就不再需要重挂载兜底。
- **不**移除 `lib/review/wrapAnchorsInDom.ts`——其内部使用的
  `collectTextNodes` / `findAllOccurrences` 工具被 RFC-013 历史版本
  只读视图、`anchor.ts` 选区计算等多处复用。仅 review-detail 这一处
  调用点删除；模块本身和它的单测保留。

## 用户故事

- **US-1**（clarify 队列处理）：作为 reviewer，打开收件箱后我可以
  连续点击多条反问条目，每次点击都看到对应反问的问题列表 + 初始焦点
  落在第一个未答问题上，不需要刷新页面或退回收件箱再进。
- **US-2**（review 队列处理）：作为 reviewer，连续点击多条评审条目
  + 在同一条评审上等待 polling refetch / 等待 agent iterate 重新落
  doc_version，页面始终保持可交互，不出现白屏 / `NotFoundError`。
- **US-3**（不打扰其它调用方）：作为代码 reviewer，看到
  `<Prose body=... taskId=...>` 在编辑器 preview / memory 详情 /
  distill job detail 等老调用点的渲染输出与 RFC-051 落地前**字节级
  一致**——anchors prop 是 review-detail 独有的扩展面。

## 验收标准

- AC-1：clarify 详情页加一条回归测试，覆盖"挂载组件后将 `nodeRunId`
  prop 切到不同的 session id，新 session 的所有 `QuestionForm` 渲染
  出来、`<input>` / `<textarea>` 数对得上 `s.questions.length`"。
- AC-2：review 详情页加一条回归测试，覆盖"组件树里 `mark.comment-
  anchor[data-comment-id]` 必须是 React 渲染的子节点（断言：
  `markdownRef` 内的 mark 节点数 = sortedComments 长度，且每个 mark
  的 `__reactFiber$*` / `data-react-managed` 标志成立或等价：本测试
  改成对 react render 输出 HTML 字符串做断言）"。
- AC-3：review 详情页加第二条回归测试，覆盖"将 `currentBody` prop
  从 'A' 改成 'B' 不抛任何异常 + 新 body 中的高亮覆盖与新评论的
  selectedText 匹配"。
- AC-4：源码层断言锁——`packages/frontend/src/routes/reviews.detail.tsx`
  整文件不再出现 `wrapAnchorsInDom(` 调用文本；`useLayoutEffect`
  里只剩下 measure / IntersectionObserver 相关逻辑。
- AC-5：i18n / 视觉零改动；本地三件套 `bun run typecheck && bun run
  test && bun run format:check` 全绿；CI 同三件套 + 单二进制 build
  smoke + Playwright e2e 全绿。

## 显式拒绝的方案

- ~~**给 `<ReviewDetailPage>` 加 `key={nodeRunId}` 强制重挂载**~~。
  能治用户看见的「重入崩溃」，但同一 nodeRunId 内 refetch /
  iterate 落新版本时 currentBody 仍会变，react 仍然要 reconcile
  外部 mutate 过的 DOM，崩溃只是被推后到下次轮询；不解决根因。
- ~~**在 useLayoutEffect 的 cleanup 里 unwrapAnchors**~~。React commit
  阶段（DOM 实际 mutation）在 layout-effect cleanup 之前；cleanup
  跑到的时候 react 已经抛过 removeChild。
- ~~**给 `<Prose body>` 预处理：在 markdown 源码里直接插 HTML
  `<mark>` 字符串**~~。`<Prose>` 显式不开 `rehype-raw`（安全考量
  原文 L8-12），inline HTML 会被 react-markdown 转义成可见字符。
