import type { ProviderNeutralDatabase } from '@/db/query'
import type {
  NormalizedRuntimeSessionLeaseClaimInput,
  RuntimeSessionLeaseOperations,
  RuntimeSessionLeaseToken,
} from '../application/ports/runtimeSessionLeaseOperations'
import type { TaskRuntimeSessionLeaseExecutionOperations } from '../application/ports/taskRuntimeSessionLeaseExecutionOperations'
import {
  currentTaskExecutionContext,
  runWithTaskExecutionContext,
  type TaskExecutionContext,
} from '../application/taskExecutionContext'
import {
  taskHostWorkForToken,
  taskHostWorkCapture,
  type TaskHostAdmittedWork,
} from '../application/taskHostAdmission'
import {
  withTaskHostNewWork,
  withTaskHostIssuedAck,
  type TaskHostWriteBinding,
  type TaskHostWriteSelection,
} from './hostExecutionWriteTransaction'

type SelectedWrite = Extract<TaskHostWriteSelection, { kind: 'selected' }>
interface OriginalLeaseWork {
  readonly context: TaskExecutionContext
  readonly work: TaskHostAdmittedWork
  readonly selection: SelectedWrite
}

/** Preserve the original native methods and transaction frame for selected Task execution. */
export function createSelectedTaskRuntimeSessionLeaseOperations(input: {
  readonly db: ProviderNeutralDatabase
  readonly operations: RuntimeSessionLeaseOperations
  readonly hostWrites: TaskHostWriteBinding
}): TaskRuntimeSessionLeaseExecutionOperations {
  const db = input.db
  const operations = input.operations
  const binding = input.hostWrites
  if (binding === undefined) throw new Error('task-host-write-selection-incomplete')
  const load = operations.load
  const claimNew = operations.claimNew
  const preclaimResume = operations.preclaimResume
  const confirmResume = operations.confirmResume
  const rotate = operations.rotate
  const markResetPending = operations.markResetPending
  const discard = operations.discard
  const release = operations.release
  const tokenWork = new WeakMap<RuntimeSessionLeaseToken, OriginalLeaseWork>()

  function captureClaim(claim: NormalizedRuntimeSessionLeaseClaimInput): OriginalLeaseWork {
    const context = currentTaskExecutionContext(claim.taskId)
    if (context === undefined) throw new Error('task-host-execution-context-required')
    const work = taskHostWorkForToken(context.token)
    if (work === undefined) throw new Error('task-host-admitted-work-required')
    return Object.freeze({
      context,
      work,
      selection: Object.freeze({ kind: 'selected', capture: taskHostWorkCapture(work), binding }),
    })
  }

  function originalTokenWork(token: RuntimeSessionLeaseToken): OriginalLeaseWork {
    const work = tokenWork.get(token)
    if (work === undefined) throw new Error('task-runtime-session-original-work-required')
    return work
  }

  function newWork<T>(work: OriginalLeaseWork, body: () => Promise<T>): Promise<T> {
    return withTaskHostNewWork({
      db,
      isolation: 'serializable',
      selection: work.selection,
      body: () => runWithTaskExecutionContext(work.context, body),
    })
  }

  function issuedAck<T>(work: OriginalLeaseWork, body: () => Promise<T>): Promise<T> {
    return withTaskHostIssuedAck({
      db,
      isolation: 'serializable',
      selection: work.selection,
      body: () => runWithTaskExecutionContext(work.context, body),
    })
  }

  return {
    async load(protocol, sessionId) {
      return await load.call(operations, protocol, sessionId)
    },
    async claimNew(claim) {
      const work = captureClaim(claim)
      const token = await issuedAck(work, () => claimNew.call(operations, claim))
      tokenWork.set(token, work)
      return token
    },
    async preclaimResume(claim) {
      const work = captureClaim(claim)
      const token = await newWork(work, () => preclaimResume.call(operations, claim))
      tokenWork.set(token, work)
      return token
    },
    async confirmResume(token) {
      const work = originalTokenWork(token)
      return await newWork(work, () => confirmResume.call(operations, token))
    },
    async rotate(token, nextSessionId) {
      const work = originalTokenWork(token)
      const next = await issuedAck(work, () => rotate.call(operations, token, nextSessionId))
      tokenWork.set(next, work)
      return next
    },
    async markResetPending(token) {
      const work = originalTokenWork(token)
      return await issuedAck(work, () => markResetPending.call(operations, token))
    },
    async discard(token) {
      const work = originalTokenWork(token)
      return await issuedAck(work, () => discard.call(operations, token))
    },
    async release(token) {
      const work = originalTokenWork(token)
      return await issuedAck(work, () => release.call(operations, token))
    },
  }
}
