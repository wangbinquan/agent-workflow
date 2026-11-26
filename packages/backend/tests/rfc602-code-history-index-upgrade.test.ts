// RFC-602: old epoch-2 schema/rows and independent native seeds survive upgrade
// and explicit rebuilding. Expected values are curated fixtures, never builder output.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { bindSqliteClient } from '@/db/client'
import { persistenceHistory } from '@/bootstrap/persistenceHead'
import { persistenceSchemaBinding } from '@/bootstrap/persistenceSchema'
import { EPOCH2_META_TABLES } from '@/modules/system-operations/composition/schema'
import {
  createCodeHistoryIndexCommands,
  createCodeHistoryQueryReader,
  type CodeHistoryInstallation,
  type CodeHistoryQueryReader,
} from '@/modules/code-capability/composition/historyQueries'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import type { DeliveryRow } from '@/modules/code-capability/application/ports/deliveryChainRead'
import type { CodeHistoryTable } from '@/modules/code-capability/domain/codeHistoryPackage'
import type { ContentRef } from '@/platform/content/contentRef'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { postgresqlHistorySession } from '@/platform/persistence/postgresql/historySession'
import { sqliteHistorySession } from '@/platform/persistence/sqlite/historySession'
import {
  applyHistoryVersion,
  installHistoryHead,
  readSchemaHistoryRows,
} from '@/platform/persistence/schema/history/apply'
import { parameters } from '@/platform/persistence/schema/history/connection'
import type { HistoryVersion } from '@/platform/persistence/schema/history/types'
import { describeEachProvider } from './helpers/eachProvider'
import { withR2TargetHarness, type R2TargetHarness } from './helpers/rfc395R2Harness'

type Row = Record<string, unknown>
type SourceRow = Record<string, string | number | boolean | null>
type MetricCounts = Readonly<
  Record<
    | 'published'
    | 'adopted'
    | 'quiet_fix'
    | 'disagreed'
    | 'outstanding'
    | 'rounds'
    | 'run_published'
    | 'run_failed'
    | 'run_awaiting'
    | 'incomplete',
    number
  >
>
interface Seed {
  readonly rows: readonly { readonly table: string; readonly values: Row }[]
}
interface Oracle {
  readonly sourceGeneration: string
  readonly sourceContract: string
  readonly buildId: string
  readonly originalArchiveCount: number
  readonly originalRecordCount: number
  readonly sourceRows: Readonly<Record<string, readonly SourceRow[]>>
  readonly expectedProjectionRows: Readonly<Record<string, readonly Row[]>>
  readonly metricsSince: readonly {
    readonly since: number
    readonly counts: MetricCounts
  }[]
}
const fixtures = join(import.meta.dir, 'fixtures/release-upgrade')
const oracle = JSON.parse(
  readFileSync(join(fixtures, 'rfc602-code-history-query-oracle.json'), 'utf8'),
) as Oracle
const seedAt = (version: number): Seed =>
  JSON.parse(
    readFileSync(
      join(fixtures, 'seeds/epoch2', `${String(version).padStart(4, '0')}.json`),
      'utf8',
    ),
  ) as Seed
const installation: CodeHistoryInstallation = {
  kind: 'converted',
  source: { sourceGeneration: oracle.sourceGeneration, contract: frozenEpoch1Contract },
}

function historySession(h: R2TargetHarness) {
  return h.provider === 'sqlite' ? sqliteHistorySession(h.sqlite) : postgresqlHistorySession(h.pool)
}

async function install(h: R2TargetHarness, version: HistoryVersion): Promise<void> {
  await installHistoryHead(historySession(h), {
    version,
    generationId: h.provider === 'postgresql' ? h.runtime.generationId : 'rfc602-upgrade',
    installPath: 'test-baseline',
    metaTables: EPOCH2_META_TABLES,
    now: () => 1,
  })
}

function client(h: R2TargetHarness): PersistenceDb {
  return h.provider === 'sqlite'
    ? bindSqliteClient(h.sqlite)
    : createPostgresqlDatabaseClient(h.runtime, { liveSchema: persistenceSchemaBinding })
}

async function insertSeed(h: R2TargetHarness, seed: Seed): Promise<void> {
  for (const row of seed.rows) {
    const columns = Object.keys(row.values)
    const values = columns.map((column) => {
      const value = row.values[column]
      if (value !== null && typeof value === 'object' && '$bytes' in value)
        return Buffer.from(String(value.$bytes), 'base64')
      return typeof value === 'boolean' && h.provider === 'sqlite' ? Number(value) : value
    })
    await h.native.execute(
      `INSERT INTO ${h.table(row.table)} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${parameters(h.native, values.length)})`,
      values,
    )
  }
}

function normalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') }
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]))
  return value
}

async function originalFacts(h: R2TargetHarness) {
  return normalize({
    archives: await h.native.execute(
      `SELECT * FROM ${h.table('code_history_archives')} ORDER BY id`,
    ),
    ids: await h.native.execute(
      `SELECT * FROM ${h.table('code_history_id_index')} ORDER BY source_table, original_id, source_contract`,
    ),
  })
}

const rowIdentity = (row: Row): string =>
  ['source_table', 'original_id', 'id', 'capability', 'occurred_at']
    .map((key) => String(row[key] ?? ''))
    .join(':')

async function expectProjectionOracle(h: R2TargetHarness, buildId: string): Promise<void> {
  for (const [table, expectedRows] of Object.entries(oracle.expectedProjectionRows)) {
    if (table === 'code_history_query_builds' || table === 'code_history_query_states') continue
    const actual = await h.native.execute(
      `SELECT * FROM ${h.table(table)} WHERE build_id = ${parameters(h.native, 1)}`,
      [buildId],
    )
    expect(actual.length, table).toBe(expectedRows.length)
    const expected = expectedRows.map((row) => ({ ...row, build_id: buildId }))
    const normalizeRow = (row: Row): Row =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          const sample = expectedRows[0]?.[key]
          if (key === 'record_payload_json') return [key, JSON.parse(String(value)) as unknown]
          if (typeof sample === 'number') return [key, Number(value)]
          if (typeof sample === 'boolean') return [key, Boolean(value)]
          return [key, value]
        }),
      )
    const sort = (rows: readonly Row[]) =>
      rows.map(normalizeRow).sort((a, b) => rowIdentity(a).localeCompare(rowIdentity(b)))
    expect(sort(actual), table).toEqual(sort(expected))
  }
}

async function expectQueryOracle(reader: CodeHistoryQueryReader): Promise<void> {
  const t0 = 1778459500000
  expect(
    await reader.workItems.readPage({
      codeHostEndpointId: 'rfc602-endpoint',
      stableProjectId: 'rfc602-project',
      capability: 'review',
      limit: 1,
      roundLimit: 1,
    }),
  ).toEqual({
    items: [
      {
        workItemId: 'rfc602-item',
        capability: 'review',
        anchorKind: 'mr',
        anchorId: '42',
        status: 'closed',
        epoch: 2,
        roundsHidden: 0,
        rounds: [
          {
            roundId: 'rfc602-round',
            roundSeq: 2,
            status: 'published',
            outcome: 'published',
            stageContractVer: 1,
            baselineSha: 'a'.repeat(40),
            startedAt: t0,
            endedAt: t0 + 20,
            stages: [
              {
                stageName: 'review',
                stageSeq: 1,
                kind: 'ai',
                status: 'done',
                error: null,
                startedAt: t0,
                endedAt: t0 + 20,
              },
            ],
          },
        ],
      },
    ],
    nextCursor: null,
  })
  expect(await reader.attempts.load('rfc602-round', 200)).toEqual([
    {
      attemptId: 'rfc602-attempt',
      stageName: 'review',
      shardKey: '',
      rerunSeq: 0,
      attemptSeq: 1,
      status: 'validated',
      validationOutcome: 'valid',
      sessionRef: null,
      nodeRunId: null,
      startedAt: t0,
      endedAt: t0 + 10,
    },
  ])
  const deliveries: DeliveryRow[] = [
    {
      id: 'rfc602-delivery',
      correlationId: 'rfc602-correlation',
      capability: 'review',
      step: 'published',
      outcome: 'ok',
      reason: null,
      queuedAt: null,
      queuePosition: null,
      waitingOn: null,
      roundId: 'rfc602-round',
      isProbe: false,
      createdAt: t0 + 20,
      updatedAt: t0 + 21,
    },
  ]
  expect(await reader.deliveries.recent({ stableProjectId: 'rfc602-project', limit: 1 })).toEqual(
    deliveries,
  )
  expect(await reader.deliveries.byCorrelation('rfc602-correlation')).toEqual(deliveries)
  expect(await reader.deliveries.failures({ stableProjectId: 'rfc602-project' })).toEqual([])
  for (const window of oracle.metricsSince) {
    const c = window.counts
    expect(
      await createCodeMetricsQuery(reader.metrics).summary({ now: window.since + 7, windowMs: 7 }),
    ).toEqual({
      windowMs: 7,
      adoption:
        c.published === 0
          ? []
          : [
              {
                capability: 'review',
                published: c.published,
                adopted: c.adopted,
                quietFix: c.quiet_fix,
                disagreed: c.disagreed,
                outstanding: c.outstanding,
              },
            ],
      runs:
        c.rounds === 0
          ? []
          : [
              {
                capability: 'review',
                rounds: c.rounds,
                published: c.run_published,
                failed: c.run_failed,
                awaiting: c.run_awaiting,
                incomplete: c.incomplete,
              },
            ],
    })
  }
  for (const [table, sourceRows] of Object.entries(oracle.sourceRows)) {
    for (const source of sourceRows) {
      const record = await reader.find(table as CodeHistoryTable, String(source.id))
      expect(record?.row, `${table}/${String(source.id)}`).toEqual(source)
      expect(record?.raw, `${table}/${String(source.id)} raw`).toEqual(source)
    }
  }
  expect(await reader.find('code_work_items', 'not-in-original-source')).toBeNull()
}

function indexInput(db: PersistenceDb) {
  let reads = 0
  const content = {
    async read(ref: ContentRef) {
      reads++
      if (ref.kind !== 'inline') throw new Error('curated archive must remain inline')
      return ref.bytes
    },
  }
  return {
    db,
    installation,
    content,
    get reads() {
      return reads
    },
  }
}

describeEachProvider('RFC-602 code history query index upgrade', (provider) => {
  withR2TargetHarness(provider, (h) => {
    test.each([2, 3])(
      'version %i upgrades to head, initializes from original facts, and rebuilds the same independent projection',
      async (initialVersion) => {
        expect(oracle.sourceContract).toBe(frozenEpoch1Contract.digest)
        const versions = persistenceHistory()
        const old = versions.find((version) => version.contract.version === initialVersion)!
        expect(old.contract.slug).toBe(
          initialVersion === 2 ? 'rfc401_skill_apply_journal' : 'rfc602_code_history_query_builds',
        )
        await install(h, old)
        // Version 2 is the deployed schema before any RFC-602 addition. Its
        // source facts come from the curated seed without future derived tables.
        const sourceSeed = seedAt(3)
        await insertSeed(h, {
          rows: sourceSeed.rows.filter(
            (row) =>
              initialVersion === 3 ||
              ['code_history_archives', 'code_history_id_index'].includes(row.table),
          ),
        })
        const originals = await originalFacts(h)
        const session = historySession(h)
        for (const version of versions.filter((entry) => entry.contract.version > initialVersion)) {
          expect(
            await applyHistoryVersion(session, { version, metaTables: EPOCH2_META_TABLES }),
          ).toBeTrue()
        }
        expect((await readSchemaHistoryRows(h.native)).map((row) => row.version)).toEqual(
          versions
            .filter((version) => version.contract.version >= initialVersion)
            .map((version) => version.contract.version),
        )
        const db = client(h)
        const input = indexInput(db)
        const commands = createCodeHistoryIndexCommands(input)
        const first = await commands.initialize()
        expect(first).toMatchObject({
          kind: 'ready',
          reused: false,
          records: oracle.originalRecordCount,
        })
        expect(first.buildId).not.toBe(oracle.buildId)
        expect(input.reads).toBe(oracle.originalArchiveCount)
        await expectProjectionOracle(h, first.buildId!)
        await expectQueryOracle(createCodeHistoryQueryReader({ db, installation }))
        expect(input.reads).toBe(oracle.originalArchiveCount)
        expect(await originalFacts(h)).toEqual(originals)

        // A new commands/reader pair proves that reuse belongs to the durable
        // installation, rather than the process that performed initialization.
        const restarted = indexInput(db)
        const again = await createCodeHistoryIndexCommands(restarted).initialize()
        expect(again).toMatchObject({ kind: 'ready', buildId: first.buildId, reused: true })
        expect(restarted.reads).toBe(0)
        await expectQueryOracle(createCodeHistoryQueryReader({ db, installation }))
        const rebuilt = await createCodeHistoryIndexCommands(restarted).rebuild()
        expect(rebuilt).toMatchObject({
          kind: 'ready',
          previousBuildId: first.buildId,
          reused: false,
          records: 9,
        })
        expect(rebuilt.buildId).not.toBe(first.buildId)
        expect(restarted.reads).toBe(oracle.originalArchiveCount)
        await expectProjectionOracle(h, rebuilt.buildId!)
        await expectQueryOracle(createCodeHistoryQueryReader({ db, installation }))
        expect(await originalFacts(h)).toEqual(originals)
      },
      60_000,
    )

    test('all ten native seed tables are readable before rebuilding and preserve their source bytes afterward', async () => {
      const head = persistenceHistory().at(-1)!
      await install(h, head)
      for (let version = 3; version <= 12; version++) await insertSeed(h, seedAt(version))
      const originals = await originalFacts(h)
      const db = client(h)
      await expectProjectionOracle(h, oracle.buildId)
      await expectQueryOracle(createCodeHistoryQueryReader({ db, installation }))
      const input = indexInput(db)
      const commands = createCodeHistoryIndexCommands(input)
      expect(await commands.initialize()).toMatchObject({
        kind: 'ready',
        buildId: oracle.buildId,
        reused: true,
      })
      expect(input.reads).toBe(0)
      const rebuilt = await commands.rebuild()
      expect(rebuilt).toMatchObject({
        kind: 'ready',
        previousBuildId: oracle.buildId,
        reused: false,
      })
      expect(rebuilt.buildId).not.toBe(oracle.buildId)
      expect(input.reads).toBe(oracle.originalArchiveCount)
      await expectProjectionOracle(h, rebuilt.buildId!)
      await expectQueryOracle(createCodeHistoryQueryReader({ db, installation }))
      expect(await originalFacts(h)).toEqual(originals)
    }, 60_000)
  })
})
