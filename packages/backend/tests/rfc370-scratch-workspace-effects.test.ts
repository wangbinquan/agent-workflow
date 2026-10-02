// Scratch launch and replay must use one selected effect adapter. The real
// Task journal advances only after its preparation/restoration/cleanup ACK.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import type { ScratchWorkspaceEffects } from '@/modules/source-control/application/ports/scratchWorkspaceEffects'
import type { MaterializedSpace } from '@/modules/source-control/application/workspaceMaterialization'
import {
  compensateScratchWorkspace,
  prepareScratchWorkspace,
} from '@/modules/task-execution/infrastructure/scratchWorkspacePreparation'
import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
import { materializingSpaces } from '@/services/gc'
import { describeEachProvider } from './helpers/eachProvider'

function space(taskId: string): MaterializedSpace {
  return {
    kind: 'scratch',
    spaceKind: 'scratch',
    taskId,
    worktreePath: `workspace:selected:${taskId}`,
    branch: 'main',
    baseCommit: 'selected-root',
    earlyError: null,
    resolvedSources: [],
    repos: [],
    nodePaths: [],
    cleanup: {
      taskId,
      ownedRoot: `workspace:selected:${taskId}`,
      worktrees: [],
      state: 'owned',
      report: null,
    },
  }
}

describeEachProvider('RFC-370 selected scratch workspace effects', (harness) => {
  for (const receiver of ['object', 'prototype'] as const) {
    test(`${receiver} preparation and restoration ACK precede the original journal transitions`, async () => {
      const taskId = ulid()
      const value = space(taskId)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const restoreEntered = Promise.withResolvers<void>()
      const restoreRelease = Promise.withResolvers<void>()
      const signal = new AbortController().signal
      const journal = createWorkspacePreparationJournal(harness.db)
      const calls = { prepare: 0, restore: 0, cleanup: 0 }
      const methods: ScratchWorkspaceEffects = {
        async prepare(request) {
          expect(this).toBe(selected)
          expect(request.taskId).toBe(taskId)
          expect(request.gitCommitIdentity).toBeNull()
          expect(request.signal).toBe(signal)
          await request.assertCurrent()
          calls.prepare += 1
          entered.resolve()
          await release.promise
          return value
        },
        async restore(id, saved) {
          expect(this).toBe(selected)
          expect(id).toBe(taskId)
          expect(saved).toEqual(value)
          calls.restore += 1
          restoreEntered.resolve()
          await restoreRelease.promise
          return saved
        },
        async cleanup(request) {
          calls.cleanup += 1
          return { taskId: request.taskId, complete: true, failures: [] }
        },
      }
      const selected: ScratchWorkspaceEffects =
        receiver === 'prototype' ? Object.create(methods) : methods
      const binding = composeRepositoryPreparation({
        db: harness.db,
        appHome: 'installation:selected',
        scratchEffects: selected,
      })
      const input = {
        db: harness.db,
        binding,
        appHome: 'installation:selected',
        taskId,
        gitCommitIdentity: null,
        signal,
      }
      let prepared = false
      const pending = prepareScratchWorkspace(input).then((result) => {
        prepared = true
        return result
      })
      try {
        await entered.promise
        expect(prepared).toBe(false)
        expect((await journal.read(taskId))?.state).toBe('preparing')
        expect((await journal.read(taskId))?.artifactJson).toBeNull()
        release.resolve()
        const first = await pending
        expect(first.space).toBe(value)
        const saved = await journal.read(taskId)
        expect(saved?.state).toBe('prepared')
        expect(JSON.parse(saved!.artifactJson!)).toEqual({ version: 1, space: value })
        first.commit()
        let restored = false
        const replay = prepareScratchWorkspace(input).then((result) => {
          restored = true
          return result
        })
        try {
          await restoreEntered.promise
          expect(restored).toBe(false)
          expect(await journal.read(taskId)).toEqual(saved)
          restoreRelease.resolve()
          const next = await replay
          expect(next.space).toEqual(value)
          expect(await journal.read(taskId)).toEqual(saved)
          next.commit()
          expect(calls).toEqual({ prepare: 1, restore: 1, cleanup: 0 })
        } finally {
          restoreRelease.resolve()
          await replay
        }
      } finally {
        release.resolve()
        restoreRelease.resolve()
        await pending
        materializingSpaces.delete(taskId)
      }
    })
  }

  test('cleanup ACK retains the same compensation claim and incomplete cleanup is retried', async () => {
    const taskId = ulid()
    const journal = createWorkspacePreparationJournal(harness.db)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let cleanups = 0
    const selected: ScratchWorkspaceEffects = {
      async prepare() {
        return space(taskId)
      },
      restore(_taskId, saved) {
        return saved
      },
      async cleanup(request) {
        expect(this).toBe(selected)
        await request.assertCurrent()
        cleanups += 1
        if (cleanups === 1) {
          entered.resolve()
          await release.promise
        }
        return { taskId: request.taskId, complete: cleanups > 1, failures: [] }
      },
    }
    const binding = composeRepositoryPreparation({
      db: harness.db,
      appHome: 'installation:selected',
      scratchEffects: selected,
    })
    const prepared = await prepareScratchWorkspace({
      db: harness.db,
      binding,
      appHome: 'installation:selected',
      taskId,
      gitCommitIdentity: null,
      signal: new AbortController().signal,
    })
    prepared.commit()
    const cleanupInput = { db: harness.db, binding, taskId }
    let settled = false
    const pending = compensateScratchWorkspace(cleanupInput).then((result) => {
      settled = true
      return result
    })
    try {
      await entered.promise
      expect(settled).toBe(false)
      expect((await journal.read(taskId))?.state).toBe('compensating')
      release.resolve()
      expect((await pending).complete).toBe(false)
      expect((await journal.read(taskId))?.state).toBe('compensating')
      expect((await compensateScratchWorkspace(cleanupInput)).complete).toBe(true)
      expect((await journal.read(taskId))?.state).toBe('cleaned')
      expect((await compensateScratchWorkspace(cleanupInput)).complete).toBe(true)
      expect(cleanups).toBe(2)
    } finally {
      release.resolve()
      await pending
      materializingSpaces.delete(taskId)
    }
  })

  test('selected preparation failure keeps the original error and compensates without a file fallback', async () => {
    const taskId = ulid()
    const failure = new Error('selected-prepare-failed')
    let cleanups = 0
    const binding = composeRepositoryPreparation({
      db: harness.db,
      appHome: 'installation:selected',
      scratchEffects: {
        async prepare() {
          throw failure
        },
        restore() {
          throw new Error('must not restore a failed preparation')
        },
        async cleanup(input) {
          cleanups += 1
          await input.assertCurrent()
          return { taskId: input.taskId, complete: true, failures: [] }
        },
      },
    })
    await expect(
      prepareScratchWorkspace({
        db: harness.db,
        binding,
        appHome: 'installation:selected',
        taskId,
        gitCommitIdentity: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(failure)
    expect(cleanups).toBe(1)
    expect((await createWorkspacePreparationJournal(harness.db).read(taskId))?.state).toBe(
      'cleaned',
    )
    expect(materializingSpaces.has(taskId)).toBe(false)
  })

  test('selected restoration rejection reaches the caller and uses the original compensation', async () => {
    const taskId = ulid()
    const failure = new Error('selected-restore-failed')
    let cleanups = 0
    const binding = composeRepositoryPreparation({
      db: harness.db,
      appHome: 'installation:selected',
      scratchEffects: {
        async prepare() {
          return space(taskId)
        },
        async restore() {
          throw failure
        },
        async cleanup(input) {
          cleanups += 1
          return { taskId: input.taskId, complete: true, failures: [] }
        },
      },
    })
    const input = {
      db: harness.db,
      binding,
      appHome: 'installation:selected',
      taskId,
      gitCommitIdentity: null,
      signal: new AbortController().signal,
    }
    ;(await prepareScratchWorkspace(input)).commit()
    await expect(prepareScratchWorkspace(input)).rejects.toBe(failure)
    expect(cleanups).toBe(1)
    expect((await createWorkspacePreparationJournal(harness.db).read(taskId))?.state).toBe(
      'cleaned',
    )
    expect(materializingSpaces.has(taskId)).toBe(false)
  })

  test('the owner validates version, Task and kind before a selected restoration', async () => {
    const taskId = ulid()
    let restorations = 0
    const binding = composeRepositoryPreparation({
      db: harness.db,
      appHome: 'installation:selected',
      scratchEffects: {
        async prepare() {
          return space(taskId)
        },
        restore(_taskId, saved) {
          restorations += 1
          return saved
        },
        async cleanup(input) {
          return { taskId: input.taskId, complete: true, failures: [] }
        },
      },
    })
    for (const artifact of [
      { version: 2, space: space(taskId) },
      { version: 1, space: space('another-task') },
      { version: 1, space: { ...space(taskId), kind: 'single' } },
    ]) {
      expect(() => binding.restoreScratch(taskId, JSON.stringify(artifact))).toThrow(
        'scratch-preparation-artifact-mismatch',
      )
    }
    expect(restorations).toBe(0)
  })
})
