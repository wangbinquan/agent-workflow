// RFC-395 II-a A6 — 用两种真实 provider、两张现有 journal 表锁住唯一状态机与恢复协议。
import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createAtomicApply } from '@/platform/atomic-apply/stateMachine'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import type {
  AtomicApplyErrors,
  AtomicApplyJournal,
  AtomicApplyRow,
} from '@/platform/contracts/atomicApply'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { insertOne } from '@/platform/persistence/singleInsert'
import type { IntentApplyRecoveryArtifact } from '@/modules/intent/infrastructure/intentApplyEngine'
import { createIntentApplyJournal } from '@/modules/intent/infrastructure/intentApplyJournal'
import { intentApplyArtifactCodecs } from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import { createResourcePackageAtomicJournal } from '@/modules/resource-catalog/infrastructure/resourcePackageAtomicJournal'
import {
  type ResourcePackageRecoveryArtifact,
  resourcePackageArtifactCodecs,
} from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import { intentApplyErrors } from '@/modules/intent/infrastructure/intentApplyErrors'
import { resourcePackageApplyErrors } from '@/modules/resource-catalog/infrastructure/resourcePackageApplyErrors'
import { ConflictError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'rfc395-a6-owner'
const SESSION = 'rfc395-a6-session'
const DRAFT = 'rfc395-a6-draft'
const errors: AtomicApplyErrors<AtomicApplyRow> = {
  failedReplay: (row) => new Error(`failed:${row.error}`),
  unsettledReplay: () => new Error('unsettled'),
  claimLost: () => new Error('claim-lost'),
  transitionLost: (phase) => new Error(`cas-lost:${phase}`),
  failed: (error) => String(error),
  compensationIncomplete: () => 'retryable: compensation incomplete',
  committedIncomplete: 'retryable: committed tail incomplete',
}
type Artifact = IntentApplyRecoveryArtifact | ResourcePackageRecoveryArtifact
type Receipt = { journalId: string; applied: readonly unknown[] }

for (const scene of ['intent', 'resource-package'] as const) {
  describeEachProvider(`RFC-395 II-a A6 ${scene} shared state machine`, (harness) => {
    let now = 1
    let journal: AtomicApplyJournal<PersistenceTx, string, string>
    const codecs = scene === 'intent' ? intentApplyArtifactCodecs : resourcePackageArtifactCodecs
    beforeEach(async () => {
      now = 1
      const { users, intentSessions, intentDrafts } = tablesOf(harness.db)
      await insertOne(harness.db, users, {
        id: OWNER,
        username: OWNER,
        displayName: 'before',
        role: 'user',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })
      await insertOne(harness.db, intentSessions, {
        id: SESSION,
        ownerUserId: OWNER,
        title: 'A6',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })
      await insertOne(harness.db, intentDrafts, {
        id: DRAFT,
        sessionId: SESSION,
        revision: 1,
        draftHash: 'hash-a',
        contextRevision: 0,
        changesetJson: '{}',
        createdAt: 1,
      })
      if (scene === 'intent') {
        const port = createIntentApplyJournal(harness.db)
        journal = {
          ...port,
          find: (tx, key) => port.find(tx, { sessionId: SESSION, clientMutationId: key }),
          insert: (tx, row, key) =>
            port.insert(tx, row, {
              sessionId: SESSION,
              clientMutationId: key,
              draftId: DRAFT,
              draftHash: 'hash-a',
            }),
        }
      } else {
        const port = createResourcePackageAtomicJournal(harness.db)
        journal = {
          ...port,
          find: (tx, key) => port.find(tx, { scope: 'package', key }),
          insert: (tx, row, key) =>
            port.insert(tx, row, { scope: 'package', key, actorUserId: OWNER }),
        }
      }
    })
    function machine(port = journal, errorContract = errors) {
      return createAtomicApply({
        journal: port,
        codecs: {
          encode: (artifacts: readonly Artifact[]) =>
            scene === 'intent'
              ? intentApplyArtifactCodecs.encode(
                  artifacts as readonly IntentApplyRecoveryArtifact[],
                )
              : resourcePackageArtifactCodecs.encode(
                  artifacts as readonly ResourcePackageRecoveryArtifact[],
                ),
        },
        receipt: { decode: (json: string) => JSON.parse(json) as Receipt, encode: JSON.stringify },
        errors: errorContract,
        id: ulid,
        now: () => now,
      })
    }
    async function claim(key: string, apply = machine()) {
      const result = await apply.claim({
        key,
        beforeLookup: async () => undefined,
        prepare: async () => ({ insert: key, value: key }),
      })
      if (result.kind !== 'claimed') throw new Error('expected claim')
      return { apply, journalId: result.journalId }
    }
    async function row(key: string) {
      return journal.transaction((tx) => journal.find(tx, key))
    }
    function run(
      apply: ReturnType<typeof machine>,
      journalId: string,
      fail = false,
      loseCommit = false,
    ) {
      return apply.execute({
        journalId,
        prepare: async () => undefined,
        async commit(tx, id) {
          const { users } = tablesOf(tx)
          await tx.update(users).set({ displayName: id }).where(eq(users.id, OWNER))
          if (loseCommit)
            await journal.compareAndSet(tx, id, 'applying', {
              state: 'failed',
              error: 'injected',
              updatedAt: now,
            })
          if (fail) throw new Error('domain-commit-failed')
          return { receipt: { journalId: id, applied: [] } }
        },
        afterCommit: async () => undefined,
        compensate: async () => [],
        committedFailure: async () => undefined,
      })
    }
    function recovery(
      recover: (
        row: AtomicApplyRow,
        action: 'compensate' | 'roll-forward',
      ) => Promise<boolean | void>,
    ) {
      return createAtomicApplyRecovery(
        [
          {
            key: String(scene),
            list: journal.list,
            compareAndSet: (row, patch) =>
              journal.transaction((tx) => journal.compareAndSet(tx, row.id, row.state, patch)),
            recover,
            errors: {
              abandoned: 'crashed before commit',
              committedIncomplete: errors.committedIncomplete,
              retryable: () => 'retryable: recovery failed',
            },
            warn() {},
            warnScene() {},
          },
        ],
        () => now,
      )
    }

    test.each(['prepared', 'applying'] as const)(
      'crash after %s is compensated and CAS-settled',
      async (state) => {
        const { journalId } = await claim('crash')
        if (state === 'applying')
          await journal.transaction((tx) =>
            journal.compareAndSet(tx, journalId, 'prepared', { state, updatedAt: now }),
          )
        now = 600_002
        const calls: string[] = []
        const result = await recovery(async (entry, action) => {
          calls.push(action)
          expect(codecs.decode(entry.preparedArtifactsJson)).toEqual([])
        }).converge({ [scene]: [] })
        expect(result).toEqual({ failed: 1, rolledForward: 0 })
        expect(calls).toEqual(['compensate'])
        expect((await row('crash'))?.state).toBe('failed')
      },
    )

    test('duplicate request replays one receipt without repeating domain commit', async () => {
      const { apply, journalId } = await claim('duplicate')
      const receipt = await run(apply, journalId)
      let prepared = 0
      const second = await machine().claim({
        key: 'duplicate',
        beforeLookup: async () => undefined,
        prepare: async () => {
          prepared++
          return { insert: 'duplicate', value: undefined }
        },
      })
      expect(second).toEqual({ kind: 'replay', receipt })
      expect(prepared).toBe(0)
      expect(await journal.list()).toHaveLength(1)
    })

    test('insert conflict rereads the persistent claim even when the first lookup missed it', async () => {
      await claim('collision')
      let reads = 0
      const apply = machine({
        ...journal,
        find: async (tx, key) => (++reads === 1 ? undefined : journal.find(tx, key)),
      })
      await expect(
        apply.claim({
          key: 'collision',
          beforeLookup: async () => undefined,
          prepare: async () => ({ insert: 'collision', value: undefined }),
        }),
      ).rejects.toThrow('unsettled')
      expect(reads).toBe(2)
      expect(await journal.list()).toHaveLength(1)
    })

    test('failed replay stays failed; a new idempotency key can retry', async () => {
      const first = await claim('failed')
      await expect(run(first.apply, first.journalId, true)).rejects.toThrow('domain-commit-failed')
      await expect(
        machine().claim({
          key: 'failed',
          beforeLookup: async () => undefined,
          prepare: async () => ({ insert: 'failed', value: undefined }),
        }),
      ).rejects.toThrow('failed:')
      const retry = await claim('retry')
      await run(retry.apply, retry.journalId)
      expect((await row('retry'))?.state).toBe('committed')
    })

    test.each([false, true])(
      'domain writes roll back with the journal CAS (commit CAS lost: %s)',
      async (loseCommit) => {
        const { apply, journalId } = await claim('rollback')
        await expect(run(apply, journalId, !loseCommit, loseCommit)).rejects.toThrow(
          loseCommit ? 'cas-lost:commit' : 'domain-commit-failed',
        )
        const { users } = tablesOf(harness.db)
        expect(
          (await first(harness.db.select().from(users).where(eq(users.id, OWNER))))?.displayName,
        ).toBe('before')
        expect(await row('rollback')).toMatchObject({ state: 'failed', receiptJson: null })
      },
    )

    test('journal id is available to the domain transaction and receipt', async () => {
      const { apply, journalId } = await claim('atomic')
      const receipt = await run(apply, journalId)
      const { users } = tablesOf(harness.db)
      expect(
        (await first(harness.db.select().from(users).where(eq(users.id, OWNER))))?.displayName,
      ).toBe(journalId)
      expect(JSON.parse((await row('atomic'))!.receiptJson!)).toEqual(receipt)
    })

    test('incomplete compensation remains retryable and artifact recovery settles later', async () => {
      const { apply, journalId } = await claim('artifact')
      const artifact =
        scene === 'intent'
          ? {
              kind: 'plugin-install' as const,
              pluginId: 'p',
              generationId: 'g',
              generationDir: '/plugins/g',
            }
          : {
              kind: 'plugin-install' as const,
              operationId: 'op',
              pluginId: 'p',
              generationId: 'g',
              generationDirectory: '/plugins/g',
            }
      await expect(
        apply.execute({
          journalId,
          prepare: async (record) => {
            await record(artifact)
            throw new Error('crash after record')
          },
          commit: async () => ({ receipt: { journalId, applied: [] } }),
          afterCommit: async () => undefined,
          compensate: async () => [new Error('disk unavailable')],
          committedFailure: async () => undefined,
        }),
      ).rejects.toThrow('crash after record')
      expect(apply.activeJournalIds()).toEqual([])
      expect((await row('artifact'))?.preparedArtifactsJson).toBe(JSON.stringify([artifact]))
      expect(await row('artifact')).toMatchObject({
        state: 'prepared',
        error: 'retryable: compensation incomplete',
      })
      now = 600_002
      await recovery(async (entry) => {
        expect(codecs.decode(entry.preparedArtifactsJson)).toEqual([artifact])
      }).converge({ [scene]: [] })
      expect((await row('artifact'))?.state).toBe('failed')
    })

    test('committed tail failures never compensate domain writes and clear their persisted note on recovery', async () => {
      const { apply, journalId } = await claim('tail')
      let compensation = 0
      await expect(
        apply.execute({
          journalId,
          prepare: async () => undefined,
          commit: async () => ({ receipt: { journalId, applied: [] } }),
          afterCommit: async () => {
            throw new Error('tail failed')
          },
          compensate: async () => {
            compensation++
            return []
          },
          committedFailure: async () => undefined,
        }),
      ).rejects.toThrow('tail failed')
      expect(compensation).toBe(0)
      expect(await row('tail')).toMatchObject({
        state: 'committed',
        error: errors.committedIncomplete,
      })
      expect(await recovery(async () => undefined).converge({ [scene]: [] })).toEqual({
        failed: 0,
        rolledForward: 1,
      })
      expect((await row('tail'))?.error).toBeNull()
    })

    test('payload identity is checked before replay when the scene stores it', async () => {
      const { apply, journalId } = await claim('identity')
      await run(apply, journalId)
      const original = new ConflictError('identity-conflict', 'different-payload')
      let checks = 0
      let prepares = 0
      await expect(
        machine().claim({
          key: 'identity',
          beforeLookup: async () => undefined,
          assertReplay: (persisted) => {
            expect(persisted.id).toBe(journalId)
            expect(persisted.state).toBe('committed')
            checks++
            throw original
          },
          prepare: async () => {
            prepares++
            return { insert: 'identity', value: undefined }
          },
        }),
      ).rejects.toBe(original)
      expect(checks).toBe(1)
      expect(prepares).toBe(0)
      expect(await journal.list()).toHaveLength(1)
      expect((await row('identity'))?.state).toBe('committed')
    })

    test.each(['prepared', 'applying'] as const)(
      'failed recovery notes do not renew %s freshness',
      async (state) => {
        const { journalId } = await claim('retry-age')
        if (state === 'applying')
          await journal.transaction((tx) =>
            journal.compareAndSet(tx, journalId, 'prepared', { state, updatedAt: 1 }),
          )
        now = 600_002
        let attempts = 0
        const sweep = recovery(async () => {
          attempts++
          throw new Error('storage unavailable')
        })
        await sweep.converge({ [scene]: [] })
        expect(await row('retry-age')).toMatchObject({
          state,
          updatedAt: 1,
          error: 'retryable: recovery failed',
        })
        now++
        await sweep.converge({ [scene]: [] })
        expect(attempts).toBe(2)
      },
    )

    test.each([false, true])(
      'settlement failures preserve the original pre-commit error (cleanup fails: %s)',
      async (cleanupFails) => {
        const original = new ConflictError('package-selected-target-changed', 're-preview')
        const cleanup = new Error('cleanup failed')
        const settlement = new Error('database unavailable')
        let notes = 0
        const port: typeof journal = {
          ...journal,
          compareAndSet: async (tx, id, expected, patch) => {
            if (patch.error) {
              notes++
              throw settlement
            }
            return journal.compareAndSet(tx, id, expected, patch)
          },
        }
        const { apply, journalId } = await claim('settlement', machine(port))
        const warnings: unknown[] = []
        await expect(
          apply.execute({
            journalId,
            prepare: async () => {
              throw original
            },
            commit: async () => ({ receipt: { journalId, applied: [] } }),
            afterCommit: async () => undefined,
            compensate: async () => (cleanupFails ? [cleanup] : []),
            committedFailure: async () => {
              throw new Error('pre-commit cannot run committed recovery')
            },
            leftRetryable: (error, failures) => warnings.push({ error, failures }),
          }),
        ).rejects.toBe(original)
        expect(notes).toBe(2)
        expect(warnings).toEqual([
          { error: original, failures: cleanupFails ? [cleanup, settlement] : [settlement] },
        ])
        expect(await row('settlement')).toMatchObject({ state: 'prepared', receiptJson: null })
        expect(apply.activeJournalIds()).toEqual([])
      },
    )

    test('failed committed note still runs committed recovery and preserves the original error', async () => {
      const original = new Error('publication failed')
      const port: typeof journal = {
        ...journal,
        compareAndSet: async (tx, id, expected, patch) => {
          if (expected === 'committed') throw new Error('note write failed')
          return journal.compareAndSet(tx, id, expected, patch)
        },
      }
      const { apply, journalId } = await claim('committed-note', machine(port))
      const calls: unknown[] = []
      await expect(
        apply.execute({
          journalId,
          prepare: async () => undefined,
          commit: async () => ({ receipt: { journalId, applied: [] } }),
          afterCommit: async () => {
            throw original
          },
          compensate: async () => {
            throw new Error('committed domain cannot be compensated')
          },
          committedFailure: async (error, artifacts) => {
            calls.push({ error, artifacts })
          },
        }),
      ).rejects.toBe(original)
      expect(calls).toEqual([{ error: original, artifacts: [] }])
      expect(await row('committed-note')).toMatchObject({
        state: 'committed',
        receiptJson: JSON.stringify({ journalId, applied: [] }),
      })
      expect(apply.activeJournalIds()).toEqual([])
    })

    test.each(['artifact', 'claim', 'commit'] as const)(
      'lost %s transition uses the scene 409 and rolls back domain writes',
      async (phase) => {
        const port: typeof journal = {
          ...journal,
          compareAndSet: async (tx, id, expected, patch) => {
            if (
              (phase === 'artifact' && patch.preparedArtifactsJson !== undefined) ||
              (phase === 'claim' && patch.state === 'applying') ||
              (phase === 'commit' && patch.state === 'committed')
            )
              return false
            return journal.compareAndSet(tx, id, expected, patch)
          },
        }
        const apply = machine(
          port,
          scene === 'intent' ? intentApplyErrors : resourcePackageApplyErrors,
        )
        const { journalId } = await claim('transition-lost', apply)
        const artifact =
          scene === 'intent'
            ? {
                kind: 'plugin-install' as const,
                pluginId: 'p',
                generationId: 'g',
                generationDir: '/g',
              }
            : {
                kind: 'plugin-install' as const,
                pluginId: 'p',
                operationId: 'op',
                generationId: 'g',
                generationDirectory: '/g',
              }
        await expect(
          apply.execute({
            journalId,
            prepare: async (record) => {
              if (phase === 'artifact') await record(artifact)
            },
            commit: async (tx) => {
              const { users } = tablesOf(tx)
              await tx.update(users).set({ displayName: 'changed' }).where(eq(users.id, OWNER))
              return { receipt: { journalId, applied: [] } }
            },
            afterCommit: async () => undefined,
            compensate: async () => [],
            committedFailure: async () => undefined,
          }),
        ).rejects.toMatchObject({
          status: 409,
          code: scene === 'intent' ? 'intent-apply-unsettled' : 'bundle-apply-unsettled',
          message: phase === 'commit' ? 'journal commit lost' : 'journal claim lost',
        })
        const { users } = tablesOf(harness.db)
        expect(
          (await first(harness.db.select().from(users).where(eq(users.id, OWNER))))?.displayName,
        ).toBe('before')
        expect(await row('transition-lost')).toMatchObject({
          state: 'failed',
          preparedArtifactsJson: '[]',
          receiptJson: null,
        })
      },
    )

    test('claim disappearance is a scene conflict rather than an internal error', async () => {
      const apply = machine(
        { ...journal, find: async () => undefined, insert: async () => false },
        scene === 'intent' ? intentApplyErrors : resourcePackageApplyErrors,
      )
      await expect(
        apply.claim({
          key: 'gone',
          beforeLookup: async () => undefined,
          prepare: async () => ({ insert: 'gone', value: undefined }),
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: scene === 'intent' ? 'intent-apply-unsettled' : 'bundle-apply-unsettled',
        message: 'journal claim lost',
      })
      expect(await journal.list()).toEqual([])
    })
  })
}
