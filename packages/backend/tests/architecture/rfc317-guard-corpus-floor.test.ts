// RFC-317 T13 / T21 —— 扫语料的守卫必须自己证明「语料还在」。
//
// 事故形态
// --------
// 源码扫描型守卫的绿有两种来源，断言层面**完全同形**：
//   ① 真的没有违规；
//   ② 扫描根写错 / walk 提前 return / 后缀过滤把语料筛成空 —— 违规集合当然为空。
// ② 一旦发生就是**永久静默**：没有任何断言会因此转红，守卫从此零预言力，而它
// 依然每次 CI 都绿，还在 manifest 里占着「已有守卫」的名额。
//
// findings G-07 实测：rfc294-architecture-preflight / rfc305-architecture-lock /
// rfc284-spawn-site-ratchet / ux-source-ratchets 这四条最吃重的 ratchet，一条语料
// 下限都没有——把它们的扫描根改成一个空目录，全部照绿。
//
// 本守卫要求：**凡枚举文件的守卫，都必须在自己文件里断言一条语料下限**，并把该
// 下限两向钉进 `architecture/guard-manifest.json`。下限被调低 / 断言被删 / 新守卫
// 忘了写，三种都红。
//
// 判据与账本共用 `census.ts` 的 `isCorpusScanner` / `corpusFloor` 单一实现——否则
// 又会长出「账本一套判据、守卫另一套判据」的第二实现（正是 RFC-317 要防的形状）。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { corpusFloor, guardTestFiles, isCorpusScanner, sourceUnit } from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

interface ManifestGuard {
  readonly id: string
  readonly file: string
  readonly corpusScanner: boolean
  readonly minCorpusFiles: number | null
}

const MANIFEST = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'architecture', 'guard-manifest.json'), 'utf8'),
) as { readonly guards: readonly ManifestGuard[] }

/**
 * 尚未声明语料下限的扫描型守卫。**每条必须写清为什么、以及哪一波清偿**。
 *
 * 空表是**目标态**：RFC-317 B2 把当时全部 36 个扫描型守卫一次性补齐。往这里加
 * 一行等于承认新增了一个「扫空也照绿」的守卫——那必须是有意识的决定，并点名清偿波次。
 */
const NO_FLOOR_YET: Readonly<Record<string, { why: string; removeWhen: string }>> = {}

interface Scanned {
  readonly file: string
  readonly scanner: boolean
  readonly floor: number | null
}

const SCANNED: readonly Scanned[] = guardTestFiles(REPO_ROOT).map((rel) => {
  const unit = sourceUnit(rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8'))
  return { file: rel, scanner: isCorpusScanner(unit), floor: corpusFloor(unit) }
})

const SCANNERS = SCANNED.filter((row) => row.scanner)

describe('RFC-317 T13 —— 扫语料的守卫必须声明语料下限', () => {
  test('语料非空：确实扫得到一批扫描型守卫（扫成 0 说明判据本身失效，此刻零预言力）', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(100)
    expect(SCANNERS.length).toBeGreaterThanOrEqual(30)
  })

  test('每个扫语料的守卫都断言了 >= 1 的语料下限（否则扫空 = 假绿）', () => {
    const offenders = SCANNERS.filter(
      (row) => row.floor === null && NO_FLOOR_YET[row.file] === undefined,
    ).map((row) => row.file)
    expect(
      offenders,
      '这些守卫枚举文件却没有任何语料规模断言——扫描根一旦失效，它们会永久静默地绿。' +
        '加一条 `expect(<语料>.length).toBeGreaterThanOrEqual(N)`，并把 N 填进 guard-manifest.json 的 minCorpusFiles',
    ).toEqual([])
  })

  test('豁免无过期条目（守卫没了 / 已补下限 / 已不再扫语料 ⇒ 删掉这一行）', () => {
    const byFile = new Map(SCANNED.map((row) => [row.file, row]))
    const stale: string[] = []
    for (const file of Object.keys(NO_FLOOR_YET)) {
      const row = byFile.get(file)
      if (row === undefined) stale.push(`${file}（守卫已不存在）`)
      else if (!row.scanner) stale.push(`${file}（已不再枚举语料，豁免应删除）`)
      else if (row.floor !== null) stale.push(`${file}（已补上语料下限，豁免应删除）`)
    }
    expect(stale, '豁免只能缩、不能涨；过期条目必须删').toEqual([])
  })

  test('每条豁免都写清理由与**具名**清偿波次（不接受「以后再说」）', () => {
    const bad = Object.entries(NO_FLOOR_YET)
      .filter(
        ([, entry]) =>
          entry.why.trim().length < 20 ||
          entry.removeWhen.trim().length < 10 ||
          !/RFC-\d{3}|B\d{1,2}|W\d/.test(entry.removeWhen),
      )
      .map(([file]) => file)
    expect(bad, 'removeWhen 必须点名具体 RFC / 批次').toEqual([])
  })
})

describe('RFC-317 T13 —— 语料下限两向钉死进 guard-manifest.json', () => {
  const manifestByFile = new Map(MANIFEST.guards.map((guard) => [guard.file, guard]))

  test('磁盘上「谁在扫语料」与账本 corpusScanner 逐条相等', () => {
    const onDisk = SCANNERS.map((row) => row.file).sort()
    const inLedger = MANIFEST.guards
      .filter((guard) => guard.corpusScanner)
      .map((guard) => guard.file)
      .sort()
    expect(
      inLedger,
      '守卫从「读固定文件」变成「扫语料」（或反之）时必须同步账本——这不是记账洁癖：' +
        'corpusScanner 决定了它要不要受语料下限约束',
    ).toEqual(onDisk)
  })

  test('账本记的 minCorpusFiles 与守卫文件里断言的下限逐条相等（调低下限就红）', () => {
    const drift: string[] = []
    for (const row of SCANNERS) {
      const guard = manifestByFile.get(row.file)
      if (guard === undefined) {
        drift.push(`${row.file}: 不在账本里`)
        continue
      }
      if (guard.minCorpusFiles !== row.floor) {
        drift.push(`${row.file}: 账本 ${String(guard.minCorpusFiles)} vs 文件 ${String(row.floor)}`)
      }
    }
    expect(
      drift,
      '语料下限被改动却没进账本。**调低下限必须是一次有记录的决定**——静默调低正是让守卫慢慢失去牙齿的路径',
    ).toEqual([])
  })

  test('非扫描型守卫不得记 minCorpusFiles（避免账本里出现无人校验的数字）', () => {
    const bogus = MANIFEST.guards
      .filter((guard) => !guard.corpusScanner && guard.minCorpusFiles !== null)
      .map((guard) => guard.file)
    expect(bogus, '这些守卫不扫语料，minCorpusFiles 无从校验，必须是 null').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// R11 自变异：判据自己必须有牙齿（T21）
// ---------------------------------------------------------------------------
//
// 上面每条断言都建立在 isCorpusScanner / corpusFloor 之上。这两个函数一旦判错，
// 本守卫会用与「全部合规」完全相同的形态绿掉。fixture 一律内存字符串——不落磁盘、
// 不依赖仓内某个文件恰好保持某形状。

interface Fixture {
  readonly name: string
  readonly source: string
  readonly scanner: boolean
  readonly floor: number | null
}

const FIXTURES: readonly Fixture[] = [
  {
    name: '真的在 readdirSync 枚举 ⇒ 扫描型',
    source: `import { readdirSync } from 'node:fs'\nconst files = readdirSync('/x')\n`,
    scanner: true,
    floor: null,
  },
  {
    name: '注释里提到 readdirSync ⇒ 不算（正向检查不得被注释满足）',
    source: `// 这里以前用 readdirSync 扫，现在改成读固定文件\nconst text = readFileSync('/x')\n`,
    scanner: false,
    floor: null,
  },
  {
    name: '字符串里出现 globSync ⇒ 不算',
    source: `const hint = 'globSync 在本仓被禁用'\n`,
    scanner: false,
    floor: null,
  },
  {
    name: 'toBeGreaterThan(200) ⇒ 下限 201',
    source: `import { readdirSync } from 'node:fs'\nconst f = readdirSync('/x')\nexpect(f.length).toBeGreaterThan(200)\n`,
    scanner: true,
    floor: 201,
  },
  {
    name: 'toBeGreaterThanOrEqual(200) ⇒ 下限 200',
    source: `import { readdirSync } from 'node:fs'\nconst f = readdirSync('/x')\nexpect(f.length).toBeGreaterThanOrEqual(200)\n`,
    scanner: true,
    floor: 200,
  },
  {
    name: '同文件多条取最大',
    source:
      `import { readdirSync } from 'node:fs'\nconst f = readdirSync('/x')\n` +
      `expect(f.length).toBeGreaterThanOrEqual(3)\nexpect(f.length).toBeGreaterThanOrEqual(120)\n`,
    scanner: true,
    floor: 120,
  },
  {
    name: 'Set.size 也算语料规模',
    source: `import { readdirSync } from 'node:fs'\nconst s = new Set(readdirSync('/x'))\nexpect(s.size).toBeGreaterThanOrEqual(9)\n`,
    scanner: true,
    floor: 9,
  },
  {
    name: '接收者不是规模（.count）⇒ 不记为下限',
    source: `import { readdirSync } from 'node:fs'\nreaddirSync('/x')\nexpect(stats.count).toBeGreaterThan(5)\n`,
    scanner: true,
    floor: null,
  },
  {
    name: 'toBeGreaterThan(0) ⇒ 记 1（「非空」是合法的最弱下限）',
    source: `import { readdirSync } from 'node:fs'\nconst f = readdirSync('/x')\nexpect(f.length).toBeGreaterThan(0)\n`,
    scanner: true,
    floor: 1,
  },
  {
    name: '违规集合断言 toEqual([]) 不是语料下限',
    source: `import { readdirSync } from 'node:fs'\nconst bad = readdirSync('/x').filter(hit)\nexpect(bad).toEqual([])\n`,
    scanner: true,
    floor: null,
  },
]

describe('RFC-317 T21 —— 判据自变异：把 fixture 喂回同一份判据', () => {
  test('fixture 语料非空（fixture 表被清空时本 describe 会零预言力）', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(10)
  })

  for (const fixture of FIXTURES) {
    test(`isCorpusScanner / corpusFloor：${fixture.name}`, () => {
      const unit = sourceUnit('fixture.test.ts', fixture.source)
      expect(isCorpusScanner(unit), `${fixture.name} —— 扫描型判定`).toBe(fixture.scanner)
      expect(corpusFloor(unit), `${fixture.name} —— 语料下限`).toBe(fixture.floor)
    })
  }

  test('两个判据互相独立：不扫语料的文件即便写了下限也不进受管集合', () => {
    const unit = sourceUnit('fixture.test.ts', `expect(rows.length).toBeGreaterThanOrEqual(4)\n`)
    expect(isCorpusScanner(unit)).toBe(false)
    expect(corpusFloor(unit)).toBe(4)
  })
})
