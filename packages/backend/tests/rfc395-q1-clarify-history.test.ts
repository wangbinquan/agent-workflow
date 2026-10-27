import { initializeClarifyHistory } from '@/modules/collaboration/composition/clarifyHistory'
import { readClarifyHistory } from '@/modules/collaboration/infrastructure/clarifyHistoryProjection'
import { setDefaultTimeout, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import {
  workflowFixture,
  taskFixture,
  nodeRunFixture,
  clarifyRoundFixture,
  patchTaskFixture,
} from './helpers/model'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import {
  readDispositionArchives,
  initializeDispositionArchives,
} from '@/platform/persistence/schema/history/dispositionArchive'
import { createProviderHttpApplication } from './helpers/providerHttpApplication'
import {
  getClarifyRoundDetail,
  countAwaitingClarifyRounds,
  listClarifyRounds,
  listClarifyRoundSummaries,
} from '@/modules/collaboration/infrastructure/clarifyRounds'
import { createClarifyAnswerQueries } from '@/modules/collaboration/infrastructure/clarifyAnswerQueries'
import {
  createTaskArchiveCollaborationSectionReader,
  createTaskRecoveryHumanGateFacts,
  createTaskNodeRunClarifyNav,
} from '@/modules/collaboration/infrastructure/taskCollaborationReads'
import { createCollaborationTaskAccessPort } from '@/modules/collaboration/infrastructure/collaborationTaskAccess'
import { buildActor } from '@/auth/actor'
import { ClarifyRoundSchema } from '@agent-workflow/shared'

// Slowest case took 3.38 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

const definition = '{"$schema_version":6,"inputs":[],"nodes":[],"edges":[]}'
const answers =
  '[{"questionId":"q","selectedOptionIndices":[],"selectedOptionLabels":[],"customText":"original"}]'
const drafts = '{"q":{"selectedOptionIndices":[],"customText":"draft"}}'
const attrs = '{"q":{"userId":"u","role":"owner","updatedAt":8}}'
const values = {
  id: 'archived-round',
  task_id: 't',
  kind: 'self',
  asking_node_id: 'agent',
  asking_node_run_id: 'asking',
  asking_shard_key: null,
  intermediary_node_id: 'clarify',
  intermediary_node_run_id: 'carrier',
  target_consumer_node_id: null,
  loop_iter: 0,
  container_run_id: null,
  iteration: 0,
  questions_json: '[]',
  answers_json: answers,
  draft_answers_json: drafts,
  answer_attributions_json: attrs,
  directive: 'continue',
  status: 'answered',
  truncation_warnings_json: null,
  designer_run_triggered_at: null,
  abandoned_at: null,
  created_at: 5,
  answered_at: 8,
  answered_by: 'u',
  submitted_by_role: 'owner',
}

describeEachProvider('RFC-395 Q-1 disposition history projection', (h) => {
  async function seed(overrides: Partial<typeof values> = {}) {
    await workflowFixture(h.db, { id: 'w', name: 'Workflow', definition })
    await taskFixture(h.db, {
      id: 't',
      workflowId: 'w',
      workflowSnapshot: definition,
      status: 'done',
      startedAt: 1,
      repoPath: '',
      worktreePath: '',
      baseBranch: '',
      branch: '',
      inputs: '{}',
    })
    const meta = (name: string) => sql.raw(metaTableName(engineOf(h.db).provider, name))
    const bytes = Buffer.from(
      encodeStagedValue({
        table: 'clarify_rounds',
        encodedKey: 'key',
        phase: 'current',
        values: { ...values, ...overrides },
      }),
    )
    await rawRows(
      h.db,
      sql`UPDATE ${meta('generations')} SET run_id = 'q1-run' WHERE state = 'active'`,
    )
    await rawRows(
      h.db,
      sql`INSERT INTO ${meta('migration_archives')}
      (run_id, archive_ref, unit_id, kind, source_table, format, rows, byte_size, bytes)
      VALUES ('q1-run', 'archive', 'unit', 'source-journal', 'clarify_rounds', 'logical-row@1', 1, ${bytes.length}, ${bytes})`,
    )
    await rawRows(
      h.db,
      sql`INSERT INTO ${meta('migration_row_dispositions')}
      (run_id, source_table, source_phase, source_key, ordinal, unit_id, class, kind, rule_id, rule_version, targets_json, archive_ref)
      VALUES ('q1-run', 'clarify_rounds', 'current', 'key', 0, 'unit', 'archived', 'history-only', 'fixture', 1, '[]', 'archive')`,
    )
    return { meta, bytes }
  }
  test('history detail/list/export/access retain answers, drafts and attribution without activating a round', async () => {
    const { bytes } = await seed()
    await initializeClarifyHistory(h.db)
    const detail = ClarifyRoundSchema.parse(await getClarifyRoundDetail(h.db, 'carrier'))
    expect(detail).toMatchObject({
      id: 'archived-round',
      answers: JSON.parse(answers),
      draftAnswers: JSON.parse(drafts),
      answerAttributions: JSON.parse(attrs),
    })
    expect(
      (await listClarifyRoundSummaries(h.db, { taskId: 't', status: 'all' })).map((r) => r.id),
    ).toEqual(['archived-round'])
    expect(
      (await createTaskNodeRunClarifyNav(h.db).latestRoundStatusByRun('t')).get('carrier'),
    ).toBe('answered')
    const query = createClarifyAnswerQueries(h.db)
    expect(await query.listSelfQuestions(['archived-round'])).toEqual([
      { id: 'archived-round', taskId: 't', questionsJson: '[]' },
    ])
    expect((await query.listSelfSources(['archived-round']))[0]?.answers).toMatchObject({
      kind: 'answers',
    })
    const actor = buildActor({
      user: { id: 'u', username: 'u', displayName: 'u', role: 'admin', status: 'active' },
      source: 'session',
    })
    expect(
      await createCollaborationTaskAccessPort(h.db).resolveClarifyRoundTask(actor, 'carrier'),
    ).toMatchObject({ roundExists: true, taskId: 't', visible: true })
    const section = await h.session.snapshotRead((tx) =>
      createTaskArchiveCollaborationSectionReader().load(tx, ['t']),
    )
    expect(section.rows.clarify_rounds).toEqual([])
    expect(section.dispositionEvidence?.[0]?.bytes).toEqual(Uint8Array.from(bytes))
    expect(await createTaskRecoveryHumanGateFacts(h.db).lifecycleClarifyRounds(['t'])).toEqual([])
    await h.db.delete(tablesOf(h.db).tasks).where(eq(tablesOf(h.db).tasks.id, 't'))
    expect(await listClarifyRoundSummaries(h.db, { status: 'all' })).toEqual([])
  })
  test('missing archive bytes are a conversion defect, not an empty history result', async () => {
    const { meta } = await seed()
    await rawRows(h.db, sql`DELETE FROM ${meta('migration_archives')} WHERE run_id = 'q1-run'`)
    await expect(initializeClarifyHistory(h.db)).rejects.toThrow('disposition-archive-missing:key')
    await expect(readDispositionArchives(h.db, 'clarify_rounds')).rejects.toThrow(
      'disposition-archive-missing:key',
    )
  })

  // BF-D22: a converted installation must keep the RFC-311 poll cost and SQL window.
  test('BF-D22 inbox status and kind eliminate unmatched history before any live checks', async () => {
    await seed()
    await initializeClarifyHistory(h.db)
    for (const filter of [
      {},
      { status: 'awaiting_human' },
      { status: 'all', kind: 'cross' },
    ] as const) {
      const recording = h.recordStatements()
      try {
        expect(await listClarifyRoundSummaries(h.db, filter)).toEqual([])
      } finally {
        recording.stop()
      }
      expect(recording.statements).toHaveLength(1)
      expect(recording.statements[0]?.sql).not.toContain('workflow_snapshot')
    }
    const recording = h.recordStatements()
    try {
      expect(
        (await readClarifyHistory(h.db, { status: 'answered', kind: 'self' })).map((r) => r.id),
      ).toEqual(['archived-round'])
    } finally {
      recording.stop()
    }
    expect(recording.statements).toHaveLength(2)
    expect(
      recording.statements.every(
        (row) => !/workflow_snapshot|frozen_definition_json/.test(row.sql),
      ),
    ).toBe(true)
  })

  test('BF-D22 explicit-status pages bound live rows before merging history and preserve newest-first order', async () => {
    await seed({ created_at: 15 })
    for (const [id, createdAt] of [
      ['old', 1],
      ['middle', 10],
      ['new', 20],
    ] as const) {
      await nodeRunFixture(h.db, { id, taskId: 't', nodeId: id, status: 'done' })
      await clarifyRoundFixture(h.db, {
        id,
        taskId: 't',
        kind: 'self',
        askingNodeId: id,
        askingNodeRunId: id,
        intermediaryNodeId: id,
        intermediaryNodeRunId: id,
        questions: '[]',
        status: 'answered',
        createdAt,
      })
    }
    await initializeClarifyHistory(h.db)
    for (const status of ['answered', 'all'] as const) {
      const recording = h.recordStatements()
      try {
        expect(
          (await listClarifyRoundSummaries(h.db, { status, limit: 2 })).map((row) => row.id),
        ).toEqual(['new', 'archived-round'])
      } finally {
        recording.stop()
      }
      const live = recording.statements.find(
        (row) => row.sql.includes('"clarify_rounds"') && /order by/i.test(row.sql),
      )
      expect(live).toBeDefined()
      expect(live!.sql).toMatch(/limit/i)
      expect(live!.rows).toBe(2)
      expect(live!.values.at(-1)).toBe(2)
    }
  })

  test('BF-D23 failed lazy and initialized archive loads retry on the same handle', async () => {
    const { meta, bytes } = await seed()
    for (const mode of ['lazy', 'initialized'] as const) {
      await rawRows(h.db, sql`DELETE FROM ${meta('migration_archives')} WHERE run_id = 'q1-run'`)
      // Re-admit the restored harness connection before exercising each load path.
      await expect(initializeClarifyHistory(h.db)).rejects.toThrow(
        'disposition-archive-missing:key',
      )
      if (mode === 'lazy')
        await expect(readClarifyHistory(h.db)).rejects.toThrow('disposition-archive-missing:key')
      await rawRows(
        h.db,
        sql`INSERT INTO ${meta('migration_archives')}
        (run_id, archive_ref, unit_id, kind, source_table, format, rows, byte_size, bytes)
        VALUES ('q1-run', 'archive', 'unit', 'source-journal', 'clarify_rounds', 'logical-row@1', 1, ${bytes.length}, ${bytes})`,
      )
      // No reinitialization: both rejected cache entries must have been evicted.
      expect((await readClarifyHistory(h.db)).map((row) => row.id)).toEqual(['archived-round'])
      expect(await readDispositionArchives(h.db, 'clarify_rounds')).toHaveLength(1)
    }
  })

  test('BF-D23 a clarify-index decode failure is evicted independently of the archive cache', async () => {
    const { meta, bytes } = await seed()
    const malformed = Buffer.from(
      encodeStagedValue({
        table: 'clarify_rounds',
        encodedKey: 'key',
        phase: 'current',
        values: { ...values, task_id: null },
      }),
    )
    await rawRows(
      h.db,
      sql`UPDATE ${meta('migration_archives')} SET bytes = ${malformed}, byte_size = ${malformed.length} WHERE run_id = 'q1-run'`,
    )
    await expect(initializeClarifyHistory(h.db)).rejects.toThrow('clarify-history-identity-missing')
    await expect(readClarifyHistory(h.db)).rejects.toThrow('clarify-history-identity-missing')
    await rawRows(
      h.db,
      sql`UPDATE ${meta('migration_archives')} SET bytes = ${bytes}, byte_size = ${bytes.length} WHERE run_id = 'q1-run'`,
    )
    // A new archive admission after repair; do not reset the failed clarify index.
    await initializeDispositionArchives(h.db, 'clarify_rounds')
    expect((await readClarifyHistory(h.db)).map((row) => row.id)).toEqual(['archived-round'])
  })

  test('BF-D23 malformed conversion history does not abort daemon composition and remains a read error', async () => {
    const { meta } = await seed()
    await rawRows(h.db, sql`DELETE FROM ${meta('migration_archives')} WHERE run_id = 'q1-run'`)
    const application = await createProviderHttpApplication(h, {
      token: 'bfb-history',
      dbVersion: 1,
    })
    try {
      await expect(getClarifyRoundDetail(h.db, 'carrier')).rejects.toThrow(
        'disposition-archive-missing:key',
      )
    } finally {
      await application.dispose()
    }
  })

  test('AF-D20 fresh runtime primes once without touching archives; every hot path keeps its bound', async () => {
    const initialization = h.recordStatements()
    await initializeClarifyHistory(h.db)
    initialization.stop()
    expect(initialization.statements).toHaveLength(1)
    expect(initialization.statements[0]?.sql).toContain('migration_row_dispositions')
    expect(initialization.statements.some((row) => row.sql.includes('migration_archives'))).toBe(
      false,
    )
    const actor = buildActor({
      user: { id: 'u', username: 'u', displayName: 'u', role: 'admin', status: 'active' },
      source: 'session',
    })
    const paths: readonly [string, number, () => Promise<unknown>][] = [
      ['badge', 1, () => countAwaitingClarifyRounds(h.db, actor)],
      ['round list', 1, () => listClarifyRounds(h.db, { taskId: 'fresh' })],
      ['summary list', 1, () => listClarifyRoundSummaries(h.db, { taskId: 'fresh' })],
      [
        'detail',
        1,
        async () => {
          await expect(getClarifyRoundDetail(h.db, 'fresh-run')).rejects.toMatchObject({
            code: 'clarify-round-not-found',
          })
        },
      ],
      ['navigation', 1, () => createTaskNodeRunClarifyNav(h.db).latestRoundStatusByRun('fresh')],
      [
        'memory questions',
        1,
        () => createClarifyAnswerQueries(h.db).listSelfQuestions(['fresh-round']),
      ],
      [
        'memory sources',
        1,
        () => createClarifyAnswerQueries(h.db).listSelfSources(['fresh-round']),
      ],
      [
        'visibility',
        2,
        () => createCollaborationTaskAccessPort(h.db).resolveClarifyRoundTask(actor, 'fresh-run'),
      ],
    ]
    for (let iteration = 0; iteration < 2; iteration++)
      for (const [path, bound, read] of paths) {
        const recording = h.recordStatements()
        try {
          await read()
        } finally {
          recording.stop()
        }
        expect(recording.statements.length, path).toBe(bound)
        expect(
          recording.statements.some((row) => /migration_(archives|row_dispositions)/.test(row.sql)),
          path,
        ).toBe(false)
      }
  })
  test('AF-D20 converted lineage is loaded once, transactions share it and unrelated tasks never scan history', async () => {
    const { meta } = await seed()
    // A same-epoch successor inherits the conversion lineage.
    await rawRows(
      h.db,
      sql`INSERT INTO ${meta('generations')} (generation_id, schema_epoch, role, state, provider, run_id, contract_digest, plan_digest, created_at, activated_at)
      SELECT 'q1-parent', schema_epoch, 'converted', 'retired', provider, run_id, contract_digest, plan_digest, created_at, activated_at FROM ${meta('generations')} WHERE state = 'active'`,
    )
    await rawRows(
      h.db,
      sql`UPDATE ${meta('generations')} SET run_id = NULL, source_generation_id = 'q1-parent' WHERE state = 'active'`,
    )
    const initialization = h.recordStatements()
    await initializeClarifyHistory(h.db)
    initialization.stop()
    expect(initialization.statements).toHaveLength(2)
    expect(
      initialization.statements.filter((row) => row.sql.includes('migration_archives')),
    ).toHaveLength(1)
    const warm = h.recordStatements()
    try {
      expect((await getClarifyRoundDetail(h.db, 'carrier')).id).toBe('archived-round')
      expect(await createTaskNodeRunClarifyNav(h.db).latestRoundStatusByRun('fresh')).toEqual(
        new Map(),
      )
      expect(await readClarifyHistory(h.db, { taskId: 'fresh' })).toEqual([])
      await h.session.snapshotRead(async (tx) => {
        expect((await readDispositionArchives(tx, 'clarify_rounds'))[0]?.values.task_id).toBe('t')
        expect(
          (await createTaskArchiveCollaborationSectionReader().load(tx, ['t'])).dispositionEvidence,
        ).toHaveLength(1)
      })
    } finally {
      warm.stop()
    }
    expect(
      warm.statements.some((row) => /migration_(archives|row_dispositions)/.test(row.sql)),
    ).toBe(false)
    const unrelated = h.recordStatements()
    await createTaskNodeRunClarifyNav(h.db).latestRoundStatusByRun('fresh')
    unrelated.stop()
    expect(unrelated.statements).toHaveLength(1)
  })
  test('AF-D20 a large archive still counts in one bounded-depth query', async () => {
    const { meta } = await seed({ status: 'awaiting_human' })
    await patchTaskFixture(h.db, { id: 't' }, { status: 'awaiting_human' })
    const total = 1101
    for (let offset = 1; offset < total; offset += 100) {
      const batch = Array.from({ length: Math.min(100, total - offset) }, (_, index) => {
        const key = `round-${offset + index}'quoted`
        return {
          key,
          bytes: Buffer.from(
            encodeStagedValue({
              table: 'clarify_rounds',
              encodedKey: key,
              phase: 'current',
              values: { ...values, id: key, status: 'awaiting_human' },
            }),
          ),
        }
      })
      await rawRows(
        h.db,
        sql`INSERT INTO ${meta('migration_archives')}
        (run_id, archive_ref, unit_id, kind, source_table, format, rows, byte_size, bytes)
        VALUES ${sql.join(
          batch.map(
            ({ key, bytes }) =>
              sql`('q1-run', ${key}, 'unit', 'source-journal', 'clarify_rounds', 'logical-row@1', 1, ${bytes.length}, ${bytes})`,
          ),
          sql`, `,
        )}`,
      )
      await rawRows(
        h.db,
        sql`INSERT INTO ${meta('migration_row_dispositions')}
        (run_id, source_table, source_phase, source_key, ordinal, unit_id, class, kind, rule_id, rule_version, targets_json, archive_ref)
        VALUES ${sql.join(
          batch.map(
            ({ key }) =>
              sql`('q1-run', 'clarify_rounds', 'current', ${key}, 0, 'unit', 'archived', 'history-only', 'fixture', 1, '[]', ${key})`,
          ),
          sql`, `,
        )}`,
      )
    }
    await initializeClarifyHistory(h.db)
    const admin = buildActor({
      user: {
        id: 'admin',
        username: 'admin',
        displayName: 'admin',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const recording = h.recordStatements()
    try {
      expect(await countAwaitingClarifyRounds(h.db, admin)).toBe(total)
    } finally {
      recording.stop()
    }
    expect(recording.statements).toHaveLength(1)
    expect(recording.statements[0]?.params).toBeLessThan(30)
  })
  test('AF-D20 archived badge keeps one query, respects current visibility/deletion and live-row precedence', async () => {
    await seed({ status: 'awaiting_human' })
    await h.db
      .insert(tablesOf(h.db).users)
      .values({ id: 'owner', username: 'owner', displayName: 'owner', createdAt: 1, updatedAt: 1 })
      .onConflictDoNothing()
    await patchTaskFixture(h.db, { id: 't' }, { status: 'awaiting_human', ownerUserId: 'owner' })
    await initializeClarifyHistory(h.db)
    const actor = (id: string, role: 'user' | 'admin' = 'user') =>
      buildActor({
        user: { id, username: id, displayName: id, role, status: 'active' },
        source: 'session',
      })
    for (const [who, expected] of [
      [actor('admin', 'admin'), 1],
      [actor('owner'), 1],
      [actor('other'), 0],
    ] as const) {
      const recording = h.recordStatements()
      expect(await countAwaitingClarifyRounds(h.db, who)).toBe(expected)
      recording.stop()
      expect(recording.statements).toHaveLength(1)
    }
    // A live row with the same ID wins, even when its status differs from the archive.
    await nodeRunFixture(h.db, { id: 'carrier', taskId: 't', nodeId: 'clarify', status: 'done' })
    await clarifyRoundFixture(h.db, {
      id: 'archived-round',
      taskId: 't',
      kind: 'self',
      askingNodeId: 'clarify',
      askingNodeRunId: 'carrier',
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: 'carrier',
      questions: '[]',
      status: 'answered',
    })
    expect(await countAwaitingClarifyRounds(h.db, actor('admin', 'admin'))).toBe(0)
    expect((await getClarifyRoundDetail(h.db, 'carrier')).status).toBe('answered')
    await h.db.delete(tablesOf(h.db).tasks).where(eq(tablesOf(h.db).tasks.id, 't'))
    expect(await countAwaitingClarifyRounds(h.db, actor('admin', 'admin'))).toBe(0)
    expect(await listClarifyRoundSummaries(h.db, { status: 'all' })).toEqual([])
  })
})
