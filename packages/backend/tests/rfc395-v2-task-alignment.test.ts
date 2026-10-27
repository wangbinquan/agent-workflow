import { setDefaultTimeout, describe, expect, test } from 'bun:test'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { overrideSourceValues } from './helpers/rfc395V2/sourceOverride'
import {
  taskRow,
  writeTaskFixture,
  convertTaskFixtures,
  assertTaskProjection,
} from './helpers/rfc395V2/taskFixtures'
import { taskName } from '@/modules/task-execution/infrastructure/migration/task/alignment'
import { conversion } from '@/modules/task-execution/infrastructure/migration/task'
import {
  TASK_LINEAGE,
  type TaskLineage,
} from '@/modules/task-execution/infrastructure/migration/task/lineage'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'

// Slowest case took 3.24 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

describe('RFC-395 V2-T name alignment', () => {
  test('0021 fallback counts Unicode characters like SQLite substr and preserves nonempty names', () => {
    expect(taskName('prefix-😀123456789', null)).toBe('task-😀123456789')
    expect(taskName('123', '')).toBe('task-123')
    expect(taskName('ignored', ' ')).toBe(' ')
  })
})

describeV2Providers('RFC-395 V2-T lineage and alignment', (h) => {
  test('0210 trigger fill is byte-exact across providers and resolves parents before lexically earlier children', async () => {
    await h.install()
    const parentPath =
      '[ { "stableNodeKey" : "root", "numeric": 1.00e+1, "duplicate":1, "duplicate":2, "escape":"\\u0061" } ]'
    await writeTaskFixture(
      h,
      taskRow('z-parent', {
        execution_lineage_id: 'recorded-lineage',
        lineage_slot_path_json: parentPath,
        launch_origin: 'scheduled',
      }),
    )
    await h.write('node_runs', [
      {
        id: 'parent-run',
        task_id: 'z-parent',
        node_id: 'node',
        status: 'done',
        continuation_slot_key: 'slot|exact',
        lineage_slot_path_json: '[]',
      },
    ])
    await writeTaskFixture(
      h,
      taskRow('a-child', {
        parent_task_id: 'z-parent',
        root_task_id: 'z-parent',
        parent_node_run_id: 'parent-run',
        launch_origin: 'scheduled',
        execution_lineage_id: null,
        lineage_slot_path_json: null,
        workflow_version: null,
      }),
    )
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(
      result.sink.rows('task_launch_contexts').find((row) => row.task_id === 'z-parent')!
        .lineage_slot_path_json,
    ).toBe(parentPath)
    const child = result.sink.rows('task_launch_contexts').find((row) => row.task_id === 'a-child')!
    expect(child.execution_lineage_id).toBe('recorded-lineage')
    expect(child.lineage_slot_path_json).toBe(
      '[{"stableNodeKey":"root","numeric":1.00e+1,"duplicate":1,"duplicate":2,"escape":"\\u0061"},{"stableNodeKey":"child-task","frozenOccurrenceKey":"slot|exact","workflowRevision":null}]',
    )
    for (const id of ['z-parent', 'a-child']) assertTaskProjection(result, id)
  })

  test('missing lineage recomputes the entire trigger pair and child occurrence falls back to parent run id', async () => {
    await h.install()
    await writeTaskFixture(
      h,
      taskRow('root', {
        execution_lineage_id: 'discard-when-path-null',
        lineage_slot_path_json: null,
      }),
    )
    await writeTaskFixture(
      h,
      taskRow('child', {
        parent_task_id: 'root',
        parent_node_run_id: 'pruned-run',
        execution_lineage_id: null,
        lineage_slot_path_json: null,
      }),
    )
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    const root = result.sink.rows('task_launch_contexts').find((row) => row.task_id === 'root')!
    expect(root.execution_lineage_id).toBe('root')
    expect(root.lineage_slot_path_json).toBe(
      '[{"stableNodeKey":"task-root","frozenOccurrenceKey":"root","workflowRevision":7}]',
    )
    expect(
      result.sink.rows('task_launch_contexts').find((row) => row.task_id === 'child')!
        .lineage_slot_path_json,
    ).toBe(
      '[{"stableNodeKey":"task-root","frozenOccurrenceKey":"root","workflowRevision":7},{"stableNodeKey":"child-task","frozenOccurrenceKey":"pruned-run","workflowRevision":7}]',
    )
    for (const id of ['root', 'child']) assertTaskProjection(result, id)
  })

  test('0210 retains SQLite json_insert behavior for a valid non-array parent document', async () => {
    await h.install()
    await writeTaskFixture(
      h,
      taskRow('object-parent', { lineage_slot_path_json: '{ "recorded": 1.00 }' }),
    )
    await writeTaskFixture(
      h,
      taskRow('object-child', {
        parent_task_id: 'object-parent',
        execution_lineage_id: null,
        lineage_slot_path_json: null,
      }),
    )
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(
      result.sink.rows('task_launch_contexts').find((row) => row.task_id === 'object-child')!
        .lineage_slot_path_json,
    ).toBe('{"recorded":1.00}')
    for (const id of ['object-parent', 'object-child']) assertTaskProjection(result, id)
  })

  for (const status of ['running', 'canceled'])
    test(`launch-origin validator consumes injected lineage facts without silently inheriting under ${status}`, async () => {
      await h.install()
      await writeTaskFixture(h, taskRow('origin', { status, launch_origin: 'manual' }))
      const lineage: TaskLineage = {
        executionLineageId: 'origin',
        lineageSlotPathJson: '[]',
        launchOrigin: 'manual',
        parentLaunchOrigin: 'scheduled',
        derived: false,
        missingFields: [],
      }
      const isolated: ConversionContribution = {
        ...conversion,
        lookups: [
          ...conversion.lookups.filter((builder) => builder.key.id !== TASK_LINEAGE.id),
          fixtureLookup(TASK_LINEAGE, [['origin', lineage]]),
        ],
      }
      const result = await convertTaskFixtures(h, { contribution: isolated })
      if (status !== 'running')
        expect(result.sink.rows('task_launch_contexts')[0]!.launch_origin).toBe('manual')
      if (status === 'running')
        expect(
          result.summary.blocks.some((row) => row.code === 'v2-task-launch-origin-mismatch'),
        ).toBe(true)
      else {
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly[0]!.history!.missingFields).toContain('launch_origin')
      }
      if (status !== 'running') assertTaskProjection(result, 'origin')
      else expect(result.sink.rows('task_launch_contexts')).toEqual([])
    })

  test('complete recorded lineage survives a parent cycle without recursive derivation', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('cycle', { parent_task_id: 'cycle' }))
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.summary.historyOnly).toEqual([])
    expect(result.sink.rows('task_launch_contexts')[0]!.execution_lineage_id).toBe('cycle')
    assertTaskProjection(result, 'cycle')
  })

  test('dangling task owner always blocks, even for done history', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('owner'))
    const source = overrideSourceValues(await h.sourceHarness.source(), 'tasks', (row) => ({
      ...row,
      owner_user_id: 'nonexistent-owner',
    }))
    const result = await convertTaskFixtures(h, { source })
    expect(
      result.summary.blocks.some(
        (row) => row.code === 'v2-task-owner-dangling' && row.taskId === 'owner',
      ),
    ).toBe(true)
    expect(result.summary.historyOnly).toEqual([])
    expect(result.sink.rows('tasks')).toEqual([])
  })

  test('empty task name uses migration 0021 and is marked legacy-derived', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('name-1234567890', { name: '' }))
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    expect(result.sink.rows('tasks')[0]!.name).toBe('task-1234567890')
    expect(result.sink.rows('execution_legacy_evidence')[0]!.provenance_quality).toBe(
      'legacy-derived',
    )
    assertTaskProjection(result, 'name-1234567890')
  })

  test('both in-flight validators block exactly the specified states without claiming generic tables', async () => {
    await h.install()
    await h.write(
      'task_workspace_preparations',
      ['preparing', 'prepared', 'compensating', 'admitted', 'cleaned', 'failed'].map((state) => ({
        id: state,
        admission_key: state,
        request_digest: 'digest',
        lane: 'repository-preparation',
        state,
        created_at: 1,
        updated_at: 2,
      })),
    )
    await h.write(
      'hosted_workspace_commands',
      ['submitting', 'running', 'settled', 'abandoned'].map((state) => ({
        execution_id: state,
        task_id: 'external-task',
        business_task_id: 'business-task',
        operation: 'prepare',
        request_key: state,
        request_json: '{ "original": true }',
        state,
        epoch: 1,
        created_at: 1,
        updated_at: 2,
      })),
    )
    const copy = (table: string): ConversionRule => ({
      ref: { id: `fixture/copy/${table}`, version: 1 },
      owner: 'fixture',
      claims: [table],
      produces: [{ table }],
      lookups: [],
      unit: { kind: 'source-chunk', table },
      disposition: 'preserved',
      convert(unit, ctx) {
        for (const row of unit.rows.get(table)!) ctx.out.row(table, row.values, row)
      },
    })
    const extra: ConversionContribution = {
      rules: [copy('task_workspace_preparations'), copy('hosted_workspace_commands')],
      lookups: [],
      validators: [],
    }
    const result = await convertTaskFixtures(h, { extra: [extra] })
    expect(
      result.summary.blocks.filter((row) => row.code === 'v2-task-workspace-preparation-in-flight'),
    ).toHaveLength(3)
    expect(
      result.summary.blocks.filter(
        (row) => row.code === 'v2-task-hosted-workspace-command-in-flight',
      ),
    ).toHaveLength(2)
    expect(
      result.sink
        .rows('task_workspace_preparations')
        .map((row) => row.state)
        .sort(),
    ).toEqual(['admitted', 'cleaned', 'failed'])
    expect(
      result.sink
        .rows('hosted_workspace_commands')
        .map((row) => row.state)
        .sort(),
    ).toEqual(['abandoned', 'settled'])
    expect(
      result.sink
        .rows('hosted_workspace_commands')
        .every((row) => row.request_json === '{ "original": true }'),
    ).toBe(true)
    expect(conversion.rules.flatMap((rule) => rule.claims)).toEqual([
      'tasks',
      'task_repos',
      'task_space_nodes',
      'workgroup_task_state',
    ])
  })
})
