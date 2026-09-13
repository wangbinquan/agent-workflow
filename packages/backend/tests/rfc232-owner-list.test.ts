// RFC-232 — owner projection batching + scheduled-list mapper parity.

import { expect, test } from 'bun:test'

import { buildActor, SYSTEM_USER_ID } from '../src/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'
import { scheduledTasks, tasks, users, workflows } from '../src/db/schema'
import {
  listScheduledTaskItems,
  listScheduledTasks,
} from './helpers/integrationTriggerResourceBinding'
import { OWNER_IDENTITY_SQL_BATCH_SIZE } from '../src/services/ownerIdentity'
import { listTaskItems } from '../src/services/task'

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
    await db.insert(users).values({
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
  test('keeps null and dangling owner ids stable while degrading identity to null', async () => {
    const db = harness.db
    const now = Date.now()
    await db.insert(workflows).values({
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
    // RFC-359 AC-6：悬空 owner 这条夹具要绕开外键，而**两个引擎的外键不是一回事**。
    // SQLite 的迁移链给 `tasks.owner_user_id` 加了 `REFERENCES users(id)`
    // （`db/migrations/0020_rfc036_task_collab.sql:1`），drizzle 的表声明里没有这条——
    // PostgreSQL 的 schema 由 drizzle 声明生成，所以那边压根不存在这个约束，不用关也不能关
    // （`PRAGMA` 是 SQLite 专属语句，走到 PG 上会被 SQL 编译器直接拒掉）。
    // provider 判别只出现在**夹具**里，被测判据本身两个引擎逐字相同。
    const enforcesOwnerForeignKey = harness.capabilities.provider === 'sqlite'
    if (enforcesOwnerForeignKey) await harness.executeFixtureDdl('PRAGMA foreign_keys = OFF')
    await db.insert(tasks).values([
      {
        ...baseTask,
        id: 'task-owner-null',
        branch: 'agent-workflow/task-owner-null',
        ownerUserId: null,
      },
      {
        ...baseTask,
        id: 'task-owner-missing',
        branch: 'agent-workflow/task-owner-missing',
        ownerUserId: 'deleted-owner',
      },
    ])
    if (enforcesOwnerForeignKey) await harness.executeFixtureDdl('PRAGMA foreign_keys = ON')

    const rows = await listTaskItems(db)
    expect(rows.find((row) => row.id === 'task-owner-null')).toMatchObject({
      ownerUserId: null,
      owner: null,
    })
    expect(rows.find((row) => row.id === 'task-owner-missing')).toMatchObject({
      ownerUserId: 'deleted-owner',
      owner: null,
    })
  })
})
