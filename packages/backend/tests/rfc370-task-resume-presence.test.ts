// RFC-370: ordinary routes use the selected SC presence facts before admission.
// These real-provider cases stop at the existing source fence after a positive
// receipt; they do not claim to execute the TaskEngine or a remote workspace.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { and, eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'
import {
  nodeRuns,
  taskExecutionIntents,
  taskExecutionOwners,
  taskRepos,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

const ulid = monotonicFactory()
function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}
async function seed(db: ProviderNeutralDatabase, repositories = 1) {
  const taskId = ulid(),
    workflowId = ulid(),
    userId = ulid()
  const workspace = `workspace://${taskId}`
  await db.insert(users).values({
    id: userId,
    username: userId,
    displayName: userId,
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
  const definition = JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] })
  await db.insert(workflows).values({ id: workflowId, name: 'resume presence', definition })
  await db.insert(tasks).values({
    id: taskId,
    name: 'resume presence',
    workflowId,
    workflowSnapshot: definition,
    ownerUserId: userId,
    executionLineageId: taskId,
    repoPath: workspace,
    worktreePath: workspace,
    branch: `agent-workflow/${taskId}`,
    baseBranch: 'main',
    status: 'failed',
    inputs: '{}',
    startedAt: 1,
    finishedAt: 2,
    repoCount: repositories,
    sourceTerminationFence: 'closed',
  })
  const refs = Array.from({ length: repositories }, (_, i) => `${workspace}/repo-${i}`)
  if (repositories > 1) {
    await db.insert(taskRepos).values(
      refs.map((ref, repoIndex) => ({
        taskId,
        repoIndex,
        repoPath: ref,
        worktreePath: ref,
        worktreeDirName: `repo-${repoIndex}`,
        branch: `agent-workflow/${taskId}`,
      })),
    )
  }
  return { taskId, userId, workspace, refs }
}
async function assertUnadmitted(db: ProviderNeutralDatabase, taskId: string) {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  expect(row?.status).toBe('failed')
  expect(row?.lifecycleEventRevision).toBe(1)
  expect(
    await db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId)),
  ).toEqual([])
  expect(
    await db.select().from(taskExecutionIntents).where(eq(taskExecutionIntents.taskId, taskId)),
  ).toEqual([])
}

describeEachProvider('RFC-370 ordinary task resume selected workspace presence', (harness) => {
  for (const result of ['present', 'missing', 'unavailable'] as const) {
    test(`real provider route waits for ${result} before durable admission`, async () => {
      const fixture = await seed(harness.db),
        entered = barrier(),
        release = barrier()
      const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc370-resume-presence-'))
      const unavailable = new Error('selected presence unavailable')
      const selected = {
        expected: fixture.workspace,
        async exists(reference: string) {
          expect(reference).toBe(this.expected)
          entered.release()
          await release.pending
          if (result === 'unavailable') throw unavailable
          return result === 'present'
        },
      }
      const execution = await createEachProviderTaskExecution(
        harness,
        { appHome },
        fixture.userId,
        { workspacePresence: selected },
      )
      let settled = false
      const outcome = execution.provider.routes.tasks
        .resume({ actor: execution.actor, taskId: fixture.taskId })
        .then(
          () => {
            settled = true
            return undefined
          },
          (error: unknown) => {
            settled = true
            return error
          },
        )
      try {
        await entered.pending
        expect(settled).toBe(false)
        await assertUnadmitted(harness.db, fixture.taskId)
        release.release()
        const error = await outcome
        if (result === 'unavailable') expect(error).toBe(unavailable)
        else
          expect(error).toMatchObject({
            code: result === 'present' ? 'task-source-terminal-closed' : 'task-worktree-missing',
            status: result === 'present' ? 409 : 410,
          })
        await assertUnadmitted(harness.db, fixture.taskId)
      } finally {
        release.release()
        await outcome
        await execution.shutdown()
        rmSync(appHome, { recursive: true, force: true })
      }
    })
  }

  for (const present of [true, false]) {
    test(`multiple repositories await ordered facts and ${present ? 'short circuit' : 'reject all missing'}`, async () => {
      const fixture = await seed(harness.db, 3),
        entered = barrier(),
        release = barrier()
      const calls: string[] = []
      const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc370-resume-multi-'))
      const execution = await createEachProviderTaskExecution(
        harness,
        { appHome },
        fixture.userId,
        {
          workspacePresence: {
            async exists(reference) {
              calls.push(reference)
              if (reference === fixture.workspace) return true
              if (reference === fixture.refs[0]) {
                entered.release()
                await release.pending
                return false
              }
              return present && reference === fixture.refs[1]
            },
          },
        },
      )
      const outcome = execution.provider.routes.tasks
        .resume({ actor: execution.actor, taskId: fixture.taskId })
        .then(
          () => undefined,
          (error: unknown) => error,
        )
      try {
        await entered.pending
        expect(calls).toEqual([fixture.workspace, fixture.refs[0]!])
        await assertUnadmitted(harness.db, fixture.taskId)
        release.release()
        expect(await outcome).toMatchObject({
          code: present ? 'task-source-terminal-closed' : 'task-worktree-missing',
          status: present ? 409 : 410,
        })
        expect(calls).toEqual([fixture.workspace, ...fixture.refs.slice(0, present ? 2 : 3)])
        await assertUnadmitted(harness.db, fixture.taskId)
      } finally {
        release.release()
        await outcome
        await execution.shutdown()
        rmSync(appHome, { recursive: true, force: true })
      }
    })
  }

  for (const phase of ['preparing', 'pruning', 'pruned'] as const) {
    test(`${phase} retains its earlier decision without an existence call`, async () => {
      const fixture = await seed(harness.db)
      await harness.db
        .update(tasks)
        .set({
          ...(phase === 'preparing' ? { worktreePath: '' } : {}),
          ...(phase === 'pruning' ? { workspacePruningAt: 3 } : {}),
          ...(phase === 'pruned' ? { workspacePrunedAt: 3 } : {}),
        })
        .where(eq(tasks.id, fixture.taskId))
      if (phase === 'preparing')
        await harness.db.insert(nodeRuns).values({
          id: ulid(),
          taskId: fixture.taskId,
          nodeId: '__repo_prep__',
          status: 'failed',
          startedAt: 1,
        })
      const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc370-resume-phase-'))
      const execution = await createEachProviderTaskExecution(
        harness,
        { appHome },
        fixture.userId,
        {
          workspacePresence: {
            exists() {
              throw new Error('earlier workspace decision must not probe')
            },
          },
        },
      )
      try {
        await expect(
          execution.provider.routes.tasks.resume({
            actor: execution.actor,
            taskId: fixture.taskId,
          }),
        ).rejects.toMatchObject({
          code:
            phase === 'preparing'
              ? 'task-repo-prep-incomplete'
              : phase === 'pruning'
                ? 'workspace-pruning'
                : 'task-worktree-missing',
          status: phase === 'pruned' ? 410 : 409,
        })
        await assertUnadmitted(harness.db, fixture.taskId)
        expect(
          await harness.db
            .select()
            .from(tasks)
            .where(and(eq(tasks.id, fixture.taskId), eq(tasks.status, 'failed'))),
        ).toHaveLength(1)
      } finally {
        await execution.shutdown()
        rmSync(appHome, { recursive: true, force: true })
      }
    })
  }
})
