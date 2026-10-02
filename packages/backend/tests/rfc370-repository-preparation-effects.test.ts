import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { decodeRepositoryLaunchRef } from '@/modules/source-control/domain/repositoryLaunchRef'
import { repositoryPreparationFactsJson } from '@/modules/source-control/domain/repositoryPreparationFacts'
import { createRepositoryPreparationJournal } from '@/modules/source-control/infrastructure/repositoryPreparationJournal'
import type { MaterializedSpace } from '@/modules/source-control/infrastructure/workspaceMaterializer'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/application/ports/repositoryPreparationEffects'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-370 selected repository preparation effects', (harness) => {
  async function fixture() {
    const journal = createRepositoryPreparationJournal(harness.db)
    const factsJson = repositoryPreparationFactsJson({
      version: 1,
      kind: 'repository',
      repositories: [],
      groups: [],
      groupName: null,
      layout: { repos: [], nodes: [] },
    })
    const source = await journal.seal({
      id: `sc:source:v1:${ulid()}`,
      requestKey: ulid(),
      requestDigest: 'selected',
      kind: 'repository',
      factsJson,
      createdAt: 1,
    })
    const frozen = decodeRepositoryLaunchRef('preparation', `sc:preparation:v1:${ulid()}`)
    await journal.freeze({
      id: frozen,
      sourceRef: source.id,
      revision: `sha256:${sha256Hex(factsJson)}`,
      factsJson,
      createdAt: 1,
    })
    const operation = decodeRepositoryLaunchRef('operation', `sc:operation:v1:${ulid()}`)
    await journal.plan({ id: operation, snapshotRef: frozen, now: 1 })
    const signal = new AbortController().signal
    const request = {
      taskId: 'selected-workspace',
      operationRef: operation,
      workingBranch: 'selected-branch',
      gitCommitIdentity: null,
      signal,
      assertCurrent: async () => {},
    }
    return { journal, frozen, operation, request }
  }

  for (const mode of ['object', 'prototype'] as const) {
    test(`awaits the selected ${mode} factory and preserves prepare, replay and compensation`, async () => {
      const f = await fixture()
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const space: MaterializedSpace = {
        kind: 'single',
        spaceKind: 'remote',
        taskId: f.request.taskId,
        worktreePath: 'workspace:selected',
        branch: 'selected-branch',
        baseCommit: 'frozen-commit',
        earlyError: null,
        resolvedSources: [],
        repos: [],
        nodePaths: [],
        cleanup: {
          taskId: f.request.taskId,
          ownedRoot: 'workspace:selected',
          worktrees: [],
          state: 'owned',
          report: null,
        },
      }
      const calls = { factory: 0, resolve: 0, materialize: 0, cleanup: 0 }
      const effectMethods: Awaited<ReturnType<RepositoryPreparationEffectFactory['create']>> = {
        assertCurrent: f.request.assertCurrent,
        async resolveCommits() {
          expect(this).toBe(effects)
          calls.resolve++
          return { kind: 'resolved', planJson: '{"selected":"frozen"}' }
        },
        async materialize(input) {
          expect(this).toBe(effects)
          expect(input.planJson).toBe('{"selected":"frozen"}')
          expect((await f.journal.operation(f.operation))?.resolvedJson).toBe(input.planJson)
          await input.checkpoint('{"selected":"checkpoint"}')
          calls.materialize++
          return { kind: 'prepared', receiptJson: JSON.stringify({ version: 1, space }) }
        },
        async cleanup(input) {
          expect(this).toBe(effects)
          expect(input.planJson).toBe('{"selected":"frozen"}')
          calls.cleanup++
          const report = { taskId: f.request.taskId, complete: calls.cleanup > 1, failures: [] }
          return { complete: report.complete, receiptJson: JSON.stringify({ report }) }
        },
      }
      const effects: Awaited<ReturnType<RepositoryPreparationEffectFactory['create']>> =
        mode === 'prototype' ? Object.create(effectMethods) : effectMethods
      const factory: RepositoryPreparationEffectFactory = {
        async create(input) {
          expect(this).toBe(factory)
          expect(input).toEqual(f.request)
          calls.factory++
          entered.resolve()
          await release.promise
          return effects
        },
      }
      const composition = composeRepositoryPreparation({
        db: harness.db,
        appHome: 'installation:selected',
        preparationEffects: factory,
      })
      const before = await f.journal.operation(f.operation)
      let settled = false
      const pending = composition.effect(f.request).then((binding) => {
        settled = true
        return binding
      })
      try {
        await entered.promise
        expect(settled).toBe(false)
        expect(await f.journal.operation(f.operation)).toEqual(before)
        expect(calls).toEqual({ factory: 1, resolve: 0, materialize: 0, cleanup: 0 })
      } finally {
        release.resolve()
      }
      const binding = await pending
      expect(
        (await binding.participant.prepare(binding.capability, binding.operation, binding.source))
          .kind,
      ).toBe('prepared')
      expect(await binding.space()).toEqual(space)
      binding.close()
      const replay = await composition.effect(f.request)
      expect(
        (await replay.participant.prepare(replay.capability, replay.operation, replay.source)).kind,
      ).toBe('prepared')
      expect(await replay.space()).toEqual(space)
      expect(calls).toEqual({ factory: 2, resolve: 1, materialize: 1, cleanup: 0 })
      expect((await replay.cleanup()).complete).toBe(false)
      expect((await f.journal.operation(f.operation))?.state).toBe('prepared')
      expect((await replay.cleanup()).complete).toBe(true)
      expect((await f.journal.operation(f.operation))?.state).toBe('cleaned')
      expect((await replay.cleanup()).complete).toBe(true)
      expect(calls.cleanup).toBe(2)
      replay.close()
    })
  }

  test('selected factory failure propagates without starting or changing preparation', async () => {
    const f = await fixture()
    const before = await f.journal.operation(f.operation)
    const failure = new Error('selected workspace mechanism unavailable')
    const composition = composeRepositoryPreparation({
      db: harness.db,
      appHome: 'installation:selected',
      preparationEffects: {
        async create() {
          throw failure
        },
      },
    })
    await expect(composition.effect(f.request)).rejects.toBe(failure)
    expect(await f.journal.operation(f.operation)).toEqual(before)
  })
})
