// RFC-317 T14 / T15 / T21 —— 断言「不存在」的守卫必须证明自己还咬得动。
//
// 事故形态
// --------
// 扫语料型守卫的绿有三种来源，断言层面**两两同形**：
//   ① 真的没有违规；
//   ② 语料被筛成空（T13 已由 rfc317-guard-corpus-floor 挡住）；
//   ③ **语料还在，但 matcher 不咬了**——正则被「整理」掉一支、AST 判据漏掉一种语法
//      形态、needle 被改名。违规集合同样回到空。
// ③ 是本文件的对象。它比 ② 更隐蔽：语料下限还绿着，扫描器看上去健康得很。
//
// findings G-07 实测：三条最吃重的 ratchet 在**散文**里声称做过变异实证
// （'Every lock here has been mutation-verified'、'变异实证（2026-08-18，开发期手工
// 做过一轮）'、'变异实证（写入时验证过）'），但仓里没有一条今天还能复跑的 fixture。
// 散文不是证据。G-07 还给出了具体证伪方式：把 rfc284 的 SPAWN_PATTERNS 改成匹配不到
// 任何东西、再清空 ALLOWLIST，整个 suite 照绿——那次证伪现在会红。
//
// 规则
// ----
// 凡「扫语料 **且** 断言不存在」的守卫，必须至少有一条**负 fixture**：把伪造的输入
// 喂给某个决定过程、且**完全不碰真实语料**的断言。
//
// 只断言**存在**的守卫（`expect(sites.length).toBeGreaterThanOrEqual(4)`）不在管辖
// 范围内——它们自带证明：扫描一失效就掉到 0、当场转红。判据窄一点、但每条都必要，
// 比宽而掺水更耐用；后者会让豁免账本慢慢变成停车场。
//
// 判据与账本共用 `census.ts` 的单一实现，理由同 T13。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  assertsAbsence,
  guardTestFiles,
  isCorpusScanner,
  negativeFixtureAssertions,
  sourceUnit,
} from './census'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')

interface ManifestGuard {
  readonly id: string
  readonly file: string
  readonly corpusScanner: boolean
  readonly assertsAbsence: boolean
  readonly negativeFixture: boolean
}

const MANIFEST = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'architecture', 'guard-manifest.json'), 'utf8'),
) as { readonly guards: readonly ManifestGuard[] }

/**
 * 尚未配负 fixture 的「扫语料 + 断言不存在」守卫。**每条必须写清为什么、哪一波清偿**。
 *
 * 空表是**目标态**：RFC-317 B2-b 把当时全部 34 个受管守卫一次性补齐（其中 22 个是
 * 把内联判据提到模块顶层 / 抽成纯函数之后才有得喂——判据散在 test 体里，fixture 就
 * 只能证明自己那份拷贝还活着）。往这里加一行，等于承认新增了一条「matcher 停止工作
 * 也不会红」的守卫。
 */
const NO_FIXTURE_YET: Readonly<Record<string, { why: string; removeWhen: string }>> = {}

interface Scanned {
  readonly file: string
  readonly scanner: boolean
  readonly absence: boolean
  readonly fixtures: readonly string[]
}

const SCANNED: readonly Scanned[] = guardTestFiles(REPO_ROOT).map((rel) => {
  const unit = sourceUnit(rel, readFileSync(resolve(REPO_ROOT, rel), 'utf8'))
  return {
    file: rel,
    scanner: isCorpusScanner(unit),
    absence: assertsAbsence(unit),
    fixtures: negativeFixtureAssertions(unit),
  }
})

const GOVERNED = SCANNED.filter((row) => row.scanner && row.absence)

describe('RFC-317 T14 —— 断言「不存在」的扫语料守卫必须配负 fixture', () => {
  test('语料非空：受管集合本身不能扫成空（扫成 0 时本文件零预言力）', () => {
    expect(SCANNED.length).toBeGreaterThanOrEqual(100)
    expect(GOVERNED.length).toBeGreaterThanOrEqual(30)
  })

  test('每个受管守卫都至少有一条负 fixture（否则 matcher 停止工作也不会红）', () => {
    const offenders = GOVERNED.filter(
      (row) => row.fixtures.length === 0 && NO_FIXTURE_YET[row.file] === undefined,
    ).map((row) => row.file)
    expect(
      offenders,
      '这些守卫扫语料、断言「零违规」，却没有任何一条断言证明它的 matcher 还咬得动。' +
        '加一条：把伪造的违规喂给**扫描用的同一份判据**并断言它报。' +
        '判据内联在 test 体里喂不进去时，先把它提到模块顶层 / 抽成纯函数——' +
        '各留一份拷贝的话，fixture 证明的只是拷贝还活着',
    ).toEqual([])
  })

  test('豁免无过期条目（守卫没了 / 已补 fixture / 已不受管 ⇒ 删掉这一行）', () => {
    const byFile = new Map(SCANNED.map((row) => [row.file, row]))
    const stale: string[] = []
    for (const file of Object.keys(NO_FIXTURE_YET)) {
      const row = byFile.get(file)
      if (row === undefined) stale.push(`${file}（守卫已不存在）`)
      else if (!row.scanner) stale.push(`${file}（已不再扫语料，豁免应删除）`)
      else if (!row.absence) stale.push(`${file}（已不再断言「不存在」，豁免应删除）`)
      else if (row.fixtures.length > 0) stale.push(`${file}（已补上负 fixture，豁免应删除）`)
    }
    expect(stale, '豁免只能缩、不能涨；过期条目必须删').toEqual([])
  })

  test('每条豁免都写清理由与**具名**清偿波次（不接受「以后再说」）', () => {
    const bad = Object.entries(NO_FIXTURE_YET)
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

describe('RFC-317 T14 —— 受管面与 fixture 有无两向钉死进 guard-manifest.json', () => {
  const manifestByFile = new Map(MANIFEST.guards.map((guard) => [guard.file, guard]))

  test('「谁在断言不存在」与账本 assertsAbsence 逐条相等', () => {
    const onDisk = SCANNED.filter((row) => row.absence)
      .map((row) => row.file)
      .sort()
    const inLedger = MANIFEST.guards
      .filter((guard) => guard.assertsAbsence)
      .map((guard) => guard.file)
      .sort()
    expect(
      inLedger,
      '守卫从「断言不存在」变成「只断言存在」（或反之）时必须同步账本——' +
        'assertsAbsence 决定了它要不要受负 fixture 约束',
    ).toEqual(onDisk)
  })

  test('「谁有负 fixture」与账本 negativeFixture 逐条相等（fixture 被删就红）', () => {
    const drift: string[] = []
    for (const row of SCANNED) {
      const guard = manifestByFile.get(row.file)
      if (guard === undefined) {
        drift.push(`${row.file}: 不在账本里`)
        continue
      }
      const onDisk = row.fixtures.length > 0
      if (guard.negativeFixture !== onDisk) {
        drift.push(`${row.file}: 账本 ${String(guard.negativeFixture)} vs 磁盘 ${String(onDisk)}`)
      }
    }
    expect(
      drift,
      '负 fixture 被删 / 新增却没进账本。**删掉一条 fixture 必须是一次有记录的决定**',
    ).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// R11 自变异：判据自己必须有牙齿（T21）
// ---------------------------------------------------------------------------
//
// 下面每条 fixture 都对应本判据**实际犯过**的一次错。写这套判据用了四版，前三版
// 各自以不同方式判错，而且两个方向的错都出现过：
//   - 判**紧**了：把合格的 fixture 判成不合格（matcher 藏在局部 helper / describe
//     作用域 / `Object.fromEntries` 外壳下）。这个方向会逼着后来的人把代码写成判据
//     认得的样子，本末倒置。
//   - 判**松**了：把 `expect(offenders).toEqual([])` 这种彻头彻尾的**规则**断言记成
//     「有负 fixture」（因为 `offenders` 的初始化式里有一段「像源码」的字面量）。
//     这个方向更坏——缺 fixture 的守卫凭空达标，判据自己成了假绿源。
// 两个方向都留在下面，任何一版回归都会当场红。

interface Fixture {
  readonly name: string
  readonly source: string
  readonly fixtures: number
  readonly absence: boolean
}

const FIXTURES: readonly Fixture[] = [
  {
    name: '把伪造源码喂给顶层正则 ⇒ 是负 fixture',
    source:
      "const RE = /Bun\\.spawn/\ntest('x', () => {\n  expect(RE.test('Bun.spawn({ cmd })')).toBe(true)\n})\n",
    fixtures: 1,
    absence: false,
  },
  {
    name: '判松了会怎样：expect(offenders).toEqual([]) 不是负 fixture（offenders 源自语料）',
    source:
      "const files = readdirSync('/src')\n" +
      "test('x', () => {\n" +
      "  const offenders = files.filter((f) => readFileSync(f).includes('function describeError('))\n" +
      '  expect(offenders).toEqual([])\n' +
      '})\n',
    fixtures: 0,
    absence: true,
  },
  {
    name: '语料传播要跑到不动点：files → offenders → filtered 全程算语料',
    source:
      "const files = readdirSync('/src')\n" +
      "test('x', () => {\n" +
      "  const hits = files.map((f) => readFileSync(f))\n" +
      "  const filtered = hits.filter((t) => t.includes('const x = 1'))\n" +
      '  expect(filtered).toEqual([])\n' +
      '})\n',
    fixtures: 0,
    absence: true,
  },
  {
    name: '判紧了会怎样：fixture 声明在 describe 作用域、断言在 test 里 ⇒ 仍算',
    source:
      "describe('d', () => {\n" +
      "  const fabricated = 'const a = spawn(bin)\\n'\n" +
      "  test('x', () => {\n" +
      '    expect(detect(fabricated)).toBe(true)\n' +
      '  })\n' +
      '})\n',
    fixtures: 1,
    absence: false,
  },
  {
    name: '判紧了会怎样：for…of 循环变量绑定内联字面量数组 ⇒ 仍算',
    source:
      "test('x', () => {\n" +
      "  for (const sample of ['const a = spawn(bin)', 'Bun.spawn({ cmd })']) {\n" +
      '    expect(detect(sample)).toBe(true)\n' +
      '  }\n' +
      '})\n',
    fixtures: 1,
    absence: false,
  },
  {
    name: '判紧了会怎样：matcher 藏在外壳下（Object.fromEntries）⇒ 仍算',
    source:
      "test('x', () => {\n" +
      "  const parsed = parse('const plain = \\'overview\\'\\n')\n" +
      "  expect(Object.fromEntries(parsed)).toMatchObject({ plain: 'overview' })\n" +
      '})\n',
    fixtures: 1,
    absence: false,
  },
  {
    name: '伪造的**文件名**输入也算（判据主体是文件名时，fixture 喂的就是文件名）',
    source:
      "test('x', () => {\n" +
      "  expect(PATTERN.test('rfc294-architecture-preflight.test.ts')).toBe(true)\n" +
      '})\n',
    fixtures: 1,
    absence: false,
  },
  {
    name: '路径字面量不算伪造源码（否则「读真实树里某个文件」会被记成 fixture）',
    source:
      "test('x', () => {\n" +
      "  expect(existsSync(resolve(REPO, 'packages/shared/src/codeHost/triggerContext.ts'))).toBe(false)\n" +
      '})\n',
    fixtures: 0,
    absence: false,
  },
  {
    name: 'toEqual([]) / toHaveLength(0) / toBe(0) / not.toMatch 都算「断言不存在」',
    source:
      "const files = readdirSync('/src')\n" +
      "test('x', () => {\n" +
      '  expect(files.filter(bad)).toHaveLength(0)\n' +
      '})\n',
    fixtures: 0,
    absence: true,
  },
  {
    name: '只断言存在（>= N）不算「断言不存在」——这类守卫自带证明，不该被要求配 fixture',
    source:
      "const files = readdirSync('/src')\n" +
      "test('x', () => {\n" +
      '  expect(files.length).toBeGreaterThanOrEqual(4)\n' +
      '})\n',
    fixtures: 0,
    absence: false,
  },
]

describe('RFC-317 T21 —— 判据自变异：把 fixture 喂回同一份判据', () => {
  test('fixture 语料非空（fixture 表被清空时本 describe 零预言力）', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(10)
  })

  for (const fixture of FIXTURES) {
    test(`negativeFixtureAssertions / assertsAbsence：${fixture.name}`, () => {
      const unit = sourceUnit('probe.test.ts', fixture.source)
      expect(
        negativeFixtureAssertions(unit).length,
        `${fixture.name} —— 负 fixture 条数`,
      ).toBe(fixture.fixtures)
      expect(assertsAbsence(unit), `${fixture.name} —— 是否断言「不存在」`).toBe(fixture.absence)
    })
  }
})
