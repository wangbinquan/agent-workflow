// Why this test exists: RFC-349 added a second database provider, and the only
// thing that structurally forced the 216-adapter cohort to stay complete was the
// shared port interfaces — adding a METHOD breaks both providers' factories
// until each implements it. Adding a PROVIDER had no such forcing function.
//
// Measured 2026-09-03 on `1e5a47893`: appending a third member to
// `DatabaseProvider` and running `tsc -p packages/backend` produced **4 errors,
// all in `db/providerSchema.ts`**, all about the schema projection. Not one came
// from the 216 adapters, the 31 provider forks, the migration engine, the write
// matrix or the four parity guards. Two of those forks silently hand a third
// provider SQLite's behaviour, and both are the exact defect class this RFC spent
// the session fixing:
//   `schemaContract.ts` literalSql   — boolean DDL defaults render '1'/'0'
//   `maintenanceService.ts`          — classifyRetryable uses SQLite error codes
//
// So this file makes provider completeness a compile/test-time obligation:
//   1. one canonical provider list, derived — nobody hand-writes the union;
//   2. an exhaustive traits table — a new provider cannot be added without
//      answering every per-provider decision;
//   3. a ledger for the remaining `provider === '<literal>'` forks, each
//      classified, so a new fork names itself instead of defaulting to SQLite.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import { DATABASE_PROVIDERS } from '@/platform/persistence/schemaContract'
import { DATABASE_PROVIDER_TRAITS } from '@/platform/persistence/providerTraits'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const BACKEND_SRC = resolve(ROOT, 'packages', 'backend', 'src')

function walk(dir: string): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
      continue
    }
    if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

interface BackendSource {
  readonly path: string
  readonly text: string
}

// Read on demand, not at module scope: `src/` is ~1900 files / ~17 MiB, and four
// of the six tests below only need two or three named files. Eagerly slurping the
// tree made this file's I/O cost independent of what was actually asked for.
let sourcesCache: readonly BackendSource[] | null = null
function backendSources(): readonly BackendSource[] {
  return (sourcesCache ??= walk(BACKEND_SRC).map((path) => ({
    path: path.slice(ROOT.length + 1).replaceAll('\\', '/'),
    text: readFileSync(path, 'utf8'),
  })))
}

function backendSource(suffix: string): BackendSource {
  const full = resolve(ROOT, suffix)
  return { path: suffix, text: readFileSync(full, 'utf8') }
}

// The single place allowed to spell the union out: it derives from the tuple.
const CANONICAL_UNION_FILE = 'packages/backend/src/platform/persistence/schemaContract.ts'

// Every remaining place that still branches on a provider LITERAL. A fork is not
// automatically a bug — three of the shapes below are fenced by something
// stronger than a traits lookup — but an UNREGISTERED fork is, because it is a
// place a third provider silently inherits someone else's behaviour. Registering
// each one with its fence is what turns "31 forks somewhere" into a reviewable
// checklist a new provider can be walked through.
//
//   discriminated-union  the literal also narrows a provider-keyed option union,
//                        so a third provider cannot be constructed without adding
//                        its own variant — the CALLER fails to compile. Strongest
//                        fence here; do not "simplify" these into traits lookups.
//   projection-fenced    lives in db/providerSchema.ts, which indexes
//                        `TableProjection` by provider and therefore already
//                        fails to compile for an unknown provider.
//   embedded-question    asks "is this the embedded file store the daemon owns?".
//                        A new external-server provider answers "no" correctly.
//   migration-pair       RFC-349 V1 migrates exactly sqlite → postgresql. A third
//                        provider means a new source/target pair, i.e. new
//                        feature work, not a branch to widen.
//   boot-fence           the deliberate closed list that refuses to boot a
//                        provider nobody has adapted yet (see the test below).
const PROVIDER_FORK_LEDGER = {
  // RFC-359 AC-10 第二波：`cli/database.ts` 的条目退役。两处品牌分叉都换成了 traits ——
  // `--to` 先解析成 `DatabaseProvider` 再问 `migrationRole === 'target'`，
  // `db info` 的服务端版本兜底改读 `serverVersionFallback`。
  'cli/doctor.ts': { forks: 1, fence: 'fenced-dispatch' },
  // RFC-359 AC-10：`cli/migrate.ts` 的条目退役——要说的那句话在
  // `prepareDatabaseProviderForBoot`（白名单层、品牌已确定处）就定稿，CLI 只剩「拿来输出」。
  // 文件里残留的 `unhandledDatabaseProvider` 穷尽性围栏不计债（按形状豁免）。
  // cli/start.ts：RFC-359 W3-T16 后没有 provider 执行分支——会话装配按 DatabaseProvider 查表，
  // 运行时收窄走 platform/persistence 的 requireDatabaseProviderRuntime。
  // RFC-359 AC-10 第一波：`db/providerSchema.ts` 的条目退役。原来那处 fork 是
  // `concreteDatabaseColumn` 按 provider 在 `PgColumn` / `SQLiteColumn` 之间做类型判定，
  // 而它**全仓没有任何调用方**（只有自己的定义），所以处置是删除而不是改写；
  // 同文件的孪生 `concreteDatabaseTable` 是活的（`schemaContract.ts` 在用），保留。
  // RFC-359 W4-D8 / D9：identity-access 与 auth 运行时的装配入口收中立句柄，main.ts 少了三个 provider 三元分支。
  // RFC-359（apply 引擎合一，plan §5dv）4 → 3：`package` 子命令的资源包装配此前是一个
  // `provider === 'sqlite' ? … : …`，现在两个 provider 装同一条组合根。
  // RFC-359 AC-10：`main.ts` 的条目退役（3 → 2 → 0）。
  // 第一波 3 → 2：`runFrameBackfillOnBoot` 的 provider 标签是摆设——联合两个成员结构逐字相同、
  // 函数体从不读它，却逼着 main.ts 写一条三元分叉；标签删掉，分叉消失。
  // 本刀 2 → 0：bootstrap 客户端改由 `prepareDatabaseProviderForBoot` 交出
  // （`openBootstrapClient()`），两支的唯一差别（`openClient` 入参个数）随之消失。
  // 文件里残留的两处 `unhandledDatabaseProvider` 穷尽性围栏不计债（按形状豁免）。
  'modules/system-operations/composition.ts': { forks: 1, fence: 'discriminated-union' },
  // RFC-354 T4: the frame backfill picks its store by the provider-keyed
  // `FrameBackfillDatabase` union — a third provider cannot be passed in
  // without its own variant.
  // modules/task-execution/composition/frameBackfill.ts：RFC-359 W4-B1 后存储只有一份实现，不再按 provider 分叉。
  // RFC-359 W8 销账：`providerRuntime.ts` 的品牌分派整段消失——归档维护命令那一对合一后，
  // 装配点直接构造同一个中立实现，两个 provider 共用；此处不再有 fork，条目随之退役。
  // RFC-359 W4-D24：运行时会话租约合一后这里少了一处按品牌的分派（4 → 2；租约那两支收成一行转出口）。
  // RFC-359 AC-10 销账：`taskExecutionPersistence.ts` 的条目退役（2 → 0）。两份 persistence
  // 聚合的唯一差别是恢复管理面，而它四个方法里只有两个不同、且**各让一个引擎更弱**
  // （`interruptBootOrphanTask` 上 SQLite 宽判据且漏传 `now`，
  // `repairRuntimeSessionLeaseAfterOrphanReap` 上 PostgreSQL 的手抄件漏了归属闸）。
  // 各自收敛到强的一侧后两份聚合逐字相同，分派三元连同那道 `fenced-dispatch` 的 never 汇
  // 一起消失——**没有 fork 就不该再声明围栏**，否则守卫会去找一个不存在的 never 汇。
  // RFC-359 AC-10 销账：`maintenanceService.ts` 的条目退役（2 → 0）。原来是一个按 provider
  // 字面量判别的联合，服务体内因此问了两次——准入存储怎么来、Worker 监工怎么起。改成由
  // 装配方交出 `openAdmissionStore` / `startSupervisor` 两个工厂（两个调用点本来就各自知道
  // 自己在装哪个 provider），`provider` 字段只留给 traits 查表，fork 与围栏一并消失。
  'platform/background/maintenanceWorkerSupervisor.ts': { forks: 1, fence: 'discriminated-union' },
  // RFC-359 T19h: runtime selection plus three engine-specific schema preparation branches.
  'platform/persistence/databaseProviderRuntime.ts': { forks: 4, fence: 'fenced-dispatch' },
  // RFC-359：统一事务原语按客户端品牌挑会话实现（$provider 缺失 = bun:sqlite），残余分支沉入 never 汇。
  'platform/persistence/databaseTransaction.ts': { forks: 2, fence: 'fenced-dispatch' },
  // RFC-359 W8 销账：`legacySqliteNodeRollback.ts` 的 `rollbackEffectPersistence` 品牌分派已删除——
  // effect 持久化那一对合一为单份 `DrizzleTaskExecutionEffectPersistence`，观察者不再需要按品牌挑；
  // W1-T2b 记的「两个 provider 各有一份 persistence」这个前提至此不成立，条目退役。
} as const

function providerForkCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const source of backendSources()) {
    const relative = source.path.slice('packages/backend/src/'.length)
    let forks = 0
    for (const line of source.text.split('\n')) {
      const trimmed = line.trimStart()
      // Comments in this file and in providerTraits.ts name the literals while
      // explaining them; only executable branches count.
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
      forks += line.match(/provider === '(?:sqlite|postgresql)'/gu)?.length ?? 0
    }
    if (forks > 0) counts[relative] = forks
  }
  return counts
}

describe('RFC-349 provider completeness', () => {
  test('the provider list is a single derived source, never hand-written', () => {
    expect([...DATABASE_PROVIDERS]).toEqual(['sqlite', 'postgresql'])

    // A hand-copied `'sqlite' | 'postgresql'` does not grow when the tuple does,
    // so each copy is a place a third provider silently fails to reach.
    const handWritten = backendSources()
      .filter(
        (source) =>
          source.path !== CANONICAL_UNION_FILE && /'sqlite'\s*\|\s*'postgresql'/u.test(source.text),
      )
      .map((source) => source.path)
    expect(handWritten).toEqual([])
  })

  test('every provider answers every per-provider decision', () => {
    // `satisfies Record<DatabaseProvider, …>` already makes a missing provider a
    // compile error; this asserts the runtime keys too, so a cast cannot hide one.
    expect(Object.keys(DATABASE_PROVIDER_TRAITS).sort()).toEqual([...DATABASE_PROVIDERS].sort())

    for (const provider of DATABASE_PROVIDERS) {
      const traits = DATABASE_PROVIDER_TRAITS[provider]
      expect(traits.storage, `${provider} must declare its storage shape`).toBeDefined()
      // The two decisions a third provider was measured to inherit wrongly.
      expect(traits.booleanLiteral(true), `${provider} boolean true literal`).toBeTruthy()
      expect(traits.booleanLiteral(false), `${provider} boolean false literal`).toBeTruthy()
      expect(typeof traits.classifyRetryable, `${provider} retryable classifier`).toBe('function')
    }

    // Distinctness: a provider that merely copied SQLite's answers has not been
    // adapted. Boolean rendering is the canary — it is what broke on PostgreSQL.
    const renderings = new Set(
      DATABASE_PROVIDERS.map((provider) => DATABASE_PROVIDER_TRAITS[provider].booleanLiteral(true)),
    )
    expect(renderings.size).toBeGreaterThan(1)
  })

  test('the two measured silent-fallthrough forks now read the traits table', () => {
    const contract = backendSource(CANONICAL_UNION_FILE)
    // literalSql must not branch on a provider literal any more.
    expect(contract.text).not.toContain("if (provider === 'postgresql') return value ? 'TRUE'")
    expect(contract.text).toContain('booleanLiteral')

    const maintenance = backendSource(
      'packages/backend/src/platform/background/maintenanceService.ts',
    )
    expect(maintenance.text).not.toContain(
      "options.provider === 'postgresql' ? postgresqlRetryableCode : retryableSqliteWriteErrorCode",
    )
    expect(maintenance.text).toContain('classifyRetryable')
  })
  test('no provider fork exists outside the ledger, and none grows silently', () => {
    const expected: Record<string, number> = {}
    for (const [path, entry] of Object.entries(PROVIDER_FORK_LEDGER)) {
      expected[path] = entry.forks
    }
    // A new file appearing here, or an existing count changing, means someone
    // added or removed a provider fork. Register it with its fence (or migrate it
    // into the traits table) rather than editing the number to match.
    expect(providerForkCounts()).toEqual(expected)
  })

  test('every ledger entry declares which fence makes its fork safe', () => {
    const fences = new Set([
      'fenced-dispatch',
      'discriminated-union',
      'projection-fenced',
      'display-text',
    ])
    for (const [path, entry] of Object.entries(PROVIDER_FORK_LEDGER)) {
      expect(fences.has(entry.fence), `${path} declares an unknown fence`).toBe(true)
      expect(entry.forks, `${path} must declare at least one fork`).toBeGreaterThan(0)
    }
  })

  test('every fenced-dispatch file actually carries the never sink', () => {
    // `fenced-dispatch` is a claim, so check it: the file must call
    // `unhandledDatabaseProvider` in the residual branch. Without that call the
    // literal comparison is an ordinary fork again and a third provider takes
    // whichever branch happens to be the `else`.
    for (const [path, entry] of Object.entries(PROVIDER_FORK_LEDGER)) {
      if (entry.fence !== 'fenced-dispatch') continue
      const text = backendSource(`packages/backend/src/${path}`).text
      expect(text, `${path} claims fenced-dispatch but never sinks the residual`).toContain(
        'unhandledDatabaseProvider(',
      )
    }
  })

  test('no trait is declared without a consumer', () => {
    // A trait nobody reads drifts away from the branch it was meant to replace —
    // that already happened once here with a `maintenanceWorker` trait that was
    // added and then removed the same day for exactly this reason.
    const traits = backendSource('packages/backend/src/platform/persistence/providerTraits.ts').text
    const declared = [...traits.matchAll(/^\s{2}readonly (\w+):/gmu)].map((m) => m[1])
    expect(declared.sort()).toEqual([
      // RFC-359 AC-10 第三波：「本地库文件还不存在」时 doctor 该报的那句话
      //（`null` = 这个引擎没有本地文件这回事），以及 `db compact` 能不能做事
      //（不能就连要对用户说的话一起给）。两条原本都问 `storage`——比品牌名好一档，
      // 但仍是**两值枚举**，是同一张真值表的另一种拼法，第三个 provider 只能落进其中一边。
      'absentLocalStoreMessage',
      'booleanLiteral',
      'classifyRetryable',
      // RFC-359 AC-10 第二波：`db info` 的服务端版本兜底文案、以及 provider 自检失败时的
      // 下一步提示。两条原本都是调用方现场写的品牌三元，现在由各引擎各声明一次。
      'failureRecoveryHint',
      'migrationRole',
      'offlineCompaction',
      'serverVersionFallback',
      'storage',
    ])
    const consumers = backendSources().filter(
      (source) =>
        !source.path.endsWith('providerTraits.ts') &&
        source.text.includes('databaseProviderTraits('),
    )
    for (const trait of declared) {
      expect(
        consumers.some((source) => source.text.includes(`.${trait}`)),
        `trait ${trait} has no consumer outside the traits table`,
      ).toBe(true)
    }
  })

  test('the generation enum stays a deliberate closed list, not a derived one', () => {
    // This is the boot fence and the reason it is NOT `z.enum(DATABASE_PROVIDERS)`:
    // a provider added to the tuple but not yet adapted must be unable to boot at
    // all. Deriving this enum would let it through and hand every fork above its
    // `else` branch instead. Widen it deliberately, as the last step of adapting
    // a provider — after the traits table and the ledger above are answered.
    const store = backendSource('packages/backend/src/platform/persistence/generationStore.ts')
    expect(store.text).toContain("z.enum(['sqlite', 'postgresql'])")
    expect(store.text).not.toContain('z.enum(DATABASE_PROVIDERS)')
  })
})
