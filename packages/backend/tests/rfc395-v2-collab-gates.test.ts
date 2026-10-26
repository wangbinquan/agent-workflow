import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  seedCollabTask,
  gateRow,
  readFixtureRows,
  convertFixtures,
  taskClasses,
} from './helpers/rfc395V2/collabFixtures'
import {
  gateOperationsRule,
  gateOperationsValidator,
} from '@/modules/collaboration/infrastructure/migration/gateOperationsRule'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
const gateOperationsDefinition = persistenceSchema.tables.find(
  (table) => table.id === 'collaboration_gate_operations',
)!

const conversion = {
  rules: [gateOperationsRule],
  validators: [gateOperationsValidator],
  lookups: [],
}

describeV2Providers('RFC-395 V2-C gate operations', (h) => {
  test('every preparing/prepared clarify/review open combination follows all eight D4 classes', async () => {
    await h.install()
    const facts = []
    for (const [status, execution] of taskClasses) {
      facts.push((await seedCollabTask(h, status, status, execution)).task)
      for (const gate_kind of ['clarify', 'review'])
        for (const state of ['preparing', 'prepared'])
          await h.write('collaboration_gate_operations', [
            gateRow(`${status}-${gate_kind}-${state}`, status, { gate_kind, state }),
          ])
    }
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: facts,
    })
    expect(summary.blocks.filter((b) => b.code === 'v2-gate-open-in-flight')).toHaveLength(20)
    expect(sink.rows('collaboration_gate_operations')).toHaveLength(12)
    expect(dispositions.filter((d) => d.kind === 'history-only')).toHaveLength(12)
    for (const d of dispositions.filter((d) => d.kind === 'history-only')) {
      expect(d.history?.missingFields).toEqual(['legacy-open-replay'])
      expect(d.archive).toStartWith('archive:sha256:')
    }
  }, 180_000)

  test('committed receipts, decide manifests and rollback plans copy byte for byte; claims stay unchanged', async () => {
    await h.install()
    const { task } = await seedCollabTask(h, 'task', 'awaiting_review', 'executable')
    const manifest =
      '{ "schemaVersion": 1, "rollbackPlan": { "path": "repo/中", "sha": "a" }, "decision": "approve" }\n'
    const receipt = '{"revision": 1, "bytes": "  unchanged  "}\n'
    await h.write('collaboration_gate_operations', [
      gateRow('committed', 'task', {
        state: 'committed',
        result_gate_revision: 1,
        receipt_json: receipt,
        committed_at: 125,
        manifest_json: manifest,
        claim_epoch: 9,
        claim_expires_at: 500,
      }),
      gateRow('decide', 'task', { operation_kind: 'decide', manifest_json: manifest }),
      gateRow('questions', 'task', { gate_kind: 'questions' }),
      gateRow('failed', 'task', { state: 'failed', failure_json: '{"message":"failed"}' }),
      gateRow('cleanup', 'task', {
        state: 'cleanup_pending',
        result_gate_revision: 1,
        receipt_json: receipt,
        committed_at: 125,
      }),
      gateRow('completed', 'task', {
        state: 'completed',
        result_gate_revision: 1,
        receipt_json: receipt,
        committed_at: 125,
        completed_at: 126,
      }),
    ])
    const source = await readFixtureRows(h, 'collaboration_gate_operations')
    const { summary, sink, dispositions } = await convertFixtures(h, [conversion], {
      taskFacts: [task],
    })
    expect(summary.status).toBe('converted')
    expect(dispositions).toEqual([])
    for (const row of source)
      expect(sink.rows(row.table).find((r) => r.id === row.values.id)).toEqual(row.values)
    expect(gateOperationsDefinition.rowRules).toEqual([
      expect.objectContaining({
        kind: 'immutableOnceSet',
        columns: ['result_gate_revision', 'receipt_json', 'committed_at'],
        errorCode: 'human-gate-committed-receipt-immutable',
      }),
    ])
  }, 180_000)

  test('missing TASK_FACTS blocks an open operation instead of guessing from the source task status', async () => {
    await h.install()
    await seedCollabTask(h)
    await h.write('collaboration_gate_operations', [gateRow('missing')])
    const { summary, sink } = await convertFixtures(h, [conversion], { taskFacts: [] })
    expect(summary.blocks.map((b) => b.code)).toContain('v2-gate-task-facts-missing')
    expect(sink.rows('collaboration_gate_operations')).toEqual([])
  }, 180_000)
})
