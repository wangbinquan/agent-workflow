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
}

interface WrapRange {
  from: number
  to: number
  commentId: string
}

function collectTextSegments(tree: HastRoot): TextSegment[] {
  const out: TextSegment[] = []
  let cursor = 0
  const walk = (parent: HastRoot | HastElement): void => {
    const children = parent.children
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!
      if (node.type === 'text') {
        const t = node as HastText
        out.push({ parent, indexInParent: i, offsetStart: cursor, node: t })
        cursor += t.value.length
      } else if (node.type === 'element') {
        walk(node as HastElement)
      } else if ('children' in node && Array.isArray(node.children)) {
        // E.g. fragments inside math nodes; recurse but treat as opaque
        // for indexInParent bookkeeping since we don't mutate them.
        const placeholder = { type: 'root', children: node.children } as HastRoot
        walk(placeholder)
      }
    }
  }
  walk(tree)
  return out
}

export function rehypeWrapAnchors(opts: RehypeWrapAnchorsOptions) {
  const { anchors } = opts
  return (tree: HastRoot): void => {
    if (anchors.length === 0) return
    const segments = collectTextSegments(tree)
    if (segments.length === 0) return
    const full = segments.map((s) => s.node.value).join('')
    const wrapsPerSegment = new Map<number, WrapRange[]>()
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
              properties: { className: ['comment-anchor'], 'data-comment-id': r.commentId },
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
