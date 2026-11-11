// RFC-479 —— 治理补洞（RFC-294 S11）：减速带上限 = 实测、public 合同两项计数与 composition 控制流入带。
//
// 锁三件事（「低于上限即红」本身的单元用例在 rfc376-structural-guards 的 checkCounts 一组）：
// ① composition 控制流（review-2026-11-09 F13 口径）：fixture 变异——行首 if / for / for-in / for-of / while / switch / try / throw 各计
//    一行；`} else if`、`do … while`、模板字符串与注释里以这些词开头的行不计；非 composition/ 目录不计；只有声明的 composition 文件
//    给出空集（id 仍在）。真实语料：与 F13 的行首正则逐模块对账，正则多出的行只能落在字符串 / 模板 / 注释里。
// ② public 合同两项：fixture 变异——无人取用的 public 导出计入、另一模块的生产文件取用后不计入；public 文件的导出签名带禁用类型
//    → 偏差多一条。
// ③ 登记：`architecture/counts.json` 里两项 public 合同计数与每个有 composition/ 的模块的控制流计数都在，reason 写明口径。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { BACKEND_PREFIX, compositionControlFlowSets, createGateCorpus } from './rfc294Gates'
import { corpusPublicContract, publicContractGateSets } from './architectureReport'

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const MODULES = BACKEND_PREFIX + 'modules/'
const flow = (files: Record<string, string>) =>
  compositionControlFlowSets(
    createGateCorpus(Object.entries(files).map(([path, text]) => sourceUnit(path, text))),
  )

describe('RFC-479 —— composition 控制流（F13 口径）', () => {
  test('行首的分支、循环、try 与 throw 各计一行，带行号与种类', () => {
    const path = MODULES + 'alpha/composition/wire.ts'
    const sets = flow({
      [path]: [
        'export function wire(input: number[]): number {', // 1
        '  if (input.length === 0) return 0', // 2
        '  for (let i = 0; i < 1; i++) {}', // 3
        '  for (const x in input) {}', // 4
        '  for (const x of input) {}', // 5
        '  while (input.length > 9) input.pop()', // 6
        '  switch (input[0]) {', // 7
        '    default:', // 8
        '  }', // 9
        '  try {', // 10
        '    return 1', // 11
        '  } catch {', // 12
        "    throw new Error('x')", // 13
        '  }', // 14
        '}', // 15
      ].join('\n'),
    })
    expect(sets).toEqual({
      'composition-control-flow-alpha': [
        `${path}:10:branch`,
        `${path}:13:throw`,
        `${path}:2:branch`,
        `${path}:3:branch`,
        `${path}:4:branch`,
        `${path}:5:branch`,
        `${path}:6:branch`,
        `${path}:7:branch`,
      ],
    })
  })

  test('负对照：else if、do … while、同一行的语句、字符串 / 模板 / 注释里的同名词都不计', () => {
    const path = MODULES + 'alpha/composition/quiet.ts'
    const sets = flow({
      [path]: [
        'export function quiet(flag: boolean): string {', // 1
        '  if (flag) {', // 2  counted: the one real line-start statement
        '  } else if (!flag) {', // 3
        '  }', // 4
        '  do {} while (flag)', // 5
        '  const a = 1; if (a) {}', // 6  not at line start
        '  const text = `', // 7
        'if this were code it would count', // 8  inside a template literal
        'throw it away', // 9
        '`', // 10
        "  const s = 'if (x) {}'", // 11
        '  // if (x) throw y', // 12
        '  /*', // 13
        '  for (;;) {}', // 14 inside a block comment
        '  */', // 15
        '  return text + s', // 16
        '}', // 17
      ].join('\n'),
    })
    expect(sets).toEqual({ 'composition-control-flow-alpha': [`${path}:2:branch`] })
  })

  test('只认 modules/<module>/composition/；声明文件给空集；每个模块各一项', () => {
    const sets = flow({
      [MODULES + 'alpha/composition/types.ts']: 'export interface Alpha { readonly x: number }\n',
      [MODULES + 'alpha/infrastructure/run.ts']: 'export function run() {\n  if (1) throw 1\n}\n',
      [MODULES + 'alpha/composition.ts']: 'export function root() {\n  if (1) throw 1\n}\n',
      [MODULES + 'beta/composition/a/b.ts']: 'export function b() {\n  throw new Error()\n}\n',
      [BACKEND_PREFIX + 'services/legacy.ts']: 'export function l() {\n  if (1) throw 1\n}\n',
    })
    expect(sets).toEqual({
      'composition-control-flow-alpha': [],
      'composition-control-flow-beta': [MODULES + 'beta/composition/a/b.ts:2:throw'],
    })
  })

  test('F13 对账的判据自测：正则多算的模板行被认出，正则漏掉的语法树计数被认出', () => {
    const path = MODULES + 'alpha/composition/copy.ts'
    const text = [
      'export function copy(flag: boolean): string {', // 1
      '  if (flag) return ``', // 2  counted by both
      '  return `', // 3
      'if the template says so', // 4  regex-only, inside a template literal
      '`', // 5
      '}', // 6
    ].join('\n')
    const unit = sourceUnit(path, text)
    const sets = compositionControlFlowSets(createGateCorpus([unit]))
    expect(reconcileWithF13(unit, sets)).toEqual({ stringOrCommentOnly: [4], mismatches: [] })
    // Mutation: a site the regex cannot see (or a regex line outside any literal) is a mismatch.
    expect(
      reconcileWithF13(unit, { 'composition-control-flow-alpha': [`${path}:6:branch`] }),
    ).toEqual({
      stringOrCommentOnly: [4],
      mismatches: [`${path}:2 regex-only`, `${path}:6 ast-only`],
    })
  })

  test('真实语料：与 F13 的行首正则逐模块对账，正则多出的行只落在字符串 / 模板 / 注释里', () => {
    const units = backendUnits(ROOT)
    expect(units.length).toBeGreaterThanOrEqual(2000)
    const sets = compositionControlFlowSets(createGateCorpus(units))
    expect(Object.keys(sets).length).toBeGreaterThanOrEqual(19)
    const mismatches = units
      .filter((unit) =>
        /^packages\/backend\/src\/modules\/[a-z0-9-]+\/composition\//.test(unit.path),
      )
      .flatMap((unit) => reconcileWithF13(unit, sets).mismatches)
    expect(mismatches).toEqual([])
  }, 60_000)
})

describe('RFC-479 —— public 合同两项计数', () => {
  const contract = (files: Record<string, string>) =>
    publicContractGateSets(
      corpusPublicContract(
        createGateCorpus(Object.entries(files).map(([path, text]) => sourceUnit(path, text))),
      ),
    )
  const PUBLIC = MODULES + 'memory/public/queries.ts'
  const SOURCE = [
    'export function readMemoryCount(): number {',
    '  return 1',
    '}',
    'export function unreadMemoryCount(): number {',
    '  return 2',
    '}',
    '',
  ].join('\n')

  test('没有任何模块外读者的 public 导出计入；另一模块的生产文件取用后不计入', () => {
    const consumer = MODULES + 'intent/application/useMemory.ts'
    const consumed = contract({
      [PUBLIC]: SOURCE,
      [consumer]:
        "import { readMemoryCount } from '@/modules/memory/public/queries'\n" +
        'export const count = readMemoryCount()\n',
    })
    // RFC-480 split the count per context; the fixture's public file is memory's.
    expect(consumed['unconsumed-public-symbols-memory']).toEqual([
      'public:memory:queries:unreadMemoryCount',
    ])
    // Mutation: drop the consumer and both exports are unconsumed.
    expect(contract({ [PUBLIC]: SOURCE })['unconsumed-public-symbols-memory']).toEqual([
      'public:memory:queries:readMemoryCount',
      'public:memory:queries:unreadMemoryCount',
    ])
  })

  test('public 导出签名带禁用类型 → 偏差多一条（负对照：普通签名没有偏差）', () => {
    expect(contract({ [PUBLIC]: SOURCE })['public-surface-deviations']).toEqual([])
    const tainted = contract({
      [PUBLIC]:
        SOURCE + 'export function readMemoryBuffer(): Buffer {\n  return Buffer.alloc(0)\n}\n',
    })['public-surface-deviations']
    expect(tainted).toHaveLength(1)
    expect(tainted?.[0]).toContain('readMemoryBuffer')
  })
})

describe('RFC-479 —— 登记', () => {
  test('counts.json 登记两项 public 合同计数与每个有 composition/ 的模块，reason 写明口径', () => {
    const counts = (
      JSON.parse(readFileSync(resolve(ROOT, 'architecture/counts.json'), 'utf8')) as {
        counts: Record<string, { max: number; reason: string }>
      }
    ).counts
    // RFC-480: the unconsumed count is one entry per context with a public surface, each with the same wording.
    const unconsumed = Object.keys(counts).filter((id) =>
      id.startsWith('unconsumed-public-symbols-'),
    )
    expect(unconsumed.length).toBeGreaterThanOrEqual(19)
    for (const id of unconsumed)
      expect([id, counts[id]!.reason.includes('unconsumedPublicSymbols')]).toEqual([id, true])
    expect(counts['public-surface-deviations']?.reason).toContain('publicSurfaceDeviations')
    const ids = Object.keys(counts).filter((id) => id.startsWith('composition-control-flow-'))
    expect(ids.length).toBeGreaterThanOrEqual(19)
    for (const id of ids) {
      expect([id, counts[id]!.reason.includes('F13'), counts[id]!.reason.includes('S10')]).toEqual([
        id,
        true,
        true,
      ])
    }
  })
})

const F13_LINE = /^\s*(?:(?:if|for|while|switch|try)\b|throw\b)/

/**
 * Reconcile one composition unit's syntax-tree sites with review F13's line-start regex. A line only the regex counts must
 * start inside a string, template or comment (`stringOrCommentOnly`); anything else on either side is a mismatch.
 */
function reconcileWithF13(
  unit: SourceUnit,
  sets: Record<string, string[]>,
): { stringOrCommentOnly: number[]; mismatches: string[] } {
  const module = /^packages\/backend\/src\/modules\/([a-z0-9-]+)\/composition\//.exec(
    unit.path,
  )?.[1]
  const counted = new Set(
    (module === undefined ? [] : (sets[`composition-control-flow-${module}`] ?? []))
      .filter((site) => site.startsWith(unit.path + ':'))
      .map((site) => Number(site.slice(unit.path.length + 1).split(':')[0])),
  )
  const literalOrComment = literalAndCommentRanges(unit.source)
  const stringOrCommentOnly: number[] = []
  const mismatches: string[] = []
  let offset = 0
  for (const [index, line] of unit.source.text.split('\n').entries()) {
    const lineNumber = index + 1
    const first = offset + (line.length - line.trimStart().length)
    const byRegex = F13_LINE.test(line)
    if (byRegex && !counted.has(lineNumber)) {
      if (inRanges(first, literalOrComment)) stringOrCommentOnly.push(lineNumber)
      else mismatches.push(`${unit.path}:${lineNumber} regex-only`)
    }
    if (counted.has(lineNumber) && !byRegex) mismatches.push(`${unit.path}:${lineNumber} ast-only`)
    offset += line.length + 1
  }
  return { stringOrCommentOnly, mismatches }
}

function literalAndCommentRanges(source: ts.SourceFile): (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = []
  const seen = new Set<number>()
  const comments = (list: readonly ts.CommentRange[] | undefined) => {
    for (const range of list ?? []) {
      if (seen.has(range.pos)) continue
      seen.add(range.pos)
      ranges.push([range.pos, range.end])
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      ranges.push([node.getStart(source), node.end])
    comments(ts.getLeadingCommentRanges(source.text, node.pos))
    comments(ts.getTrailingCommentRanges(source.text, node.end))
    ts.forEachChild(node, visit)
  }
  visit(source)
  return ranges
}

function inRanges(position: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => position >= start && position < end)
}
