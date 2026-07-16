// RFC-012 — Word 模式 markdown 表格保留单测。
// 锚定 buildMergedMarkdown 在 word 路径上对表格块的"占位符 + 还原"行为：
//   - 左右表完全相等 → 单一占位符 → 输出单张表，无 marker
//   - 表头改名 / 列数变化 / 表↔段落互换 → 两张表分别带 ins/del 标记
//   - 分隔符行不携带 PUA marker（否则 GFM 表识别失败、整张表降级 `<p>`）
//   - 表 cell 用未转义 `|` 切分后逐 cell 包 marker（marker 不能跨 cell 边界）
// 这些断言一旦红，浏览器实测就会出现 RFC-012 背景里那种"裸 `|---|---|` 漏出来"。

import { describe, expect, test } from 'vitest'
import { buildMergedMarkdown, MARKERS, _internal } from '@/lib/review/markdownDiff'

const { INS_OPEN, INS_CLOSE, DEL_OPEN, DEL_CLOSE } = MARKERS
const ZWSP = '​'
const stripZwsp = (s: string) => s.replaceAll(ZWSP, '')
const ANY_MARKER_RE = new RegExp(`[${INS_OPEN}${INS_CLOSE}${DEL_OPEN}${DEL_CLOSE}]`, 'g')

// design §测试 1
test('identical 左右两份相同表 → 无 marker、输出含完整表', () => {
  const t = '| col | val |\n|---|---|\n| a | 1 |\n'
  const merged = stripZwsp(buildMergedMarkdown(t, t, 'word'))
  expect(merged.includes(INS_OPEN)).toBe(false)
  expect(merged.includes(DEL_OPEN)).toBe(false)
  // 表的所有行都在输出里
  expect(merged.includes('| col | val |')).toBe(true)
  expect(merged.includes('|---|---|')).toBe(true)
  expect(merged.includes('| a | 1 |')).toBe(true)
})

// design §测试 2
test('header rename 同列数：每张表带行 ins/del，分隔符行无 marker', () => {
  const left = '| 项目名称 | 坦克大战游戏 |\n|---------|------------|\n| 文档版本 | V1.0 |\n'
  const right = '| 项目 | 内容 |\n|------|------|\n| 文档版本 | v1.0 |\n'
  const merged = stripZwsp(buildMergedMarkdown(left, right, 'word'))
  // 两份分隔符行都必须保持干净（不允许 PUA marker 落进 :?-+:? 字符之间）
  for (const sep of ['|---------|------------|', '|------|------|']) {
    expect(merged.includes(sep)).toBe(true)
    // 找到分隔符行在 merged 中的精确位置，断言它两侧没有 marker
    const idx = merged.indexOf(sep)
    expect(idx).toBeGreaterThanOrEqual(0)
    const lineEnd = merged.indexOf('\n', idx)
    const wholeLine = merged.slice(idx, lineEnd === -1 ? undefined : lineEnd)
    expect(wholeLine.match(ANY_MARKER_RE)).toBeNull()
  }
  expect(merged.includes(DEL_OPEN)).toBe(true)
  expect(merged.includes(INS_OPEN)).toBe(true)
})

// design §测试 3
test('column count change 真实样本：两张表都带 ins/del，分隔符无 marker', () => {
  // 这就是浏览器实测里把 `<table>` 降级为 `<p>` + 裸 `|---|---|` 的样本（见 RFC-012 proposal 背景）。
  const left = `| 项目名称 | 坦克大战游戏 |\n|---------|------------|\n| 文档版本 | V1.0 |\n| 创建日期 | 2026-05-16 |\n| 文档状态 | 初稿 |\n`
  const right = `| 项目 | 内容 |\n|------|------|\n| 项目名称 | 坦克大战游戏 |\n| 文档版本 | v1.0 |\n| 创建日期 | 2026-05-16 |\n| 文档状态 | 正式发布 |\n`
  const merged = stripZwsp(buildMergedMarkdown(left, right, 'word'))
  // 分隔符行必须无 marker（GFM 表识别的关键不变量）
  for (const sep of ['|---------|------------|', '|------|------|']) {
    expect(merged.includes(sep)).toBe(true)
  }
  // 旧 / 新表两份内容都应出现
  expect(merged).toMatch(new RegExp(`${DEL_OPEN}项目名称${DEL_CLOSE}`))
  expect(merged).toMatch(new RegExp(`${INS_OPEN}项目${INS_CLOSE}`))
  // 两张表之间必须有 `\n\n` 空白行（否则下游 markdown 把两张表糊成一张）
  // 旧表最后一行尾巴是 DEL marker，新表第一行起手是 IO 之前的 `| `，
  // 中间至少出现一处 `\n\n`。
  const delEnd = merged.lastIndexOf(DEL_CLOSE)
  const insStart = merged.indexOf(INS_OPEN)
  expect(delEnd).toBeGreaterThanOrEqual(0)
  expect(insStart).toBeGreaterThan(delEnd)
  expect(merged.slice(delEnd, insStart).includes('\n\n')).toBe(true)
})

// design §测试 4
test('table ↔ paragraph 互转：表 / 段落各自落 ins/del', () => {
  const left = '项目名称：坦克大战游戏\n文档版本：V1.0\n'
  const right = '| 项目 | 内容 |\n|---|---|\n| 项目名称 | 坦克大战游戏 |\n'
  const merged = stripZwsp(buildMergedMarkdown(left, right, 'word'))
  // 左侧段落字词进入 DEL
  expect(merged.includes(DEL_OPEN)).toBe(true)
  // 右侧整张表的 cell 内容进入 INS
  expect(merged).toMatch(new RegExp(`${INS_OPEN}项目${INS_CLOSE}`))
  expect(merged).toMatch(new RegExp(`${INS_OPEN}内容${INS_CLOSE}`))
  // 表分隔符行无 marker
  expect(merged.includes('|---|---|')).toBe(true)
  const idx = merged.indexOf('|---|---|')
  const lineEnd = merged.indexOf('\n', idx)
  expect(merged.slice(idx, lineEnd).match(ANY_MARKER_RE)).toBeNull()
})

// design §测试 5
test('连续两张表 + 中间段落：占位符按位置正确对应', () => {
  const left = '| a | b |\n|---|---|\n| 1 | 2 |\n\n中间段\n\n| c | d |\n|---|---|\n| 3 | 4 |\n'
  const right = '| a | b |\n|---|---|\n| 1 | 2 |\n\n中间段改\n\n| c | d2 |\n|---|---|\n| 3 | 4 |\n'
  const merged = stripZwsp(buildMergedMarkdown(left, right, 'word'))
  // 第一张表两侧相等 → 无 marker、单一输出
  expect(merged.includes('| a | b |')).toBe(true)
  // 第二张表 cell 改名 → 两侧各自带 marker
  expect(merged).toMatch(new RegExp(`${DEL_OPEN}d${DEL_CLOSE}`))
  expect(merged).toMatch(new RegExp(`${INS_OPEN}d2${INS_CLOSE}`))
  // 中间段也被 diff
  expect(merged).toMatch(new RegExp(`${INS_OPEN}改${INS_CLOSE}`))
})

// design §测试 6
test('placeholder 字符碰撞：输入含 U+E010 字面量时 fall through 不抛错', () => {
  // 极端兜底：input 自身就含 placeholder PUA 字面量。
  // 行为：不命中 table 保护（因为非表行），merged 不抛错且仍输出文本。
  const left = 'hello  world'
  const right = 'hello  earth'
  const merged = stripZwsp(buildMergedMarkdown(left, right, 'word'))
  // 不抛 + 字面量原样保留
  expect(merged.includes('')).toBe(true)
})

// design §测试 7
test('fence + 表混排：fence 块不被 marker 包，table 块正确还原', () => {
  const left = '前文\n\n```ts\nold()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
  const right = '前文\n\n```ts\nnew()\n```\n\n| a | b2 |\n|---|---|\n| 1 | 2 |\n'
  const merged = stripZwsp(buildMergedMarkdown(left, right, 'word'))
  // fence 行不允许携带 marker（RFC-010 既有不变量）
  expect(merged).not.toMatch(new RegExp(`${INS_OPEN}\`\`\``))
  expect(merged).not.toMatch(new RegExp(`${DEL_OPEN}\`\`\``))
  // table 分隔符行干净
  expect(merged.includes('|---|---|')).toBe(true)
  // 表 cell 改字 → 带 marker
  expect(merged).toMatch(new RegExp(`${DEL_OPEN}b${DEL_CLOSE}`))
  expect(merged).toMatch(new RegExp(`${INS_OPEN}b2${INS_CLOSE}`))
})

// 内部 helper 覆盖（design §测试 10 中的"源码层断言"）
describe('_internal helpers', () => {
  test('findTableBlocks: 单表识别', () => {
    const text = '前文\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n后文\n'
    const blocks = _internal.findTableBlocks(text)
    expect(blocks.length).toBe(1)
    expect(blocks[0]?.content).toBe('| a | b |\n|---|---|\n| 1 | 2 |')
  })

  test('findTableBlocks: 无 separator 的"伪表"不识别', () => {
    const text = '| not a table |\n| no separator |\n'
    expect(_internal.findTableBlocks(text).length).toBe(0)
  })

  test('pretreatWordAtoms: 内容相等 → 共用 placeholder（unchanged 保持）', () => {
    const t = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    const { l, r, lookup } = _internal.pretreatWordAtoms(t, t)
    expect(l).toBe(r)
    expect(lookup.size).toBe(1)
  })

  test('pretreatWordAtoms: 内容不等 → 两个独立 placeholder（jsdiff 会 emit del + ins）', () => {
    const left = '| a | b |\n|---|---|\n| 1 | 2 |\n'
    const right = '| a | b2 |\n|---|---|\n| 1 | 2 |\n'
    const { l, r, lookup } = _internal.pretreatWordAtoms(left, right)
    expect(l).not.toBe(r)
    expect(lookup.size).toBe(2)
  })

  test('pretreatWordAtoms: 同内容表在两侧不同位置 → 仍共用 placeholder（内容寻址）', () => {
    // 2026-07-16 回归：占位符旧实现按位置 i 配对，右侧中间插入一张新表时，
    // 后续内容未变的表被拆成两个独立占位符 → jsdiff 标成整表 DEL+INS 各
    // 显示一遍。内容寻址后同内容必共用。
    const t1 = '| a | b |\n|---|---|\n| 1 | 2 |'
    const t2 = '| x | y |\n|---|---|\n| 8 | 9 |'
    const tNew = '| n | m |\n|---|---|\n| 5 | 6 |'
    const { lookup } = _internal.pretreatWordAtoms(
      `${t1}\n\n${t2}\n`,
      `${t1}\n\n${tNew}\n\n${t2}\n`,
    )
    // t1 / t2 各共用一个，tNew 独立 → 一共 3 个
    expect(lookup.size).toBe(3)
  })

  test('restoreAtoms: pad 块占位符回填且补 `\\n\\n` 周边空白', () => {
    const lookup = new Map([['\uE010', { content: '| h |\n|---|\n| v |', pad: true }]])
    const changes = [{ added: true, removed: false, value: '\uE010', count: 1 }] as Parameters<
      typeof _internal.restoreAtoms
    >[0]
    const out = _internal.restoreAtoms(changes, lookup)
    expect(out[0]?.value).toBe('\n\n| h |\n|---|\n| v |\n\n')
  })
})
