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

/**
 * 用户可见的错误码 = 真正被 `throw new XxxError(...)` 抛出的那些。
 *
 * 三种引号都认（实现门 r2 实测：原来只认单引号，反引号模板串
 * `` new ConflictError(`intent-x`, …) `` 即使写在清单内的文件里也完全抓不到，
 * 于是「精确清单」对**新增**的隐形码毫无预言力）。
 */
function thrownCodes(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/new\s+\w*Error\(\s*\n?\s*['"`](intent-[a-z0-9-]+)['"`]/g)].map(
      (m) => m[1]!,
    ),
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

  // RFC-355 T10 / 实现门 r2：apply 面**用户可见错误码的精确清单**。
  //
  // 立项时 proposal §2 写的「共有 15 条」把 `log.warn` 标签和抛出的错误码混在一起数了。
  // 第一版清单又只手挑了 7 个文件——实现门第二路实测：在 `application/resolveChangeset.ts`
  // 里新增一个全新错误码**照样全绿**，而那个文件明明在 apply 路径上（把存下来的 changeset
  // 解成 ops），它自己就带着 9 个 `intent-*` 码。所以那一版的标题写的是「apply 面」，
  // 实际锁的是「这 7 个文件面」。
  //
  // 现在的 `APPLY_SURFACE` 是真正的 apply 路径：两个 provider 编排 + SQL 持久化 +
  // 共享判据 + changeset 解析。实测在 current-source pin `c7c6fb81b` 与收工时都是
  // **同样的 36 条，零增删**——判据从两个 provider 搬进 domain / application 之后
  // 抛点换了文件，用户拿到的码一条没变。
  //
  // 这条断言比「两侧集合相等」强：两侧一起改也会红。新增一条是产品决定，必须显式改这张表。
  const APPLY_SURFACE_ERROR_CODES = [
    'intent-apply-failed-replay',
    'intent-apply-in-flight',
    'intent-apply-unsettled',
    'intent-baseline-stale',
    'intent-budget-exhausted',
    'intent-changeset-invalid',
    'intent-checkpoint-stale',
    'intent-current-action-invalid',
    'intent-current-action-stale',
    'intent-draft-hash-mismatch',
    'intent-draft-invalid',
    'intent-draft-not-found',
    'intent-draft-superseded',
    'intent-foreign-modify-forbidden',
    'intent-iteration-stale',
    'intent-mutation-conflict',
    'intent-name-conflict',
    'intent-op-canonical-invalid',
    'intent-ref-unknown',
    'intent-reservation-invalid',
    // 不是产品面的码：编排自身的不变量（plan 与 op 必须同序），迁位前后都以裸 `Error` 抛出。
    'intent-resource-plan-order-mismatch',
    'intent-retry-stale',
    'intent-secret-required',
    'intent-secret-value-forbidden',
    'intent-session-archived',
    'intent-session-not-found',
    'intent-slot-unknown',
    'intent-slot-value-invalid',
    'intent-target-not-mounted',
    'intent-turn-in-flight',
    'intent-turn-not-found',
    'intent-working-set-applying',
    'intent-working-set-not-failed',
    'intent-working-set-not-found',
    'intent-working-set-pending',
    'intent-working-set-stale',
  ] as const

  test('apply 面的用户可见错误码与精确清单逐条相等（增删都红）', () => {
    const surface = [
      sqlite,
      postgresql,
      read('modules', 'intent', 'infrastructure', 'intentSqlPersistence.ts'),
      read('modules', 'intent', 'domain', 'applyClaim.ts'),
      read('modules', 'intent', 'domain', 'storedChangeset.ts'),
      read('modules', 'intent', 'application', 'intentResourcePlan.ts'),
      read('modules', 'intent', 'application', 'applyCommitPlan.ts'),
      read('modules', 'intent', 'application', 'applyReplay.ts'),
      read('modules', 'intent', 'application', 'resolveChangeset.ts'),
    ].join('\n')
    expect(
      [...thrownCodes(surface)].sort(),
      'apply 面的用户可见错误码变了。这是产品面的 breaking change，不是重构的副产物——' +
        '要改先改这张表并说明为什么。',
    ).toEqual([...APPLY_SURFACE_ERROR_CODES].sort())
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

describe('RFC-355 T6 —— intent 深取 resource-catalog 内部实现的账本（只准缩，不准涨）', () => {
  // T6 之前这里是「必须为空」的断言，于是它在 T6 落地前一直红——**而红的主干是全员的**。
  // 改成账本逐条相等：**新增一条立刻红**（压力一点没丢），T6 逐条销账时把对应行删掉即可。
  // 形态与仓里既有的 exact-debt 账本一致（`architecture/commons-debt.json` 等）。
  //
  // 这些边全部是 RFC-317 R2 禁止的跨 context 内部 import：intent 的 apply 直接取
  // resource-catalog 的技能文件机制（路径解析 / 内容哈希 / 文件发布 / 版本提交 / boot 校验）。
  // T6 的做法是让 RC 出一个技能工件 participant，两个 provider 的 intent 都从那里取
  // ——形态复用 RFC-353 已验证过的 participant + bootstrap 装配。
  const DEEP_IMPORT_DEBT: Readonly<Record<string, readonly string[]>> = {
    // T6 已销账：`postgresqlIntentApplyArtifactOwners.ts` 整份迁进 resource-catalog
    // （它实现的是 RC 的端口、用的是 RC 自己的机制，见 T0 结论），文件在 intent 下已不存在；
    // 两个 ArtifactLifecycle 的运行时深取改为经 `ports/skillArtifactCompensation` 注入。
    //
    // **剩下这 2 条是纯类型 import**：`PostgresqlIntentApplyArtifact` /
    // `PostgresqlIntentApplyResourceSession` 是 RC 定义的工件与会话形状，intent 的 PostgreSQL
    // 适配器按它们标注参数。把它们搬进 public 会让 `Postgresql*` 命名的 provider 类型出现在
    // 公共面上（RFC-349 的 provider-cutover 账本「只能缩不能涨」正是防这件事），
    // 所以按既有口径作为**已入账的纯类型边**留着，随 RC 自己的下一波收口。
    'postgresqlIntentApplyArtifactLifecycle.ts': [
      '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants',
    ],
    'postgresqlIntentApplyOperations.ts': [
      '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourceParticipants',
    ],
    'sqliteIntentApplyArtifactLifecycle.ts': [],
    'sqliteIntentApplyOperations.ts': [],
  }

  test.each(Object.keys(DEEP_IMPORT_DEBT))('%s 的深取与账本逐条相等', (file: string) => {
    let source: string
    try {
      source = read('modules', 'intent', 'infrastructure', file)
    } catch {
      // 文件已被 T6 删除即视为全部销账。
      expect(DEEP_IMPORT_DEBT[file]).toBeDefined()
      return
    }
    const deep = [
      ...new Set(
        [
          ...source.matchAll(
            /@\/modules\/resource-catalog\/(?:infrastructure|application|domain)[^'"]*/g,
          ),
        ].map((m) => m[0]),
      ),
    ].sort()
    expect(
      deep,
      'RFC-317 R2：跨 context 只能经 exact `public/*`。**多**了要么改走 RC offered participant、' +
        '要么连同理由加进本账本；**少**了说明 T6 销账了——把对应行一并删掉，' +
        '不删的话差额会变成下一个人的免费槽位。',
    ).toEqual([...DEEP_IMPORT_DEBT[file]!].sort())
  })
})
