// RFC-363: real database operation replay and record-before-effect ordering.
// Injected effects isolate failure windows; real Git is covered separately.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { sha256Hex } from '@/util/hash'
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
})
