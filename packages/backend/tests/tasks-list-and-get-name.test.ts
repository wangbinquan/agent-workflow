// RFC-037 T3 — locks `services/task.ts` rowToTask + rowToSummary returning
// `name`. The list + single endpoints both rely on the row mapper functions;
// if either drops `name` the inbox / list pages will render undefined.
//
// This is a thin contract test against the row mappers (no HTTP). The 422
// validation flow lives in tasks-create-name.test.ts (T5).

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { taskListSummariesProjection } from '../src/modules/task-execution/infrastructure/taskRouteOperations'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { getTask } from '../src/services/task'

async function seedTask(db: PersistenceDb, name: string) {
  const wfId = ulid()
  const tId = ulid()
  const now = Date.now()
  const { workflows, tasks } = tablesOf(db)
  await insertOne(db, workflows, {
    id: wfId,
    name: 'wf',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  })
  await insertOne(db, tasks, {
    id: tId,
    name,
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/r',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${tId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: now,
  })
  return tId
}

describeEachProvider('RFC-037 — task row mappers include `name`', (harness) => {
  test('getTask returns name', async () => {
    const db = harness.db
    const id = await seedTask(db, 'PR-1234 fix pagination')
    const t = await getTask(db, id)
    expect(t?.name).toBe('PR-1234 fix pagination')
  })

  test('listTasks returns name per row', async () => {
    const db = harness.db
    await seedTask(db, 'one')
    await seedTask(db, 'two')
    const rows = await taskListSummariesProjection(db, { limit: 100 })
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual(['one', 'two'])
  })
})
