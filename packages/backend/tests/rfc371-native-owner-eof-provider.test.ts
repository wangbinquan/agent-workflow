// RFC-371: a crowded original native record must not truncate unrelated owners or hide
// an ambiguous owner after row800. These are retained ledger fixtures, not model runs.
import { expect, test } from 'bun:test'
import { observationUsageCurrent, observationUsageNativeRecords } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { UsageLedgerRecord } from '@/modules/run-observability/domain/usageLedger'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { describeEachProvider } from './helpers/eachProvider'

function record(invocationId: string, stepId: string): UsageLedgerRecord {
  return {
    sourceId: 'source-' + invocationId,
    observedRevision: 1,
    complete: true,
    issues: [],
    contribution: { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' },
    measurement: {
      schemaVersion: 1,
      invocationId,
      recordId: 'opencode:step:' + stepId,
      taskId: 'original-task',
      nodeRunId: 'run-' + invocationId,
      agentId: null,
      revision: 1,
      occurredAt: 10,
      observedAt: 11,
      model: null,
      adapterVersion: 'original-retained-fixture',
      reporting: 'delta',
      inclusion: 'self',
      coverage: 'complete',
      validity: 'valid',
      basis: { kind: 'invocation' },
      usage: { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' },
      scope: {
        root: 'native-root',
        session: 'native-root',
        parentSession: null,
        ancestors: [],
        turn: invocationId,
        turnIndex: 0,
        level: 'request',
      },
    },
  }
}
const key = (value: UsageLedgerRecord) =>
  sha256Hex(
    JSON.stringify([value.sourceId, value.measurement.invocationId, value.measurement.recordId]),
  )

describeEachProvider('RFC-371 original native ownership reaches actual EOF', (harness) => {
  async function seed(records: readonly UsageLedgerRecord[]) {
    for (let start = 0; start < records.length; start += 100) {
      const page = records.slice(start, start + 100)
      await harness.db.insert(observationUsageCurrent).values(
        page.map((value) => ({
          id: key(value),
          taskId: value.measurement.taskId,
          sourceId: value.sourceId,
          document: JSON.stringify(value),
        })),
      )
      await harness.db.insert(observationUsageNativeRecords).values(
        page.map((value) => ({
          id: key(value),
          nativeSource: 'native-source',
          nativeRoot: 'native-root',
          recordId: value.measurement.recordId,
        })),
      )
    }
  }

  test('all399 unique owners survive alongside1001 owners of another selected native step', async () => {
    const unique = Array.from({ length: 399 }, (_, n) => record('unique-' + n, 'unique-' + n)),
      crowded = Array.from({ length: 1001 }, (_, n) => record('crowded-' + n, 'crowded')),
      excluded = record('resumed', 'unique-398')
    await seed([...unique, ...crowded, excluded])
    const owners = await createUsageLedgerStore(harness.db).change('resumed-source', (scope) =>
      scope.nativeOwners(
        'native-source',
        'native-root',
        ['opencode:step:crowded', ...unique.map((value) => value.measurement.recordId)],
        'resumed',
      ),
    )
    expect(owners.size).toBe(400)
    expect(owners.get('opencode:step:crowded')).toEqual({ owners: '1001', candidate: null })
    for (const value of unique)
      expect(owners.get(value.measurement.recordId)).toEqual({ owners: '1', candidate: value })
    expect(owners.get('opencode:step:unique-398')!.candidate!.contribution).toEqual({
      input: '1',
      cacheRead: '2',
      cacheWrite: '3',
      output: '4',
    })
  })

  test('the final original row makes an apparently unique step ambiguous after more than1000 preceding rows', async () => {
    let index = 0
    const find = (prefix: string, stepId: string, predicate: (id: string) => boolean) => {
      while (true) {
        const value = record(prefix + index++, stepId)
        if (predicate(key(value))) return value
      }
    }
    const first = find('first-', 'target', (id) => id < '1'),
      last = find('last-', 'target', (id) => id >= 'f'),
      crowded = Array.from({ length: 1001 }, () =>
        find('middle-', 'crowded', (id) => id > key(first) && id < key(last)),
      )
    await seed([first, ...crowded, last])
    const owners = await createUsageLedgerStore(harness.db).change('resumed-source', (scope) =>
      scope.nativeOwners(
        'native-source',
        'native-root',
        ['opencode:step:target', 'opencode:step:crowded', 'opencode:step:absent'],
        'resumed',
      ),
    )
    expect(owners.get('opencode:step:target')).toEqual({ owners: '2', candidate: null })
    expect(owners.get('opencode:step:crowded')).toEqual({ owners: '1001', candidate: null })
    expect(owners.get('opencode:step:absent')).toEqual({ owners: '0', candidate: null })
    const unrelated = await createUsageLedgerStore(harness.db).change('resumed-source', (scope) =>
      scope.nativeOwners('other-source', 'native-root', ['opencode:step:target'], 'resumed'),
    )
    expect(unrelated.get('opencode:step:target')).toEqual({ owners: '0', candidate: null })
  })
})
