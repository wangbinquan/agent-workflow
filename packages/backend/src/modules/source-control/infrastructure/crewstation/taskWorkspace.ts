// RFC-370 §9.2 V3 — one persistent CrewStation parent (its `/work` volume) per
// volume owner. Source Control owns the parent; task execution owns subtasks.
//
// Lifecycle of a parent as seen from here:
//   allocate (first ensure) → running → paused (idle, by the lifecycle
//   reconciler) → resumed (next ensure / open) → … → closed (owner deleted).
// Every use goes through `ensure` (may allocate) or `open` (never allocates);
// both resume a paused parent and wait until the platform reports it running
// with a ready volume. `find` / `list` are registration reads without platform
// I/O and must never wake a volume.
import { and, eq, inArray, ne } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { hostedTaskWorkspaces } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  BusinessTask,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import { DomainError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import { hostedWorkspaceOwnerKind } from './workspaceOwnership'

export interface HostedTaskWorkspace {
  readonly taskId: string
  readonly businessTaskId: string
}

/** A registered parent as the platform reports it, observed without waking it:
 * `running` (usable now), `dormant` (the volume persists but the parent is
 * paused, pausing, being resumed or failed), `gone` (closed and released) or
 * `absent` (no usable registration). */
export type HostedWorkspaceProbe = 'absent' | 'running' | 'dormant' | 'gone'

export interface HostedTaskWorkspaces {
  /** First use allocates the parent; every use waits until it runs (a paused
   * parent is resumed first). Never returns a parent that is closing. */
  ensure(taskId: string): Promise<HostedTaskWorkspace>
  /** An allocated parent made ready for use (resumed when paused). Null when
   * none was ever allocated or it is closing. Never allocates. */
  open(taskId: string): Promise<HostedTaskWorkspace | null>
  /** Registration lookup without platform I/O; never wakes a volume. */
  find(taskId: string): Promise<HostedTaskWorkspace | null>
  /** Read-only platform observation of a registered parent. */
  probe(taskId: string): Promise<HostedWorkspaceProbe>
  /** Registered parents whose volume may still exist. */
  list(): Promise<readonly HostedTaskWorkspace[]>
  /** Registered parents the platform currently runs. Read-only: a paused
   * parent is left paused (maintenance sweeps must not wake volumes). */
  listRunning(): Promise<readonly HostedTaskWorkspace[]>
  /** End the parent once its owner is deleted: an `archive-and-delete` parent
   * is finalized (its volume deleted), a `legacy` one closed. CS is asked
   * first; `closing` is recorded only after CS accepted. True once the
   * platform reports the parent released, false while that is still pending. */
  close(taskId: string): Promise<boolean>
  /** A scratch owner's parent created under another release, due to be
   * replaced (see `hostedWorkspaceOwnerKind`). Registration read only. */
  superseded(taskId: string): Promise<boolean>
}

const READY_TIMEOUT_MS = 300_000
const POLL_MS = 2_000
/** Platform states from which the parent becomes ready without our action. */
const TRANSITIONAL = new Set(['admitting', 'creating', 'running', 'pausing'])
/** Platform states whose volume is being or has been released for good. */
const CLOSED = new Set(['finalizing', 'closing', 'closed'])
/** States still provisioning resources, where `unknown` resources are expected. */
const PROVISIONING = new Set(['admitting', 'creating'])
/** CS request keys are at most 128 bytes. */
const REQUEST_KEY_MAX = 128
/** AW keeps every task result in its own database and object space; a parent's
 * volume holds only a working copy, so finalizing archives nothing. */
export const HOSTED_NO_ARTIFACTS_REASON =
  'agent-workflow keeps task results in its own records; the workspace volume holds only a working copy'

type Row = typeof hostedTaskWorkspaces.$inferSelect

/** RFC-370 §9.2 V4 — the parent's container or volume is unusable (failed,
 * or its resources are failed / unobservable after provisioning). The node
 * fails with this explicit reason; the platform's recovery page can rebuild
 * the workspace on its original volume, after which the task is resumed. */
export class HostedWorkspaceUnavailableError extends DomainError {
  constructor(businessTaskId: string, task: BusinessTask) {
    const state =
      task.state === 'failed' || task.resourceState === 'failed'
        ? 'failed'
        : `${task.state} with ${task.resourceState ?? 'unknown'} resources`
    super(
      'hosted-workspace-unavailable',
      `The CrewStation task container is ${state} (${task.message || 'no platform message'}). ` +
        "Rebuild the workspace from CrewStation's recovery page, then resume this task.",
      503,
      {
        businessTaskId,
        state: task.state,
        resourceState: task.resourceState ?? null,
        platformMessage: task.message ?? null,
      },
    )
  }
}

/** The parent did not become ready within the provisioning wait. */
export class HostedWorkspaceProvisioningTimeoutError extends DomainError {
  constructor(businessTaskId: string, lastObserved: string) {
    super(
      'hosted-workspace-provisioning-timeout',
      `hosted-workspace-provisioning-timeout: the CrewStation task container is still ${lastObserved}`,
      504,
      { businessTaskId, lastObserved },
    )
  }
}

/** The project's concurrent task quota stayed full for the whole provisioning
 * wait. The parent request is kept: resuming the task resubmits the same
 * request key, which the platform admits once another parent pauses or closes. */
export class HostedWorkspaceQuotaExhaustedError extends DomainError {
  constructor(waitedMs: number, platformMessage: string) {
    super(
      'hosted-task-quota-exhausted',
      `The CrewStation project's concurrent task quota stayed full for ${Math.round(waitedMs / 1000)} s: ` +
        'every task slot is held by other running tasks (a finished task frees its slot once its ' +
        'container pauses). Resume this task when other tasks have finished.',
      429,
      { waitedMs, platformMessage },
    )
  }
}

/** CS reports `unknown` resources when its own observation fails; a short
 * outage is waited out, a persistent one means the container is gone. */
const UNKNOWN_RESOURCE_GRACE_MS = 60_000

const resourcesUnobserved = (task: BusinessTask) =>
  task.resourceState === 'unknown' && !PROVISIONING.has(task.state) && task.state !== 'paused'

function unavailable(task: BusinessTask, unobservedForMs: number): boolean {
  if (task.state === 'failed' || task.resourceState === 'failed') return true
  if (resourcesUnobserved(task)) return unobservedForMs >= UNKNOWN_RESOURCE_GRACE_MS
  return task.state !== 'paused' && !TRANSITIONAL.has(task.state)
}

/** Deterministic per-generation lifecycle key: a retried pause/resume/close of
 * the same generation is a lookup of the original platform operation. */
export function hostedLifecycleRequestKey(
  parentRequestKey: string,
  action: 'pause' | 'resume' | 'close' | 'finalize',
  generation: number,
): string {
  const key = `${parentRequestKey}:${action}:${generation}`
  return key.length <= REQUEST_KEY_MAX ? key : `aw-task-op:${sha256Hex(key)}`
}

/** A lifecycle refusal that only means "another lifecycle operation or a
 * concurrent caller got there first"; the next observation decides. */
export function isLifecycleRace(error: unknown): boolean {
  return isCrewStationApiError(error) && (error.status === 409 || error.status === 429)
}

export function createHostedTaskWorkspaces(input: {
  readonly db: ProviderNeutralDatabase
  readonly api: CrewStationBusinessExecution
  readonly fence: CrewStationMutationFence
  readonly installation: string
  readonly taskContractVersion: string
  /** The running release (CrewStation capabilities `releaseId`); null while
   * unknown. Scratch owners get a parent per release. */
  readonly release?: () => Promise<string | null>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly readyTimeoutMs?: number
}): HostedTaskWorkspaces {
  const session = databaseSessionFor(input.db)
  const sleep = input.sleep ?? ((ms) => Bun.sleep(ms))
  const now = input.now ?? Date.now
  const readyTimeoutMs = input.readyTimeoutMs ?? READY_TIMEOUT_MS
  // Hash the installation so request keys remain below the platform's 128
  // byte limit even when project/service names are long.
  const installation = sha256Hex(input.installation).slice(0, 20)
  /** The running release for a scratch owner's parent; null for any other owner. */
  const releaseFor = async (taskId: string) =>
    hostedWorkspaceOwnerKind(taskId) === 'scratch' && input.release !== undefined
      ? await input.release()
      : null
  const parentRequestKey = (taskId: string, release: string | null) =>
    release === null
      ? `aw-task:${installation}:${taskId}`
      : `aw-task:${installation}:${taskId}@${sha256Hex(release).slice(0, 16)}`
  const read = async (db: ProviderNeutralDatabase, taskId: string): Promise<Row | undefined> =>
    (
      await db
        .select()
        .from(hostedTaskWorkspaces)
        .where(eq(hostedTaskWorkspaces.taskId, taskId))
        .limit(1)
    )[0]
  const write = async <T>(operation: (tx: ProviderNeutralDatabase) => Promise<T>) => {
    const fence = input.fence.current()
    return session.transaction(async (tx) => {
      await input.fence.assertHeld(tx, fence)
      return operation(tx)
    })
  }
  const observe = async (businessTaskId: string): Promise<BusinessTask> => {
    const task = await input.api.getTask(businessTaskId)
    if (task.id !== businessTaskId) throw new Error('hosted-workspace-receipt-mismatch')
    return task
  }
  const resume = async (row: Row, task: BusinessTask) => {
    try {
      await input.api.resumeTask(task.id, {
        requestKey: hostedLifecycleRequestKey(row.requestKey, 'resume', task.generation),
        fence: input.fence.current(),
        expectedGeneration: task.generation,
      })
    } catch (error) {
      if (!isLifecycleRace(error)) throw error
    }
  }
  /** Wait until the parent runs with a ready volume, resuming it if paused.
   * The ready write refreshes `updatedAt`, the last-use mark the lifecycle
   * reconciler honours before pausing an idle volume. */
  const ready = async (row: Row, businessTaskId: string): Promise<HostedTaskWorkspace> => {
    const deadline = now() + readyTimeoutMs
    let last = 'unobserved'
    let unobservedSince: number | null = null
    for (;;) {
      input.fence.current()
      const task = await observe(businessTaskId)
      unobservedSince = resourcesUnobserved(task) ? (unobservedSince ?? now()) : null
      if (task.state === 'running' && task.resourceState === 'ready') {
        await write(async (tx) => {
          const current = await read(tx, row.taskId)
          if (current === undefined || current.state === 'closing' || current.state === 'closed')
            throw new Error('hosted-workspace-closed')
          await tx
            .update(hostedTaskWorkspaces)
            .set({ state: 'ready', updatedAt: now() })
            .where(eq(hostedTaskWorkspaces.taskId, row.taskId))
        })
        return { taskId: row.taskId, businessTaskId }
      }
      if (CLOSED.has(task.state)) throw new Error(`hosted-workspace-closed: ${task.state}`)
      if (unavailable(task, unobservedSince === null ? 0 : now() - unobservedSince))
        throw new HostedWorkspaceUnavailableError(businessTaskId, task)
      if (task.state === 'paused') await resume(row, task)
      last = `${task.state}/${task.resourceState ?? 'unknown'}`
      if (now() >= deadline) throw new HostedWorkspaceProvisioningTimeoutError(businessTaskId, last)
      await sleep(POLL_MS)
    }
  }
  /** Replays the persisted create intent. The platform answers a known
   * requestKey with the original parent, so a lost receipt is recovered
   * without a second volume.
   *
   * A full concurrent task quota (`429 quota_exceeded`) is a wait, not a
   * failure: the platform admits the same request key once another parent
   * pauses or closes — typically a just-finished task whose container is in
   * its pause grace, or a system scratch parent (RFC-370 hosted acceptance,
   * 2026-10-17: a task launched right after another one failed its repository
   * preparation within seconds). The wait shares the provisioning budget. */
  const allocate = async (row: Row): Promise<string> => {
    const started = now()
    let task: BusinessTask
    for (let attempt = 0; ; attempt += 1) {
      try {
        task = await input.api.createTask({
          requestKey: row.requestKey,
          fence: input.fence.current(),
          taskContractVersion: input.taskContractVersion,
          labels: { 'aw-task-id': row.taskId, 'aw-installation': input.installation },
        })
        break
      } catch (error) {
        if (
          !(isCrewStationApiError(error) && error.status === 429 && error.code === 'quota_exceeded')
        )
          throw error
        if (now() - started >= readyTimeoutMs)
          throw new HostedWorkspaceQuotaExhaustedError(now() - started, error.message)
        await sleep(Math.min(POLL_MS * 2 ** attempt, 30_000))
      }
    }
    await write(async (tx) => {
      const current = await read(tx, row.taskId)
      if (
        current === undefined ||
        (current.businessTaskId !== null && current.businessTaskId !== task.id)
      ) {
        throw new Error('hosted-workspace-receipt-mismatch')
      }
      await tx
        .update(hostedTaskWorkspaces)
        .set({ businessTaskId: task.id, updatedAt: now() })
        .where(eq(hostedTaskWorkspaces.taskId, row.taskId))
    })
    return task.id
  }
  const registered = (row: Row | undefined): HostedTaskWorkspace | null =>
    row === undefined ||
    row.businessTaskId === null ||
    row.state === 'closing' ||
    row.state === 'closed'
      ? null
      : { taskId: row.taskId, businessTaskId: row.businessTaskId }
  const list = async (): Promise<readonly HostedTaskWorkspace[]> => {
    const rows = await input.db
      .select()
      .from(hostedTaskWorkspaces)
      .where(inArray(hostedTaskWorkspaces.state, ['creating', 'ready']))
    return rows.flatMap((row) => {
      const workspace = registered(row)
      return workspace === null ? [] : [workspace]
    })
  }
  const probe = async (workspace: HostedTaskWorkspace | null): Promise<HostedWorkspaceProbe> => {
    if (workspace === null) return 'absent'
    const task = await observe(workspace.businessTaskId)
    if (task.state === 'running' && task.resourceState === 'ready') return 'running'
    // A closing parent is being released by the platform: nothing in it is usable.
    if (task.state === 'closed' || task.state === 'closing') return 'gone'
    return 'dormant'
  }

  const close = async (taskId: string): Promise<boolean> => {
    const row = await read(input.db, taskId)
    if (row === undefined || row.state === 'closed') return true
    const businessTaskId = row.businessTaskId ?? (await allocate(row))
    const task = await observe(businessTaskId)
    if (!CLOSED.has(task.state)) {
      try {
        // A `legacy` parent (created before AW chose its completion policy)
        // keeps the old lifecycle: CrewStation refuses to finalize it, and
        // closing it retains the volume for an administrator to reclaim.
        if (task.completionPolicy === 'archive-and-delete')
          await input.api.finalizeTask(task.id, {
            requestKey: hostedLifecycleRequestKey(row.requestKey, 'finalize', task.generation),
            fence: input.fence.current(),
            expectedGeneration: task.generation,
            outcome: 'succeeded',
            archive: { noArtifactsReason: HOSTED_NO_ARTIFACTS_REASON },
          })
        else
          await input.api.closeTask(task.id, {
            requestKey: hostedLifecycleRequestKey(row.requestKey, 'close', task.generation),
            fence: input.fence.current(),
            expectedGeneration: task.generation,
          })
      } catch (error) {
        // A pause/resume still in flight or a subtask still settling: the
        // deletion step (or the lifecycle reconciler) retries.
        if (isLifecycleRace(error)) return false
        throw error
      }
    }
    // CS accepted the close: from here on the parent is never reused.
    await write(async (tx) => {
      await tx
        .update(hostedTaskWorkspaces)
        .set({ state: 'closing', updatedAt: now() })
        .where(
          and(eq(hostedTaskWorkspaces.taskId, taskId), ne(hostedTaskWorkspaces.state, 'closed')),
        )
    })
    // Acknowledged close is not physical release. The owner retries until
    // the platform confirms the resources actually disappeared.
    const released = await observe(task.id)
    if (released.state !== 'closed' || released.resourceState !== 'released') return false
    await write(async (tx) => {
      await tx
        .update(hostedTaskWorkspaces)
        .set({ state: 'closed', updatedAt: now() })
        .where(eq(hostedTaskWorkspaces.taskId, taskId))
    })
    return true
  }
  /** A scratch parent belongs to the running release when its key is that
   * release's key, or a later replacement of it under the same release. */
  const isCurrent = (row: Row, requestKey: string) =>
    row.requestKey === requestKey || row.requestKey.startsWith(`${requestKey}~`)
  /** Close a scratch owner's parent and re-arm the owner with a new parent of
   * the running release. Nothing but invocation scratch is lost. */
  const replace = async (row: Row, requestKey: string): Promise<Row> => {
    const deadline = now() + readyTimeoutMs
    while (!(await close(row.taskId))) {
      if (now() >= deadline)
        throw new HostedWorkspaceProvisioningTimeoutError(
          row.businessTaskId ?? row.taskId,
          'closing',
        )
      await sleep(POLL_MS)
    }
    // The platform answers a known request key with the original parent, so a
    // replacement under the same release needs a key of its own; deriving it
    // from the replaced key keeps a retried replacement on the same parent.
    const key = isCurrent(row, requestKey)
      ? `${requestKey}~${sha256Hex(row.requestKey).slice(0, 12)}`
      : requestKey
    return write(async (tx) => {
      await tx
        .update(hostedTaskWorkspaces)
        .set({ requestKey: key, businessTaskId: null, state: 'creating', updatedAt: now() })
        .where(
          and(
            eq(hostedTaskWorkspaces.taskId, row.taskId),
            eq(hostedTaskWorkspaces.state, 'closed'),
          ),
        )
      return (await read(tx, row.taskId))!
    })
  }

  return {
    async ensure(taskId) {
      const release = await releaseFor(taskId)
      const requestKey = parentRequestKey(taskId, release)
      // Persist the parent request key before network I/O so concurrent
      // preparations and a lost create response resolve to the same volume.
      let row = await write(async (tx) => {
        await tx
          .insert(hostedTaskWorkspaces)
          .values({ taskId, requestKey, state: 'creating', createdAt: now(), updatedAt: now() })
          .onConflictDoNothing()
        return (await read(tx, taskId))!
      })
      if (release === null) {
        if (row.state === 'closed' || row.state === 'closing')
          throw new Error('hosted-workspace-closed')
        return ready(row, row.businessTaskId ?? (await allocate(row)))
      }
      // A scratch owner. A parent of another release that still runs may serve
      // an invocation of that release and is used as it is (the lifecycle
      // reconciler replaces it once idle); any other is replaced now, and so is
      // a parent the platform closed or can no longer run.
      if (row.state === 'closing' || row.state === 'closed') row = await replace(row, requestKey)
      else if (!isCurrent(row, requestKey)) {
        const task = row.businessTaskId === null ? null : await observe(row.businessTaskId)
        if (task === null || (task.state !== 'running' && !PROVISIONING.has(task.state)))
          row = await replace(row, requestKey)
      }
      try {
        return await ready(row, row.businessTaskId ?? (await allocate(row)))
      } catch (error) {
        if (!(error instanceof HostedWorkspaceUnavailableError)) throw error
        row = await replace((await read(input.db, taskId))!, requestKey)
        return ready(row, row.businessTaskId ?? (await allocate(row)))
      }
    },
    async open(taskId) {
      const row = await read(input.db, taskId)
      const workspace = registered(row)
      return workspace === null ? null : ready(row!, workspace.businessTaskId)
    },
    async find(taskId) {
      return registered(await read(input.db, taskId))
    },
    async probe(taskId) {
      return probe(registered(await read(input.db, taskId)))
    },
    list,
    async listRunning() {
      const running: HostedTaskWorkspace[] = []
      for (const workspace of await list()) {
        try {
          if ((await probe(workspace)) === 'running') running.push(workspace)
        } catch {
          // An unobservable parent is skipped by this sweep, never woken.
        }
      }
      return running
    },
    close,
    async superseded(taskId) {
      const release = await releaseFor(taskId)
      if (release === null) return false
      const row = await read(input.db, taskId)
      return (
        row !== undefined &&
        row.state !== 'closed' &&
        !isCurrent(row, parentRequestKey(taskId, release))
      )
    },
  }
}
