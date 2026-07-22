// RFC-037 T4 — locks `listClarifySummaries` joining `tasks.name` onto each
// summary row. The inbox / clarify list rely on this field being non-empty
// for ordinary tasks; if the join silently drops the field, every row
// renders empty.

import { describe, expect, test } from 'bun:test'
import { insertClarifyRoundRaw } from './clarify-fixtures'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { listClarifyRoundSummaries } from '../src/services/clarifyRounds'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seed(
  db: ReturnType<typeof createInMemoryDb>,
  args: { taskName: string; status?: 'awaiting_human' | 'answered' },
) {
  const wfId = ulid()
  const tId = ulid()
  const nrId = ulid()
  const csId = ulid()
  const now = Date.now()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      description: '',
      definition: '{}',
      version: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(tasks)
    .values({
      id: tId,
      name: args.taskName,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/r',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${tId}`,
      status: 'running',
      inputs: '{}',
      startedAt: now,
    })
    .run()
  db.insert(nodeRuns)
    .values({
      id: nrId,
      taskId: tId,
      nodeId: 'clarify-1',
      retryIndex: 0,
      iteration: 0,
      status: 'awaiting_human',
      startedAt: now,
    })
    .run()
  await insertClarifyRoundRaw(db, {
    id: csId,
    taskId: tId,
    kind: 'self' as const,
    askingNodeId: 'agent-1',
    askingNodeRunId: 'nr-source',
    askingShardKey: null,
    intermediaryNodeId: 'clarify-1',
    intermediaryNodeRunId: nrId,
    iteration: 0,
    questionsJson: JSON.stringify([
      { id: 'q1', title: 'Q?', kind: 'single', options: [{ label: 'a' }, { label: 'b' }] },
    ]),
    answersJson: null,
    status: args.status ?? 'awaiting_human',
    truncationWarningsJson: null,
    createdAt: now,
    answeredAt: null,
    answeredBy: null,
  })
  return { tId, csId }
}

describe('RFC-037 — listClarifySummaries joins tasks.name → taskName', () => {
  test('summary row carries taskName equal to tasks.name', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, { taskName: 'PR-1234 fix' })
    const summaries = await listClarifyRoundSummaries(db, { status: 'awaiting_human' })
    expect(summaries.length).toBe(1)
    expect(summaries[0]?.taskName).toBe('PR-1234 fix')
  })

  test('multiple sessions across multiple tasks → each row has its own taskName', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, { taskName: 'alpha' })
    await seed(db, { taskName: 'beta' })
    const summaries = await listClarifyRoundSummaries(db, { status: 'awaiting_human' })
    expect(summaries.length).toBe(2)
    const names = summaries.map((s) => s.taskName).sort()
    expect(names).toEqual(['alpha', 'beta'])
  })

  test('summary still includes taskName when status filter narrows results', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db, { taskName: 'answered-task', status: 'answered' })
    const summaries = await listClarifyRoundSummaries(db, { status: 'answered' })
    expect(summaries[0]?.taskName).toBe('answered-task')
  })
})
