import { expect, test } from 'bun:test'
import { overrideSourceValues } from './helpers/rfc395V2/sourceOverride'
import {
  encodeSyntheticOwner,
  decodeSyntheticOwner,
} from '@/modules/task-execution/domain/runSelection/syntheticOwner'
import {
  extractWriterFacts,
  type WriterEvidenceIndex,
} from '@/modules/task-execution/infrastructure/migration/run/writers'
import { deriveRunIdentities } from '@/modules/task-execution/infrastructure/migration/run/identity'
import { frozenRunDefinition } from '@/modules/task-execution/infrastructure/migration/run/definitions'
import { oracleRow } from '@/modules/task-execution/infrastructure/migration/run/source'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { TaskFacts } from '@/platform/persistence/migration/conversion/lookups/keys'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  runSource,
  runValues,
  taskFacts,
  taskMounts,
  writeTask,
} from './helpers/rfc395V2/runFixtures'

const noEvidence: WriterEvidenceIndex = {
  assignments: [],
  preparations: [],
  gateStatus: null,
  dwStateJson: null,
}
function identities(
  rows: readonly SourceRow[],
  nodes: unknown[],
  evidence = noEvidence,
  task: TaskFacts = taskFacts(),
) {
  const definition = frozenRunDefinition(
    JSON.stringify({ $schema_version: 7, nodes, edges: [], inputs: [] }),
    rows,
    task,
  )
  const writers = extractWriterFacts(task, definition, rows, evidence)
  const projected = rows.map((row, index) =>
    oracleRow(row, index + 1, {
      runId: String(row.values.id),
      taskId: task.taskId,
      containerRunId: row.values.container_run_id as string | null,
      scopePath: '',
      iteration: Number(row.values.iteration),
      quality: 'recorded',
    }),
  )
  return { values: deriveRunIdentities(projected, task, definition, writers), writers }
}
test('D25 owner codec is a versioned canonical tuple mirroring rs1 task/attempt positions', () => {
  for (const kind of ['task', 'attempt'] as const)
    for (const id of ['', 'a:b/[]', '中', 'e\u0301', '\u0000']) {
      const encoded = encodeSyntheticOwner({ kind, id })
      expect(encoded).toBe(JSON.stringify(['so1', kind, id]))
      expect(decodeSyntheticOwner(encoded)).toEqual({ kind, id })
    }
  for (const value of [
    'null',
    '[]',
    '["so2","task","a"]',
    '["so1","task","a",0]',
    '["so1", "task","a"]',
    '["so1","node","a"]',
  ])
    expect(() => decodeSyntheticOwner(value)).toThrow('invalid-synthetic-owner')
})
test('D5 name and cause alone prove no writer; same-named user nodes and __wg_clarify__ retain frozen ordinary identity', () => {
  const rows = [
    runSource('prep', { node_id: '__repo_prep__', rerun_cause: 'commit-push' }),
    runSource('clarify', { node_id: '__wg_clarify__' }),
  ]
  const actual = identities(rows, [
    { id: '__repo_prep__', kind: 'script' },
    { id: '__wg_clarify__', kind: 'clarify' },
  ])
  expect(actual.writers.writers.size).toBe(0)
  for (const value of actual.values.values()) {
    expect(value.role).toBe('node-attempt')
    expect(value.slot?.kind).toBe('node')
  }
  expect(
    identities([runSource('unknown', { node_id: '__repo_prep__' })], []).values.get('unknown')!
      .recordMode,
  ).toBe('executable')
})
test('D5 combined preparation and commit ledgers prove system rows, and a same-named user node is reported as a conflict', () => {
  const actual = identities(
    [
      runSource('prep', { node_id: '__repo_prep__' }),
      runSource('commit', { node_id: '__commit_push__', commit_push_json: '{}' }),
    ],
    [],
    { ...noEvidence, preparations: ['task_workspace_preparations:admitted:task'] },
  )
  expect(actual.values.get('prep')!.syntheticKind).toBe('repo-prep')
  expect(actual.values.get('commit')!.syntheticKind).toBe('commit-push')
  const collision = identities(
    [runSource('commit', { node_id: '__commit_push__', commit_push_json: '{}' })],
    [{ id: '__commit_push__', kind: 'script' }],
  )
  expect(collision.writers.conflicts.has('commit')).toBe(true)
  expect(collision.values.get('commit')!.evidence.conflicts).toContain('writer.user-node')
  expect(collision.values.get('commit')!.recordMode).toBe('history-only')
})
test('NULL-cause commit-session is proved by its commit-push parent; an ordinary parent cannot supply that writer', () => {
  const actual = identities(
    [
      runSource('parent', { node_id: '__commit_push__', commit_push_json: '{}' }),
      runSource('session', {
        node_id: '__commit_push__',
        parent_node_run_id: 'parent',
        rerun_cause: null,
      }),
    ],
    [],
  )
  expect(actual.values.get('session')!.syntheticKind).toBe('commit-session')
  expect(actual.values.get('session')!.slot).toMatchObject({
    owner: { kind: 'attempt', id: 'parent' },
  })
  const user = identities(
    [
      runSource('parent'),
      runSource('session', { parent_node_run_id: 'parent', rerun_cause: null }),
    ],
    [{ id: 'ordinary', kind: 'script' }],
  )
  expect(user.values.get('session')!.recordMode).toBe('history-only')
})
test("fanout with no aggregator writer records aggregatorId null without consulting today's agents", () => {
  const definition = frozenRunDefinition(
    JSON.stringify({
      $schema_version: 7,
      nodes: [
        { id: 'w', kind: 'wrapper-fanout', nodeIds: ['a'] },
        { id: 'a', kind: 'agent-single', agentName: 'aggregator' },
      ],
      edges: [],
    }),
  )
  expect(definition.fanouts).toMatchObject([
    { wrapperNodeId: 'w', aggregatorNodeId: null, sharedNodeIds: ['a'] },
  ])
  expect(definition.missingFacts).toEqual([])
})

describeV2Providers('RFC-395 V2-N D4 identity and nonce classes', (h) => {
  for (const status of [
    'pending',
    'running',
    'awaiting_review',
    'awaiting_human',
    'interrupted',
    'failed',
    'canceled',
    'done',
  ])
    for (const defect of ['nonce', 'identity', 'container', 'collision'] as const)
      test(`${status}: selected ${defect} uncertainty is blocked or listed as history-only`, async () => {
        await h.install()
        const task = taskFacts('task', status)
        await writeTask(
          h,
          task,
          defect === 'collision'
            ? { $schema_version: 7, nodes: [{ id: '__commit_push__', kind: 'script' }], edges: [] }
            : undefined,
        )
        await h.write('node_runs', [
          runValues('run', {
            ...(defect === 'nonce' ? { envelope_nonce: null } : {}),
            ...(defect === 'identity' ? { node_id: 'missing' } : {}),
            ...(defect === 'collision'
              ? { node_id: '__commit_push__', commit_push_json: '{}' }
              : {}),
          }),
        ])
        const input = await h.input([conversion], {
          fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
          ...(defect === 'container'
            ? {
                source: overrideSourceValues(
                  await h.sourceHarness.source(),
                  'node_runs',
                  (row) => ({ ...row, container_run_id: 'missing' }),
                ),
              }
            : {}),
        })
        try {
          const sink = new V2MemorySink()
          const result = await runConversion(input, sink)
          expect(result.blocks.length > 0).toBe(task.execution === 'executable')
          if (task.execution === 'executable') {
            expect(sink.rows('node_runs')).toEqual([])
            expect(sink.rows('execution_legacy_evidence')).toEqual([])
          } else {
            const run = sink.rows('node_runs')[0]!
            expect(run.record_mode).toBe('history-only')
            if (defect === 'container') expect(run.container_run_id).toBe(null)
            if (defect === 'nonce') expect(run.envelope_nonce).toBe(null)
          }
          const dispositions = [...sink.units.values()]
            .flatMap((unit) => unit.dispositions)
            .filter((entry) => entry.kind === 'history-only')
          expect(dispositions).toHaveLength(task.execution === 'executable' ? 0 : 1)
          if (task.execution !== 'executable')
            expect(dispositions[0]!.history).toMatchObject({
              taskId: 'task',
              runId: 'run',
              execution: task.execution,
            })
          expect(sink.rows('execution_legacy_evidence')).toHaveLength(
            task.execution === 'executable' ? 0 : 1,
          )
          if (defect === 'collision')
            expect(
              [...sink.units.values()]
                .flatMap((unit) => unit.records)
                .filter(
                  (record) =>
                    record.kind === 'decision' &&
                    record.code === 'v2-run-writer-user-node-conflict',
                ),
            ).toHaveLength(1)
        } finally {
          await input.source.close()
        }
      }, 180_000)
})
