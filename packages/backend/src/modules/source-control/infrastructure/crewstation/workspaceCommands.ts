// RFC-370 §9.2 V2 — durable task-image helper commands on a hosted task volume.
//
// Source Control owns the volume, so it owns every non-node command run in it
// (workspace, Git, content and maintenance operations requested by any owner).
// Task executions (agents, script nodes) keep their own journal in
// task-execution; both observe CrewStation through the same neutral loop.
//
// Lifecycle of one command (`command:<taskId>:<operationId>`):
//   submitting → (CS receipt) running → settled
// A row left `submitting` by a previous process is `abandoned`: its caller is
// gone and nothing is resubmitted on its behalf. A caller that comes back with
// the same operation id resubmits with the original requestKey, which CS
// answers with the original subtask if it was created.
//
// An operation the parent's task image does not know runs again once, under
// its own operation id (`<id>:image-upgraded`), after the parent was upgraded
// to the release's image (§10 V21). A replay or recovery of the original id
// follows that retry.
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import {
  isParentNotRunningError,
  type BusinessResult,
  type BusinessSubtask,
  type CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import type { BusinessEnvironmentValue } from '@/platform/crewstation/nativeMaterial'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import { observeSubtask, SubtaskObservationError } from '@/platform/crewstation/subtaskStream'
import {
  parseWorkspaceHelperOutcome,
  WORKSPACE_RESULT_MAX_BYTES,
  WorkspaceCommandStoppedError,
  workspaceHelperArguments,
  workspaceHelperValue,
  workspaceResultPath,
  type WorkspaceHelper,
  type WorkspaceHelperOptions,
  type WorkspaceHelperOutcome,
} from '@/platform/crewstation/workspaceProtocol'
import { sha256Hex } from '@/util/hash'
import {
  isUnknownTaskImageOperation,
  NO_HOSTED_IMAGE_UPGRADES,
  type HostedWorkspaceImageUpgrades,
} from './workspaceImageUpgrade'

/** The daemon is stopping: the command keeps running and is reconciled by
 * the next execution-authority holder. */
export class WorkspaceCommandDetachedError extends Error {
  constructor(readonly executionId: string) {
    super(`workspace command ${executionId} detached for the next owner`)
    this.name = 'WorkspaceCommandDetachedError'
  }
}

/** The platform accepted neither a receipt nor a refusal; the same operation
 * id resubmits with the original requestKey. */
export class WorkspaceCommandUnknownError extends Error {
  constructor(
    readonly executionId: string,
    reason: string,
  ) {
    super(`workspace command ${executionId} outcome unknown: ${reason}`)
    this.name = 'WorkspaceCommandUnknownError'
  }
}

export interface HostedWorkspaceCommands extends WorkspaceHelper {
  /** Observe only an already-persisted operation; never start a new one. */
  recover<T>(taskId: string, operationId: string): Promise<{ value: T } | null>
  /** Volumes that still run a command started by any process. */
  hasUnsettledCommands(businessTaskId: string): Promise<boolean>
  /** Settle running commands left by a previous process and abandon the
   * never-acknowledged ones. Commands of this process are left alone. */
  reconcile(signal: AbortSignal): Promise<void>
}

interface CommandOutcome {
  readonly exitCode: number | null
  readonly reason: string
  readonly stderr: string
  readonly truncated: boolean
  readonly helper: WorkspaceHelperOutcome | null
}

type Row = PersistenceTables['hostedWorkspaceCommands']['$inferSelect']

const DEFAULT_TIMEOUT_MS = 86_400_000
const CANCEL_SUFFIX = ':cancel'
/** A parent paused again right after each resume is a platform problem. */
const MAX_PARENT_RESUMES = 3
/** A `submitting` row of this process older than this has lost its caller. */
const SUBMISSION_GRACE_MS = 60_000
/** §10 V21: the operation id of the one run after a task-image upgrade. */
const IMAGE_UPGRADE_RETRY_SUFFIX = ':image-upgraded'

function authorityHeld(fence: CrewStationMutationFence): boolean {
  try {
    fence.current()
    return true
  } catch {
    return false
  }
}

function leaseLost(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'execution-standby'
}

function digest(value: string): string {
  return sha256Hex(value)
}

function relativeToVolume(path: string): string {
  return path.replace(/^\/work\/?/, '')
}

export function createHostedWorkspaceCommands(input: {
  readonly db: PersistenceDb
  readonly fence: CrewStationMutationFence
  readonly api: CrewStationBusinessExecution
  readonly workspaces: { ensure(taskId: string): Promise<{ readonly businessTaskId: string }> }
  readonly commandEnvironment?: (
    operation: string,
  ) => Readonly<Record<string, BusinessEnvironmentValue>> | undefined
  /** §10 V21: upgrades the parent's task image after a command it does not know. */
  readonly imageUpgrades?: Pick<HostedWorkspaceImageUpgrades, 'afterUnknownOperation'>
  readonly now?: () => number
}): HostedWorkspaceCommands {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const imageUpgrades = input.imageUpgrades ?? NO_HOSTED_IMAGE_UPGRADES
  const inFlight = new Set<string>()

  const fenced = async <T>(work: (tx: PersistenceDb, epoch: number) => Promise<T>) => {
    const lease = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, lease)
      return work(tx, lease.epoch)
    })
  }
  const read = async (executionId: string): Promise<Row | null> => {
    const { hostedWorkspaceCommands } = tablesOf(input.db)
    return (
      (
        await input.db
          .select()
          .from(hostedWorkspaceCommands)
          .where(eq(hostedWorkspaceCommands.executionId, executionId))
          .limit(1)
      )[0] ?? null
    )
  }
  const patch = (
    executionId: string,
    values: Partial<PersistenceTables['hostedWorkspaceCommands']['$inferInsert']>,
  ) =>
    fenced(async (tx, epoch) => {
      const { hostedWorkspaceCommands } = tablesOf(tx)
      await tx
        .update(hostedWorkspaceCommands)
        .set({ ...values, epoch, updatedAt: now() })
        .where(eq(hostedWorkspaceCommands.executionId, executionId))
    })

  const outcomeOf = (row: Row): CommandOutcome =>
    JSON.parse(row.outcomeJson ?? 'null') as CommandOutcome

  const conclude = <T>(outcome: CommandOutcome): T => {
    if (outcome.helper !== null) return workspaceHelperValue<T>(outcome.helper)
    const reason = outcome.reason.toLowerCase()
    throw new WorkspaceCommandStoppedError(
      /timeout|deadline/.test(reason)
        ? 'timeout'
        : /cancel|abort/.test(reason)
          ? 'aborted'
          : 'exited',
      outcome.exitCode,
      '',
      outcome.stderr,
      outcome.truncated,
    )
  }

  /** The helper publishes its outcome file before exiting; a missing file
   * means it never finished (killed, timed out, or crashed). */
  const readOutcome = async (
    row: Row,
    result: BusinessResult,
    timedOut: boolean,
  ): Promise<CommandOutcome> => {
    const request = JSON.parse(row.requestJson) as { readonly resultPath: string }
    let helper: WorkspaceHelperOutcome | null = null
    try {
      const chunks: Buffer[] = []
      let offset = 0
      let version: string | undefined
      for (;;) {
        const page = await input.api.readFile(row.businessTaskId, {
          path: relativeToVolume(request.resultPath),
          offset,
          limit: WORKSPACE_RESULT_MAX_BYTES,
          ...(version === undefined ? {} : { version }),
        })
        version ??= page.version
        if (page.size > WORKSPACE_RESULT_MAX_BYTES)
          throw new Error('hosted-command-result-too-large')
        const bytes = Buffer.from(page.contentBase64, 'base64')
        chunks.push(bytes)
        offset += bytes.length
        if (page.nextOffset === null || bytes.length === 0) break
      }
      helper = parseWorkspaceHelperOutcome(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      if (!(isCrewStationApiError(error) && error.status === 404)) throw error
    }
    return {
      exitCode: result.exitCode,
      // A command this observer stopped at its deadline reports the timeout,
      // not the platform's cancellation of it.
      reason: timedOut && helper === null ? 'timeout' : result.reason,
      stderr: result.stderr,
      truncated: result.truncated,
      helper,
    }
  }

  /** `detachOnAbort`: the observer is not the command's caller (background
   * reconciliation), so stopping it must never stop the remote command. */
  const observe = async <T>(
    initial: Row,
    options: WorkspaceHelperOptions & { readonly detachOnAbort?: boolean },
  ): Promise<T> => {
    const executionId = initial.executionId
    if (inFlight.has(executionId)) throw new Error('hosted-command-observer-already-running')
    inFlight.add(executionId)
    let row = initial
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      if (row.subtaskId === null) {
        let receipt: BusinessSubtask
        const request = JSON.parse(row.requestJson) as {
          readonly argv: readonly string[]
          readonly env?: Readonly<Record<string, BusinessEnvironmentValue>>
          readonly timeoutSeconds: number
        }
        let resumed = 0
        for (;;) {
          try {
            receipt = await input.api.submitSubtask(row.businessTaskId, {
              kind: 'command',
              requestKey: row.requestKey,
              fence: input.fence.current(),
              name: `aw ${row.operation}`,
              cwd: '/work',
              argv: request.argv,
              ...(request.env === undefined ? {} : { env: request.env }),
              timeoutSeconds: request.timeoutSeconds,
            })
            break
          } catch (error) {
            // Paused between the readiness check and this submit (§9.2 V3):
            // resume the parent and repeat the same idempotent request.
            if (isParentNotRunningError(error) && resumed < MAX_PARENT_RESUMES) {
              resumed += 1
              await input.workspaces.ensure(row.taskId)
              continue
            }
            if (isCrewStationApiError(error) && error.status >= 400 && error.status < 500) {
              await patch(executionId, {
                state: 'settled',
                outcomeJson: JSON.stringify({
                  exitCode: null,
                  reason: `rejected: ${error.message}`,
                  stderr: error.message,
                  truncated: false,
                  helper: null,
                } satisfies CommandOutcome),
              })
              throw error
            }
            throw new WorkspaceCommandUnknownError(
              executionId,
              error instanceof Error ? error.message : String(error),
            )
          }
        }
        await patch(executionId, {
          subtaskId: receipt.id,
          attempt: receipt.attempt,
          state: 'running',
        })
        row = { ...row, subtaskId: receipt.id, attempt: receipt.attempt, state: 'running' }
      }
      await options.onStarted?.({
        executionId,
        businessTaskId: row.businessTaskId,
        subtaskId: row.subtaskId!,
        attempt: row.attempt!,
      })
      const stopped = new AbortController()
      const wake = () => stopped.abort()
      options.signal?.addEventListener('abort', wake, { once: true })
      if (options.signal?.aborted) wake()
      const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let timedOut = false
      const remaining = row.createdAt + timeoutMs - now()
      deadline = setTimeout(
        () => {
          timedOut = true
          wake()
        },
        Math.max(0, remaining),
      )
      let cancelled = false
      let cursor = row.lastCursor
      for (;;) {
        // After a cancel the command still ends only with its platform
        // result; only process exit interrupts that final observation.
        const end = await observeSubtask({
          api: input.api,
          target: {
            businessTaskId: row.businessTaskId,
            subtaskId: row.subtaskId!,
            attempt: row.attempt!,
          },
          after: cursor,
          signal: cancelled ? new AbortController().signal : stopped.signal,
          active: () => authorityHeld(input.fence),
          async onEvent(event) {
            if (event.type === 'output')
              await options.onOutput?.(event.data.stream, event.data.text)
            cursor = event.cursor
            await patch(executionId, { lastCursor: cursor })
          },
        })
        if (end.kind === 'result') {
          const outcome = await readOutcome(row, end.result, timedOut)
          await patch(executionId, { state: 'settled', outcomeJson: JSON.stringify(outcome) })
          return conclude<T>(outcome)
        }
        if (
          !authorityHeld(input.fence) ||
          (!timedOut &&
            (options.detachOnAbort === true ||
              options.signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON))
        )
          throw new WorkspaceCommandDetachedError(executionId)
        if (cancelled) throw new WorkspaceCommandDetachedError(executionId)
        // A caller abort or the deadline stops the remote command. A refused
        // or failed cancel is left to the observation: the platform enforces
        // the same deadline and reports the command's actual outcome.
        await input.api
          .cancelSubtask(row.businessTaskId, row.subtaskId!, {
            requestKey: `${row.requestKey}${CANCEL_SUFFIX}`,
            expectedAttempt: row.attempt!,
            fence: input.fence.current(),
          })
          .catch(() => undefined)
        cancelled = true
      }
    } catch (error) {
      if (
        !(error instanceof WorkspaceCommandDetachedError) &&
        (leaseLost(error) || !authorityHeld(input.fence))
      )
        throw new WorkspaceCommandDetachedError(executionId)
      // History gone (410), subtask gone or refused (4xx), or an identity
      // mismatch: the outcome can never be observed, so the command settles
      // as stopped instead of being reconciled forever.
      if (error instanceof SubtaskObservationError) {
        const outcome: CommandOutcome = {
          exitCode: null,
          reason: `observation-${error.failure}`,
          stderr: error.message,
          truncated: true,
          helper: null,
        }
        await patch(executionId, { state: 'settled', outcomeJson: JSON.stringify(outcome) })
        return conclude<T>(outcome)
      }
      throw error
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      inFlight.delete(executionId)
    }
  }

  const callOnce = async <T>(
    taskId: string,
    operation: string,
    value: unknown,
    operationId: string,
    options: WorkspaceHelperOptions,
  ): Promise<T> => {
    const workspace = await input.workspaces.ensure(taskId)
    const executionId = `command:${taskId}:${operationId}`
    const resultPath = workspaceResultPath(digest(executionId))
    const argv = workspaceHelperArguments(operation, value, resultPath)
    const existing = await read(executionId)
    if (existing !== null) {
      const frozen = JSON.parse(existing.requestJson) as { argv: string[] }
      if (
        existing.businessTaskId !== workspace.businessTaskId ||
        existing.operation !== operation ||
        JSON.stringify(frozen.argv) !== JSON.stringify(argv)
      )
        throw new Error('hosted-command-replay-mismatch')
      if (existing.state === 'settled') return conclude<T>(outcomeOf(existing))
      if (existing.state === 'abandoned') {
        await patch(executionId, { state: 'submitting' })
        return observe<T>({ ...existing, state: 'submitting' }, options)
      }
      // The original persisted Secret references win over a later
      // deployment configuration change during a cold retry.
      return observe<T>(existing, options)
    }
    const environment = input.commandEnvironment?.(operation)
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const requestJson = JSON.stringify({
      argv,
      resultPath,
      ...(environment === undefined ? {} : { env: environment }),
      timeoutSeconds: Math.min(86_400, Math.max(1, Math.ceil(timeoutMs / 1_000))),
    })
    await fenced(async (tx, epoch) => {
      const { hostedWorkspaceCommands } = tablesOf(tx)
      await tx
        .insert(hostedWorkspaceCommands)
        .values({
          executionId,
          taskId,
          businessTaskId: workspace.businessTaskId,
          operation,
          requestKey: `aw-command:${digest(executionId)}`,
          requestJson,
          state: 'submitting',
          epoch,
          createdAt: now(),
          updatedAt: now(),
        })
        .onConflictDoNothing()
    })
    const inserted = await read(executionId)
    if (inserted === null) throw new Error('hosted-command-intent-missing')
    return observe<T>(inserted, options)
  }
  const retryOf = (operationId: string) => `${operationId}${IMAGE_UPGRADE_RETRY_SUFFIX}`
  /** The command runs again when its parent's image did not know the
   * operation and was upgraded just now, or when that run already exists (a
   * replay of the original id). */
  const rerunsAfterImageUpgrade = async (taskId: string, operationId: string, error: unknown) =>
    isUnknownTaskImageOperation(error) &&
    ((await read(`command:${taskId}:${retryOf(operationId)}`)) !== null ||
      (await imageUpgrades.afterUnknownOperation(taskId, error)))

  return {
    async call<T>(
      taskId: string,
      operation: string,
      value: unknown,
      options: WorkspaceHelperOptions = {},
    ) {
      const operationId = options.operationId ?? ulid()
      try {
        return await callOnce<T>(taskId, operation, value, operationId, options)
      } catch (error) {
        if (options.signal?.aborted || !(await rerunsAfterImageUpgrade(taskId, operationId, error)))
          throw error
        return callOnce<T>(taskId, operation, value, retryOf(operationId), options)
      }
    },
    async recover<T>(taskId: string, operationId: string) {
      // A command that ran again after an image upgrade is recovered as that run.
      const row =
        (await read(`command:${taskId}:${retryOf(operationId)}`)) ??
        (await read(`command:${taskId}:${operationId}`))
      if (row === null || row.state === 'abandoned') return null
      if (row.state === 'settled') return { value: conclude<T>(outcomeOf(row)) }
      return { value: await observe<T>(row, {}) }
    },
    async hasUnsettledCommands(businessTaskId) {
      const { hostedWorkspaceCommands } = tablesOf(input.db)
      const rows = await input.db
        .select({ executionId: hostedWorkspaceCommands.executionId })
        .from(hostedWorkspaceCommands)
        .where(
          and(
            eq(hostedWorkspaceCommands.businessTaskId, businessTaskId),
            inArray(hostedWorkspaceCommands.state, ['submitting', 'running']),
          ),
        )
        .limit(1)
      return rows.length > 0
    },
    async reconcile(signal) {
      const lease = input.fence.current()
      const { hostedWorkspaceCommands } = tablesOf(input.db)
      // Never-acknowledged commands whose caller is gone (an earlier owner,
      // or a caller of this process that gave up on an unknown submission).
      const orphans = (
        await input.db
          .select({
            executionId: hostedWorkspaceCommands.executionId,
            epoch: hostedWorkspaceCommands.epoch,
            updatedAt: hostedWorkspaceCommands.updatedAt,
          })
          .from(hostedWorkspaceCommands)
          .where(eq(hostedWorkspaceCommands.state, 'submitting'))
      ).filter(
        (row) =>
          !inFlight.has(row.executionId) &&
          (row.epoch < lease.epoch || row.updatedAt < now() - SUBMISSION_GRACE_MS),
      )
      if (orphans.length > 0)
        await fenced(async (tx, epoch) => {
          const { hostedWorkspaceCommands } = tablesOf(tx)
          await tx
            .update(hostedWorkspaceCommands)
            .set({ state: 'abandoned', epoch, updatedAt: now() })
            .where(
              and(
                eq(hostedWorkspaceCommands.state, 'submitting'),
                inArray(
                  hostedWorkspaceCommands.executionId,
                  orphans.map((row) => row.executionId),
                ),
              ),
            )
        })
      // Acknowledged commands nobody observes any more are settled from
      // their platform result (whoever started them).
      const running = await input.db
        .select()
        .from(hostedWorkspaceCommands)
        .where(eq(hostedWorkspaceCommands.state, 'running'))
      await Promise.all(
        running.map(async (row) => {
          if (signal.aborted || inFlight.has(row.executionId)) return
          try {
            await observe(row, { signal, detachOnAbort: true })
          } catch {
            // The outcome (success or failure) is recorded on the row; a
            // detached or unknown observation is retried on the next pass.
          }
        }),
      )
    },
  }
}
