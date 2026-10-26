// RFC-232 — owner projection batching + scheduled-list mapper parity.

import { taskFixture, workflowFixture } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { taskListItemsProjection } from '../src/modules/task-execution/infrastructure/taskRouteOperations'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/providerOperations'

import { buildActor, SYSTEM_USER_ID } from '../src/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'
import {
  listScheduledTaskItems,
  listScheduledTasks,
} from './helpers/integrationTriggerResourceBinding'
import { OWNER_IDENTITY_SQL_BATCH_SIZE } from '@/modules/identity-access/public/operations'

const SCHEDULE_SPEC = JSON.stringify({ kind: 'daily', at: '09:00', timezone: 'UTC' })

const adminActor = buildActor({
  user: {
    id: 'viewer',
    username: 'viewer',
    displayName: 'Viewer',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

function launchPayload(repoUrl = 'https://example.com/repo.git'): string {
  return JSON.stringify({
    workflowId: 'workflow-1',
    name: 'scheduled run',
    repoUrl,
    ref: 'main',
    inputs: {},
  })
}

describeEachProvider('RFC-232 — scheduled-task owner list projection', (harness) => {
  test('combines every owner across more than one bounded SQL batch', async () => {
    const db = harness.db
    const total = OWNER_IDENTITY_SQL_BATCH_SIZE + 1
    const now = Date.now()
    const userRows = Array.from({ length: total }, (_, index) => {
      const suffix = String(index).padStart(3, '0')
      return {
        id: `owner-${suffix}`,
        username: `owner_${suffix}`,
        displayName: `Owner ${suffix}`,
        createdAt: now,
        updatedAt: now,
      }
    })
    const scheduleRows = userRows.map((owner, index) => ({
      id: `schedule-${String(index).padStart(3, '0')}`,
      name: `Schedule ${index}`,
      ownerUserId: owner.id,
      launchPayload: launchPayload(),
      scheduleSpec: SCHEDULE_SPEC,
      createdAt: now,
      updatedAt: now,
    }))

    for (let offset = 0; offset < total; offset += 100) {
      const { users, scheduledTasks } = tablesOf(db)
      await db.insert(users).values(userRows.slice(offset, offset + 100))
      await db.insert(scheduledTasks).values(scheduleRows.slice(offset, offset + 100))
    }

    const rows = await listScheduledTaskItems(db, adminActor)
    expect(rows).toHaveLength(total)
    expect(rows.every((row) => row.owner?.id === row.ownerUserId)).toBe(true)
    expect(new Set(rows.map((row) => row.owner?.id)).size).toBe(total)
  })

  test('keeps canonical tolerant/redacting mapping and degrades missing owners', async () => {
    const db = harness.db
    const now = Date.now()
    const { users, scheduledTasks } = tablesOf(db)
    await insertOne(db, users, {
      id: 'owner-alice',
      username: 'alice',
      displayName: 'Alice',
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(scheduledTasks).values([
      {
        id: 'schedule-redacted',
        name: 'Redacted',
        ownerUserId: 'owner-alice',
        launchPayload: launchPayload('https://alice:secret@example.com/repo.git'),
        scheduleSpec: SCHEDULE_SPEC,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'schedule-corrupt',
        name: 'Corrupt',
        ownerUserId: 'deleted-owner',
        launchPayload: launchPayload(),
        scheduleSpec: '{bad json',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'schedule-system',
        name: 'System',
        ownerUserId: SYSTEM_USER_ID,
        launchPayload: launchPayload(),
        scheduleSpec: SCHEDULE_SPEC,
        createdAt: now,
        updatedAt: now,
      },
    ])

    const canonical = await listScheduledTasks(db)
    const ownerRows = await listScheduledTaskItems(db, adminActor)
    const withoutOwner = ownerRows.map(({ owner: _owner, ...row }) => row)
    expect(withoutOwner).toEqual(canonical)

    const redacted = ownerRows.find((row) => row.id === 'schedule-redacted')
    expect(JSON.stringify(redacted?.launchPayload)).not.toContain('secret')
    expect(redacted?.owner).toEqual({
      id: 'owner-alice',
      username: 'alice',
      displayName: 'Alice',
    })

    const corrupt = ownerRows.find((row) => row.id === 'schedule-corrupt')
    expect(corrupt?.scheduleSpec).toBeNull()
    expect(corrupt?.migrationError?.scheduleSpec).toContain('invalid-json')
    expect(corrupt).toMatchObject({ ownerUserId: 'deleted-owner', owner: null })

    expect(ownerRows.find((row) => row.id === 'schedule-system')).toMatchObject({
      ownerUserId: SYSTEM_USER_ID,
      owner: null,
    })
  })
})

describeEachProvider('RFC-232 — task owner list projection', (harness) => {
  test('keeps a null owner and clears a removed owner while degrading identity to null', async () => {
    const db = harness.db
    const now = Date.now()
    await workflowFixture(db, {
      id: 'workflow-task-owner-fallbacks',
      name: 'Owner fallback workflow',
      description: '',
      definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    })
    const baseTask = {
      name: 'Owner fallback task',
      workflowId: 'workflow-task-owner-fallbacks',
      workflowSnapshot: '{}',
      repoPath: '/tmp/rfc232-owner-fallbacks',
      repoUrl: null,
      worktreePath: '/tmp/rfc232-owner-fallbacks-wt',
      baseBranch: 'main',
      baseCommit: null,
      status: 'done' as const,
      inputs: '{}',
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: now,
      finishedAt: now,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
    }
    const { users } = tablesOf(db)
    await insertOne(db, users, {
      id: 'departing-owner',
      username: 'departing',
      displayName: 'Departing',
      createdAt: now,
      updatedAt: now,
    })
    await taskFixture(db, [
      {
        ...baseTask,
        id: 'task-owner-null',
        branch: 'agent-workflow/task-owner-null',
        ownerUserId: null,
      },
      {
        ...baseTask,
        id: 'task-owner-removed',
        branch: 'agent-workflow/task-owner-removed',
        ownerUserId: 'departing-owner',
      },
    ])
    // RFC-395: both engines declare tasks_owner_user_fk (ON DELETE SET NULL, as SQLite's
    // migration 0020 always did), so a dangling owner id cannot be stored, and the converter
    // blocks one from an epoch-1 PostgreSQL source (v2-task-owner-dangling). Removing the
    // user keeps the task and clears its attribution.
    await expect(
      taskFixture(db, [
        {
          ...baseTask,
          id: 'task-owner-dangling',
          branch: 'agent-workflow/task-owner-dangling',
          ownerUserId: 'deleted-owner',
        },
      ]),
    ).rejects.toThrow()
    await db.delete(users).where(eq(users.id, 'departing-owner'))

    const rows = await taskListItemsProjection({ db, owners: composeOwnerIdentityQueries(db) }, {})
    expect(rows.find((row) => row.id === 'task-owner-null')).toMatchObject({
      ownerUserId: null,
      owner: null,
    })
    expect(rows.find((row) => row.id === 'task-owner-removed')).toMatchObject({
      ownerUserId: null,
      owner: null,
    })
    expect(rows.some((row) => row.id === 'task-owner-dangling')).toBe(false)
  })
})
