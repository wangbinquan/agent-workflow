# RFC-051 — 技术设计

> 配套 `proposal.md`。本文件给具体接口契约、改动落点、失败模式 + 测试策略。

## 1. 改动总览

| 层       | 文件                                                                          | 改动                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| frontend | `packages/frontend/src/routes/clarify.detail.tsx`                             | 在 `nodeRunId`（route param）变化时复位本地 state：`answers={}` + `draftLoaded=false` + `initialFocusedRef.current=false`；既有 seeding effect 因 `draftLoaded` 转 false 自然重跑 |
| frontend | `packages/frontend/src/components/prose/Prose.tsx`                            | 新可选 prop `anchors?: ReadonlyArray<{commentId,selectedText,occurrenceIndex}>`；当提供且非空时把 `rehypeWrapAnchors({anchors})` 拼到 `rehypePlugins` 末尾                            |
| frontend | `packages/frontend/src/components/prose/rehypeWrapAnchors.ts`                 | 新文件，导出 `rehypeWrapAnchors(opts)` —— 走 hast 树包 `<mark class="comment-anchor" data-comment-id=...>`；不依赖 DOM                                                                |
| frontend | `packages/frontend/src/routes/reviews.detail.tsx`                             | 删除 `useLayoutEffect(() => wrapAnchorsInDom(markdownRef.current, ...), [sortedComments, diffMode])` 整段；把 `sortedComments` map 成 `anchors` prop 传给 `<Prose>`；保留所有 measure / IntersectionObserver / `data-active` 逻辑 |
| frontend | `packages/frontend/src/lib/review/wrapAnchorsInDom.ts`                        | **不动**——其辅助函数 `collectTextNodes` / `findAllOccurrences` 仍被 `anchor.ts`（选区→anchor 计算）使用                                                                          |
| tests    | `packages/frontend/tests/clarify-detail-nodeRunId-switch.test.tsx`            | 新文件，新增 2 case：(a) 切 nodeRunId 重新渲染问题；(b) 切 nodeRunId 复位 answers 状态                                                                                              |
| tests    | `packages/frontend/tests/reviews-detail-anchor-rehype.test.tsx`               | 新文件，新增 3 case：(a) React 输出 HTML 含 `<mark>`；(b) currentBody 改变后高亮跟新 anchor 走且不抛；(c) AC-4 grep 守卫：reviews.detail.tsx 不再含 `wrapAnchorsInDom(` 调用 |
| tests    | `packages/frontend/tests/prose-anchors-prop.test.tsx`                         | 新文件，新增 2 case：(a) 不传 anchors 时 Prose 输出与传 `anchors=[]` 完全等价；(b) 多 occurrence 时按 `occurrenceIndex` 精确锁第 N 个                                                  |

零 backend / shared / DB / WS / i18n 改动；零 RFC-008 `<Prose>` 既有调用方迁移。

## 2. clarify 复位逻辑

### 2.1 路径参数变化即复位

`clarify.detail.tsx` 顶部加：

```ts
const initialFocusedRef = useRef(false)  // 已存在
// ...
// RFC-051: 同一路由跨 nodeRunId 切换时 React 复用 ClarifyDetailPage
// 实例。draftLoaded 是一次性闸门，answers 是按上一会话的 question.id
// 键控的字典；不复位的话新会话的 questions[].id 查不到键，导致
// `s.questions.map(q => answers[q.id] === undefined ? null : <QuestionForm/>)`
// 整块返回 null（用户复现的"第二条反问空白"）。
useEffect(() => {
  setAnswers({})
  setDraftLoaded(false)
  initialFocusedRef.current = false
  // draftTimerRef 也要 clear，避免上条会话的 debounce 写入跨会话生效。
  if (draftTimerRef.current !== null) {
    clearTimeout(draftTimerRef.current)
    draftTimerRef.current = null
  }
}, [nodeRunId])
```

放在已有 seeding effect**之前**——React 18+ batch 同一渲染里的多个 setter，
不会出现"先 setAnswers 空、再 seeding 看到 draftLoaded=false 立即重 seed"
的中间帧；但即便有也是正确语义（最终态正确）。

不用 `key={nodeRunId}` 强制重挂载的理由：本组件挂载时还要订阅
`useClarifyWs(taskId)` —— 同一 taskId 下不同 nodeRunId 切换时 WS hook 内部
可以复用 socket，重挂载会让它 disconnect + reconnect，损害用户体验。手动
复位粒度更精确，只 reset 真正与 session 绑定的 state。

### 2.2 不需要复位的 state

- `submitMut` mutation：跨 session 即便残留也只是"提交按钮一瞬 disabled"，
  下次提交会用新 session 重新调度；不需要 reset。
- `peers` / `taskQuery` 是 react-query 管理的，key 含 `session.data?.taskId`
  / `nodeRunId`，跨切换会自然 invalidate / refetch；不需要 reset。
- `decisionDialog`（review 才有）：clarify 没有这块。

### 2.3 既有 seeding effect 不动

L85-128 整段 seeding effect 逻辑保留——这次复位让 `draftLoaded` 重置为
false，seeding effect 因 `[draftLoaded, session.data]` 重跑，按新 session
重新填 `answers` 字典 + 重新加载 IDB 草稿。

## 3. review anchor 走 react 树

### 3.1 新 rehype 插件 `rehypeWrapAnchors`

```ts
// packages/frontend/src/components/prose/rehypeWrapAnchors.ts
import { visit } from 'unist-util-visit'
import type { Element, ElementContent, Root, Text } from 'hast'

export interface AnchorWrapInput {
  /** Comment id, written to `data-comment-id` on each <mark>. */
  commentId: string
  /** Plain-text selection from the original anchor. */
  selectedText: string
  /** 1-based occurrence index. */
  occurrenceIndex: number
}

export interface RehypeWrapAnchorsOptions {
  anchors: ReadonlyArray<AnchorWrapInput>
}

/**
 * Walk all hast text nodes, find the n-th occurrence of each anchor's
 * `selectedText` in the concatenated text, and wrap the covered text-
 * node sub-ranges with `<mark class="comment-anchor" data-comment-id>`.
 *
 * Behavior parity with the legacy DOM-mutation utility
 * (`lib/review/wrapAnchorsInDom.ts`):
 *   - Searches by linearized text content; selections that cross
 *     element boundaries still match.
 *   - Selections crossing multiple text nodes produce multiple sibling
 *     <mark> elements all sharing the same `data-comment-id`.
 *   - Occurrence index is clamped to `[0, occurrences-1]`; out-of-range
 *     anchors fall back to the last occurrence (matches DOM utility).
 *
 * Difference: this plugin operates on the hast tree before react-markdown
 * mounts the output, so the <mark> elements live inside the React tree
 * and are managed by react reconciliation. The old DOM-mutation path
 * caused `NotFoundError: removeChild` when react re-rendered the body
 * (RFC-051 §Background bug 2).
 */
export function rehypeWrapAnchors(opts: RehypeWrapAnchorsOptions) {
  const { anchors } = opts
  return (tree: Root): void => {
    if (anchors.length === 0) return
    interface Seg {
      parent: Root | Element
      indexInParent: number
      offsetStart: number
      node: Text
    }
    const segments: Seg[] = []
    let cursor = 0
    visit(tree, 'text', (node, indexInParent, parent) => {
      if (parent === undefined || parent === null) return
      if (parent.type !== 'root' && parent.type !== 'element') return
      if (indexInParent === undefined || indexInParent === null) return
      segments.push({ parent, indexInParent, offsetStart: cursor, node })
      cursor += node.value.length
    })
    const full = segments.map((s) => s.node.value).join('')
    const wrapsPerSegment = new Map<number, Array<{ from: number; to: number; commentId: string }>>()
    for (const a of anchors) {
      if (a.selectedText.length === 0) continue
      const occs: number[] = []
      let pos = 0
      while (pos <= full.length - a.selectedText.length) {
        const i = full.indexOf(a.selectedText, pos)
        if (i === -1) break
        occs.push(i)
        pos = i + 1
      }
      if (occs.length === 0) continue
      const clamped = Math.min(Math.max(a.occurrenceIndex - 1, 0), occs.length - 1)
      const startOff = occs[clamped]!
      const endOff = startOff + a.selectedText.length
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]!
        const segEnd = seg.offsetStart + seg.node.value.length
        if (segEnd <= startOff) continue
        if (seg.offsetStart >= endOff) break
        const from = Math.max(0, startOff - seg.offsetStart)
        const to = Math.min(seg.node.value.length, endOff - seg.offsetStart)
        if (from >= to) continue
        const list = wrapsPerSegment.get(si) ?? []
        list.push({ from, to, commentId: a.commentId })
        wrapsPerSegment.set(si, list)
      }
    }
    if (wrapsPerSegment.size === 0) return
    // Rebuild parents in reverse `indexInParent` order so splicing earlier
    // segments doesn't shift later segments' indices in the same parent.
    const byParent = new Map<Root | Element, Array<{ segIdx: number; indexInParent: number }>>()
    for (const segIdx of wrapsPerSegment.keys()) {
      const seg = segments[segIdx]!
      const list = byParent.get(seg.parent) ?? []
      list.push({ segIdx, indexInParent: seg.indexInParent })
      byParent.set(seg.parent, list)
    }
    for (const [parent, list] of byParent) {
      list.sort((a, b) => b.indexInParent - a.indexInParent)
      for (const item of list) {
        const seg = segments[item.segIdx]!
        const ranges = (wrapsPerSegment.get(item.segIdx) ?? []).slice().sort((a, b) => a.from - b.from)
        const value = seg.node.value
        const replacement: ElementContent[] = []
        let cur = 0
        for (const r of ranges) {
          const from = Math.max(r.from, cur)
          const to = Math.max(r.to, cur)
          if (from > cur) replacement.push({ type: 'text', value: value.slice(cur, from) })
          if (to > from) {
            replacement.push({
              type: 'element',
              tagName: 'mark',
              properties: { className: ['comment-anchor'], 'data-comment-id': r.commentId },
              children: [{ type: 'text', value: value.slice(from, to) }],
            })
          }
          cur = to
        }
        if (cur < value.length) replacement.push({ type: 'text', value: value.slice(cur) })
        parent.children.splice(item.indexInParent, 1, ...replacement)
      }
    }
  }
}
```

注意 `properties` 里写 `'data-comment-id'`（带连字符的字面 key）而不是
camelCase `dataCommentId`——前者在 `property-information` 默认行为下原样
透传到 HTML 属性、不做 camelCase ↔ kebab-case 转换，与下游 CSS
`mark.comment-anchor[data-comment-id="..."]` 选择器精确对齐；新增一条
单测固化该属性键。`className: ['comment-anchor']` 沿用 hast 数组形态，
react-markdown 输出时变成 `class="comment-anchor"`。

### 3.2 `<Prose>` 接收可选 anchors

`Prose.tsx` 改动两处：

```ts
export interface ProseProps {
  // ...既有字段
  /**
   * RFC-051 — Optional anchors. When provided, a local rehype plugin
   * wraps each occurrence of an anchor's `selectedText` with
   * `<mark class="comment-anchor" data-comment-id>` *inside the React
   * tree* (not via post-mount DOM mutation). Empty array is treated as
   * "no anchors" — output is byte-identical to the omitted-prop call.
   *
   * Only review-detail uses this today; other Prose consumers (editor
   * preview / memory body / distill job detail) should not pass it.
   */
  anchors?: ReadonlyArray<AnchorWrapInput>
}
```

`rehypePlugins` 拼装：

```ts
const rehypePlugins = useMemo(
  () => {
    const base: PluggableList = [/* 既有四个：katex / slug / autolink / external-links */]
    if (anchors !== undefined && anchors.length > 0) {
      base.push([rehypeWrapAnchors, { anchors }])
    }
    return base
  },
  [/* 既有 deps */, anchors],
)
```

`anchors` 引用稳定性由调用方负责（review-detail 用 `useMemo` 包，已经
按 `sortedComments` cache）。Prose 不做 deep-eq，引用变即重生成 plugin
列表 + 触发 react-markdown 重渲染——这是预期行为，因为 anchors 变化
意味着 marks 集合需要重新计算。

### 3.3 review-detail.tsx 删 mutate effect + 接通 anchors

删除 L512-523：

```ts
- useLayoutEffect(() => {
-   if (markdownRef.current === null) return
-   if (diffMode) return
-   wrapAnchorsInDom(
-     markdownRef.current,
-     sortedComments.map((c) => ({
-       commentId: c.id,
-       selectedText: c.anchor.selectedText,
-       occurrenceIndex: c.anchor.occurrenceIndex,
-     })),
-   )
- }, [sortedComments, diffMode])
```

import 同步删 `wrapAnchorsInDom`。

`<Prose>` 调用改为：

```ts
const anchors = useMemo(
  () =>
    sortedComments.map((c) => ({
      commentId: c.id,
      selectedText: c.anchor.selectedText,
      occurrenceIndex: c.anchor.occurrenceIndex,
    })),
  [sortedComments],
)
// ...
<Prose
  body={activeBody ?? ''}
  taskId={data.summary.taskId}
  plantumlEndpoint={config.data?.plantumlEndpoint}
  plantumlAuthHeader={config.data?.plantumlAuthHeader}
  anchors={diffMode ? undefined : anchors}
/>
```

`diffMode` 开启时不传 anchors，与原 `useLayoutEffect` `if (diffMode) return`
早退保持一致语义（DiffView 走自己的渲染路径，不需要 mark 高亮）。

### 3.4 下游 measure / scroll-spy / data-active 不动

- `useLayoutEffect`（L529-634）按 `markdownRef.current.querySelector(
  'mark.comment-anchor[data-comment-id="..."]')` 找 anchor 元素测高——
  现在 mark 由 react 渲染，selector 命中**完全等价**，零改动。
- `data-active` 切换（L642-653）同上。
- IntersectionObserver（L724-742）按 `[data-comment-id]` 选择，等价。
- `wrapAnchorsInDom.ts` 模块保留——`anchor.ts` 中 `computeAnchorFromSelection`
  仍调用 `collectTextNodes` / `findAllOccurrences` 处理选区→anchor 计算
  （选区是用户操作 DOM 给的，必然走 DOM 路径）。仅 review-detail 这一处
  调用点删除。

## 4. 失败模式 & 风险

| 模式                                                  | 处理                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| anchor 的 `selectedText` 在新 body 里找不到           | 同既有 DOM 工具：跳过该 anchor 不抛错。bubble-positioning effect 已有 orphan 分支处理（located vs orphans）          |
| anchor.occurrenceIndex 越界（删评论后位置漂移）       | 同既有：clamp 到最后一个 occurrence                                                                                  |
| 多 anchor 选区重叠                                    | 当前 DOM 工具不显式处理；rehype 实现里"区间按 from 排序后顺序生成 mark"，重叠区段被后一个 anchor 覆盖。这是既有行为的延续，本 RFC 不引入新缺陷 |
| anchors 数组引用每次 render 都变（调用方未 memo）    | rehypePlugins 跟着变，react-markdown 重新跑——性能可接受（review-detail 已 memo `sortedComments` → memo `anchors`）  |
| ShikiPre 异步替换 `<pre><code>` 内容                  | 与既有 DOM 工具行为一致——mark 在 react 渲染时插入，shiki post-mount 替换 innerHTML 会覆盖。code-block 内不允许加评论是隐含约束 |
| 历史只读模式（RFC-013 `view.mode === 'historical'`）  | `<Prose body={historicalDetail.data?.body}>` 同样接 `anchors` prop（评论从 historicalDetail.comments 派生）——既有 readonly 流自然包含 |

## 5. 与既有 RFC 的关系

- **RFC-005**（review 节点）：anchor 高亮是 RFC-005 PR-D 落地的视觉契约。
  本 RFC 改实现路径不改契约——`<mark class="comment-anchor" data-comment-id>`
  渲染结果字节级一致。
- **RFC-008**（Prose 渲染器）：只新增可选 prop，老调用方不传时输出
  字节级不变（AC-5 by `prose-anchors-prop.test.tsx` case (a) 守护）。
- **RFC-009**（review 侧栏增强 / bubble 定位）：测高 / scroll-spy 全部
  通过 `[data-comment-id]` 选择器读 DOM，等价；既有测试零退化。
- **RFC-013**（review 历史版本只读视图）：`activeBody` / `activeComments`
  抽象保留——只读模式照常传 `anchors`。
- **RFC-023**（clarify 节点）：clarify 复位仅影响本组件 state；
  WS / draftStore / clarify backend 全部不动。

## 6. 测试矩阵

### 6.1 frontend tests/clarify-detail-nodeRunId-switch.test.tsx — 2 case

**Why：锁 clarify 跨 nodeRunId 复位行为；防回归到"挂载 = 一会话"假设**

- case 1：渲染 nodeRunId=A 的 session（1 question），等待 QuestionForm
  挂出；rerender 同组件但 useParams nodeRunId=B 的 session（2 question，
  question.id 与 A 不同），断言 B 的 2 个 QuestionForm 全部渲染、A 的
  question.id 不再出现在 DOM。
- case 2：A 上先 type 一段 customText 进 textarea；切到 B；切回 A，
  断言 A 的 textarea 重新走 IDB 草稿 / session.answers seed 路径（state
  不应残留 B 期间的输入；具体断言：切回 A 后 A 的 textarea value 是
  原 seed 值或空字符串而非 B 期间的输入）。

### 6.2 frontend tests/reviews-detail-anchor-rehype.test.tsx — 3 case

**Why：锁 anchor 高亮走 React 树；锁 A→B→A 不崩；锁 wrapAnchorsInDom 不再被 review-detail 调用**

- case 1：渲染 reviews.detail.tsx，body="Hello world"，comments 一条
  anchor.selectedText="world" occurrenceIndex=1。断言 `markdownRef`
  innerHTML 包含 `<mark class="comment-anchor" data-comment-id="cm_1">world</mark>`
  （字符串子串断言）；断言 react root container DOM 含 `mark[data-comment-id]`
  节点（getBoundingClientRect 测高路径仍工作）。
- case 2：渲染 review A（body "alpha"，comments anchor=alpha）→ rerender
  review B（body "bravo"，comments anchor=bravo）→ rerender 回 A（body
  "alpha"，comments anchor=alpha）。三轮间断言不抛任何异常、每轮
  `mark[data-comment-id]` 数量与 sortedComments 长度对齐。
- case 3（grep 守卫）：read `routes/reviews.detail.tsx` 源文件字符串，
  断言**不含** `wrapAnchorsInDom(` substring（AC-4）。

### 6.3 frontend tests/prose-anchors-prop.test.tsx — 2 case

**Why：锁 Prose anchors prop 对未传调用方零影响 + 多 occurrence 精确锁**

- case 1：渲染 `<Prose body="hello hello" />`（无 anchors prop）vs
  `<Prose body="hello hello" anchors={[]} />`，断言两次 outerHTML
  字节级一致（既有 Prose 调用方不传 prop 时输出不变的契约）。
- case 2：`<Prose body="hello world hello" anchors=[{commentId:'c1',
  selectedText:'hello', occurrenceIndex:2}]>`，断言只有第二个 "hello"
  被包进 mark，第一个 "hello" 不被包。

### 6.4 既有套件零退化

- `clarify-detail-route.test.tsx`（3 case）—— 不动，复位 effect 在 nodeRunId
  不变时不触发，行为等价。
- `reviews-detail-readonly-source.test.ts` / `reviews-detail-cross-heading-hint.test.ts` /
  `review-detail-bubble-redesign.test.ts` / `prose-reviews-detail.test.tsx`
  —— review 渲染输出契约不变（mark 仍在 DOM、`data-comment-id` 仍是相同
  selector 命中点），既有断言全部通过。
- `lib/review/wrapAnchorsInDom.ts` 模块及其单测（如有）保留——`anchor.ts`
  仍用其辅助函数。

## 7. 落地步骤（commit 顺序）

1. **rehype 插件 + Prose 接 anchors prop + 单测**——加 `rehypeWrapAnchors.ts` +
   改 Prose.tsx + 写 `prose-anchors-prop.test.tsx`（2 case）。这一步
   review-detail 仍走老路径，行为零变化。
2. **review-detail 切流**——删 wrapAnchorsInDom 调用 + import，传
   anchors prop；写 `reviews-detail-anchor-rehype.test.tsx`（3 case）。
3. **clarify 复位**——加 reset effect，写 `clarify-detail-nodeRunId-switch.test.tsx`（2 case）。
4. **三件套** `bun run typecheck && bun run test && bun run format:check` 全绿后
   `git add` 精确路径（多人协作原则），单个 commit
   `fix(inbox): RFC-051 anchor 走 react 树 + clarify nodeRunId 复位`。
5. push origin/main → 按 `feedback_post_commit_ci_check` 查 GitHub Actions。
