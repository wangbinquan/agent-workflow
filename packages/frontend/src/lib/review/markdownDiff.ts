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
//
// 2026-07-30 表格 diff 碎裂修复（评审页实测：变更落在表格内时三档全烂）：
//   repairBrokenLinePrefixes 对 wrapTableRowCells 产出的表格行误报"前缀
//   被打断"——整行 DEL/INS 的空侧视图（`|  |  |`）的 `\|\s*` 前缀比 marker
//   前的物理前缀（`| `）长——把每个带 marker 的行拆成"行 + 空行 + `|  |  |`"，
//   整张表随之碎成带裸 `|` 的段落。现表格行（含 blockquote 内）跳过拆行
//   修复；wrapLines 的结构 skip（表分隔符 / hr）改为剥引用前缀后判定并新增
//   setext `===` 下划线 skip；task list checkbox（`- [x] `）并入行首结构
//   前缀，勾选态切换由拆行修复呈现为完整的 DEL 项 + INS 项。
//   实现门跟进（同日两轮，5 P1 + 1 P2）：结构行 skip 与前缀外置只作用于
//   与物理行边界对齐的行（word 片段的 `=`/`---` 增删否则被静默吞掉）；
//   前缀即变更本体时整行入 marker（纯引用前缀完整行除外——`>` 空续行必须
//   保持裸行）；setext 标题块在 word/line 路径整块原子化（仅加删下划线
//   不再隐身）；line 模式表头 / 列数变化由 repairMergedTableRuns 重建为
//   旧表 DEL + 新表 INS；checkbox 原子化排除缩进代码块。

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
 * 行首结构性 markdown 前缀（heading / list / blockquote / table cell 起手 |，
 * 以及 GFM task list 的 `[x] ` / `[ ] ` checkbox——它必须紧贴 li 内容起点，
 * marker 夹在中间会让 checkbox 降级成字面 `[x]` 文本）。
 * marker 不能落在这些字符之前，否则 markdown 解析失败。我们把 marker 推到
 * 前缀之后。
 */
const LEADING_BLOCK_PREFIX_RE =
  /^(\s*(?:>+\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|\d+\.\s+(?:\[[ xX]\]\s+)?|\|\s*)?)([\s\S]*)$/

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
 *
 * word 模式的 value 是 diff 片段而非完整物理行：首行可能起于行中、末行
 * 可能止于行中（Codex 实现门 P1）。firstComplete / lastComplete 标记首 /
 * 末行是否与物理行边界对齐；结构行判定（fence / 表分隔符 / hr / setext /
 * 表格行）只作用于两端都完整的行——否则 `a=b`→`a==b` 的 `=` 片段会被当
 * setext 下划线跳过不包 marker，删除侧还会以 context 形态残留旧文本。
 * 行首前缀外置只要求"起于行首"（idx>0 或 firstComplete）。
 */
function wrapLines(
  value: string,
  open: string,
  close: string,
  firstComplete = true,
  lastComplete = true,
): string {
  if (value.length === 0) return ''
  const lines = value.split('\n')
  const wrapped: string[] = []
  let fenceMarker = ''
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!
    const startsLine = idx > 0 || firstComplete
    const complete = startsLine && (idx < lines.length - 1 || lastComplete)
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMarker !== '') {
      wrapped.push(line)
      if (fenceMatch !== null && (fenceMatch[2] ?? '').startsWith(fenceMarker)) {
        fenceMarker = ''
      }
      continue
    }
    if (complete && fenceMatch !== null) {
      wrapped.push(line)
      fenceMarker = fenceMatch[2] ?? ''
      continue
    }
    if (isBlank(line)) {
      wrapped.push(line)
      continue
    }
    // 结构行判定统一剥掉 blockquote 前缀后做（`> | a |` 的表格骨架、
    // `> |---|` 的分隔符与顶层同规则）；无引用前缀时 rest === line，
    // 行为与旧实现一致。
    const quotePrefix = QUOTE_PREFIX_RE.exec(line)?.[0] ?? ''
    const rest = line.slice(quotePrefix.length)
    if (complete) {
      // RFC-012：markdown 表格分隔符行（`|---|---|`）不能携带任何 PUA marker，
      // 否则 GFM 表分隔符正则匹配失败、整张表降级为段落。整张表已在 word 路径
      // 上由占位符保证为单一 ins/del/unchanged change，分隔行不带 marker
      // 不会丢失 diff 语义（颜色仍由 header/body 行的 marker 提供）。
      // 额外要求行内含 `|`：裸 `-`（如列表符被删）也匹配 TABLE_SEP_RE，
      // 漏包 marker 会让它变成无归属的 context 字符，行首修复拆不出正确视图。
      if (rest.includes('|') && TABLE_SEP_RE.test(rest)) {
        wrapped.push(line)
        continue
      }
      // thematic break（--- / *** / ___）不包 marker：包了会让行首变成 PUA、
      // hr 降级成可见的裸 "---" 文本（乱码感）。hr 本身无文字可高亮，跳过。
      if (THEMATIC_BREAK_RE.test(rest)) {
        wrapped.push(line)
        continue
      }
      // setext 标题下划线（`===`）同理不包：PUA 落进去后不再被识别为下划线，
      // 上一行标题降级成段落、裸 `===` 直接可见。下划线无文字可高亮；标题
      // 文本行自身照常包 marker，高亮不丢。（`---` 形式的 setext H2 已被
      // thematic break 分支覆盖。）
      if (SETEXT_UNDERLINE_RE.test(rest)) {
        wrapped.push(line)
        continue
      }
      if (TABLE_ROW_RE.test(rest)) {
        // RFC-012：表格 header / body 行（不是 separator）按 cell 逐个包 marker。
        // 一行内的 open/close 不能跨 `|`——markdown 解析时 `|` 是单元格边界，
        // 跨界的 open 与 close 落在不同 `<td>` 里、remarkDiffMarkers 看到的
        // 各自是孤儿 marker，统统被吞，diff 高亮消失。逐 cell 包就避免了。
        wrapped.push(quotePrefix + wrapTableRowCells(rest, open, close))
        continue
      }
    }
    const m = startsLine ? LEADING_BLOCK_PREFIX_RE.exec(line) : null
    const prefix = m?.[1] ?? ''
    const body = m?.[2] ?? line
    // 前缀即变更本体（body 为空，如段落 → task 化时 ins 片段恰为
    // `- [x] `）：外置前缀会让空 marker 对被清理、整行无任何高亮（Codex
    // 实现门 P1）。改为整行入 marker，交给 repairBrokenLinePrefixes 拆成
    // 完整的 DEL 行 + INS 行呈现。
    // 例外（Codex 二轮 P1）：完整出现的纯 blockquote 前缀行（`>` 空续行）
    // 保持裸行——包 marker 会渲染出字面高亮 `>` 并把 `> a\n>\n> b` 撕成
    // 一个段落；不完整的 `> ` 片段（引用化前缀新增）仍整行入 marker。
    if (body.length === 0) {
      if (complete && prefix.replace(/[>\s]/g, '').length === 0) {
        wrapped.push(line)
        continue
      }
      wrapped.push(open + line + close)
      continue
    }
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
/** setext 标题下划线（`=` 行）。CommonMark 允许单个 `=`。 */
const SETEXT_UNDERLINE_RE = /^ {0,3}=+[ \t]*$/
/** 行首 blockquote 前缀（`> ` / 嵌套 `> > `），供结构行判定剥壳复用。 */
const QUOTE_PREFIX_RE = /^ {0,3}(?:>[ \t]?)+/
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

// GFM task list checkbox（`- [x] ` / `1. [ ] `，含 blockquote 内）。只认
// 行首列表符之后紧跟的一个 `[ ]`/`[x]`/`[X]`，避免把正文里的 `[x]` 误伤。
const TASK_CHECKBOX_RE = /^([ \t]*(?:>[ \t]?)*(?:[-*+]|\d+\.)[ \t]+)\[([ xX])\](?=[ \t]|$)/
const LIST_LINE_RE = /^[ \t]*(?:>[ \t]?)*(?:[-*+]|\d+\.)[ \t]+/

/**
 * 找出 text 中所有 setext 标题块（段落行 run + `=` 下划线；`---` 形式的
 * H2 与 hr 歧义大，维持既有 thematic break 处理不atomize）。若不整块
 * 原子化，"给既有段落补 `===` 下划线"这类结构变更会因下划线单独成
 * change、被 wrapLines 结构 skip 放行而完全无高亮（Codex 二轮 P1）。
 * 题行 run：连续的非空、非结构（fence / 表 / hr / ATX / 引用 / 列表 /
 * 下划线自身）、且不含已分配占位符的行（占位符行入题会造成嵌套原子，
 * restoreAtoms 单趟 replace 解不开嵌套、PUA 直接漏到输出）。
 */
function findSetextBlocks(text: string): LineBlock[] {
  const lines = text.split('\n')
  const isPlainTitleLine = (l: string): boolean =>
    l.trim().length > 0 &&
    !PLACEHOLDER_RE.test(l) &&
    FENCE_RE.exec(l) === null &&
    !TABLE_ROW_RE.test(l) &&
    !THEMATIC_BREAK_RE.test(l) &&
    !SETEXT_UNDERLINE_RE.test(l) &&
    !/^ {0,3}(?:#{1,6}[ \t]|>)/.test(l) &&
    !LIST_LINE_RE.test(l)
  const blocks: LineBlock[] = []
  let i = 0
  while (i < lines.length) {
    if (!SETEXT_UNDERLINE_RE.test(lines[i] ?? '') || i === 0) {
      i++
      continue
    }
    let start = i
    while (start > 0 && isPlainTitleLine(lines[start - 1] ?? '')) start--
    if (start === i || (blocks.length > 0 && start <= blocks[blocks.length - 1]!.end)) {
      i++
      continue
    }
    blocks.push({ start, end: i, content: lines.slice(start, i + 1).join('\n') })
    i++
  }
  return blocks
}

/**
 * checkbox 原子化的逐行扫描。P2（Codex 二轮）：行首 ≥4 空格（或含 tab）
 * 且上一条非空行不是列表行时，该行是缩进代码块而非 task 项，原子化会让
 * 代码块 diff 被行首修复错拆出赝品 `- [x]` 行；嵌套 task（前面有列表行）
 * 缩进合法，照常原子化。
 */
function protectTaskCheckboxes(
  text: string,
  allocInline: (kind: string, content: string) => string | null,
): string {
  const lines = text.split('\n')
  let prevNonBlankIsList = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim().length === 0) continue
    const m = TASK_CHECKBOX_RE.exec(line)
    if (m !== null) {
      const leading = /^[ \t]*/.exec(line)?.[0] ?? ''
      const indentedCode = (leading.includes('\t') || leading.length >= 4) && !prevNonBlankIsList
      if (!indentedCode) {
        const pre = m[1] ?? ''
        const box = '[' + (m[2] ?? ' ') + ']'
        lines[i] = pre + (allocInline('todo', box) ?? box) + line.slice(pre.length + box.length)
      }
    }
    prevNonBlankIsList = LIST_LINE_RE.test(line)
  }
  return lines.join('\n')
}

/**
 * word 路径专属：把 left / right 中的 fenced code block、markdown 表格、
 * setext 标题块、inline code span、task checkbox 依次替换成单 codepoint
 * 占位符。占位符是 jsdiff 眼中的原子 token——整块要么 unchanged、要么
 * ins、要么 del，不会内部碎裂，marker 也就永远不会落进 code / 表分隔符
 * 里（乱码根因）。
 *
 * 顺序敏感：先 fence（fence 内的 `|` / `===` 行不能当表 / 标题）、再表格、
 * 再 setext（题行不吸收占位符行，防嵌套原子）、最后 inline code 与
 * checkbox（表格 cell / 题行内的反引号已随块抽走）。
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
    // setext 标题块（题行 + `===`）整块原子化：下划线增删才能呈现为
    // "旧段落 DEL + 新标题 INS"而不是无高亮的静默结构变化。
    const setexts = findSetextBlocks(out)
    out = replaceLineBlocks(
      out,
      setexts,
      setexts.map((b) => alloc.alloc('setext', b.content, true) ?? b.content),
    )
    out = out.replace(INLINE_CODE_RE, (m) => alloc.alloc('inline', m, false) ?? m)
    // task checkbox 原子化：`[`/`x`/`]` 逐 token diff 时，勾选态切换会产生
    // "del `x` + ins 空格"——空白 change 不包 marker（isBlank skip），空格
    // 沦为无归属 context，del 视图残留 `[x ]` 字面量、checkbox 渲染丢失。
    // 原子化后切换呈现为 `[x]`→`[ ]` 整体 DEL+INS，行首修复再把它拆成两条
    // 各自完整的 task 行（旧勾选态红、新勾选态绿）。
    return protectTaskCheckboxes(out, (kind, content) => alloc.alloc(kind, content, false))
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
 * setext 标题块同折（Codex 二轮 P1）：否则"给既有段落补 `===`"只 emit
 * 下划线一行、被结构 skip 放行，标题化完全无高亮。
 */
function computeLineChanges(left: string, right: string): Change[] {
  const alloc = new PlaceholderAllocator([left, right])
  const fold = (text: string): string => {
    const fences = findFencedBlocks(text)
    let out = replaceLineBlocks(
      text,
      fences,
      fences.map((b) => alloc.alloc('fence', b.content, false) ?? b.content),
    )
    const setexts = findSetextBlocks(out)
    out = replaceLineBlocks(
      out,
      setexts,
      setexts.map((b) => alloc.alloc('setext', b.content, false) ?? b.content),
    )
    return out
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

const TABLE_SEP_LINE = (l: string): boolean => l.includes('|') && TABLE_SEP_RE.test(l)

/** cell 剥掉 `|` 与空白后是否还有内容（区分真实行与"空侧视图" `|  |  |`）。 */
function hasTableCellContent(view: string): boolean {
  return view.replace(/[|\s]/g, '').length > 0
}

/**
 * line 模式表格结构变更修复（Codex 二轮 P1）：diffLines 把"表头改名 /
 * 列数变化"emit 成相邻的 DEL 行 + INS 行，而表格行不做拆行修复后它们会
 * 留在同一条 GFM 表里——第二行不是分隔符时整表降级为段落；旧表头 + 旧
 * 分隔符打头时新表头被当 body 行、超出旧列数的 cell 被 GFM 直接丢弃。
 * 修法：对 merged 里"带 marker 且结构不合法"（分隔符行数量 ≠ 1 或位置
 * ≠ 第二行）的顶层表格连续段，按单侧视图重建成"旧表整表 DEL + 空行 +
 * 新表整表 INS"（与 word / block 模式的整表呈现一致）。合法段（普通行级
 * 增删改）与无 marker 段原样保留——后者同时保住 identical 输入逐字节
 * 还原的不变量。
 */
function repairMergedTableRuns(merged: string): string {
  ANY_MARKER_RE.lastIndex = 0
  if (!ANY_MARKER_RE.test(merged)) return merged
  const lines = merged.split('\n')
  const out: string[] = []
  let fenceMarker = ''
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMarker !== '') {
      out.push(line)
      if (fenceMatch !== null && (fenceMatch[2] ?? '').startsWith(fenceMarker)) fenceMarker = ''
      i++
      continue
    }
    if (fenceMatch !== null) {
      out.push(line)
      fenceMarker = fenceMatch[2] ?? ''
      i++
      continue
    }
    if (!TABLE_ROW_RE.test(line)) {
      out.push(line)
      i++
      continue
    }
    let j = i
    while (j < lines.length && TABLE_ROW_RE.test(lines[j]!)) j++
    out.push(...normalizeTableRun(lines.slice(i, j)))
    i = j
  }
  return out.join('\n')
}

/** repairMergedTableRuns 的单段处理：合法 / 无 marker 段原样返回，结构
 *  不合法段按单侧视图重建。分隔符行不带 marker、无法直接归边，按"紧跟
 *  本侧表头（已积累 1 行）"归属；空侧视图行（全空 cell）丢弃。 */
function normalizeTableRun(run: string[]): string[] {
  ANY_MARKER_RE.lastIndex = 0
  if (!ANY_MARKER_RE.test(run.join('\n'))) return run
  const sepIdx: number[] = []
  for (let k = 0; k < run.length; k++) {
    if (TABLE_SEP_LINE(run[k]!)) sepIdx.push(k)
  }
  if (sepIdx.length === 0) return run
  if (sepIdx.length === 1 && sepIdx[0] === 1) return run
  const del: string[] = []
  const ins: string[] = []
  for (const l of run) {
    if (TABLE_SEP_LINE(l)) {
      if (del.length === 1) del.push(l)
      if (ins.length === 1) ins.push(l)
      continue
    }
    const dv = extractMarkedView(l, 'del')
    const iv = extractMarkedView(l, 'ins')
    if (hasTableCellContent(dv)) del.push(dv)
    if (hasTableCellContent(iv)) ins.push(iv)
  }
  if (del.length === 0 || ins.length === 0) return run
  return [
    wrapLines(del.join('\n'), MARKERS.DEL_OPEN, MARKERS.DEL_CLOSE),
    '',
    wrapLines(ins.join('\n'), MARKERS.INS_OPEN, MARKERS.INS_CLOSE),
  ]
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
    // 表格行（含 blockquote 内的）不做拆行修复：wrapTableRowCells 把 marker
    // 严格放在 cell 内部，行首 `|` 骨架不可能被 marker 真正打断；而整行
    // DEL/INS 行的"空侧视图"（`|  |  |`）的 `\|\s*` 前缀比 marker 前的物理
    // 前缀（`| `）长，isPrefixInterrupted 会误报，把每个带 marker 的表格行
    // 拆成"行 + 空行 + `|  |  |`"——整张表碎成带裸 `|` 的段落（2026-07-30
    // 评审页表格 diff 全烂的根因）。
    if (TABLE_ROW_RE.test(line.slice((QUOTE_PREFIX_RE.exec(line)?.[0] ?? '').length))) {
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
  // word 模式（separator=''）下 change 是任意片段，须为 wrapLines 计算
  // 首 / 末行是否与物理行边界对齐：首行完整 ⇔ 前一段以 \n 结尾（或文档
  // 起点）；末行完整 ⇔ 下一非空段以 \n 开头（或文档终点）。line 模式的
  // value 恒以 \n 结尾、block 模式有 \n\n separator，两者天然全完整。
  let atLineStart = true
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i]!
    if (c.value.length === 0) continue
    let firstComplete = true
    let lastComplete = true
    if (separator === '') {
      let nextVal = ''
      for (let j = i + 1; j < changes.length; j++) {
        const v = changes[j]!.value
        if (v.length > 0) {
          nextVal = v
          break
        }
      }
      firstComplete = atLineStart
      lastComplete = nextVal === '' || nextVal.startsWith('\n')
    }
    if (c.added === true) {
      parts.push(
        wrapLines(c.value, MARKERS.INS_OPEN, MARKERS.INS_CLOSE, firstComplete, lastComplete),
      )
    } else if (c.removed === true) {
      parts.push(
        wrapLines(c.value, MARKERS.DEL_OPEN, MARKERS.DEL_CLOSE, firstComplete, lastComplete),
      )
    } else {
      parts.push(c.value)
    }
    atLineStart = c.value.endsWith('\n')
  }
  // 空 marker 对（如"只剩前缀的行"包出的 open+close 相邻）渲染成零宽
  // 色块，先清掉再做表格结构修复与行首修复。
  const merged = parts
    .join(separator)
    .replaceAll(MARKERS.INS_OPEN + MARKERS.INS_CLOSE, '')
    .replaceAll(MARKERS.DEL_OPEN + MARKERS.DEL_CLOSE, '')
  return repairBrokenLinePrefixes(repairMergedTableRuns(merged))
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
  findSetextBlocks,
  pretreatWordAtoms,
  restoreAtoms,
  PlaceholderAllocator,
  trimCommonAffixes,
  repairMergedTableRuns,
  repairBrokenLinePrefixes,
  extractMarkedView,
  isPrefixInterrupted,
  FALLBACK_TOKEN_RE,
  TABLE_ROW_RE,
  TABLE_SEP_RE,
  PLACEHOLDER_BASE,
  PLACEHOLDER_END,
}
