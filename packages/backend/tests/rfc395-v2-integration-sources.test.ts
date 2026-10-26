// Real frozen readers, V1 copy upgrade and exported logical artifacts; no live schema builders.
import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  integrationInput,
  convertIntegration,
  assertTaskDtos,
  assertAgentReplay,
  assertRunOracle,
} from './helpers/rfc395V2/integration'
import { seedRequiredRows, seedSimpleTask, nodeSlot } from './helpers/rfc395V2/integrationFixtures'
import { runValues } from './helpers/rfc395V2/runFixtures'
import { upgradeEpoch1Copy } from '@/platform/persistence/migration/offlineSourceUpgrade'
import type { openEpoch1SqliteSource } from '@/platform/persistence/migration/sqliteSourceReader'
import { openEpoch1LogicalArtifactSource } from '@/platform/persistence/migration/artifactSourceReader'
import { RFC349_ARCHIVE_THEN_OMIT_TABLES } from '@/platform/persistence/schema/contractTypes'

describeV2Providers('RFC-395 V2 real source chains', (h) => {
  if (h.sourceHarness.provider === 'sqlite')
    test('pre-seq SQLite prefix -> V1 offline copy upgrade -> all V2 packages', async () => {
      await h.install('pre-seq')
      await seedRequiredRows(h)
      await seedSimpleTask(h, 'old-prefix', 'interrupted')
      // seq does not exist at this prefix. Physical omission is required, not a NULL head insert.
      const { seq: _seq, ...oldRun } = runValues('old-run', {
        task_id: 'old-prefix',
        status: 'interrupted',
        started_at: 1000,
        pre_snapshot: 'old-checkpoint',
      })
      await h.write('node_runs', [oldRun])
      await h.write('maintenance_state', [
        { key: 'prefix-bytes', value: ' { "before":"upgrade" }\n', updated_at: 1 },
      ])
      const source = (await h.sourceHarness.source()) as ReturnType<typeof openEpoch1SqliteSource>
      const before = await source.preflight()
      expect(before.requiresOfflineUpgrade).toBe(true)
      const copy = await upgradeEpoch1Copy({
        source,
        expected: before,
        manifest: await h.sourceHarness.manifest(),
        operationRoot: h.sourceHarness.operationRoot,
      })
      try {
        expect(copy.sourceWatermark).toBe(before.watermark)
        expect(copy.sourcePreflight).toEqual(before)
        const input = await integrationInput(h, {
          source: copy.reader,
          preUpgradeSource: source,
          preUpgradePreflight: before,
        })
        const result = await convertIntegration(input)
        expect(input.preflight.requiresOfflineUpgrade).toBe(false)
        expect(input.preflight.contract!.digest).toBe((await h.sourceHarness.manifest()).headDigest)
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly).toEqual([])
        expect(
          result.sink.rows('maintenance_state').find((row) => row.key === 'prefix-bytes')!.value,
        ).toBe(' { "before":"upgrade" }\n')
        assertTaskDtos(result)
        expect(
          await assertRunOracle(result, [
            {
              id: 'old-run',
              taskId: 'old-prefix',
              slot: nodeSlot(),
              seq: 0,
              container: null,
              scope: '',
              iteration: 0,
            },
          ]),
        ).toBe(0)
        expect(
          result.summary.tableReceipts.some(
            (row) =>
              row.sourcePhase === 'pre-upgrade' &&
              row.sourceTable === '__drizzle_migrations' &&
              row.rowsRead > 0,
          ),
        ).toBe(true)
        await source.assertUnchanged(before)
      } finally {
        await copy.close()
        await source.close()
      }
    }, 300_000)

  test('native source and its logical artifact both preserve full coverage and executable projections', async () => {
    const version = await h.install()
    await seedRequiredRows(h)
    await seedSimpleTask(h, 'source-task', 'awaiting_review')
    await h.write('node_runs', [
      runValues('source-run', {
        task_id: 'source-task',
        status: 'awaiting_review',
        review_iteration: 2,
        started_at: 1000,
      }),
    ])
    await h.write('agents', [
      {
        id: 'source-agent',
        name: 'source-agent',
        skills: '[{"kind":"project","name":"workspace-skill"}]',
        depends_on: '[]',
        mcp: '[]',
        plugins: '[]',
      },
    ])
    await h.write('maintenance_state', [
      { key: 'artifact-copy', value: 'literal\r\nbytes', updated_at: 2 },
    ])
    // The existing exporter records PostgreSQL generation metadata; freeze native evidence afterwards.
    const artifact = await h.sourceHarness.backup(version)
    const native = await integrationInput(h)
    const logicalSource = await openEpoch1LogicalArtifactSource({
      artifactRoot: artifact.artifactRoot,
      envelopeFileDigest: artifact.envelopeFileDigest,
      supportedSources: await h.sourceHarness.manifest(),
    })
    const logical = await integrationInput(h, { source: logicalSource })
    try {
      const results = [await convertIntegration(native), await convertIntegration(logical)]
      expect(native.source.kind).toBe(
        h.sourceHarness.provider === 'sqlite' ? 'sqlite-file' : 'postgresql-database',
      )
      expect(logical.source.kind).toBe('logical-artifact')
      for (const result of results) {
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly).toEqual([])
        assertTaskDtos(result)
        assertAgentReplay(result)
        expect(
          await assertRunOracle(result, [
            {
              id: 'source-run',
              taskId: 'source-task',
              slot: nodeSlot(),
              seq: 1,
              container: null,
              scope: '',
              iteration: 0,
            },
          ]),
        ).toBe(0)
        expect(
          result.sink.rows('maintenance_state').find((row) => row.key === 'artifact-copy'),
        ).toEqual({ key: 'artifact-copy', value: 'literal\r\nbytes', updated_at: 2 })
      }
      for (const table of [
        'tasks',
        'node_runs',
        'node_run_selections',
        'agents',
        'agent_skill_refs',
      ])
        expect(results[0]!.sink.rows(table)).toEqual(results[1]!.sink.rows(table))
      // Native PostgreSQL omits these physical tables; its logical artifact has
      // verified archive entries even when this fresh-install fixture has no rows.
      expect(native.preflight.expectedAbsent).toEqual(
        h.sourceHarness.provider === 'postgresql' ? [...RFC349_ARCHIVE_THEN_OMIT_TABLES] : [],
      )
      expect(logical.preflight.expectedAbsent).toEqual([])
      for (const table of RFC349_ARCHIVE_THEN_OMIT_TABLES)
        expect(logical.preflight.tables.find((entry) => entry.table === table)).toMatchObject({
          disposition: 'archived',
          rows: 0,
        })
    } finally {
      await native.source.close()
      await logical.source.close()
      artifact.close()
    }
  }, 300_000)
})
