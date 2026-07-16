// 2026-07-16 — 评审页 diff（词 / 行 / 段三档）"乱码 / 不精准"修复回归锁。
// 用户报告：按词、段、章节显示 diff 偶尔不精准或乱码。排查实证了五类根因，
// 本文件按根因逐条锁定（一旦红 = 对应乱码 / 错位形态回归）：
//   1. PUA marker 落进 fenced / inline code → 浏览器渲染 tofu 方块（乱码）。
//      修法：word 模式 fence/表格/inline code 占位符原子化；line 模式 fence
//      折叠成占位符行；block 模式 fence-aware 切块。
//   2. diff@9 下旧 ZWSP 分词完全失效（ZWSP 不匹配 \s、自身成 token），中文
//      逐字 LCS 交错（"评/审/查"红绿相间）。修法：Intl.Segmenter 词级
//      tokenize + diffArrays + 公共前后缀提取。
//   3. 表格占位符按位置配对 → 中间插表后，内容未变的表被标成整表 DEL+INS
//      显示两遍。修法：按内容配对（内容寻址）。
//   4. 行首结构前缀被 marker 打断（##→###、列表符变化）→ heading 降级成
//      段落、裸 # 可见。修法：repairBrokenLinePrefixes 拆成 DEL 行 + INS 行。
//   5. 文档自带 PUA / ZWSP 的边界：marker 隔离带字符 sanitize、占位符分配
//      避让文档已有字符、不再误剥用户 ZWSP、空 marker 对清理。

import { describe, expect, test } from 'vitest'
import { buildMergedMarkdown, MARKERS, _internal } from '@/lib/review/markdownDiff'

const { INS_OPEN, INS_CLOSE, DEL_OPEN, DEL_CLOSE } = MARKERS
const ALL_MARKERS = [INS_OPEN, INS_CLOSE, DEL_OPEN, DEL_CLOSE]

const hasMarker = (s: string): boolean => ALL_MARKERS.some((m) => s.includes(m))
const stripMarkers = (s: string): string => {
  let out = s
  for (const m of ALL_MARKERS) out = out.replaceAll(m, '')
  return out
}

/** 逐行扫 fence 状态：fence 头行、fence 内部行、fence 尾行任何一行带
 *  marker 都返回 true（= PUA 会落进 <code>，渲染成乱码方块）。 */
function markerInsideFences(merged: string): boolean {
  let fenceMarker = ''
  for (const line of merged.split('\n')) {
    const m = /^(\s*)(`{3,}|~{3,})/.exec(line)
    if (fenceMarker !== '') {
      if (hasMarker(line)) return true
      if (m !== null && (m[2] ?? '').startsWith(fenceMarker)) fenceMarker = ''
      continue
    }
    if (m !== null) {
      if (hasMarker(line)) return true
      fenceMarker = m[2] ?? ''
    }
  }
  return false
}

/** 抓取 merged 里所有 kind 段的内容拼接（验证高亮覆盖面）。 */
function pickSegments(merged: string, open: string, close: string): string[] {
  const re = new RegExp(`${open}([^${open}${close}]*)${close}`, 'g')
  const out: string[] = []
  for (const m of merged.matchAll(re)) out.push(m[1] ?? '')
  return out
}

describe('根因 1 — code 保护（乱码主根因）', () => {
  const fenceLeft = 'intro\n\n```js\nconst a = 1\nconst b = 2\n```\n\ntail\n'
  const fenceRight = 'intro\n\n```js\nconst a = 1\nconst b = 99\n```\n\ntail\n'

  test('word：fence 内改行 → 整块新旧两份、fence 内零 marker', () => {
    const merged = buildMergedMarkdown(fenceLeft, fenceRight, 'word')
    expect(markerInsideFences(merged)).toBe(false)
    expect(merged.includes('const b = 2')).toBe(true)
    expect(merged.includes('const b = 99')).toBe(true)
    // 新旧两个完整 fence 块（4 条 fence 行）
    expect(merged.split('\n').filter((l) => l.startsWith('```')).length).toBe(4)
  })

  test('line：fence 内改行 → 整块新旧两份、fence 内零 marker', () => {
    const merged = buildMergedMarkdown(fenceLeft, fenceRight, 'line')
    expect(markerInsideFences(merged)).toBe(false)
    expect(merged.includes('const b = 2')).toBe(true)
    expect(merged.includes('const b = 99')).toBe(true)
  })

  test('word：inline code 改词 → marker 包在反引号外侧，span 内零 marker', () => {
    const merged = buildMergedMarkdown('run `foo bar` now\n', 'run `foo baz` now\n', 'word')
    expect(merged.includes(`${DEL_OPEN}\`foo bar\`${DEL_CLOSE}`)).toBe(true)
    expect(merged.includes(`${INS_OPEN}\`foo baz\`${INS_CLOSE}`)).toBe(true)
    // 反引号内部不允许出现 marker（PUA 落进 <code> = 乱码）
    for (const span of merged.match(/`[^`\n]+`/g) ?? []) {
      expect(hasMarker(span)).toBe(false)
    }
  })

  test('block：含空行的 code block 不再被撕裂（旧 split(/\\n{2,}/) 会把 fence 切成两半）', () => {
    const left = '```js\nline1\n\nline2\n```\n\ntail\n'
    const right = '```js\nline1\n\nline2 changed\n```\n\ntail\n'
    const merged = buildMergedMarkdown(left, right, 'block')
    expect(markerInsideFences(merged)).toBe(false)
    // 新旧两个完整块 → 4 条 fence 行且成对闭合
    const fenceLines = stripMarkers(merged)
      .split('\n')
      .filter((l) => l.startsWith('```'))
    expect(fenceLines.length).toBe(4)
    // 块内空行结构保留
    expect(merged.includes('line1\n\nline2')).toBe(true)
  })

  test('word：fence 的 ~~~ 变体同样受保护', () => {
    const merged = buildMergedMarkdown('~~~\nold()\n~~~\n', '~~~\nnew()\n~~~\n', 'word')
    expect(markerInsideFences(merged)).toBe(false)
    expect(merged.includes('old()')).toBe(true)
    expect(merged.includes('new()')).toBe(true)
  })
})

describe('根因 2 — CJK 词级 diff（逐字交错修复）', () => {
  const hasSegmenter =
    typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function'

  test('审查→评审：词级整体替换，"审"字不再被交错共享', () => {
    if (!hasSegmenter) return
    const merged = buildMergedMarkdown('本轮代码审查通过\n', '本轮代码评审通过\n', 'word')
    // 旧逐字 LCS 输出"代码⟦I⟧评⟦/I⟧审⟦D⟧查⟦/D⟧通过"——"审"被共享，
    // 阅读顺序变成"评审查"。词级 + 公共缀提取后必须是整词替换：
    expect(pickSegments(merged, DEL_OPEN, DEL_CLOSE).join('')).toBe('审查')
    expect(pickSegments(merged, INS_OPEN, INS_CLOSE).join('')).toBe('评审')
    // 且 DEL 段与 INS 段之间不夹 context 字符（无交错）
    expect(merged.includes(`${DEL_OPEN}审查${DEL_CLOSE}${INS_OPEN}评审${INS_CLOSE}`)).toBe(true)
  })

  test('公共后缀落回 context：你好世界→你好新世界 仅"新"标绿', () => {
    const merged = buildMergedMarkdown('你好世界', '你好新世界', 'word')
    expect(pickSegments(merged, INS_OPEN, INS_CLOSE).join('')).toBe('新')
    expect(merged.includes(DEL_OPEN)).toBe(false)
  })

  test('trimCommonAffixes：del/ins 公共前后缀移回 context', () => {
    const changes = [
      { value: '世界', added: false, removed: true, count: 1 },
      { value: '新世界', added: true, removed: false, count: 1 },
    ]
    const out = _internal.trimCommonAffixes(
      changes as Parameters<typeof _internal.trimCommonAffixes>[0],
    )
    expect(out.map((c) => [c.added === true, c.removed === true, c.value])).toEqual([
      [true, false, '新'],
      [false, false, '世界'],
    ])
  })

  test('trimCommonAffixes：不劈 surrogate pair（emoji 改动不产生半个乱码字符）', () => {
    const changes = [
      { value: '😀', added: false, removed: true, count: 1 },
      { value: '😁', added: true, removed: false, count: 1 },
    ]
    const out = _internal.trimCommonAffixes(
      changes as Parameters<typeof _internal.trimCommonAffixes>[0],
    )
    // 😀 与 😁 共享 high surrogate（U+D83D），公共前缀必须回退到 pair 起点
    expect(out.map((c) => c.value)).toEqual(['😀', '😁'])
  })
})

describe('根因 3 — 表格内容寻址配对', () => {
  test('两表之间插入新表：后面内容未变的表不再标成 DEL+INS 两遍', () => {
    const t1 = '| a | b |\n|---|---|\n| 1 | 2 |'
    const t2 = '| x | y |\n|---|---|\n| 8 | 9 |'
    const tNew = '| n | m |\n|---|---|\n| 5 | 6 |'
    const merged = buildMergedMarkdown(`${t1}\n\n${t2}\n`, `${t1}\n\n${tNew}\n\n${t2}\n`, 'word')
    // t2 未变 → 只出现一次且无 marker
    const t2Hits = merged.split('| x | y |').length - 1
    expect(t2Hits).toBe(1)
    expect(pickSegments(merged, DEL_OPEN, DEL_CLOSE).join('')).not.toContain('x')
    // 新表整表 INS
    expect(pickSegments(merged, INS_OPEN, INS_CLOSE).join('')).toContain('n')
  })
})

describe('根因 4 — 行首结构前缀打断修复', () => {
  test('heading 级别变化 ##→###：拆成合法 DEL 行 + INS 行，裸 # 不再漏出', () => {
    const merged = buildMergedMarkdown('## Title\n', '### Title\n', 'word')
    const lines = merged.split('\n').filter((l) => l.trim().length > 0)
    // 存在 '## ' 开头的 DEL 行与 '### ' 开头的 INS 行
    expect(lines.some((l) => l.startsWith('## ') && l.includes(DEL_OPEN))).toBe(true)
    expect(lines.some((l) => l.startsWith('### ') && l.includes(INS_OPEN))).toBe(true)
    // 行首 # 序列中间不允许夹 marker（旧 bug 形态：##⟦I⟧# Title）
    for (const m of ALL_MARKERS) {
      expect(merged.includes(`#${m}#`)).toBe(false)
    }
  })

  test('有序列表插入项（重编号）：行首数字不被 marker 打断、无空 marker 对', () => {
    const merged = buildMergedMarkdown(
      '1. alpha\n2. beta\n',
      '1. alpha\n2. inserted\n3. beta\n',
      'word',
    )
    expect(merged.includes(`${INS_OPEN}inserted${INS_CLOSE}`)).toBe(true)
    // 行首不允许 marker 紧跟数字（列表解析破坏形态）
    for (const line of merged.split('\n')) {
      expect(/^[\uE000-\uE003]\d/.test(line)).toBe(false)
    }
    // 空 marker 对（渲染成零宽色块）必须被清理
    expect(merged.includes(INS_OPEN + INS_CLOSE)).toBe(false)
    expect(merged.includes(DEL_OPEN + DEL_CLOSE)).toBe(false)
  })

  test('列表符号变化 -→*：拆行后两侧都是合法列表行', () => {
    const merged = buildMergedMarkdown('- item one\n', '* item one\n', 'word')
    const stripped = stripMarkers(merged)
    const lines = stripped.split('\n').filter((l) => l.trim().length > 0)
    // 每个非空行都以合法列表前缀开头（不允许出现裸的 -* 粘连行）
    for (const l of lines) {
      expect(/^(-|\*) /.test(l)).toBe(true)
    }
  })
})

describe('根因 5 — 输入边界防护', () => {
  test('文档自带 marker 区 PUA（U+E000–E003）被 sanitize，不产生假高亮', () => {
    const dirty = 'before\uE000mid\uE002after\n'
    const merged = buildMergedMarkdown(dirty, dirty, 'word')
    expect(merged).toBe('beforemidafter\n')
  })

  test('文档自带占位符区字符（U+E010）+ 表格：分配避让，字符原样保留', () => {
    const doc = '\uE010 icon text\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'
    const merged = buildMergedMarkdown(doc, doc, 'word')
    // unchanged 全文原样（U+E010 不被误还原成表内容、表正常还原）
    expect(merged).toBe(doc)
  })

  test('不再误剥用户文档里的原生 ZWSP', () => {
    const doc = 'a\u200Bb\n'
    const merged = buildMergedMarkdown(doc, doc, 'word')
    expect(merged).toBe(doc)
  })

  test('identical 长文档（含 fence + 表 + inline code）→ 输出与输入完全一致', () => {
    const doc = [
      '# Title',
      '',
      'para with `code span` here',
      '',
      '```ts',
      'const x = 1',
      '',
      'const y = 2',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'tail',
      '',
    ].join('\n')
    for (const g of ['word', 'line', 'block'] as const) {
      const merged = buildMergedMarkdown(doc, doc, g)
      expect(hasMarker(merged)).toBe(false)
      // word/line 模式必须逐字节还原；block 模式允许段间空行规范化
      if (g !== 'block') expect(merged).toBe(doc)
      else
        expect(
          stripMarkers(merged)
            .replace(/\n{2,}/g, '\n\n')
            .trim(),
        ).toBe(doc.replace(/\n{2,}/g, '\n\n').trim())
    }
  })
})

// 2026-07-16 — Codex 实现门评审(6 P2)修复回归。
describe('Codex 实现门 findings', () => {
  test('F1: 转义反引号 \\`word\\` 不被当 code span 原子化', () => {
    const merged = buildMergedMarkdown('see \\`old\\` here\n', 'see \\`new\\` here\n', 'word')
    expect(merged.includes(`${DEL_OPEN}old${DEL_CLOSE}`)).toBe(true)
    expect(merged.includes(`${INS_OPEN}new${INS_CLOSE}`)).toBe(true)
  })

  test('F3: 无 Segmenter fallback 正则 CJK 逐字、拉丁词级', () => {
    expect('甲乙丙 hello'.match(_internal.FALLBACK_TOKEN_RE)).toEqual([
      '甲',
      '乙',
      '丙',
      ' ',
      'hello',
    ])
  })

  test('F4: 有序列表显式序号变化 10.→1. 拆行后以空行分隔成两个列表', () => {
    const merged = buildMergedMarkdown('10. item\n', '1. item\n', 'word')
    const lines = merged.split('\n')
    const delIdx = lines.findIndex((l) => l.startsWith('10. ') && l.includes(DEL_OPEN))
    const insIdx = lines.findIndex((l) => l.startsWith('1. ') && l.includes(INS_OPEN))
    expect(delIdx).toBeGreaterThanOrEqual(0)
    expect(insIdx).toBeGreaterThan(delIdx)
    // 相邻会被 CommonMark 合并成一个 <ol> 并忽略第二个显式序号
    expect(lines.slice(delIdx + 1, insIdx).some((l) => l.trim() === '')).toBe(true)
  })

  test('F5: line 档未闭合 fence 到 EOF,identical 输入逐字节还原', () => {
    const doc = '```js\nconst x = 1\n'
    expect(buildMergedMarkdown(doc, doc, 'line')).toBe(doc)
    // word 档同样不多不少
    expect(buildMergedMarkdown(doc, doc, 'word')).toBe(doc)
  })
})
