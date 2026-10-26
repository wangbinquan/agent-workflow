// RFC-395 U-5: frozen /code response examples, not archive record-order expectations.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Hono, type Context } from 'hono'
import { buildActor } from '@/auth/actor'
import { errorHandler } from '@/util/errors'
import { mountCodeRoutes } from '@/routes/code'
import { resetRouteMetaRegistry } from '@/routes/registry'
import {
  composeCodeHistoryQueries,
  type CodeHistoryQueries,
} from '@/modules/code-capability/composition/historyQueries'
import { createAgentExecutionQueries } from '@/modules/resource-catalog/public/queries'
import { describeEachProvider } from './helpers/eachProvider'
import {
  seedEmptyCodeHistory,
  seedCodeHistoryRows,
  historyFixtureReader,
  historyFixtureSource,
  historyFixtureContent,
  createEpoch1HistoryQueries,
  installConvertedCodeHistory,
} from './helpers/legacyCapabilitySeed'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withR2TargetHarness } from './helpers/rfc395R2Harness'
import { installFrozenSqlite } from './helpers/rfc395V1Harness'
import { emptyV2Content, fixtureLookup } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { bindFrozenSqliteHandle, createFrozenPostgresqlClient } from './migration-freeze'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { migratePostgresqlSchema } from '@/platform/persistence/migration/legacy/postgresqlMigrator'
import {
  loadSupportedSourceManifest,
  compileEpoch1PostgresqlCatalog,
} from '@/platform/persistence/migration/supportedSources'
import { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { openEpoch1PostgresqlSource } from '@/platform/persistence/migration/postgresqlSourceReader'
import { parameters } from '@/platform/persistence/schema/history/connection'
import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import { historyRule } from '@/platform/persistence/migration/archives/codeHistory'
import { HISTORY_ADOPTIONS } from '@/platform/persistence/migration/archives/adoptions'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { createCodeHistoryPackageReader } from '@/modules/code-capability/infrastructure/history/packageReader'
import type { CodeHistoryQueryTable } from '@/modules/code-capability/domain/codeHistoryPackage'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

const NOW = 1_700_000_000_000
const item = (id: string, createdAt = NOW) => ({
  id,
  codeHostEndpointId: 'ep',
  stableProjectId: 'project',
  capability: 'mr-review',
  anchorKind: 'mr',
  anchorId: id,
  status: 'settled',
  epoch: 3,
  createdAt,
  updatedAt: createdAt,
})

function historyApp(history: CodeHistoryQueries) {
  const server = new Hono()
  server.use('*', async (c: Context, next) => {
    c.set(
      'actor',
      buildActor({
        user: {
          id: 'history-admin',
          username: 'history-admin',
          displayName: 'History',
          role: 'admin',
          status: 'active',
        },
        source: 'daemon',
      }),
    )
    await next()
  })
  server.onError(errorHandler)
  mountCodeRoutes(server, {
    ...history,
    metrics: { summary: (input) => history.metrics.summary({ ...input, now: NOW }) },
  })
  return server
}

describeEachProvider('RFC-395 history response parity', (h) => {
  const queries = () =>
    composeCodeHistoryQueries(h.db, createAgentExecutionQueries(h.db), historyFixtureReader(h.db))
  beforeEach(async () => {
    resetRouteMetaRegistry()
    await seedEmptyCodeHistory(h.db)
  })
  afterEach(() => resetRouteMetaRegistry())
  const app = () => historyApp(queries())
  test('work-item DTO preserves every field, null and stage/round order, including hidden rounds', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('item'))
    await seedCodeHistoryRows(h.db, 'code_work_rounds', [
      {
        id: 'z-first',
        workItemId: 'item',
        roundSeq: 1,
        startedAt: NOW,
        outcome: 'published',
        endedAt: NOW + 1,
      },
      {
        id: 'a-second',
        workItemId: 'item',
        roundSeq: 2,
        stageContractVer: 4,
        baselineSha: null,
        startedAt: NOW + 2,
        outcome: null,
        endedAt: NOW + 3,
      },
    ])
    await seedCodeHistoryRows(h.db, 'code_round_stages', [
      {
        id: 'a-last',
        roundId: 'a-second',
        stageSeq: 2,
        stageName: 'finish',
        stageKind: 'program',
        status: 'failed',
        error: 'line\nverbatim',
        startedAt: NOW + 2,
        endedAt: null,
      },
      {
        id: 'z-first',
        roundId: 'a-second',
        stageSeq: 0,
        stageName: 'prepare',
        stageKind: 'script',
        status: 'pending',
        error: null,
        startedAt: null,
        endedAt: null,
      },
    ])
    const response = await app().request(
      '/api/code/work-items?endpointId=ep&projectId=project&capability=mr-review&rounds=1',
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      items: [
        {
          workItemId: 'item',
          capability: 'mr-review',
          anchorKind: 'mr',
          anchorId: 'item',
          status: 'settled',
          epoch: 3,
          roundsHidden: 1,
          rounds: [
            {
              roundId: 'a-second',
              roundSeq: 2,
              status: 'ended-without-outcome',
              outcome: null,
              stageContractVer: 4,
              baselineSha: null,
              startedAt: NOW + 2,
              endedAt: NOW + 3,
              stages: [
                {
                  stageName: 'prepare',
                  stageSeq: 0,
                  kind: 'script',
                  status: 'pending',
                  error: null,
                  startedAt: null,
                  endedAt: null,
                },
                {
                  stageName: 'finish',
                  stageSeq: 2,
                  kind: 'program',
                  status: 'failed',
                  error: 'line\nverbatim',
                  startedAt: NOW + 2,
                  endedAt: null,
                },
              ],
            },
          ],
        },
      ],
      nextCursor: null,
    })
    for (const path of [
      '/api/code/work-items?endpointId=other',
      '/api/code/work-items?projectId=other',
      '/api/code/work-items?capability=other',
    ])
      expect(await (await app().request(path)).json()).toEqual({ items: [], nextCursor: null })
  })
  test('timestamp ties retain the existing cursor omission and stale cursors restart from the top', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', [
      item('a'),
      item('z'),
      item('older', NOW - 1),
    ])
    const first = await queries().workItems.page({ limit: 1 })
    expect(first.items.map((row) => row.workItemId)).toEqual(['z'])
    expect(first.nextCursor).toBe(`${NOW}:z`)
    expect(
      (await queries().workItems.page({ limit: 1, cursor: first.nextCursor })).items.map(
        (row) => row.workItemId,
      ),
    ).toEqual(['older'])
    expect(
      (await queries().workItems.page({ cursor: 'invalid' })).items.map((row) => row.workItemId),
    ).toEqual(['z', 'a', 'older'])
  })
  test('page and round limits retain the 1..100 and 1..20 clamps', async () => {
    await seedCodeHistoryRows(
      h.db,
      'code_work_items',
      Array.from({ length: 101 }, (_, i) => item(`item-${i}`, NOW + i)),
    )
    await seedCodeHistoryRows(
      h.db,
      'code_work_rounds',
      Array.from({ length: 25 }, (_, i) => ({
        id: `round-${i}`,
        workItemId: 'item-100',
        roundSeq: i,
        startedAt: NOW + i,
      })),
    )
    const page = await queries().workItems.page({ limit: 999, roundLimit: 999 })
    expect(page.items).toHaveLength(100)
    expect(page.items[0]?.rounds).toHaveLength(20)
    expect(page.items[0]?.roundsHidden).toBe(5)
    expect(
      (await queries().workItems.page({ limit: 0, roundLimit: 0 })).items[0]?.rounds,
    ).toHaveLength(1)
  })
  test('fractional SQL limits still fail while delivery default, zero and negative limits retain their behavior', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('item'))
    await seedCodeHistoryRows(
      h.db,
      'code_trigger_deliveries',
      Array.from({ length: 51 }, (_, i) => ({
        id: `delivery-${i}`,
        correlationId: 'limits',
        stableProjectId: 'project',
        step: 'failed',
        outcome: 'failed',
        createdAt: NOW + i,
        updatedAt: NOW + i,
      })),
    )
    expect(await queries().deliveries.forProject({ stableProjectId: 'project' })).toHaveLength(50)
    expect(await queries().deliveries.forProject({ stableProjectId: 'project', limit: 0 })).toEqual(
      [],
    )
    expect(await queries().deliveries.failures({ limit: -1 })).toHaveLength(51)
    expect(await queries().deliveries.failures({ limit: Number.NaN })).toHaveLength(51)
    for (const path of [
      '/api/code/work-items?limit=1.5',
      '/api/code/work-items?rounds=1.5',
      '/api/code/deliveries?projectId=project&limit=1.5',
    ]) {
      const response = await app().request(path)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ code: 'internal-error' })
    }
    const invalid = await app().request('/api/code/deliveries?projectId=project&limit=NaN')
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({ code: 'code-limit-invalid' })
  })
  test('attempt DTOs preserve empty shard, raw verdict, ids and all nulls; absent round remains an empty array', async () => {
    await seedCodeHistoryRows(h.db, 'code_ai_attempts', [
      {
        id: 'z',
        roundId: 'round',
        stageName: 'review',
        shardKey: '',
        rerunSeq: 0,
        attemptSeq: 1,
        status: 'failed',
        validationOutcome: ' { "why": "verbatim" }\r\n',
        sessionRef: null,
        nodeRunId: 'old-node',
        startedAt: NOW,
        endedAt: null,
      },
      {
        id: 'a',
        roundId: 'round',
        stageName: 'review',
        shardKey: 'src/a',
        rerunSeq: 1,
        attemptSeq: 0,
        status: 'validated',
        startedAt: NOW,
        endedAt: NOW + 1,
      },
    ])
    expect(await (await app().request('/api/code/rounds/round/attempts')).json()).toEqual({
      attempts: [
        {
          attemptId: 'z',
          stageName: 'review',
          shardKey: '',
          rerunSeq: 0,
          attemptSeq: 1,
          status: 'failed',
          validationOutcome: ' { "why": "verbatim" }\r\n',
          sessionRef: null,
          nodeRunId: 'old-node',
          startedAt: NOW,
          endedAt: null,
        },
        {
          attemptId: 'a',
          stageName: 'review',
          shardKey: 'src/a',
          rerunSeq: 1,
          attemptSeq: 0,
          status: 'validated',
          validationOutcome: null,
          sessionRef: null,
          nodeRunId: null,
          startedAt: NOW,
          endedAt: NOW + 1,
        },
      ],
    })
    expect(await (await app().request('/api/code/rounds/missing/attempts')).json()).toEqual({
      attempts: [],
    })
    await seedCodeHistoryRows(
      h.db,
      'code_ai_attempts',
      Array.from({ length: 201 }, (_, i) => ({
        id: `bounded-${201 - i}`,
        roundId: 'bounded',
        stageName: 'review',
        startedAt: NOW + i,
      })),
    )
    const bounded = await queries().attempts.forRound('bounded')
    expect(bounded).toHaveLength(200)
    expect(bounded[0]?.attemptId).toBe('bounded-201')
    expect(bounded.at(-1)?.attemptId).toBe('bounded-2')
  })
  test('delivery correlation wins over failure/project/limit and preserves the pre-conversion outcome', async () => {
    await seedCodeHistoryRows(h.db, 'code_trigger_deliveries', [
      {
        id: 'old',
        correlationId: 'corr',
        stableProjectId: 'project',
        capability: null,
        step: 'received',
        outcome: 'ok',
        reason: null,
        queuedAt: null,
        queuePosition: null,
        waitingOn: null,
        roundId: null,
        isProbe: true,
        createdAt: NOW,
        updatedAt: NOW + 1,
      },
      {
        id: 'new',
        correlationId: 'corr',
        stableProjectId: 'elsewhere',
        capability: 'mr-review',
        step: 'failed',
        outcome: 'failed',
        createdAt: NOW + 2,
        updatedAt: NOW + 3,
      },
      {
        id: 'dropped',
        correlationId: 'other',
        stableProjectId: 'project',
        step: 'routed',
        outcome: 'dropped',
        createdAt: NOW + 4,
        updatedAt: NOW + 4,
      },
    ])
    const body = (await (
      await app().request(
        '/api/code/deliveries?correlationId=corr&failedOnly=true&projectId=missing&limit=1',
      )
    ).json()) as { deliveries: unknown[] }
    expect(body.deliveries).toHaveLength(2)
    expect(body.deliveries[1]).toEqual({
      id: 'old',
      correlationId: 'corr',
      capability: null,
      step: 'received',
      outcome: 'ok',
      reason: null,
      queuedAt: null,
      queuePosition: null,
      waitingOn: null,
      roundId: null,
      isProbe: true,
      createdAt: NOW,
      updatedAt: NOW + 1,
    })
    expect(
      await (await app().request('/api/code/deliveries?failedOnly=true&projectId=project')).json(),
    ).toEqual({ deliveries: [] })
    expect(
      (await queries().deliveries.forProject({ stableProjectId: 'project', limit: 1 })).map(
        (row) => row.id,
      ),
    ).toEqual(['dropped'])
    const missing = await app().request('/api/code/deliveries')
    expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ code: 'code-delivery-filter-required' })
  })
  test('metrics keep the inclusive window, inner join, all outcome priorities and adoption buckets', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('item'))
    await seedCodeHistoryRows(h.db, 'code_findings', [
      ...[
        [NOW, NOW],
        [null, NOW],
        [NOW, null],
        [null, null],
      ].map(([resolvedAt, codeChangedAt], i) => ({
        id: `finding-${i}`,
        capability: 'mr-review',
        externalId: `thread-${i}`,
        resolvedAt: resolvedAt!,
        codeChangedAt: codeChangedAt!,
        createdAt: NOW - 100,
      })),
      { id: 'unpublished', capability: 'mr-review', externalId: null, createdAt: NOW },
      { id: 'too-old', capability: 'mr-review', externalId: 'old', createdAt: NOW - 101 },
    ])
    await seedCodeHistoryRows(h.db, 'code_work_rounds', [
      ...['published', 'failed', 'awaiting', 'canceled', 'superseded', null].map((outcome, i) => ({
        id: `round-${i}`,
        workItemId: 'item',
        roundSeq: i,
        outcome,
        startedAt: NOW - 100,
        endedAt: NOW,
      })),
      {
        id: 'running',
        workItemId: 'item',
        roundSeq: 6,
        outcome: null,
        startedAt: NOW,
        endedAt: null,
      },
      {
        id: 'orphan',
        workItemId: 'missing',
        roundSeq: 0,
        outcome: 'published',
        startedAt: NOW,
        endedAt: NOW,
      },
      {
        id: 'old',
        workItemId: 'item',
        roundSeq: 7,
        outcome: 'published',
        startedAt: NOW - 101,
        endedAt: NOW,
      },
    ])
    expect(await (await app().request('/api/code/metrics?windowMs=100')).json()).toEqual({
      windowMs: 100,
      adoption: [
        {
          capability: 'mr-review',
          published: 4,
          adopted: 1,
          quietFix: 1,
          disagreed: 1,
          outstanding: 1,
        },
      ],
      runs: [
        { capability: 'mr-review', rounds: 7, published: 1, failed: 1, awaiting: 1, incomplete: 3 },
      ],
    })
    for (const value of ['0', '-1', 'NaN', 'Infinity']) {
      const response = await app().request(`/api/code/metrics?windowMs=${value}`)
      expect(response.status).toBe(422)
      expect(await response.json()).toMatchObject({ code: 'code-window-invalid' })
    }
  })
  test('the same original id in a different contract never bleeds into this installation', async () => {
    const other = {
      ...historyFixtureSource,
      sourceGeneration: 'other-generation',
      contract: { ...historyFixtureSource.contract, digest: 'sha256:other-contract' },
    }
    await seedCodeHistoryRows(h.db, 'code_work_items', item('same-id'), historyFixtureSource)
    await seedCodeHistoryRows(
      h.db,
      'code_work_items',
      { ...item('same-id'), capability: 'ci-fix' },
      other,
    )
    expect((await queries().workItems.page({})).items.map((row) => row.capability)).toEqual([
      'mr-review',
    ])
    expect(
      (await historyFixtureReader(h.db, other).find('code_work_items', 'same-id'))?.row.capability,
    ).toBe('ci-fix')
  })
  test('current capability GETs remain current and do not need a history binding', async () => {
    const unbound = composeCodeHistoryQueries(h.db, createAgentExecutionQueries(h.db))
    const server = historyApp(unbound)
    expect((await server.request('/api/code/matrix/unknown')).status).toBe(200)
    expect((await server.request('/api/code/capabilities')).status).toBe(200)
    expect((await server.request('/api/code/capabilities/unknown/graph')).status).toBe(404)
    expect((await server.request('/api/code/capabilities/mr-review/graph')).status).toBe(200)
    for (const read of [
      () => unbound.workItems.page({}),
      () => unbound.attempts.forRound('missing'),
      () => unbound.deliveries.forCorrelation('missing'),
      () => unbound.metrics.summary({ now: NOW }),
    ])
      await expect(read()).rejects.toThrow('code-history-reader-unbound')
  })
})

// H-F1: both sides execute their own SQL against real, independent provider databases.
// The target receives sink rows verbatim: this must detect producer key/boolean/byte drift.
describeEachProvider('RFC-395 converter to HTTP epoch-1 parity', (target) => {
  withR2TargetHarness(target, (source) => {
    afterEach(() => resetRouteMetaRegistry())
    test('historyRule → runConversion → sink rows → package reader → all four endpoints', async () => {
      resetRouteMetaRegistry()
      const root = mkdtempSync(join(tmpdir(), 'aw-h-history-roundtrip-'))
      try {
        const history = await loadFrozenEpoch1History()
        // PG catalog compilation requires the still-empty reference database and rolls back its DDL.
        const manifest = await loadSupportedSourceManifest(
          source.provider === 'sqlite'
            ? {}
            : {
                async postgresqlCatalog(version) {
                  const connection = await source.pool.reserve()
                  try {
                    return await compileEpoch1PostgresqlCatalog(connection, version)
                  } finally {
                    connection.release()
                  }
                },
              },
        )
        if (source.provider === 'sqlite')
          await installFrozenSqlite(source.sqlite, history.sqlite.length)
        else
          await migratePostgresqlSchema({
            runtime: source.runtime,
            headContract: frozenEpoch1Contract,
            plan: history.postgresql.head.plan,
          })
        const fixtures: Record<CodeHistoryQueryTable, readonly DecodedSourceRow[]> = {
          code_work_items: ['z-item', 'a-item', 'older-item'].map((id, i) =>
            frozenValues('code_work_items', {
              id,
              code_host_endpoint_id: 'ep',
              stable_project_id: 'project',
              capability: 'mr-review',
              anchor_kind: 'mr',
              anchor_id: id,
              status: 'settled',
              epoch: 3,
              created_at: NOW - (i === 2 ? 1 : 0),
              updated_at: NOW,
            }),
          ),
          code_work_rounds: ['published', 'failed', 'canceled', 'superseded'].map((outcome, i) =>
            frozenValues('code_work_rounds', {
              id: `round-${i}`,
              work_item_id: 'z-item',
              round_seq: i + 1,
              epoch: 3,
              outcome,
              started_at: NOW - 100 + i,
              ended_at: NOW,
              stage_contract_ver: 4,
            }),
          ),
          code_round_stages: [2, 0].map((i) =>
            frozenValues('code_round_stages', {
              id: `stage-${i}`,
              round_id: 'round-3',
              stage_seq: i,
              stage_name: `stage-${i}`,
              stage_kind: i === 0 ? 'script' : 'ai',
              status: i === 0 ? 'skipped' : 'failed',
              error: i === 0 ? null : 'verbatim\nerror',
              started_at: i === 0 ? null : NOW - 1,
              ended_at: NOW,
            }),
          ),
          code_ai_attempts: ['z-attempt', 'a-attempt'].map((id, i) =>
            frozenValues('code_ai_attempts', {
              id,
              round_id: 'round-3',
              stage_name: 'review',
              shard_key: i === 0 ? '' : 'src/a',
              rerun_seq: i,
              attempt_seq: 1,
              status: i === 0 ? 'failed' : 'validated',
              validation_outcome: i === 0 ? ' { "result": "raw" }\r\n' : null,
              node_run_id: i === 0 ? 'old-node' : null,
              started_at: NOW - 1,
              ended_at: NOW,
            }),
          ),
          code_trigger_deliveries: [true, false].map((isProbe, i) =>
            frozenValues('code_trigger_deliveries', {
              id: `delivery-${i}`,
              correlation_id: 'corr',
              stable_project_id: i === 0 ? 'project' : 'other',
              step: i === 0 ? 'received' : 'failed',
              outcome: i === 0 ? 'ok' : 'failed',
              is_probe: isProbe,
              created_at: NOW + i,
              updated_at: NOW + i,
            }),
          ),
          code_findings: [
            [NOW, NOW],
            [null, NOW],
            [NOW, null],
            [null, null],
          ].map(([resolvedAt, codeChangedAt], i) =>
            frozenValues('code_findings', {
              id: `finding-${i}`,
              capability: 'mr-review',
              fingerprint: `finding-${i}`,
              external_id: `thread-${i}`,
              resolved_at: resolvedAt!,
              code_changed_at: codeChangedAt!,
              created_at: NOW - 100,
            }),
          ),
        }
        for (const [table, rows] of Object.entries(fixtures))
          for (const row of rows) {
            const columns = Object.keys(row)
            await source.native.execute(
              `INSERT INTO ${source.table(table)} (${columns.map((column) => `"${column}"`).join(',')}) VALUES (${parameters(source.native, columns.length)})`,
              Object.values(row).map((value) =>
                typeof value === 'boolean' &&
                databaseProviderTraits(source.provider).booleanLiteral(true) === '1'
                  ? Number(value)
                  : value,
              ),
            )
          }
        const epoch1Db = (source.provider === 'sqlite'
          ? bindFrozenSqliteHandle(source.sqlite)
          : createFrozenPostgresqlClient(source.runtime)) as unknown as PersistenceDb
        const current = composeCodeHistoryQueries(target.db, createAgentExecutionQueries(target.db))
        const oracleQueries = createEpoch1HistoryQueries(epoch1Db)
        const oracle = historyApp({ ...current, ...oracleQueries })
        const paths = [
          '/api/code/work-items?endpointId=ep&projectId=project&capability=mr-review&limit=1&rounds=1',
          `/api/code/work-items?limit=1&cursor=${NOW}:z-item`,
          '/api/code/work-items?endpointId=missing',
          '/api/code/rounds/round-3/attempts',
          '/api/code/rounds/missing/attempts',
          '/api/code/deliveries?correlationId=corr&failedOnly=true&projectId=missing&limit=1',
          '/api/code/deliveries?projectId=project&limit=1',
          '/api/code/deliveries?failedOnly=true',
          '/api/code/metrics?windowMs=100',
          '/api/code/metrics?windowMs=99',
        ]
        const expected: unknown[] = []
        for (const path of paths) {
          const response = await oracle.request(path)
          expect(response.status).toBe(200)
          expected.push(await response.json())
        }
        expect(expected[0]).toMatchObject({ items: [{ workItemId: 'z-item', roundsHidden: 3 }] })
        expect(expected[3]).toMatchObject({
          attempts: [{ attemptId: 'z-attempt' }, { attemptId: 'a-attempt' }],
        })
        expect(expected[5]).toMatchObject({ deliveries: [{ isProbe: false }, { isProbe: true }] })
        expect(expected[8]).toMatchObject({ adoption: [{ published: 4 }], runs: [{ rounds: 4 }] })

        const reader =
          source.provider === 'sqlite'
            ? openEpoch1SqliteSource({ path: source.sqlitePath, manifest, operationRoot: root })
            : openEpoch1PostgresqlSource({ runtime: source.runtime, manifest, contentRoot: root })
        try {
          const preflight = await reader.preflight()
          const sink = new V2MemorySink()
          const result = await runConversion(
            {
              source: reader,
              preflight,
              target: persistenceSchema,
              contributions: [
                {
                  rules: Object.keys(fixtures).map((table) => historyRule(table)),
                  lookups: [fixtureLookup(HISTORY_ADOPTIONS, [])],
                  validators: [],
                },
              ],
              content: emptyV2Content,
              scratchRoot: join(root, 'scratch'),
              planTime: NOW,
              chunkLimit: 2,
              targetGeneration: 'dbg_h_history_target',
              candidateBuild: 'h-history-roundtrip',
              sourceBackupId: null,
              contentManifestDigest: 'fixture:no-content',
              sourceScope: Object.keys(fixtures),
            },
            sink,
          )
          expect(result.blocks).toEqual([])
          expect(sink.rows('code_history_archives')).toHaveLength(6)
          expect(sink.rows('code_history_id_index')).toHaveLength(
            Object.values(fixtures).reduce((n, rows) => n + rows.length, 0),
          )
          await installConvertedCodeHistory(target.db, sink)
          const packages = createCodeHistoryPackageReader({
            db: target.db,
            content: historyFixtureContent,
            installation: {
              kind: 'converted',
              source: {
                sourceGeneration: preflight.sourceGenerationId,
                contract: preflight.contract!,
              },
            },
          })
          // Look up by persisted source id, never by an id reconstructed with the runtime codec.
          for (const table of Object.keys(fixtures) as CodeHistoryQueryTable[])
            for (const row of fixtures[table])
              expect((await packages.find(table, String(row.id)))?.row.id).toBe(row.id)
          resetRouteMetaRegistry()
          const converted = historyApp(
            composeCodeHistoryQueries(target.db, createAgentExecutionQueries(target.db), packages),
          )
          for (const [i, path] of paths.entries()) {
            const response = await converted.request(path)
            expect(response.status).toBe(200)
            expect({ path, body: await response.json() }).toEqual({ path, body: expected[i] })
          }
        } finally {
          await reader.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }, 60_000)
  })
})
