import type {
  AtomicApplyArtifactRegistry,
  AtomicApplyClaim,
  AtomicApplyErrors,
  AtomicApplyJournal,
  AtomicApplyRow,
  AtomicApplyState,
} from '@/platform/contracts/atomicApply'
import { resolveAtomicApplyReplay } from './replay'

/** 唯一 apply 状态机；外部 effect 由 prepare / afterCommit / compensate / committedFailure 承担。 */
export function createAtomicApply<
  Tx,
  Key,
  Insert,
  Row extends AtomicApplyRow,
  Artifact,
  Receipt,
>(input: {
  readonly journal: AtomicApplyJournal<Tx, Key, Insert, Row>
  readonly codecs: Pick<AtomicApplyArtifactRegistry<Artifact>, 'encode'>
  readonly receipt: { decode(json: string): Receipt; encode(receipt: Receipt): string }
  readonly errors: AtomicApplyErrors<NoInfer<Row>>
  readonly id: () => string
  readonly now: () => number
}) {
  const active = new Set<string>()
  const { journal, errors, now } = input
  function replay(row: Row): Receipt {
    return resolveAtomicApplyReplay(row, {
      decode: input.receipt.decode,
      failedReplay: errors.failedReplay,
      unsettledReplay: errors.unsettledReplay,
    })
  }
  async function note(id: string, state: AtomicApplyState, error: string | null) {
    await journal.transaction((tx) =>
      journal.compareAndSet(tx, id, state, { error, updatedAt: now() }),
    )
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
    }): Promise<Receipt> {
      const { journalId } = command
      const artifacts: Artifact[] = []
      let databaseCommitted = false
      active.add(journalId)
      try {
        const prepared = await command.prepare(async (artifact) => {
          const next = [...artifacts, artifact]
          const recorded = await journal.transaction((tx) =>
            journal.compareAndSet(tx, journalId, 'prepared', {
              preparedArtifactsJson: input.codecs.encode(next),
              updatedAt: now(),
            }),
          )
          if (!recorded) throw errors.transitionLost('artifact')
          artifacts.push(artifact)
        })
        const result = await journal.transaction(async (tx) => {
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
          return committed
        })
        databaseCommitted = true
        const complete = await command.afterCommit(result, artifacts)
        if (complete === false) await note(journalId, 'committed', errors.committedIncomplete)
        return result.receipt
      } catch (error) {
        if (databaseCommitted) {
          try {
            await note(journalId, 'committed', errors.committedIncomplete)
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
            // applying 所在事务已回滚，持久状态仍是 prepared。
            await journal.compareAndSet(
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
          })
        } catch (settlementError) {
          compensationErrors = [...compensationErrors, settlementError]
          try {
            await note(
              journalId,
              'prepared',
              errors.compensationIncomplete(error, compensationErrors),
            )
          } catch {
            // 连续 DB 故障仍保留原错误，并由 leftRetryable 留下诊断。
          }
        }
        if (compensationErrors.length > 0) command.leftRetryable?.(error, compensationErrors)
        throw error
      } finally {
        active.delete(journalId)
      }
    },
  })
}
