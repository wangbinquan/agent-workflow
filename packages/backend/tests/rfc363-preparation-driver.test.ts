// RFC-363: real database operation replay and record-before-effect ordering.
// Injected effects isolate failure windows; real Git is covered separately.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { sha256Hex } from '@/util/hash'
import { composeRepositoryPreparationParticipant } from '@/modules/source-control/infrastructure/repositoryPreparationParticipant'
import { cleanupRepositoryWorkspace } from '@/modules/source-control/application/repositoryPreparationCleanup'
import { prepareRepositoryWorkspace } from '@/modules/source-control/application/repositoryPreparation'
import type { RepositoryPreparationEffects } from '@/modules/source-control/application/ports/repositoryPreparationEffects'
import { createRepositoryPreparationJournal } from '@/modules/source-control/infrastructure/repositoryPreparationJournal'
import { decodeRepositoryLaunchRef } from '@/modules/source-control/domain/repositoryLaunchRef'
import { repositoryPreparationFactsJson } from '@/modules/source-control/domain/repositoryPreparationFacts'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-363 preparation driver durability', (harness) => {
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
      requestDigest: 'request',
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
    return { journal, source: frozen, operation, now: () => 2 }
  }
  test('interruption after a physical checkpoint replays frozen commits without resolving again', async () => {
    const f = await fixture()
    let resolves = 0
    let materializations = 0
    const effects: RepositoryPreparationEffects = {
      assertCurrent: async () => {},
      resolveCommits: async () => {
        resolves++
        return { kind: 'resolved', planJson: '{"commit":"old"}' }
      },
      async materialize(input) {
        materializations++
        // The first physical effect only starts after commits are durable.
        expect((await f.journal.operation(f.operation))?.resolvedJson).toBe('{"commit":"old"}')
        await input.checkpoint('{"beforeWorktreeAdd":"owned-provenance"}')
        throw new Error('process-interruption')
      },
    }
    await expect(prepareRepositoryWorkspace({ ...f, effects })).rejects.toThrow(
      'process-interruption',
    )
    expect((await f.journal.operation(f.operation))?.state).toBe('materializing')
    const recreated = createRepositoryPreparationJournal(harness.db)
    const resumed: RepositoryPreparationEffects = {
      ...effects,
      async materialize(input) {
        materializations++
        expect(input.planJson).toBe('{"commit":"old"}')
        expect(input.evidenceJson).toBe('{"beforeWorktreeAdd":"owned-provenance"}')
        return { kind: 'prepared', receiptJson: '{"workspace":"same-operation"}' }
      },
    }
    const receipt = await prepareRepositoryWorkspace({ ...f, journal: recreated, effects: resumed })
    expect(receipt.kind).toBe('prepared')
    expect(
      await prepareRepositoryWorkspace({ ...f, journal: recreated, effects: resumed }),
    ).toEqual(receipt)
    expect(resolves).toBe(1)
    expect(materializations).toBe(2)
    expect((await recreated.operation(f.operation))?.receiptJson).toBe(
      '{"workspace":"same-operation"}',
    )
  })

  test('a stale physical checkpoint cannot overwrite progress or the first commit set', async () => {
    const f = await fixture()
    expect(
      await f.journal.checkpoint({
        id: f.operation,
        expectedVersion: 0,
        now: 2,
        evidenceJson: 'too-early',
      }),
    ).toBeNull()
    await f.journal.advance({
      id: f.operation,
      expectedVersion: 0,
      from: 'planned',
      to: 'resolving',
      now: 2,
    })
    await f.journal.advance({
      id: f.operation,
      expectedVersion: 1,
      from: 'resolving',
      to: 'materializing',
      resolvedJson: 'first-commits',
      now: 2,
    })
    const attempts = await Promise.all(
      ['one', 'two'].map((evidenceJson) =>
        f.journal.checkpoint({ id: f.operation, expectedVersion: 2, now: 3, evidenceJson }),
      ),
    )
    expect(attempts.filter(Boolean)).toHaveLength(1)
    const row = await f.journal.operation(f.operation)
    expect(row?.resolvedJson).toBe('first-commits')
    expect(row?.version).toBe(3)
    expect(row?.diagnosticsJson).toBe(attempts.find(Boolean)?.diagnosticsJson)
  })

  test('revoked Task ownership after resolving prevents the worktree effect and commit transition', async () => {
    const f = await fixture()
    let revoked = false,
      materialized = false
    const effects: RepositoryPreparationEffects = {
      async assertCurrent() {
        if (revoked) throw new Error('existing-task-fence-revoked')
      },
      async resolveCommits() {
        revoked = true
        return { kind: 'resolved', planJson: 'commits' }
      },
      async materialize() {
        materialized = true
        return { kind: 'prepared', receiptJson: 'unexpected' }
      },
    }
    await expect(prepareRepositoryWorkspace({ ...f, effects })).rejects.toThrow(
      'existing-task-fence-revoked',
    )
    expect(materialized).toBe(false)
    expect((await f.journal.operation(f.operation))?.state).toBe('resolving')
  })

  test('failed and stopped outcomes replay durable references without invoking effects again', async () => {
    for (const kind of ['failed', 'stopped'] as const) {
      const f = await fixture()
      const effects: RepositoryPreparationEffects = {
        assertCurrent: async () => {},
        resolveCommits: async () => ({ kind: 'resolved', planJson: 'commits' }),
        materialize: async () =>
          kind === 'failed'
            ? { kind, safeCode: 'preparation-failed', diagnosticsJson: '{"reason":"git failed"}' }
            : { kind, receiptJson: '{"cleanup":"completed"}' },
      }
      const result = await prepareRepositoryWorkspace({ ...f, effects })
      expect(result.kind).toBe(kind)
      effects.materialize = async () => {
        throw new Error('terminal effect repeated')
      }
      effects.resolveCommits = async () => {
        throw new Error('terminal source repeated')
      }
      expect(
        await prepareRepositoryWorkspace({
          ...f,
          journal: createRepositoryPreparationJournal(harness.db),
          effects,
        }),
      ).toEqual(result)
      expect((await f.journal.operation(f.operation))?.diagnosticsJson).toContain(
        kind === 'failed' ? 'git failed' : 'completed',
      )
    }
  })
  test('a live effect binding checks operation/source, expires, and coalesces concurrent calls', async () => {
    const f = await fixture()
    let resolves = 0,
      physical = 0
    const owner = composeRepositoryPreparationParticipant({ journal: f.journal })
    const bound = owner.bindEffect({
      operation: f.operation,
      source: f.source,
      effects: {
        assertCurrent: async () => {},
        resolveCommits: async () => {
          resolves++
          return { kind: 'resolved', planJson: 'commits' }
        },
        materialize: async () => {
          physical++
          return { kind: 'prepared', receiptJson: 'workspace' }
        },
      },
    })
    await expect(
      owner.participant.prepare(
        bound.capability,
        decodeRepositoryLaunchRef('operation', `sc:operation:v1:${ulid()}`),
        f.source,
      ),
    ).rejects.toThrow('repository-preparation-effect-scope-mismatch')
    const results = await Promise.all(
      [1, 2, 3].map(() => owner.participant.prepare(bound.capability, f.operation, f.source)),
    )
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
    expect(resolves).toBe(1)
    expect(physical).toBe(1)
    bound.close()
    await expect(
      owner.participant.prepare(bound.capability, f.operation, f.source),
    ).rejects.toThrow('repository-preparation-effect-scope-ended')
  })
  test('cleanup keeps incomplete receipts, original evidence and success receipts across replay', async () => {
    const f = await fixture()
    await prepareRepositoryWorkspace({
      ...f,
      effects: {
        assertCurrent: async () => {},
        resolveCommits: async () => ({ kind: 'resolved', planJson: 'first commits' }),
        materialize: async ({ checkpoint }) => {
          await checkpoint('{"original":"physical evidence"}')
          return { kind: 'prepared', receiptJson: 'original receipt' }
        },
      },
    })
    let attempts = 0
    const effects = {
      assertCurrent: async () => {},
      cleanup: async (input: { planJson: string | null; diagnosticsJson: string | null }) => {
        expect(input.planJson).toBe('first commits')
        expect(input.diagnosticsJson).toBe('{"original":"physical evidence"}')
        attempts++
        return { complete: attempts > 1, receiptJson: `cleanup-${attempts}` }
      },
    }
    expect(await cleanupRepositoryWorkspace({ ...f, effects })).toEqual({
      complete: false,
      receiptJson: 'cleanup-1',
    })
    const partial = await f.journal.operation(f.operation)
    expect(partial?.state).toBe('prepared')
    expect(partial?.diagnosticsJson).toContain('cleanup-1')
    const complete = await cleanupRepositoryWorkspace({
      ...f,
      journal: createRepositoryPreparationJournal(harness.db),
      effects,
    })
    expect(complete).toEqual({ complete: true, receiptJson: 'cleanup-2' })
    expect(await cleanupRepositoryWorkspace({ ...f, effects })).toEqual(complete)
    expect(attempts).toBe(2)
    const row = await f.journal.operation(f.operation)
    expect(row?.state).toBe('cleaned')
    expect(row?.resolvedJson).toBe('first commits')
    expect(row?.receiptJson).toBe('original receipt')
    expect(
      await f.journal.recordCleanup({
        id: f.operation,
        expectedVersion: partial!.version,
        from: 'prepared',
        complete: true,
        diagnosticsJson: 'stale cleanup',
        now: 3,
      }),
    ).toBeNull()
  })

  test('a Task binding or owner rejection cannot start cleanup or publish a stale result', async () => {
    const f = await fixture()
    let physical = 0
    let allowed = false
    const effects = {
      assertCurrent: async () => {
        if (!allowed) throw new Error('task-workspace-already-bound')
      },
      cleanup: async () => {
        physical++
        allowed = false
        return { complete: true, receiptJson: 'stale' }
      },
    }
    await expect(cleanupRepositoryWorkspace({ ...f, effects })).rejects.toThrow(
      'task-workspace-already-bound',
    )
    expect(physical).toBe(0)
    expect((await f.journal.operation(f.operation))?.state).toBe('planned')
    allowed = true
    await expect(cleanupRepositoryWorkspace({ ...f, effects })).rejects.toThrow(
      'task-workspace-already-bound',
    )
    expect(physical).toBe(1)
    expect((await f.journal.operation(f.operation))?.state).toBe('stopped')
    expect((await f.journal.operation(f.operation))?.diagnosticsJson).toBeNull()
  })
})
