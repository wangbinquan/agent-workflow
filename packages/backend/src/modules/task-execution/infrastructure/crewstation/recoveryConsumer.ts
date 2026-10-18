// RFC-370 §9.2 V4 — consume CrewStation recovery requests for AW tasks.
//
// AW declares the two parent-level actions only: `resume-task` (paused
// container, same volume) and `rebuild-workspace` (failed container, same
// volume). Node-level retry/resume stays AW's own task command, exactly as in
// standalone; a fresh volume is AW's ordinary "rerun task".
//
// One request: claim → admission (owner task, requester account, manual
// execution policy) → the platform operation under `recovery:<requestId>` →
// wait for the platform result → AW's ordinary resume command → done. Every
// path ends in a terminal journal state; nothing is reserved or deferred.
import type { Actor } from '@/auth/actor'
import type { CrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import type {
  CrewStationRecoveryClaim,
  CrewStationRecoveryRequest,
  createCrewStationRecoveryApi,
} from '@/platform/crewstation/recovery'
import type { Logger } from '@/util/log'
import {
  TERMINAL_HOSTED_RECOVERY_STATES,
  type HostedRecoveryJournal,
  type HostedRecoveryRecord,
} from './recoveryJournal'

export const HOSTED_RECOVERY_ACTIONS = ['resume-task', 'rebuild-workspace'] as const
const SUPPORTED: ReadonlySet<string> = new Set(HOSTED_RECOVERY_ACTIONS)
/** A request the platform has not finished within this window is failed so
 * the operator sees a terminal outcome instead of an indefinite wait. */
const RECOVERY_DEADLINE_MS = 2 * 60 * 60 * 1000
const RESUMABLE_TASK_STATUSES = new Set(['interrupted', 'failed', 'canceled'])
const CLAIMS_PER_TICK = 4

export interface HostedRecoveryBusiness {
  /** The AW task owning the CS parent task, or null when AW does not own it. */
  ownerTask(businessTaskId: string): Promise<string | null>
  /** The requester's AW identity; null when the platform user has none. */
  requester(requestedBy: string): Promise<Actor | null>
  assertManualExecutionAllowed(actor: Actor, taskId: string): Promise<void>
  taskStatus(taskId: string): Promise<string | null>
  resumeTask(actor: Actor, taskId: string): Promise<void>
}

export interface HostedRecoveryConsumer {
  tick(): Promise<void>
}

type RecoveryApi = ReturnType<typeof createCrewStationRecoveryApi>

function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string' && code.length > 0 ? `${code}: ${error.message}` : error.message
  }
  return String(error)
}

function transient(error: unknown): boolean {
  if (!isCrewStationApiError(error)) return !(error instanceof Error && 'code' in error)
  return error.status >= 500 || error.status === 429 || error.status === 408
}

export function createHostedRecoveryConsumer(input: {
  readonly recovery: RecoveryApi
  readonly api: Pick<CrewStationBusinessExecution, 'getTask'>
  readonly journal: HostedRecoveryJournal
  readonly business: HostedRecoveryBusiness
  readonly log: Pick<Logger, 'info' | 'warn'>
  readonly now?: () => number
}): HostedRecoveryConsumer {
  const now = input.now ?? Date.now

  const reject = async (
    claim: CrewStationRecoveryClaim,
    request: CrewStationRecoveryRequest,
    reason: string,
  ) => {
    await input.journal.admit({ request, taskId: null, actorUserId: null })
    if (claim.request.state === 'claimed') await input.recovery.reject(claim, reason)
    await input.journal.finish(request.id, 'rejected', reason)
    input.log.info('crewstation recovery rejected', { requestId: request.id, reason })
  }

  const admit = async (
    claim: CrewStationRecoveryClaim,
  ): Promise<{ record: HostedRecoveryRecord; actor: Actor } | null> => {
    const request = claim.request
    if (!SUPPORTED.has(request.target.action)) {
      await reject(claim, request, 'recovery-action-not-supported')
      return null
    }
    const taskId = await input.business.ownerTask(request.target.taskId)
    if (taskId === null) {
      await reject(claim, request, 'recovery-task-not-owned-by-agent-workflow')
      return null
    }
    const actor = await input.business.requester(request.requestedBy)
    if (actor === null) {
      await reject(claim, request, 'recovery-requester-has-no-agent-workflow-account')
      return null
    }
    try {
      if (!actor.permissions.has('tasks:execute'))
        throw new Error('recovery-requester-cannot-execute-tasks')
      await input.business.assertManualExecutionAllowed(actor, taskId)
    } catch (error) {
      await reject(claim, request, reasonOf(error))
      return null
    }
    // A parent AW paused itself (the task waits for a person, is queued or
    // finished) is resumed by AW when it is next used; a platform resume would
    // only be paused again. A failed container is different: its volume is
    // reachable again only after a rebuild, whatever the task's status — a
    // finished task's files stay browsable on its paused parent (RFC-370
    // hosted acceptance, 2026-10-18: a done task whose container failed could
    // never show its files again because the rebuild was refused).
    const status = await input.business.taskStatus(taskId)
    if (status === null) {
      await reject(claim, request, 'recovery-task-not-found')
      return null
    }
    if (request.target.action === 'resume-task' && !RESUMABLE_TASK_STATUSES.has(status)) {
      await reject(claim, request, `recovery-task-not-resumable: ${status}`)
      return null
    }
    const record = await input.journal.admit({ request, taskId, actorUserId: actor.user.id })
    return { record, actor }
  }

  /** After the platform operation succeeded and the container is running,
   * AW resumes the task with its ordinary command (rolling interrupted or
   * failed nodes back to their pre-run snapshots, as standalone does). A task
   * that is not resumable (finished, running, waiting) is left as it is: the
   * rebuilt container serves it, and AW pauses it again once idle. */
  const project = async (record: HostedRecoveryRecord): Promise<void> => {
    const current = await input.recovery.read(record.requestId)
    if (current.state === 'failed' || current.state === 'rejected') {
      await input.journal.finish(
        record.requestId,
        'failed',
        current.reason ?? 'platform-recovery-failed',
      )
      return
    }
    if (current.state !== 'succeeded') return
    const parent = await input.api.getTask(record.businessTaskId)
    if (parent.state !== 'running') return
    const taskId = record.taskId!
    const actor = await input.business.requester(record.request.requestedBy)
    if (actor === null) {
      await input.journal.finish(record.requestId, 'failed', 'recovery-requester-removed')
      return
    }
    const status = await input.business.taskStatus(taskId)
    if (status !== null && RESUMABLE_TASK_STATUSES.has(status))
      await input.business.resumeTask(actor, taskId)
    await input.journal.finish(record.requestId, 'succeeded')
    input.log.info('crewstation recovery completed', {
      requestId: record.requestId,
      taskId,
      resumed: status !== null && RESUMABLE_TASK_STATUSES.has(status),
    })
  }

  const execute = async (claim: CrewStationRecoveryClaim, record: HostedRecoveryRecord) => {
    const receipt = await input.recovery.execute(claim)
    await input.journal.executing(record.requestId, receipt)
    await project({ ...record, state: 'executing', receipt })
  }

  const guarded = async (record: HostedRecoveryRecord, work: () => Promise<void>) => {
    try {
      await work()
    } catch (error) {
      if (transient(error) && now() - record.createdAt < RECOVERY_DEADLINE_MS) {
        input.log.warn('crewstation recovery deferred', {
          requestId: record.requestId,
          reason: reasonOf(error),
        })
        return
      }
      await input.journal.finish(record.requestId, 'failed', reasonOf(error))
      input.log.warn('crewstation recovery failed', {
        requestId: record.requestId,
        reason: reasonOf(error),
      })
    }
  }

  return {
    async tick() {
      for (const record of await input.journal.active()) {
        if (now() - record.createdAt >= RECOVERY_DEADLINE_MS) {
          await input.journal.finish(record.requestId, 'failed', 'recovery-timed-out')
          continue
        }
        // An admitted request whose claim expired is offered again by the
        // platform and continues through the claim loop below.
        if (record.state === 'executing') await guarded(record, () => project(record))
      }
      for (let index = 0; index < CLAIMS_PER_TICK; index += 1) {
        const claim = await input.recovery.claim()
        if (claim === null) return
        const existing = await input.journal.get(claim.request.id)
        if (existing !== null && TERMINAL_HOSTED_RECOVERY_STATES.includes(existing.state)) {
          if (claim.request.state === 'claimed')
            await input.recovery
              .reject(claim, existing.reason ?? 'recovery-already-processed')
              .catch(() => undefined)
          continue
        }
        const admitted = await admit(claim).catch(async (error: unknown) => {
          await input.journal
            .admit({ request: claim.request, taskId: null, actorUserId: null })
            .then((record) => input.journal.finish(record.requestId, 'failed', reasonOf(error)))
          return null
        })
        if (admitted === null) continue
        await guarded(admitted.record, () => execute(claim, admitted.record))
      }
    },
  }
}
