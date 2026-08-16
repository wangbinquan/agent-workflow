// RFC-304 §3.1 — turning a verified webhook delivery into code-round tasks.
//
// The last link: a delivery arrives, the matrix says which capabilities this
// repository has switched on, and each woken cell gets its own round.
//
// Deliberately NOT routed through the workflow trigger table. A trigger is
// something a person wrote for one workflow; a cell is "this repo has MR review
// turned on". Sending capabilities through triggers would make every team
// hand-write the same event list and get it subtly different — and the platform
// could never change the set without editing everybody's rows.
//
// ## Why one task per cell rather than one per delivery
//
// `mr-review` and `mr-monitor` on the same MR are two work items (design §2.1),
// with separate ledgers and separate lifecycles. Sharing a task would make one
// capability's failure settle the other's round.

import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { repoCapabilityConfig } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { cellsWokenBy, type WakeableCell } from '@/modules/code-capability/domain/capabilityWake'
import { startCodeRoundTask } from '@/services/codeRoundLaunch'
import { resolveMonitorScripts } from '@/services/codeCapabilityScripts'
import {
  closeMonitorItem,
  runMonitorWake,
  type MonitorWakeOutcome,
} from '@/modules/code-capability/application/monitorLoop'
import {
  attachRoundTask,
  closeWorkItem,
  ensureWorkItem,
  openRound,
  recordObservation,
  type WorkItemIdentity,
} from '@/modules/code-capability/infrastructure/sqliteMonitorStore'
import { claimTerminalMr } from '@/modules/code-capability/application/producedMrIndex'
import type { StartTaskDeps } from '@/services/task'
import type { TriggerContext } from '@agent-workflow/shared'

/**
 * The capability that runs a LOOP rather than a fixed sequence.
 *
 * Singled out here because it is dispatched differently: every other capability
 * is "this event means run this sequence", while the monitor decides what — if
 * anything — the event means, and most of the time the answer is nothing.
 */
const MONITOR_CAPABILITY = 'mr-monitor'

/**
 * Events that END a merge request's life (T40).
 *
 * A terminal event closes the work items rather than waking them: there is no
 * state left to collect, and running `collect` against a merged merge request
 * to discover it is merged is the wasted round-trip the event exists to save.
 */
const TERMINAL_EVENTS = new Set(['mr_merged', 'mr_closed'])

export interface WakeDeliveryInput {
  db: DbClient
  /** The repo the delivery resolved to — the matrix is keyed by it. */
  repoId: string
  eventType: string
  mrIid?: string | undefined
  authorUsername?: string | undefined
  /** The frozen context each round reads its target from. */
  triggerContext: TriggerContext
  /** Attribution for the launch; RFC-301 requires both ids with a webhook origin. */
  webhookTriggerId: string
  webhookFireId: string
  /** Suppresses self-triggered loops when the platform's account is known. */
  botUsername?: string | undefined
  launchDeps: StartTaskDeps & { db: DbClient }
  /** Which connection this delivery came through; part of a work item's identity. */
  codeHostEndpointId?: string | undefined
  /** The delivery's own id. Claiming it is the T10e rule. */
  eventId?: string | undefined
}

export interface WokenRound {
  capability: string
  taskId: string
  roundId: string
  /** The work item this round belongs to; absent only if it could not be made. */
  workItemId?: string
  /** 1-based within the work item. */
  roundSeq?: number
}

export interface WakeResult {
  started: WokenRound[]
  /** Cells that matched but could not start, with the reason. */
  failed: Array<{ capability: string; error: string }>
  /** Monitor cells that looked and started nothing — the commonest outcome. */
  observed?: Array<{ capability: string; outcome: MonitorWakeOutcome }>
  /** Work items closed by a terminal event (T40). */
  closed?: string[]
}

function parseTriggerConfig(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    // A malformed row falls back to the default event set rather than making
    // this repository silently stop responding.
    return {}
  }
}

/**
 * Start a round for every capability this delivery wakes.
 *
 * Never throws: a delivery that woke three cells and failed to launch the
 * second must still launch the third. Failures come back in `failed` so the
 * caller can record them — a launch that vanished with no row is the shape this
 * RFC exists to prevent.
 */
export async function wakeCapabilitiesForDelivery(input: WakeDeliveryInput): Promise<WakeResult> {
  const rows = await input.db
    .select()
    .from(repoCapabilityConfig)
    .where(eq(repoCapabilityConfig.repoId, input.repoId))

  const cells: WakeableCell[] = rows.map((row) => ({
    capability: row.capability,
    enabled: row.enabled,
    readiness: row.readiness,
    triggerConfig: parseTriggerConfig(row.triggerConfigJson),
  }))

  const woken = cellsWokenBy(
    cells,
    {
      eventType: input.eventType,
      mrIid: input.mrIid,
      authorUsername: input.authorUsername,
    },
    { botUsername: input.botUsername },
  )

  const started: WokenRound[] = []
  const failed: Array<{ capability: string; error: string }> = []
  const observed: Array<{ capability: string; outcome: MonitorWakeOutcome }> = []

  // T10e — one ingress event, one top-level capability. When the monitor is
  // live on this repository it IS the top level: it decides what the event
  // means, up to and including "run a review". Letting both react would answer
  // one comment twice, which is how a bot earns its mute.
  const monitorIsLive = woken.some((cell) => cell.capability === MONITOR_CAPABILITY)
  const dispatchable = monitorIsLive
    ? woken.filter((cell) => cell.capability === MONITOR_CAPABILITY)
    : woken

  for (const cell of dispatchable) {
    const identity = identityFor(input, cell.capability)

    if (cell.capability === MONITOR_CAPABILITY) {
      if (identity === null) {
        failed.push({
          capability: cell.capability,
          error: `the monitor has no work item to wake — this delivery is missing: ${missingIdentityFields(input).join(', ')}`,
        })
        continue
      }
      try {
        observed.push({
          capability: cell.capability,
          outcome: await runMonitorLoopFor(input, identity),
        })
      } catch (err) {
        failed.push({
          capability: cell.capability,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        })
      }
      continue
    }

    try {
      started.push(await startDirectRound(input, cell.capability, identity))
    } catch (err) {
      failed.push({
        capability: cell.capability,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      })
    }
  }

  return { started, failed, ...(observed.length > 0 ? { observed } : {}) }
}

/**
 * The work item this delivery is about, or null when it cannot be identified.
 *
 * Both halves are required and neither can be defaulted: a work item without a
 * project id would merge two repositories' merge requests into one row, and one
 * without an endpoint id would merge two GitLab instances'.
 */
function identityFor(input: WakeDeliveryInput, capability: string): WorkItemIdentity | null {
  const projectId = input.triggerContext.trigger.webhook?.project_id ?? ''
  const endpointId = input.codeHostEndpointId ?? ''
  const anchorId = input.mrIid ?? ''
  if (projectId === '' || endpointId === '' || anchorId === '') return null
  return {
    codeHostEndpointId: endpointId,
    stableProjectId: projectId,
    capability,
    anchorKind: 'mr',
    anchorId,
  }
}

/**
 * Which identity fields this delivery is missing.
 *
 * Named individually rather than reported as "cannot identify": fixing a
 * misconfigured connection one field per round-trip is how a first-time setup
 * takes an afternoon (the same reasoning as `resolveTarget`).
 */
function missingIdentityFields(input: WakeDeliveryInput): string[] {
  const missing: string[] = []
  if ((input.triggerContext.trigger.webhook?.project_id ?? '') === '') missing.push('project id')
  if ((input.codeHostEndpointId ?? '') === '') missing.push('code host connection')
  if ((input.mrIid ?? '') === '') missing.push('merge request number')
  return missing
}

/** Run one turn of the monitor for this delivery. */
async function runMonitorLoopFor(
  input: WakeDeliveryInput,
  identity: WorkItemIdentity,
): Promise<MonitorWakeOutcome> {
  const resolved = await resolveMonitorScripts(input.db, {
    repoId: input.repoId,
    capability: MONITOR_CAPABILITY,
  })
  if (!resolved.ok) {
    // Surfaced as a blocked wake rather than thrown: the cell is
    // misconfigured, which is a state the matrix already knows how to show,
    // and an exception here would look like the platform failing instead.
    throw new Error(`the monitor cannot run on this repository: ${resolved.problem}`)
  }

  return await runMonitorWake({
    db: input.db,
    identity,
    scripts: resolved.scripts,
    ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
    dispatch: async (request) => {
      const task = await startCodeRoundTask(
        {
          roundId: request.roundId,
          capability: request.capability,
          roundSeq: request.roundSeq,
          name: `${request.capability} · MR ${identity.anchorId}`,
          scratch: true,
        },
        launchDepsFor(input),
      )
      await attachRoundTask(input.db, request.roundId, task.id)
      return { taskId: task.id }
    },
  })
}

/**
 * Start a round for a capability that is dispatched directly.
 *
 * The work item is created FIRST and the round is allocated from it, so
 * `roundSeq` is the real position in that merge request's history. The previous
 * shape launched every round as `roundSeq: 1` with no work item at all, which
 * made "this MR has been reviewed three times" unrepresentable.
 */
async function startDirectRound(
  input: WakeDeliveryInput,
  capability: string,
  identity: WorkItemIdentity | null,
): Promise<WokenRound> {
  let roundId = ulid()
  let workItemId: string | undefined
  let roundSeq = 1

  if (identity !== null) {
    const item = await ensureWorkItem({ db: input.db, ...identity })
    const round = await openRound({
      db: input.db,
      workItemId: item.id,
      epoch: item.epoch,
      ...(input.triggerContext.trigger.webhook?.commit_sha === undefined
        ? {}
        : { baselineSha: input.triggerContext.trigger.webhook.commit_sha }),
    })
    workItemId = item.id
    roundId = round.roundId
    roundSeq = round.roundSeq
  }

  const task = await startCodeRoundTask(
    {
      roundId,
      capability,
      roundSeq,
      name: `${capability} · MR ${input.mrIid ?? '?'}`,
      scratch: true,
    },
    launchDepsFor(input),
  )
  if (workItemId !== undefined) await attachRoundTask(input.db, roundId, task.id)

  return {
    capability,
    taskId: task.id,
    roundId,
    ...(workItemId === undefined ? {} : { workItemId }),
    roundSeq,
  }
}

/**
 * Close every work item on a merge request that has ended (T40).
 *
 * Closes items for ALL capabilities, not just the ones this delivery would
 * wake: a merged merge request ends the review's item as surely as the
 * monitor's, and leaving one open means a late pipeline event reopens work on a
 * branch that no longer exists.
 */
export interface CloseDeliveryInput {
  db: DbClient
  repoId: string
  codeHostEndpointId: string
  stableProjectId: string
  mrIid: string
  /** `mr_merged` or `mr_closed`; only used to word the observation. */
  eventType: string
  eventId?: string | undefined
}

export async function closeCapabilitiesForDelivery(
  input: CloseDeliveryInput,
): Promise<{ closed: string[] }> {
  if (input.codeHostEndpointId === '' || input.stableProjectId === '' || input.mrIid === '') {
    return { closed: [] }
  }

  const rows = await input.db
    .select({ capability: repoCapabilityConfig.capability })
    .from(repoCapabilityConfig)
    .where(eq(repoCapabilityConfig.repoId, input.repoId))

  const closed: string[] = []
  for (const row of rows) {
    const result = await closeMonitorItem({
      db: input.db,
      identity: {
        codeHostEndpointId: input.codeHostEndpointId,
        stableProjectId: input.stableProjectId,
        capability: row.capability,
        anchorKind: 'mr',
        anchorId: input.mrIid,
      },
      reason: `the merge request was ${input.eventType === 'mr_merged' ? 'merged' : 'closed'}`,
      // Suffixed per capability: the event-claim index is there to stop two
      // capabilities REACTING to one event, and closing is not a reaction —
      // every capability's item on this merge request has ended.
      ...(input.eventId === undefined
        ? {}
        : { eventId: `${input.eventId}:close:${row.capability}` }),
    })
    if (result.closed) closed.push(row.capability)
  }

  // T50b — the OTHER thing a terminal event closes: the requirement that
  // produced this merge request. That work item is anchored to an issue, not to
  // this MR, so the loop above cannot reach it — its identity has a different
  // anchor entirely. The index is the only path from one to the other, and
  // without this call the requirement stays open after its code has shipped.
  const produced = await claimTerminalMr(input.db, {
    codeHostEndpointId: input.codeHostEndpointId,
    stableProjectId: input.stableProjectId,
    mrIid: input.mrIid,
  })
  if (produced.claimed) {
    await closeWorkItem(input.db, produced.workItemId)
    await recordObservation({
      db: input.db,
      workItemId: produced.workItemId,
      kind: 'noop',
      reason: `the merge request this produced was ${input.eventType === 'mr_merged' ? 'merged' : 'closed'}`,
      ...(input.eventId === undefined ? {} : { eventId: `${input.eventId}:produced` }),
    })
    closed.push('requirement:produced-mr')
  }

  return { closed }
}

/** Whether this delivery ends the merge request rather than waking it. */
export function isTerminalDelivery(eventType: string): boolean {
  return TERMINAL_EVENTS.has(eventType)
}

/**
 * The launch deps, with the webhook provenance every code round carries.
 *
 * The cast is confined to this one function rather than repeated at each call
 * site: `StartTaskDeps` does not model the webhook-origin fields, and widening
 * it is a task-engine change this RFC has no business making.
 */
function launchDepsFor(input: WakeDeliveryInput): StartTaskDeps & { db: DbClient } {
  return {
    ...input.launchDeps,
    launchProvenance: { kind: 'webhook' },
    webhookTriggerId: input.webhookTriggerId,
    webhookFireId: input.webhookFireId,
    triggerContext: input.triggerContext,
  } as StartTaskDeps & { db: DbClient }
}
