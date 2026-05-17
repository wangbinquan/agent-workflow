// RFC-026 T6 — buildClarifyPromptContext respects the `sessionMode` arg.
//
// Locks:
//   - sessionMode === 'inline'  → only the most-recent answered round is
//     rendered (no prior questions, no historical answers), and the returned
//     context carries `mode: 'inline'` + `currentRoundOnly: true` so
//     renderUserPrompt picks the short trailing reminder.
//   - sessionMode === 'isolated' / undefined → multi-round dump unchanged
//     (RFC-023 behavior verbatim — locked in clarify-service.test.ts already).
//
// If these go red, RFC-026's inline-mode "agent reads only fresh answers,
// session memory has the rest" promise (proposal §1 / §2.1) is broken.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildClarifyPromptContext,
  createClarifySession,
  submitClarifyAnswers,
} from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function emptyDefinition(): WorkflowDefinition {
  return { $schema_version: 3, inputs: [], nodes: [], edges: [], outputs: [] }
}

async function seedTask(db: DbClient): Promise<{ taskId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clarify1', portName: 'questions' },
      },
    ],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc026/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

function makeQuestion(title: string): ClarifyQuestion {
  return {
    id: 'q1',
    title,
    kind: 'single',
    recommended: true,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
      { label: 'SQLite', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAnswer(pickIndex: number): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [pickIndex],
    selectedOptionLabels: [],
    customText: '',
  }
}

async function seedRound(
  db: DbClient,
  taskId: string,
  runId: string,
  iterationIndex: number,
  questionTitle: string,
  pickIndex: number,
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: iterationIndex,
  })
  const { clarifyNodeRunId } = await createClarifySession({
    db,
    taskId,
    sourceAgentNodeId: 'designer',
    sourceAgentNodeRunId: runId,
    sourceShardKey: null,
    clarifyNodeId: 'clarify1',
    iterationIndex,
    questions: [makeQuestion(questionTitle)],
  })
  await submitClarifyAnswers({
    db,
    clarifyNodeRunId,
    answers: [makeAnswer(pickIndex)],
  })
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-026 buildClarifyPromptContext — sessionMode', () => {
  test('sessionMode="inline" collapses dump to most-recent round and tags context.mode', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)

    // Three rounds: Postgres → MySQL → SQLite. In isolated mode the context
    // dumps all three; inline mode drops the first two and keeps only the
    // latest ("SQLite") because opencode's resumed session memory has them.
    await seedRound(db, taskId, 'nr_r1', 0, 'Which database?', 0) // Postgres
    await seedRound(db, taskId, 'nr_r2', 1, 'Which ORM?', 1) // MySQL idx
    await seedRound(db, taskId, 'nr_r3', 2, 'Which migration tool?', 2) // SQLite idx

    const inline = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 3,
      shardKey: null,
      sessionMode: 'inline',
    })

    expect(inline).toBeDefined()
    expect(inline?.mode).toBe('inline')
    expect(inline?.currentRoundOnly).toBe(true)
    // Only round 3's content should leak through.
    expect(inline?.answersBlock ?? '').toContain('SQLite')
    expect(inline?.answersBlock ?? '').not.toContain('Postgres')
    expect(inline?.answersBlock ?? '').not.toContain('MySQL')
    // Question titles: only the latest round is included.
    expect(inline?.questionsBlock ?? '').toContain('Which migration tool?')
    expect(inline?.questionsBlock ?? '').not.toContain('Which database?')
    expect(inline?.questionsBlock ?? '').not.toContain('Which ORM?')
    // Iteration counter is still 3 — inline doesn't fudge the iteration math,
    // it only changes WHICH prior rounds get rendered.
    expect(inline?.iteration).toBe('3')
  })

  test('sessionMode="isolated" matches default (undefined) byte-for-byte', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedRound(db, taskId, 'nr_a', 0, 'Which database?', 0)
    await seedRound(db, taskId, 'nr_b', 1, 'Which ORM?', 1)

    const explicit = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      sessionMode: 'isolated',
    })
    const omitted = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
    })

    expect(explicit).toBeDefined()
    expect(omitted).toBeDefined()
    expect(explicit?.mode).toBeUndefined()
    expect(explicit?.currentRoundOnly).toBeUndefined()
    expect(explicit?.questionsBlock).toBe(omitted?.questionsBlock)
    expect(explicit?.answersBlock).toBe(omitted?.answersBlock)
    expect(explicit?.iteration).toBe(omitted?.iteration)
    // Multi-round dump preserved: both prior rounds present.
    expect(explicit?.answersBlock ?? '').toContain('Postgres')
    expect(explicit?.answersBlock ?? '').toContain('MySQL')
    expect(explicit?.questionsBlock ?? '').toContain('Which database?')
    expect(explicit?.questionsBlock ?? '').toContain('Which ORM?')
  })
})
