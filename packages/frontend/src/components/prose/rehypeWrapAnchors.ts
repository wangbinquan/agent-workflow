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
// We declare the minimal hast node shapes inline and walk the tree by
// hand — the plugin is small enough that the trade is favourable.
//
// Two modes (RFC-326 D5, design §9):
//
//   `mode: 'text'` (the RFC-051 behaviour, default): match by concatenated
//   text-node content, 1-based occurrence index, clamp to the last occurrence
//   unless `strictOccurrence`. Counting is NON-overlapping (shared
//   `findAllOccurrences`) — the number the database stores.
//
//   `mode: 'source-offset'`: the stored anchor names a source range
//   `[offsetStart, offsetEnd)` of `sourceBody`; the text nodes react-markdown
//   produces carry the source `position` they came from, so the range is
//   PROJECTED onto the rendered text through a token-aware alignment of each
//   text node's value against its source slice (backticks of inline code,
//   `\` escapes and `&…;` entities are consumed as single tokens). No text
//   heuristics, no drift when the same words appear twice. Ranges the page
//   never renders (link targets, HTML comments, reference definitions) and
//   KaTeX output stay UNLOCATED; fenced code hands its ranges to the code
//   element as `data-anchor-ranges` for CodeBlock (Shiki decorations); other
//   unpositioned visible text (alert first paragraph, footnotes) falls back to
//   a text match confined to the window between the neighbouring positioned
//   nodes. An anchor whose text is not in `sourceBody` at all (legacy rows)
//   falls back to text mode.
//
// RFC-241 阶段 2:opts(markClass / strictOccurrence / excludeClasses /
// tableGuard)供「上一版意见锚进 merged diff 文档」路径复用同一插件——
// 后挂载 DOM 突变(legacy wrapAnchorsInDom)在 body / granularity 变化时
// 会撞 React reconciliation,与本插件当年替换它的原因相同,因此 prior
// 锚定同样必须在 hast 阶段完成。全部 opts 缺省时行为与旧版逐字节一致
// (当前版 Prose 调用零改动)。

import { findAllOccurrences } from '@agent-workflow/shared'
import { decodeNamedCharacterReference } from 'decode-named-character-reference'

export interface AnchorWrapInput {
  /** Comment id, written to `data-comment-id` on each `<mark>`. */
  commentId: string
  /** Plain text selection captured at comment-creation time. */
  selectedText: string
  /** 1-based occurrence index. */
  occurrenceIndex: number
  /** RFC-326: source range of the selection in `sourceBody` (stored anchor offsets). */
  offsetStart?: number
  offsetEnd?: number
}

export type AnchorWrapMode = 'text' | 'source-offset'

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
  /** RFC-326: `'source-offset'` needs `sourceBody`; default `'text'`. */
  mode?: AnchorWrapMode
  /** The markdown the anchors were resolved against (the document being rendered). */
  sourceBody?: string
  /** Test-only: counts the work done, so the "build once" claims are pinned by a test. */
  __stats?: { alignments: number; occurrenceScans: number }
}

interface HastPosition {
  start?: { offset?: number }
  end?: { offset?: number }
}

interface HastText {
  type: 'text'
  value: string
  position?: HastPosition
}

interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastChild[]
  position?: HastPosition
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
  /** Source span of the node (RFC-326), when react-markdown kept it. */
  srcStart: number | null
  srcEnd: number | null
  /** Inside a `.katex` subtree (never highlighted). */
  inKatex: boolean
  /** The `<code>` element of a fenced block this text belongs to, if any. */
  fencedCode: HastElement | null
}

interface WrapRange {
  from: number
  to: number
  commentId: string
}

/** A range handed to CodeBlock for a fenced code element (relative to the code text). */
export interface CodeAnchorRange {
  start: number
  end: number
  commentId: string
}

function classTokens(el: HastElement): string[] {
  const cls = el.properties?.['className']
  if (Array.isArray(cls)) return cls.map((c) => String(c))
  if (typeof cls === 'string') return cls.split(/\s+/)
  return []
}

function positionOf(node: { position?: HastPosition }): { start: number; end: number } | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  if (typeof start !== 'number' || typeof end !== 'number' || end < start) return null
  return { start, end }
}

function collectTextSegments(tree: HastRoot, excludeClasses: ReadonlyArray<string>): TextSegment[] {
  const out: TextSegment[] = []
  let cursor = 0
  const walk = (
    parent: HastRoot | HastElement,
    tableEl: HastElement | null,
    inKatex: boolean,
    fencedCode: HastElement | null,
  ): void => {
    const children = parent.children
    for (let i = 0; i < children.length; i++) {
      const node = children[i]!
      if (node.type === 'text') {
        const t = node as HastText
        const pos = positionOf(t)
        out.push({
          parent,
          indexInParent: i,
          offsetStart: cursor,
          node: t,
          tableEl,
          srcStart: pos?.start ?? null,
          srcEnd: pos?.end ?? null,
          inKatex,
          fencedCode,
        })
        cursor += t.value.length
      } else if (node.type === 'element') {
        const el = node as HastElement
        const tokens = classTokens(el)
        if (excludeClasses.length > 0 && tokens.some((c) => excludeClasses.includes(c))) continue
        const katex = inKatex || tokens.includes('katex') || tokens.includes('katex-error')
        const fenced =
          fencedCode ??
          (el.tagName === 'code' && parent.type === 'element' && parent.tagName === 'pre'
            ? el
            : null)
        walk(el, el.tagName === 'table' ? el : tableEl, katex, fenced)
      } else if ('children' in node && Array.isArray(node.children)) {
        // E.g. fragments inside math nodes; recurse but treat as opaque
        // for indexInParent bookkeeping since we don't mutate them.
        const placeholder = { type: 'root', children: node.children } as HastRoot
        walk(placeholder, tableEl, inKatex, fencedCode)
      }
    }
  }
  walk(tree, null, false, null)
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

// -----------------------------------------------------------------------------
// RFC-326 — source-offset projection
// -----------------------------------------------------------------------------

const ENTITY_RE = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/
const ASCII_PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/

/**
 * HTML / CommonMark 的数字实体规则:NUL、超出 Unicode 平面、以及代理区码位一律
 * 解成 U+FFFD,而不是抛。`String.fromCodePoint` 对 `&#x110000;` / `&#xD800;` 会
 * 直接 RangeError——它跑在 rehype 插件里,一条设计文档里写了这么个实体就会把整个
 * 评审面板炸掉(白屏),而这正是评审文档最可能出现的那类字面量。
 */
function decodeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return '\uFFFD'
  if (value >= 0xd800 && value <= 0xdfff) return '\uFFFD'
  return String.fromCodePoint(value)
}

function decodeEntityAt(src: string, at: number): { decoded: string; length: number } | null {
  const m = ENTITY_RE.exec(src.slice(at, at + 40))
  if (m === null) return null
  let decoded: string | false
  if (m[1] !== undefined) decoded = decodeCodePoint(Number.parseInt(m[1], 16))
  else if (m[2] !== undefined) decoded = decodeCodePoint(Number.parseInt(m[2], 10))
  else decoded = decodeNamedCharacterReference(m[3]!)
  if (decoded === false || decoded.length === 0) return null
  return { decoded, length: m[0].length }
}

/**
 * Token-aware monotonic alignment of a text node's `value` against its source
 * slice: `valueToSrc[i]` is the absolute source offset of value char `i`, or
 * -1 when the char has no source counterpart. Equal chars advance together; a
 * `\`-escape or an `&…;` entity in the source is consumed as ONE token paired
 * with its decoded value char(s); any other mismatch skips the source char
 * (backticks of inline code, a stripped padding space) — value chars are never
 * skipped ahead, so a value tail without source stays unmapped rather than
 * landing on the wrong token.
 */
export function alignValueToSource(value: string, src: string, srcStart: number): Int32Array {
  const map = new Int32Array(value.length).fill(-1)
  let i = 0
  let j = 0
  while (i < value.length && j < src.length) {
    const v = value[i]!
    const s = src[j]!
    if (v === s) {
      map[i] = srcStart + j
      i += 1
      j += 1
      continue
    }
    if (s === '\\' && j + 1 < src.length && ASCII_PUNCT.test(src[j + 1]!) && src[j + 1] === v) {
      map[i] = srcStart + j
      i += 1
      j += 2
      continue
    }
    // RFC-326 P1#5:code span 里的**换行**被 CommonMark 正规化成一个空格
    // (`` `foo\nbar` `` → `foo bar`)。段落里的软换行在 value 里仍是 '\n',会走
    // 上面的等值分支,所以这条只会命中 code span(以及同样折行的场景),不会误吃
    // 普通换行。不处理它的话,换行之后的所有字符都留在未映射状态——锚点整段丢失。
    if (v === ' ' && (s === '\n' || s === '\r')) {
      map[i] = srcStart + j
      i += 1
      j += s === '\r' && src[j + 1] === '\n' ? 2 : 1
      continue
    }
    if (s === '&') {
      const entity = decodeEntityAt(src, j)
      if (entity !== null && value.startsWith(entity.decoded, i)) {
        for (let k = 0; k < entity.decoded.length; k++) map[i + k] = srcStart + j
        i += entity.decoded.length
        j += entity.length
        continue
      }
    }
    // Source char with no rendered counterpart (inline-code backticks, the
    // stripped padding space, a soft-break variant): skip it, keep the value char.
    j += 1
  }
  return map
}

interface SourceRange {
  start: number
  end: number
}

/**
 * 围栏代码块在源文里的区间(含开闭围栏行)。一次行扫描,跟踪围栏状态——CommonMark
 * 的闭合规则:同种标记、长度不短于开标记、后面只能是空白。
 */
export function fencedRegions(body: string): SourceRange[] {
  const out: SourceRange[] = []
  let open: { start: number; marker: string; len: number } | null = null
  let at = 0
  while (at <= body.length) {
    const nl = body.indexOf('\n', at)
    const lineEnd = nl < 0 ? body.length : nl
    const raw = body.slice(at, lineEnd)
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open === null) {
      // 反引号围栏的 info string 里不能再有反引号(CommonMark);否则那是行内代码。
      if (m !== null && !(m[1]![0] === '`' && m[2]!.includes('`'))) {
        open = { start: at, marker: m[1]![0]!, len: m[1]!.length }
      }
    } else if (
      m !== null &&
      m[1]![0] === open.marker &&
      m[1]!.length >= open.len &&
      m[2]!.trim() === ''
    ) {
      out.push({ start: open.start, end: lineEnd })
      open = null
    }
    if (nl < 0) break
    at = nl + 1
  }
  // 未闭合围栏一直吃到文末(CommonMark 同款)。
  if (open !== null) out.push({ start: open.start, end: body.length })
  return out
}

/**
 * Ranges of `body` the page never renders as text (mirrors the backend document model).
 *
 * RFC-326 P1#2:这三条 Markdown 语法在**围栏代码块里就是可见正文**。此前整篇平扫,
 * 于是围栏里写着 `[ref]: https://x` 或 `<!-- 注释 -->` 时,落在那儿的锚点会在进入
 * 代码块交接之前被当成「永不渲染」直接丢掉——页面上一个 mark 都没有。
 */
export function nonRenderedSpans(body: string): SourceRange[] {
  const fences = fencedRegions(body)
  const inFence = (at: number): boolean => fences.some((f) => at >= f.start && at < f.end)
  const spans: SourceRange[] = []
  for (const m of body.matchAll(/<!--[\s\S]*?-->/g)) {
    if (!inFence(m.index)) spans.push({ start: m.index, end: m.index + m[0].length })
  }
  for (const m of body.matchAll(/\]\(([^()\s]+(?:\([^()\s]*\))?)/g)) {
    const start = m.index + 2
    if (!inFence(start)) spans.push({ start, end: start + m[1]!.length })
  }
  for (const m of body.matchAll(/^ {0,3}\[[^\]]+\]:[ \t]*\S.*$/gm)) {
    if (!inFence(m.index)) spans.push({ start: m.index, end: m.index + m[0].length })
  }
  return spans.sort((a, b) => a.start - b.start)
}

function insideAnySpan(spans: ReadonlyArray<SourceRange>, start: number, end: number): boolean {
  for (const s of spans) {
    if (s.start <= start && end <= s.end) return true
    if (s.start > start) break
  }
  return false
}

/**
 * RFC-326 P17 — is the stored anchor self-consistent with `body`? Returns the
 * source range to project: the stored one when consistent, the range of the
 * `occurrenceIndex`-th occurrence when only the text matches at the stored
 * offsets (the server canonicalisation is authoritative), or null when the
 * text is not in the body at all (→ text mode). The occurrence check scans
 * only up to `offsetStart` and is memoised per (body, text) by the caller.
 */
export function resolveSourceRange(
  body: string,
  anchor: AnchorWrapInput,
  occurrencesOf: (text: string) => number[],
): SourceRange | null {
  const { offsetStart, offsetEnd, selectedText } = anchor
  if (selectedText.length === 0) return null
  // 一次扫描服务两件事(自洽校验 + 兜底定位),并且**走调用方的记忆化**:此前自洽
  // 分支自己 `body.indexOf` 逐条重扫,每条意见都是一次 O(body) ——锚多起来就是
  // O(anchors × body),而 `__stats.occurrenceScans` 也永远看不到它们(统计失真、
  // 那条统计测试等于空转)。findAllOccurrences 是不重叠、升序的,offsetStart 落在
  // 结果里 ⇔ 它本身就是一个不重叠出现位置,与旧的双条件判等价。
  const occurrences = occurrencesOf(selectedText)
  if (
    typeof offsetStart === 'number' &&
    typeof offsetEnd === 'number' &&
    offsetStart >= 0 &&
    offsetEnd > offsetStart &&
    body.slice(offsetStart, offsetEnd) === selectedText
  ) {
    const at = occurrences.indexOf(offsetStart)
    if (at >= 0 && at + 1 === anchor.occurrenceIndex) {
      return { start: offsetStart, end: offsetEnd }
    }
  }
  if (occurrences.length === 0) return null
  const wanted = Math.min(Math.max(anchor.occurrenceIndex - 1, 0), occurrences.length - 1)
  const start = occurrences[wanted]!
  return { start, end: start + selectedText.length }
}

function lowerBound(sorted: ReadonlyArray<number>, target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid]! < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

interface Projection {
  hits: Array<{ si: number; from: number; to: number }>
  codeRanges: Array<{ code: HastElement; range: CodeAnchorRange }>
}

const CLOSING_FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/

/**
 * 把围栏块里的**源文**区间换算成 CodeBlock 手上那份 `source` 的偏移。
 *
 * RFC-326 P1#4:此前是「减去第一行长度」一刀切。三处会错:
 *   · **开标记缩进**——`  ```ts` 的内容行按 CommonMark 每行剥掉至多同样多的前导空格,
 *     一刀切会让第一行起就偏移 2,并且**逐行累积**;
 *   · **CRLF**——源文一个换行占两个字符,`value` 里只有一个;
 *   · 闭合围栏行不属于内容(`~~~` 与更长的开标记同理)。
 * 逐行建映射是唯一能同时吃下这三条的形态。返回 null = 该区间落在内容之外。
 */
function fenceValueRange(body: string, pos: SourceRange, range: SourceRange): SourceRange | null {
  const firstBreak = body.indexOf('\n', pos.start)
  if (firstBreak < 0 || firstBreak >= pos.end) return null
  // 缩进要从**行首**数,不能从 pos.start 数:mdast 的 code 节点位置落在围栏标记上
  // (实测 `  ```ts` 的 position.start 指向第一个反引号),从那儿数永远是 0。
  const lineStart = body.lastIndexOf('\n', pos.start - 1) + 1
  const indent = Math.min(/^ {0,3}/.exec(body.slice(lineStart, pos.start))![0].length, 3)

  const lines: Array<{ abs: number; text: string; eol: number }> = []
  let at = firstBreak + 1
  while (at <= pos.end) {
    const nl = body.indexOf('\n', at)
    const lineEnd = nl < 0 || nl > pos.end ? pos.end : nl
    const raw = body.slice(at, lineEnd)
    const crlf = raw.endsWith('\r')
    // 实测:micromark 剥掉内容行的前导缩进,但**保留** `\r\n` 原样进 code 节点的
    // value,所以换行在 value 里占 2 个字符——按 1 个算就会逐行累积错位。
    lines.push({ abs: at, text: crlf ? raw.slice(0, -1) : raw, eol: crlf ? 2 : 1 })
    if (nl < 0 || nl >= pos.end) break
    at = nl + 1
  }
  while (lines.length > 0 && CLOSING_FENCE.test(lines[lines.length - 1]!.text)) lines.pop()

  let value = 0
  let start = -1
  let end = -1
  for (const line of lines) {
    const strip = Math.min(indent, /^ */.exec(line.text)![0].length)
    for (let k = strip; k < line.text.length; k++) {
      const src = line.abs + k
      if (src >= range.start && src < range.end) {
        const v = value + (k - strip)
        if (start < 0) start = v
        end = v + 1
      }
    }
    value += line.text.length - strip + line.eol // + the line's own newline (CRLF = 2)
  }
  return start < 0 || end <= start ? null : { start, end }
}

/** Project one source range onto the rendered text (design §9.3 steps 3-4). */
function projectSourceRange(
  range: SourceRange,
  commentId: string,
  segments: TextSegment[],
  positioned: number[],
  positionedStarts: number[],
  alignments: Map<number, Int32Array>,
  body: string,
  nonRendered: ReadonlyArray<SourceRange>,
  stats: RehypeWrapAnchorsOptions['__stats'],
): Projection | null {
  const hits: Projection['hits'] = []
  const codeRanges: Projection['codeRanges'] = []
  // Positioned segments overlapping [start, end).
  let k = lowerBound(positionedStarts, range.start)
  if (k > 0 && (segments[positioned[k - 1]!]!.srcEnd ?? 0) > range.start) k -= 1
  for (; k < positioned.length; k++) {
    const si = positioned[k]!
    const seg = segments[si]!
    if (seg.srcStart! >= range.end) break
    if (seg.srcEnd! <= range.start) continue
    if (seg.inKatex) continue
    let map = alignments.get(si)
    if (map === undefined) {
      map = alignValueToSource(
        seg.node.value,
        body.slice(seg.srcStart!, seg.srcEnd!),
        seg.srcStart!,
      )
      alignments.set(si, map)
      if (stats !== undefined) stats.alignments += 1
    }
    let from = -1
    let to = -1
    for (let i = 0; i < map.length; i++) {
      const src = map[i]!
      if (src < 0) continue
      if (src >= range.start && src < range.end) {
        if (from < 0) from = i
        to = i + 1
      } else if (from >= 0 && src >= range.end) {
        break
      }
    }
    if (from >= 0 && to > from) hits.push({ si, from, to })
  }
  if (hits.length > 0) return { hits, codeRanges }

  // No positioned text intersects: decide between the documented fallbacks.
  if (insideAnySpan(nonRendered, range.start, range.end)) return null
  // Fenced code: the <code> element's position spans the whole fence.
  for (const seg of segments) {
    const code = seg.fencedCode
    if (code === null) continue
    const pos = positionOf(code)
    if (pos === null || pos.start > range.start || pos.end < range.end) continue
    const mapped = fenceValueRange(body, pos, range)
    if (mapped !== null) {
      codeRanges.push({ code, range: { ...mapped, commentId } })
    }
    return { hits, codeRanges }
  }
  // Visible but unpositioned text (alert first paragraph, footnotes, hard
  // breaks): the caller runs the windowed text match.
  return { hits, codeRanges }
}

/**
 * Text-match fallback confined to the unpositioned text between two positioned neighbours.
 *
 * RFC-326:窗口里出现多次时必须钉**这条锚的那一次**。此前恒取 `indexOf` 的第一次,
 * 于是 `x and x` 的第二条意见和第一条高亮在同一处。`body` 已知、窗口对应的源文
 * 区间也已知,于是「这条锚在窗口内是第几次」可以直接在源文上数出来。
 */
function windowedTextHits(
  range: SourceRange,
  selectedText: string,
  segments: TextSegment[],
  positioned: number[],
  body: string,
): Array<{ si: number; from: number; to: number }> {
  // Neighbours in document order: last positioned segment ending ≤ start, first starting ≥ end.
  let leftIdx = -1
  let rightIdx = segments.length
  for (const si of positioned) {
    const seg = segments[si]!
    if (seg.srcEnd! <= range.start) leftIdx = si
    if (seg.srcStart! >= range.end) {
      rightIdx = si
      break
    }
  }
  const window: number[] = []
  for (let si = leftIdx + 1; si < rightIdx; si++) {
    const seg = segments[si]!
    if (seg.srcStart === null && !seg.inKatex && seg.fencedCode === null) window.push(si)
  }
  if (window.length === 0) return []
  const text = window.map((si) => segments[si]!.node.value).join('')
  // 窗口覆盖的源文区间:左邻居结束处 → 右邻居开始处(两端缺失时取文档端点)。
  const srcFrom = leftIdx >= 0 ? segments[leftIdx]!.srcEnd! : 0
  const srcTo = rightIdx < segments.length ? segments[rightIdx]!.srcStart! : body.length
  let localIndex = 0
  for (const occ of findAllOccurrences(body.slice(srcFrom, srcTo), selectedText)) {
    if (occ + srcFrom >= range.start) break
    localIndex += 1
  }
  const inWindow = findAllOccurrences(text, selectedText)
  if (inWindow.length === 0) return []
  const at = inWindow[Math.min(localIndex, inWindow.length - 1)]!
  const endAt = at + selectedText.length
  const hits: Array<{ si: number; from: number; to: number }> = []
  let cursor = 0
  for (const si of window) {
    const len = segments[si]!.node.value.length
    const segStart = cursor
    const segEnd = cursor + len
    cursor = segEnd
    if (segEnd <= at) continue
    if (segStart >= endAt) break
    const from = Math.max(0, at - segStart)
    const to = Math.min(len, endAt - segStart)
    if (from < to) hits.push({ si, from, to })
  }
  return hits
}

// -----------------------------------------------------------------------------
// Plugin
// -----------------------------------------------------------------------------

export function rehypeWrapAnchors(opts: RehypeWrapAnchorsOptions) {
  const { anchors } = opts
  const markClass = opts.markClass ?? 'comment-anchor'
  const strict = opts.strictOccurrence === true
  const excludeClasses = opts.excludeClasses ?? []
  const tableGuard = opts.tableGuard === true
  const sourceMode = opts.mode === 'source-offset' && typeof opts.sourceBody === 'string'
  const body = opts.sourceBody ?? ''
  return (tree: HastRoot): void => {
    if (anchors.length === 0) return
    const segments = collectTextSegments(tree, excludeClasses)
    if (segments.length === 0) return
    const full = segments.map((s) => s.node.value).join('')
    const wrapsPerSegment = new Map<number, WrapRange[]>()
    const unreliableTables = new Map<HastElement, boolean>()
    const codeRangesPerElement = new Map<HastElement, CodeAnchorRange[]>()

    // RFC-326 — indexes built ONCE per render (design §9.3 step 2).
    const positioned: number[] = []
    for (let si = 0; si < segments.length; si++) {
      if (segments[si]!.srcStart !== null) positioned.push(si)
    }
    positioned.sort((a, b) => segments[a]!.srcStart! - segments[b]!.srcStart!)
    const positionedStarts = positioned.map((si) => segments[si]!.srcStart!)
    const alignments = new Map<number, Int32Array>()
    const occurrenceCache = new Map<string, number[]>()
    const occurrencesOf = (text: string): number[] => {
      let occ = occurrenceCache.get(text)
      if (occ === undefined) {
        occ = findAllOccurrences(body, text)
        occurrenceCache.set(text, occ)
        if (opts.__stats !== undefined) opts.__stats.occurrenceScans += 1
      }
      return occ
    }
    const nonRendered = sourceMode ? nonRenderedSpans(body) : []

    const tableUnreliable = (seg: TextSegment): boolean => {
      if (!tableGuard || seg.tableEl === null) return false
      let bad = unreliableTables.get(seg.tableEl)
      if (bad === undefined) {
        bad = isUnreliableTable(seg.tableEl)
        unreliableTables.set(seg.tableEl, bad)
      }
      return bad
    }

    const textModeHits = (
      a: AnchorWrapInput,
    ): Array<{ si: number; from: number; to: number }> | null => {
      const occs = findAllOccurrences(full, a.selectedText)
      if (occs.length === 0) return null
      const wanted = Math.max(a.occurrenceIndex - 1, 0)
      // strict:次数不足即放弃该锚(未定位回退),绝不 clamp 错钉。
      if (strict && wanted >= occs.length) return null
      const clamped = Math.min(wanted, occs.length - 1)
      const startOff = occs[clamped]!
      const endOff = startOff + a.selectedText.length
      const hits: Array<{ si: number; from: number; to: number }> = []
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]!
        const segEnd = seg.offsetStart + seg.node.value.length
        if (segEnd <= startOff) continue
        if (seg.offsetStart >= endOff) break
        const from = Math.max(0, startOff - seg.offsetStart)
        const to = Math.min(seg.node.value.length, endOff - seg.offsetStart)
        if (from >= to) continue
        // 表格校验命中:该意见全部段一并放弃(整体归未定位),不留半截 mark。
        if (tableUnreliable(seg)) return null
        hits.push({ si, from, to })
      }
      return hits
    }

    for (const a of anchors) {
      if (a.selectedText.length === 0) continue
      let hits: Array<{ si: number; from: number; to: number }> | null = null
      if (sourceMode) {
        const range = resolveSourceRange(body, a, occurrencesOf)
        if (range !== null) {
          const projected = projectSourceRange(
            range,
            a.commentId,
            segments,
            positioned,
            positionedStarts,
            alignments,
            body,
            nonRendered,
            opts.__stats,
          )
          if (projected === null) continue // unlocated by design (never rendered / KaTeX)
          for (const { code, range: r } of projected.codeRanges) {
            const list = codeRangesPerElement.get(code) ?? []
            list.push(r)
            codeRangesPerElement.set(code, list)
          }
          hits = projected.hits
          if (hits.length === 0 && projected.codeRanges.length === 0) {
            hits = windowedTextHits(range, a.selectedText, segments, positioned, body)
          }
          if (hits.some((h) => tableUnreliable(segments[h.si]!))) continue
        } else {
          hits = textModeHits(a)
        }
      } else {
        hits = textModeHits(a)
      }
      if (hits === null) continue
      for (const h of hits) {
        const list = wrapsPerSegment.get(h.si) ?? []
        list.push({ from: h.from, to: h.to, commentId: a.commentId })
        wrapsPerSegment.set(h.si, list)
      }
    }

    for (const [code, ranges] of codeRangesPerElement) {
      code.properties = {
        ...(code.properties ?? {}),
        'data-anchor-ranges': JSON.stringify(ranges),
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
