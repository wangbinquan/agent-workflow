// RFC-546 — 模块级可变单例的进程级例外清单（RFC-294 S12 第 4 项；design §14 “不计登记的进程级例外”）。
//
// 为什么存在：架构报告的模块级可变单例判据（`mutableSingletons`：顶层 `let`，与写模块级绑定的 set / bind / reset / register / configure /
// install 导出函数）此前没有守卫钉住——新增一条不会红，删掉一条也不会提醒更新口径。RFC-546 把判据的结果分进
// `architecture/module-singleton-exceptions.json` 的两份清单：
// - exceptions：进程级事实（主机探测、一次初始化、不变数据的备忘、唯一名计数、只告警一次、进程唯一的输出端、只能按身份记的表、动态作用域的
//   缓存），作为例外保留，design §14 不计它们；
// - pending：凭据 / 访问相邻的服务状态（WebSocket 的三处登记、遗留测试库标记、技能启动复核），随延后的 ws/ 与 legacy 一族迁进组合根构造的
//   实例，只减不增。
// 锁四件事：
// ① 判据在真实语料上的结果 = 两份清单之和，两份互不重叠：清单外的新单例红，清单里的条目在源码里消失也红（提示把它删掉）。语料下限 3,000。
// ② 每条有判据给的种类、例外的类别或待迁的一族，以及理由。
// ③ 两份的条数不高于本 RFC 落地时的值（只减不增；提高要随 RFC 改这里的上限）。
// ④ design §14 的这一行写着修订后的口径并指向清单。
// 负对照只喂伪造的源码与清单，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mutableSingletons, type DefinitionSite } from './architectureReport'
import { backendUnits, sourceUnit } from './census'

const REPO = resolve(import.meta.dir, '../../../..')
const LEDGER_PATH = 'architecture/module-singleton-exceptions.json'
const DESIGN = 'design/RFC-294-backend-layered-target-architecture/design.md'
const CATEGORIES = new Set([
  'host-probe',
  'runtime-initialisation',
  'immutable-memo',
  'unique-counter',
  'warn-once',
  'process-output',
  'identity-keyed',
  'dynamic-scope-cache',
])
const FAMILIES = new Set(['legacy-test-database', 'skill-boot-reverify', 'websocket-registry'])
const KINDS = new Set(['top-level-let', 'exported-state-mutator'])
/** The list sizes when RFC-546 landed. Lower them as entries go; raising either needs an RFC. */
const MAX_EXCEPTIONS = 28
const MAX_PENDING = 9
const CORPUS_TIMEOUT = 60_000

interface LedgerEntry {
  readonly file: string
  readonly symbol: string
  readonly kind: string
  readonly category?: string
  readonly family?: string
  readonly reason?: string
}
interface Ledger {
  readonly exceptions: readonly LedgerEntry[]
  readonly pending: readonly LedgerEntry[]
}

const keyOf = (site: { readonly file: string; readonly symbol: string; readonly kind: string }) =>
  `${site.file}#${site.symbol}#${site.kind}`

type CensusSite = Pick<DefinitionSite, 'file' | 'symbol' | 'kind'>

/** What disagrees between a census and the ledger; empty when they agree. */
function ledgerFindings(census: readonly CensusSite[], ledger: Ledger): string[] {
  const findings = new Set<string>()
  const listed = new Set<string>()
  const lists = [
    ['exceptions', ledger.exceptions],
    ['pending', ledger.pending],
  ] as const
  for (const [list, entries] of lists) {
    for (const entry of entries) {
      const key = keyOf(entry)
      if (listed.has(key)) findings.add(`listed twice:${key}`)
      listed.add(key)
      if (!KINDS.has(entry.kind)) findings.add(`unknown kind:${key}`)
      if (typeof entry.reason !== 'string' || entry.reason.trim() === '')
        findings.add(`no reason:${key}`)
      if (list === 'exceptions' && !CATEGORIES.has(entry.category ?? ''))
        findings.add(`unknown category:${key}`)
      if (list === 'pending' && !FAMILIES.has(entry.family ?? ''))
        findings.add(`unknown family:${key}`)
    }
  }
  const found = new Set(census.map(keyOf))
  for (const key of found) if (!listed.has(key)) findings.add(`unlisted singleton:${key}`)
  for (const key of listed) if (!found.has(key)) findings.add(`stale entry:${key}`)
  return [...findings].sort()
}

const ledger = JSON.parse(readFileSync(resolve(REPO, LEDGER_PATH), 'utf8')) as Ledger

describe('RFC-546 —— 模块级可变单例的例外清单', () => {
  test(
    '判据在真实语料上的结果就是两份清单之和',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(ledgerFindings(mutableSingletons(units), ledger)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )

  test('每条有种类、类别或一族与理由；两份只减不增', () => {
    expect(ledgerFindings([...ledger.exceptions, ...ledger.pending], ledger)).toEqual([])
    expect(ledger.exceptions.length).toBeLessThanOrEqual(MAX_EXCEPTIONS)
    expect(ledger.pending.length).toBeLessThanOrEqual(MAX_PENDING)
  })

  test('design §14 的这一行写着修订后的口径并指向清单', () => {
    const row = readFileSync(resolve(REPO, DESIGN), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('| 模块级可变单例'))
    expect(row).toBeDefined()
    expect(row).toContain('不计登记的进程级例外')
    expect(row).toContain(LEDGER_PATH)
  })
})

describe('RFC-546 —— 负对照（伪造的源码与清单）', () => {
  const PATH = 'packages/backend/src/modules/alpha/infrastructure/state.ts'
  const census = mutableSingletons([
    sourceUnit(
      PATH,
      [
        'let counter = 0',
        'export function next(): number { return counter++ }',
        'export function resetCounterForTests(): void { counter = 0 }',
      ].join('\n'),
    ),
  ])
  const counter = { file: PATH, symbol: 'counter', kind: 'top-level-let' }
  const reset = { file: PATH, symbol: 'resetCounterForTests', kind: 'exported-state-mutator' }

  test('判据认出伪造源码里的两条', () => {
    expect(census.map(keyOf).sort()).toEqual([keyOf(counter), keyOf(reset)].sort())
  })

  test('清单外的新单例、过期的条目、重复与缺字段都报出来', () => {
    expect(ledgerFindings(census, { exceptions: [], pending: [] })).toEqual([
      `unlisted singleton:${keyOf(counter)}`,
      `unlisted singleton:${keyOf(reset)}`,
    ])
    const gone = { file: PATH, symbol: 'gone', kind: 'top-level-let' }
    expect(
      ledgerFindings(census, {
        exceptions: [
          { ...counter, category: 'unique-counter', reason: 'r' },
          { ...gone, category: 'unique-counter', reason: 'r' },
        ],
        pending: [{ ...reset, family: 'websocket-registry', reason: 'r' }],
      }),
    ).toEqual([`stale entry:${keyOf(gone)}`])
    expect(
      ledgerFindings(census, {
        exceptions: [
          { ...counter, category: 'unique-counter', reason: 'r' },
          { ...reset, category: 'not-a-category', reason: ' ' },
        ],
        pending: [{ ...counter, family: 'not-a-family', reason: 'r' }],
      }),
    ).toEqual([
      `listed twice:${keyOf(counter)}`,
      `no reason:${keyOf(reset)}`,
      `unknown category:${keyOf(reset)}`,
      `unknown family:${keyOf(counter)}`,
    ])
  })
})
