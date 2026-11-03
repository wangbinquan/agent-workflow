import type {
  AtomicApplyArtifactRegistry,
  AtomicApplyClaim,
  AtomicApplyClaims,
  AtomicApplyErrors,
  AtomicApplyJournal,
  AtomicApplyRow,
  AtomicApplyState,
  AtomicApplyTailState,
} from '@/platform/contracts/atomicApply'
import { ATOMIC_APPLY_LEASE_MS, ATOMIC_APPLY_RENEW_EVERY_MS } from './lease'
import { resolveAtomicApplyReplay } from './replay'

/**
 * 唯一 apply 状态机；外部 effect 由 prepare / afterCommit / compensate / committedFailure 承担。
 *
 * RFC-401 T4（design §10.1）：claim 与 journal 行同一事务落下持久 claim（随机令牌、60 s 租约）；执行期间每 20 s 续租；每一次
 * journal 状态写所在事务先以令牌续租，0 行即已被接管、本持有者不再提交或结算。committed 时尾部记为 pending，`afterCommit`
 * 完成记为 complete 并释放租约。
 */
export function createAtomicApply<
  Tx,
  Key,
  Insert,
  Row extends AtomicApplyRow,
  Artifact,
  Receipt,
>(input: {
  readonly journal: AtomicApplyJournal<Tx, Key, Insert, Row>
  readonly claims: AtomicApplyClaims<Tx>
  readonly codecs: Pick<AtomicApplyArtifactRegistry<Artifact>, 'encode'>
  readonly receipt: { decode(json: string): Receipt; encode(receipt: Receipt): string }
  readonly errors: AtomicApplyErrors<NoInfer<Row>>
  readonly id: () => string
  /** claim 令牌（每次 claim 一个新值）。 */
  readonly token: () => string
  readonly now: () => number
  readonly leaseMs?: number
  readonly renewEveryMs?: number
}) {
  const active = new Set<string>()
  /** 本进程 claim 到的 journal → 令牌；execute 用它 fencing。 */
  const tokens = new Map<string, string>()
  const { journal, claims, errors, now } = input
  /** 本持有者的 claim 已被接管：状态写被 fencing 拒绝，补偿与收尾归接管者。错误本身是场景的 `transitionLost('lease')`。 */
  const leaseLostErrors = new WeakSet<object>()
  function leaseLost(): Error {
    const error = errors.transitionLost('lease')
    leaseLostErrors.add(error)
    return error
  }
  const leaseMs = input.leaseMs ?? ATOMIC_APPLY_LEASE_MS
  const renewEveryMs = input.renewEveryMs ?? ATOMIC_APPLY_RENEW_EVERY_MS
  function replay(row: Row): Receipt {
    return resolveAtomicApplyReplay(row, {
      decode: input.receipt.decode,
      failedReplay: errors.failedReplay,
      unsettledReplay: errors.unsettledReplay,
    })
  }
  /** 以令牌续租（可改尾部）；0 行 = 已被接管。 */
  async function fence(
    tx: Tx,
    journalId: string,
    token: string,
    options: { readonly tail?: AtomicApplyTailState; readonly release?: boolean } = {},
  ): Promise<void> {
    const at = now()
    const renewed = await claims.renew(
      tx,
      {
        journalId,
        token,
        expiresAt: options.release === true ? at : at + leaseMs,
        ...(options.tail === undefined ? {} : { tail: options.tail }),
      },
      at,
    )
    if (!renewed) throw leaseLost()
  }
  async function note(
    id: string,
    token: string,
    state: AtomicApplyState,
    error: string | null,
    release = false,
  ) {
    await journal.transaction(async (tx) => {
      await fence(tx, id, token, { release })
      return journal.compareAndSet(tx, id, state, { error, updatedAt: now() })
    })
  }
  return Object.freeze({
    replay,
    activeJournalIds: () => Object.freeze([...active]),
    async claim<Context, Value>(command: {
      readonly key: Key
      readonly beforeLookup: (tx: Tx) => Promise<Context>
      readonly prepare: (
        tx: Tx,
        context: Context,
      ) => Promise<{ readonly insert: Insert; readonly value: Value }>
      readonly assertReplay?: (row: Row) => void
      readonly afterInsert?: () => void
      /** RFC-401 T5：claim 事务内的场景写（skill 场景在这里取技能锁），失败则整个 claim 回滚。 */
      readonly withinClaim?: (tx: Tx, journalId: string, value: Value) => Promise<void>
    }): Promise<AtomicApplyClaim<Value, Receipt>> {
      const journalId = input.id()
      return journal.transaction(async (tx) => {
        const context = await command.beforeLookup(tx)
        const existing = await journal.find(tx, command.key)
        if (existing !== undefined) {
          command.assertReplay?.(existing)
          return { kind: 'replay', receipt: replay(existing) }
        }
        const prepared = await command.prepare(tx, context)
        const recordedAt = now()
        const token = input.token()
        const inserted = await journal.insert(
          tx,
          {
            id: journalId,
            state: 'prepared',
            preparedArtifactsJson: input.codecs.encode([]),
            receiptJson: null,
            error: null,
            createdAt: recordedAt,
            updatedAt: recordedAt,
          },
          prepared.insert,
        )
        if (!inserted) {
          const raced = await journal.find(tx, command.key)
          if (raced === undefined) throw errors.claimLost()
          command.assertReplay?.(raced)
          return { kind: 'replay', receipt: replay(raced) }
        }
        await claims.insert(tx, { journalId, token, expiresAt: recordedAt + leaseMs }, recordedAt)
        await command.withinClaim?.(tx, journalId, prepared.value)
        tokens.set(journalId, token)
        command.afterInsert?.()
        return { kind: 'claimed', journalId, value: prepared.value }
      })
    },
    async execute<Prepared, Committed extends { readonly receipt: Receipt }>(command: {
      readonly journalId: string
      readonly prepare: (recordArtifact: (artifact: Artifact) => Promise<void>) => Promise<Prepared>
      readonly commit: (tx: Tx, journalId: string, prepared: Prepared) => Promise<Committed>
      readonly afterCommit: (
        result: Committed,
        artifacts: readonly Artifact[],
      ) => Promise<boolean | void>
      readonly compensate: (artifacts: readonly Artifact[]) => Promise<readonly unknown[]>
      readonly committedFailure: (error: unknown, artifacts: readonly Artifact[]) => Promise<void>
      readonly leftRetryable?: (error: unknown, errors: readonly unknown[]) => void
      /**
       * RFC-401 T5：终态结算事务内的场景写（skill 场景在这里释放技能锁）。只在两处执行：尾部完成、补偿完成记为 failed；未完成的
       * 记录由恢复在它的终态写回里结算。
       */
      readonly settle?: (tx: Tx) => Promise<void>
    }): Promise<Receipt> {
      const { journalId } = command
      const token = tokens.get(journalId)
      if (token === undefined) throw errors.transitionLost('claim')
      const artifacts: Artifact[] = []
      let databaseCommitted = false
      let renewalLost = false
      active.add(journalId)
      // 长 staging 与提交后尾部期间续租；续租失败记为租约丢失，下一次状态写必被 fencing 拒绝。续租是一条自排程的链：上一次
      // 落地之后才排下一次，天然串行。最终结算（释放租约）之前先停掉并等在途的那一次落地——否则一次迟到的续租会把刚释放的
      // 租约又续上一个周期。
      let renewing: Promise<void> = Promise.resolve()
      let renewalStopped = false
      let renewalTimer: ReturnType<typeof setTimeout> | undefined
      const scheduleRenewal = (): void => {
        if (renewalStopped) return
        renewalTimer = setTimeout(() => {
          renewalTimer = undefined
          if (renewalStopped) return
          renewing = journal
            .transaction((tx) =>
              claims.renew(tx, { journalId, token, expiresAt: now() + leaseMs }, now()),
            )
            .then(
              (renewed) => {
                // 已被接管就不再续；一次数据库故障不算丢失，下一拍再试。
                if (renewed) scheduleRenewal()
                else renewalLost = true
              },
              () => scheduleRenewal(),
            )
        }, renewEveryMs)
        ;(renewalTimer as { unref?: () => void }).unref?.()
      }
      scheduleRenewal()
      function cancelRenewal(): void {
        renewalStopped = true
        if (renewalTimer !== undefined) clearTimeout(renewalTimer)
        renewalTimer = undefined
      }
      async function stopRenewal(): Promise<void> {
        cancelRenewal()
        await renewing
      }
      try {
        const prepared = await command.prepare(async (artifact) => {
          const next = [...artifacts, artifact]
          const recorded = await journal.transaction(async (tx) => {
            await fence(tx, journalId, token)
            return journal.compareAndSet(tx, journalId, 'prepared', {
              preparedArtifactsJson: input.codecs.encode(next),
              updatedAt: now(),
            })
          })
          if (!recorded) throw errors.transitionLost('artifact')
          artifacts.push(artifact)
        })
        if (renewalLost) throw leaseLost()
        const result = await journal.transaction(async (tx) => {
          await fence(tx, journalId, token)
          if (
            !(await journal.compareAndSet(tx, journalId, 'prepared', {
              state: 'applying',
              updatedAt: now(),
            }))
          ) {
            throw errors.transitionLost('claim')
          }
          const committed = await command.commit(tx, journalId, prepared)
          if (
            !(await journal.compareAndSet(tx, journalId, 'applying', {
              state: 'committed',
              receiptJson: input.receipt.encode(committed.receipt),
              error: null,
              updatedAt: now(),
            }))
          )
            throw errors.transitionLost('commit')
          await fence(tx, journalId, token, { tail: 'pending' })
          return committed
        })
        databaseCommitted = true
        const complete = await command.afterCommit(result, artifacts)
        await stopRenewal()
        if (complete === false) {
          // 尾部未完成：保留 pending、释放租约，恢复接管后前滚。
          await note(journalId, token, 'committed', errors.committedIncomplete, true)
        } else {
          try {
            await journal.transaction(async (tx) => {
              await fence(tx, journalId, token, { tail: 'complete', release: true })
              await command.settle?.(tx)
            })
          } catch {
            // 尾部已完成，记账失败只让恢复多前滚一次（前滚是幂等的）。
          }
        }
        return result.receipt
      } catch (error) {
        await stopRenewal()
        if (!databaseCommitted && leaseLostErrors.has(error as object)) {
          // claim 已被接管：补偿与结算归接管者，本持有者只退出。
          throw error
        }
        if (databaseCommitted) {
          try {
            await note(journalId, token, 'committed', errors.committedIncomplete, true)
          } catch {
            // 记账失败不能跳过提交后的恢复，也不能替换原始错误。
          }
          try {
            await command.committedFailure(error, artifacts)
          } catch {
            // 场景负责记录恢复失败；调用方仍收到最初的发布错误。
          }
          throw error
        }
        let compensationErrors: readonly unknown[]
        try {
          compensationErrors = await command.compensate(artifacts)
        } catch (cleanupError) {
          compensationErrors = [cleanupError]
        }
        try {
          await journal.transaction(async (tx) => {
            // 结算后释放租约：失败的记录无事可做，补偿未完成的留给恢复接管。
            await fence(tx, journalId, token, { release: true })
            // applying 所在事务已回滚，持久状态仍是 prepared。
            const settled = await journal.compareAndSet(
              tx,
              journalId,
              'prepared',
              compensationErrors.length === 0
                ? { state: 'failed', error: errors.failed(error), updatedAt: now() }
                : {
                    error: errors.compensationIncomplete(error, compensationErrors),
                    updatedAt: now(),
                  },
            )
            if (settled && compensationErrors.length === 0) await command.settle?.(tx)
          })
        } catch (settlementError) {
          compensationErrors = [...compensationErrors, settlementError]
          try {
            await note(
              journalId,
              token,
              'prepared',
              errors.compensationIncomplete(error, compensationErrors),
              true,
            )
          } catch {
            // 连续 DB 故障仍保留原错误，并由 leftRetryable 留下诊断。
          }
        }
        if (compensationErrors.length > 0) command.leftRetryable?.(error, compensationErrors)
        throw error
      } finally {
        cancelRenewal()
        active.delete(journalId)
        tokens.delete(journalId)
      }
    },
  })
}
