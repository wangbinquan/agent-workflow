// RFC-602: cold history queries must consume a durable bounded projection. These
// tests exercise the owner initialization barrier, immutable archive evidence,
// recovery, keyset ranges and actual returned SQL rows on both native providers.
import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import {
  composeCodeHistoryQueries,
  createCodeHistoryIndexCommands,
  createCodeHistoryQueryReader,
} from '@/modules/code-capability/composition/historyQueries'
import {
  CODE_HISTORY_TABLES,
  decodeStoredCodeHistoryRecord,
  encodeStoredCodeHistoryRecord,
} from '@/modules/code-capability/domain/codeHistoryPackage'
import { projectCodeMetricsSummary } from '@/modules/code-capability/application/codeMetricsQuery'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { ContentRef } from '@/platform/content/contentRef'
import { describeEachProvider } from './helpers/eachProvider'
import {
  historyFixtureArchive,
  historyFixtureContent,
  historyFixtureReader,
  historyFixtureSource,
  preparedHistoryFixtureReader,
  seedCodeHistoryRows,
  seedEmptyCodeHistory,
} from './helpers/legacyCapabilitySeed'

// The PostgreSQL recorder includes its physical schema; SQLite omits it.
// Match the actual FROM target without dropping either provider's row budgets.
const selectedTable = (query: string) => /\bfrom\s+(?:"[^"]+"\.)?"([^"]+)"/i.exec(query)?.[1]

const NOW = 1_800_000_000_000
const installation = { kind: 'converted' as const, source: historyFixtureSource }
const item = (id: string, createdAt = NOW) => ({
  id,
  codeHostEndpointId: 'endpoint',
  stableProjectId: 'project',
  capability: 'review',
  anchorKind: 'mr',
  anchorId: id,
  status: 'open',
  epoch: 1,
  createdAt,
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('derived individual records preserve bytes, wide integers, booleans, null and raw evidence', () => {
  const record = {
    key: [{ type: 'text' as const, value: 'original' }],
    row: {
      id: 'original',
      bytes: new Uint8Array([0, 255, 65]),
      wide: 9007199254740993n,
      enabled: true,
      missing: null,
      ratio: 0.125,
      count: -12,
      largeReal: 1e30,
      negativeZero: -0,
    },
    raw: { source: { bytes: 'AP9B', wide: '9007199254740993' } },
  }
  const source = {
    sourceGeneration: 'codec-fixture',
    contract: {
      digest: 'codec-fixture',
      tables: [
        {
          id: 'code_artifacts',
          columns: Object.keys(record.row).map((name) => ({ name })),
          migrationKey: ['id'],
        },
      ],
    },
  }
  expect(
    decodeStoredCodeHistoryRecord(encodeStoredCodeHistoryRecord(record), 'code_artifacts', source),
  ).toEqual(record)
  expect(() => decodeStoredCodeHistoryRecord('{invalid', 'code_artifacts', source)).toThrow(
    'code-history-query-index-invalid',
  )
})

describeEachProvider('RFC-602 durable code history index', (h) => {
  const commands = (content = historyFixtureContent) =>
    createCodeHistoryIndexCommands({ db: h.db, installation, content })
  const cold = () => createCodeHistoryQueryReader({ db: h.db, installation })
  const compose = () =>
    composeCodeHistoryQueries(
      h.db,
      {
        async existingIds() {
          return []
        },
      },
      cold(),
    )

  test('fresh installations do not read or construct historical data', async () => {
    const content = {
      async read(): Promise<Uint8Array> {
        throw new Error('unexpected archive IO')
      },
    }
    const recording = h.recordStatements()
    try {
      const empty = { kind: 'fresh-install' as const }
      expect(
        await createCodeHistoryIndexCommands({
          db: h.db,
          installation: empty,
          content,
        }).initialize(),
      ).toEqual({
        kind: 'fresh-install',
        buildId: null,
        previousBuildId: null,
        reused: false,
        records: 0,
      })
      const reader = createCodeHistoryQueryReader({ db: h.db, installation: empty })
      expect(await reader.workItems.readPage({})).toEqual({ items: [], nextCursor: null })
      expect(await reader.find('code_work_items', 'missing')).toBeNull()
      expect(await reader.deliveries.byCorrelation('missing')).toEqual([])
      expect(await reader.metrics.loadSince(0)).toEqual({ findings: [], rounds: [] })
      expect(recording.statements).toEqual([])
    } finally {
      recording.stop()
    }
  })

  test('explicit initialization gates reads, validates all thirteen packages once, and a cold reader remains SELECT-only', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('retained'))
    const t = tablesOf(h.db)
    const beforeArchives = await h.db.select().from(t.codeHistoryArchives)
    const beforeIndex = await h.db.select().from(t.codeHistoryIdIndex)
    await expect(cold().workItems.readPage({})).rejects.toThrow(
      'code-history-query-index-not-ready',
    )
    const started = deferred()
    const release = deferred()
    let reads = 0
    const owner = commands({
      async read(ref: ContentRef) {
        reads += 1
        if (reads === 1) {
          started.resolve()
          await release.promise
        }
        return historyFixtureContent.read(ref)
      },
    })
    const building = owner.initialize()
    await started.promise
    expect(owner.initialize()).toBe(building)
    await expect(cold().find('code_work_items', 'retained')).rejects.toThrow(
      'code-history-query-index-not-ready',
    )
    release.resolve()
    const receipt = await building
    expect(receipt).toMatchObject({
      kind: 'ready',
      records: 1,
      reused: false,
      previousBuildId: null,
    })
    expect(reads).toBe(CODE_HISTORY_TABLES.length)
    const recording = h.recordStatements()
    try {
      // No content adapter or process cache is passed to this newly constructed reader.
      const reader = cold()
      expect((await reader.workItems.readPage({})).items.map((row) => row.workItemId)).toEqual([
        'retained',
      ])
      expect(await reader.find('code_work_items', 'retained')).toEqual(
        await historyFixtureReader(h.db).find('code_work_items', 'retained'),
      )
    } finally {
      recording.stop()
    }
    // The raw evidence comparison above intentionally reads the original archive;
    // isolate the actual cold request's budget below.
    const coldRecording = h.recordStatements()
    try {
      expect((await cold().find('code_work_items', 'retained'))?.row.id).toBe('retained')
      expect((await cold().workItems.readPage({})).items).toHaveLength(1)
    } finally {
      coldRecording.stop()
    }
    expect(coldRecording.statements.every(({ sql }) => /^\s*select\b/i.test(sql))).toBe(true)
    expect(coldRecording.statements.every(({ sql }) => !sql.includes('content_inline_bytes'))).toBe(
      true,
    )
    expect(
      coldRecording
        .selects()
        .filter(({ sql }) => selectedTable(sql) === 'code_history_query_records')
        .map(({ rows }) => rows),
    ).toEqual([1])
    expect(
      await commands({
        async read() {
          throw new Error('reuse must not reopen a package')
        },
      }).initialize(),
    ).toMatchObject({ buildId: receipt.buildId, reused: true, records: 1 })
    expect(await h.db.select().from(t.codeHistoryArchives)).toEqual(beforeArchives)
    expect(await h.db.select().from(t.codeHistoryIdIndex)).toEqual(beforeIndex)
  })

  test('failed content build stays unavailable, persists its diagnostic, and startup retries after repair', async () => {
    await seedCodeHistoryRows(h.db, 'code_ai_attempts', {
      id: 'attempt',
      roundId: 'round',
      stageName: 'review',
      shardKey: '',
      startedAt: NOW,
    })
    let reads = 0
    await expect(
      commands({
        async read(ref: ContentRef) {
          if (++reads === 3) throw new Error('archive-volume-offline')
          return historyFixtureContent.read(ref)
        },
      }).initialize(),
    ).rejects.toThrow('code-history-content-invalid')
    const t = tablesOf(h.db)
    const [state] = await h.db.select().from(t.codeHistoryQueryStates)
    expect(state).toMatchObject({
      state: 'unavailable',
      activeBuildId: null,
      failureCode: 'code-history-content-invalid',
    })
    expect(state?.failureDetail).toContain('archive-volume-offline')
    expect(await h.db.select().from(t.codeHistoryQueryRecords)).toEqual([])
    await expect(cold().attempts.load('round', 200)).rejects.toThrow(
      'code-history-query-index-not-ready',
    )
    const receipt = await commands().initialize()
    expect(receipt).toMatchObject({ kind: 'ready', records: 1, reused: false })
    expect((await cold().attempts.load('round', 200)).map((row) => row.attemptId)).toEqual([
      'attempt',
    ])
  })

  test('interrupted candidates never become visible and are reclaimed by startup', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('real'))
    const first = await commands().initialize()
    const t = tablesOf(h.db)
    await h.db
      .update(t.codeHistoryQueryBuilds)
      .set({ state: 'building', completedAt: null })
      .where(eq(t.codeHistoryQueryBuilds.id, first.buildId!))
    await h.db.update(t.codeHistoryQueryStates).set({ state: 'unavailable' })
    await expect(cold().workItems.readPage({})).rejects.toThrow(
      'code-history-query-index-not-ready',
    )
    const recovered = await commands().initialize()
    expect(recovered.buildId).not.toBe(first.buildId)
    expect(
      await h.db
        .select()
        .from(t.codeHistoryQueryRecords)
        .where(eq(t.codeHistoryQueryRecords.buildId, first.buildId!)),
    ).toEqual([])
    expect((await cold().workItems.readPage({})).items.map((row) => row.workItemId)).toEqual([
      'real',
    ])
  })

  test('forced rebuild detects changed original bytes, blocks stale success and can be retried without modifying evidence', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('real'))
    const t = tablesOf(h.db)
    const original = await h.db.select().from(t.codeHistoryArchives)
    const originalIndex = await h.db.select().from(t.codeHistoryIdIndex)
    const first = await commands().initialize()
    const archive = original.find((row) => row.sourceTable === 'code_work_items')!
    await h.db
      .update(t.codeHistoryArchives)
      .set({ contentInlineBytes: Buffer.from('broken') })
      .where(eq(t.codeHistoryArchives.id, archive.id))
    // Ready queries deliberately validate metadata, not the entire retained blob.
    expect((await cold().workItems.readPage({})).items).toHaveLength(1)
    await expect(commands().rebuild()).rejects.toThrow('code-history-content-invalid')
    await expect(cold().workItems.readPage({})).rejects.toThrow(
      'code-history-query-index-not-ready',
    )
    await h.db
      .update(t.codeHistoryArchives)
      .set({ contentInlineBytes: archive.contentInlineBytes })
      .where(eq(t.codeHistoryArchives.id, archive.id))
    const rebuilt = await commands().rebuild()
    expect(rebuilt).toMatchObject({ records: 1, reused: false, previousBuildId: first.buildId })
    expect(rebuilt.buildId).not.toBe(first.buildId)
    expect((await cold().workItems.readPage({})).items).toHaveLength(1)
    await commands().initialize() // Offline restart reclaims superseded payloads.
    expect(
      await h.db
        .select()
        .from(t.codeHistoryQueryRecords)
        .where(eq(t.codeHistoryQueryRecords.buildId, first.buildId!)),
    ).toEqual([])
    expect(await h.db.select().from(t.codeHistoryArchives)).toEqual(original)
    expect(await h.db.select().from(t.codeHistoryIdIndex)).toEqual(originalIndex)
  })

  test('source metadata changes abort publication, and a later explicit initialization admits the repaired source', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('real'))
    const t = tablesOf(h.db)
    const id = historyFixtureArchive('code_work_items', []).id
    const [original] = await h.db
      .select()
      .from(t.codeHistoryArchives)
      .where(eq(t.codeHistoryArchives.id, id))
    let mutated = false
    await expect(
      commands({
        async read(ref: ContentRef) {
          if (!mutated) {
            mutated = true
            await h.db
              .update(t.codeHistoryArchives)
              .set({ contentRefJson: `${original!.contentRefJson} ` })
              .where(eq(t.codeHistoryArchives.id, id))
          }
          return historyFixtureContent.read(ref)
        },
      }).initialize(),
    ).rejects.toThrow('code-history-query-source-changed')
    await expect(cold().workItems.readPage({})).rejects.toThrow(
      'code-history-query-index-not-ready',
    )
    expect(await commands().initialize()).toMatchObject({ kind: 'ready', records: 1 })
    expect((await cold().workItems.readPage({})).items).toHaveLength(1)
  })

  test('source generation selects only its own archive indexes, including two generations under one frozen contract', async () => {
    const other = { ...historyFixtureSource, sourceGeneration: 'another-import' }
    await seedCodeHistoryRows(h.db, 'code_work_items', item('ours'))
    await seedCodeHistoryRows(h.db, 'code_work_items', item('theirs'), other)
    await commands().initialize()
    expect((await cold().workItems.readPage({})).items.map((row) => row.workItemId)).toEqual([
      'ours',
    ])
    const otherReader = await preparedHistoryFixtureReader(h.db, other)
    expect((await otherReader.workItems.readPage({})).items.map((row) => row.workItemId)).toEqual([
      'theirs',
    ])
    expect((await cold().find('code_work_items', 'ours'))?.row.id).toBe('ours')
  })

  test('original-ID lookup distinguishes a truly missing id from a damaged legacy ID index after readiness', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('real'))
    await commands().initialize()
    const t = tablesOf(h.db)
    expect(await cold().find('code_work_items', 'absent')).toBeNull()
    const recording = h.recordStatements()
    try {
      expect((await cold().find('code_work_items', 'real'))?.row.id).toBe('real')
    } finally {
      recording.stop()
    }
    expect(
      recording
        .selects()
        .filter(({ sql }) => selectedTable(sql) === 'code_history_query_records')
        .map(({ rows }) => rows),
    ).toEqual([1])
    expect(recording.selects().every(({ sql }) => !sql.includes('content_inline_bytes'))).toBe(true)
    await h.db
      .delete(t.codeHistoryIdIndex)
      .where(
        and(
          eq(t.codeHistoryIdIndex.sourceTable, 'code_work_items'),
          eq(t.codeHistoryIdIndex.originalId, 'real'),
        ),
      )
    await expect(cold().find('code_work_items', 'real')).rejects.toThrow(
      'code-history-index-invalid',
    )
    expect(await cold().find('code_work_items', 'absent')).toBeNull()
    await expect(commands().rebuild()).rejects.toThrow('code-history-index-invalid')
  })

  test('a damaged individual derived record fails explicitly and force rebuild restores it from retained evidence', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('real'))
    const built = await commands().initialize()
    const t = tablesOf(h.db)
    await h.db
      .update(t.codeHistoryQueryRecords)
      .set({ recordPayloadJson: '{broken' })
      .where(
        and(
          eq(t.codeHistoryQueryRecords.buildId, built.buildId!),
          eq(t.codeHistoryQueryRecords.originalId, 'real'),
        ),
      )
    await expect(cold().find('code_work_items', 'real')).rejects.toThrow(
      'code-history-query-index-invalid',
    )
    await commands().rebuild()
    expect((await cold().find('code_work_items', 'real'))?.row.id).toBe('real')
  })

  test('point reads validate canonical columns and row identity without reopening the original package', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('real'))
    const built = await commands().initialize()
    const t = tablesOf(h.db)
    const where = and(
      eq(t.codeHistoryQueryRecords.buildId, built.buildId!),
      eq(t.codeHistoryQueryRecords.sourceTable, 'code_work_items'),
      eq(t.codeHistoryQueryRecords.originalId, 'real'),
    )
    const [original] = await h.db.select().from(t.codeHistoryQueryRecords).where(where)
    const expected = await historyFixtureReader(h.db).find('code_work_items', 'real')
    for (const damage of [
      'wrong-id',
      'missing-id',
      'missing-column',
      'duplicate-column',
      'extra-column',
    ] as const) {
      const payload = JSON.parse(original!.recordPayloadJson) as {
        values: Array<[string, unknown]>
      }
      if (damage === 'wrong-id')
        payload.values = payload.values.map(([name, cell]): [string, unknown] => [
          name,
          name === 'id' ? { type: 'text', value: 'different-id' } : cell,
        ])
      else if (damage === 'missing-id')
        payload.values = payload.values.filter(([name]) => name !== 'id')
      else if (damage === 'missing-column')
        payload.values = payload.values.filter(([name]) => name !== 'status')
      else if (damage === 'duplicate-column') payload.values.push(payload.values[0]!)
      else payload.values.push(['not_in_source', { type: 'null' }])
      await h.db
        .update(t.codeHistoryQueryRecords)
        .set({ recordPayloadJson: JSON.stringify(payload) })
        .where(where)
      const recording = h.recordStatements()
      try {
        await expect(cold().find('code_work_items', 'real'), damage).rejects.toThrow(
          'code-history-query-index-invalid',
        )
      } finally {
        recording.stop()
      }
      expect(
        recording
          .selects()
          .filter(({ sql }) => selectedTable(sql) === 'code_history_query_records')
          .map(({ rows }) => rows),
      ).toEqual([1])
      expect(recording.selects().every(({ sql }) => !sql.includes('content_inline_bytes'))).toBe(
        true,
      )
    }
    await h.db
      .update(t.codeHistoryQueryRecords)
      .set({ recordPayloadJson: original!.recordPayloadJson })
      .where(where)
    expect(await cold().find('code_work_items', 'real')).toEqual(expected)
  })

  test('invalid original query rows retain their diagnostic instead of publishing an empty projection', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', {
      ...item('bad'),
      status: null as unknown as string,
    })
    await expect(commands().initialize()).rejects.toThrow('code-history-row-invalid')
    const t = tablesOf(h.db)
    const [state] = await h.db.select().from(t.codeHistoryQueryStates)
    expect(state).toMatchObject({ state: 'unavailable', failureCode: 'code-history-row-invalid' })
    expect(await h.db.select().from(t.codeHistoryQueryWorkItems)).toEqual([])
    await expect(cold().workItems.readPage({})).rejects.toThrow(
      'code-history-query-index-not-ready',
    )
  })

  test('deep work-item pagination uses the full descending tuple range and preserves Unicode ties and filter scope', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', [
      ...Array.from({ length: 2200 }, (_, index) => item(`new-${index}`, NOW + 100 + index)),
      item('z'),
      item('ä'),
      item('😀'),
      item('a'),
      item('last', NOW - 1),
      { ...item('foreign', NOW + 1), capability: 'repair' },
    ])
    await commands().initialize()
    const recording = h.recordStatements()
    try {
      const page = await cold().workItems.readPage({
        codeHostEndpointId: 'endpoint',
        stableProjectId: 'project',
        capability: 'review',
        limit: 2,
        cursor: `${NOW + 1}:boundary`,
      })
      expect(page.items.map((row) => row.workItemId)).toEqual(['😀', 'ä'])
      expect(page.nextCursor).toBe(`${NOW}:ä`)
      const next = await cold().workItems.readPage({
        codeHostEndpointId: 'endpoint',
        stableProjectId: 'project',
        capability: 'review',
        limit: 2,
        cursor: page.nextCursor,
      })
      expect(next.items.map((row) => row.workItemId)).toEqual(['z', 'a'])
      expect(next.nextCursor).toBe(`${NOW}:a`)
      expect(
        (
          await cold().workItems.readPage({
            codeHostEndpointId: 'endpoint',
            stableProjectId: 'project',
            capability: 'review',
            limit: 2,
            cursor: next.nextCursor,
          })
        ).items.map((row) => row.workItemId),
      ).toEqual(['last'])
    } finally {
      recording.stop()
    }
    const selections = recording
      .selects()
      .filter(({ sql }) => selectedTable(sql) === 'code_history_query_work_items')
    expect(selections.map(({ rows }) => rows)).toEqual([3, 3, 1])
    for (const statement of selections) {
      expect(statement.sql).toMatch(
        /\((?:"[^"]+"\.)?"code_history_query_work_items"\."created_at", (?:"[^"]+"\.)?"code_history_query_work_items"\."id_order_key"\) </,
      )
      const plan = await h.explain(statement)
      expect(plan).toContain('idx_code_history_query_items_page_7')
      if (h.capabilities.isolation !== 'exclusive') {
        const indexConditions = plan
          .split('\n')
          .filter((line) => line.includes('Index Cond:'))
          .join('\n')
        expect(indexConditions).toMatch(/created_at[\s\S]*id_order_key[\s\S]*</)
      }
      expect(plan).not.toMatch(
        /Seq Scan on code_history_query_work_items|SCAN code_history_query_work_items\b(?! USING)/,
      )
    }
    expect(recording.selects().every(({ sql }) => !sql.includes('content_inline_bytes'))).toBe(true)
  }, 30_000)

  test('item and round windows fetch only the selected projection, with all stages of selected rounds and at most 200 attempts', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', [
      item('wanted'),
      ...Array.from({ length: 400 }, (_, index) => item(`noise-${index}`, NOW - 1 - index)),
    ])
    await seedCodeHistoryRows(
      h.db,
      'code_work_rounds',
      Array.from({ length: 25 }, (_, index) => ({
        id: `round-${index}`,
        workItemId: 'wanted',
        roundSeq: index,
        outcome: index === 24 ? null : 'published',
        startedAt: NOW + index,
        endedAt: index === 24 ? null : NOW + index + 1,
      })),
    )
    await seedCodeHistoryRows(h.db, 'code_round_stages', [
      ...Array.from({ length: 230 }, (_, index) => ({
        id: `stage-${String(index).padStart(3, '0')}`,
        roundId: 'round-24',
        stageName: `stage-${index}`,
        stageSeq: index,
        stageKind: 'program',
        status: 'done',
      })),
      {
        id: 'hidden-stage',
        roundId: 'round-0',
        stageName: 'hidden',
        stageSeq: 0,
        stageKind: 'program',
        status: 'done',
      },
    ])
    await seedCodeHistoryRows(
      h.db,
      'code_ai_attempts',
      Array.from({ length: 250 }, (_, index) => ({
        id: `attempt-${index}`,
        roundId: 'round-24',
        stageName: 'review',
        shardKey: '',
        startedAt: NOW + index,
        rerunSeq: 0,
        attemptSeq: index,
      })),
    )
    await commands().initialize()
    const recording = h.recordStatements()
    try {
      const result = await compose().workItems.page({ limit: 1, roundLimit: 1000 })
      expect(result.items[0]).toMatchObject({ workItemId: 'wanted', roundsHidden: 5 })
      expect(result.items[0]?.rounds.map((row) => row.roundId)).toEqual(
        Array.from({ length: 20 }, (_, index) => `round-${24 - index}`),
      )
      expect(result.items[0]?.rounds[0]?.stages.map((row) => row.stageName)).toEqual(
        Array.from({ length: 230 }, (_, index) => `stage-${index}`),
      )
      expect((await compose().attempts.forRound('round-24')).map((row) => row.attemptId)).toEqual(
        Array.from({ length: 200 }, (_, index) => `attempt-${index}`),
      )
    } finally {
      recording.stop()
    }
    const counts = (table: string) =>
      recording
        .selects()
        .filter(({ sql }) => selectedTable(sql) === table)
        .map(({ rows }) => rows)
    expect(counts('code_history_query_work_items')).toEqual([2])
    expect(counts('code_history_query_rounds')).toEqual([20])
    expect(counts('code_history_query_stages')).toEqual([230]) // output-sized stages remain complete
    expect(counts('code_history_query_attempts')).toEqual([200])
    expect(recording.selects().every(({ sql }) => !sql.includes('content_inline_bytes'))).toBe(true)
  })

  test('correlation chains and negative-limit history retain all matches through bounded mixed-order batches', async () => {
    await seedCodeHistoryRows(h.db, 'code_trigger_deliveries', [
      ...Array.from({ length: 405 }, (_, index) => ({
        id: `d-${String(index).padStart(4, '0')}`,
        correlationId: 'trace',
        stableProjectId: 'project',
        step: 'published',
        outcome: 'failed',
        reason: `reason-${index}`,
        createdAt: index < 402 ? NOW : NOW - 1,
        updatedAt: NOW,
      })),
      ...Array.from({ length: 600 }, (_, index) => ({
        id: `unrelated-${index}`,
        correlationId: 'other',
        stableProjectId: 'other',
        step: 'received',
        outcome: 'ok',
        createdAt: NOW + index,
        updatedAt: NOW,
      })),
    ])
    await commands().initialize()
    const recording = h.recordStatements()
    try {
      expect((await compose().deliveries.forCorrelation('trace')).map((row) => row.id)).toEqual(
        Array.from({ length: 405 }, (_, index) => `d-${String(index).padStart(4, '0')}`),
      )
      expect(
        (await compose().deliveries.failures({ stableProjectId: 'project', limit: -1 })).map(
          (row) => row.id,
        ),
      ).toEqual(Array.from({ length: 405 }, (_, index) => `d-${String(index).padStart(4, '0')}`))
    } finally {
      recording.stop()
    }
    const selections = recording
      .selects()
      .filter(({ sql }) => selectedTable(sql) === 'code_history_query_deliveries')
    expect(selections.length).toBeLessThanOrEqual(10)
    expect(selections.every(({ rows }) => rows <= 200)).toBe(true)
    expect(selections.reduce((sum, { rows }) => sum + rows, 0)).toBe(810)
    expect(selections.every(({ sql }) => !/\bor\b/i.test(sql))).toBe(true)
    expect(await cold().deliveries.recent({ stableProjectId: 'project', limit: 0 })).toEqual([])
  })

  test('metrics prefixes preserve timestamp inclusion, four adoption buckets, outcome priority and the historical inner join', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', item('work'))
    await seedCodeHistoryRows(h.db, 'code_findings', [
      {
        id: 'adopted',
        capability: 'review',
        externalId: 'a',
        createdAt: NOW,
        resolvedAt: NOW,
        codeChangedAt: NOW,
      },
      {
        id: 'quiet',
        capability: 'review',
        externalId: 'b',
        createdAt: NOW,
        resolvedAt: null,
        codeChangedAt: NOW,
      },
      {
        id: 'disagreed',
        capability: 'review',
        externalId: 'c',
        createdAt: NOW + 1,
        resolvedAt: NOW,
        codeChangedAt: null,
      },
      {
        id: 'outstanding',
        capability: 'review',
        externalId: 'd',
        createdAt: NOW + 1,
        resolvedAt: null,
        codeChangedAt: null,
      },
      { id: 'unpublished', capability: 'review', externalId: null, createdAt: NOW + 1 },
      ...Array.from({ length: 1000 }, (_, index) => ({
        id: `old-${index}`,
        capability: 'review',
        externalId: `old-${index}`,
        createdAt: NOW - 1000 - index,
      })),
    ])
    await seedCodeHistoryRows(h.db, 'code_work_rounds', [
      {
        id: 'published',
        workItemId: 'work',
        roundSeq: 1,
        outcome: 'published',
        startedAt: NOW,
        endedAt: NOW,
      },
      {
        id: 'failed',
        workItemId: 'work',
        roundSeq: 2,
        outcome: 'failed',
        startedAt: NOW,
        endedAt: NOW,
      },
      {
        id: 'awaiting',
        workItemId: 'work',
        roundSeq: 3,
        outcome: 'awaiting',
        startedAt: NOW + 1,
        endedAt: null,
      },
      {
        id: 'incomplete',
        workItemId: 'work',
        roundSeq: 4,
        outcome: 'legacy-other',
        startedAt: NOW + 1,
        endedAt: NOW + 2,
      },
      {
        id: 'live',
        workItemId: 'work',
        roundSeq: 5,
        outcome: null,
        startedAt: NOW + 1,
        endedAt: null,
      },
      {
        id: 'orphan',
        workItemId: 'missing',
        roundSeq: 6,
        outcome: 'published',
        startedAt: NOW + 1,
        endedAt: NOW + 2,
      },
    ])
    await commands().initialize()
    const recording = h.recordStatements()
    try {
      const first = await cold().metrics.loadSince(NOW)
      expect(projectCodeMetricsSummary({ windowMs: 1, ...first })).toEqual({
        windowMs: 1,
        adoption: [
          {
            capability: 'review',
            published: 4,
            adopted: 1,
            quietFix: 1,
            disagreed: 1,
            outstanding: 1,
          },
        ],
        runs: [
          { capability: 'review', rounds: 5, published: 1, failed: 1, awaiting: 1, incomplete: 1 },
        ],
      })
      expect(
        projectCodeMetricsSummary({ windowMs: 0, ...(await cold().metrics.loadSince(NOW + 1)) }),
      ).toEqual({
        windowMs: 0,
        adoption: [
          {
            capability: 'review',
            published: 2,
            adopted: 0,
            quietFix: 0,
            disagreed: 1,
            outstanding: 1,
          },
        ],
        runs: [
          { capability: 'review', rounds: 3, published: 0, failed: 0, awaiting: 1, incomplete: 1 },
        ],
      })
      expect(await cold().metrics.loadSince(NOW + 2)).toEqual({ findings: [], rounds: [] })
    } finally {
      recording.stop()
    }
    expect(
      recording
        .selects()
        .filter(({ sql }) =>
          ['code_history_metric_totals', 'code_history_metric_prefixes'].includes(
            selectedTable(sql) ?? '',
          ),
        )
        .map(({ rows }) => rows),
    ).toEqual([1, 1, 1, 1, 1, 1])
    expect(
      recording
        .selects()
        .every(
          ({ sql }) =>
            ![
              'code_history_query_records',
              'code_history_query_work_items',
              'code_history_query_rounds',
            ].includes(selectedTable(sql) ?? ''),
        ),
    ).toBe(true)
    expect(recording.selects().every(({ sql }) => !sql.includes('content_inline_bytes'))).toBe(true)
  }, 30_000)

  test('metadata loss is explicit and empty retained archives are a ready empty history', async () => {
    await expect(commands().initialize()).rejects.toThrow('code-history-package-missing')
    await seedEmptyCodeHistory(h.db)
    expect(await commands().initialize()).toMatchObject({ kind: 'ready', records: 0 })
    expect(await cold().workItems.readPage({})).toEqual({ items: [], nextCursor: null })
    const t = tablesOf(h.db)
    await h.db
      .delete(t.codeHistoryArchives)
      .where(eq(t.codeHistoryArchives.id, historyFixtureArchive('code_findings', []).id))
    await expect(cold().metrics.loadSince(0)).rejects.toThrow('code-history-package-missing')
  })

  test('metrics normalize fractional and out-of-domain cutoffs before binding integer timestamps', async () => {
    await seedCodeHistoryRows(h.db, 'code_findings', [
      { id: 'old', capability: 'review', externalId: 'old', createdAt: NOW - 1 },
      { id: 'now', capability: 'review', externalId: 'now', createdAt: NOW },
    ])
    await commands().initialize()
    const recording = h.recordStatements()
    try {
      const fractional = await cold().metrics.loadSince(NOW - 0.5)
      expect(projectCodeMetricsSummary({ windowMs: 0.5, ...fractional })).toEqual({
        windowMs: 0.5,
        adoption: [
          {
            capability: 'review',
            published: 1,
            adopted: 0,
            quietFix: 0,
            disagreed: 0,
            outstanding: 1,
          },
        ],
        runs: [],
      })
      const all = await cold().metrics.loadSince(-Number.MAX_VALUE)
      expect(projectCodeMetricsSummary({ windowMs: Number.MAX_VALUE, ...all })).toEqual({
        windowMs: Number.MAX_VALUE,
        adoption: [
          {
            capability: 'review',
            published: 2,
            adopted: 0,
            quietFix: 0,
            disagreed: 0,
            outstanding: 2,
          },
        ],
        runs: [],
      })
      expect(await cold().metrics.loadSince(Number.MAX_VALUE)).toEqual({ findings: [], rounds: [] })
      expect(await cold().metrics.loadSince(Number.NaN)).toEqual({ findings: [], rounds: [] })
    } finally {
      recording.stop()
    }
    const prefixReads = recording
      .selects()
      .filter(({ sql }) => selectedTable(sql) === 'code_history_metric_prefixes')
    expect(prefixReads).toHaveLength(1)
    expect(prefixReads[0]?.values).toContain(NOW)
    expect(
      recording
        .selects()
        .flatMap(({ values }) => values)
        .every((value) => typeof value !== 'number' || Number.isSafeInteger(value)),
    ).toBe(true)
  })

  for (const failureAt of ['publish-pointer', 'supersede-previous'] as const) {
    test(`publication failure at ${failureAt} rolls back all ready transitions before persisting failure`, async () => {
      await seedCodeHistoryRows(h.db, 'code_work_items', item('retained'))
      const first = await commands().initialize()
      const t = tablesOf(h.db)
      const [beforeBuild] = await h.db
        .select()
        .from(t.codeHistoryQueryBuilds)
        .where(eq(t.codeHistoryQueryBuilds.id, first.buildId!))
      const beforeRecords = await h.db
        .select()
        .from(t.codeHistoryQueryRecords)
        .where(eq(t.codeHistoryQueryRecords.buildId, first.buildId!))
      // Fail a real SQL statement after earlier publication writes have run.
      // A synchronous SQLite transaction wrapper would have already committed
      // those writes at its first await; a native trigger makes that observable.
      const table =
        failureAt === 'publish-pointer' ? 'code_history_query_states' : 'code_history_query_builds'
      const state = failureAt === 'publish-pointer' ? 'ready' : 'superseded'
      const trigger = 'rfc602_fail_history_publication'
      const exclusive = h.capabilities.isolation === 'exclusive'
      const create = exclusive
        ? [
            `CREATE TRIGGER ${trigger} BEFORE UPDATE ON ${table}
            WHEN NEW.state = '${state}' BEGIN SELECT RAISE(ABORT, 'forced history publication failure'); END`,
          ]
        : [
            `CREATE FUNCTION agent_workflow.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.state = '${state}' THEN RAISE EXCEPTION 'forced history publication failure'; END IF;
            RETURN NEW; END; $$`,
            `CREATE TRIGGER ${trigger} BEFORE UPDATE ON agent_workflow.${table}
            FOR EACH ROW EXECUTE FUNCTION agent_workflow.${trigger}()`,
          ]
      const drop = exclusive
        ? [`DROP TRIGGER ${trigger}`]
        : [
            `DROP TRIGGER ${trigger} ON agent_workflow.${table}`,
            `DROP FUNCTION agent_workflow.${trigger}()`,
          ]
      for (const statement of create) await h.executeFixtureDdl(statement)
      try {
        await expect(
          commands()
            .rebuild()
            .catch((error: unknown) => {
              let cause = error
              while (cause instanceof Error && cause.cause instanceof Error) cause = cause.cause
              throw cause
            }),
        ).rejects.toThrow('forced history publication failure')
        const [stateRow] = await h.db.select().from(t.codeHistoryQueryStates)
        expect(stateRow).toMatchObject({
          state: 'unavailable',
          activeBuildId: first.buildId,
          failureCode: 'code-history-query-build-failed',
        })
        expect(stateRow?.lastAttemptId).not.toBe(first.buildId)
        const [failed] = await h.db
          .select()
          .from(t.codeHistoryQueryBuilds)
          .where(eq(t.codeHistoryQueryBuilds.id, stateRow!.lastAttemptId!))
        // Both the pointer and the earlier counts/ready write must have rolled
        // back. The catch path records failure, but cannot repair a committed
        // activeBuildId or reset a prematurely committed countsJson.
        expect(failed).toMatchObject({ state: 'failed', countsJson: '{}' })
        expect(
          (
            await h.db
              .select()
              .from(t.codeHistoryQueryBuilds)
              .where(eq(t.codeHistoryQueryBuilds.id, first.buildId!))
          )[0],
        ).toEqual(beforeBuild)
        expect(
          await h.db
            .select()
            .from(t.codeHistoryQueryRecords)
            .where(eq(t.codeHistoryQueryRecords.buildId, first.buildId!)),
        ).toEqual(beforeRecords)
        expect(
          await h.db
            .select()
            .from(t.codeHistoryQueryRecords)
            .where(eq(t.codeHistoryQueryRecords.buildId, failed!.id)),
        ).toEqual([])
        await expect(cold().workItems.readPage({})).rejects.toThrow(
          'code-history-query-index-not-ready',
        )
      } finally {
        for (const statement of drop) await h.executeFixtureDdl(statement)
      }
      expect(await commands().initialize()).toMatchObject({ kind: 'ready', records: 1 })
      expect((await cold().workItems.readPage({})).items.map((row) => row.workItemId)).toEqual([
        'retained',
      ])
    })
  }
})
