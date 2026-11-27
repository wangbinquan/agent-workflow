// RFC-616 §6.2 — workgroup facts offered to process metrics through the neutral
// platform contract (`platform/contracts/processFacts.ts`). The workgroup ledgers
// (running configuration, assignments, room messages, gate holder runs) belong
// to task execution; process metrics never read them directly.

import {
  parseDwState,
  workgroupLaunchMode,
  type RerunCause,
  type WorkgroupRuntimeMember,
} from '@agent-workflow/shared'
import { and, asc, count, eq, inArray } from 'drizzle-orm'

import type {
  ProcessTextItem,
  ProcessWorkgroupActivityRow,
  ProcessWorkgroupAssignmentRow,
  ProcessWorkgroupFacts,
  ProcessWorkgroupGateDecisionRow,
  ProcessWorkgroupGateRunRow,
  ProcessWorkgroupMember,
  ProcessWorkgroupRosterRow,
} from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { processFactIds } from './processTaskFacts'
import { taskWorkgroupConfigFromRow, taskWorkgroupConfigSelection } from './taskWorkgroupConfig'

// The two holder runs a workgroup task parks on while a person decides: the
// completion gate of the turn modes and the plan confirmation of a dynamic workflow.
const COMPLETION_GATE_CAUSE = 'wg-gate' satisfies RerunCause
const PLAN_CONFIRM_CAUSE = 'dw-gate' satisfies RerunCause

// A completion-gate decision is recorded by the task room's confirm command as
// a `system` message authored by the deciding person, with one of these two
// bodies. Only system-authored messages may carry a template key, so the body
// is the one marker the ledger keeps; the room's other human-authored `system`
// message ("config updated: …") does not match either.
const GATE_APPROVED_BODY = 'completion gate APPROVED'
const GATE_REJECTED_PREFIX = 'completion gate REJECTED: '

type MessageKind = PersistenceTables['workgroupMessages']['$inferSelect']['kind']
/** What people say to the group: plain talk, and talk that hands a member work. */
const HUMAN_TALK_KINDS: readonly MessageKind[] = ['chat', 'dispatch']

interface GateDecision {
  readonly approved: boolean
  /** The reason given with a rejection; empty for an approval. */
  readonly comment: string
}

function gateDecisionOf(body: string): GateDecision | null {
  if (body === GATE_APPROVED_BODY) return { approved: true, comment: '' }
  if (body.startsWith(GATE_REJECTED_PREFIX))
    return { approved: false, comment: body.slice(GATE_REJECTED_PREFIX.length) }
  return null
}

function memberOf(member: WorkgroupRuntimeMember): ProcessWorkgroupMember {
  return {
    id: member.id,
    memberType: member.memberType,
    displayName: member.displayName,
    agentId: member.agentId ?? null,
    agentName: member.agentName,
    userId: member.userId,
    roleNote: member.roleDesc.length > 0 ? member.roleDesc : null,
  }
}

/** Rejected plans so far; a task that is not a dynamic workflow has no such state. */
function planRejectionsOf(dwStateJson: string | null): number {
  if (dwStateJson === null) return 0
  try {
    return parseDwState(JSON.parse(dwStateJson))?.rejectRounds ?? 0
  } catch {
    return 0
  }
}

export function createProcessWorkgroupFacts(db: PersistenceDb): ProcessWorkgroupFacts {
  /** Messages people wrote in the rooms, oldest first per task. */
  async function humanMessages(taskIds: readonly string[], kinds: readonly MessageKind[]) {
    const { workgroupMessages } = tablesOf(db)
    return await db
      .select({
        taskId: workgroupMessages.taskId,
        kind: workgroupMessages.kind,
        userId: workgroupMessages.authorUserId,
        body: workgroupMessages.bodyMd,
        at: workgroupMessages.createdAt,
      })
      .from(workgroupMessages)
      .where(
        and(
          inArray(workgroupMessages.taskId, [...taskIds]),
          eq(workgroupMessages.authorKind, 'human'),
          inArray(workgroupMessages.kind, [...kinds]),
        ),
      )
      // Ordered by the time each row reports; the id only settles a tie.
      .orderBy(
        asc(workgroupMessages.taskId),
        asc(workgroupMessages.createdAt),
        asc(workgroupMessages.id),
      )
  }

  return {
    async rosters(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const { tasks, taskDefinitions, workgroupTaskState } = tablesOf(db)
      const rows = await db
        .select({
          taskId: tasks.id,
          // Both documents through the one reader of task workgroup configuration.
          config: taskWorkgroupConfigSelection(db),
          pauseReason: workgroupTaskState.pauseReason,
          configRevision: workgroupTaskState.configRevision,
          dwStateJson: workgroupTaskState.dwStateJson,
        })
        .from(tasks)
        .innerJoin(taskDefinitions, eq(taskDefinitions.taskId, tasks.id))
        .leftJoin(workgroupTaskState, eq(workgroupTaskState.taskId, tasks.id))
        .where(and(inArray(tasks.id, ids), eq(taskDefinitions.subjectKind, 'workgroup')))
      return rows.map((row): ProcessWorkgroupRosterRow => {
        // The task room's rule: the running document is the configuration (it
        // starts as the launch snapshot and takes every later edit). The launch
        // document freezes only the group's identity, mode and leader, so it can
        // stand in for those two fields when the running document is unreadable.
        const { launch, runtime } =
          row.config ?? taskWorkgroupConfigFromRow({ workgroupLaunchConfigJson: null })
        const config = runtime.config
        return {
          taskId: row.taskId,
          mode: config === null ? workgroupLaunchMode(launch) : config.mode,
          leaderMemberId: config === null ? launch.leaderMemberId : config.leaderMemberId,
          members: config === null ? [] : config.members.map(memberOf),
          maxRounds: config === null ? null : config.maxRounds,
          pauseReason: row.pauseReason,
          // No state row means the configuration was never edited.
          configRevision: row.configRevision === null ? 1 : Number(row.configRevision),
          planRejections: planRejectionsOf(row.dwStateJson),
        }
      })
    },

    async assignments(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const { workgroupAssignments, workgroupMessages } = tablesOf(db)
      const rows = await db
        .select({
          taskId: workgroupAssignments.taskId,
          assignmentId: workgroupAssignments.id,
          round: workgroupAssignments.round,
          source: workgroupAssignments.source,
          assigneeMemberId: workgroupAssignments.assigneeMemberId,
          status: workgroupAssignments.status,
          createdAt: workgroupAssignments.createdAt,
          updatedAt: workgroupAssignments.updatedAt,
        })
        .from(workgroupAssignments)
        .where(inArray(workgroupAssignments.taskId, ids))
        .orderBy(asc(workgroupAssignments.taskId), asc(workgroupAssignments.id))
      if (!rows.length) return []
      // The assignment row cannot say when a person delivered: its status moves
      // on to `done` once the leader has read the delivery. The delivery message does.
      const deliveries = await db
        .select({
          assignmentId: workgroupMessages.assignmentId,
          userId: workgroupMessages.authorUserId,
          at: workgroupMessages.createdAt,
        })
        .from(workgroupMessages)
        .where(and(inArray(workgroupMessages.taskId, ids), eq(workgroupMessages.kind, 'delivery')))
        .orderBy(asc(workgroupMessages.createdAt), asc(workgroupMessages.id))
      const firstDelivery = new Map<string, (typeof deliveries)[number]>()
      for (const delivery of deliveries)
        if (delivery.assignmentId !== null && !firstDelivery.has(delivery.assignmentId))
          firstDelivery.set(delivery.assignmentId, delivery)
      return rows.map((row): ProcessWorkgroupAssignmentRow => {
        const delivery = firstDelivery.get(row.assignmentId)
        return {
          ...row,
          round: Number(row.round),
          createdAt: Number(row.createdAt),
          updatedAt: Number(row.updatedAt),
          deliveredAt: delivery === undefined ? null : Number(delivery.at),
          deliveredByUserId: delivery?.userId ?? null,
        }
      })
    },

    async gateRuns(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select({
          taskId: nodeRuns.taskId,
          nodeRunId: nodeRuns.id,
          cause: nodeRuns.rerunCause,
          status: nodeRuns.status,
          startedAt: nodeRuns.startedAt,
          finishedAt: nodeRuns.finishedAt,
          round: nodeRuns.wgRound,
          seq: nodeRuns.seq,
        })
        .from(nodeRuns)
        .where(
          and(
            inArray(nodeRuns.taskId, ids),
            inArray(nodeRuns.rerunCause, [COMPLETION_GATE_CAUSE, PLAN_CONFIRM_CAUSE]),
          ),
        )
      // Mint order within each task, sorted on the values read: ranking node runs
      // in SQL is reserved to the owner query (the run-selection boundary).
      rows.sort((a, b) =>
        a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : Number(a.seq) - Number(b.seq),
      )
      return rows.flatMap((row): ProcessWorkgroupGateRunRow[] => {
        // A holder run is minted when its gate opens and every mint stamps the
        // start time, so that is the opening. A row from an older ledger that
        // lacks it is known only by the moment it closed; one with neither
        // cannot be placed in time.
        const openedAt = row.startedAt ?? row.finishedAt
        if (openedAt === null) return []
        return [
          {
            taskId: row.taskId,
            nodeRunId: row.nodeRunId,
            kind: row.cause === COMPLETION_GATE_CAUSE ? 'completion' : 'plan-confirm',
            openedAt: Number(openedAt),
            closedAt: row.finishedAt === null ? null : Number(row.finishedAt),
            round: row.round === null ? null : Number(row.round),
            // A decision closes the holder as done; the sweep that runs when the task ends
            // (canceled, or done past a gate nobody answered) cancels it.
            canceled: row.status === 'canceled',
          },
        ]
      })
    },

    async gateDecisions(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const rows = await humanMessages(ids, ['system'])
      return rows.flatMap((row): ProcessWorkgroupGateDecisionRow[] => {
        const decision = gateDecisionOf(row.body)
        return decision === null
          ? []
          : [
              {
                taskId: row.taskId,
                at: Number(row.at),
                userId: row.userId,
                approved: decision.approved,
              },
            ]
      })
    },

    async activity(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const { workgroupMessages } = tablesOf(db)
      const rows = await db
        .select({ taskId: workgroupMessages.taskId, humanMessages: count() })
        .from(workgroupMessages)
        .where(
          and(
            inArray(workgroupMessages.taskId, ids),
            eq(workgroupMessages.authorKind, 'human'),
            inArray(workgroupMessages.kind, [...HUMAN_TALK_KINDS]),
          ),
        )
        .groupBy(workgroupMessages.taskId)
      const counted = new Map(rows.map((row) => [row.taskId, row.humanMessages]))
      // A room nobody wrote in is a fact too: every asked task gets its count.
      return ids.map(
        (taskId): ProcessWorkgroupActivityRow => ({
          taskId,
          humanMessages: counted.get(taskId) ?? 0,
        }),
      )
    },

    async texts(taskIds) {
      const ids = processFactIds(taskIds)
      if (!ids.length) return []
      const rows = await humanMessages(ids, [...HUMAN_TALK_KINDS, 'system'])
      return rows.flatMap((row): ProcessTextItem[] => {
        // Of the `system` messages only a rejection carries words of its own:
        // an approval and a configuration note leave nothing to analyse.
        const text = row.kind === 'system' ? (gateDecisionOf(row.body)?.comment ?? '') : row.body
        if (text.length === 0) return []
        return [
          {
            source: row.kind === 'system' ? 'workgroup-rejection' : 'workgroup-message',
            taskId: row.taskId,
            caseId: null,
            stageRef: null,
            at: Number(row.at),
            text,
          },
        ]
      })
    },
  }
}
