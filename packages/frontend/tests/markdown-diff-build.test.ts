// RFC-010 — buildMergedMarkdown 单元测试。
// 锚定 markdown-diff word 模式的合并语义：
//   - 等同 → 无 marker
//   - 改字 → marker 包裹改动 token，保留行首 markdown 结构前缀
//   - 整行新增 / 删除 → 每行独立包 marker，不破坏块结构
//   - CJK 词级粒度走 Intl.Segmenter tokenize（tokenizeForWordDiff）
//   - <script> 字面量原样保留（react-markdown 阶段才转义）
// 这些断言一旦红，意味着 MarkdownDiffView 的渲染态高亮会出错。

import { describe, expect, test } from 'vitest'
import {
  buildMergedMarkdown,
  MARKERS,
  tokenizeForWordDiff,
  _internal,
} from '@/lib/review/markdownDiff'

const { INS_OPEN, INS_CLOSE, DEL_OPEN, DEL_CLOSE } = MARKERS
const ZWSP = '​'
const stripZwsp = (s: string) => s.replaceAll(ZWSP, '')

describe('buildMergedMarkdown', () => {
  test('identical input → 无 marker', () => {
    const merged = stripZwsp(buildMergedMarkdown('hello world', 'hello world'))
    expect(merged.includes(INS_OPEN)).toBe(false)
    expect(merged.includes(DEL_OPEN)).toBe(false)
    expect(merged).toBe('hello world')
  })

  test('段内改字 → marker 包改动 token', () => {
    const merged = stripZwsp(buildMergedMarkdown('the order_status enum', 'the order_status field'))
    expect(merged.includes(`${INS_OPEN}field${INS_CLOSE}`)).toBe(true)
    expect(merged.includes(`${DEL_OPEN}enum${DEL_CLOSE}`)).toBe(true)
  })

  test('heading 改字 → marker 落在 # 之后', () => {
    const merged = stripZwsp(buildMergedMarkdown('# Old Title', '# New Title'))
    // marker 必须在 '# ' 之后，否则 markdown 解析会失败（'#' 不再在行首结构位置）
    expect(merged.startsWith('# ')).toBe(true)
    expect(merged).not.toMatch(new RegExp(`^${INS_OPEN}#`))
    expect(merged).not.toMatch(new RegExp(`^${DEL_OPEN}#`))
    expect(merged.includes(INS_OPEN)).toBe(true)
    expect(merged.includes(DEL_OPEN)).toBe(true)
  })

  test('list item 改字 → marker 落在 "- " 之后', () => {
    const merged = stripZwsp(
      buildMergedMarkdown('- buy milk\n- buy bread', '- buy oats\n- buy bread'),
    )
    expect(merged.startsWith('- ')).toBe(true)
    expect(merged).not.toMatch(new RegExp(`^${INS_OPEN}-`))
    expect(merged).not.toMatch(new RegExp(`^${DEL_OPEN}-`))
    expect(merged.includes('buy bread')).toBe(true)
  })

  test('blockquote 改字 → marker 落在 "> " 之后', () => {
    const merged = stripZwsp(buildMergedMarkdown('> alert old', '> alert new'))
    expect(merged.startsWith('> ')).toBe(true)
    expect(merged).not.toMatch(new RegExp(`^${INS_OPEN}>`))
  })

  test('table cell 改字 → marker 落在 "| " 之后', () => {
    const merged = stripZwsp(buildMergedMarkdown('| col1 | old |\n', '| col1 | new |\n'))
    expect(merged.startsWith('| ')).toBe(true)
    expect(merged).not.toMatch(new RegExp(`^${INS_OPEN}\\|`))
  })

  test('整段新增（多行）→ 每非空行独立包 marker', () => {
    const left = 'paragraph one\n'
    const right = 'paragraph one\n\n## New Section\n\nbody body\n'
    const merged = stripZwsp(buildMergedMarkdown(left, right))
    // 整段新增的多行内容里：'## New Section' 被包住但 '##' 在 marker 之外
    expect(merged.includes(INS_OPEN)).toBe(true)
    // 不允许出现 '##' 被 marker 切散
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}#{1,6}`))
  })

  test('整段删除（多行）→ 每非空行独立包 DEL marker', () => {
    const left = 'paragraph one\n\n## Old Section\n\nbody\n'
    const right = 'paragraph one\n'
    const merged = stripZwsp(buildMergedMarkdown(left, right))
    expect(merged.includes(DEL_OPEN)).toBe(true)
    expect(merged).not.toMatch(new RegExp(`${DEL_OPEN}#{1,6}`))
  })

  test('CJK：你好世界 vs 你好新世界 — 仅 "新" 一段 ins', () => {
    const merged = stripZwsp(buildMergedMarkdown('你好世界', '你好新世界'))
    // INS marker 应包含 "新" 而非整个 "你好新世界"
    const insMatch = new RegExp(`${INS_OPEN}([^${INS_CLOSE}]*)${INS_CLOSE}`).exec(merged)
    expect(insMatch).not.toBeNull()
    expect(insMatch?.[1]).toBe('新')
  })

  test('安全：<script> 字面量被原样保留', () => {
    const merged = stripZwsp(buildMergedMarkdown('hello', '<script>alert(1)</script>'))
    // buildMergedMarkdown 不做 HTML 转义；react-markdown 渲染阶段才会转义
    expect(merged.includes('<script>')).toBe(true)
  })

  test('行首 markdown 结构前缀正则覆盖嵌套（"  > - "）', () => {
    const m = _internal.LEADING_BLOCK_PREFIX_RE.exec('  > - item text')
    expect(m).not.toBeNull()
    expect(m?.[1]).toBe('  > - ')
    expect(m?.[2]).toBe('item text')
  })
})

describe('buildMergedMarkdown — line granularity', () => {
  test('单行改字 → 整行 DEL 加整行 INS', () => {
    const merged = stripZwsp(
      buildMergedMarkdown('hello world\nstable\n', 'hello earth\nstable\n', 'line'),
    )
    // 第一行变了 → 整行包 DEL + 整行包 INS；第二行 'stable' 保持 context
    expect(merged.includes(`${DEL_OPEN}hello world${DEL_CLOSE}`)).toBe(true)
    expect(merged.includes(`${INS_OPEN}hello earth${INS_CLOSE}`)).toBe(true)
    expect(merged.includes('stable')).toBe(true)
    expect(merged).not.toMatch(new RegExp(`${DEL_OPEN}stable`))
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}stable`))
  })

  test('整行新增 → 仅 INS marker', () => {
    const merged = stripZwsp(buildMergedMarkdown('a\nb\n', 'a\nb\nc\n', 'line'))
    expect(merged.includes(`${INS_OPEN}c${INS_CLOSE}`)).toBe(true)
    expect(merged.includes(DEL_OPEN)).toBe(false)
  })

  test('整行删除 → 仅 DEL marker', () => {
    const merged = stripZwsp(buildMergedMarkdown('a\nb\nc\n', 'a\nc\n', 'line'))
    expect(merged.includes(`${DEL_OPEN}b${DEL_CLOSE}`)).toBe(true)
    expect(merged.includes(INS_OPEN)).toBe(false)
  })

  test('行首结构前缀（heading / list）保留在 marker 之外', () => {
    const merged = stripZwsp(buildMergedMarkdown('# Old Title\n', '# New Title\n', 'line'))
    expect(merged.startsWith('# ')).toBe(true)
    expect(merged).not.toMatch(new RegExp(`^${DEL_OPEN}#`))
    expect(merged).not.toMatch(new RegExp(`^${INS_OPEN}#`))
  })
})

describe('buildMergedMarkdown — block granularity', () => {
  test('整段重写 → 旧段 DEL + 新段 INS', () => {
    const left = 'first paragraph\n\nold paragraph two\n\nthird paragraph\n'
    const right = 'first paragraph\n\nbrand new paragraph two\n\nthird paragraph\n'
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'block'))
    expect(merged.includes(`${DEL_OPEN}old paragraph two${DEL_CLOSE}`)).toBe(true)
    expect(merged.includes(`${INS_OPEN}brand new paragraph two${INS_CLOSE}`)).toBe(true)
    expect(merged.includes('first paragraph')).toBe(true)
    expect(merged.includes('third paragraph')).toBe(true)
  })

  test('整段新增（多行） → 每非空行独立包 INS marker、行首 # / - 保留', () => {
    const left = 'paragraph one\n'
    const right = 'paragraph one\n\n## New Section\n\n- bullet a\n- bullet b\n'
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'block'))
    expect(merged.includes(INS_OPEN)).toBe(true)
    // ## 与 - 必须保留在 marker 之外，否则 markdown 结构破坏
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}#`))
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}-\\s`))
  })

  test('段→列表 的结构性 diff：旧段 DEL + 新列表项 INS（每项独立标）', () => {
    const left = 'todo: buy milk and bread\n'
    const right = '- buy milk\n- buy bread\n'
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'block'))
    expect(merged.includes(DEL_OPEN)).toBe(true)
    expect(merged.includes(INS_OPEN)).toBe(true)
    // 列表项的 '- ' 仍在 marker 之外
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}-\\s`))
  })
})

describe('buildMergedMarkdown — granularity 默认值', () => {
  test('未传 granularity 时默认走 word', () => {
    const a = stripZwsp(buildMergedMarkdown('hello old', 'hello new'))
    const b = stripZwsp(buildMergedMarkdown('hello old', 'hello new', 'word'))
    expect(a).toBe(b)
  })
})

describe('buildMergedMarkdown — line 模式用户回归 (CJK 单行替换)', () => {
  // 用户报告：在 line 模式下，把"单人/双人游戏模式"改成"单人游戏模式"
  // 后，旧行有红色 strikethrough 但新行完全没有绿色高亮。两份文档里
  // "单人游戏模式"只出现一次（无 LCS 误匹配），所以 jsdiff diffLines
  // 必须 emit removed + added 两条，wrapLines 必须把两条都包到 marker。
  // 一旦这条红，说明 INS marker 没生成 / 被吞，要先复现再 fix。

  test('单行替换（无重复）— 旧行 DEL + 新行 INS 都必须出现在 merged', () => {
    const left = '单人/双人游戏模式\n'
    const right = '单人游戏模式\n'
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'line'))
    expect(merged).toMatch(new RegExp(`${DEL_OPEN}单人/双人游戏模式${DEL_CLOSE}`))
    expect(merged).toMatch(new RegExp(`${INS_OPEN}单人游戏模式${INS_CLOSE}`))
  })

  test('裸单行（无 trailing newline）— 旧行 DEL + 新行 INS 都必须出现', () => {
    // 防御 jsdiff diffLines 对 trailing-newline 边界的差异：value 可能
    // 没有 \n 结尾。wrapLines 仍要正确包 marker。
    const left = '单人/双人游戏模式'
    const right = '单人游戏模式'
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'line'))
    expect(merged.includes(`${DEL_OPEN}单人/双人游戏模式${DEL_CLOSE}`)).toBe(true)
    expect(merged.includes(`${INS_OPEN}单人游戏模式${INS_CLOSE}`)).toBe(true)
  })

  test('上下文包夹的单行替换 — 中间一行 DEL + INS，前后保持 context 不动', () => {
    const left = ['前文', '单人/双人游戏模式', '后文'].join('\n')
    const right = ['前文', '单人游戏模式', '后文'].join('\n')
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'line'))
    expect(merged.includes('前文')).toBe(true)
    expect(merged.includes('后文')).toBe(true)
    expect(merged).toMatch(new RegExp(`${DEL_OPEN}单人/双人游戏模式${DEL_CLOSE}`))
    expect(merged).toMatch(new RegExp(`${INS_OPEN}单人游戏模式${INS_CLOSE}`))
  })

  test('列表项内单行替换 — 行首 "- " 留外，旧行 DEL + 新行 INS 都必须出现', () => {
    const left = ['- 单人/双人游戏模式', '- 多人游戏模式'].join('\n')
    const right = ['- 单人游戏模式', '- 多人游戏模式'].join('\n')
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'line'))
    expect(merged).toMatch(new RegExp(`${DEL_OPEN}单人/双人游戏模式${DEL_CLOSE}`))
    expect(merged).toMatch(new RegExp(`${INS_OPEN}单人游戏模式${INS_CLOSE}`))
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}-`))
    expect(merged).not.toMatch(new RegExp(`${DEL_OPEN}-`))
  })
})

describe('buildMergedMarkdown — block 模式回归', () => {
  // 这组用例锁住"block 模式过去看起来等同于 line 模式"那个 bug：
  // 旧实现把 splitBlocks 用单个 \n join 后再 diffLines，多行块（code
  // fence、列表、表格）的内部 \n 被当 line 边界，导致整段结构被切散。
  // 改用 diffArrays<string> + 段间 \n\n 分隔后必须满足以下断言。

  test('代码块改动：fence 行不能被 marker 包裹（否则 markdown 解析失败）', () => {
    const left = ['# Spec', '', '```ts', 'old()', '```', '', 'tail.'].join('\n')
    const right = ['# Spec', '', '```ts', 'new()', '```', '', 'tail.'].join('\n')
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'block'))
    // fence 头 / 尾必须原样（不允许 ` ``` ` 前面出现 marker）
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}\`\`\``))
    expect(merged).not.toMatch(new RegExp(`${DEL_OPEN}\`\`\``))
    // 旧 / 新代码都得在输出中出现（block 视图把两份都给 reviewer 看）
    expect(merged.includes('old()')).toBe(true)
    expect(merged.includes('new()')).toBe(true)
  })

  test('段间分隔：删除段 + 新增段相邻时仍以 \\n\\n 隔开（防止糊成一段）', () => {
    const left = 'Intro.\n\nMiddle old.\n\nEnd.'
    const right = 'Intro.\n\nMiddle new.\n\nEnd.'
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'block'))
    // 删除段与新增段必须用 \n\n 分隔，否则下游 markdown 渲染成一段
    expect(merged).toMatch(
      new RegExp(`${DEL_OPEN}Middle old\\.${DEL_CLOSE}\\n\\n${INS_OPEN}Middle new\\.${INS_CLOSE}`),
    )
    // Intro / End 上下文段也都必须是独立段（前后 \n\n）
    expect(merged.startsWith('Intro.')).toBe(true)
    expect(merged.endsWith('End.')).toBe(true)
  })

  test('多块全删：每块独立 DEL，不会合并成一个 marker', () => {
    const left = 'A.\n\nB.\n\nC.'
    const right = 'A.\n\nC.'
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'block'))
    // 只有 B 被删，A / C 是 context
    expect(merged.includes(`${DEL_OPEN}B.${DEL_CLOSE}`)).toBe(true)
    expect(merged).not.toMatch(new RegExp(`${DEL_OPEN}A\\.`))
  })

  test('列表项的 \\n 不再被当作 line 边界（验证 diffArrays 取代旧 join "\\n"）', () => {
    // 旧实现下，列表内的 \n 会被 splitBlocks().join('\n') 与 diffLines
    // 联手切成多个 "line"，整个列表的 block 形态丧失。改用 diffArrays
    // 后整个列表是一个原子 token，单项变化时整个列表块作为 DEL/INS。
    const left = ['# Doc', '', '- a', '- b', '- c'].join('\n')
    const right = ['# Doc', '', '- a', '- b', '- d'].join('\n')
    const merged = stripZwsp(buildMergedMarkdown(left, right, 'block'))
    // # Doc 不变 → context；列表整块作为一个 change（DEL 旧 + INS 新）
    expect(merged.startsWith('# Doc')).toBe(true)
    // INS 段和 DEL 段都得出现
    expect(merged.includes(INS_OPEN)).toBe(true)
    expect(merged.includes(DEL_OPEN)).toBe(true)
    // 列表项的 '- ' 仍在 marker 之外（行首结构前缀保留）
    expect(merged).not.toMatch(new RegExp(`${INS_OPEN}-\\s`))
    expect(merged).not.toMatch(new RegExp(`${DEL_OPEN}-\\s`))
  })
})

describe('tokenizeForWordDiff', () => {
  test('tokens 拼接恒等于原文（partition 不变量，diff 后 join 无损）', () => {
    for (const s of ['simple english', '你好世界', 'mix 中文 and english\nnew line']) {
      expect(tokenizeForWordDiff(s).join('')).toBe(s)
    }
  })

  test('CJK 被切成多个 token（词级，不再整段一个 token）', () => {
    // Intl.Segmenter 可用时"你好世界"至少切成"你好/世界"两段；
    // fallback 正则也按单字切。两条路径都不允许整段成一个 token。
    const out = tokenizeForWordDiff('你好世界')
    expect(out.length).toBeGreaterThan(1)
  })

  test('空串 → 空 token 数组', () => {
    expect(tokenizeForWordDiff('')).toEqual([])
  })
})

// RFC-012 — 源码层断言锁住 word 路径上的占位符原子化内部 helper 在
// _internal 里被 export。一旦未来误删 / 改名，build 测试一并红，提示这是
// word 模式表格 / code 块保留契约的一部分。
describe('_internal exports — 占位符原子化契约（RFC-012 泛化）', () => {
  test('_internal 暴露 findTableBlocks / findFencedBlocks / pretreatWordAtoms / restoreAtoms', () => {
    expect(typeof _internal.findTableBlocks).toBe('function')
    expect(typeof _internal.findFencedBlocks).toBe('function')
    expect(typeof _internal.pretreatWordAtoms).toBe('function')
    expect(typeof _internal.restoreAtoms).toBe('function')
  })

  test('_internal.PLACEHOLDER_BASE 与 MARKERS PUA 区间不重叠', () => {
    const base = _internal.PLACEHOLDER_BASE as number
    const end = _internal.PLACEHOLDER_END as number
    const markerCps = [INS_OPEN, INS_CLOSE, DEL_OPEN, DEL_CLOSE].map((c) => c.codePointAt(0)!)
    for (const cp of markerCps) {
      expect(cp).toBeLessThan(base)
    }
    expect(end).toBeGreaterThan(base)
  })

  test('TABLE_SEP_RE 严格匹配 GFM 分隔符行，不误伤普通段落', () => {
    expect(_internal.TABLE_SEP_RE.test('|---|---|')).toBe(true)
    expect(_internal.TABLE_SEP_RE.test('| :---: | ---: |')).toBe(true)
    expect(_internal.TABLE_SEP_RE.test('| 项目 | 内容 |')).toBe(false)
    expect(_internal.TABLE_SEP_RE.test('正常段落')).toBe(false)
  })
})
