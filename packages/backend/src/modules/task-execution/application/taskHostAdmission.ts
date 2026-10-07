import type { OwnershipToken } from '../domain/ownership'
import { assertOwnershipToken, ownershipTokenKey } from '../domain/ownership'
import type { TaskHostNewWorkAdmission, TaskHostStopReason } from './ports/taskHostAdmission'
import { assertTaskHostWriteCapture, type TaskHostWriteCapture } from './taskHostWriteCapture'

declare const taskHostAdmissionAttemptBrand: unique symbol
declare const taskHostAdmittedWorkBrand: unique symbol

export interface TaskHostAdmissionAttempt {
  readonly [taskHostAdmissionAttemptBrand]: true
}

export interface TaskHostAdmittedWork {
  readonly [taskHostAdmittedWorkBrand]: true
}

interface OriginalTaskHostWork {
  readonly capture: TaskHostWriteCapture
  readonly stopped: Promise<TaskHostStopReason>
  readonly receiver: object
  readonly complete: () => void
  readonly completed: Promise<void>
  readonly acknowledge: () => void
  finished: boolean
}

type OriginalTaskHostAttempt =
  | { readonly kind: 'admitted'; readonly work: TaskHostAdmittedWork }
  | { readonly kind: 'unavailable'; readonly error: Error }

const attempts = new WeakMap<TaskHostAdmissionAttempt, OriginalTaskHostAttempt>()
const works = new WeakMap<TaskHostAdmittedWork, OriginalTaskHostWork>()
const tokenWork = new WeakMap<OwnershipToken, TaskHostAdmittedWork>()

/** Capture once, synchronously after the original claim permit and before SQL awaits. */
export function captureTaskHostAdmission(port: TaskHostNewWorkAdmission): TaskHostAdmissionAttempt {
  const acquire = port?.acquire
  if (typeof acquire !== 'function') throw new Error('task-host-admission-incomplete')
  const result = acquire.call(port)
  const attempt = Object.freeze({}) as TaskHostAdmissionAttempt
  if (result.kind === 'unavailable') {
    attempts.set(attempt, {
      kind: 'unavailable',
      error: new Error(`task-host-execution-unavailable: ${result.reason}`),
    })
    return attempt
  }
  const lease = result.lease
  const complete = lease?.complete
  if (typeof complete !== 'function' || lease.stopped === undefined) {
    throw new Error('task-host-admission-incomplete')
  }
  assertTaskHostWriteCapture(lease.capture)
  let acknowledge!: () => void
  const completed = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const work = Object.freeze({}) as TaskHostAdmittedWork
  works.set(work, {
    capture: lease.capture,
    stopped: lease.stopped,
    receiver: lease,
    complete,
    completed,
    acknowledge,
    finished: false,
  })
  attempts.set(attempt, { kind: 'admitted', work })
  return attempt
}

export function taskHostAdmissionResult(
  attempt: TaskHostAdmissionAttempt,
): OriginalTaskHostAttempt {
  const original = attempts.get(attempt)
  if (original === undefined) throw new Error('task-host-admission-unavailable')
  return original
}

function originalWork(work: TaskHostAdmittedWork): OriginalTaskHostWork {
  const original = works.get(work)
  if (original === undefined) throw new Error('task-host-admitted-work-unavailable')
  return original
}

export function taskHostWorkCapture(work: TaskHostAdmittedWork): TaskHostWriteCapture {
  return originalWork(work).capture
}

export function taskHostWorkStopped(work: TaskHostAdmittedWork): Promise<TaskHostStopReason> {
  return originalWork(work).stopped
}

export function taskHostWorkCompleted(work: TaskHostAdmittedWork): Promise<void> {
  return originalWork(work).completed
}

export function completeTaskHostWork(work: TaskHostAdmittedWork): void {
  const original = originalWork(work)
  if (original.finished) return
  original.complete.call(original.receiver)
  original.finished = true
  original.acknowledge()
}

export function associateTaskHostWork(token: OwnershipToken, work: TaskHostAdmittedWork): void {
  assertOwnershipToken(token)
  originalWork(work)
  const previous = tokenWork.get(token)
  if (previous !== undefined && previous !== work) {
    throw new Error('task-host-admitted-work-binding-mismatch')
  }
  tokenWork.set(token, work)
}

export function taskHostWorkForToken(token: OwnershipToken): TaskHostAdmittedWork | undefined {
  assertOwnershipToken(token)
  return tokenWork.get(token)
}

export function inheritTaskHostWork(original: OwnershipToken, refreshed: OwnershipToken): void {
  assertOwnershipToken(original)
  assertOwnershipToken(refreshed)
  if (ownershipTokenKey(original) !== ownershipTokenKey(refreshed)) {
    throw new Error('task-host-admitted-work-binding-mismatch')
  }
  const work = tokenWork.get(original)
  if (work !== undefined) associateTaskHostWork(refreshed, work)
}
