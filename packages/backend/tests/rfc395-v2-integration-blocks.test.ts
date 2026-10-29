// D4 is asserted against the complete bootstrap, including generic journal validators.
import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  integrationInput,
  convertIntegration,
  assertTaskDtos,
  type IntegrationResult,
} from './helpers/rfc395V2/integration'
import {
  seedRequiredRows,
  seedSimpleTask,
  plainSnapshot,
} from './helpers/rfc395V2/integrationFixtures'
import { taskClasses, roundRow, gateRow } from './helpers/rfc395V2/collabFixtures'
import { runValues } from './helpers/rfc395V2/runFixtures'
import { taskRow, repoRow, writeTaskFixture } from './helpers/rfc395V2/taskFixtures'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'

function sourceKey(result: IntegrationResult, table: string, id: string) {
  return result.sourceRows.get(table)!.find((row) => row.values.id === id)!.encodedKey
}
function blockList(result: IntegrationResult) {
  return result.summary.blocks
    .map((block) => [block.code, block.sourceTable, block.sourceKey])
    .sort()
}

describeV2Providers('RFC-395 V2 full-assembly block and history contracts', (h) => {
  test('all eight D4 statuses: executable uncertainty blocks; failed/canceled/done retain restricted history', async () => {
    await h.install()
    await seedRequiredRows(h)
    for (const [status] of taskClasses) {
      await seedSimpleTask(h, status, status)
      await h.write('node_runs', [
        runValues(`${status}-run`, { task_id: status, envelope_nonce: null }),
      ])
      await h.write('clarify_rounds', [
        roundRow(`${status}-round`, status, {
          asking_node_id: 'ordinary',
          intermediary_node_id: 'ordinary',
          answers_json: '{malformed original answer',
        }),
      ])
      await h.write('collaboration_gate_operations', [gateRow(`${status}-gate`, status)])
      await h.write('task_workspace_preparations', [
        {
          id: `${status}-prep`,
          admission_key: `${status}-admission`,
          request_digest: 'digest',
          lane: 'repository-preparation',
          state: 'preparing',
          admitted_task_id: status,
          created_at: 1,
          updated_at: 2,
        },
      ])
    }
    // CrewStation RFC-044 T10: a preparation left behind by a Task delete is history, not a block.
    await h.write('task_workspace_preparations', [
      {
        id: 'orphan-prep',
        admission_key: 'orphan-admission',
        request_digest: 'digest',
        lane: 'repository-preparation',
        state: 'preparing',
        admitted_task_id: 'deleted-task',
        created_at: 1,
        updated_at: 2,
      },
    ])
    const input = await integrationInput(h)
    try {
      const result = await convertIntegration(input)
      const expected: (string | null)[][] = []
      for (const [status, execution] of taskClasses) {
        if (execution === 'executable')
          for (const [code, table, id] of [
            ['v2-run-null-nonce', 'node_runs', `${status}-run`],
            ['v2-run-selected-unprovable', 'node_runs', `${status}-run`],
            ['v2-clarify-json-unproven', 'clarify_rounds', `${status}-round`],
            ['v2-gate-open-in-flight', 'collaboration_gate_operations', `${status}-gate`],
            [
              'v2-task-workspace-preparation-in-flight',
              'task_workspace_preparations',
              `${status}-prep`,
            ],
          ] as const)
            expected.push([code, table, sourceKey(result, table, id)])
      }
      expect(blockList(result)).toEqual(expected.sort())
      expect(result.summary.status).toBe('blocked')
      assertTaskDtos(result)
      const histories = result.summary.historyOnly
      expect(histories.map((row) => [row.sourceTable, row.history!.taskId]).sort()).toEqual(
        ['failed', 'canceled', 'done']
          .flatMap((id) =>
            ['node_runs', 'clarify_rounds', 'collaboration_gate_operations'].map((table) => [
              table,
              id,
            ]),
          )
          .sort(),
      )
      for (const row of histories) {
        expect(row.history!.execution).toBe(
          row.history!.taskId === 'done' ? 'terminal-history' : 'retryable-history',
        )
        expect([...row.history!.missingFields].sort()).toEqual(
          row.sourceTable === 'node_runs'
            ? ['envelope_nonce', 'selected_run_id', 'slot_key']
            : row.sourceTable === 'clarify_rounds'
              ? ['answers_json']
              : ['legacy-open-replay'],
        )
        if (row.sourceTable === 'node_runs')
          expect(row.decision!.detail).toMatchObject({ resumeRetry: 'refused' })
      }
      for (const status of ['failed', 'canceled', 'done']) {
        expect(
          result.sink.rows('node_runs').find((row) => row.id === `${status}-run`),
        ).toMatchObject({ record_mode: 'history-only', envelope_nonce: null })
        expect(
          result.sink.rows('clarify_rounds').find((row) => row.id === `${status}-round`)!
            .legacy_answers_json,
        ).toBe('{malformed original answer')
        expect(
          result.sink
            .rows('task_workspace_preparations')
            .find((row) => row.id === `${status}-prep`)!.state,
        ).toBe('preparing')
      }
      expect(
        result.summary.records.filter(
          (row) => row.kind === 'decision' && row.code === 'v2-task-workspace-preparation-history',
        ),
      ).toHaveLength(3)
      expect(
        result.summary.records.filter(
          (row) => row.kind === 'decision' && row.code === 'v2-task-workspace-preparation-orphan',
        ),
      ).toMatchObject([{ payload: { taskId: 'deleted-task', state: 'preparing' } }])
      expect(
        result.sink.rows('task_workspace_preparations').find((row) => row.id === 'orphan-prep'),
      ).toMatchObject({ admitted_task_id: 'deleted-task', state: 'preparing' })
      expect(
        result.sink
          .rows('node_run_selections')
          .map((row) => row.selected_run_id)
          .sort(),
      ).toEqual(['canceled-run', 'done-run', 'failed-run'])
    } finally {
      await input.source.close()
    }
  }, 300_000)

  test('single non-root svc member: lost iso_node_tree only blocks executable in-flight isolation', async () => {
    await h.install()
    await seedRequiredRows(h)
    for (const status of ['interrupted', 'failed', 'canceled', 'done'])
      for (const state of ['isolating', 'pending-merge', 'merged']) {
        const id = `${status}-${state}`
        const task = taskRow(id, {
          status,
          space_kind: 'internal',
          workflow_snapshot: plainSnapshot,
        })
        await writeTaskFixture(h, task, {
          repos: [
            repoRow(task, {
              mount_path: 'svc',
              worktree_dir_name: 'svc',
              worktree_path: `/work/${id}/svc`,
            }),
          ],
        })
        await h.write('node_runs', [
          runValues(`${id}-run`, {
            task_id: id,
            merge_state: state,
            iso_worktree_path: `/iso/${id}/svc`,
            iso_base_snapshot: 'base',
            iso_node_tree: null,
            iso_node_tree_repos_json: null,
          }),
        ])
      }
    const input = await integrationInput(h)
    try {
      const result = await convertIntegration(input)
      expect(blockList(result)).toEqual(
        ['isolating', 'pending-merge']
          .flatMap((state) =>
            ['node-tree-lost-by-known-defect', 'v2-run-selected-unprovable'].map((code) => [
              code,
              'node_runs',
              sourceKey(result, 'node_runs', `interrupted-${state}-run`),
            ]),
          )
          .sort(),
      )
      expect(result.summary.historyOnly.map((row) => row.history!.taskId).sort()).toEqual(
        [
          'failed-isolating',
          'failed-pending-merge',
          'canceled-isolating',
          'canceled-pending-merge',
        ].sort(),
      )
      for (const row of result.summary.historyOnly) {
        expect(row.history!.execution).toBe('retryable-history')
        expect(row.history!.missingFields).toContain('iso_node_tree')
        expect(row.decision!.detail).toMatchObject({ resumeRetry: 'refused' })
      }
      assertTaskDtos(result)
      // CORE-8 removes every target row whose origin is blocked, including evidence/checkpoints.
      expect(result.sink.rows('node_run_repo_checkpoints')).toHaveLength(10)
      for (const checkpoint of result.sink.rows('node_run_repo_checkpoints')) {
        expect(checkpoint.node_tree).toBeNull()
        expect(
          result.sink
            .rows('task_repository_mounts')
            .find(
              (row) => row.task_id === checkpoint.task_id && row.repo_key === checkpoint.repo_key,
            )!.mount_path,
        ).toBe('svc')
      }
      const evidence = result.sink
        .rows('execution_legacy_evidence')
        .filter((row) => row.record_kind === 'node-run')
      expect(evidence).toHaveLength(10)
      for (const row of evidence)
        expect(Buffer.from(row.content_inline_bytes as Uint8Array).toString()).toContain(
          'node-tree-lost-by-known-defect',
        )
      expect(
        result.sink
          .rows('node_runs')
          .filter((row) => row.task_id === 'done-isolating' || row.task_id === 'interrupted-merged')
          .every((row) => row.record_mode === 'executable'),
      ).toBe(true)
    } finally {
      await input.source.close()
    }
  }, 300_000)

  test('unselected NULL nonce has explicit executionUse:none, while current execution remains selected', async () => {
    await h.install()
    await seedRequiredRows(h)
    await seedSimpleTask(h, 'unused', 'interrupted')
    await h.write('node_runs', [
      runValues('unused-old', { task_id: 'unused', envelope_nonce: null, seq: 1, started_at: 1 }),
      runValues('unused-current', {
        task_id: 'unused',
        seq: 2,
        started_at: 2,
        retry_index: 1,
        status: 'interrupted',
      }),
    ])
    const input = await integrationInput(h)
    try {
      const result = await convertIntegration(input)
      expect(result.summary.blocks).toEqual([])
      expect(result.summary.historyOnly).toHaveLength(1)
      expect(result.summary.historyOnly[0]).toMatchObject({
        sourceTable: 'node_runs',
        sourceKey: sourceKey(result, 'node_runs', 'unused-old'),
        history: {
          taskId: 'unused',
          runId: 'unused-old',
          execution: 'executable',
          executionUse: 'none',
          reason: 'null-envelope-nonce-unselected',
          missingFields: ['envelope_nonce'],
        },
      })
      expect(result.sink.rows('node_run_selections').map((row) => row.selected_run_id)).toEqual([
        'unused-current',
      ])
      assertTaskDtos(result)
    } finally {
      await input.source.close()
    }
  }, 300_000)

  test('unadopted unfinished history, undrained mission and non-dispatchable family produce only named blocks', async () => {
    await h.install()
    await seedRequiredRows(h)
    await h.write('development_missions', [
      frozenValues('development_missions', {
        id: 'open-mission',
        status: 'watching',
        terminal_at: null,
      }),
    ])
    await h.write('code_work_items', [
      frozenValues('code_work_items', {
        id: 'unfinished-work',
        anchor_id: 'unfinished-anchor',
        status: 'running',
      }),
      frozenValues('code_work_items', {
        id: 'finished-work',
        anchor_id: 'finished-anchor',
        status: 'settled',
      }),
    ])
    await h.write('committed_event_family_cutovers', [
      frozenValues('committed_event_family_cutovers', {
        producer: 'task-execution',
        family: 'review',
        mode: 'shadow',
      }),
    ])
    const input = await integrationInput(h)
    try {
      const result = await convertIntegration(input)
      const route = result.sourceRows
        .get('committed_event_family_cutovers')!
        .find((row) => row.values.family === 'review' && row.values.producer === 'task-execution')!
      expect(blockList(result)).toEqual(
        [
          [
            'v2-code-history-unfinished',
            'code_work_items',
            sourceKey(result, 'code_work_items', 'unfinished-work'),
          ],
          ['v2-code-history-package-blocked', 'code_work_items', null],
          ['v2-family-cutover-not-dispatchable', route.table, route.encodedKey],
          [
            'v2-writer-not-os-active',
            'employee_os_writer_state',
            sourceKey(result, 'employee_os_writer_state', 'global'),
          ],
        ].sort(),
      )
      expect(result.summary.historyOnly).toEqual([])
      expect(
        result.summary.tableReceipts.find((row) => row.sourceTable === 'code_work_items')!.counts,
      ).toEqual({ converted: 0, preserved: 0, archived: 0, blocked: 2 })
      expect(
        result.sink
          .rows('code_history_archives')
          .some((row) => row.source_table === 'code_work_items'),
      ).toBe(false)
      expect(
        result.sink
          .rows('committed_event_family_cutovers')
          .some((row) => row.family === 'review' && row.producer === 'task-execution'),
      ).toBe(false)
      expect(
        result.summary.blocks.find((row) => row.code === 'v2-writer-not-os-active')!.missingFields,
      ).toEqual(['development_missions.terminal_at'])
    } finally {
      await input.source.close()
    }
  }, 300_000)
})
