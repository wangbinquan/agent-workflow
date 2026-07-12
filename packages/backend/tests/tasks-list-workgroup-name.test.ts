// RFC-164 follow-up — the /tasks list must link a workgroup task to its GROUP,
// not to the builtin `__workgroup_host__` workflow it is FK-anchored to (tasks
// .workflow_id / workflow_snapshot are NOT NULL, so every workgroup task points
// at the shared host workflow — see services/workgroupLaunch.ts).
//
// Before the fix the list showed `workflowName` (=== "__workgroup_host__") and
// linked to /workflows/$hostId. This locks the data half of the fix: listTasks
// live-joins the owning group's CURRENT name into TaskSummary.workgroupName so
// the UI can render /workgroups/$name. The frontend wiring is locked by
// tasks-workgroup-badge.test.ts.

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows, workgroups } from '../src/db/schema'
import { listTasks } from '../src/services/task'
import {
  WORKGROUP_HOST_WORKFLOW_ID,
  WORKGROUP_HOST_WORKFLOW_NAME,
} from '../src/services/workgroupLaunch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedWorkflow(db: ReturnType<typeof createInMemoryDb>, id: string, name: string): void {
  const now = Date.now()
  db.insert(workflows)
    .values({
      id,
      name,
      description: '',
      definition: '{}',
      version: 1,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

function seedTask(
  db: ReturnType<typeof createInMemoryDb>,
  opts: { name: string; workflowId: string; workgroupId?: string },
): string {
  const tId = ulid()
  const now = Date.now()
  db.insert(tasks)
    .values({
      id: tId,
      name: opts.name,
      workflowId: opts.workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/r',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${tId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: now,
      ...(opts.workgroupId !== undefined ? { workgroupId: opts.workgroupId } : {}),
    })
    .run()
  return tId
}

describe('RFC-164 follow-up — listTasks joins the owning workgroup name', () => {
  test('a workgroup task carries workgroupName while workflowName stays the host anchor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID, WORKGROUP_HOST_WORKFLOW_NAME)
    const groupId = ulid()
    db.insert(workgroups).values({ id: groupId, name: 'design-crew' }).run()
    const tId = seedTask(db, {
      name: 'ship it',
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      workgroupId: groupId,
    })

    const row = (await listTasks(db, { limit: 100 })).find((r) => r.id === tId)!
    expect(row.workgroupId).toBe(groupId)
    expect(row.workgroupName).toBe('design-crew')
    // The workflow join still resolves the builtin host — proving the UI must
    // read the GROUP name (not this anchor) for the label + link.
    expect(row.workflowName).toBe(WORKGROUP_HOST_WORKFLOW_NAME)
  })

  test('workgroupName tracks a rename (live join, not launch-frozen)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID, WORKGROUP_HOST_WORKFLOW_NAME)
    const groupId = ulid()
    db.insert(workgroups).values({ id: groupId, name: 'old-name' }).run()
    const tId = seedTask(db, {
      name: 't',
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      workgroupId: groupId,
    })
    db.update(workgroups).set({ name: 'new-name' }).where(eq(workgroups.id, groupId)).run()

    const row = (await listTasks(db, { limit: 100 })).find((r) => r.id === tId)!
    expect(row.workgroupName).toBe('new-name')
  })

  test('workgroupName is null for a non-workgroup task', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    seedWorkflow(db, wfId, 'plain-wf')
    const tId = seedTask(db, { name: 'solo', workflowId: wfId })

    const row = (await listTasks(db, { limit: 100 })).find((r) => r.id === tId)!
    expect(row.workgroupId).toBeNull()
    expect(row.workgroupName).toBeNull()
  })

  test('workgroupName is null when the group row was deleted (durable soft link stays)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID, WORKGROUP_HOST_WORKFLOW_NAME)
    const groupId = ulid()
    db.insert(workgroups).values({ id: groupId, name: 'gone' }).run()
    const tId = seedTask(db, {
      name: 't',
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      workgroupId: groupId,
    })
    db.delete(workgroups).where(eq(workgroups.id, groupId)).run()

    const row = (await listTasks(db, { limit: 100 })).find((r) => r.id === tId)!
    expect(row.workgroupId).toBe(groupId) // soft link stays on the task row
    expect(row.workgroupName).toBeNull() // but the join yields no name
  })
})
