// RFC-037 T3 — locks `services/task.ts` rowToTask + rowToSummary returning
// `name`. The list + single endpoints both rely on the row mapper functions;
// if either drops `name` the inbox / list pages will render undefined.
//
// This is a thin contract test against the row mappers (no HTTP). The 422
// validation flow lives in tasks-create-name.test.ts (T5).

import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { tasks, workflows } from '../src/db/schema'
import { getTask, listTasks } from '../src/services/task'

async function seedTask(db: ProviderNeutralDatabase, name: string) {
  const wfId = ulid()
  const tId = ulid()
  const now = Date.now()
  await db
    .insert(workflows)
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
  await db
    .insert(tasks)
    .values({
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
    .run()
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
    const rows = await listTasks(db, { limit: 100 })
    const names = rows.map((r) => r.name).sort()
    expect(names).toEqual(['one', 'two'])
  })
})
