// RFC-010 — Markdown 渲染态 diff 的核心：把两份 markdown 算差异，再把
// 添加 / 删除段用 PUA marker 包起来后拼回单串 markdown。这串 markdown 喂给
// react-markdown，配合 remarkDiffMarkers 插件就能在渲染态 prose 上看到内联
// 高亮。
//
// 三种 granularity 共用同一 wrapLines 管线，差异在 change 计算方式：
//   word  → Intl.Segmenter 词级 tokenize + jsdiff diffArrays
//   line  → diffLines（fenced code block 先折叠成占位符行）
//   block → fence-aware 空行切块后 diffArrays
//
// 2026-07-16 乱码 / 不精准修复（评审页 word/line/block 三档实测回归）：
//   1. diff@9 的 word tokenizer 把每个 CJK 字符当独立 token，旧实现靠注入
//      ZWSP（U+200B）分词——但 ZWSP 不匹配 \s，在 diff@9 里自身也是独立
//      token，分词完全失效，中文一直在做逐字 LCS，产生"评/审/查"式红绿
//      交错。现改为显式 Intl.Segmenter tokenize + diffArrays，ZWSP 机制
//      整体删除（顺带不再误剥用户文档里的原生 ZWSP）。
//   2. PUA marker 一旦落进 fenced / inline code，remarkDiffMarkers 不处理
//      code 节点的 value，浏览器直接显示 tofu 方块（乱码主根因）。word
//      模式把 fenced block 与 inline code span 原子化成占位符；line 模式
//      把 fenced block 折叠成单行占位符再 diffLines；block 模式切块改为
//      fence-aware（fence 内空行不再撕裂代码块）。
//   3. 表格占位符从"按位置配对"改为"按内容配对"——右侧中间插入一张新表
//      时，后续内容未变的表不再被错误标成整表 DEL+INS 各显示一遍。
//   4. 行首结构前缀被 marker 打断（`##`→`###`、列表符变化）会让整行降级
//      为段落、裸 `#` 可见。新增 repairBrokenLinePrefixes 后处理：检测到
//      前缀区夹 marker 的行拆成 DEL 行 + INS 行各自完整包裹。
//   5. 入口 sanitize 剥掉文档自带的 U+E000–U+E00F（marker 隔离带）；占位
//      符分配避让文档中已出现的 U+E010–U+EFFF 字符；输出前清理空 marker
//      对（渲染成零宽色块的来源）。

import { diffArrays, diffLines, type Change } from 'diff'

export type DiffGranularity = 'word' | 'line' | 'block'

/** PUA marker codepoints — 见 design.md §PUA marker 选择。
 *  一律写 \u 转义：裸 PUA 字面量曾在编辑链路上被剥（见 remarkDiffMarkers
 *  顶部注释），转义形式是唯一稳妥写法。 */
export const MARKERS = {
  INS_OPEN: '\uE000',
  INS_CLOSE: '\uE001',
  DEL_OPEN: '\uE002',
  DEL_CLOSE: '\uE003',
} as const

const ANY_MARKER_RE = /[\uE000-\uE003]/g
/** 输入文档自带的 marker 隔离带字符（U+E000–U+E00F）直接剥掉，防止伪 marker
 *  干扰 remarkDiffMarkers 状态机（Nerd Font 图标区在 U+E0A0+，不受影响）。 */
const SANITIZE_RE = /[\uE000-\uE00F]/g

/**
 * 行首结构性 markdown 前缀（heading / list / blockquote / table cell 起手 |）。
 * marker 不能落在这些字符之前，否则 markdown 解析失败。我们把 marker 推到
 * 前缀之后。
 */
const LEADING_BLOCK_PREFIX_RE = /^(\s*(?:>+\s*)*(?:[-*+]\s+|#{1,6}\s+|\d+\.\s+|\|\s*)?)([\s\S]*)$/

/** 判断一行是否完全空白（含纯 marker，剥掉后为空）。 */
function isBlank(line: string): boolean {
  return line.replace(ANY_MARKER_RE, '').trim().length === 0
}

const FENCE_RE = /^(\s*)(`{3,}|~{3,})/

/**
 * 把一段 value 用 open/close marker 逐行包裹。规则：
 *   - 空行不包（保持段落分隔）
 *   - 行首 markdown 结构前缀（`# ` / `- ` / `> ` / `| ` / `1. `）保留在
 *     marker 之外
 *   - fenced code block 的 fence 行（` ``` ` / `~~~`）以及 fence 内部行
 *     不包 marker：marker 落在 fence 头部会让 markdown 解析器丢掉整个
 *     fence；落在 fence 内部又只是 code 文本内的 PUA 字符（remark 不会
 *     把它转成 hast `<span>`）—— 两种情况都没意义。旧 / 新代码块以正常
 *     prose 在前后渲染，reviewer 可以直接对比。
 */
function wrapLines(value: string, open: string, close: string): string {
  if (value.length === 0) return ''
  const lines = value.split('\n')
  const wrapped: string[] = []
  let fenceMarker = ''
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMarker !== '') {
      wrapped.push(line)
      if (fenceMatch !== null && (fenceMatch[2] ?? '').startsWith(fenceMarker)) {
        fenceMarker = ''
      }
      continue
    }
    if (fenceMatch !== null) {
      wrapped.push(line)
      fenceMarker = fenceMatch[2] ?? ''
      continue
    }
    if (isBlank(line)) {
      wrapped.push(line)
      continue
    }
    // RFC-012：markdown 表格分隔符行（`|---|---|`）不能携带任何 PUA marker，
    // 否则 GFM 表分隔符正则匹配失败、整张表降级为段落。整张表已在 word 路径
    // 上由占位符保证为单一 ins/del/unchanged change，分隔行不带 marker
    // 不会丢失 diff 语义（颜色仍由 header/body 行的 marker 提供）。
    // 额外要求行内含 `|`：裸 `-`（如列表符被删）也匹配 TABLE_SEP_RE，
    // 漏包 marker 会让它变成无归属的 context 字符，行首修复拆不出正确视图。
    if (line.includes('|') && TABLE_SEP_RE.test(line)) {
      wrapped.push(line)
      continue
    }
    // thematic break（--- / *** / ___）不包 marker：包了会让行首变成 PUA、
    // hr 降级成可见的裸 "---" 文本（乱码感）。hr 本身无文字可高亮，跳过。
    if (THEMATIC_BREAK_RE.test(line)) {
      wrapped.push(line)
      continue
    }
    if (TABLE_ROW_RE.test(line)) {
      // RFC-012：表格 header / body 行（不是 separator）按 cell 逐个包 marker。
      // 一行内的 open/close 不能跨 `|`——markdown 解析时 `|` 是单元格边界，
      // 跨界的 open 与 close 落在不同 `<td>` 里、remarkDiffMarkers 看到的
      // 各自是孤儿 marker，统统被吞，diff 高亮消失。逐 cell 包就避免了。
      wrapped.push(wrapTableRowCells(line, open, close))
      continue
    }
    const m = LEADING_BLOCK_PREFIX_RE.exec(line)
    const prefix = m?.[1] ?? ''
    const body = m?.[2] ?? line
    wrapped.push(prefix + open + body + close)
  }
  return wrapped.join('\n')
}

// 把"行首 `|`"的表格行按未转义 `|` 切成 cells，对每个非空 cell 用
// open/close 包裹其修剪后的 body（保留周边空白在 marker 外侧）。前后
// 哑 cell（leading / trailing `|` 之前 / 之后）不包。
function wrapTableRowCells(line: string, open: string, close: string): string {
  const parts = line.split(/(?<!\\)\|/g)
  const wrapped = parts.map((cell, i) => {
    if (i === 0 || i === parts.length - 1) {
      if (cell.trim() === '') return cell
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(cell)
    if (m === null) return cell
    const lead = m[1] ?? ''
    const inner = m[2] ?? ''
    const tail = m[3] ?? ''
    if (inner.length === 0) return cell
    return lead + open + inner + close + tail
  })
  return wrapped.join('|')
}

// ---------------------------------------------------------------------------
// 占位符原子化框架（RFC-012 表格保护泛化：fenced code / inline code / 表格）
// ---------------------------------------------------------------------------

const TABLE_ROW_RE = /^ {0,3}\|/
const TABLE_SEP_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/
const THEMATIC_BREAK_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/
// 占位符用 U+E010–U+EFFF 区间（与 MARKERS 的 U+E000–U+E003 留 12 字隔离带），
// 每个原子块分配 1 个 codepoint；同类同内容的块共用同一占位符（内容寻址），
// 这样"未变化的块"在 jsdiff 看来是同一 token，天然对齐成 unchanged。
const PLACEHOLDER_BASE = 0xe010
const PLACEHOLDER_END = 0xefff
const PLACEHOLDER_RE = /[\uE010-\uEFFF]/g

interface AtomEntry {
  content: string
  /** restore 时是否在前后补 `\n\n` 让块独立成段（fenced / table 需要；
   *  inline code 与 line 模式的 fence 折叠必须原位还原，不补）。 */
  pad: boolean
}

/**
 * 内容寻址的占位符分配器。分配时跳过 left / right 文档中已出现的
 * U+E010–U+EFFF 字符，避免用户文档自带的 PUA（如 Nerd Font 图标）被
 * restore 误还原成别的块。
 */
class PlaceholderAllocator {
  private next = PLACEHOLDER_BASE
  private readonly used: Set<number>
  private readonly byKey = new Map<string, string>()
  readonly lookup = new Map<string, AtomEntry>()

  constructor(docs: readonly string[]) {
    this.used = new Set()
    for (const doc of docs) {
      const hits = doc.match(PLACEHOLDER_RE)
      if (hits !== null) {
        for (const ch of hits) this.used.add(ch.codePointAt(0) ?? 0)
      }
    }
  }

  /** 分配失败（区间耗尽，~4000 块以上）返回 null，调用方保留原文不保护。 */
  alloc(kind: string, content: string, pad: boolean): string | null {
    const key = kind + '\u0000' + content
    const hit = this.byKey.get(key)
    if (hit !== undefined) return hit
    while (this.next <= PLACEHOLDER_END && this.used.has(this.next)) this.next++
    if (this.next > PLACEHOLDER_END) return null
    const ph = String.fromCodePoint(this.next)
    this.next++
    this.byKey.set(key, ph)
    this.lookup.set(ph, { content, pad })
    return ph
  }
}

interface LineBlock {
  start: number
  end: number
  content: string
}

/**
 * 找出 text 中所有 fenced code block（``` / ~~~，含未闭合到 EOF 的块），
 * 返回每块的起止行号与内容。关 fence 要求与开 fence 同字符且不短于开长
 * （与 wrapLines 的 fence 状态机同一判定）。
 */
function findFencedBlocks(text: string): LineBlock[] {
  const lines = text.split('\n')
  const blocks: LineBlock[] = []
  let i = 0
  while (i < lines.length) {
    const openMatch = FENCE_RE.exec(lines[i] ?? '')
    if (openMatch === null) {
      i++
      continue
    }
    const fenceMarker = openMatch[2] ?? ''
    let j = i + 1
    let closed = false
    while (j < lines.length) {
      const m = FENCE_RE.exec(lines[j] ?? '')
      if (m !== null && (m[2] ?? '').startsWith(fenceMarker)) {
        closed = true
        break
      }
      j++
    }
    // 未闭合 fence 吞到 EOF 时，排除原文尾部 \n 在 split 后留下的空串哨兵，
    // 否则哨兵进 atom、fold 后 ensureTrailingNewline 又补一个 \n，restore
    // 会让 identical 输入平白多出一个空 code 行。
    let end: number
    if (closed) {
      end = j
    } else {
      end = lines.length - 1
      if (end > i && lines[end] === '') end--
    }
    blocks.push({ start: i, end, content: lines.slice(i, end + 1).join('\n') })
    i = end + 1
  }
  return blocks
}

/**
 * 找出 text 中所有 markdown 表格块，返回每块的起止行号与内容。
 * 表格起点：行匹配 TABLE_ROW_RE 且下一行匹配 TABLE_SEP_RE；
 * 延续直到出现非 TABLE_ROW_RE 行或 EOF。
 */
function findTableBlocks(text: string): LineBlock[] {
  const lines = text.split('\n')
  const blocks: LineBlock[] = []
  let i = 0
  while (i < lines.length) {
    if (
      TABLE_ROW_RE.test(lines[i] ?? '') &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1] ?? '')
    ) {
      let j = i + 1
      while (j + 1 < lines.length && TABLE_ROW_RE.test(lines[j + 1] ?? '')) j++
      blocks.push({ start: i, end: j, content: lines.slice(i, j + 1).join('\n') })
      i = j + 1
    } else {
      i++
    }
  }
  return blocks
}

/**
 * 把 text 内每段 blocks[i] 替换成 replacements[i]（通常是单行占位符；
 * 分配失败时传回原块内容，等价于不保护）。其它行保持不变。
 * 调用者保证 blocks 与 replacements 长度一致、blocks 按起始行升序。
 */
function replaceLineBlocks(text: string, blocks: LineBlock[], replacements: string[]): string {
  if (blocks.length === 0) return text
  const lines = text.split('\n')
  const out: string[] = []
  let cursor = 0
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k]!
    for (let i = cursor; i < b.start; i++) out.push(lines[i] ?? '')
    out.push(replacements[k] ?? '')
    cursor = b.end + 1
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i] ?? '')
  return out.join('\n')
}

// 同行内的 inline code span（`code` / ``a `b`` 多反引号形式，不跨行）。
// 开端排除 `\` 转义的反引号（`\`word\`` 是字面反引号文本，不是 code span，
// 误原子化会让 marker 把转义符一起包进去、渲染出裸的 `\`）。
const INLINE_CODE_RE = /(?<!\\)(`+)(?!`)([^`\n]+?)\1(?!`)/g

/**
 * word 路径专属：把 left / right 中的 fenced code block、markdown 表格、
 * inline code span 依次替换成单 codepoint 占位符。占位符是 jsdiff 眼中的
 * 原子 token——整块要么 unchanged、要么 ins、要么 del，不会内部碎裂，
 * marker 也就永远不会落进 code / 表分隔符里（乱码根因）。
 *
 * 顺序敏感：先 fence（fence 内的 `|` 行不能当表）、再表格、最后 inline
 * code（表格 cell 内的反引号已随表抽走）。
 */
function pretreatWordAtoms(
  left: string,
  right: string,
): { l: string; r: string; lookup: Map<string, AtomEntry> } {
  const alloc = new PlaceholderAllocator([left, right])
  const protect = (text: string): string => {
    const fences = findFencedBlocks(text)
    let out = replaceLineBlocks(
      text,
      fences,
      fences.map((b) => alloc.alloc('fence', b.content, true) ?? b.content),
    )
    const tables = findTableBlocks(out)
    out = replaceLineBlocks(
      out,
      tables,
      tables.map((b) => alloc.alloc('table', b.content, true) ?? b.content),
    )
    return out.replace(INLINE_CODE_RE, (m) => alloc.alloc('inline', m, false) ?? m)
  }
  return { l: protect(left), r: protect(right), lookup: alloc.lookup }
}

/**
 * 把 changes 里每个 value 中的占位符还原成 lookup 中的原文。
 *
 * pad=true 的块（fenced / table）回填时强制前后补 `\n\n`：当 jsdiff emit
 * 相邻的 removed + added 两条 change 时，word 模式 separator="" 会把它们
 * 拼到同一物理行，下一块会紧接上一块的最后一行，markdown 解析器把两张表 /
 * 两个 fence 糊成一个，分隔符就此错位。补 `\n\n` 保证每块独立成段；
 * wrapLines 看到的空白行会原样保留，不会插入 marker。
 */
function restoreAtoms(changes: Change[], lookup: Map<string, AtomEntry>): Change[] {
  if (lookup.size === 0) return changes
  return changes.map((c) => {
    // pad 只对 added/removed change 生效：它们会与相邻 change 直接拼接，
    // 需要 \n\n 保证块独立成段。unchanged change 的占位符周围文本就是
    // 原文（pretreat 只替换了块行本身），原样还原才能保住
    // "identical 输入 → 输出逐字节一致" 的不变量。
    const shouldPad = c.added === true || c.removed === true
    return {
      ...c,
      value: c.value.replace(PLACEHOLDER_RE, (ch) => {
        const entry = lookup.get(ch)
        if (entry === undefined) return ch
        return entry.pad && shouldPad ? '\n\n' + entry.content + '\n\n' : entry.content
      }),
    }
  })
}

// ---------------------------------------------------------------------------
// word 模式：Intl.Segmenter 词级 tokenize + diffArrays
// ---------------------------------------------------------------------------

let cachedSegmenter: Intl.Segmenter | null | undefined
function getWordSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter
  const IntlNs = (globalThis as { Intl?: { Segmenter?: typeof Intl.Segmenter } }).Intl
  cachedSegmenter =
    IntlNs?.Segmenter === undefined ? null : new IntlNs.Segmenter('zh', { granularity: 'word' })
  return cachedSegmenter
}

// Segmenter 不可用时的退路：空白 run / 词字符 run / 单个其它字符（含 CJK
// 逐字与占位符），与 diff@9 自带 tokenizer 同粒度。`u` flag 保证按 code
// point 迭代，emoji 等 astral 字符不会被劈成半个 surrogate（乱码防护）。
// CJK 单字分支必须排在 letter-run 之前：\p{L} 包含汉字，若让整段中文进
// letter-run，一个 token 吞掉整句，比逐字对齐还粗（改一个字整句红绿）。
const FALLBACK_TOKEN_RE =
  /\s+|[\p{sc=Han}\p{sc=Hangul}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Bopomofo}]|[\p{L}\p{N}_]+|[\s\S]/gu

/**
 * UTF-8 / CJK-safe 词级 tokenizer。Intl.Segmenter 的词典分词让中文以
 * "词"为 diff 原子（旧 ZWSP 注入方案在 diff@9 下完全失效，见文件头 §1）。
 * segments 拼接恒等于原文（Segmenter 是 partition），diff 后 join 无损。
 */
export function tokenizeForWordDiff(s: string): string[] {
  if (s.length === 0) return []
  const seg = getWordSegmenter()
  if (seg === null) return s.match(FALLBACK_TOKEN_RE) ?? []
  const out: string[] = []
  for (const it of seg.segment(s)) out.push(it.segment)
  return out
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  // 不把 surrogate pair 劈成两半：分歧点若落在 pair 中间，回退到 pair 起点。
  if (i > 0 && i < n && isHighSurrogate(a.charCodeAt(i - 1))) i--
  return i
}

function commonSuffixLen(a: string, b: string, reservedPrefix: number): number {
  const max = Math.min(a.length, b.length) - reservedPrefix
  let i = 0
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  // 后缀边界若落在 pair 中间（正好切在 low surrogate 前），同样回退一格。
  if (i > 0 && i < max && isHighSurrogate(a.charCodeAt(a.length - 1 - i))) i--
  return i
}

/**
 * 对相邻的 removed + added change 对做字符级公共前后缀提取，把公共部分
 * 移回 context。两个作用：
 *   - Intl.Segmenter 的分词是上下文相关的，同一子串在左右两侧可能切出
 *     不同 token 序列（如"世界" vs "新世界"），导致公共文字被裹进
 *     del/ins；trim 之后高亮只覆盖真实差异。
 *   - 顺带把"改词尾一个字"这类 case 的高亮收敛到最小区间。
 */
function trimCommonAffixes(changes: Change[]): Change[] {
  const out: Change[] = []
  const pushContext = (value: string): void => {
    if (value.length === 0) return
    const last = out[out.length - 1]
    if (last !== undefined && last.added !== true && last.removed !== true) {
      last.value += value
    } else {
      out.push({ value, added: false, removed: false, count: 0 } as Change)
    }
  }
  let i = 0
  while (i < changes.length) {
    const cur = changes[i]!
    const nxt = changes[i + 1]
    if (cur.removed === true && nxt !== undefined && nxt.added === true) {
      const a = cur.value
      const b = nxt.value
      const p = commonPrefixLen(a, b)
      const s = commonSuffixLen(a, b, p)
      pushContext(a.slice(0, p))
      const aMid = a.slice(p, a.length - s)
      const bMid = b.slice(p, b.length - s)
      if (aMid.length > 0) out.push({ ...cur, value: aMid })
      if (bMid.length > 0) out.push({ ...nxt, value: bMid })
      pushContext(s > 0 ? a.slice(a.length - s) : '')
      i += 2
      continue
    }
    out.push(cur)
    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// line / block 模式
// ---------------------------------------------------------------------------

/**
 * line 模式必须保证每条 jsdiff change 的 value 都以 `\n` 结尾，否则相邻
 * removed + added 拼回 markdown 时会糊在一行——典型表现：
 *   - heading 改字 → 第二行的 `## ` 落进第一行 heading 的 text 里
 *   - 列表项改字 → 两 `<li>` 合成一个，新行 `<span class="diff-ins">`
 *     直接接在旧行 `<span class="diff-del">` 后面，看起来像"新行没标绿"
 * jsdiff diffLines 在 input 不含 trailing newline 时 emit 的最后一段
 * value 也没有 \n，所以在调用前先 normalize 两侧都补一个 \n。
 */
function ensureTrailingNewline(s: string): string {
  return s.length === 0 || s.endsWith('\n') ? s : s + '\n'
}

/**
 * line 模式的 change 计算：先把每个 fenced code block 折叠成单行占位符再
 * diffLines。否则"fence 内部改一行"会 emit 只含 code 内容行的 change，
 * wrapLines 看不到 fence 头、误把 marker 包进 code 文本（乱码根因之一）。
 * 折叠后整块作为一行参与对齐：内容相同 → 同占位符 → unchanged；不同 →
 * 整块 DEL + 整块 INS（restore 后由 wrapLines 的 fence 状态机保持干净）。
 */
function computeLineChanges(left: string, right: string): Change[] {
  const alloc = new PlaceholderAllocator([left, right])
  const fold = (text: string): string => {
    const fences = findFencedBlocks(text)
    return replaceLineBlocks(
      text,
      fences,
      fences.map((b) => alloc.alloc('fence', b.content, false) ?? b.content),
    )
  }
  const raw = diffLines(ensureTrailingNewline(fold(left)), ensureTrailingNewline(fold(right)))
  return restoreAtoms(raw, alloc.lookup)
}

/**
 * block 模式的切块：空行分隔，但 fence 内的空行不算块边界。旧实现直接
 * `split(/\n{2,}/)`，会把内部含空行的 fenced code block 撕成两半——一半的
 * fence 头没有对应的尾，diff 后 merged markdown 的 fence 结构错乱，后续
 * 整篇文档可能被吞进 code block（大面积乱码）。
 */
function splitBlocksFenceAware(s: string): string[] {
  const lines = s.split('\n')
  const blocks: string[] = []
  let cur: string[] | null = null
  let fenceMarker = ''
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMarker !== '') {
      cur = cur ?? []
      cur.push(line)
      if (fenceMatch !== null && (fenceMatch[2] ?? '').startsWith(fenceMarker)) {
        fenceMarker = ''
      }
      continue
    }
    if (line.trim().length === 0) {
      if (cur !== null) {
        blocks.push(cur.join('\n'))
        cur = null
      }
      continue
    }
    cur = cur ?? []
    cur.push(line)
    if (fenceMatch !== null) {
      fenceMarker = fenceMatch[2] ?? ''
    }
  }
  if (cur !== null) blocks.push(cur.join('\n'))
  return blocks
}

/**
 * block 模式的 diff：把空行分隔的"段"当原子单元，用 jsdiff `diffArrays`
 * 在 string[] 上跑严格相等比较，每个变更段内部用 `\n\n` 还原段间分隔。
 * 每个 block 作为一个原子 token 进入 diff，块结构（代码块 / 表格 / 列表）
 * 得以保留。
 */
function diffBlocks(left: string, right: string): Change[] {
  const raw = diffArrays<string>(splitBlocksFenceAware(left), splitBlocksFenceAware(right))
  // diffArrays 的 value 是 string[]：把同向连续块用 \n\n 拼回 markdown
  // 字符串。强转 unknown 是因为 jsdiff 的 Change 公共类型 value=string，
  // 而 diffArrays 内部用了 ChangeObject<string[]>。
  return raw.map((c) => ({
    ...c,
    value: (c.value as unknown as string[]).join('\n\n'),
  }))
}

function computeChanges(left: string, right: string, granularity: DiffGranularity): Change[] {
  if (granularity === 'word') {
    const pre = pretreatWordAtoms(left, right)
    const raw = diffArrays<string>(tokenizeForWordDiff(pre.l), tokenizeForWordDiff(pre.r))
    const joined = raw.map((c) => ({
      ...c,
      value: (c.value as unknown as string[]).join(''),
    })) as Change[]
    return restoreAtoms(trimCommonAffixes(joined), pre.lookup)
  }
  if (granularity === 'line') {
    return computeLineChanges(left, right)
  }
  return diffBlocks(left, right)
}

// ---------------------------------------------------------------------------
// 行首结构前缀修复
// ---------------------------------------------------------------------------

function isMarkerChar(ch: string): boolean {
  return (
    ch === MARKERS.INS_OPEN ||
    ch === MARKERS.INS_CLOSE ||
    ch === MARKERS.DEL_OPEN ||
    ch === MARKERS.DEL_CLOSE
  )
}

/** 在数满 prefixLen 个非 marker 字符之前遇到 marker → 前缀被打断。
 *  （marker 恰好落在前缀之后是 wrapLines 的正常产物，不算打断。） */
function isPrefixInterrupted(line: string, prefixLen: number): boolean {
  let seen = 0
  for (const ch of line) {
    if (isMarkerChar(ch)) return seen < prefixLen
    seen++
    if (seen >= prefixLen) return false
  }
  return false
}

/** 把一段含 marker 的文本按状态机还原成单侧视图：keep 侧内容 + context
 *  保留，另一侧内容与所有 marker 字符丢弃。导出供 remarkDiffMarkers 解析
 *  link url / math value 等"新旧拼接"字符串（直接剥 marker 会把
 *  https://old/a 与 https://new/b 拼成不存在的 URL）。 */
export function extractMarkedView(line: string, keep: 'ins' | 'del'): string {
  let mode: 'context' | 'ins' | 'del' = 'context'
  let out = ''
  for (const ch of line) {
    if (ch === MARKERS.INS_OPEN) {
      mode = 'ins'
    } else if (ch === MARKERS.INS_CLOSE) {
      if (mode === 'ins') mode = 'context'
    } else if (ch === MARKERS.DEL_OPEN) {
      mode = 'del'
    } else if (ch === MARKERS.DEL_CLOSE) {
      if (mode === 'del') mode = 'context'
    } else if (mode === 'context' || mode === keep) {
      out += ch
    }
  }
  return out
}

/**
 * word 模式下，若变更命中行首结构字符本身（`##`→`###`、`-`→`*`、有序列表
 * 重编号的进位等），marker 会夹进前缀区，markdown 解析随之失败：heading
 * 降级成段落、裸 `#` 可见（用户视角即"乱码"）。修法：检测"结构前缀被
 * marker 打断"的行，拆成 DEL 行 + INS 行——各自是完整合法的 markdown 行，
 * 由 wrapLines 重新做整行包裹（前缀外置）。结构级变化本就该以"旧行删除 +
 * 新行添加"呈现。
 */
function repairBrokenLinePrefixes(merged: string): string {
  ANY_MARKER_RE.lastIndex = 0
  if (!ANY_MARKER_RE.test(merged)) return merged
  const lines = merged.split('\n')
  const out: string[] = []
  let fenceMarker = ''
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMarker !== '') {
      out.push(line)
      if (fenceMatch !== null && (fenceMatch[2] ?? '').startsWith(fenceMarker)) {
        fenceMarker = ''
      }
      continue
    }
    if (fenceMatch !== null) {
      out.push(line)
      fenceMarker = fenceMatch[2] ?? ''
      continue
    }
    ANY_MARKER_RE.lastIndex = 0
    if (!ANY_MARKER_RE.test(line)) {
      out.push(line)
      continue
    }
    // 打断判定基于"单侧视图"的前缀：`-`→`*` 这类替换在 merged 里混成
    // "-*" 不构成合法前缀（直接看 stripped 会漏检），但 del 视图
    // "- item" / ins 视图 "* item" 的前缀是真实存在的结构。
    const delView = extractMarkedView(line, 'del')
    const insView = extractMarkedView(line, 'ins')
    const delPrefix = LEADING_BLOCK_PREFIX_RE.exec(delView)?.[1] ?? ''
    const insPrefix = LEADING_BLOCK_PREFIX_RE.exec(insView)?.[1] ?? ''
    const structural = delPrefix.trim().length > 0 || insPrefix.trim().length > 0
    const guard = Math.max(delPrefix.length, insPrefix.length)
    if (!structural || !isPrefixInterrupted(line, guard)) {
      out.push(line)
      continue
    }
    const pushed: string[] = []
    if (delView.trim().length > 0) {
      pushed.push(wrapLines(delView, MARKERS.DEL_OPEN, MARKERS.DEL_CLOSE))
    }
    if (insView.trim().length > 0) {
      pushed.push(wrapLines(insView, MARKERS.INS_OPEN, MARKERS.INS_CLOSE))
    }
    if (pushed.length === 0) {
      out.push(line.replace(ANY_MARKER_RE, ''))
    } else {
      // 拆出的 DEL 行与 INS 行之间必须隔空行：CommonMark 把相邻的
      // `10. item` / `1. item` 解析成同一个 <ol>，第二行的显式序号被
      // 忽略（显示 10、11 而不是 10、1）。空行让两侧各自成块。
      out.push(pushed[0]!)
      for (let k = 1; k < pushed.length; k++) {
        out.push('')
        out.push(pushed[k]!)
      }
    }
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 主入口：给定 left / right 两份 markdown 与 granularity，返回一份 merged
 * markdown：添加段被 INS marker 包裹、删除段被 DEL marker 包裹，其它部分
 * 原样。三种 granularity 共用 wrapLines 逻辑（每非空行独立包对，行首
 * markdown 结构前缀保留在 marker 之外）。
 */
export function buildMergedMarkdown(
  left: string,
  right: string,
  granularity: DiffGranularity = 'word',
): string {
  const changes = computeChanges(
    left.replace(SANITIZE_RE, ''),
    right.replace(SANITIZE_RE, ''),
    granularity,
  )
  // block 模式每个 change 是 0+ 块（已用 \n\n 拼接），相邻 change 之间也
  // 必须有 \n\n 才能维持段落边界；word/line 模式下相邻 change 直接拼接。
  const separator = granularity === 'block' ? '\n\n' : ''
  const parts: string[] = []
  for (const c of changes) {
    if (c.added === true) {
      parts.push(wrapLines(c.value, MARKERS.INS_OPEN, MARKERS.INS_CLOSE))
    } else if (c.removed === true) {
      parts.push(wrapLines(c.value, MARKERS.DEL_OPEN, MARKERS.DEL_CLOSE))
    } else {
      parts.push(c.value)
    }
  }
  // 空 marker 对（如"只剩前缀的行"包出的 open+close 相邻）渲染成零宽
  // 色块，先清掉再做行首修复。
  const merged = parts
    .join(separator)
    .replaceAll(MARKERS.INS_OPEN + MARKERS.INS_CLOSE, '')
    .replaceAll(MARKERS.DEL_OPEN + MARKERS.DEL_CLOSE, '')
  return repairBrokenLinePrefixes(merged)
}

// 仅供测试与 DiffView 内部复用。
export const _internal = {
  wrapLines,
  isBlank,
  LEADING_BLOCK_PREFIX_RE,
  diffBlocks,
  computeChanges,
  splitBlocksFenceAware,
  // 占位符原子化：供测试锁定 pretreat / restore 行为。
  findTableBlocks,
  findFencedBlocks,
  pretreatWordAtoms,
  restoreAtoms,
  PlaceholderAllocator,
  trimCommonAffixes,
  repairBrokenLinePrefixes,
  extractMarkedView,
  isPrefixInterrupted,
  FALLBACK_TOKEN_RE,
  TABLE_ROW_RE,
  TABLE_SEP_RE,
  PLACEHOLDER_BASE,
  PLACEHOLDER_END,
}
