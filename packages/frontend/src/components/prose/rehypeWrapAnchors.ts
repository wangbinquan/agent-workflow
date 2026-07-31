// RFC-051 — Wrap review comment anchors inside the React tree.
//
// Replaces the legacy post-mount `wrapAnchorsInDom` (which mutated the DOM
// rendered by react-markdown and crashed React reconciliation when the
// document body changed). This plugin runs during the hast → React phase
// so the `<mark class="comment-anchor" data-comment-id>` elements are
// part of the React-managed tree from the start.
//
// Type strategy: react-markdown's `rehypePlugins` prop is loosely typed
// by Prose.tsx (`as unknown as ComponentProps<...>['rehypePlugins']`),
// and `unist-util-visit` / `@types/hast` are transitive deps of
// react-markdown that bun doesn't hoist into our package's node_modules.
// To avoid bumping packages/frontend/package.json (multi-person tree),
// we declare the minimal hast node shapes inline and walk the tree by
// hand — the plugin is small enough that the trade is favourable.
//
// Behaviour parity with `lib/review/wrapAnchorsInDom.ts` (kept around
// for `anchor.ts` selection→anchor computation):
//   - Match by concatenated text-node content (same as the DOM utility).
//   - 1-based occurrence index; clamp to last occurrence if out of range
//     (matches DOM utility semantics; orphaned anchors are tolerated).
//   - Selections that span multiple text nodes produce multiple sibling
//     `<mark>` elements sharing the same `data-comment-id`.
//
// RFC-241 阶段 2:新增 opts(markClass / strictOccurrence / excludeClasses /
// tableGuard)供「上一版意见锚进 merged diff 文档」路径复用同一插件——
// 后挂载 DOM 突变(legacy wrapAnchorsInDom)在 body / granularity 变化时
// 会撞 React reconciliation,与本插件当年替换它的原因相同,因此 prior
// 锚定同样必须在 hast 阶段完成。全部 opts 缺省时行为与旧版逐字节一致
// (当前版 Prose 调用零改动)。

export interface AnchorWrapInput {
  /** Comment id, written to `data-comment-id` on each `<mark>`. */
  commentId: string
  /** Plain text selection captured at comment-creation time. */
  selectedText: string
  /** 1-based occurrence index. */
  occurrenceIndex: number
}

export interface RehypeWrapAnchorsOptions {
  anchors: ReadonlyArray<AnchorWrapInput>
  /** Mark class written to each `<mark>`; default `'comment-anchor'`. */
  markClass?: string
  /**
   * RFC-241 阶段 2:true 时出现次数不足直接放弃该锚(不 clamp 到最后
   * 一次)。当前版路径的 clamp 是「文档=锚定源」的容错;上一版意见锚进
   * merged diff 文档时文档≠锚定源,clamp 会把该回退的静默钉错。
   */
  strictOccurrence?: boolean
  /**
   * 整棵子树不进入文本流的 className token 列表(如 `diff-ins` —— 排除
   * 新增内容后 del/context 流保序近似上一版原文;`katex`/`katex-error`
   * —— word 档行内公式被 resolveMarkedString 解析成仅新版,整树出流)。
   */
  excludeClasses?: ReadonlyArray<string>
  /**
   * RFC-241 阶段 2 表格校验(仅 word 档传 true):锚若命中「含 diff-ins,
   * 或含 diff-del 且存在不属任何 diff 标记的 context 文本」的 <table>
   * (配对表行相似度贪心 + 未配对 DEL 前置会重排旧行序;纯删减词级配对
   * 表无 ins 但重排照发),放弃该锚整体 → 未定位回退。纯 DEL 原子化整表
   * (全部文本在 del 内)保序保字面,锚定保留。
   */
  tableGuard?: boolean
}

interface HastText {
  type: 'text'
  value: string
}

interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastChild[]
}

interface HastRoot {
  type: 'root'
  children: HastChild[]
}

type HastChild = HastText | HastElement | HastOther
interface HastOther {
  type: string
  children?: HastChild[]
}

interface TextSegment {
  parent: HastRoot | HastElement
  indexInParent: number
  offsetStart: number
  node: HastText
  /** 最近的 <table> 祖先(表格校验用);无则 null。 */
  tableEl: HastElement | null
}

interface WrapRange {
  from: number
  to: number
  commentId: string
}

function classTokens(el: HastElement): string[] {
  const cls = el.properties?.['className']
  if (Array.isArray(cls)) return cls.map((c) => String(c))
  if (typeof cls === 'string') return cls.split(/\s+/)
  return []
}

function collectTextSegments(tree: HastRoot, excludeClasses: ReadonlyArray<string>): TextSegment[] {
  const out: TextSegment[] = []
  let cursor = 0
  const walk = (parent: HastRoot | HastElement, tableEl: HastElement | null): void => {
    const children = parent.children
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!
      if (node.type === 'text') {
        const t = node as HastText
        out.push({ parent, indexInParent: i, offsetStart: cursor, node: t, tableEl })
        cursor += t.value.length
      } else if (node.type === 'element') {
        const el = node as HastElement
        if (excludeClasses.length > 0) {
          const tokens = classTokens(el)
          if (tokens.some((c) => excludeClasses.includes(c))) continue
        }
        walk(el, el.tagName === 'table' ? el : tableEl)
      } else if ('children' in node && Array.isArray(node.children)) {
        // E.g. fragments inside math nodes; recurse but treat as opaque
        // for indexInParent bookkeeping since we don't mutate them.
        const placeholder = { type: 'root', children: node.children } as HastRoot
        walk(placeholder, tableEl)
      }
    }
  }
  walk(tree, null)
  return out
}

/**
 * RFC-241 阶段 2 表格校验:该表的锚定是否不可靠。条件(聚焦复核修订):
 * (a) 表含 diff-ins;(b) 表含 diff-del 且存在不属任何 diff 标记的非空白
 * context 文本。纯 DEL 原子化整表(全部文本在 del 内)两条都不满足,
 * 锚定保留。
 */
function isUnreliableTable(table: HastElement): boolean {
  let hasIns = false
  let hasDel = false
  let hasContextText = false
  const walk = (parent: HastElement | HastRoot, inDiff: boolean): void => {
    for (const node of parent.children) {
      if (node.type === 'text') {
        if (!inDiff && /\S/.test((node as HastText).value)) hasContextText = true
      } else if (node.type === 'element') {
        const el = node as HastElement
        const tokens = classTokens(el)
        const isIns = tokens.includes('diff-ins')
        const isDel = tokens.includes('diff-del')
        if (isIns) hasIns = true
        if (isDel) hasDel = true
        walk(el, inDiff || isIns || isDel)
      } else if ('children' in node && Array.isArray(node.children)) {
        walk({ type: 'root', children: node.children } as HastRoot, inDiff)
      }
    }
  }
  walk(table, false)
  return hasIns || (hasDel && hasContextText)
}

export function rehypeWrapAnchors(opts: RehypeWrapAnchorsOptions) {
  const { anchors } = opts
  const markClass = opts.markClass ?? 'comment-anchor'
  const strict = opts.strictOccurrence === true
  const excludeClasses = opts.excludeClasses ?? []
  const tableGuard = opts.tableGuard === true
  return (tree: HastRoot): void => {
    if (anchors.length === 0) return
    const segments = collectTextSegments(tree, excludeClasses)
    if (segments.length === 0) return
    const full = segments.map((s) => s.node.value).join('')
    const wrapsPerSegment = new Map<number, WrapRange[]>()
    const unreliableTables = new Map<HastElement, boolean>()
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
      const wanted = Math.max(a.occurrenceIndex - 1, 0)
      // strict:次数不足即放弃该锚(未定位回退),绝不 clamp 错钉。
      if (strict && wanted >= occs.length) continue
      const clamped = Math.min(wanted, occs.length - 1)
      const startOff = occs[clamped]!
      const endOff = startOff + a.selectedText.length
      const hits: Array<{ si: number; from: number; to: number }> = []
      let unreliable = false
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]!
        const segEnd = seg.offsetStart + seg.node.value.length
        if (segEnd <= startOff) continue
        if (seg.offsetStart >= endOff) break
        const from = Math.max(0, startOff - seg.offsetStart)
        const to = Math.min(seg.node.value.length, endOff - seg.offsetStart)
        if (from >= to) continue
        if (tableGuard && seg.tableEl !== null) {
          let bad = unreliableTables.get(seg.tableEl)
          if (bad === undefined) {
            bad = isUnreliableTable(seg.tableEl)
            unreliableTables.set(seg.tableEl, bad)
          }
          if (bad) {
            unreliable = true
            break
          }
        }
        hits.push({ si, from, to })
      }
      // 表格校验命中:该意见全部段一并放弃(整体归未定位),不留半截 mark。
      if (unreliable) continue
      for (const h of hits) {
        const list = wrapsPerSegment.get(h.si) ?? []
        list.push({ from: h.from, to: h.to, commentId: a.commentId })
        wrapsPerSegment.set(h.si, list)
      }
    }
    if (wrapsPerSegment.size === 0) return

    // Group by parent so we can splice in reverse `indexInParent` order
    // within each parent — replacing an earlier text node with N children
    // would otherwise shift later siblings' indices.
    const byParent = new Map<
      HastRoot | HastElement,
      Array<{ segIdx: number; indexInParent: number }>
    >()
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
        const ranges = (wrapsPerSegment.get(item.segIdx) ?? [])
          .slice()
          .sort((a, b) => a.from - b.from)
        const value = seg.node.value
        const replacement: HastChild[] = []
        let cur = 0
        for (const r of ranges) {
          const from = Math.max(r.from, cur)
          const to = Math.max(r.to, cur)
          if (from > cur) {
            replacement.push({ type: 'text', value: value.slice(cur, from) })
          }
          if (to > from) {
            const mark: HastElement = {
              type: 'element',
              tagName: 'mark',
              // `data-comment-id` is the literal attribute name; the
              // `property-information` defaults preserve `data-*` keys
              // verbatim so the rendered HTML matches the existing CSS
              // selector `mark.comment-anchor[data-comment-id="..."]`.
              properties: { className: [markClass], 'data-comment-id': r.commentId },
              children: [{ type: 'text', value: value.slice(from, to) }],
            }
            replacement.push(mark)
          }
          cur = to
        }
        if (cur < value.length) {
          replacement.push({ type: 'text', value: value.slice(cur) })
        }
        parent.children.splice(item.indexInParent, 1, ...replacement)
      }
    }
  }
}
