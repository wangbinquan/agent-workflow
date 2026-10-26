import type { V2Harness, V2LookupFixtures } from '../rfc395V2Harness'
import { V2MemorySink } from '../rfc395V2MemorySink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'
import type { TaskFacts, RunFrame } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { ClarifyQuestion } from '@agent-workflow/shared'

export const taskClasses = [
  ['pending', 'executable'],
  ['running', 'executable'],
  ['awaiting_review', 'executable'],
  ['awaiting_human', 'executable'],
  ['interrupted', 'executable'],
  ['failed', 'retryable-history'],
  ['canceled', 'retryable-history'],
  ['done', 'terminal-history'],
] as const

export const question = (id = 'q'): ClarifyQuestion => ({
  id,
  title: `Question ${id}`,
  kind: 'single',
  recommended: false,
  options: [
    { label: 'yes', description: '', recommended: false, recommendationReason: '' },
    { label: 'no', description: '', recommended: false, recommendationReason: '' },
  ],
})
export const answer = (questionId = 'q', customText = 'yes') => ({
  questionId,
  selectedOptionIndices: [0],
  customText,
})

export async function seedCollabTask(
  h: V2Harness,
  id = 'task',
  status = 'done',
  execution: TaskFacts['execution'] = 'terminal-history',
  overrides: DecodedSourceRow = {},
) {
  await h.write('tasks', [
    {
      id,
      name: id,
      workflow_id: 'workflow',
      workflow_snapshot: '{"nodes":[],"edges":[],"inputs":[]}',
      repo_path: '',
      worktree_path: '',
      base_branch: '',
      branch: '',
      status,
      inputs: '{}',
      started_at: 100,
      ...overrides,
    },
  ])
  await h.write('node_runs', [
    { id: `${id}-run`, task_id: id, node_id: 'n', status: 'done', started_at: 100, seq: 1 },
  ])
  const task: TaskFacts = {
    taskId: id,
    parentTaskId: null,
    rootTaskId: null,
    status,
    startedAt: 100,
    execution,
    subjectKind: 'workflow',
    sourceId: 'workflow',
    definitionAnchorId: 'workflow',
    engineKind: 'dag',
    spaceKind: 'internal',
    workflowVersion: 1,
  }
  const frame: RunFrame = {
    runId: `${id}-run`,
    taskId: id,
    containerRunId: null,
    scopePath: '[]',
    iteration: 0,
    quality: 'recorded',
  }
  return { task, frame }
}

export function roundRow(
  id: string,
  taskId = 'task',
  overrides: DecodedSourceRow = {},
): DecodedSourceRow {
  return {
    id,
    task_id: taskId,
    kind: 'self',
    asking_node_id: 'n',
    asking_node_run_id: `${taskId}-run`,
    intermediary_node_id: 'n',
    intermediary_node_run_id: `${taskId}-run`,
    questions_json: JSON.stringify([question()]),
    status: 'answered',
    created_at: 110,
    answered_at: 120,
    ...overrides,
  }
}

export function gateRow(
  id: string,
  taskId = 'task',
  overrides: DecodedSourceRow = {},
): DecodedSourceRow {
  return {
    id,
    task_id: taskId,
    gate_kind: 'clarify',
    operation_kind: 'open',
    gate_ref: id,
    idempotency_key: id,
    request_hash: `hash:${id}`,
    expected_task_revision: 0,
    expected_gate_revision: 0,
    state: 'prepared',
    created_at: 110,
    updated_at: 120,
    ...overrides,
  }
}

export async function readFixtureRows(h: V2Harness, table: string): Promise<SourceRow[]> {
  const source = await h.sourceHarness.source()
  try {
    await source.preflight()
    const chunk = await source.readChunk(table, null, 1000)
    return chunk.rows.map((canonical, index) => ({
      table,
      phase: 'current',
      key: canonical.key,
      encodedKey: encodeMigrationKey(table, canonical.key),
      canonical,
      values: chunk.decodedRows[index]!,
    }))
  } finally {
    await source.close()
  }
}

export async function convertFixtures(
  h: V2Harness,
  contributions: readonly ConversionContribution[],
  fixtures: V2LookupFixtures = {},
) {
  const input = await h.input(contributions, {
    fixtures,
    candidateBuild: 'v2-c-fixture',
    chunkLimit: 2,
  })
  try {
    const sink = new V2MemorySink()
    const summary = await runConversion(input, sink)
    return {
      sink,
      summary,
      units: [...sink.units.values()],
      dispositions: [...sink.units.values()].flatMap((unit) => unit.dispositions),
    }
  } finally {
    await input.source.close()
  }
}
