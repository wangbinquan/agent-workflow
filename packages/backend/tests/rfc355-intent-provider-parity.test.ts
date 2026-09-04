// RFC-355 T1（RFC-294 W4-E4a）—— intent apply 双 provider 平价的**先红**预言。
//
// 这两条断言存在的理由：`intent-apply` 的编排今天在仓里有**逐行并行的两份**——
// `sqliteIntentApplyOperations.ts`(842 行) 与 `postgresqlIntentApplyOperations.ts`(684 行)。
// 两份的 claim 判据序列逐条对应、连 15 行的 session 串行锁都各写一遍，任何一次业务变更都要改两遍。
// 「改两遍」正是 RFC-352 与 RFC-353 各自开局撞到的漂移源；本文件把「已经漂了多少」变成机器判据。
//
// **本文件在 T1 落地时必须是红的**（诊断词汇已分叉、纯判据被抄了两份），由 T2～T5 转绿。
// 转绿之后它继续守着「不许再抄第二份」。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', 'src')
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), 'utf-8')

const SQLITE_APPLY = [
  'modules',
  'intent',
  'infrastructure',
  'sqliteIntentApplyOperations.ts',
] as const
const PG_APPLY = [
  'modules',
  'intent',
  'infrastructure',
  'postgresqlIntentApplyOperations.ts',
] as const

/** 文件里出现的所有 kebab-case 诊断标识（错误码与 log 标签共用同一套词汇）。 */
function diagnosticTokens(source: string): Set<string> {
  return new Set([...source.matchAll(/'(intent-[a-z0-9-]+)'/g)].map((m) => m[1]!))
}

/** 用户可见的错误码 = 真正被 `throw new XxxError(...)` 抛出的那些。 */
function thrownCodes(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/new\s+\w*Error\(\s*\n?\s*'(intent-[a-z0-9-]+)'/g)].map((m) => m[1]!),
  )
}

describe('RFC-355 T1 —— 双 provider 的诊断词汇必须一致', () => {
  const sqlite = read(...SQLITE_APPLY)
  const postgresql = read(...PG_APPLY)

  test('用户可见的错误码两侧集合相等，且词汇由共享判据持有', () => {
    // 判据搬进 domain/application 之后，provider 文件里**本来就不该**再留多少错误码——
    // 所以这里不能再要求「两侧各 ≥ 10 条」（那是改造前的形态）。真正的断言是两件事：
    //   ① 两个 provider 剩下的错误码集合相等（谁多一条谁就在悄悄分叉）；
    //   ② 词汇的**主体**在共享判据文件里，否则本条会退化成「两个空集也算过」。
    expect([...thrownCodes(sqlite)].sort()).toEqual([...thrownCodes(postgresql)].sort())

    const shared = [
      read('modules', 'intent', 'domain', 'applyClaim.ts'),
      read('modules', 'intent', 'domain', 'storedChangeset.ts'),
      read('modules', 'intent', 'application', 'intentResourcePlan.ts'),
    ].join('\n')
    expect([...thrownCodes(shared)].length).toBeGreaterThanOrEqual(6)
  })

  test('诊断标签（含 log.warn）两侧集合相等——今天红：四条各只在一侧', () => {
    const s = diagnosticTokens(sqlite)
    const p = diagnosticTokens(postgresql)
    const onlySqlite = [...s].filter((t) => !p.has(t)).sort()
    const onlyPostgresql = [...p].filter((t) => !s.has(t)).sort()
    expect(
      { onlySqlite, onlyPostgresql },
      '同一类失败在两种部署上被记成不同的词，运维 grep 同一件事拿到的结果不同。' +
        '两份拷贝正在分头演进——合并成一份编排后本条自然转绿。',
    ).toEqual({ onlySqlite: [], onlyPostgresql: [] })
  })
})

describe('RFC-355 T1 —— 纯判据不许被抄成两份', () => {
  const sqlite = read(...SQLITE_APPLY)
  const postgresql = read(...PG_APPLY)

  test('`intentResourcePlanOf` 只应存在于一处——今天红：两个 provider 各一份、逐字节相同', () => {
    const holders: string[] = []
    if (/function intentResourcePlanOf\(/.test(sqlite))
      holders.push('sqliteIntentApplyOperations.ts')
    if (/function intentResourcePlanOf\(/.test(postgresql)) {
      holders.push('postgresqlIntentApplyOperations.ts')
    }
    expect(
      holders,
      '`intentResourcePlanOf` 是 44 行纯判据（无 DB、无 provider 相关），两侧逐字节相同、' +
        '只有形参名 `op` vs `operation` 不同。它属于 `modules/intent/domain`，不属于任何 provider。',
    ).toEqual([])
  })

  test('session 串行锁只应存在于一处——今天红：同一算法各写一遍', () => {
    const holders: string[] = []
    if (/const applyLocks|function withSessionApplyLock/.test(sqlite)) holders.push('sqlite')
    if (/const locks = new Map|function withSessionLock/.test(postgresql))
      holders.push('postgresql')
    expect(
      holders,
      'SQLite 的 `withSessionApplyLock` 与 PostgreSQL 的 `withSessionLock` 是同一个 15 行算法。' +
        '它属于 `modules/intent/application`，与 provider 无关。',
    ).toEqual([])
  })

  test('claim 段的判据不应在两个 provider 里各写一遍', () => {
    // 判据序列：session 归属 → clientMutationId 重放 → active → inFlightTurnId。
    const shape =
      /intent-session-not-found[\s\S]{0,2000}clientMutationId[\s\S]{0,2000}intent-session-archived[\s\S]{0,600}intent-turn-in-flight/
    const holders: string[] = []
    if (shape.test(sqlite)) holders.push('sqlite')
    if (shape.test(postgresql)) holders.push('postgresql')
    expect(
      holders,
      'claim 的判据序列在两个 provider 文件里逐条对应地各写了一遍；' +
        '判据属于 domain，事务边界才属于 provider。',
    ).toEqual([])
  })
})

describe('RFC-355 T1 —— intent 不得深取 resource-catalog 的内部实现', () => {
  test.each([
    'postgresqlIntentApplyArtifactOwners.ts',
    'postgresqlIntentApplyArtifactLifecycle.ts',
    'sqliteIntentApplyArtifactLifecycle.ts',
    'postgresqlIntentApplyOperations.ts',
    'sqliteIntentApplyOperations.ts',
  ])('%s 不 import resource-catalog 的 infrastructure/application/domain', (file: string) => {
    let source: string
    try {
      source = read('modules', 'intent', 'infrastructure', file)
    } catch {
      // 文件已被本 RFC 删除（例如 T6 删掉 PostgreSQL 侧的工件拷贝）即视为达成。
      return
    }
    const deep = [
      ...source.matchAll(
        /@\/modules\/resource-catalog\/(infrastructure|application|domain)[^'"]*/g,
      ),
    ].map((m) => m[0])
    expect(
      [...new Set(deep)].sort(),
      'RFC-317 R2：跨 context 只能经 exact `public/*`。这些深取应改为 RC offered participant，' +
        '由 bootstrap 注入（形态见 RFC-353）。',
    ).toEqual([])
  })
})
