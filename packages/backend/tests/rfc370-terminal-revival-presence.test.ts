// RFC-370 A3: remote existence is awaited before terminal revival. A response
// for an older workspace/lifecycle must not mark a new workspace as reclaimed.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { committedEvents, tasks, users, workflows } from '@/db/schema'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

const TASK_ID = 'selected-terminal-revival'
async function seed(db: ProviderNeutralDatabase, extra: Partial<typeof tasks.$inferInsert> = {}) {
  await db.insert(workflows).values({ id: 'revival-workflow', name: 'Revival', definition: '{}' })
  await db.insert(tasks).values({
    id: TASK_ID,
    name: 'Selected terminal revival',
    workflowId: 'revival-workflow',
    workflowSnapshot: '{}',
    repoPath: '',
    worktreePath: 'workspace:selected',
    spaceKind: 'scratch',
    baseBranch: 'main',
    branch: 'agent-workflow/revival',
    status: 'failed',
    inputs: '{}',
    startedAt: 100,
    finishedAt: 200,
    lifecycleEventRevision: 7,
    executionLineageId: TASK_ID,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: TASK_ID, workflowRevision: null },
    ]),
    ...extra,
  })
}
const transition = {
  taskId: TASK_ID,
  to: 'pending' as const,
  allowedFrom: ['failed' as const],
  allowTerminal: true,
  now: 300,
  reason: 'selected-terminal-revival',
}

describeEachProvider('RFC-370 provider runtime shares selected terminal presence', (harness) => {
  for (const result of ['present', 'missing', 'failure'] as const) {
    test(`real provider composition awaits ${result} before revival`, async () => {
      await seed(harness.db)
      await harness.db.insert(users).values({
        id: 'revival-author',
        username: 'revival-author',
        displayName: 'Revival Author',
        passwordHash: 'fixture',
        createdAt: 100,
        updatedAt: 100,
      })
      const appHome = mkdtempSync(join(tmpdir(), 'rfc370-provider-revival-'))
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const failure = new Error('selected provider presence failed')
      const presence: WorkspacePresenceQueries = {
        async exists(reference) {
          expect(this).toBe(presence)
          expect(reference).toBe('workspace:selected')
          entered.resolve()
          await release.promise
          if (result === 'failure') throw failure
          return result === 'present'
        },
      }
      const execution = await createEachProviderTaskExecution(
        harness,
        { appHome },
        'revival-author',
        { workspacePresence: presence },
      )
      const before = await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get()
      let settled = false
      const pending = execution.provider.persistence.runtimeLifecycle.trySet(transition).then(
        (value) => {
          settled = true
          return { kind: 'ok' as const, value }
        },
        (error: unknown) => {
          settled = true
          return { kind: 'error' as const, error }
        },
      )
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('provider revival settled before selected presence')
          }),
        ])
        expect(settled).toBe(false)
        expect(await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get()).toEqual(
          before,
        )
        expect(await harness.db.select().from(committedEvents).all()).toEqual([])
        release.resolve()
        const outcome = await pending
        if (result === 'failure') {
          expect(outcome).toEqual({ kind: 'error', error: failure })
          expect(await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get()).toEqual(
            before,
          )
        } else {
          if (result === 'present') expect(outcome).toEqual({ kind: 'ok', value: true })
          else {
            expect(outcome.kind).toBe('error')
            if (outcome.kind === 'error')
              expect(outcome.error).toMatchObject({ code: 'workspace-pruned', status: 410 })
          }
          expect(
            await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get(),
          ).toMatchObject({
            status: result === 'present' ? 'pending' : 'failed',
            lifecycleEventRevision: result === 'present' ? 8 : 7,
            workspacePrunedAt: result === 'present' ? null : 300,
          })
          expect(await harness.db.select().from(committedEvents).all()).toHaveLength(
            result === 'present' ? 1 : 0,
          )
        }
      } finally {
        release.resolve()
        await pending
        await execution.shutdown()
        rmSync(appHome, { recursive: true, force: true })
      }
    })
  }
})

describeEachProvider('RFC-370 terminal revival selected presence', (harness) => {
  for (const mode of ['runtime', 'human-gate'] as const) {
    const resume = async (presence: WorkspacePresenceQueries) => {
      const persistence = createTaskExecutionPersistence(harness.db, {
        workspacePresence: presence,
      })
      if (mode === 'runtime') return await persistence.runtimeLifecycle.trySet(transition)
      const result =
        await persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks(transition)
      if (result.kind !== 'settled') throw new Error('unexpected manual question')
      return result.won
    }
    for (const present of [true, false]) {
      test(`${mode} awaits ${present ? 'present' : 'missing'} before changing persistent lifecycle`, async () => {
        await seed(harness.db)
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        const presence: WorkspacePresenceQueries = {
          async exists(reference) {
            expect(this).toBe(presence)
            expect(reference).toBe('workspace:selected')
            entered.resolve()
            await release.promise
            return present
          },
        }
        const before = await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get()
        let settled = false
        const result = resume(presence).then(
          (value) => {
            settled = true
            return { ok: true as const, value }
          },
          (error: unknown) => {
            settled = true
            return { ok: false as const, error }
          },
        )
        try {
          await entered.promise
          expect(settled).toBe(false)
          expect(await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get()).toEqual(
            before,
          )
          expect(await harness.db.select().from(committedEvents).all()).toEqual([])
        } finally {
          release.resolve()
        }
        const actual = await result
        if (present) {
          expect(actual).toEqual({ ok: true, value: true })
          expect(
            await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get(),
          ).toMatchObject({ status: 'pending', lifecycleEventRevision: 8, workspacePrunedAt: null })
          expect(await harness.db.select().from(committedEvents).all()).toHaveLength(1)
        } else {
          expect(actual.ok).toBe(false)
          if (actual.ok) throw new Error('expected missing workspace')
          expect(actual.error).toMatchObject({ code: 'workspace-pruned', status: 410 })
          expect(
            await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get(),
          ).toMatchObject({ status: 'failed', lifecycleEventRevision: 7, workspacePrunedAt: 300 })
          expect(await harness.db.select().from(committedEvents).all()).toEqual([])
        }
      })
    }
    for (const present of [true, false]) {
      for (const [label, patch] of [
        ['path', { worktreePath: 'workspace:new' }],
        ['revision', { lifecycleEventRevision: 8 }],
        ['pruning', { workspacePruningAt: 250 }],
        ['deleted', { deletedAt: 250 }],
        ['source-closed', { sourceTerminationFence: 'closed' }],
        ['source-merged', { sourceTerminationFence: 'merged' }],
      ] as const) {
        test(`${mode} ignores stale ${present ? 'present' : 'missing'} after ${label} changes`, async () => {
          await seed(harness.db)
          const entered = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const presence: WorkspacePresenceQueries = {
            async exists() {
              entered.resolve()
              await release.promise
              return present
            },
          }
          const pending = resume(presence)
          try {
            await entered.promise
            await harness.db.update(tasks).set(patch).where(eq(tasks.id, TASK_ID))
          } finally {
            release.resolve()
          }
          expect(await pending).toBe(false)
          expect(
            await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get(),
          ).toMatchObject({ status: 'failed', workspacePrunedAt: null, ...patch })
          expect(await harness.db.select().from(committedEvents).all()).toEqual([])
        })
      }
    }
    test(`${mode} propagates selected failure without writes or a local fallback`, async () => {
      await seed(harness.db)
      const before = await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get()
      const failure = new Error('selected workspace query unavailable')
      await expect(
        resume({
          exists: async () => {
            throw failure
          },
        }),
      ).rejects.toBe(failure)
      expect(await harness.db.select().from(tasks).where(eq(tasks.id, TASK_ID)).get()).toEqual(
        before,
      )
      expect(await harness.db.select().from(committedEvents).all()).toEqual([])
    })
    test(`${mode} preserves empty refs and refuses existing source/prune states before IO`, async () => {
      await seed(harness.db, { worktreePath: '' })
      const presence: WorkspacePresenceQueries = {
        exists() {
          throw new Error('must not query')
        },
      }
      expect(await resume(presence)).toBe(true)
      await harness.db
        .update(tasks)
        .set({
          status: 'failed',
          worktreePath: 'workspace:selected',
          sourceTerminationFence: 'closed',
        })
        .where(eq(tasks.id, TASK_ID))
      expect(await resume(presence)).toBe(false)
      await harness.db
        .update(tasks)
        .set({ sourceTerminationFence: null, workspacePruningAt: 250 })
        .where(eq(tasks.id, TASK_ID))
      expect(await resume(presence)).toBe(false)
      await harness.db
        .update(tasks)
        .set({ workspacePruningAt: null, workspacePrunedAt: 250 })
        .where(eq(tasks.id, TASK_ID))
      await expect(resume(presence)).rejects.toMatchObject({
        code: 'workspace-pruned',
        status: 410,
      })
    })
  }
})
