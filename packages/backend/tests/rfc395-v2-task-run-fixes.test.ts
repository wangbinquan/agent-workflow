// RFC-395 phase 2 T/N: exercise the real TaskFacts/mounts producers with NodeRun conversion.
import { expect, test } from 'bun:test'
import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'
import { conversion as runs } from '@/modules/task-execution/infrastructure/migration/run'
import { preservedRule } from '@/platform/persistence/migration/conversion/generic/preserved'
import { decodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  taskRow,
  repoRow,
  workgroupConfig,
  writeTaskFixture,
  convertTaskFixtures,
  assertTaskHistoryProjection,
} from './helpers/rfc395V2/taskFixtures'
import { runValues, ordinaryDefinition } from './helpers/rfc395V2/runFixtures'
import type { CanonicalLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'

const preparations = {
  rules: [preservedRule('task_workspace_preparations')],
  lookups: [],
  validators: [],
}
describeV2Providers('RFC-395 phase 2 T/N real cross-rule facts', (h) => {
  // PGX-A: numeric output aliases and locale text order used to disagree with
  // canonical keys. Exercise every cursor boundary, not just one large chunk.
  test('source keyset pages preserve numeric and UTF-8 order without gaps or duplicate keys', async () => {
    await h.install()
    const taskIds = ['order-a', 'order-Z', 'order-é', 'order-中', 'order-a-a', 'order-aa']
    const ordinals = [10, -1, 2, -10, 0, -2]
    for (const id of taskIds) {
      const task = taskRow(id)
      await writeTaskFixture(h, task, {
        repos: ordinals.map((repo_index) => repoRow(task, { repo_index })),
      })
    }
    const expected = [...taskIds]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .flatMap((id) => [...ordinals].sort((a, b) => a - b).map((ordinal) => [id, ordinal]))
    const source = await h.sourceHarness.source()
    try {
      await source.preflight()
      for (const limit of [1, 2, 5, 100]) {
        const actual: unknown[][] = []
        let after: readonly CanonicalLogicalValue[] | null = null
        for (;;) {
          const chunk = await source.readChunk('task_repos', after, limit)
          if (!chunk.rows.length) break
          actual.push(...chunk.decodedRows.map((row) => [row.task_id, row.repo_index]))
          expect(actual.length).toBeLessThanOrEqual(expected.length)
          after = chunk.lastKey
        }
        expect(actual).toEqual(expected)
      }
    } finally {
      await source.close()
    }
  })

  test('integer source cursors retain bigint precision above the safe-number boundary', async () => {
    await h.install()
    const ids = [9007199254740993n, 10n, 2n, 9007199254740992n]
    await h.write(
      'node_run_seq_allocations',
      ids.map((seq) => ({
        seq,
        task_id: 'pruned-task',
        node_run_id: `pruned-${seq}`,
        allocated_at: 123,
      })),
    )
    const source = await h.sourceHarness.source()
    try {
      await source.preflight()
      const actual: string[] = []
      let after: readonly CanonicalLogicalValue[] | null = null
      for (;;) {
        const chunk = await source.readChunk('node_run_seq_allocations', after, 1)
        if (!chunk.rows.length) break
        actual.push(String(chunk.decodedRows[0]!.seq))
        expect(actual.length).toBeLessThanOrEqual(ids.length)
        after = chunk.lastKey
      }
      expect(actual).toEqual(['2', '10', '9007199254740992', '9007199254740993'])
    } finally {
      await source.close()
    }
  })

  for (const mode of ['leader_worker', 'free_collab', 'dynamic_workflow'] as const)
    for (const phase of ['generating', 'executing'] as const)
      test(`${mode}/${phase}: platform snapshots prove unlinked host turns and historical DW generation`, async () => {
        await h.install()
        const dynamic = mode === 'dynamic_workflow'
        const task = taskRow('platform', {
          workflow_id: TASK_DEFINITION_HOSTS.workgroup.id,
          workgroup_id: 'group',
          workgroup_config_json: workgroupConfig(mode),
          status: 'awaiting_review',
          ...(dynamic && phase === 'executing'
            ? {
                workflow_snapshot: JSON.stringify({
                  $schema_version: 7,
                  nodes: [{ id: 'generated', kind: 'script' }],
                  edges: [],
                }),
              }
            : {}),
        })
        await writeTaskFixture(h, task, {
          state: {
            gate_status: 'awaiting_confirmation',
            dw_state_json: dynamic
              ? JSON.stringify({ phase, generateAttempts: 1, rejectRounds: 0 })
              : null,
          },
        })
        await h.write('node_runs', [
          runValues('host', {
            task_id: 'platform',
            node_id: dynamic ? '__dw_orchestrator__' : '__wg_leader__',
            rerun_cause: dynamic ? 'dw-generate' : 'wg-leader-round',
            seq: 1,
          }),
          runValues('gate', {
            task_id: 'platform',
            node_id: dynamic ? '__dw_orchestrator__' : '__wg_leader__',
            rerun_cause: dynamic ? 'dw-gate' : 'wg-gate',
            seq: 2,
            status: 'awaiting_review',
          }),
          ...(!dynamic
            ? [
                runValues('member', {
                  task_id: 'platform',
                  node_id: '__wg_member__',
                  rerun_cause: 'wg-message-turn',
                  shard_key: 'msg:member:message',
                  seq: 3,
                }),
              ]
            : []),
        ])
        const result = await convertTaskFixtures(h, { extra: [runs] })
        expect(result.summary.blocks).toEqual([])
        expect(result.summary.historyOnly).toEqual([])
        expect(result.facts.get('platform')!.engineKind).toBe(
          dynamic ? (phase === 'executing' ? 'dag' : 'dw-generate') : 'workgroup-turns',
        )
        expect(result.sink.rows('node_runs').every((row) => row.record_mode === 'executable')).toBe(
          true,
        )
        expect(
          result.sink
            .rows('node_run_selections')
            .map((row) => row.selected_run_id)
            .sort(),
        ).toEqual(dynamic ? ['gate', 'host'] : ['gate', 'host', 'member'])
        const slots = result.sink
          .rows('node_runs')
          .map((row) => decodeCanonicalRunSlot(String(row.slot_key)))
        expect(
          slots.some(
            (slot) =>
              slot.kind === 'synthetic' && slot.syntheticKind === (dynamic ? 'dw-gate' : 'wg-gate'),
          ),
        ).toBe(true)
      }, 180_000)

  for (const status of ['running', 'failed', 'canceled', 'done'])
    for (const state of ['preparing', 'prepared', 'compensating', 'admitted', 'failed', 'cleaned'])
      test(`${status}/${state}: only live preparations block, all bound journal states prove repo-prep`, async () => {
        await h.install()
        await writeTaskFixture(h, taskRow('prep', { status, worktree_path: '' }))
        await h.write('task_workspace_preparations', [
          {
            id: 'journal',
            admission_key: 'admission',
            request_digest: 'digest',
            lane: 'repository-preparation',
            state,
            admitted_task_id: 'prep',
            created_at: 1,
            updated_at: 2,
          },
        ])
        await h.write('node_runs', [
          runValues('prep-run', { task_id: 'prep', node_id: '__repo_prep__', status: 'failed' }),
        ])
        const result = await convertTaskFixtures(h, { extra: [runs, preparations] })
        const unfinished = ['preparing', 'prepared', 'compensating'].includes(state)
        expect(result.summary.blocks.map((row) => row.code)).toEqual(
          status === 'running' && unfinished ? ['v2-task-workspace-preparation-in-flight'] : [],
        )
        expect(result.sink.rows('node_runs')[0]!.record_mode).toBe('executable')
        expect(result.summary.historyOnly).toEqual([])
        const notes = result.summary.records.filter(
          (row) => row.kind === 'decision' && row.code === 'v2-task-workspace-preparation-history',
        )
        expect(notes).toHaveLength(status !== 'running' && unfinished ? 1 : 0)
        if (notes.length) {
          expect([...result.sink.units.values()].flatMap((unit) => unit.archives)).toHaveLength(1)
          expect(result.sink.rows('task_workspace_preparations')[0]!.state).toBe(state)
        }
      }, 180_000)

  test('pre-journal repo-prep has structural proof without an invented ledger', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('old-prep', { status: 'interrupted', worktree_path: '' }))
    await h.write('node_runs', [
      runValues('old-run', {
        task_id: 'old-prep',
        node_id: '__repo_prep__',
        status: 'failed',
        started_at: 1786665600000,
      }),
    ])
    const result = await convertTaskFixtures(h, { extra: [runs] })
    expect(result.summary.blocks).toEqual([])
    expect(result.sink.rows('node_runs')[0]!.record_mode).toBe('executable')
    expect(result.summary.historyOnly).toEqual([])
  }, 180_000)

  test('source mount aliases map real checkpoint keys outside in-flight isolation; branch fallback applies outside internal spaces', async () => {
    await h.install()
    const task = taskRow('alias', {
      status: 'running',
      space_kind: 'remote',
      base_branch: '',
      base_commit: null,
      workflow_snapshot: JSON.stringify(ordinaryDefinition),
    })
    await writeTaskFixture(h, task, {
      repos: [
        repoRow(task, {
          mount_path: 'pkg',
          worktree_dir_name: 'old-name',
          worktree_path: '/work/alias/pkg',
          branch: '',
        }),
      ],
    })
    await h.write('node_runs', [
      runValues('checkpoint', {
        task_id: 'alias',
        node_id: 'ordinary',
        iso_node_tree_repos_json: '{"old-name":"tree"}',
      }),
    ])
    const result = await convertTaskFixtures(h, { extra: [runs] })
    expect(result.summary.blocks).toEqual([])
    expect(result.mounts.get('alias')!.mounts[0]!.worktreeDirName).toBe('old-name')
    expect(result.sink.rows('task_repository_mounts')[0]!.branch).toBeNull()
    expect(result.sink.rows('node_run_repo_checkpoints')[0]!.node_tree).toBe('tree')
    expect(result.summary.historyOnly).toEqual([])
    assertTaskHistoryProjection(result, 'alias')
  }, 180_000)

  test('CORE-1 raw historical NULL name reaches the task fallback and every lookup', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('name-1234567890', { status: 'running' }))
    const source = await h.sourceHarness.source()
    const result = await convertTaskFixtures(h, {
      source: {
        ...source,
        async readChunk(table, after, limit) {
          if (table === 'tasks')
            throw new Error('logical database codec: fixture historical NULL name')
          return source.readChunk(table, after, limit)
        },
        async readRawChunk(table, after, limit) {
          const chunk = await source.readRawChunk(table, after, limit)
          return table !== 'tasks'
            ? chunk
            : {
                ...chunk,
                rows: chunk.rows.map((row) => ({
                  ...row,
                  cells: {
                    ...row.cells,
                    name: { storageClass: 'null', value: { type: 'null' as const } },
                  },
                })),
              }
        },
      },
    })
    expect(result.summary.blocks).toEqual([])
    expect(result.facts.get('name-1234567890')!.execution).toBe('executable')
    expect(result.sink.rows('tasks')[0]!.name).toBe('task-1234567890')
    expect(
      [...result.sink.units.values()]
        .flatMap((unit) => unit.dispositions)
        .find((row) => row.decision?.code === 'v2-task-codec-takeover')!.codecColumns,
    ).toEqual(['name'])
  })

  test('complete child lineage survives an ancestor codec failure', async () => {
    await h.install()
    await writeTaskFixture(h, taskRow('parent', { ref_closure_json: '{bad' }))
    await writeTaskFixture(
      h,
      taskRow('child', {
        status: 'running',
        parent_task_id: 'parent',
        execution_lineage_id: 'recorded-child',
        lineage_slot_path_json: '[ {"frozen":true} ]',
      }),
    )
    const result = await convertTaskFixtures(h)
    expect(
      result.summary.blocks.some(
        (row) => row.taskId === 'parent' && row.code === 'v2-source-codec',
      ),
    ).toBe(true)
    expect(result.summary.blocks.filter((row) => row.taskId === 'child')).toEqual([])
    expect(
      result.sink.rows('task_launch_contexts').find((row) => row.task_id === 'child'),
    ).toMatchObject({
      execution_lineage_id: 'recorded-child',
      lineage_slot_path_json: '[ {"frozen":true} ]',
    })
  })

  test('same conflict code on two repositories keeps each ordinal and missingFields separate', async () => {
    await h.install()
    const task = taskRow('two', { repo_count: 2 })
    await writeTaskFixture(h, task, {
      repos: [
        repoRow(task, { repo_index: 0, worktree_path: 'wrong' }),
        repoRow(task, {
          repo_index: -1,
          mount_path: 'pkg',
          worktree_dir_name: 'pkg',
          worktree_path: '/work/two/pkg',
        }),
      ],
    })
    const result = await convertTaskFixtures(h)
    expect(result.summary.blocks).toEqual([])
    const repos = result.sink
      .rows('execution_legacy_evidence')
      .filter((row) => row.record_kind === 'task-repo')
    expect(repos).toHaveLength(2)
    for (const row of repos) {
      const content = JSON.parse(Buffer.from(row.content_inline_bytes as Uint8Array).toString())
      const ordinals = content.detail.decisions.map(
        (decision: { ordinal: number }) => decision.ordinal,
      )
      expect(new Set(ordinals).size).toBe(1)
    }
    const restrictions = result.summary.historyOnly.filter(
      (row) => row.sourceTable === 'task_repos',
    )
    expect(restrictions).toHaveLength(2)
    for (const restriction of restrictions) {
      const detail = restriction.decision!.detail as { detail: { ordinal: number } }[]
      expect(new Set(detail.map((issue) => issue.detail.ordinal)).size).toBe(1)
      expect(restriction.history!.missingFields).toEqual(
        detail[0]!.detail.ordinal === -1 ? ['repo_index'] : ['worktree_path'],
      )
    }
  })
})
