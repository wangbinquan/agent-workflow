// RFC-036 PR4 launch-context test, rewritten for RFC-099 (D6/D10/D13):
// the node-level assignment mechanism is gone — task membership (owner +
// collaborators) is the answer-rights boundary. This file now locks:
//   - recordLaunchContext: owner + collaborator rows, disabled-user 422
//   - requireTaskMember: the member gate + role snapshot precedence
//   - updateTaskMembers: owner/admin-only writes, full-replace semantics,
//     owner transfer keeps the previous owner as collaborator

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { taskCollaborators, tasks, users, workflows } from '../src/db/schema'
import { createUser } from '../src/services/users'
import {
  getTaskMembers,
  recordLaunchContext,
  requireTaskMember,
  updateTaskMembers,
} from '../src/services/taskCollab'
import { ForbiddenError } from '../src/util/errors'
import {
  TASKS_LIST_CHANNEL,
  tasksListBroadcaster,
  type TasksListBroadcastContext,
} from '../src/ws/broadcaster'
import { registerRevalidationTrigger } from '../src/ws/revalidationHook'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorFor(id: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

describe('taskCollab — RFC-099 membership model', () => {
  let db: DbClient
  let bob = ''
  let carol = ''
  let dave = ''
  let admin = ''

  async function seedTask(id: string, ownerId: string) {
    const wfId = `wf-${id}`
    await db.insert(workflows).values({
      id: wfId,
      name: `wf-${id}`,
      description: '',
      definition: '{}',
    })
    await db.insert(tasks).values({
      name: 'fixture-task',
      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      repoUrl: null,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: null,
      status: 'done',
      inputs: '{}',
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: 0,
      finishedAt: 0,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
      ownerUserId: ownerId,
    })
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    bob = (
      await createUser(db, {
        username: 'bob',
        displayName: 'Bob',
        role: 'user',
        password: 'pw12345678',
      })
    ).id
    carol = (
      await createUser(db, {
        username: 'carol',
        displayName: 'Carol',
        role: 'user',
        password: 'pw12345678',
      })
    ).id
    dave = (
      await createUser(db, {
        username: 'dave',
        displayName: 'Dave',
        role: 'user',
        password: 'pw12345678',
      })
    ).id
    admin = (
      await createUser(db, {
        username: 'root',
        displayName: 'Root',
        role: 'admin',
        password: 'pw12345678',
      })
    ).id
  })

  test('recordLaunchContext writes owner + collaborator rows (no assignment legs)', async () => {
    await seedTask('task-1', bob)
    await recordLaunchContext(db, {
      taskId: 'task-1',
      ownerUserId: bob,
      collaboratorUserIds: [dave, bob], // owner in the list is deduped
      now: 1_000,
    })
    const collabs = await db
      .select()
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, 'task-1'))
    expect(collabs.length).toBe(2)
    expect(collabs.find((r) => r.userId === bob)?.role).toBe('owner')
    expect(collabs.find((r) => r.userId === dave)?.role).toBe('collaborator')
  })

  test('recordLaunchContext rejects disabled users', async () => {
    await seedTask('task-2', bob)
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, carol))
    await expect(
      recordLaunchContext(db, {
        taskId: 'task-2',
        ownerUserId: bob,
        collaboratorUserIds: [carol],
        now: 1_000,
      }),
    ).rejects.toThrow(/not active/)
  })

  test('requireTaskMember: owner→owner, collaborator→user, non-member admin→admin, stranger→403', async () => {
    await seedTask('task-3', bob)
    await recordLaunchContext(db, {
      taskId: 'task-3',
      ownerUserId: bob,
      collaboratorUserIds: [carol],
      now: 1_000,
    })
    const task = { id: 'task-3', ownerUserId: bob }
    expect(await requireTaskMember(db, actorFor(bob, 'user'), task)).toBe('owner')
    expect(await requireTaskMember(db, actorFor(carol, 'user'), task)).toBe('user')
    expect(await requireTaskMember(db, actorFor(admin, 'admin'), task)).toBe('admin')
    const daveBase = actorFor(dave, 'user')
    const daveUsersWriter: Actor = {
      ...daveBase,
      permissions: new Set([...daveBase.permissions, 'users:write']),
    }
    await expect(requireTaskMember(db, daveUsersWriter, task)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
    await expect(requireTaskMember(db, actorFor(dave, 'user'), task)).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  test('updateTaskMembers: full replace + owner transfer keeps previous owner as collaborator', async () => {
    await seedTask('task-4', bob)
    await recordLaunchContext(db, {
      taskId: 'task-4',
      ownerUserId: bob,
      collaboratorUserIds: [carol],
      now: 1_000,
    })
    const task = { id: 'task-4', ownerUserId: bob }
    // carol (plain member) cannot manage members
    await expect(
      updateTaskMembers(db, actorFor(carol, 'user'), task, { userIds: [dave] }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    // owner transfers to carol; bob auto-kept as collaborator
    const after = await updateTaskMembers(db, actorFor(bob, 'user'), task, {
      ownerUserId: carol,
      userIds: [dave],
    })
    expect(after.ownerUserId).toBe(carol)
    expect(after.users.map((u) => u.id).sort()).toEqual([bob, dave].sort())
    const taskRow = (await db.select().from(tasks).where(eq(tasks.id, 'task-4')))[0]!
    expect(taskRow.ownerUserId).toBe(carol)
    // membership flipped: bob is now role 'user'
    expect(
      await requireTaskMember(db, actorFor(bob, 'user'), { id: 'task-4', ownerUserId: carol }),
    ).toBe('user')
  })

  test('updateTaskMembers: admin can manage; getTaskMembers reports canManage correctly', async () => {
    await seedTask('task-5', bob)
    await recordLaunchContext(db, {
      taskId: 'task-5',
      ownerUserId: bob,
      collaboratorUserIds: [carol],
      now: 1_000,
    })
    const task = { id: 'task-5', ownerUserId: bob }
    const adminView = await getTaskMembers(db, actorFor(admin, 'admin'), task)
    expect(adminView.canManage).toBe(true)
    const carolView = await getTaskMembers(db, actorFor(carol, 'user'), task)
    expect(carolView.canManage).toBe(false)
    expect(carolView.users.map((u) => u.id)).toEqual([carol])
    const updated = await updateTaskMembers(db, actorFor(admin, 'admin'), task, {
      userIds: [carol, dave],
    })
    expect(updated.users.map((u) => u.id).sort()).toEqual([carol, dave].sort())
  })

  test('member notification waits for revalidation and carries the before/after audience union', async () => {
    await seedTask('task-audience', bob)
    await recordLaunchContext(db, {
      taskId: 'task-audience',
      ownerUserId: bob,
      collaboratorUserIds: [carol],
      now: 1_000,
    })
    let releaseRevalidation!: () => void
    const revalidation = new Promise<void>((resolve) => {
      releaseRevalidation = resolve
    })
    let markRevalidationStarted!: () => void
    const revalidationStarted = new Promise<void>((resolve) => {
      markRevalidationStarted = resolve
    })
    const order: string[] = []
    registerRevalidationTrigger(async () => {
      order.push('revalidation-start')
      markRevalidationStarted()
      await revalidation
      order.push('revalidation-finished')
    })
    let context: TasksListBroadcastContext | undefined
    const unsubscribe = tasksListBroadcaster.subscribe(
      TASKS_LIST_CHANNEL,
      (message, nextContext) => {
        if (message.type !== 'task.members.changed') return
        order.push('broadcast')
        context = nextContext
      },
    )
    try {
      const update = updateTaskMembers(
        db,
        actorFor(bob, 'user'),
        { id: 'task-audience', ownerUserId: bob },
        { ownerUserId: dave, userIds: [] },
      )
      await revalidationStarted
      expect(order).toEqual(['revalidation-start'])

      releaseRevalidation()
      await update

      expect(order).toEqual(['revalidation-start', 'revalidation-finished', 'broadcast'])
      expect(context?.kind).toBe('task.members-changed-audience')
      if (context?.kind === 'task.members-changed-audience') {
        expect([...context.visibleUserIds].sort()).toEqual([bob, carol, dave].sort())
      }
    } finally {
      unsubscribe()
      registerRevalidationTrigger(async () => {})
    }
  })

  test('updateTaskMembers rejects disabled / system users', async () => {
    await seedTask('task-6', bob)
    await recordLaunchContext(db, {
      taskId: 'task-6',
      ownerUserId: bob,
      collaboratorUserIds: [],
      now: 1_000,
    })
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, dave))
    const task = { id: 'task-6', ownerUserId: bob }
    await expect(
      updateTaskMembers(db, actorFor(bob, 'user'), task, { userIds: [dave] }),
    ).rejects.toThrow(/not active/)
    await expect(
      updateTaskMembers(db, actorFor(bob, 'user'), task, { userIds: ['__system__'] }),
    ).rejects.toThrow(/not active/)
  })
})
