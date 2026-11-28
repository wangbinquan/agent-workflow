// RFC-626 §3.2.5 and §7 "与先做取消事务的写入再升级等价" (design/RFC-626-upgrade-no-refusal-minimal-time/
// design.md): ending a task during the automatic upgrade must leave the new database exactly as if
// the task had been canceled first and upgraded afterwards. For each original status (the four the
// product can cancel, and `interrupted`) and for two ways of ending — the task's own run records
// cannot be proven, and a child taken along by its ended parent — the same source is upgraded
// twice: once as it is (side A, the upgrade ends the task), once after the writes of the v0.19.2
// cancel transaction were applied to it by hand (side B, written from
// `git show v0.19.2:packages/backend/src/modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts`
// :746-826 and its `terminalizeTaskExecutionIntentsInTx`, never from converter output).
//
// The business columns of the task and its dependent rows must be equal table by table. Three
// exceptions are asserted on their own:
//   1. the stop reason (error_summary/error_message, failure_code) and the time columns take each
//      side's own values — the upgrade's reason and plan time on A, the user's cancel on B;
//   2. the cancel appends a lifecycle event and moves `lifecycle_event_revision`; the upgrade does
//      neither (§3.2.3), so A keeps the source revision;
//   3. evidence that preserves the source row as read (`source` of the task evidence) is faithful
//      to each side's own source, while the run evidence's `sourceValues` (read from the rewritten
//      values) differ only in the reason and time.
// The gate sweep's clarify part and the alerts belong to other modules and are not in scope here.
import { setDefaultTimeout, expect, test } from 'bun:test'
import {
  runConversion as runContribution,
  taskConversion,
} from '@/modules/task-execution/composition/conversion'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { repositoryUrlFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { preservedRule } from '@/platform/persistence/migration/conversion/generic/preserved'
import { columnLookup, idSetLookup } from '@/platform/persistence/migration/conversion/lookups'
import { canonicalValue } from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { describeV2Providers, fixtureLookup, type V2Harness } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { runValues } from './helpers/rfc395V2/runFixtures'
import { taskRow, writeTaskFixture } from './helpers/rfc395V2/taskFixtures'

// Two full conversions per case on a real provider; allow 120 s.
setDefaultTimeout(120_000)

const PLAN_TIME = 123
const CANCEL_TIME = 999
const STATUSES = ['pending', 'running', 'awaiting_review', 'awaiting_human', 'interrupted'] as const
const CANCELABLE: readonly string[] = ['pending', 'running', 'awaiting_review', 'awaiting_human']
/** v0.19.2 taskStopProjection for the two causes side B is canceled with. */
const USER = { summary: 'canceled by user', code: 'canceled-by-user' } as const
const CASCADE = { summary: 'canceled by parent task', code: 'canceled-by-parent-cascade' } as const
const UPGRADE = { summary: 'ended by upgrade', code: 'ended-by-upgrade' } as const
type Reason = { readonly summary: string; readonly code: string }

const definition = JSON.stringify({
  $schema_version: 7,
  inputs: [],
  nodes: [
    { id: 'ordinary', kind: 'script' },
    { id: 'second', kind: 'script' },
  ],
  edges: [],
})

/** The run a task is doing when it is ended; `interrupted` tasks hold interrupted runs. */
const activeRunStatus = (status: string) => (status === 'interrupted' ? 'interrupted' : 'running')

/**
 * One task with its runs and, optionally, its execution intent, owner and replay decision.
 * `cancel` writes what the v0.19.2 cancel transaction writes for that task; null leaves it as is.
 */
async function seedTask(
  h: V2Harness,
  input: {
    readonly id: string
    readonly status: string
    readonly parentTaskId?: string
    /** A selected run without an envelope nonce: the task's records cannot be proven. */
    readonly unprovable: boolean
    readonly execution: boolean
    readonly cancel: Reason | null
  },
): Promise<void> {
  const { id, cancel } = input
  const task = taskRow(id, {
    status: input.status,
    space_kind: 'internal',
    workflow_snapshot: definition,
    ...(input.parentTaskId ? { parent_task_id: input.parentTaskId } : {}),
  })
  // v0.19.2 :784-810 — status, finished_at, error_summary, error_message, lifecycle revision.
  await writeTaskFixture(
    h,
    cancel
      ? {
          ...task,
          status: 'canceled',
          finished_at: CANCEL_TIME,
          error_summary: cancel.summary,
          error_message: cancel.code,
          lifecycle_event_revision: 2,
        }
      : task,
  )
  const active = activeRunStatus(input.status)
  // v0.19.2 :812-820 — every pending/running/parked run is canceled with the stop reason code.
  const activeCanceled = cancel !== null && CANCELABLE.includes(active)
  await h.write('node_runs', [
    ...(input.unprovable
      ? [
          runValues(`${id}-anchor`, {
            task_id: id,
            node_id: 'ordinary',
            status: 'done',
            envelope_nonce: null,
            seq: 1,
          }),
        ]
      : []),
    runValues(`${id}-active`, {
      task_id: id,
      node_id: 'second',
      seq: 2,
      ...(activeCanceled
        ? { status: 'canceled', finished_at: CANCEL_TIME, error_message: cancel.code }
        : { status: active }),
    }),
  ])
  if (!input.execution) return
  // terminalizeTaskExecutionIntentsInTx: an active intent is canceled with the reason code.
  await h.write('task_execution_intents', [
    frozenValues('task_execution_intents', {
      id: `${id}-intent`,
      task_id: id,
      kind: 'resume',
      state: cancel ? 'canceled' : 'pending',
      source: 'rest',
      execution_lineage_id: id,
      continuation_slot_key: `${id}-slot`,
      slot_path_json: '[]',
      authorization_scope_json: null,
      claimed_epoch: null,
      failure_code: cancel ? cancel.code : null,
      created_at: 400,
      claimed_at: null,
      completed_at: cancel ? CANCEL_TIME : null,
      updated_at: cancel ? CANCEL_TIME : 400,
    }),
  ])
  // v0.19.2 :749-772 — a claimed owner is revoked, its revision one step on.
  await h.write('task_execution_owners', [
    frozenValues('task_execution_owners', {
      task_id: id,
      owner_id: `${id}-owner`,
      daemon_generation: 'generation',
      epoch: 1,
      state: cancel ? 'revoked' : 'claimed',
      lease_until: 450,
      revision: cancel ? 4 : 3,
      last_heartbeat_at: 440,
      recovery_code: cancel ? 'terminal-control-cancel' : null,
      recovery_proof_digest: null,
      updated_at: cancel ? CANCEL_TIME : 440,
    }),
  ])
  // The same intent sequence releases a replay decision bound to a closed intent.
  await h.write('task_execution_lineage_operation_records', [
    frozenValues('task_execution_lineage_operation_records', {
      id: `${id}-decision`,
      record_kind: 'replay-decision',
      execution_lineage_id: id,
      operation_family_key: 'family',
      operation_generation: 0,
      highest_settled_generation: null,
      last_outcome: 'outcome-unknown',
      slot_path_json: '[]',
      root_anchor_task_id: id,
      ancestor_anchor_task_id: null,
      current_anchor_task_id: id,
      source_task_id: id,
      source_effect_id: null,
      source_attempt_id: null,
      provider_coordinate_json: null,
      failure_code: 'task-execution-outcome-unknown',
      decision_state: cancel ? 'requires-actor' : 'actor-replay-authorized',
      replay_authorization_id: cancel ? null : 'authorization',
      authorization_scope_json: cancel ? null : '{"v":1}',
      actor_user_id: cancel ? null : 'actor',
      authorization_source: cancel ? null : 'rest',
      bound_intent_id: cancel ? null : `${id}-intent`,
      new_effect_id: null,
      record_revision: cancel ? 3 : 2,
      compacted: false,
      created_at: 300,
      updated_at: cancel ? CANCEL_TIME : 300,
    }),
  ])
}

const SEEDED = [
  'task_execution_lineage_operation_records',
  'task_execution_owners',
  'task_execution_intents',
  'node_runs',
  'task_repos',
  'task_space_nodes',
  'workgroup_task_state',
  'tasks',
] as const
/** Side B goes into the same installed database once side A has been converted. */
async function clearSeeded(h: V2Harness): Promise<void> {
  for (const table of SEEDED)
    await h.sourceHarness.native.execute(`DELETE FROM ${h.sourceHarness.table(table)}`)
}

async function upgrade(h: V2Harness) {
  const contributions: ConversionContribution[] = [
    taskConversion,
    runContribution,
    {
      rules: [
        preservedRule('task_execution_intents'),
        preservedRule('task_execution_owners'),
        preservedRule('task_execution_lineage_operation_records'),
      ],
      validators: [],
      lookups: [
        idSetLookup('users', 'id'),
        columnLookup('workflows', ['id'], ['builtin']),
        columnLookup('node_runs', ['id'], ['continuation_slot_key']),
        fixtureLookup(repositoryUrlFacts, []),
      ],
    },
  ]
  const input = await h.input(contributions, {
    candidateBuild: 'rfc626-f1-equivalence',
    resolution: 'automatic',
  })
  const sink = new V2MemorySink()
  try {
    return { summary: await runConversion(input, sink), sink }
  } finally {
    await input.source.close()
  }
}
type Side = Awaited<ReturnType<typeof upgrade>>

/** Columns compared separately (exceptions 1–3); everything else must be equal. */
const SEPARATE: Readonly<Record<string, readonly string[]>> = {
  tasks: ['finished_at', 'error_summary', 'error_message', 'lifecycle_event_revision'],
  node_runs: ['finished_at', 'error_message'],
  task_execution_intents: ['failure_code', 'completed_at', 'updated_at'],
  task_execution_owners: ['updated_at'],
  task_execution_lineage_operation_records: ['updated_at'],
  execution_legacy_evidence: ['content_ref_json', 'content_inline_bytes'],
}
const COMPARED = [
  'tasks',
  'task_definitions',
  'task_launch_contexts',
  'task_workspaces',
  'task_repository_mounts',
  'task_space_nodes',
  'task_execution_generations',
  'node_runs',
  'node_run_configs',
  'node_run_runtime_states',
  'node_run_results',
  'node_run_selections',
  'node_run_inputs',
  'node_run_repo_checkpoints',
  'task_execution_intents',
  'task_execution_owners',
  'task_execution_lineage_operation_records',
  'execution_legacy_evidence',
] as const

function comparable(table: string, rows: readonly TargetRow[]): string[] {
  const separate = SEPARATE[table] ?? []
  return rows
    .map((row) =>
      JSON.stringify(
        Object.keys(row)
          .filter((column) => !separate.includes(column))
          .sort()
          .map((column) => [column, canonicalValue(row[column] ?? null)]),
      ),
    )
    .sort()
}
function expectBusinessColumnsEqual(a: Side, b: Side): void {
  for (const table of COMPARED)
    expect({ table, rows: comparable(table, a.sink.rows(table)) }).toEqual({
      table,
      rows: comparable(table, b.sink.rows(table)),
    })
}
const one = (side: Side, table: string, match: DecodedSourceRow): TargetRow => {
  const rows = side.sink
    .rows(table)
    .filter((row) => Object.entries(match).every(([column, value]) => row[column] === value))
  expect(rows).toHaveLength(1)
  return rows[0]!
}
const evidence = (side: Side, kind: string, id: string) =>
  JSON.parse(
    Buffer.from(
      one(side, 'execution_legacy_evidence', { record_kind: kind, record_id: id })
        .content_inline_bytes as Uint8Array,
    ).toString(),
  ) as Record<string, unknown>
const statusColumn = frozenEpoch1Contract.tables
  .find((table) => table.id === 'tasks')!
  .columns.findIndex((column) => column.name === 'status')

/** Exception 1 and 2 for one task that both sides ended. */
function expectEnded(a: Side, b: Side, id: string, reasons: { a: Reason; b: Reason }): void {
  expect(one(a, 'tasks', { id })).toMatchObject({
    status: 'canceled',
    finished_at: PLAN_TIME,
    error_summary: reasons.a.summary,
    error_message: reasons.a.code,
    lifecycle_event_revision: 1,
  })
  expect(one(b, 'tasks', { id })).toMatchObject({
    status: 'canceled',
    finished_at: CANCEL_TIME,
    error_summary: reasons.b.summary,
    error_message: reasons.b.code,
    lifecycle_event_revision: 2,
  })
}
function expectRunEnded(a: Side, b: Side, id: string, reasons: { a: Reason; b: Reason }) {
  expect(one(a, 'node_runs', { id })).toMatchObject({
    status: 'canceled',
    finished_at: PLAN_TIME,
    error_message: reasons.a.code,
  })
  expect(one(b, 'node_runs', { id })).toMatchObject({
    status: 'canceled',
    finished_at: CANCEL_TIME,
    error_message: reasons.b.code,
  })
}
function expectExecutionEnded(a: Side, b: Side, id: string, reasons: { a: Reason; b: Reason }) {
  for (const [side, reason, time] of [
    [a, reasons.a, PLAN_TIME],
    [b, reasons.b, CANCEL_TIME],
  ] as const) {
    expect(one(side, 'task_execution_intents', { id: `${id}-intent` })).toMatchObject({
      state: 'canceled',
      failure_code: reason.code,
      completed_at: time,
      updated_at: time,
    })
    expect(one(side, 'task_execution_owners', { task_id: id })).toMatchObject({
      state: 'revoked',
      revision: 4,
      recovery_code: 'terminal-control-cancel',
      updated_at: time,
    })
    expect(
      one(side, 'task_execution_lineage_operation_records', { id: `${id}-decision` }),
    ).toMatchObject({
      decision_state: 'requires-actor',
      bound_intent_id: null,
      replay_authorization_id: null,
      record_revision: 3,
      updated_at: time,
    })
  }
}
/** Exception 3: source-preserving evidence follows its own source; run evidence follows values. */
function expectEvidence(a: Side, b: Side, taskId: string, originalStatus: string, runs: string[]) {
  const taskA = evidence(a, 'task', taskId) as { source: { values: unknown[] }; detail: unknown }
  const taskB = evidence(b, 'task', taskId) as { source: { values: unknown[] }; detail: unknown }
  expect(taskA.source.values[statusColumn]).toEqual({ type: 'text', value: originalStatus })
  expect(taskB.source.values[statusColumn]).toEqual({ type: 'text', value: 'canceled' })
  expect(taskA.detail).toEqual(taskB.detail)
  for (const run of runs) {
    const runA = evidence(a, 'node-run', run) as { sourceValues: Record<string, unknown> }
    const runB = evidence(b, 'node-run', run) as { sourceValues: Record<string, unknown> }
    const strip = (content: { sourceValues: Record<string, unknown> }) => {
      const { finished_at: _finished, error_message: _message, ...values } = content.sourceValues
      return { ...content, sourceValues: values }
    }
    expect(strip(runA)).toEqual(strip(runB))
  }
}

describeV2Providers('RFC-626 §3.2.5 ending a task equals cancel-then-upgrade', (h) => {
  for (const status of STATUSES)
    test(`unprovable run records, original status ${status}`, async () => {
      await h.install()
      await seedTask(h, { id: 'task', status, unprovable: true, execution: true, cancel: null })
      const a = await upgrade(h)
      await clearSeeded(h)
      await seedTask(h, { id: 'task', status, unprovable: true, execution: true, cancel: USER })
      const b = await upgrade(h)

      expect(a.summary.blocks).toEqual([])
      expect(b.summary.blocks).toEqual([])
      expect(a.summary.plan.settlements).toHaveLength(1)
      expect(a.summary.plan.settlements![0]).toMatchObject({
        taskId: 'task',
        cause: 'unprovable-records',
        originalStatus: status,
        parentTaskId: null,
      })
      expect(a.summary.plan.settlements![0]!.blockCodes).toContain('v2-run-null-nonce')
      expect(b.summary.plan.settlements ?? []).toEqual([])

      expectBusinessColumnsEqual(a, b)
      expectEnded(a, b, 'task', { a: UPGRADE, b: USER })
      if (status === 'interrupted') {
        // The cancel leaves an interrupted run as it is; so does the upgrade.
        for (const side of [a, b])
          expect(one(side, 'node_runs', { id: 'task-active' })).toMatchObject({
            status: 'interrupted',
            finished_at: null,
            error_message: null,
          })
      } else expectRunEnded(a, b, 'task-active', { a: UPGRADE, b: USER })
      for (const side of [a, b])
        expect(one(side, 'node_runs', { id: 'task-anchor' })).toMatchObject({
          status: 'done',
          envelope_nonce: null,
          record_mode: 'history-only',
        })
      expectExecutionEnded(a, b, 'task', { a: UPGRADE, b: USER })
      expectEvidence(a, b, 'task', status, ['task-anchor', 'task-active'])
    }, 300_000)

  for (const status of STATUSES)
    test(`child taken along by its ended parent, child status ${status}`, async () => {
      const cascaded = CANCELABLE.includes(status)
      await h.install()
      await seedTask(h, {
        id: 'parent',
        status: 'running',
        unprovable: true,
        execution: false,
        cancel: null,
      })
      await seedTask(h, {
        id: 'child',
        status,
        parentTaskId: 'parent',
        unprovable: false,
        execution: true,
        cancel: null,
      })
      const a = await upgrade(h)
      await clearSeeded(h)
      await seedTask(h, {
        id: 'parent',
        status: 'running',
        unprovable: true,
        execution: false,
        cancel: USER,
      })
      // v0.19.2 cascades only to cancelable children (:827-833); an interrupted child stays.
      await seedTask(h, {
        id: 'child',
        status,
        parentTaskId: 'parent',
        unprovable: false,
        execution: true,
        cancel: cascaded ? CASCADE : null,
      })
      const b = await upgrade(h)

      expect(a.summary.blocks).toEqual([])
      expect(b.summary.blocks).toEqual([])
      expect(
        [...(a.summary.plan.settlements ?? [])]
          .map((entry) => [entry.taskId, entry.cause, entry.originalStatus, entry.parentTaskId])
          .sort(),
      ).toEqual(
        [
          ['parent', 'unprovable-records', 'running', null],
          ...(cascaded ? [['child', 'parent-cascade', status, 'parent']] : []),
        ].sort(),
      )
      expect(b.summary.plan.settlements ?? []).toEqual([])

      expectBusinessColumnsEqual(a, b)
      expectEnded(a, b, 'parent', { a: UPGRADE, b: USER })
      expectRunEnded(a, b, 'parent-active', { a: UPGRADE, b: USER })
      if (cascaded) {
        // A cascaded child carries the same reason on both sides; only the times differ.
        expectEnded(a, b, 'child', { a: CASCADE, b: CASCADE })
        expectRunEnded(a, b, 'child-active', { a: CASCADE, b: CASCADE })
        expectExecutionEnded(a, b, 'child', { a: CASCADE, b: CASCADE })
        expectEvidence(a, b, 'child', status, ['child-active'])
      } else
        for (const table of ['tasks', 'node_runs', 'task_execution_intents'] as const)
          expect(
            a.sink.rows(table).filter((row) => row.id === 'child' || row.task_id === 'child'),
          ).toEqual(
            b.sink.rows(table).filter((row) => row.id === 'child' || row.task_id === 'child'),
          )
      expectEvidence(a, b, 'parent', 'running', ['parent-anchor', 'parent-active'])
    }, 300_000)
})
