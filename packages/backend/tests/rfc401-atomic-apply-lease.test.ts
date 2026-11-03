// RFC-401 T4（design §10.1）—— AtomicApply 的持久 claim / lease / fencing。
//
// 此前恢复判据是「不在本进程活跃快照且 updatedAt 超过十分钟」：另一进程中超过十分钟的 staging 可能被补偿，而被补偿的那个
// 进程仍会继续提交；committed 之后的尾部每轮都被前滚。本文件锁定新协议（两个场景 × 两种 provider）：
//   · 前台 claim 与 journal 行同一事务落下（令牌、lease_epoch 1、60 s 租约），apply 完成后尾部 complete、租约释放；
//   · 未过期的租约不能被恢复接管；过期后接管成功（lease_epoch + 1），接管者执行补偿 / 前滚；
//   · 被接管的旧持有者提交被 fencing 拒绝（场景的 `transitionLost('lease')`），领域写入不落库、它也不补偿；
//   · 长 staging 续租，租约不过期；
//   · 提交后尾部未完成（pending）由恢复前滚一次后记为 complete，下一轮不再前滚；
//   · 旧版本留下的 journal（没有 claim 行）被恢复接管。
import { beforeEach, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createAtomicApplyClaimStore } from '@/platform/atomic-apply/infrastructure/claimStore'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import { ATOMIC_APPLY_LEASE_MS, atomicApplyRecoveryClaims } from '@/platform/atomic-apply/lease'
import { createAtomicApply } from '@/platform/atomic-apply/stateMachine'
import type {
  AtomicApplyErrors,
  AtomicApplyJournal,
  AtomicApplyRow,
} from '@/platform/contracts/atomicApply'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createIntentApplyJournal } from '@/modules/intent/infrastructure/intentApplyJournal'
import { intentApplyArtifactCodecs } from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import { createResourcePackageAtomicJournal } from '@/modules/resource-catalog/infrastructure/resourcePackageAtomicJournal'
import { resourcePackageArtifactCodecs } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'rfc401-lease-owner'
const SESSION = 'rfc401-lease-session'
const DRAFT = 'rfc401-lease-draft'
const errors: AtomicApplyErrors<AtomicApplyRow> = {
  failedReplay: (row) => new Error(`failed:${row.error}`),
  unsettledReplay: () => new Error('unsettled'),
  claimLost: () => new Error('claim-lost'),
  transitionLost: (phase) => new Error(`cas-lost:${phase}`),
  failed: (error) => String(error),
  compensationIncomplete: () => 'retryable: compensation incomplete',
  committedIncomplete: 'retryable: committed tail incomplete',
}
type Receipt = { journalId: string }

for (const scene of ['intent', 'resource-package'] as const) {
  describeEachProvider(`RFC-401 T4 ${scene} durable claim / lease / fencing`, (harness) => {
    let now = 1_000
    let journal: AtomicApplyJournal<PersistenceTx, string, string>
    const claims = createAtomicApplyClaimStore(scene)
    // 本文件不记录工件：只需要两个场景各自的空工件信封。
    const emptyArtifacts = () =>
      scene === 'intent'
        ? intentApplyArtifactCodecs.encode([])
        : resourcePackageArtifactCodecs.encode([])

    beforeEach(async () => {
      now = 1_000
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
        title: 'lease',
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

    function machine(
      options: { readonly renewEveryMs?: number; readonly clock?: () => number } = {},
    ) {
      return createAtomicApply({
        journal,
        claims,
        codecs: { encode: emptyArtifacts },
        receipt: { decode: (json: string) => JSON.parse(json) as Receipt, encode: JSON.stringify },
        errors,
        id: ulid,
        token: ulid,
        now: options.clock ?? (() => now),
        ...(options.renewEveryMs === undefined ? {} : { renewEveryMs: options.renewEveryMs }),
      })
    }

    async function claimed(apply = machine(), key = ulid()) {
      const result = await apply.claim({
        key,
        beforeLookup: async () => undefined,
        prepare: async () => ({ insert: key, value: key }),
      })
      if (result.kind !== 'claimed') throw new Error('expected claim')
      return { apply, journalId: result.journalId }
    }

    async function claimRow(journalId: string) {
      const { atomicApplyClaims } = tablesOf(harness.db)
      return first(
        harness.db
          .select()
          .from(atomicApplyClaims)
          .where(
            and(eq(atomicApplyClaims.scene, scene), eq(atomicApplyClaims.journalId, journalId)),
          ),
      )
    }

    async function journalRow(journalId: string) {
      return (await journal.list()).find((row) => row.id === journalId)
    }

    async function displayName() {
      const { users } = tablesOf(harness.db)
      return (await first(harness.db.select().from(users).where(eq(users.id, OWNER))))?.displayName
    }

    function execute(
      apply: ReturnType<typeof machine>,
      journalId: string,
      options: {
        readonly beforeCommit?: () => Promise<void>
        readonly afterCommit?: () => Promise<boolean | void>
        readonly compensations?: string[]
      } = {},
    ) {
      return apply.execute({
        journalId,
        prepare: async () => {
          await options.beforeCommit?.()
          return undefined
        },
        async commit(tx, id) {
          const { users } = tablesOf(tx)
          await tx.update(users).set({ displayName: id }).where(eq(users.id, OWNER))
          return { receipt: { journalId: id } }
        },
        afterCommit: options.afterCommit ?? (async () => undefined),
        compensate: async () => {
          options.compensations?.push(journalId)
          return []
        },
        committedFailure: async () => undefined,
      })
    }

    function recovery(calls: string[], options: { readonly incompleteRollForward?: boolean } = {}) {
      return createAtomicApplyRecovery(
        [
          {
            key: scene,
            list: journal.list,
            ...atomicApplyRecoveryClaims(journal, claims),
            async recover(row, action) {
              calls.push(`${action}:${row.id}`)
              if (action === 'roll-forward' && options.incompleteRollForward === true) return false
            },
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

    test('the front claim lands with the journal row; a completed apply marks the tail complete and releases the lease', async () => {
      const { apply, journalId } = await claimed()
      expect(await claimRow(journalId)).toMatchObject({
        leaseEpoch: 1,
        claimExpiresAt: now + ATOMIC_APPLY_LEASE_MS,
        tailState: 'none',
      })
      now += 10
      await execute(apply, journalId)
      expect(await claimRow(journalId)).toMatchObject({
        leaseEpoch: 1,
        tailState: 'complete',
        claimExpiresAt: now,
      })
      expect((await journalRow(journalId))?.state).toBe('committed')
      // 尾部已完成：恢复不再前滚它。
      const calls: string[] = []
      expect(await recovery(calls).converge({ [scene]: [] } as never)).toEqual({
        failed: 0,
        rolledForward: 0,
      })
      expect(calls).toEqual([])
    })

    test('a live lease cannot be taken over; after expiry recovery takes it over and compensates', async () => {
      const { journalId } = await claimed()
      const calls: string[] = []
      // 另一个进程的在途 apply：租约未过期，恢复不动它（此前十分钟内也不动，但过了十分钟就会补偿在途的 staging）。
      now += ATOMIC_APPLY_LEASE_MS - 1
      expect(await recovery(calls).converge({ [scene]: [] } as never)).toEqual({
        failed: 0,
        rolledForward: 0,
      })
      expect(calls).toEqual([])
      now += 2
      expect(await recovery(calls).converge({ [scene]: [] } as never)).toEqual({
        failed: 1,
        rolledForward: 0,
      })
      expect(calls).toEqual([`compensate:${journalId}`])
      expect((await journalRow(journalId))?.state).toBe('failed')
      expect(await claimRow(journalId)).toMatchObject({ leaseEpoch: 2, claimExpiresAt: now })
    })

    test('an old holder whose claim was taken over cannot commit and does not compensate', async () => {
      const { apply, journalId } = await claimed()
      const compensations: string[] = []
      const calls: string[] = []
      await expect(
        execute(apply, journalId, {
          compensations,
          async beforeCommit() {
            // 旧持有者在 staging 中停顿超过租约；恢复接管并补偿。
            now += ATOMIC_APPLY_LEASE_MS + 1
            await recovery(calls).converge({ [scene]: [] } as never)
          },
        }),
      ).rejects.toThrow('cas-lost:lease')
      expect(calls).toEqual([`compensate:${journalId}`])
      expect(compensations).toEqual([])
      expect(await displayName()).toBe('before')
      expect((await journalRow(journalId))?.state).toBe('failed')
    })

    test('a long staging renews its lease so recovery cannot take it over', async () => {
      let clock = Date.now()
      const apply = machine({ renewEveryMs: 5, clock: () => clock })
      const { journalId } = await claimed(apply)
      const calls: string[] = []
      await execute(apply, journalId, {
        async beforeCommit() {
          // 时钟走过一个租约，期间续租不断推进 claim_expires_at。
          for (let i = 0; i < 4; i += 1) {
            clock += ATOMIC_APPLY_LEASE_MS / 3
            await new Promise((resolve) => setTimeout(resolve, 20))
          }
          now = clock
          await recovery(calls).converge({ [scene]: [] } as never)
        },
      })
      expect(calls).toEqual([])
      expect((await journalRow(journalId))?.state).toBe('committed')
      expect(await displayName()).toBe(journalId)
    })

    test('an incomplete post-commit tail is rolled forward once, then marked complete', async () => {
      const { apply, journalId } = await claimed()
      await execute(apply, journalId, { afterCommit: async () => false })
      expect(await claimRow(journalId)).toMatchObject({ tailState: 'pending' })
      const calls: string[] = []
      // 尾部失败时已释放租约：恢复立即可接管（不必等十分钟）。
      expect(await recovery(calls).converge({ [scene]: [] } as never)).toEqual({
        failed: 0,
        rolledForward: 1,
      })
      expect(calls).toEqual([`roll-forward:${journalId}`])
      expect(await claimRow(journalId)).toMatchObject({ tailState: 'complete', leaseEpoch: 2 })
      expect((await journalRow(journalId))?.error).toBeNull()
      await recovery(calls).converge({ [scene]: [] } as never)
      expect(calls).toEqual([`roll-forward:${journalId}`])
    })

    test('a roll-forward that stays incomplete keeps the tail pending for the next run', async () => {
      const { apply, journalId } = await claimed()
      await execute(apply, journalId, { afterCommit: async () => false })
      const calls: string[] = []
      await recovery(calls, { incompleteRollForward: true }).converge({ [scene]: [] } as never)
      expect(await claimRow(journalId)).toMatchObject({ tailState: 'pending' })
      expect((await journalRow(journalId))?.error).toBe(errors.committedIncomplete)
      await recovery(calls).converge({ [scene]: [] } as never)
      expect(calls).toEqual([`roll-forward:${journalId}`, `roll-forward:${journalId}`])
      expect(await claimRow(journalId)).toMatchObject({ tailState: 'complete' })
    })

    test('a journal left by an older version (no claim row) is taken over by recovery', async () => {
      const journalId = ulid()
      await journal.transaction((tx) =>
        journal.insert(
          tx,
          {
            id: journalId,
            state: 'prepared',
            preparedArtifactsJson: emptyArtifacts(),
            receiptJson: null,
            error: null,
            createdAt: now,
            updatedAt: now,
          },
          ulid(),
        ),
      )
      expect(await claimRow(journalId)).toBeUndefined()
      const calls: string[] = []
      expect(await recovery(calls).converge({ [scene]: [] } as never)).toEqual({
        failed: 1,
        rolledForward: 0,
      })
      expect(calls).toEqual([`compensate:${journalId}`])
      expect(await claimRow(journalId)).toMatchObject({ leaseEpoch: 1, claimExpiresAt: now })
    })
  })
}
