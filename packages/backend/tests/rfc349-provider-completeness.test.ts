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
  'cli/database.ts': { forks: 1, fence: 'embedded-question' },
  'cli/dbCompact.ts': { forks: 1, fence: 'migration-pair' },
  'cli/doctor.ts': { forks: 2, fence: 'embedded-question' },
  'cli/migrate.ts': { forks: 1, fence: 'migration-pair' },
  'cli/start.ts': { forks: 4, fence: 'discriminated-union' },
  'db/providerSchema.ts': { forks: 1, fence: 'projection-fenced' },
  'main.ts': { forks: 5, fence: 'discriminated-union' },
  'modules/system-operations/composition.ts': { forks: 1, fence: 'discriminated-union' },
  'modules/system-operations/infrastructure/databaseMigrationCoordinator.ts': {
    forks: 4,
    fence: 'migration-pair',
  },
  'modules/system-operations/infrastructure/databaseMigrationDaemonAdmission.ts': {
    forks: 1,
    fence: 'embedded-question',
  },
  'modules/system-operations/infrastructure/portableDatabaseRestore.ts': {
    forks: 1,
    fence: 'migration-pair',
  },
  'platform/background/maintenanceService.ts': { forks: 2, fence: 'discriminated-union' },
  'platform/background/maintenanceWorkerSupervisor.ts': { forks: 1, fence: 'discriminated-union' },
  'platform/persistence/databaseProviderRuntime.ts': { forks: 1, fence: 'discriminated-union' },
  'platform/persistence/generationStore.ts': { forks: 1, fence: 'boot-fence' },
  'platform/persistence/logicalDatabaseExport.ts': { forks: 1, fence: 'migration-pair' },
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
      'discriminated-union',
      'projection-fenced',
      'embedded-question',
      'migration-pair',
      'boot-fence',
    ])
    for (const [path, entry] of Object.entries(PROVIDER_FORK_LEDGER)) {
      expect(fences.has(entry.fence), `${path} declares an unknown fence`).toBe(true)
      expect(entry.forks, `${path} must declare at least one fork`).toBeGreaterThan(0)
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
