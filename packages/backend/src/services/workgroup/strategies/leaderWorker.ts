// RFC-217 T3 — leader_worker strategy: the leader turn (dispatch → barrier →
// aggregate → declare), the completion gate opener, the wrap-up/park
// derivations and the zero-delta warn (all moved verbatim from runner.ts).

import { ulid } from 'ulid'
import { workgroupAssignments } from '@/db/schema'
import {
  parseWgAssignmentsPort,
  parseWgDecisionPort,
  parseWgMessagesPort,
  WG_PORT_ASSIGNMENTS,
  WG_PORT_DECISION,
  WG_PORT_MESSAGES,
} from '@agent-workflow/shared'
import { WG_LEADER_NODE_ID } from '@/services/workgroup/constants'
import { casAssignmentStatus, advanceMemberCursor } from '@/services/workgroup/lifecycle'
import { executeTurn, WG_PROTOCOL_RETRIES } from '@/services/workgroup/turnExecution'
import { casGateStatus, type EngineDbState } from '@/services/workgroup/state'
import { countRoundsUsed, currentRound, roundMode, stampWgRound } from '@/services/workgroup/rounds'
import { maxMessageId, memberDisplayName, rosterDisplayNames } from '@/services/workgroup/context'
import { persistWgMessages, postMessage } from '@/services/workgroup/messages'
import { composeLeaderPrompt } from '@/services/workgroup/prompts'
import type { WorkgroupEngineArgs } from '@/services/workgroup/engine'
import { mintNodeRun } from '@/services/nodeRunMint'
import { setNodeRunStatus } from '@/services/lifecycle'
import { taskBroadcaster, TASK_CHANNEL } from '@/ws/broadcaster'
import { resolveMemberAgent } from '@/services/workgroup/memberTurns'
import { hasSalvageableWork } from '@/services/workgroup/wake'

export async function openCompletionGate(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
): Promise<void> {
  const { db, taskId } = args
  // RFC-209 §2.4 — 读一次账本，holder 的 wgRound 与下面那条门消息的 round 共用。
  // 此前两者相隔 9 行、中间夹着两个 await 却各读各的，注释又断言它们同轮——正是本 RFC
  // 要消灭的那类漂移（对抗门 P2）。
  const gateRound = currentRound(state)
  // The gate holder run satisfies the lifecycle invariant "task
  // awaiting_review ⟹ ∃ awaiting_review node_run" (design §8.2, 设计门
  // Finding-2). Minted directly in awaiting_review — a non-frontier host row.
  const gateRunId = await mintNodeRun(db, {
    taskId,
    nodeId: WG_LEADER_NODE_ID,
    status: 'pending',
    cause: 'wg-gate',
    // RFC-189 — the gate holder belongs to the CURRENT round (display only;
    // wg-gate rows never advance the round budget, ≤ max by construction).
    overrides: { wgRound: gateRound },
  })
  await setNodeRunStatus({
    db,
    nodeRunId: gateRunId,
    to: 'awaiting_review',
    allowedFrom: ['pending'],
    reason: 'wg-gate-open',
  })
  await postMessage(db, taskId, roundMode(state.config), {
    round: gateRound,
    authorKind: 'system',
    kind: 'system',
    bodyMd: `completion gate: waiting for human confirmation${state.gate.summary ? ` — ${state.gate.summary}` : ''}`,
  })
  if (!(await casGateStatus(db, taskId, { from: ['declared'], to: 'awaiting_confirmation' }))) {
    // lost to a concurrent transition (e.g. resumed engine raced a stale pass)
    // — respect the winner; the holder run above still parks the task.
    return
  }
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'wg.gate.updated',
    awaitingConfirmation: true,
  })
}

/**
 * RFC-187 §3-7 (Codex impl-gate P1) — is an ADOPTED leader run the grace wrap-up round
 * resuming from its clarify? The wake item carries `reason:'wrap-up'`, but a clarify-answer
 * rerun is adopted (no wake item), so the flag must be re-derived or the continuation
 * silently loses the FINAL directive AND the dispatch-ban — letting the leader answer with
 * `continue + wg_assignments` and dispatch work past the cap that no later round can
 * aggregate. The cap only ever grants ONE grace leader round, so a leader continuation
 * while roundsUsed is already at/past maxRounds (with completed work) IS that round.
 */
export function isLeaderWrapUpContinuation(state: EngineDbState): boolean {
  return (
    state.config.mode === 'leader_worker' &&
    countRoundsUsed(state) >= state.config.maxRounds &&
    hasSalvageableWork(state.assignments)
  )
}

/**
 * RFC-187 F3 — is the LEADER parked on a clarify? Keyed on an OPEN clarify SESSION whose
 * source is the leader host node (`sourceAgentNodeId === __wg_leader__`). A member clarify
 * has `sourceAgentNodeId === __wg_member__` and parks its assignment `awaiting_human`
 * (caught by the wake's `humanPending`, not here). The SESSION — not the `__wg_clarify__`
 * run — is authoritative (Codex P0-1): the run is minted before the session in a
 * non-atomic sequence, so a crash between them leaves an unanswerable orphan run that a
 * run-only signal would park forever; an open session proves the park is answerable and
 * self-heals a crash-orphan (no session ⇒ the leader is re-driven and re-asks). Without
 * this the engine re-drives a clarify-parked leader every round → orphans N sessions and
 * hits max_rounds (probe B).
 */
export function deriveLeaderClarifyPark(
  clarifySessions: ReadonlyArray<{ sourceAgentNodeId: string; status: string }>,
): boolean {
  return clarifySessions.some(
    (s) => s.status === 'awaiting_human' && s.sourceAgentNodeId === WG_LEADER_NODE_ID,
  )
}

/**
 * RFC-187 §4 — a workgroup that reached `done` with ZERO canonical delta yet had
 * completed assignments is suspect: the outputs were produced but never merged into
 * canonical (probe A: fan-out writers wrote outside their iso → merge-back merged
 * nothing). `doneAssignmentCount` gates on completed work existing at all (RFC-130
 * removed the agent `readonly` field — per-node iso replaced write serialization — so
 * a "producer vs reader" distinction no longer exists; the rare pure-coordination group
 * that finishes with no files just gets a soft, non-blocking advisory).
 */
export function detectZeroDeltaDone(filesChanged: number, doneAssignmentCount: number): boolean {
  return filesChanged === 0 && doneAssignmentCount > 0
}

/**
 * RFC-187 §4 — on `done`, warn (don't block) if completed work left the canonical
 * worktree unchanged: the outputs were produced but never merged. Best-effort — any git
 * failure is swallowed so it can never wedge the done finalization.
 */
export async function warnIfZeroDeltaDone(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
): Promise<void> {
  const getFiles = args.hooks.getCanonicalFilesChanged
  if (getFiles === undefined) return
  const doneAssignmentCount = state.assignments.filter((a) => a.status === 'done').length
  if (doneAssignmentCount === 0) return
  let filesChanged: number
  try {
    filesChanged = await getFiles()
  } catch {
    return
  }
  if (!detectZeroDeltaDone(filesChanged, doneAssignmentCount)) return
  await postMessage(args.db, args.taskId, roundMode(state.config), {
    authorKind: 'system',
    kind: 'decision',
    bodyMd:
      `⚠️ ${doneAssignmentCount} assignment(s) completed but the canonical worktree has no changes — ` +
      'outputs may not have merged. Check that each worker wrote inside its own working copy ' +
      '(relative paths), not an absolute path outside it.',
  })
  args.log.warn('workgroup done with zero canonical delta despite completed work', {
    taskId: args.taskId,
    doneAssignmentCount,
  })
}

export async function driveLeaderTurn(
  args: WorkgroupEngineArgs,
  state: EngineDbState,
  adoptedRunId?: string,
  // RFC-187 §3-7 (Codex P0-3) — the single grace wrap-up round past the round cap:
  // inject a directive to aggregate + declare done, and drop any new dispatch (no
  // rounds remain to run it).
  wrapUp = false,
): Promise<void> {
  const { db, taskId } = args
  const config = state.config
  const leaderId = config.leaderMemberId
  if (leaderId === null) return
  const leaderAgent = await resolveMemberAgent(args, state, leaderId)
  if (leaderAgent === null) {
    await postMessage(db, taskId, roundMode(state.config), {
      authorKind: 'system',
      kind: 'system',
      bodyMd: `leader agent unresolvable (${memberDisplayName(config, leaderId)}) — failing task`,
    })
    throw new Error('workgroup leader agent unresolvable')
  }

  // RFC-189 — this turn's ROUND ordinal, shared by every attempt row (protocol
  // retries are the same logical round). A fresh turn is round N+1; an ADOPTED
  // row (clarify-answer rerun / crash recovery, minted outside without a stamp)
  // is already inside countRoundsUsed's NULL-qualifying tail, so its round is
  // the CURRENT count — stamped in place before driving.
  const adoptedRow =
    adoptedRunId !== undefined ? state.hostRuns.find((r) => r.id === adoptedRunId) : undefined
  const wgRound =
    adoptedRow !== undefined
      ? (adoptedRow.wgRound ?? countRoundsUsed(state))
      : countRoundsUsed(state) + 1
  if (adoptedRow !== undefined && adoptedRow.wgRound === null) {
    await stampWgRound(db, adoptedRow.id, wgRound)
  }

  interface LeaderTurnValue {
    decision: ReturnType<typeof parseWgDecisionPort> | null
    dispatches: { value: readonly { member: string; title: string; brief: string }[] }
    outMessages: ReturnType<typeof parseWgMessagesPort>
    wrapUpDroppedDispatch: boolean
  }
  const roster = rosterDisplayNames(config)
  const outcome = await executeTurn<LeaderTurnValue>(
    {
      db,
      taskId,
      hooks: args.hooks,
      ...(args.registerMint !== undefined ? { registerMint: args.registerMint } : {}),
      ...(adoptedRunId !== undefined ? { adoptedRunId } : {}),
      // Codex 实现门 P2-1 — retries of an ADOPTED turn continue from the adopted
      // row's stored index so a follow-up retry never re-mints a duplicate
      // (node, shard, retry_index). Fresh turns start at 0.
      retryBase: adoptedRow?.retryIndex ?? 0,
    },
    {
      nodeId: WG_LEADER_NODE_ID,
      agent: leaderAgent,
      role: 'leader',
      config,
      clarifyShardKey: null,
      maxAttempts: WG_PROTOCOL_RETRIES + 1,
      clarifyForbiddenNotice:
        '- Ask-back is OFF in this autonomous group. Do NOT emit <workflow-clarify>.\n' +
        '  Proceed with your best judgment and emit wg_decision / wg_assignments as usual.',
      // RFC-187 §3-3 — a protocol retry (attempt>0) is the SAME logical round;
      // tag it so round accounting excludes it. RFC-189 — retryIndex is the
      // plain attempt ordinal (the round lives in wg_round).
      mintRow: (attempt, retryBase) => ({
        cause: attempt > 0 ? 'wg-protocol-retry' : 'wg-leader-round',
        retryIndex: retryBase + attempt,
        overrides: { wgRound },
      }),
      composePrompt: (envelopeNonce) =>
        composeLeaderPrompt(state, envelopeNonce) +
        (wrapUp
          ? '\n\n## FINAL round — the round cap has been reached\n\nThis is your LAST turn. Do NOT dispatch new work (there are no rounds left to run it). ' +
            'Aggregate the completed results and emit `wg_decision` with action `done`. Any `wg_assignments` you emit now will be ignored.'
          : ''),
      parse: (outputs) => {
        const decisionRaw = outputs[WG_PORT_DECISION]
        const assignmentsRaw = outputs[WG_PORT_ASSIGNMENTS]
        const messagesRaw = outputs[WG_PORT_MESSAGES]
        const errors: string[] = []
        const decision = decisionRaw !== undefined ? parseWgDecisionPort(decisionRaw) : null
        if (decision === null) errors.push('missing required port wg_decision')
        else if (!decision.ok) errors.push(...decision.errors.map((e) => `wg_decision: ${e}`))
        let dispatches =
          assignmentsRaw !== undefined
            ? parseWgAssignmentsPort(assignmentsRaw, roster, {
                // RFC-185 D4 (Codex T6 P1) — OFF is enforced here, not just in
                // the prompt: same-member duplicates reject the port whole.
                allowSameMemberFanOut: config.fanOut === true,
              })
            : { ok: true as const, value: [] }
        if (!dispatches.ok) errors.push(...dispatches.errors.map((e) => `wg_assignments: ${e}`))
        // RFC-187 §3-7 (Codex P0-3): the grace wrap-up round cannot dispatch new
        // work. DROP any new assignments (don't error, so the wg_decision still
        // lands) and note it in the room during settle.
        let wrapUpDroppedDispatch = false
        if (wrapUp && dispatches.ok && dispatches.value.length > 0) {
          wrapUpDroppedDispatch = true
          dispatches = { ok: true as const, value: [] }
        }
        const outMessages =
          messagesRaw !== undefined
            ? parseWgMessagesPort(messagesRaw, roster)
            : { ok: true as const, value: [] }
        if (!outMessages.ok) errors.push(...outMessages.errors.map((e) => `wg_messages: ${e}`))
        // RFC-186 Phase 3 (audit §3-6): `done` co-emitted with NEW assignments is
        // contradictory — reject so the leader re-decides: dispatch OR done.
        if (
          decision !== null &&
          decision.ok &&
          decision.value.action === 'done' &&
          dispatches.ok &&
          dispatches.value.length > 0
        ) {
          errors.push(
            'wg_decision: action "done" cannot be emitted together with new wg_assignments — dispatch OR declare done, not both',
          )
        }
        if (errors.length > 0) return { ok: false, errors }
        return {
          ok: true,
          value: {
            decision,
            dispatches: dispatches as {
              value: readonly { member: string; title: string; brief: string }[]
            },
            outMessages,
            wrapUpDroppedDispatch,
          },
        }
      },
    },
  )

  if (outcome.kind === 'canceled') return
  if (outcome.kind === 'awaiting') return // leader asked the human — task parks via outcome pass
  // RFC-181 C — suppressed ask-back exhaustion: DROP-AND-CONTINUE (no throw, no
  // park) — the leader slides into idle; nudge / round caps take over.
  if (outcome.kind === 'clarify-forbidden-exhausted') return
  if (outcome.kind === 'failed') throw new Error(outcome.errorMessage)
  if (outcome.kind === 'protocol-exhausted') {
    throw new Error(`leader protocol violation: ${outcome.errors.join('; ')}`)
  }

  const { decision, dispatches, outMessages, wrapUpDroppedDispatch } = outcome.value
  const runId = outcome.runId
  // Codex 实现门 P2-2 — the turn's EFFECTS share the SAME authoritative round
  // as the run row's stamp.
  const round = wgRound
  // 1. persist leader messages (targets validated; leader may always DM).
  if (outMessages.ok) {
    await persistWgMessages(db, taskId, config, round, leaderId, outMessages.value, {
      allowDirect: true,
      allowBlackboard: true,
    })
  }
  // 2. dispatch assignments (agent members start immediately via next pass;
  //    human members become awaiting-delivery cards — PR-5 unlocks launch).
  for (const d of dispatches.value) {
    const member = config.members.find((m) => m.displayName === d.member)
    if (member === undefined) continue
    const id = ulid()
    await db.insert(workgroupAssignments).values({
      id,
      taskId,
      round,
      source: 'leader',
      createdByRunId: runId,
      assigneeMemberId: member.id,
      title: d.title,
      briefMd: d.brief,
      status: 'dispatched',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await postMessage(db, taskId, roundMode(config), {
      round,
      authorKind: 'member',
      authorMemberId: leaderId,
      kind: 'dispatch',
      bodyMd: `@${d.member} ${d.title}`,
      mentionMemberIds: [member.id],
      assignmentId: id,
    })
  }
  // RFC-187 §3-7 — surface the dropped wrap-up dispatch (see the drop above).
  if (wrapUpDroppedDispatch) {
    await postMessage(db, taskId, roundMode(config), {
      round,
      authorKind: 'system',
      kind: 'system',
      bodyMd:
        'Round cap reached — new assignments in this final wrap-up round were ignored. ' +
        'Aggregating the completed work.',
    })
  }
  // 3. deliveries the leader just consumed flip delivered→done (design
  //    §1.4: delivered = 交付已落, done = 下一回合已消费).
  for (const a of state.assignments) {
    if (a.status === 'delivered') {
      await casAssignmentStatus(db, a.id, 'delivered', 'done').catch(() => false)
    }
  }
  // 4. decision.
  if (decision !== null && decision.ok) {
    if (decision.value.action === 'done') {
      await postMessage(db, taskId, roundMode(config), {
        round,
        authorKind: 'member',
        authorMemberId: leaderId,
        kind: 'decision',
        bodyMd: decision.value.summary ?? '',
      })
      await casGateStatus(db, taskId, {
        from: ['idle', 'rejected'],
        to: 'declared',
        ...(decision.value.summary !== undefined ? { summary: decision.value.summary } : {}),
      })
    } else if (state.gate.rejected) {
      // leader consumed the rejection (kept working instead of re-declaring)
      // — the rejected→idle edge clears the surfaced comment.
      await casGateStatus(db, taskId, { from: ['rejected'], to: 'idle' })
    }
  }
  // RFC-186 T5 (audit §5 F6): advance the leader cursor to the turn-start max
  // ONLY here, AFTER this turn's effects are durably persisted (crash before
  // this point ⇒ the resumed engine re-derives the turn instead of skipping).
  await advanceMemberCursor(db, taskId, leaderId, maxMessageId(state.messages))
}
