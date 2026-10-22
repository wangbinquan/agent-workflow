// RFC-370 §10 V21 — durable owners' parents follow the release's task image.
//
// A CrewStation parent keeps the task image it was created with. Scratch
// owners get a parent per release instead (`HostedTaskWorkspaces.superseded`),
// but AW task volumes and durable shared owners (`development:shared`) keep
// their parent and its files, so every command a later release added stayed
// unknown to them (RFC-370 v4 acceptance, 2026-10-19). CrewStation re-pins a
// paused persistent parent to another task image version (CS RFC-043); the
// next resume starts its container on that image, with the same volume.
//
//   - Proactive: the lifecycle reconciler upgrades the paused, idle parent of
//     a shared owner whose image differs from the one the release declares
//     (capabilities `taskRuntimeImageVersionId`).
//   - On demand: after a command the parent's image does not know
//     (`…-operation-unknown`), the parent of an AW task or shared owner is
//     paused when nothing runs in it and upgraded, and the command is retried
//     once under its own operation id (`HostedWorkspaceCommands.call`). Work
//     still running in the parent is never stopped for an upgrade: the caller
//     gets a retryable `hosted-task-image-upgrade-pending`.
//
// Nothing is upgraded unless the platform reports both the capability and the
// parent's current image; only the image the release declares is requested.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  BusinessOperation,
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import { WorkspaceCommandFailedError } from '@/platform/crewstation/workspaceProtocol'
import { DomainError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import {
  hostedLifecycleRequestKey,
  isLifecycleRace,
  TERMINAL_SUBTASK_STATES,
} from './taskWorkspace'
import { hostedWorkspaceOwnerKind } from './workspaceOwnership'

const POLL_MS = 2_000
/** Re-pinning a parent whose container is gone is platform bookkeeping. */
const UPGRADE_WAIT_MS = 120_000
/** The release's image declaration changes only with the platform's capabilities. */
const DECLARATION_CACHE_MS = 60_000
/** A command that has just ended may still be settling on the platform. */
const BUSY_GRACE_MS = 10_000
/** A refused upgrade of the same image pair is not requested again before this. */
const REFUSAL_RETRY_MS = 600_000
const OPERATION_ENDED = new Set(['succeeded', 'failed', 'retryable-rejected'])
/** Refusals that hold for an image pair until an operator acts. */
const PERMANENT_REFUSALS = new Set([
  'runtime_image_mismatch',
  'runtime_image_not_allowed',
  'image_usage_unvalidated',
  'image_unavailable',
])
/** Parent states that turn into `paused` or `running` without our action. */
const SETTLING = new Set(['admitting', 'creating', 'pausing'])

/** The parent's image cannot run the operation and work still runs in it. */
export class HostedTaskImageUpgradePendingError extends DomainError {
  constructor(owner: string, currentVersionId: string, targetVersionId: string) {
    super(
      'hosted-task-image-upgrade-pending',
      "This workspace's task container runs an earlier task image that cannot run the requested " +
        'operation, and work is still running in it. Its image is upgraded to the current release ' +
        'once that work has finished; retry then.',
      503,
      { owner, currentVersionId, targetVersionId },
    )
  }
}

/** CrewStation refused or failed the upgrade; the parent keeps its image. */
export class HostedTaskImageUpgradeFailedError extends DomainError {
  constructor(
    owner: string,
    currentVersionId: string,
    targetVersionId: string,
    platformCode: string | null,
    platformMessage: string,
  ) {
    super(
      'hosted-task-image-upgrade-failed',
      "CrewStation could not upgrade this workspace's task image to the current release " +
        `(${platformCode ?? platformMessage}). The workspace keeps its earlier image, which cannot ` +
        'run the requested operation.',
      502,
      { owner, currentVersionId, targetVersionId, platformCode, platformMessage },
    )
  }
}

/** The parent did not reach the upgraded image within the wait. */
export class HostedTaskImageUpgradeTimeoutError extends DomainError {
  constructor(owner: string, lastObserved: string) {
    super(
      'hosted-task-image-upgrade-timeout',
      `hosted-task-image-upgrade-timeout: the CrewStation task container is still ${lastObserved}`,
      504,
      { owner, lastObserved },
    )
  }
}

/** The helper refused an operation its task image does not have
 * (`workspace-helper-operation-unknown: <op>`, or a sub-operation's
 * `…-operation-unknown`). */
export function isUnknownTaskImageOperation(error: unknown): boolean {
  return error instanceof WorkspaceCommandFailedError && /operation-unknown/.test(error.message)
}

export interface HostedWorkspaceImageUpgrades {
  /** Proactive: a shared owner's paused parent runs another image than the
   * release declares (and the platform did not just refuse that upgrade). */
  due(owner: string, task: BusinessTask): Promise<boolean>
  /** Upgrades that paused parent; true once the platform re-pinned it. Stops
   * waiting (false) once `signal` aborts; the platform completes it anyway. */
  upgradePaused(
    registration: { readonly taskId: string; readonly requestKey: string },
    task: BusinessTask,
    signal?: AbortSignal,
  ): Promise<boolean>
  /** On demand, after `error` from a command on `owner`'s parent: true once
   * the parent has the release's image and the command should run again. */
  afterUnknownOperation(owner: string, error: unknown): Promise<boolean>
}

export const NO_HOSTED_IMAGE_UPGRADES: HostedWorkspaceImageUpgrades = Object.freeze({
  due: async () => false,
  upgradePaused: async () => false,
  afterUnknownOperation: async () => false,
})

type Registration = { readonly taskId: string; readonly requestKey: string }

export function createHostedWorkspaceImageUpgrades(input: {
  readonly db: PersistenceDb
  readonly api: CrewStationBusinessExecution
  readonly fence: Pick<CrewStationMutationFence, 'current'>
  /** The task image version the running release declares; null when the
   * platform cannot upgrade a parent's image or the release declares none. */
  readonly releaseTaskImage: () => Promise<string | null>
  /** Volumes that still run a workspace command of this installation. */
  readonly hasUnsettledCommands: (businessTaskId: string) => Promise<boolean>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly waitMs?: number
}): HostedWorkspaceImageUpgrades {
  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms))
  const now = input.now ?? Date.now
  const waitMs = input.waitMs ?? UPGRADE_WAIT_MS
  const supported =
    input.api.upgradeRuntimeImage !== undefined && input.api.getOperation !== undefined
  let declaration: { readonly versionId: string | null; readonly readAt: number } | null = null
  /** A failed read means "not now" and is not kept. */
  const declared = async (): Promise<string | null> => {
    if (!supported) return null
    if (declaration !== null && now() - declaration.readAt < DECLARATION_CACHE_MS)
      return declaration.versionId
    try {
      declaration = { versionId: await input.releaseTaskImage(), readAt: now() }
      return declaration.versionId
    } catch {
      return null
    }
  }
  const refusals = new Map<
    string,
    {
      readonly pair: string
      readonly at: number
      readonly error: HostedTaskImageUpgradeFailedError
    }
  >()
  const refusalOf = (owner: string, current: string, target: string) => {
    const refusal = refusals.get(owner)
    return refusal !== undefined &&
      refusal.pair === `${current}>${target}` &&
      now() - refusal.at < REFUSAL_RETRY_MS
      ? refusal.error
      : null
  }
  const refuse = (
    owner: string,
    current: string,
    target: string,
    platformCode: string | null,
    platformMessage: string,
  ) => {
    const error = new HostedTaskImageUpgradeFailedError(
      owner,
      current,
      target,
      platformCode,
      platformMessage,
    )
    refusals.set(owner, { pair: `${current}>${target}`, at: now(), error })
    return error
  }
  const inFlight = new Map<string, Promise<boolean>>()

  const observe = async (businessTaskId: string): Promise<BusinessTask> => {
    const task = await input.api.getTask(businessTaskId)
    if (task.id !== businessTaskId) throw new Error('hosted-workspace-receipt-mismatch')
    return task
  }
  /** Work the platform or this installation still runs in the parent. */
  const busy = async (businessTaskId: string): Promise<boolean> =>
    (await input.hasUnsettledCommands(businessTaskId)) ||
    (await input.api.listSubtasks(businessTaskId)).some(
      (subtask) => !TERMINAL_SUBTASK_STATES.has(subtask.state),
    )
  const pause = async (row: Registration, task: BusinessTask) => {
    try {
      await input.api.pauseTask(task.id, {
        requestKey: hostedLifecycleRequestKey(row.requestKey, 'pause', task.generation),
        fence: input.fence.current(),
        expectedGeneration: task.generation,
      })
    } catch (error) {
      // A concurrent lifecycle operation, or a subtask that started meanwhile:
      // the next observation decides.
      if (!isLifecycleRace(error)) throw error
    }
  }
  /** Requests the upgrade of a paused parent and waits for its outcome.
   * `retry`: a concurrent lifecycle operation or a transient platform refusal
   * decided first. A refusal or a failed upgrade throws the platform's reason. */
  const upgrade = async (
    row: Registration,
    task: BusinessTask,
    current: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<'upgraded' | 'retry'> => {
    let operation: BusinessOperation
    try {
      // The key names the target too: the same generation may later be asked
      // for another release's image.
      operation = await input.api.upgradeRuntimeImage!(task.id, {
        requestKey: hostedLifecycleRequestKey(
          `${row.requestKey}@${sha256Hex(target).slice(0, 16)}`,
          'upgrade',
          task.generation,
        ),
        fence: input.fence.current(),
        expectedGeneration: task.generation,
        runtimeImageVersionId: target,
      })
    } catch (error) {
      if (!isCrewStationApiError(error) || error.status >= 500) throw error
      if (isLifecycleRace(error) && !PERMANENT_REFUSALS.has(error.code ?? '')) return 'retry'
      throw refuse(row.taskId, current, target, error.code ?? null, error.message)
    }
    const deadline = now() + waitMs
    while (!OPERATION_ENDED.has(operation.state)) {
      if (signal?.aborted) return 'retry'
      if (now() >= deadline)
        throw new HostedTaskImageUpgradeTimeoutError(row.taskId, `upgrading (${operation.state})`)
      await sleep(POLL_MS)
      operation = await input.api.getOperation!(task.id, operation.operationId)
    }
    if (operation.state === 'succeeded') {
      refusals.delete(row.taskId)
      return 'upgraded'
    }
    if (operation.state === 'retryable-rejected') return 'retry'
    throw refuse(
      row.taskId,
      current,
      target,
      operation.code ?? operation.message ?? null,
      operation.message ?? 'the upgrade operation failed',
    )
  }
  const upgradeOnDemand = async (owner: string): Promise<boolean> => {
    const target = await declared()
    const { hostedTaskWorkspaces } = tablesOf(input.db)
    const row = (
      await input.db
        .select({
          taskId: hostedTaskWorkspaces.taskId,
          requestKey: hostedTaskWorkspaces.requestKey,
          businessTaskId: hostedTaskWorkspaces.businessTaskId,
          state: hostedTaskWorkspaces.state,
        })
        .from(hostedTaskWorkspaces)
        .where(eq(hostedTaskWorkspaces.taskId, owner))
        .limit(1)
    )[0]
    if (
      target === null ||
      row === undefined ||
      row.businessTaskId === null ||
      row.state === 'closing' ||
      row.state === 'closed'
    )
      return false
    const businessTaskId = row.businessTaskId
    let task = await observe(businessTaskId)
    const current = task.runtimeImage?.versionId
    // The command ran on the image the release declares: an upgrade cannot help.
    if (current === undefined || current === target) return false
    const remembered = refusalOf(owner, current, target)
    if (remembered !== null) throw remembered
    const started = now()
    for (;;) {
      if (task.runtimeImage?.versionId === target) return true
      if (task.state === 'paused') {
        if ((await upgrade(row, task, current, target)) === 'upgraded') return true
      } else if (task.state === 'running') {
        if (!(await busy(businessTaskId))) await pause(row, task)
        else if (now() - started >= BUSY_GRACE_MS)
          throw new HostedTaskImageUpgradePendingError(owner, current, target)
      } else if (!SETTLING.has(task.state)) {
        // Closed, failed or being released: the original error stands.
        return false
      }
      if (now() - started >= waitMs)
        throw new HostedTaskImageUpgradeTimeoutError(
          owner,
          `${task.state}/${task.resourceState ?? 'unknown'}`,
        )
      await sleep(POLL_MS)
      task = await observe(businessTaskId)
    }
  }

  return {
    async due(owner, task) {
      if (hostedWorkspaceOwnerKind(owner) !== 'shared' || task.state !== 'paused') return false
      const current = task.runtimeImage?.versionId
      const target = await declared()
      return (
        current !== undefined &&
        target !== null &&
        current !== target &&
        refusalOf(owner, current, target) === null
      )
    },
    async upgradePaused(registration, task, signal) {
      const current = task.runtimeImage?.versionId
      const target = await declared()
      if (task.state !== 'paused' || current === undefined || target === null || current === target)
        return false
      return (await upgrade(registration, task, current, target, signal)) === 'upgraded'
    },
    async afterUnknownOperation(owner, error) {
      // A scratch owner's parent is replaced per release instead.
      if (!isUnknownTaskImageOperation(error) || hostedWorkspaceOwnerKind(owner) === 'scratch')
        return false
      // Concurrent commands of one owner share one upgrade.
      const running = inFlight.get(owner)
      if (running !== undefined) return running
      const attempt = upgradeOnDemand(owner).finally(() => {
        inFlight.delete(owner)
      })
      inFlight.set(owner, attempt)
      return attempt
    },
  }
}
