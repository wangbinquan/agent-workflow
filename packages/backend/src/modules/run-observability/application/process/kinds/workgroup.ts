// RFC-616 §6.2 — workgroups. A unit is a task; stages are the leader and the
// members (attributed by the same rule the task room uses), plus platform work.
// In dynamic-workflow mode the generated graph differs per task, so its nodes
// are folded onto the member whose agent runs them.

import {
  PROCESS_SYSTEM_STAGES,
  PROCESS_UNATTRIBUTED_STAGE,
  WORKGROUP_PROTOCOL_RETRY_RERUN_CAUSE,
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  attributeWorkgroupHostRun,
  uniqueAgentMembersOf,
  workgroupHostRunKindOf,
  type ProcessMemberRole,
  type ProcessMetricId,
  type ProcessSubjectRow,
  type ProcessSystemStage,
  type ProcessWorkgroupActorSlice,
  type ProcessWorkgroupMemberRow,
  type ProcessWorkgroupRoundRow,
  type ProcessWorkgroupSummary,
  type WorkflowDefinition,
  type WorkgroupHostRunRoster,
  type WorkgroupMode,
} from '@agent-workflow/shared'
import type {
  ProcessNodeRunRow,
  ProcessTaskUnitRow,
  ProcessWorkgroupAssignmentRow,
  ProcessWorkgroupGateDecisionRow,
  ProcessWorkgroupGateRunRow,
  ProcessWorkgroupRosterRow,
} from '@/platform/contracts/processFacts'
import {
  clarifySummaryOf,
  decisionGateOf,
  gateDurationsOf,
} from '../../../domain/process/gateSummary'
import { hintsOf } from '../../../domain/process/hints'
import type {
  ProcessGateRound,
  ProcessStage,
  ProcessUnitFacts,
} from '../../../domain/process/model'
import { systemStage, systemStageOf } from '../../../domain/process/stages'
import { stageRowsOf, stageTotalsOf } from '../../../domain/process/stageSummary'
import { apportion, mean, ratio, statOf, sum } from '../../../domain/process/stats'
import {
  commonMetrics,
  timeSplitOf,
  waitShareOf,
  type ProcessUnitNumbers,
  type ProcessUnitRowExtras,
} from '../../../domain/process/unitSummary'
import type { NodeRunUsage } from '../../ports/callStore'
import {
  chunked,
  groupBy,
  loadTaskBundle,
  type ProcessDepth,
  type ProcessSources,
} from '../sources'
import {
  baseSummary,
  clarifyHintFacts,
  firstPassUnitsOf,
  gateHintFacts,
  stageHintFacts,
  topWaitOf,
  type SummaryFrame,
} from '../summaryBase'
import { referencedStages } from './workflow'
import { taskUnitFacts, unitOfTask } from './taskUnits'

export const LEADER_STAGE = 'leader'
/** List depth cannot tell members apart; all member work sits on this stage. */
const MEMBERS_STAGE = 'members'
/** Per-person detail hidden: every human member is folded into this row. */
const HUMANS_STAGE = 'member-human'
const memberStage = (memberId: string) => `member:${memberId}`

interface RoundTotals {
  assignments: number
  startedAt: number | null
  finishedAt: number | null
  tokens: number
  leaderTokens: number
}

export interface WorkgroupUnitExtras extends ProcessUnitRowExtras {
  readonly mode: WorkgroupMode | null
  readonly leaderTokens: number
  readonly humanMessages: number
  readonly configChanges: number
  readonly maxRounds: number | null
  readonly assignmentsBySource: Readonly<Record<'leader' | 'human' | 'self', number>>
  /** Assignments and clarify rounds by member stage. */
  readonly assignmentsByStage: ReadonlyMap<string, number>
  readonly clarifyByStage: ReadonlyMap<string, number>
  readonly roundTotals: ReadonlyMap<number, RoundTotals>
  /** Member stages present in this unit's roster. */
  readonly stages: ReadonlySet<string>
  /** Turns re-run because their output did not follow the turn protocol, by stage. */
  readonly protocolRetries: ReadonlyMap<string, number>
}

/** Only leader dispatch has a leader: the other modes store one at most, and never run it. */
const isLed = (mode: WorkgroupMode | null | undefined): boolean => mode === 'leader_worker'

export interface WorkgroupLoad {
  readonly facts: readonly ProcessUnitFacts[]
  readonly extras: ReadonlyMap<string, WorkgroupUnitExtras>
  /** Leader, members and other stages seen, with names from the newest roster that has them. */
  readonly stages: readonly ProcessStage[]
  /** Role note and human account by member stage. */
  readonly members: ReadonlyMap<
    string,
    { readonly role: ProcessMemberRole; readonly roleNote: string | null }
  >
}

function isCapped(row: ProcessTaskUnitRow, roster: ProcessWorkgroupRosterRow | undefined): boolean {
  if (roster?.pauseReason === 'max-rounds-wrapup') return true
  // The turn engine fails the task with this summary when the leader runs out of rounds.
  return row.status === 'failed' && (row.errorSummary ?? '').startsWith('workgroup hit max_rounds')
}

function rosterOf(
  roster: ProcessWorkgroupRosterRow | undefined,
  assignments: readonly ProcessWorkgroupAssignmentRow[],
): WorkgroupHostRunRoster {
  return {
    leaderMemberId: roster?.leaderMemberId ?? null,
    assignmentIds: new Set(assignments.map((assignment) => assignment.assignmentId)),
    uniqueAgentMemberById: uniqueAgentMembersOf(roster?.members ?? []),
  }
}

/** Pair each closed completion gate with the decision written while it was open. */
function completionGates(
  runs: readonly ProcessWorkgroupGateRunRow[],
  decisions: readonly ProcessWorkgroupGateDecisionRow[],
): ProcessGateRound[] {
  const sorted = [...runs].sort((a, b) => a.openedAt - b.openedAt)
  const pending = [...decisions].sort((a, b) => a.at - b.at)
  let ordinal = 0
  return sorted.map((run, index): ProcessGateRound => {
    const nextOpen = sorted[index + 1]?.openedAt ?? Infinity
    const position = pending.findIndex(
      (decision) => decision.at >= run.openedAt && decision.at <= nextOpen,
    )
    // A holder the platform closed when the task ended was never decided: it takes no decision.
    const decision = run.canceled || position < 0 ? undefined : pending.splice(position, 1)[0]
    return {
      stageKey: LEADER_STAGE,
      relatedStageKey: null,
      kind: 'completion',
      subject: null,
      instanceKey: 'completion',
      ordinal: run.canceled ? 0 : ++ordinal,
      void: run.canceled,
      openedAt: run.openedAt,
      closedAt: run.closedAt,
      outcome: run.canceled
        ? 'canceled'
        : run.closedAt === null || decision === undefined
          ? null
          : decision.approved
            ? 'approved'
            : 'rejected',
      deciderUserId: decision?.userId ?? null,
      round: run.round,
      mindmap: false,
      measures: {},
      people: [],
    }
  })
}

/** Every closed plan confirmation but the last was a rejection, as many as the task recorded. */
function planGates(
  runs: readonly ProcessWorkgroupGateRunRow[],
  rejections: number,
): ProcessGateRound[] {
  const sorted = [...runs].sort((a, b) => a.openedAt - b.openedAt)
  let left = rejections
  let ordinal = 0
  return sorted.map((run): ProcessGateRound => {
    // A confirmation the platform closed when the task ended is neither a rejection nor an approval.
    const closed = run.closedAt !== null && !run.canceled
    const rejected = closed && left > 0
    if (rejected) left--
    return {
      stageKey: 'system:orchestrator',
      relatedStageKey: null,
      kind: 'plan-confirm',
      subject: null,
      instanceKey: 'plan-confirm',
      ordinal: run.canceled ? 0 : ++ordinal,
      void: run.canceled,
      openedAt: run.openedAt,
      closedAt: run.closedAt,
      outcome: run.canceled ? 'canceled' : !closed ? null : rejected ? 'rejected' : 'approved',
      deciderUserId: null,
      round: run.round,
      mindmap: false,
      measures: {},
      people: [],
    }
  })
}

export async function loadWorkgroupUnits(
  sources: ProcessSources,
  rows: readonly ProcessTaskUnitRow[],
  depth: ProcessDepth,
  options: { readonly people: boolean },
): Promise<WorkgroupLoad> {
  const taskIds = rows.map((row) => row.taskId)
  const full = depth === 'full'
  const [bundle, usageSince, rosterRows, assignmentRows, gateRuns, gateDecisions, activity] =
    await Promise.all([
      loadTaskBundle(sources, taskIds, depth),
      sources.calls.usageSince(),
      chunked(taskIds, (chunk) => sources.workgroups.rosters(chunk)),
      chunked(taskIds, (chunk) => sources.workgroups.assignments(chunk)),
      chunked(taskIds, (chunk) => sources.workgroups.gateRuns(chunk)),
      chunked(taskIds, (chunk) => sources.workgroups.gateDecisions(chunk)),
      chunked(taskIds, (chunk) => sources.workgroups.activity(chunk)),
    ])
  const rosters = new Map(rosterRows.map((row) => [row.taskId, row]))
  const assignments = groupBy(assignmentRows, (row) => row.taskId)
  const gateRunsByTask = groupBy(gateRuns, (row) => row.taskId)
  const decisionsByTask = groupBy(gateDecisions, (row) => row.taskId)
  const messages = new Map(activity.map((row) => [row.taskId, row.humanMessages]))

  // List depth has no node runs; leader tokens (the coordination share) need the leader's runs only.
  let leaderRuns = new Map<string, ProcessNodeRunRow[]>()
  let listUsage = new Map<string, NodeRunUsage[]>()
  if (!full) {
    leaderRuns = groupBy(
      await chunked(taskIds, (chunk) =>
        sources.tasks.nodeRuns(chunk, { nodeIds: [WORKGROUP_TURN_LEADER_NODE_ID] }),
      ),
      (row) => row.taskId,
    )
    listUsage = groupBy(
      await chunked(taskIds, (chunk) => sources.calls.usageByNodeRun(chunk)),
      (row) => row.taskId,
    )
  }

  // Dynamic-workflow units: the generated graph's nodes map to members through their agent.
  const definitions = new Map<string, WorkflowDefinition | null>()
  if (full) {
    for (const row of rows) {
      if (row.engineKind !== 'dw-generate') continue
      definitions.set(row.taskId, await sources.tasks.definition(row.taskId))
    }
  }

  const stageNames = new Map<string, ProcessStage>()
  const members = new Map<string, { role: ProcessMemberRole; roleNote: string | null }>()
  const note = (key: string, label: string, role: ProcessMemberRole, roleNote: string | null) => {
    if (stageNames.has(key)) return
    stageNames.set(key, {
      key,
      label,
      kind: role === 'unattributed' ? 'unattributed' : role,
      parentKey: null,
      order: stageNames.size,
      removed: false,
    })
    members.set(key, { role, roleNote })
  }

  const extras = new Map<string, WorkgroupUnitExtras>()
  const facts = rows.map((row): ProcessUnitFacts => {
    const taskId = row.taskId
    const roster = rosters.get(taskId)
    const unitAssignments = assignments.get(taskId) ?? []
    const hostRoster = rosterOf(roster, unitAssignments)
    const humanIds = new Set(
      (roster?.members ?? [])
        .filter((member) => member.memberType === 'human')
        .map((member) => member.id),
    )
    const led = isLed(roster?.mode)
    const stageOfMember = (memberId: string): string => {
      // Outside leader dispatch the stored leader is a member like the others.
      if (led && memberId === hostRoster.leaderMemberId) return LEADER_STAGE
      if (!full) return MEMBERS_STAGE
      return humanIds.has(memberId) && !options.people ? HUMANS_STAGE : memberStage(memberId)
    }
    const unitStages = new Set<string>()
    for (const member of roster?.members ?? []) {
      const key = stageOfMember(member.id)
      unitStages.add(key)
      if (key === LEADER_STAGE) {
        note(LEADER_STAGE, member.displayName ?? LEADER_STAGE, 'leader', member.roleNote)
        // An older unit may have registered the leader without a name; keep the newest real one.
        const existing = stageNames.get(LEADER_STAGE)!
        if (existing.label === LEADER_STAGE && member.displayName)
          stageNames.set(LEADER_STAGE, { ...existing, label: member.displayName })
        continue
      }
      if (key === MEMBERS_STAGE) note(key, key, 'member-agent', null)
      else if (key === HUMANS_STAGE) note(key, key, 'member-human', null)
      else
        note(
          key,
          member.displayName ?? member.agentName ?? member.id,
          member.memberType === 'human' ? 'member-human' : 'member-agent',
          member.roleNote,
        )
    }

    const agentMember = hostRoster.uniqueAgentMemberById
    const definition = definitions.get(taskId) ?? null
    const agentOfNode = new Map(
      (definition?.nodes ?? []).flatMap((node) =>
        node.agentId ? [[node.id, node.agentId] as const] : [],
      ),
    )
    const stageOfNode = (nodeId: string): string => {
      if (nodeId === WORKGROUP_TURN_LEADER_NODE_ID) return LEADER_STAGE
      if (nodeId === WORKGROUP_TURN_MEMBER_NODE_ID)
        return full ? PROCESS_UNATTRIBUTED_STAGE : MEMBERS_STAGE
      const system = systemStageOf(nodeId)
      if (system !== null) return system
      const agentId = agentOfNode.get(nodeId)
      const memberId = agentId === undefined ? null : (agentMember.get(agentId) ?? null)
      return memberId === null ? PROCESS_UNATTRIBUTED_STAGE : stageOfMember(memberId)
    }
    const stageOfRun = (run: ProcessNodeRunRow): string => {
      const attribution = attributeWorkgroupHostRun(run, hostRoster)
      return attribution === null ? stageOfNode(run.nodeId) : stageOfMember(attribution.memberId)
    }
    const runs = bundle.nodeRuns.get(taskId) ?? []
    const askerStage = (nodeId: string | null, shardKey: string | null): string => {
      if (nodeId === null) return PROCESS_UNATTRIBUTED_STAGE
      if (nodeId === WORKGROUP_TURN_LEADER_NODE_ID) return LEADER_STAGE
      const asking = runs.find((run) => run.nodeId === nodeId && run.shardKey === shardKey)
      return asking === undefined ? stageOfNode(nodeId) : stageOfRun(asking)
    }

    const extraGates: ProcessGateRound[] = [
      ...completionGates(
        (gateRunsByTask.get(taskId) ?? []).filter((run) => run.kind === 'completion'),
        decisionsByTask.get(taskId) ?? [],
      ),
      ...planGates(
        (gateRunsByTask.get(taskId) ?? []).filter((run) => run.kind === 'plan-confirm'),
        roster?.planRejections ?? 0,
      ),
    ]
    for (const assignment of unitAssignments) {
      if (assignment.assigneeMemberId === null || !humanIds.has(assignment.assigneeMemberId))
        continue
      const canceled = assignment.status === 'canceled'
      extraGates.push({
        stageKey: stageOfMember(assignment.assigneeMemberId),
        relatedStageKey: null,
        kind: 'delivery',
        subject: null,
        instanceKey: assignment.assignmentId,
        ordinal: canceled ? 0 : 1,
        void: canceled,
        openedAt: assignment.createdAt,
        closedAt: assignment.deliveredAt ?? (canceled ? assignment.updatedAt : null),
        outcome: assignment.deliveredAt !== null ? 'delivered' : canceled ? 'canceled' : null,
        deciderUserId: assignment.deliveredByUserId,
        round: assignment.round,
        mindmap: false,
        measures: {},
        people: [],
      })
    }

    const unitFacts = taskUnitFacts({
      unit: unitOfTask(row),
      bundle,
      depth,
      usageSince,
      resolvers: {
        stageOfNode,
        stageOfRun,
        roundOfRun: (run) => run.wgRound,
        stageOfGate: (gate) => {
          const stage = askerStage(gate.relatedNodeId, gate.askingShardKey)
          return { stageKey: stage, relatedStageKey: stage }
        },
      },
      extraGates,
    })
    for (const key of referencedStages([unitFacts])) {
      if (stageNames.has(key)) continue
      // Platform work is not a member: it keeps its own kind, and with it its product name.
      if ((PROCESS_SYSTEM_STAGES as readonly string[]).includes(key))
        stageNames.set(key, systemStage(key as ProcessSystemStage, 1_000_000 + stageNames.size))
      else if (key === LEADER_STAGE) note(key, key, 'leader', null)
      else
        note(key, key, key === PROCESS_UNATTRIBUTED_STAGE ? 'unattributed' : 'member-agent', null)
    }
    // Protocol retries are told apart by their raw cause: the engine's classes fold them
    // together with retries of a process that failed.
    const protocolRetries = new Map<string, number>()
    const protocolRetry = (stageKey: string, count: number) =>
      protocolRetries.set(stageKey, (protocolRetries.get(stageKey) ?? 0) + count)
    if (full) {
      for (const run of bundle.nodeRuns.get(taskId) ?? [])
        if (run.rerunCause === WORKGROUP_PROTOCOL_RETRY_RERUN_CAUSE)
          protocolRetry(stageOfRun(run), 1)
    } else {
      for (const group of bundle.executions.get(taskId) ?? [])
        if (group.rerunCause === WORKGROUP_PROTOCOL_RETRY_RERUN_CAUSE)
          protocolRetry(stageOfNode(group.nodeId), group.runs)
    }

    // Rounds: the highest round a leader turn ran in.
    const rounds = unitFacts.executions
      .filter((item) => item.stageKey === LEADER_STAGE && item.round !== null)
      .reduce((max, item) => Math.max(max, item.round ?? 0), 0)
    const usageRows = full ? (bundle.usage.get(taskId) ?? []) : (listUsage.get(taskId) ?? [])
    const runById = new Map(
      (full ? runs : (leaderRuns.get(taskId) ?? [])).map((run) => [run.nodeRunId, run]),
    )
    const roundTotals = new Map<number, RoundTotals>()
    const roundOf = (round: number) => {
      let entry = roundTotals.get(round)
      if (!entry) {
        entry = { assignments: 0, startedAt: null, finishedAt: null, tokens: 0, leaderTokens: 0 }
        roundTotals.set(round, entry)
      }
      return entry
    }
    let leaderTokens = 0
    for (const usage of usageRows) {
      const run = usage.nodeRunId === null ? undefined : runById.get(usage.nodeRunId)
      if (run === undefined || usage.purpose === 'system') continue
      const leader = run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID
      if (leader) leaderTokens += usage.tokens
      if (!full || run.wgRound === null) continue
      const entry = roundOf(run.wgRound)
      entry.tokens += usage.tokens
      if (leader) entry.leaderTokens += usage.tokens
    }
    if (full) {
      for (const run of runs) {
        if (run.wgRound === null || run.startedAt === null) continue
        // Every turn of the round counts, also one that cannot be told apart between two members
        // sharing an agent; a gate holder is nobody's turn.
        if (workgroupHostRunKindOf(run, hostRoster.assignmentIds) === null) continue
        const entry = roundOf(run.wgRound)
        entry.startedAt =
          entry.startedAt === null ? run.startedAt : Math.min(entry.startedAt, run.startedAt)
        if (run.finishedAt !== null)
          entry.finishedAt =
            entry.finishedAt === null ? run.finishedAt : Math.max(entry.finishedAt, run.finishedAt)
      }
    }
    const bySource = { leader: 0, human: 0, self: 0 }
    const assignmentsByStage = new Map<string, number>()
    for (const assignment of unitAssignments) {
      if (assignment.source === 'leader') bySource.leader++
      else if (assignment.source === 'human') bySource.human++
      else if (assignment.source === 'self_claim') bySource.self++
      if (assignment.round > 0) roundOf(assignment.round).assignments++
      if (assignment.assigneeMemberId === null) continue
      const key = stageOfMember(assignment.assigneeMemberId)
      assignmentsByStage.set(key, (assignmentsByStage.get(key) ?? 0) + 1)
    }
    const clarifyByStage = new Map<string, number>()
    for (const gate of unitFacts.gates) {
      if (gate.kind !== 'clarify' || gate.void || gate.inherited === true) continue
      clarifyByStage.set(gate.stageKey, (clarifyByStage.get(gate.stageKey) ?? 0) + 1)
    }
    extras.set(taskId, {
      mode: roster?.mode ?? null,
      rounds: roster?.mode === 'leader_worker' || rounds > 0 ? rounds : null,
      assignments: unitAssignments.length,
      completionRejections: extraGates.filter(
        (gate) => gate.kind === 'completion' && gate.outcome === 'rejected',
      ).length,
      capped: isCapped(row, roster),
      rework: [],
      leaderTokens,
      humanMessages: messages.get(taskId) ?? 0,
      configChanges: Math.max(0, (roster?.configRevision ?? 1) - 1),
      maxRounds: roster?.maxRounds ?? null,
      assignmentsBySource: bySource,
      assignmentsByStage,
      clarifyByStage,
      roundTotals,
      stages: unitStages,
      protocolRetries,
    })
    return unitFacts
  })

  return { facts, extras, stages: [...stageNames.values()], members }
}

const endedOf = (numbers: readonly ProcessUnitNumbers[]) =>
  numbers.filter((item) => item.facts.unit.status !== 'active')

/** Protocol retries of one unit: of every stage, or of one. */
function protocolRetriesOf(extra: WorkgroupUnitExtras | undefined, stageKey?: string): number {
  if (extra === undefined) return 0
  if (stageKey !== undefined) return extra.protocolRetries.get(stageKey) ?? 0
  return sum(
    [...extra.protocolRetries]
      .filter(([key]) => !key.startsWith('system:'))
      .map(([, count]) => count),
  )
}

function workgroupMetrics(
  numbers: readonly ProcessUnitNumbers[],
  extras: ReadonlyMap<string, WorkgroupUnitExtras>,
): Partial<Record<ProcessMetricId, number | null>> {
  const ended = endedOf(numbers)
  const extra = (item: ProcessUnitNumbers) => extras.get(item.facts.unit.id)
  const rounds = ended.flatMap((item) => {
    const value = extra(item)?.rounds
    return value == null ? [] : [value]
  })
  // Coordination is what a leader costs: a task without one has no share to state, not a zero.
  const led = numbers.filter((item) => item.tokenSample && isLed(extra(item)?.mode))
  // Every run of the group itself: the leader, the members, and member runs that cannot be told
  // apart (an agent two members share). Platform work is not a turn and cannot retry the protocol.
  const hostRuns = numbers.flatMap((item) =>
    item.facts.executions.filter((execution) => !execution.stageKey.startsWith('system:')),
  )
  return {
    roundsPerUnit: mean(rounds),
    roundCapRate: ratio(ended.filter((item) => extra(item)?.capped === true).length, ended.length),
    assignmentsPerUnit: mean(ended.map((item) => extra(item)?.assignments ?? 0)),
    coordinationShare: ratio(
      sum(led.map((item) => extra(item)?.leaderTokens ?? 0)),
      sum(led.map((item) => item.facts.usageTotals.tokens)),
    ),
    protocolRetryRate: ratio(
      sum(numbers.map((item) => protocolRetriesOf(extra(item)))),
      sum(hostRuns.map((run) => run.runs)),
    ),
  }
}

function actorSlices(
  numbers: readonly ProcessUnitNumbers[],
  hasLeader: boolean,
): ProcessWorkgroupActorSlice[] {
  const sample = numbers.filter((item) => item.tokenSample)
  const actors = ['leader', 'member', 'system', 'unattributed'] as const
  const totals = new Map<(typeof actors)[number], { tokens: number; costNano: number }>()
  for (const item of sample) {
    for (const slice of item.facts.usage) {
      const actor =
        slice.cause === 'system' || slice.stageKey.startsWith('system:')
          ? 'system'
          : slice.stageKey === LEADER_STAGE
            ? 'leader'
            : slice.stageKey === PROCESS_UNATTRIBUTED_STAGE
              ? 'unattributed'
              : 'member'
      const previous = totals.get(actor)
      totals.set(actor, {
        tokens: (previous?.tokens ?? 0) + slice.tokens,
        costNano: (previous?.costNano ?? 0) + slice.costNano,
      })
    }
  }
  const perUnit = (values: readonly number[]) =>
    apportion(sample.length ? Math.round(sum(values) / sample.length) : 0, values)
  const tokens = perUnit(actors.map((actor) => totals.get(actor)?.tokens ?? 0))
  const cost = perUnit(actors.map((actor) => totals.get(actor)?.costNano ?? 0))
  return actors
    .map((actor, index) => ({ actor, tokens: tokens[index]!, costNano: cost[index]! }))
    .filter(
      (slice) =>
        slice.tokens > 0 || slice.actor === 'member' || (slice.actor === 'leader' && hasLeader),
    )
}

function roundRows(
  numbers: readonly ProcessUnitNumbers[],
  extras: ReadonlyMap<string, WorkgroupUnitExtras>,
): ProcessWorkgroupRoundRow[] {
  const units = endedOf(numbers).flatMap((item) => {
    const extra = extras.get(item.facts.unit.id)
    return extra && extra.mode === 'leader_worker' && (extra.rounds ?? 0) > 0 ? [extra] : []
  })
  const last = units.reduce((max, extra) => Math.max(max, extra.rounds ?? 0), 0)
  const rows: ProcessWorkgroupRoundRow[] = []
  for (let round = 1; round <= last; round++) {
    const reached = units.filter((extra) => (extra.rounds ?? 0) >= round)
    const totals = reached.map((extra) => extra.roundTotals.get(round))
    const durations = totals.flatMap((entry) =>
      entry && entry.startedAt !== null && entry.finishedAt !== null
        ? [Math.max(0, entry.finishedAt - entry.startedAt)]
        : [],
    )
    const tokens = sum(totals.map((entry) => entry?.tokens ?? 0))
    const duration = mean(durations)
    rows.push({
      round,
      units: reached.length,
      assignmentsMean: ratio(sum(totals.map((entry) => entry?.assignments ?? 0)), reached.length),
      durationMs: duration === null ? null : Math.round(duration),
      tokens: reached.length ? Math.round(tokens / reached.length) : null,
      leaderTokenShare: ratio(sum(totals.map((entry) => entry?.leaderTokens ?? 0)), tokens),
    })
  }
  return rows
}

function memberRows(
  load: WorkgroupLoad,
  numbers: readonly ProcessUnitNumbers[],
  now: number,
): ProcessWorkgroupMemberRow[] {
  const facts = numbers.map((item) => item.facts)
  const rows = stageRowsOf({ stages: load.stages, numbers, now })
  const totals = stageTotalsOf(numbers, now).totals
  return rows
    .filter((row) => !row.key.startsWith('system:'))
    .map((row): ProcessWorkgroupMemberRow => {
      const member = load.members.get(row.key)
      const role: ProcessMemberRole =
        member?.role ?? (row.key === PROCESS_UNATTRIBUTED_STAGE ? 'unattributed' : 'member-agent')
      const present = numbers.filter((item) =>
        load.extras.get(item.facts.unit.id)?.stages.has(row.key),
      )
      const perUnit = (pick: (extra: WorkgroupUnitExtras) => number | undefined) =>
        ratio(
          sum(present.map((item) => pick(load.extras.get(item.facts.unit.id)!) ?? 0)),
          present.length,
        )
      const deliveries = facts.flatMap((unit) =>
        unit.gates
          .filter(
            (gate) =>
              gate.kind === 'delivery' &&
              gate.stageKey === row.key &&
              !gate.void &&
              gate.closedAt !== null,
          )
          .map((gate) => Math.max(0, gate.closedAt! - gate.openedAt)),
      )
      return {
        key: row.key,
        name: typeof row.label === 'string' && row.label !== row.key ? row.label : null,
        role,
        roleNote: member?.roleNote ?? null,
        assignmentsPerUnit:
          role === 'leader' ? null : perUnit((extra) => extra.assignmentsByStage.get(row.key)),
        durationMs: row.durationMs,
        tokensPerUnit: role === 'member-human' ? null : row.tokensPerUnit,
        failureRate: row.failureRate,
        protocolRetryRate: ratio(
          sum(
            numbers.map((item) => protocolRetriesOf(load.extras.get(item.facts.unit.id), row.key)),
          ),
          totals.get(row.key)?.runs ?? 0,
        ),
        clarifyPerUnit: perUnit((extra) => extra.clarifyByStage.get(row.key)),
        deliveryMs: statOf(deliveries),
      }
    })
    .filter(
      (row) =>
        row.role === 'leader' ||
        row.role === 'member-human' ||
        row.durationMs.n > 0 ||
        (row.assignmentsPerUnit ?? 0) > 0 ||
        (row.tokensPerUnit ?? 0) > 0,
    )
}

export function workgroupSummary(input: {
  readonly frame: SummaryFrame
  readonly load: WorkgroupLoad
  readonly current: readonly ProcessUnitNumbers[]
  readonly baseline: readonly ProcessUnitNumbers[] | null
  /** Extras of the baseline units when they come from another load (period comparison). */
  readonly baselineExtras: ReadonlyMap<string, WorkgroupUnitExtras> | null
  readonly people: boolean
  readonly now: number
}): ProcessWorkgroupSummary {
  const { load, current, baseline, now } = input
  const facts = current.map((item) => item.facts)
  const ended = endedOf(current)
  const extra = (item: ProcessUnitNumbers) => load.extras.get(item.facts.unit.id)
  const mode = current.map(extra).find((value) => value?.mode != null)?.mode ?? null
  const metrics = { ...commonMetrics(current), ...workgroupMetrics(current, load.extras) }
  const completion = decisionGateOf(facts, 'completion')
  const planConfirm = decisionGateOf(facts, 'plan-confirm')
  const clarify = clarifySummaryOf(facts, { people: input.people })
  const time = timeSplitOf(current)
  const topWait = topWaitOf(time)
  const deliveries = gateDurationsOf(facts, 'delivery')
  const deliveryWait = time.waits.find((wait) => wait.kind === 'delivery')?.ms ?? 0
  const freeCollab = ended.filter((item) => extra(item)?.mode === 'free_collab')
  const members = memberRows(load, current, now)
  const hints = hintsOf({
    kind: 'workgroup',
    units: current.length,
    succeededUnits: current.filter((item) => item.facts.unit.status === 'succeeded').length,
    waitShare: waitShareOf(current),
    topWaitKind: topWait.kind,
    topWaitShare: topWait.share,
    gates: gateHintFacts(facts, ['delivery', 'completion', 'plan-confirm', 'clarify']),
    stages: stageHintFacts(stageTotalsOf(current, now).totals),
    reworkTokenShare: null,
    reworkTokens: 0,
    reworkCostNano: 0,
    clarify: clarifyHintFacts(clarify),
    firstPassRate: metrics.firstPassRate ?? null,
    firstPassUnits: firstPassUnitsOf(current),
    coordinationShare: metrics.coordinationShare ?? null,
    completion:
      completion === null
        ? null
        : {
            rounds: completion.rounds,
            rejectRate: completion.rejectRate,
            extraRounds: completion.extraRoundsAfterReject,
          },
    delivery:
      deliveries.length === 0
        ? null
        : {
            p50: statOf(deliveries).p50,
            waitShare: time.leadMs ? deliveryWait / time.leadMs : null,
          },
    blocked: null,
  })
  const clarifyRounds = (leader: boolean) =>
    ratio(
      sum(
        ended.map((item) =>
          sum(
            [...(extra(item)?.clarifyByStage ?? new Map<string, number>())]
              .filter(([key]) => (key === LEADER_STAGE) === leader)
              .map(([, rounds]) => rounds),
          ),
        ),
      ),
      ended.length,
    )
  const perEnded = (pick: (value: WorkgroupUnitExtras) => number) =>
    ratio(sum(ended.map((item) => pick(extra(item)!))), ended.length)
  return {
    ...baseSummary(input.frame, current, baseline, {
      metrics: workgroupMetrics(current, load.extras),
      baselineMetrics:
        baseline === null ? null : workgroupMetrics(baseline, input.baselineExtras ?? load.extras),
      hints,
      revisionUnits: [],
    }),
    kind: 'workgroup',
    mode,
    actors: actorSlices(
      current,
      current.some((item) => isLed(extra(item)?.mode)),
    ),
    rounds: mode === 'leader_worker' ? roundRows(current, load.extras) : [],
    budget:
      freeCollab.length === 0
        ? null
        : {
            usedMean: mean(
              freeCollab.map((item) =>
                sum(
                  item.facts.executions
                    .filter(
                      (execution) =>
                        execution.stageKey !== LEADER_STAGE &&
                        !execution.stageKey.startsWith('system:') &&
                        execution.cause !== 'auto-retry',
                    )
                    .map((execution) => execution.runs),
                ),
              ),
            ),
            limitMean: mean(
              freeCollab.flatMap((item) => {
                const limit = extra(item)?.maxRounds
                return limit == null ? [] : [limit]
              }),
            ),
          },
    assignmentSources: {
      leader: perEnded((value) => value.assignmentsBySource.leader),
      human: perEnded((value) => value.assignmentsBySource.human),
      self: perEnded((value) => value.assignmentsBySource.self),
    },
    members,
    human: {
      messagesPerUnit: perEnded((value) => value.humanMessages),
      directAssignmentsPerUnit: perEnded((value) => value.assignmentsBySource.human),
      configChangesPerUnit: perEnded((value) => value.configChanges),
      deliveryMs: statOf(deliveries),
    },
    completion,
    planConfirm,
    clarify,
    clarifyByAsker:
      clarify === null ? null : { leader: clarifyRounds(true), member: clarifyRounds(false) },
  }
}

/** One listing row per workgroup among the units. */
export function workgroupSubjectRows(
  numbers: readonly ProcessUnitNumbers[],
  extras: ReadonlyMap<string, WorkgroupUnitExtras>,
  names: ReadonlyMap<string, string | null>,
): ProcessSubjectRow[] {
  const bySubject = groupBy(numbers, (item) => item.facts.unit.subjectId ?? '')
  return [...bySubject].map(([key, items]): ProcessSubjectRow => {
    const metrics = { ...commonMetrics(items), ...workgroupMetrics(items, extras) }
    return {
      subjectId: key === '' ? null : key,
      name: names.get(key) ?? null,
      units: items.length,
      successRate: metrics.successRate ?? null,
      leadP50: metrics.leadP50 ?? null,
      waitShare: waitShareOf(items),
      tokensPerUnit: metrics.tokensPerUnit ?? null,
      costNanoPerUnit: metrics.costNanoPerUnit ?? null,
      interventionsPerUnit: metrics.interventionsPerUnit ?? null,
      firstPassRate: metrics.firstPassRate ?? null,
      // Rows are newest first: the listing shows the mode the group runs in now.
      mode:
        items.map((item) => extras.get(item.facts.unit.id)?.mode).find((mode) => mode != null) ??
        null,
      roundsPerUnit: metrics.roundsPerUnit ?? null,
      assignmentsPerUnit: metrics.assignmentsPerUnit ?? null,
      coordinationShare: metrics.coordinationShare ?? null,
      mergeRate: null,
      blockedRate: null,
    }
  })
}
