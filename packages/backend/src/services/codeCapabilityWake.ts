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
import { repoCapabilityConfig, codeWorkRounds } from '@/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import {
  anchorKindFor,
  cellsWokenBy,
  type WakeableCell,
} from '@/modules/code-capability/domain/capabilityWake'
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
import { classifyComment } from '@/modules/code-capability/application/classifyComment'
import {
  advanceSupersedingWorkItem,
  requestRoundCancelAndArm,
} from '@/services/codeCapabilitySupersede'
import type { ApplyOutcome } from '@/modules/code-capability/infrastructure/sqliteWorkItemStore'
import { createCodeHostAdapter } from '@/modules/code-capability/infrastructure/codeHostAdapter'
import { noteWorkItemEvent } from '@/modules/code-capability/application/workItemProgress'
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
  /** Issue number, for the capabilities anchored to one (`requirement`). */
  issueIid?: string | undefined
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
  /**
   * Set when a confirmation could not be honoured and was ANSWERED instead of
   * started. No round exists; the reply is already on the thread.
   */
  refused?: string
  /**
   * Set when the work item's state machine withheld the round — an ordinary
   * comment under a diff that is waiting for a person, say. No round exists and
   * NOTHING was posted: the conversation is not addressed to the platform, and
   * a bot answering every remark is its own problem.
   */
  declined?: string
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
      issueIid: input.issueIid,
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
 * The webhook fields of a trigger context, defensively.
 *
 * This function is documented as never throwing, and a malformed or absent
 * context reaching it must not be the exception to that: it is called from the
 * webhook dispatcher on live deliveries, so a crash here takes down a delivery
 * that had other work to do. An empty field set flows on to the identity check,
 * which then reports precisely what is missing.
 */
function webhookFieldsOf(context: TriggerContext | undefined): Partial<Record<string, string>> {
  return context?.trigger?.webhook ?? {}
}

/**
 * The work item this delivery is about, or null when it cannot be identified.
 *
 * Both halves are required and neither can be defaulted: a work item without a
 * project id would merge two repositories' merge requests into one row, and one
 * without an endpoint id would merge two GitLab instances'.
 */
function identityFor(input: WakeDeliveryInput, capability: string): WorkItemIdentity | null {
  const projectId = webhookFieldsOf(input.triggerContext).project_id ?? ''
  const endpointId = input.codeHostEndpointId ?? ''
  // A `requirement` is about an ISSUE; everything else is about a merge
  // request. Anchoring it to `mr` would key its work item to a merge request
  // number that happens to equal the issue number — a different object with
  // the same digits, and no error anywhere to say so.
  const anchorKind = anchorKindFor(capability)
  const anchorId = (anchorKind === 'issue' ? input.issueIid : input.mrIid) ?? ''
  if (projectId === '' || endpointId === '' || anchorId === '') return null
  return {
    codeHostEndpointId: endpointId,
    stableProjectId: projectId,
    capability,
    anchorKind,
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
  if ((webhookFieldsOf(input.triggerContext).project_id ?? '') === '') missing.push('project id')
  if ((input.codeHostEndpointId ?? '') === '') missing.push('code host connection')
  if ((input.mrIid ?? '') === '' && (input.issueIid ?? '') === '') {
    missing.push('merge request or issue number')
  }
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
          // The repository the delivery already resolved, NOT a scratch space.
          // `prepare-worktree` fetches the merge request head from `origin` of
          // the round's repo path (design §5.2 — from the TARGET remote, the
          // one the platform holds credentials for). A scratch launch gives it
          // an empty directory with no remote, so every round died at stage two
          // with "'origin' does not appear to be a git repository" — found by
          // the system-mock E2E, and invisible to every unit test because they
          // all hand `repoPath` in as an already-cloned fixture.
          cachedRepoId: input.repoId,
        },
        launchDepsFor(input),
      )
      await attachRoundTask(input.db, request.roundId, task.id)
      return { taskId: task.id }
    },
  })
}

/**
 * Tell the person why their confirmation was not acted on.
 *
 * Posted from here rather than from a round because there IS no round — the
 * confirmation named a change that is gone or superseded. Silence is the one
 * outcome the design rules out: the person believes they approved something,
 * waits, and then stops trusting the mechanism.
 *
 * A failure to post is swallowed. The alternative — failing the delivery —
 * would retry the whole wake and could open a round for a confirmation the
 * platform has already decided not to honour.
 */
async function replyRefusal(
  input: WakeDeliveryInput,
  fields: ReturnType<typeof webhookFieldsOf>,
  message: string,
): Promise<void> {
  const provider = fields.provider
  if (provider !== 'gitlab' && provider !== 'github') return
  const thread = fields.comment_thread_id ?? ''
  const project = fields.project_id ?? ''
  const mr = fields.mr_iid ?? ''
  if (thread === '' || project === '' || mr === '') return

  try {
    const codeHost = createCodeHostAdapter({ db: input.db, provider })
    await codeHost.call({
      action: 'comment.reply-thread',
      params: { project, mr, thread, body: message },
    })
  } catch {
    // Best effort; see the note above.
  }
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

    // Heal a preemption whose replacement never started — the in-process wait
    // for the old task lives in a process that can die, and an item left in
    // `superseding` is invisible: no round, no error, the merge request simply
    // stops being reviewed. A no-op unless the item is superseding AND its
    // round's task has really settled, so it costs one read on the ordinary
    // path.
    await advanceSupersedingWorkItem({ db: input.db, launchDeps: launchDepsFor(input) }, item.id)

    // Is this reply a confirmation of a change already posted and waiting?
    //
    // Until this ran, `judgeConfirmation` had no production caller: the diff
    // said "reply `/aw apply` to push this", somebody replied, and Guard 3
    // correctly refused to wake an `awaiting` item for what looked like an
    // ordinary note. The instruction the platform itself printed did nothing.
    const fields = webhookFieldsOf(input.triggerContext)
    const commentBody = fields.comment_text ?? ''
    const classification =
      commentBody === ''
        ? ({ kind: 'ordinary' } as const)
        : await classifyComment({
            db: input.db,
            workItemId: item.id,
            body: commentBody,
            currentHeadSha: fields.commit_sha ?? '',
          })

    if (classification.kind === 'refused') {
      // Answered, never silent — a confirmation that vanishes teaches people
      // the feature is unreliable, which costs more than the refusal.
      await replyRefusal(input, fields, classification.message)
      return { capability, taskId: '', roundId: '', roundSeq: 0, refused: classification.message }
    }
    // Ask the state machine BEFORE opening a round, and let it say no.
    //
    // This used to run after `openRound`, which made the answer decorative: an
    // ordinary comment on an item that was `awaiting` a person's decision
    // recorded "the table declined" and then opened a round anyway. Guard 3
    // exists precisely so that discussion under a posted diff does not start a
    // competing round — the frozen change is waiting for a yes, and the
    // conversation continuing is not one.
    const signal = await noteWorkItemEvent({
      db: input.db,
      workItemId: item.id,
      // Whether a round of this item is still alive decides between "open one"
      // and "preempt the one that is running" — the table reads it for exactly
      // that. It was hardcoded `false`, so a delivery arriving mid-round was
      // judged as if nothing were running.
      hasLiveRound: await hasLiveRound(input.db, item.id),
      // What the replacement round will need if this delivery preempts a
      // running one: the machine registers a pending revision, and until now it
      // recorded only a timestamp — nothing a round could be started from.
      pendingRevision: {
        capability,
        repoId: input.repoId,
        mrIid: input.mrIid,
        triggerContext: input.triggerContext,
        webhookTriggerId: input.webhookTriggerId,
        webhookFireId: input.webhookFireId,
        baselineSha: webhookFieldsOf(input.triggerContext).commit_sha,
      },
      // The delivery, as the state machine sees it. A `note` classification
      // rather than `head-changed`: this path opens a round for a delivery
      // whose meaning was already decided upstream, and claiming a head change
      // here would invalidate a pending patch that the author never actually
      // superseded (T45).
      event:
        classification.kind === 'confirmation'
          ? {
              kind: 'external-signal',
              // Guard 2 compares this against the pending generation: a
              // confirmation aimed at a superseded patch is answered, not
              // applied.
              signal: { kind: 'confirmation', generation: classification.generation },
            }
          : { kind: 'external-signal', signal: { kind: 'note' } },
    })

    // `request-round-cancel` is the caller's to perform (see
    // `workItemProgress`'s header), and nobody ever did: an item could enter
    // `superseding` but the round it was superseding kept running to
    // completion, publishing a review of a revision that had already moved.
    if (signal.outcome === 'applied' || signal.outcome === 'stayed') {
      if (signal.effects.some((effect) => effect.kind === 'request-round-cancel')) {
        await requestRoundCancelAndArm({ db: input.db, launchDeps: launchDepsFor(input) }, item.id)
      }
    }

    const declined = withheldRoundReason(signal)
    if (declined !== null) {
      return { capability, taskId: '', roundId: '', roundSeq: 0, declined }
    }

    const round = await openRound({
      db: input.db,
      workItemId: item.id,
      epoch: item.epoch,
      // A confirming round RESUMES at `verify-baseline`. Re-running the AI
      // stages would produce a different change with the same justification,
      // and the person approved a specific diff rather than a topic.
      ...(classification.kind === 'confirmation'
        ? {
            workPackage: {
              resumeFromStage: 'verify-baseline',
              artifactDigest: classification.artifactDigest,
            },
          }
        : {}),
      ...(webhookFieldsOf(input.triggerContext).commit_sha === undefined
        ? {}
        : { baselineSha: webhookFieldsOf(input.triggerContext).commit_sha }),
    })
    workItemId = item.id
    roundId = round.roundId
    roundSeq = round.roundSeq

    // The take that turns the queued item into a running one — the round IS
    // being opened and dispatched in one step, and the table wants both
    // transitions so the guards that key off `queued` (supersede,
    // pending-revision merge) have a state to key off.
    await noteWorkItemEvent({
      db: input.db,
      workItemId: item.id,
      hasLiveRound: true,
      event: { kind: 'scheduler-take' },
    })
  }

  const task = await startCodeRoundTask(
    {
      roundId,
      capability,
      roundSeq,
      name: `${capability} · MR ${input.mrIid ?? '?'}`,
      // Same reason as the monitor's dispatch above: the round's stages fetch
      // and check out inside this repository, so it has to BE the repository.
      cachedRepoId: input.repoId,
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
 * Whether the state machine withheld the round, and why — `null` to go ahead.
 *
 * Reads the table's `start-round` EFFECT rather than the status it moved to,
 * because the effect is the instruction: `workItemProgress`'s header says
 * plainly that `start-round` is the caller's to perform, and no caller ever
 * did. The round was opened either way, so `awaiting` — the state the whole
 * human-confirmation design turns on — could be talked straight through.
 *
 * Two states withhold it in a way the platform can honour today:
 *
 *   awaiting    a person is deciding on a frozen change; ordinary comments are
 *               discussion, and a round started here competes with the diff
 *               they were asked about.
 *   handed_off  the campaign is over and was handed to a human; a new remark
 *               does not reopen it.
 *
 * The other withholding states — `queued`, `running`, `superseding` — mean "a
 * round must start LATER", and the platform has no deferred start to hand:
 * nothing emits `round-task-terminal` and nothing performs `start-round`, so
 * honouring them here would drop the delivery entirely rather than defer it.
 * Those keep today's behaviour until the supersede work lands the performers,
 * which is the one place this function knowingly disagrees with the table.
 */
/**
 * Whether a round of this item still has a task that has not settled.
 *
 * The table's guards turn on it: with a live round an arriving event PREEMPTS
 * (`superseding`, epoch bump, cancel), without one it simply opens a round. The
 * wake path passed a literal `false`, so every delivery was judged as if the
 * item were idle — which is why three pushes in a row produced three concurrent
 * rounds instead of one.
 */
async function hasLiveRound(db: DbClient, workItemId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: codeWorkRounds.id })
    .from(codeWorkRounds)
    .where(and(eq(codeWorkRounds.workItemId, workItemId), isNull(codeWorkRounds.endedAt)))
    .limit(1)
  return row !== undefined
}

function withheldRoundReason(outcome: ApplyOutcome): string | null {
  if (outcome.outcome !== 'applied' && outcome.outcome !== 'stayed') return null
  if (outcome.effects.some((effect) => effect.kind === 'start-round')) return null

  const status = outcome.outcome === 'applied' ? outcome.to : outcome.status
  switch (status) {
    case 'awaiting':
      return 'the item is waiting for a person to answer a change that is already posted'
    case 'handed_off':
      return 'the item was handed to a human and is no longer running'
    case 'queued':
      return 'a round is already queued for this item; this delivery merged into it'
    case 'superseding':
      return 'the running round is being preempted; the replacement starts when it ends'
    case 'running':
      return 'a round is running; this delivery preempts it rather than joining it'
    default:
      return `the work item is '${status}' and the state machine asked for no round`
  }
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
    // Empty when the delivery matched no trigger, which is the NORMAL case for
    // a capability: a repository that switched on MR review has written no
    // trigger at all. The round row is the attribution anchor instead
    // (`hasCodeRound` in the RFC-301 admission check), and passing empty
    // strings here rather than omitting the fields keeps the shape stable for
    // the launches that do have them.
    webhookTriggerId: input.webhookTriggerId,
    webhookFireId: input.webhookFireId,
    triggerContext: input.triggerContext,
  } as StartTaskDeps & { db: DbClient }
}
