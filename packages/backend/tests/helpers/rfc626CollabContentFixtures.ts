// RFC-626 (design/RFC-626-upgrade-no-refusal-minimal-time/design.md §3.2): fixtures shared by
// the collaboration and content tests of automatic resolution. Ending a task only changes what
// a rule sees if the task facts are derived from the staged `tasks` rows the settlement
// rewrites, so these tests use that derivation and a stand-in for task-execution's own
// `tasks` settler (which is not under test here) instead of the fixed fixture lookups.
import type { V2Harness } from './rfc395V2Harness'
import { fixtureLookup } from './rfc395V2Harness'
import { V2MemorySink } from './rfc395V2MemorySink'
import { parameters } from '@/platform/persistence/schema/history/connection'
import { prepareConversion } from '@/platform/persistence/migration/conversion/engine'
import type { LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import {
  executionClass,
  TASK_FACTS,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import type {
  ConversionContribution,
  TaskSettler,
} from '@/platform/persistence/migration/conversion/rule'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'
import {
  GATE_CONTENT_TASK,
  NODE_CONTENT_TASK,
  REVIEW_CONTENT_TASK,
} from '@/platform/content/migration/receipts'

/** Task facts read from the staged `tasks` rows: a settled task is no longer executable. */
export const stagedTaskFacts: LookupBuilder<TaskFacts> = {
  key: TASK_FACTS,
  sources: ['tasks'],
  build(staged, put) {
    for (const row of staged.rows('tasks')) {
      if (row.codecFailure) continue
      const status = String(row.values.status)
      put(String(row.values.id), {
        taskId: String(row.values.id),
        parentTaskId: null,
        rootTaskId: null,
        status,
        startedAt: 100,
        execution: executionClass(status),
        subjectKind: 'workflow',
        sourceId: 'workflow',
        definitionAnchorId: 'workflow',
        engineKind: 'dag',
        spaceKind: 'internal',
        workflowVersion: 1,
      })
    }
  },
}
/** Stand-in for task-execution's settler of the `tasks` row: the task becomes canceled. */
export const cancelTaskSettler: TaskSettler = {
  tables: [{ table: 'tasks', taskColumn: 'id' }],
  settle: (rows) =>
    (rows.get('tasks') ?? []).map((row) => ({
      table: 'tasks',
      key: row.encodedKey,
      values: { ...row.values, status: 'canceled' },
    })),
}
/** Task facts plus the task settler: everything an automatic conversion needs to end a task. */
export const settledTasks: ConversionContribution = {
  rules: [],
  validators: [],
  lookups: [stagedTaskFacts],
  settlement: { settlers: [cancelTaskSettler] },
}
/** The content task joins of `contentLookups`, without its fixed task facts. */
export function contentTaskJoins(): ConversionContribution {
  return {
    rules: [],
    validators: [],
    lookups: [
      fixtureLookup(NODE_CONTENT_TASK, [['run', { task_id: 'task' }]]),
      fixtureLookup(REVIEW_CONTENT_TASK, [['doc', { task_id: 'task' }]]),
      fixtureLookup(GATE_CONTENT_TASK, [['gate', { task_id: 'task' }]]),
    ],
  }
}
export async function setTaskStatus(h: V2Harness, id: string, status: string): Promise<void> {
  const native = h.sourceHarness.native
  await native.execute(
    `UPDATE ${h.sourceHarness.table('tasks')} SET status = ${parameters(native, 1)} WHERE id = '${id}'`,
    [status],
  )
}
/** Prepares (discovery included) and runs one conversion, returning the plan it registered. */
export async function prepareAndRun(
  h: V2Harness,
  contributions: readonly ConversionContribution[],
  options: Parameters<V2Harness['input']>[1] = {},
) {
  const input = await h.input(contributions, options)
  try {
    const prepared = await prepareConversion(input)
    try {
      const sink = new V2MemorySink()
      const summary = await prepared.run(sink)
      const units = [...sink.units.values()]
      return {
        plan: prepared.plan,
        summary,
        sink,
        units,
        dispositions: units.flatMap((unit) => unit.dispositions),
        records: units.flatMap((unit) => unit.records),
        artifacts: units.flatMap((unit) => unit.artifacts),
      }
    } finally {
      prepared.close()
    }
  } finally {
    await input.source.close()
  }
}
export function decisions(
  records: readonly MigrationRecord[],
  code: string,
): Extract<MigrationRecord, { readonly kind: 'decision' }>[] {
  return records.filter(
    (record): record is Extract<MigrationRecord, { readonly kind: 'decision' }> =>
      record.kind === 'decision' && record.code === code,
  )
}
