// RFC-164 follow-up — the /tasks list must link a workgroup task to its GROUP,
// not to the builtin `__workgroup_host__` workflow it is FK-anchored to (tasks
// .workflow_id / workflow_snapshot are NOT NULL, so every workgroup task points
// at the shared host workflow — see services/workgroupLaunch.ts).
//
// Before the fix the list showed `workflowName` (=== "__workgroup_host__") and
// linked to /workflows/$hostId. This locks the data half of the fix: listTasks
// projects TaskSummary.workgroupName from the task's OWN frozen
// `workgroup_config_json` — the same task-scoped source the room serves — so
// the UI can render /workgroups/$name.
//
// Why frozen config and NOT a live join on the `workgroups` resource: the room
// (loadVisibleWorkgroupTask) already serves this name to any task member gated
// only by canViewTask, so the frozen name stays inside the task's membership
// ACL (RFC-099). A live join would additionally leak live resource state (a
// post-launch rename) to a collaborator without workgroup visibility — the
// "live-name" divergence assertions below fail if anyone reintroduces it.
// Frontend wiring is locked by tasks-workgroup-badge.test.ts.

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
  opts: { name: string; workflowId: string; workgroupId?: string; workgroupConfigJson?: string },
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
      ...(opts.workgroupConfigJson !== undefined
        ? { workgroupConfigJson: opts.workgroupConfigJson }
        : {}),
    })
    .run()
  return tId
}

describe('RFC-164 follow-up — listTasks projects the frozen workgroup name', () => {
  test('workgroupName comes from the frozen config, NOT the live workgroups resource', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID, WORKGROUP_HOST_WORKFLOW_NAME)
    const groupId = ulid()
    // Live resource name deliberately DIVERGES from the frozen config name — the
    // summary must read the frozen one (a live join would surface 'live-name').
    db.insert(workgroups).values({ id: groupId, name: 'live-name' }).run()
    const tId = seedTask(db, {
      name: 'ship it',
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      workgroupId: groupId,
      workgroupConfigJson: JSON.stringify({ workgroupName: 'design-crew', mode: 'leader_worker' }),
    })

    const row = (await listTasks(db, { limit: 100 })).find((r) => r.id === tId)!
    expect(row.workgroupId).toBe(groupId)
    expect(row.workgroupName).toBe('design-crew') // frozen config, not 'live-name'
    // The workflow join still resolves the builtin host — proving the UI reads
    // the GROUP name (not this anchor) for the label + link.
    expect(row.workflowName).toBe(WORKGROUP_HOST_WORKFLOW_NAME)
  })

  test('renaming the live workgroup does NOT change the frozen name (freeze-at-launch)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID, WORKGROUP_HOST_WORKFLOW_NAME)
    const groupId = ulid()
    db.insert(workgroups).values({ id: groupId, name: 'design-crew' }).run()
    const tId = seedTask(db, {
      name: 't',
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      workgroupId: groupId,
      workgroupConfigJson: JSON.stringify({ workgroupName: 'design-crew' }),
    })
    db.update(workgroups).set({ name: 'renamed-live' }).where(eq(workgroups.id, groupId)).run()

    const row = (await listTasks(db, { limit: 100 })).find((r) => r.id === tId)!
    expect(row.workgroupName).toBe('design-crew') // still frozen, not 'renamed-live'
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

  test('a corrupt frozen config degrades workgroupName to null (never 5xx the list)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    seedWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID, WORKGROUP_HOST_WORKFLOW_NAME)
    const groupId = ulid()
    const tId = seedTask(db, {
      name: 't',
      workflowId: WORKGROUP_HOST_WORKFLOW_ID,
      workgroupId: groupId,
      workgroupConfigJson: '{ not valid json',
    })

    const row = (await listTasks(db, { limit: 100 })).find((r) => r.id === tId)!
    expect(row.workgroupId).toBe(groupId) // soft link still surfaces (badge)
    expect(row.workgroupName).toBeNull() // but the name degrades safely
  })
})
