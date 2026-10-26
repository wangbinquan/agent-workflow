import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  TASK_ARCHIVE_V2_TABLES,
  type TaskArchiveV2Table,
  type TaskArchiveV2Manifest,
  type TaskArchiveV3Manifest,
} from '@/platform/contracts/taskArchive'
import {
  readTaskArchive,
  createTaskArchiveV2Reader,
  encodeTaskArchiveValue,
  decodeTaskArchiveValue,
  taskArchiveManifestDigest,
  taskArchiveV3Sections,
} from '@/modules/task-execution/infrastructure/taskArchiveWire'
import { createTaskArchiveTextSource } from './helpers/taskArchiveTextSource'

// BF-D21: v2 writers added tables without changing schemaVersion. These are
// frozen writer rosters, deliberately independent of the production union.
const AUGUST_2026_TABLES = [
  'tasks',
  'task_repos',
  'task_space_nodes',
  'task_collaborators',
  'task_questions',
  'task_feedback',
  'task_node_clarify_directives',
  'clarify_rounds',
  'doc_versions',
  'review_comments',
  'lifecycle_alerts',
  'recovery_events',
  'workgroup_task_state',
  'workgroup_assignments',
  'workgroup_messages',
  'workgroup_member_cursors',
  'node_runs',
  'node_run_outputs',
  'node_run_events',
  'task_execution_owners',
  'task_execution_intents',
  'task_execution_effects',
  'task_execution_effect_attempts',
  'task_execution_effect_fences',
  'task_execution_lineage_operation_records',
] as const satisfies readonly TaskArchiveV2Table[]
const V0192_TABLES = [
  'tasks',
  'task_repos',
  'task_space_nodes',
  'task_collaborators',
  'review_node_reviewers',
  'task_questions',
  'task_feedback',
  'task_node_clarify_directives',
  'clarify_rounds',
  'collaboration_gate_operations',
  'collaboration_gate_artifacts',
  'doc_versions',
  'review_comments',
  'lifecycle_alerts',
  'recovery_events',
  'workgroup_task_state',
  'workgroup_assignments',
  'workgroup_messages',
  'workgroup_member_cursors',
  'node_runs',
  'node_run_outputs',
  'node_run_events',
  'task_execution_owners',
  'task_execution_intents',
  'task_execution_effects',
  'task_execution_effect_attempts',
  'task_execution_effect_fences',
  'task_execution_lineage_operation_records',
] as const satisfies readonly TaskArchiveV2Table[]

function archive(version: 2 | 3, v2Tables: readonly TaskArchiveV2Table[] = TASK_ARCHIVE_V2_TABLES) {
  const sections = taskArchiveV3Sections()
  const tables = version === 2 ? [...v2Tables] : Object.values(sections).flatMap((s) => s.tables)
  const files = new Map<string, string>()
  const values =
    version === 2
      ? { id: 't', workflowId: 'legacy-host', answersJson: '[ 1 ]' }
      : {
          id: 't',
          bytes: new Uint8Array([0, 128, 255]),
          count: 9007199254740993n,
          json: '{ "x": 1 }',
        }
  const tableRows = Object.fromEntries(tables.map((table) => [table, table === 'tasks' ? 1 : 0]))
  for (const table of tables) {
    const text =
      table === 'tasks'
        ? JSON.stringify(version === 2 ? values : encodeTaskArchiveValue(values)) + '\n'
        : ''
    if (version === 3 || text) files.set(`archive/db/${table}.jsonl`, text)
  }
  const base = {
    rootTaskId: 't',
    taskIds: ['t'],
    exportedAt: '2026-10-21T00:00:00.000Z',
    rows: version === 2 ? { ...tableRows, runs_dirs: 1, logs_dirs: 1 } : tableRows,
    terminalMaintenance: { claim: { id: 'claim', memberSetDigest: 'members' }, members: [] },
  }
  const manifest = (
    version === 2
      ? { ...base, schemaVersion: 2 }
      : {
          ...base,
          schemaVersion: 3,
          sections,
          tableDigests: Object.fromEntries(
            tables.map((t) => [
              t,
              createHash('sha256')
                .update(files.get(`archive/db/${t}.jsonl`)!)
                .digest('hex'),
            ]),
          ),
        }
  ) as Omit<TaskArchiveV2Manifest | TaskArchiveV3Manifest, 'digest'>
  files.set(
    'archive/manifest.json',
    JSON.stringify({ ...manifest, digest: taskArchiveManifestDigest(manifest) }),
  )
  const source = createTaskArchiveTextSource({
    directory: 'archive',
    resolve: (a, b) => `${a}/${b}`,
    exists: async (p) => files.has(p),
    readText: async (p) => files.get(p)!,
  })
  return { source, files, values }
}
async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = []
  for await (const row of rows) all.push(row)
  return all
}
for (const version of [2, 3] as const)
  test(`v${version} is readable without changing historical JSON text`, async () => {
    const fixture = archive(version)
    const view = await readTaskArchive(fixture.source)
    expect(view.manifest.schemaVersion).toBe(version)
    expect(await collect(view.rows('tasks'))).toEqual([fixture.values])
    if (version === 2)
      expect((await createTaskArchiveV2Reader().read(fixture.source)).manifest.schemaVersion).toBe(
        2,
      )
  })
test('v3 wire preserves nested bytes/bigint and rejects corrupt table bytes before exposing rows', async () => {
  const value = { a: [new Uint8Array([0, 255]), 9007199254740993n], text: '{"codec":"bytes@1"}' }
  expect(decodeTaskArchiveValue(encodeTaskArchiveValue(value))).toEqual(value)
  const { source, files } = archive(3)
  files.set('archive/db/tasks.jsonl', '{"id":"changed"}\n')
  await expect(readTaskArchive(source)).rejects.toThrow('task-archive-table-digest-mismatch:tasks')
})
test('v2 preserves its original count/digest checks and accepts missing empty table files', async () => {
  const { source, files } = archive(2)
  files.delete('archive/db/tasks.jsonl')
  await expect(readTaskArchive(source)).rejects.toThrow('task-archive-row-count-mismatch:tasks')
})

for (const [release, tables, count] of [
  ['v0.19.2', V0192_TABLES, 28],
  ['2026-08-26 (650ced252)', AUGUST_2026_TABLES, 25],
] as const) {
  test(`BF-D21 reads the ${release} v2 manifest roster, not the later union`, async () => {
    const fixture = archive(2, tables)
    // An unlisted table is never read, even if a stray file exists.
    fixture.files.set('archive/db/hosted_task_artifacts.jsonl', 'not JSON')
    for (const view of [
      await readTaskArchive(fixture.source),
      await createTaskArchiveV2Reader().read(fixture.source),
    ]) {
      expect(Object.keys(view.manifest.rows)).toEqual([...tables, 'runs_dirs', 'logs_dirs'])
      expect(Object.keys(view.manifest.rows)).toHaveLength(count + 2)
      expect(view.manifest.rows).toMatchObject({ runs_dirs: 1, logs_dirs: 1 })
      expect(await collect(view.rows('tasks'))).toEqual([fixture.values])
      expect(await collect(view.rows('node_runs'))).toEqual([])
      expect(await collect(view.rows('hosted_task_artifacts'))).toEqual([])
    }
  })
  test(`BF-D21 still validates listed counts and the exact ${release} manifest digest`, async () => {
    const fixture = archive(2, tables)
    fixture.files.set('archive/db/node_runs.jsonl', '{"id":"extra"}\n')
    await expect(readTaskArchive(fixture.source)).rejects.toThrow(
      'task-archive-row-count-mismatch:node_runs',
    )
    fixture.files.delete('archive/db/node_runs.jsonl')
    const manifest = JSON.parse(
      fixture.files.get('archive/manifest.json')!,
    ) as TaskArchiveV2Manifest
    fixture.files.set(
      'archive/manifest.json',
      JSON.stringify({ ...manifest, rows: { ...manifest.rows, hosted_task_artifacts: 0 } }),
    )
    await expect(readTaskArchive(fixture.source)).rejects.toThrow(
      'task-archive-manifest-digest-mismatch',
    )
  })
}
