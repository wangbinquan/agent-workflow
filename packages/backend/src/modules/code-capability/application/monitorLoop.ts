// RFC-304 T36–T40 — the MR monitor's main loop.
//
//   an external event wakes the item (never a poll, N7/E3)
//     → collect    what is the state of this merge request?
//     → classify   what kind of failures are in the gate's logs?
//     → arbitrate  what, if anything, should this round do?
//     → select     which agent runs each slot?
//     → open ONE round for the whole batch, pushed once (E8)
//     → back to waiting
//
// Four scripts, no model anywhere in the chain (constitution R1): reading state,
// sorting failures, picking work and choosing an agent are all decisions a
// program can make, so a program makes them. The model appears later, inside the
// round the loop opens.
//
// ## The three outcomes that are NOT "start a round"
//
// Most of this file is about them, because each is a way the obvious
// implementation goes wrong:
//
//   noop      — the commonest outcome by an order of magnitude (~150 healthy
//               wake-ups a day at 50 active merge requests). It creates no task
//               and says NOTHING on the merge request; it leaves an observation
//               so "did it look?" has an answer that does not require polling.
//   conflict  — reported, never fixed (proposal N1/E10, AC-15). Silently
//               resolving a conflict produces code that compiles, passes, and is
//               wrong. Reported ONCE PER REVISION, or a conflicted merge request
//               that sits for a day buries its own report under repeats.
//   blocked   — a core script failed. Nothing continues on empty artifacts
//               (T35b); the round does not open and the reason is recorded.
//
// ## Where the scripts run
//
// A scratch directory, not a git worktree. The design says a capability's work
// happens in a worktree, and the ROUND's does — but the four monitor scripts
// read the code host's API rather than the code, and `git worktree add` per
// wake-up would be ~150 worktrees a day per repository to run four scripts that
// never look at a file. The round that follows gets a real worktree.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import {
  ClassifiedIssuesSchema,
  CollectResultSchema,
  WorkPackagesSchema,
  AgentPlanSchema,
  defaultArbitrate,
  isSingleCapabilityBatch,
  type AgentPlan,
  type ClassifiedIssue,
  type CollectResult,
  type WorkPackage,
} from '@/modules/code-capability/domain/monitorContracts'
import {
  runMonitorScript,
  type MonitorScriptDefinition,
  type MonitorScriptEnvironment,
} from '@/modules/code-capability/application/monitorScripts'
import {
  closeWorkItem,
  ensureWorkItem,
  hasReportedConflict,
  isWorkItemClosed,
  openRound,
  recordObservation,
  type WorkItemIdentity,
} from '@/modules/code-capability/infrastructure/sqliteMonitorStore'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'
import { invalidatePendingOnPush } from '@/modules/code-capability/application/invalidatePending'

/** The scripts a department framework supplies. Only `collect` is required. */
export interface MonitorScriptSet {
  collect: MonitorScriptDefinition
  /** Absent ⇒ no issues are classified, and arbitration sees an empty list. */
  classify?: MonitorScriptDefinition
  /** Absent ⇒ the platform's default priority applies (T37). */
  arbitrate?: MonitorScriptDefinition
  /** Absent ⇒ the round falls back to the binding's configured agents. */
  select?: MonitorScriptDefinition
}

/** What the loop needs in order to open a round it has decided on. */
export interface RoundDispatcher {
  (request: {
    workItemId: string
    roundId: string
    roundSeq: number
    capability: string
    packages: readonly WorkPackage[]
    agentPlan: AgentPlan | null
    baselineSha: string
    causationId: string
  }): Promise<{ taskId: string }>
}

export interface MonitorWakeInput {
  db: DbClient
  /** The monitor's own work item; `capability` is normally `mr-monitor`. */
  identity: WorkItemIdentity
  scripts: MonitorScriptSet
  dispatch: RoundDispatcher
  /** Used only to report a conflict. A loop with no host cannot report one. */
  codeHost?: CodeHostPort
  /**
   * T45 — releases a pending change once the branch moves past it.
   *
   * Optional because a loop without one still works: it simply never
   * invalidates, which is the pre-T45 behaviour rather than a broken state.
   */
  git?: GitPort
  /** Params the conflict report needs to address the merge request. */
  reportTarget?: Readonly<Record<string, string>>
  /** The ingress event being answered; claiming it is the T10e rule. */
  eventId?: string | null
  /** Shared by everything this wake-up causes. */
  causationId?: string
  anchorMeta?: Record<string, unknown>
  /** Where scripts run; a fresh scratch dir per wake by default. */
  scratchDir?: string
  interpreterPath?: string
  timeoutMs?: number
  now?: number
  signal?: AbortSignal
}

export type MonitorWakeOutcome =
  /** Nothing to do. No task, no comment — just the record that it looked. */
  | { kind: 'noop'; reason: string; observedRevision: string }
  /** A round is open and its task started. */
  | {
      kind: 'dispatched'
      capability: string
      roundId: string
      roundSeq: number
      taskId: string
      packages: readonly WorkPackage[]
    }
  /** A conflict was seen. `reported` is false when this revision already was. */
  | { kind: 'conflict'; reported: boolean; observedRevision: string }
  /** A core script failed, or produced something its contract rejects. */
  | { kind: 'blocked'; reason: string }
  /** The merge request is merged or closed; nothing more will run (T40). */
  | { kind: 'closed' }
  /** Another top-level capability already answered this event (T10e). */
  | { kind: 'claimed-elsewhere' }

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Run one turn of the monitor.
 *
 * Called ONLY from a wake — there is no timer here and there must never be one
 * (N7; `rfc304-monitor-loop.test.ts` asserts it at the source level). A function
 * that polls would defeat the whole event-driven design and, at 200 repositories
 * times 50 merge requests, would spend its day asking the code host questions
 * whose answer is "nothing changed".
 */
export async function runMonitorWake(input: MonitorWakeInput): Promise<MonitorWakeOutcome> {
  const now = input.now ?? Date.now()
  const causationId = input.causationId ?? ulid()

  const item = await ensureWorkItem({
    db: input.db,
    ...input.identity,
    ...(input.anchorMeta === undefined ? {} : { anchorMeta: input.anchorMeta }),
    now,
  })

  // T40. Checked before anything runs: a merged merge request must not cost a
  // subprocess, let alone a round. Late events on a closed item are normal —
  // pipelines finish after a merge.
  if (await isWorkItemClosed(input.db, item.id)) return { kind: 'closed' }

  const ownScratch = input.scratchDir === undefined
  const scratch = input.scratchDir ?? mkdtempSync(join(tmpdir(), 'aw-monitor-'))

  try {
    const scriptEnv: MonitorScriptEnvironment = {
      worktreePath: scratch,
      runDir: join(scratch, 'run'),
      repos: [],
      interpreterPath: input.interpreterPath ?? defaultInterpreterFor(input.scripts.collect),
      workItem: {
        capability: input.identity.capability,
        anchorKind: input.identity.anchorKind,
        anchorId: input.identity.anchorId,
        roundId: item.id,
        roundSeq: 0,
        baselineSha: null,
      },
      envelopeNonce: ulid(),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }

    // ---- collect ---------------------------------------------------------
    const collected = await runMonitorScript({
      definition: input.scripts.collect,
      schema: CollectResultSchema,
      env: scriptEnv,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (collected.status === 'blocked') {
      return await blocked(input, item.id, collected.reason, causationId, null, now)
    }
    const state: CollectResult = collected.value

    // T45 — a push past a pending change invalidates it, BEFORE anything is
    // arbitrated. `collect` has just reported the current head, which is the
    // only moment the platform knows the branch moved.
    //
    // The failure this prevents is specific and bad: a frozen patch is posted
    // and waits for `/aw apply`, the author pushes, and the confirmation then
    // materialises a change computed against code that no longer exists. The
    // artifact's own base check is the guard, and this is what runs it.
    //
    // Idempotent by construction, which matters because one push arrives as
    // several events (mr_updated, a pipeline start, a comment from CI) and each
    // of them wakes the monitor.
    if (input.git !== undefined) {
      await invalidatePendingOnPush({
        db: input.db,
        git: input.git,
        workItemId: item.id,
        newHeadSha: state.headSha,
        ...(input.codeHost !== undefined && input.reportTarget !== undefined
          ? { notify: { codeHost: input.codeHost, threadParams: input.reportTarget } }
          : {}),
      })
    }

    // ---- conflict (T39) --------------------------------------------------
    // Before arbitration, and not as a work package: no arm of the union can
    // express "fix this", because the platform never fixes one.
    if (state.conflict) {
      const already = await hasReportedConflict(input.db, item.id, state.headSha)
      let reported = false
      if (!already && input.codeHost !== undefined && input.reportTarget !== undefined) {
        const posted = await input.codeHost.call({
          action: 'comment.create',
          params: { ...input.reportTarget, body: conflictReportBody(state.headSha) },
        })
        reported = posted.ok
      }
      const claim = await recordObservation({
        db: input.db,
        workItemId: item.id,
        kind: 'conflict',
        reason: 'merge conflict — reported, not fixed',
        observedRevision: state.headSha,
        causationId,
        eventId: input.eventId ?? null,
        now,
      })
      if (!claim.recorded) return { kind: 'claimed-elsewhere' }
      return { kind: 'conflict', reported, observedRevision: state.headSha }
    }

    // ---- classify --------------------------------------------------------
    // Only when the gate actually failed. Running it on a green pipeline asks a
    // department's log parser to explain logs that describe success, and
    // whatever it returns would then be arbitrated as if it were a problem.
    let issues: ClassifiedIssue[] = []
    if (state.gate.status === 'fail' && input.scripts.classify !== undefined) {
      const classified = await runMonitorScript({
        definition: input.scripts.classify,
        schema: ClassifiedIssuesSchema,
        env: scriptEnv,
        input: state,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (classified.status === 'blocked') {
        return await blocked(input, item.id, classified.reason, causationId, state.headSha, now)
      }
      issues = classified.value
    }

    // ---- arbitrate (T37) -------------------------------------------------
    let packages: WorkPackage[]
    if (input.scripts.arbitrate === undefined) {
      packages = defaultArbitrate(state, issues)
    } else {
      const arbitrated = await runMonitorScript({
        definition: input.scripts.arbitrate,
        schema: WorkPackagesSchema,
        env: scriptEnv,
        input: { collected: state, issues },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (arbitrated.status === 'blocked') {
        return await blocked(input, item.id, arbitrated.reason, causationId, state.headSha, now)
      }
      packages = arbitrated.value
    }

    if (packages.length === 0) {
      // An empty list is not `noop` — `noop` is a decision with a reason, and an
      // empty list is an arbitration that declined to say anything. Treating
      // them alike would let a broken script look like a quiet day.
      return await blocked(
        input,
        item.id,
        'the arbitration returned no work packages; use a `noop` package to say there is nothing to do',
        causationId,
        state.headSha,
        now,
      )
    }

    // T38 — one round does one capability. `[{noop}, {mr-review}]` type-checks
    // and has no answer to "which sequence does this round run".
    if (!isSingleCapabilityBatch(packages)) {
      return await blocked(
        input,
        item.id,
        `the arbitration mixed capabilities in one batch (${[...new Set(packages.map((p) => p.capability))].sort().join(', ')}); work of two kinds means two rounds`,
        causationId,
        state.headSha,
        now,
      )
    }

    const capability = packages[0]!.capability

    // ---- noop ------------------------------------------------------------
    if (capability === 'noop') {
      const reason = packages
        .map((p) => (p.capability === 'noop' ? p.reason : ''))
        .filter((r) => r !== '')
        .join('; ')
      const claim = await recordObservation({
        db: input.db,
        workItemId: item.id,
        kind: 'noop',
        reason,
        observedRevision: state.headSha,
        causationId,
        eventId: input.eventId ?? null,
        now,
      })
      if (!claim.recorded) return { kind: 'claimed-elsewhere' }
      return { kind: 'noop', reason, observedRevision: state.headSha }
    }

    // ---- select ----------------------------------------------------------
    let agentPlan: AgentPlan | null = null
    if (input.scripts.select !== undefined) {
      const selected = await runMonitorScript({
        definition: input.scripts.select,
        schema: AgentPlanSchema,
        env: scriptEnv,
        input: { packages },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
      if (selected.status === 'blocked') {
        return await blocked(input, item.id, selected.reason, causationId, state.headSha, now)
      }
      agentPlan = selected.value
    }

    // ---- open the round --------------------------------------------------
    // The event is claimed BEFORE the round opens. Claiming afterwards would
    // leave a window where a second capability answers the same event and a
    // second round starts on the same merge request; the round is the expensive
    // half, so the cheap half goes first.
    const claim = await recordObservation({
      db: input.db,
      workItemId: item.id,
      kind: 'dispatched',
      reason: `${capability}: ${String(packages.length)} package(s)`,
      observedRevision: state.headSha,
      causationId,
      eventId: input.eventId ?? null,
      now,
    })
    if (!claim.recorded) return { kind: 'claimed-elsewhere' }

    const round = await openRound({
      db: input.db,
      workItemId: item.id,
      epoch: item.epoch,
      workPackage: { packages, agentPlan },
      baselineSha: state.headSha,
      now,
    })

    const { taskId } = await input.dispatch({
      workItemId: item.id,
      roundId: round.roundId,
      roundSeq: round.roundSeq,
      capability,
      packages,
      agentPlan,
      baselineSha: state.headSha,
      causationId,
    })

    return {
      kind: 'dispatched',
      capability,
      roundId: round.roundId,
      roundSeq: round.roundSeq,
      taskId,
      packages,
    }
  } finally {
    if (ownScratch) rmSync(scratch, { recursive: true, force: true })
  }
}

/** Record a blocked wake-up and return it. Never opens a round. */
async function blocked(
  input: MonitorWakeInput,
  workItemId: string,
  reason: string,
  causationId: string,
  observedRevision: string | null,
  now: number,
): Promise<MonitorWakeOutcome> {
  const claim = await recordObservation({
    db: input.db,
    workItemId,
    kind: 'blocked',
    reason,
    observedRevision,
    causationId,
    eventId: input.eventId ?? null,
    now,
  })
  if (!claim.recorded) return { kind: 'claimed-elsewhere' }
  return { kind: 'blocked', reason }
}

/**
 * The conflict report's text.
 *
 * Says what was seen, what will happen, and what the platform will NOT do. The
 * last part is the one that matters: a reader who assumes the machine is
 * handling it will not resolve the conflict, and the merge request stops.
 */
export function conflictReportBody(headSha: string): string {
  return [
    '**Merge conflict.**',
    '',
    `This merge request conflicts with its target branch at \`${headSha.slice(0, 12)}\`.`,
    '',
    'Automated work is paused until the conflict is resolved. Conflicts are **not**',
    'resolved automatically — a wrong resolution compiles, passes tests, and is still',
    'wrong, so this one is yours.',
    '',
    'Push a resolution and this will pick up from there.',
  ].join('\n')
}

/**
 * Close the monitor's work item when the merge request reaches a terminal state.
 *
 * Separate from the loop rather than a branch inside it: the terminal event
 * carries no merge-request state to collect, and running `collect` against a
 * merged merge request to discover it is merged is exactly the wasted round-trip
 * the event was supposed to save.
 */
export async function closeMonitorItem(args: {
  db: DbClient
  identity: WorkItemIdentity
  reason: string
  eventId?: string | null
  causationId?: string
  now?: number
}): Promise<{ closed: boolean }> {
  const now = args.now ?? Date.now()
  const item = await ensureWorkItem({ db: args.db, ...args.identity, now })
  if (await isWorkItemClosed(args.db, item.id)) return { closed: false }
  await closeWorkItem(args.db, item.id, now)
  await recordObservation({
    db: args.db,
    workItemId: item.id,
    kind: 'noop',
    reason: args.reason,
    causationId: args.causationId ?? ulid(),
    eventId: args.eventId ?? null,
    now,
  })
  return { closed: true }
}

/** The interpreter a script runs under when the caller did not name one. */
export function defaultInterpreterFor(definition: MonitorScriptDefinition): string {
  switch (definition.language) {
    case 'python':
      return process.platform === 'win32' ? 'python' : 'python3'
    case 'node':
      return 'node'
    default:
      return 'bash'
  }
}
