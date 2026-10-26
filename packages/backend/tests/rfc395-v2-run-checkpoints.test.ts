import { expect, test } from 'bun:test'
import { convertCheckpoints } from '@/modules/task-execution/infrastructure/migration/run/checkpoints'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  runSource,
  runValues,
  taskFacts,
  taskMounts,
  writeTask,
} from './helpers/rfc395V2/runFixtures'

test('scalar checkpoints map to the unique mount, including a single non-root member', () => {
  for (const paths of [[''], ['nested']]) {
    const mounts = taskMounts('task', paths)
    const result = convertCheckpoints(
      runSource('r', {
        pre_snapshot: '',
        iso_base_snapshot: 'base',
        iso_node_tree: 'tree',
        iso_submodules_json: '{ "poolDirs": {} }',
      }),
      mounts,
      'executable',
    )
    expect(result.decisions).toEqual([])
    expect(result.rows).toEqual([
      {
        node_run_id: 'r',
        task_id: 'task',
        repo_key: mounts.mounts[0]!.repoKey,
        pre_snapshot: '',
        isolation_base: 'base',
        node_tree: 'tree',
        submodules: '{ "poolDirs": {} }',
      },
    ])
  }
})
test('per-repo maps use worktree_dir_name and preserve NULL, empty string, id, and raw submodule bytes', () => {
  const mounts = taskMounts('task', ['', 'pkg', 'empty'])
  const result = convertCheckpoints(
    runSource('r', {
      pre_snapshot_repos_json: '{"":"","pkg":"commit","empty":null}',
      iso_node_tree_repos_json: '{"pkg":"tree"}',
      iso_submodules_repos_json: '{"pkg":{ "a": 1 }}',
    }),
    mounts,
    'executable',
  )
  expect(result.decisions).toEqual([])
  expect(
    result.rows.map((row) => [row.repo_key, row.pre_snapshot, row.node_tree, row.submodules]),
  ).toEqual([
    [mounts.mounts[0]!.repoKey, '', null, null],
    [mounts.mounts[1]!.repoKey, 'commit', 'tree', '{ "a": 1 }'],
    [mounts.mounts[2]!.repoKey, null, null, null],
  ])
  expect(convertCheckpoints(runSource('empty'), mounts, 'executable').rows).toEqual([])
})
test('unmapped keys, empty-key without a root, malformed maps, duplicate keys, scalar/map conflicts and scalar-only multi-repo values retain evidence', () => {
  const mounts = taskMounts('task', ['a', 'b'])
  for (const [over, code] of [
    [{ pre_snapshot_repos_json: '{"missing":"sha"}' }, 'v2-run-checkpoint-key-unmapped'],
    [{ pre_snapshot_repos_json: '{"":"sha"}' }, 'v2-run-checkpoint-key-unmapped'],
    [{ pre_snapshot_repos_json: '{bad' }, 'v2-run-checkpoint-malformed'],
    [{ pre_snapshot_repos_json: '{"a":"x","a":"y"}' }, 'v2-run-checkpoint-duplicate-key'],
    [{ pre_snapshot: 'scalar' }, 'v2-run-checkpoint-scalar-unmapped'],
  ] as const)
    expect(
      convertCheckpoints(runSource('r', over), mounts, 'executable').decisions.some(
        (decision) => decision.code === code && decision.unprovable,
      ),
    ).toBe(true)
  expect(
    convertCheckpoints(
      runSource('r', { pre_snapshot: 'x', pre_snapshot_repos_json: '{"":"y"}' }),
      taskMounts(),
      'executable',
    ).decisions[0]!.code,
  ).toBe('v2-run-checkpoint-conflict')
})
test('known single non-root iso_node_tree defect records the run, never invents a tree, and merged only needs evidence', () => {
  for (const merge_state of [
    'isolating',
    'pending-merge',
    'merged',
    'abandoned',
    'merge-failed',
    'conflict-human',
    null,
  ]) {
    const result = convertCheckpoints(
      runSource('r', { merge_state, iso_worktree_path: '/iso' }),
      taskMounts('task', ['member']),
      'executable',
    )
    expect(result.rows).toEqual([])
    expect(result.decisions).toEqual([
      {
        code: 'node-tree-lost-by-known-defect',
        missingFields: ['iso_node_tree'],
        detail: { runId: 'r', mergeState: merge_state, execution: 'executable' },
        unprovable: merge_state === 'isolating' || merge_state === 'pending-merge',
      },
    ])
  }
})

describeV2Providers('RFC-395 V2-N checkpoint restrictions', (h) => {
  for (const status of ['running', 'failed', 'done'])
    test(`${status}: unmapped checkpoint keys and scalar-only multi-repo values do not acquire guessed mounts`, async () => {
      await h.install()
      const task = taskFacts('task', status)
      await writeTask(h, task)
      await h.write('node_runs', [
        runValues('scalar', { seq: 1, pre_snapshot: 'root' }),
        runValues('map', { seq: 2, iso_node_tree_repos_json: '{"missing":"tree"}' }),
      ])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts('task', ['a', 'b'])] },
      })
      try {
        const sink = new V2MemorySink()
        const result = await runConversion(input, sink)
        expect(sink.rows('node_run_repo_checkpoints')).toEqual([])
        expect(result.blocks.some((block) => block.code === 'v2-run-checkpoint-key-unmapped')).toBe(
          status === 'running',
        )
        expect(
          result.blocks.some((block) => block.code === 'v2-run-checkpoint-scalar-unmapped'),
        ).toBe(status === 'running')
        expect(sink.rows('execution_legacy_evidence')).toHaveLength(status === 'running' ? 0 : 2)
        expect(result.historyOnly).toHaveLength(status === 'running' ? 0 : 2)
      } finally {
        await input.source.close()
      }
    }, 180_000)
  for (const status of ['running', 'failed', 'done'])
    for (const mergeState of [
      'isolating',
      'pending-merge',
      'merged',
      'abandoned',
      'merge-failed',
      'conflict-human',
      null,
    ])
      test(`${status}/${mergeState}: known node-tree loss follows D4 and preserves checkpoint values`, async () => {
        await h.install()
        const task = taskFacts('task', status)
        await writeTask(h, task)
        await h.write('node_runs', [
          runValues('r', {
            merge_state: mergeState,
            pre_snapshot: '',
            iso_base_snapshot: 'base',
            iso_worktree_path: '/iso',
          }),
        ])
        const input = await h.input([conversion], {
          fixtures: { taskFacts: [task], taskMounts: [taskMounts('task', ['member'])] },
        })
        try {
          const sink = new V2MemorySink()
          const result = await runConversion(input, sink)
          expect(
            result.blocks.some((block) => block.code === 'node-tree-lost-by-known-defect'),
          ).toBe(
            status === 'running' && (mergeState === 'isolating' || mergeState === 'pending-merge'),
          )
          expect(
            result.blocks.filter(
              (block) =>
                block.code !== 'node-tree-lost-by-known-defect' &&
                block.code !== 'v2-run-selected-unprovable',
            ),
          ).toEqual([])
          const uncertain =
            status !== 'done' && (mergeState === 'isolating' || mergeState === 'pending-merge')
          if (status === 'running' && uncertain) {
            expect(sink.rows('node_runs')).toEqual([])
            expect(sink.rows('node_run_repo_checkpoints')).toEqual([])
          } else {
            expect(sink.rows('node_run_repo_checkpoints')[0]).toMatchObject({
              pre_snapshot: '',
              isolation_base: 'base',
              node_tree: null,
            })
            expect(sink.rows('node_runs')[0]!.record_mode).toBe(
              uncertain ? 'history-only' : 'executable',
            )
            const evidence = sink.rows('execution_legacy_evidence')[0]!
            expect(Buffer.from(evidence.content_inline_bytes as Uint8Array).toString()).toContain(
              'node-tree-lost-by-known-defect',
            )
          }
        } finally {
          await input.source.close()
        }
      }, 180_000)
})
