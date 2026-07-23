// RFC-217 T4 — mid-run config PATCH orchestration (the former 366-line route
// handler), split from taskActions to keep every workgroup module ≤800 lines.

// RFC-217 T4 — workgroup task-room WRITE orchestration, moved verbatim out of
// routes/workgroupTasks.ts (366-line config PUT included). The route layer is
// transport only (params + status codes); every business step — membership
// gate, assignment state machine, room message rows, WS frames, resume kicks —
// lives here. G2 locks the room-table writes to this module.

import {
  workgroupHasHumanMember,
  WORKGROUP_MAX_ROUNDS_LIMIT,
  WorkgroupRuntimeConfigSchema,
} from '@agent-workflow/shared'
import { asc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { z } from 'zod'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  taskCollaborators,
  tasks,
  users,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
} from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { assertNoMissingRefs, resolveRefsUsableById } from '@/services/resourceRefs'
import { ConflictError, ValidationError } from '@/util/errors'
import {
  casAssignmentStatusTx,
  dismissOpenClarifyParksForAutonomous,
} from '@/services/workgroup/lifecycle'
import {} from '@/services/workgroup/state'
import { buildRoomMessageRow } from '@/services/workgroup/messages'
import { resolveRoomMessageRound } from '@/services/workgroup/rounds'

import { broadcastWg } from '@/services/workgroup/taskActions'
import type { buildWorkgroupTaskActions } from '@/services/workgroup/taskActions'

type Core = ReturnType<typeof buildWorkgroupTaskActions>

/** PR-5 中途改配置白名单（design §8.4：mode/leader/repo 不可改）。 */
const ConfigPatchSchema = z.object({
  switches: z
    .object({
      shareOutputs: z.boolean(),
      directMessages: z.boolean(),
      blackboard: z.boolean(),
    })

    .optional(),
  maxRounds: z.number().int().positive().max(WORKGROUP_MAX_ROUNDS_LIMIT).optional(),
  completionGate: z.boolean().optional(),
  // RFC-207 — mid-run ask-back budget, same live-pickup channel as maxRounds
  // (the engine reloads the task config every pass).
  clarifyBudget: z.number().int().min(0).max(50).optional(),
  // RFC-185 D4 — mid-run fan-out toggle, same live-pickup channel. No flip
  // compensation needed: turning OFF lets in-flight instances finish; the
  // leader simply stops being invited to fan out from its next turn.
  fanOut: z.boolean().optional(),
  addMembers: z
    .array(
      z
        .object({
          memberType: z.enum(['agent', 'human']),
          agentId: z.string().min(1).optional(),
          userId: z.string().min(1).optional(),
          displayName: z.string().trim().min(1).max(64),
          roleDesc: z.string().max(2048).default(''),
        })
        .strict()
        .superRefine((member, ctx) => {
          if (member.memberType === 'agent') {
            if (member.agentId === undefined) {
              ctx.addIssue({ code: 'custom', message: 'agent member requires agentId' })
            }
            if (member.userId !== undefined) {
              ctx.addIssue({ code: 'custom', message: 'agent member must not carry userId' })
            }
          } else {
            if (member.userId === undefined) {
              ctx.addIssue({ code: 'custom', message: 'human member requires userId' })
            }
            if (member.agentId !== undefined) {
              ctx.addIssue({ code: 'custom', message: 'human member must not carry agentId' })
            }
          }
        }),
    )
    .max(16)
    .optional(),
  removeMemberIds: z.array(z.string().min(1)).max(64).optional(),
})

const JsonObjectSchema = z.record(z.string(), z.unknown())

export function buildConfigActions(
  deps: { db: DbClient; configPath: string },
  core: Pick<Core, 'loadVisibleWorkgroupTask' | 'kickResumeIfResumable' | 'buildResumeDeps'>,
) {
  const { loadVisibleWorkgroupTask, kickResumeIfResumable } = core
  async function updateTaskConfig(actor: Actor, taskId: string, rawBody: unknown) {
    const { task, config, raw } = await loadVisibleWorkgroupTask(actor, taskId)
    if (task.status === 'done' || task.status === 'failed' || task.status === 'canceled') {
      throw new ConflictError('workgroup-task-terminal', 'cannot edit a finished workgroup task')
    }
    const parsed = ConfigPatchSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('workgroup-config-invalid', 'invalid config patch', {
        issues: parsed.error.issues,
      })
    }
    const patch = parsed.data
    const addedAgentIds = [
      ...new Set(
        (patch.addMembers ?? []).flatMap((member) =>
          member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
        ),
      ),
    ]
    // RFC-223 PR-7: member writes accept only canonical ids. Names are loaded
    // after the ACL decision solely as display snapshots.
    const addedAgentsById = new Map<string, { id: string; name: string }>()
    if (addedAgentIds.length > 0) {
      // Mid-run membership is a new reference just like editing a workgroup
      // resource: reject private agents before the existence check so the
      // response cannot be used to distinguish a hidden row from a typo.
      // Bind authorization to the exact submitted ids. A token that only
      // matches an agent name fails the identity equality check below.
      const resolved = await resolveRefsUsableById(deps.db, actor, 'agent', addedAgentIds)
      assertNoMissingRefs(resolved.missing)
      const missing = addedAgentIds.filter((id) => resolved.byToken.get(id) !== id)
      if (missing.length > 0) {
        throw new ValidationError(
          'workgroup-config-agent-missing',
          `agent member(s) do not exist: ${missing.join(', ')}`,
          { missingAgentIds: missing },
        )
      }
      const rows = await deps.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(inArray(agents.id, addedAgentIds))
      for (const row of rows) addedAgentsById.set(row.id, row)
      const disappeared = addedAgentIds.filter((id) => !addedAgentsById.has(id))
      if (disappeared.length > 0) {
        throw new ValidationError(
          'workgroup-config-agent-missing',
          `agent member(s) do not exist: ${disappeared.join(', ')}`,
          { missingAgentIds: disappeared },
        )
      }
    }
    const changes: string[] = []
    let members = [...config.members]
    // RFC-207 §3.4 — snapshot BEFORE any add/remove: the dismissal below fires
    // only on the >0 → 0 transition, never on a roster that never had humans.
    const hadHumanMember = workgroupHasHumanMember(config.members)
    // RFC-099 audit (2026-07-15): human members added mid-run must also become
    // task_collaborators — canViewTask / room access key off that table, so
    // without this a joiner is "added but can't get in" (launch does this via
    // the T24 union in workgroupLaunch.ts; the mid-run path had missed it).
    const newHumanUserIds: string[] = []
    let removingMemberIds: Set<string> | null = null
    const joinCursors: Array<{ memberId: string; messageId: string }> = []
    const assignmentUpdates: Array<{ assignmentId: string; status: string }> = []

    if (patch.removeMemberIds !== undefined && patch.removeMemberIds.length > 0) {
      const removing = new Set(patch.removeMemberIds)
      removingMemberIds = removing
      if (config.leaderMemberId !== null && removing.has(config.leaderMemberId)) {
        throw new ValidationError('workgroup-config-leader-immutable', 'cannot remove the leader')
      }
      const removed = members.filter((m) => removing.has(m.id))
      members = members.filter((m) => !removing.has(m.id))
      if (members.filter((m) => m.memberType === 'agent').length === 0) {
        throw new ValidationError(
          'workgroup-config-no-agents',
          'removing these members would leave no agent member',
        )
      }
      for (const m of removed) changes.push(`removed @${m.displayName}`)
    }

    if (patch.addMembers !== undefined && patch.addMembers.length > 0) {
      const names = new Set(members.map((m) => m.displayName))
      const maxMsg = (
        await deps.db
          .select({ id: workgroupMessages.id })
          .from(workgroupMessages)
          .where(eq(workgroupMessages.taskId, taskId))
          .orderBy(asc(workgroupMessages.id))
      ).at(-1)?.id
      for (const m of patch.addMembers) {
        if (names.has(m.displayName)) {
          throw new ValidationError(
            'workgroup-config-duplicate-member',
            `displayName '${m.displayName}' already exists in the group`,
          )
        }
        if (m.memberType === 'agent' && !m.agentId) {
          throw new ValidationError('workgroup-config-invalid', 'agent member requires agentId')
        }
        if (m.memberType === 'human') {
          if (!m.userId) {
            throw new ValidationError('workgroup-config-invalid', 'human member requires userId')
          }
          if (m.userId === SYSTEM_USER_ID) {
            throw new ValidationError(
              'workgroup-config-invalid',
              'cannot add the system user as a member',
            )
          }
          // Owner is already a member via ownerUserId (no collaborator row for
          // them); everyone else joins task_collaborators below.
          if (m.userId !== task.ownerUserId && !newHumanUserIds.includes(m.userId)) {
            newHumanUserIds.push(m.userId)
          }
        }
        const id = ulid()
        const addedAgent =
          m.memberType === 'agent' && m.agentId ? (addedAgentsById.get(m.agentId) ?? null) : null
        members.push({
          id,
          memberType: m.memberType,
          agentName: addedAgent?.name ?? null,
          agentId: addedAgent?.id ?? null,
          userId: m.memberType === 'human' ? (m.userId ?? null) : null,
          displayName: m.displayName,
          roleDesc: m.roleDesc,
        })
        names.add(m.displayName)
        changes.push(`added @${m.displayName} (${m.memberType})`)
        // join-no-history: cursor starts AT the current room tail (msghub 语义).
        if (maxMsg !== undefined) {
          joinCursors.push({ memberId: id, messageId: maxMsg })
        }
      }
      // RFC-099 audit: new human members must be active users before they ride
      // into task_collaborators below (same rule launch enforces via T24; also
      // rejects the system user, handled per-member above).
      if (newHumanUserIds.length > 0) {
        const urows = await deps.db
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(inArray(users.id, newHumanUserIds))
        const active = new Set(urows.filter((r) => r.status === 'active').map((r) => r.id))
        for (const uid of newHumanUserIds) {
          if (!active.has(uid)) {
            throw new ValidationError(
              'workgroup-config-invalid',
              `human member '${uid}' is not an active user`,
            )
          }
        }
      }
    }

    if (patch.switches !== undefined) changes.push('switches updated')
    if (patch.maxRounds !== undefined) changes.push(`maxRounds → ${patch.maxRounds}`)
    if (patch.completionGate !== undefined) changes.push(`completionGate → ${patch.completionGate}`)
    if (patch.clarifyBudget !== undefined) changes.push(`clarifyBudget → ${patch.clarifyBudget}`)
    if (patch.fanOut !== undefined) changes.push(`fanOut → ${patch.fanOut}`)
    if (changes.length === 0) {
      throw new ValidationError('workgroup-config-empty', 'nothing to change')
    }
    // Codex T6 impl-gate P2 — merge into a FRESH row inside one sync
    // transaction: `raw` was read before the addMembers awaits above, so a
    // whole-JSON write from it could clobber a concurrent writer (the engine's
    // persistGate — now also reload-and-merge — or another PATCH). Only this
    // handler's own keys ride on top of the fresh base.
    dbTxSync(deps.db, (tx) => {
      const fresh = tx
        .select({ workgroupConfigJson: tasks.workgroupConfigJson })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
      let base: Record<string, unknown> = raw
      if (fresh?.workgroupConfigJson != null) {
        try {
          base = JsonObjectSchema.parse(JSON.parse(fresh.workgroupConfigJson))
        } catch {
          // unreadable fresh JSON — fall back to the handler's earlier read
        }
      }
      const freshConfig = WorkgroupRuntimeConfigSchema.safeParse(base)
      if (!freshConfig.success) {
        throw new ConflictError(
          'workgroup-config-conflict',
          'the workgroup config changed into an unreadable state while editing',
        )
      }
      // Membership operations were validated against the entry snapshot. If
      // another editor changed the roster during the async ACL/user checks,
      // refuse this write instead of replacing their fresh members wholesale.
      if (JSON.stringify(freshConfig.data.members) !== JSON.stringify(config.members)) {
        throw new ConflictError(
          'workgroup-config-conflict',
          'the workgroup roster changed while editing; reload and retry',
        )
      }
      const nextConfig = {
        ...base,
        members,
        ...(patch.switches !== undefined ? { switches: patch.switches } : {}),
        ...(patch.maxRounds !== undefined ? { maxRounds: patch.maxRounds } : {}),
        ...(patch.completionGate !== undefined ? { completionGate: patch.completionGate } : {}),
        ...(patch.clarifyBudget !== undefined ? { clarifyBudget: patch.clarifyBudget } : {}),
        ...(patch.fanOut !== undefined ? { fanOut: patch.fanOut } : {}),
      }
      tx.update(tasks)
        .set({ workgroupConfigJson: JSON.stringify(nextConfig) })
        .where(eq(tasks.id, taskId))
        .run()
      // RFC-099 audit: mirror new human members into task_collaborators in the
      // SAME tx as the config write, so membership and room access stay atomic.
      // onConflictDoNothing dedupes against an existing owner/collaborator row.
      if (newHumanUserIds.length > 0) {
        tx.insert(taskCollaborators)
          .values(
            newHumanUserIds.map((uid) => ({
              taskId,
              userId: uid,
              role: 'collaborator' as const,
              addedBy: actor.user.id,
              addedAt: Date.now(),
            })),
          )
          .onConflictDoNothing()
          .run()
      }

      // Every roster side effect lands in the SAME transaction as the fresh
      // config row. A later validation error / crash can no longer return 422
      // after canceling cards or advancing a joiner's cursor.
      if (removingMemberIds !== null && removingMemberIds.size > 0) {
        const rows = tx
          .select()
          .from(workgroupAssignments)
          .where(eq(workgroupAssignments.taskId, taskId))
          .all()
        for (const assignment of rows) {
          if (
            assignment.assigneeMemberId === null ||
            !removingMemberIds.has(assignment.assigneeMemberId)
          ) {
            continue
          }
          if (
            assignment.status !== 'open' &&
            assignment.status !== 'dispatched' &&
            assignment.status !== 'awaiting_human' &&
            assignment.status !== 'running'
          ) {
            continue
          }
          if (assignment.status === 'running') {
            throw new ConflictError(
              'workgroup-member-running',
              `member '${assignment.assigneeMemberId}' still owns a running assignment`,
            )
          }
          if (config.mode === 'free_collab') {
            if (assignment.status === 'dispatched') {
              if (!casAssignmentStatusTx(tx, assignment.id, 'dispatched', 'failed')) {
                throw new ConflictError(
                  'workgroup-config-conflict',
                  `assignment '${assignment.id}' changed while editing the roster`,
                )
              }
              if (
                !casAssignmentStatusTx(tx, assignment.id, 'failed', 'open', {
                  assigneeMemberId: null,
                  nodeRunId: null,
                })
              ) {
                throw new ConflictError(
                  'workgroup-config-conflict',
                  `assignment '${assignment.id}' changed while editing the roster`,
                )
              }
              assignmentUpdates.push({ assignmentId: assignment.id, status: 'open' })
            } else if (assignment.status === 'awaiting_human') {
              if (
                !casAssignmentStatusTx(tx, assignment.id, 'awaiting_human', 'open', {
                  assigneeMemberId: null,
                  nodeRunId: null,
                })
              ) {
                throw new ConflictError(
                  'workgroup-config-conflict',
                  `assignment '${assignment.id}' changed while editing the roster`,
                )
              }
              assignmentUpdates.push({ assignmentId: assignment.id, status: 'open' })
            }
          } else if (assignment.status !== 'open') {
            if (!casAssignmentStatusTx(tx, assignment.id, assignment.status, 'canceled')) {
              throw new ConflictError(
                'workgroup-config-conflict',
                `assignment '${assignment.id}' changed while editing the roster`,
              )
            }
            assignmentUpdates.push({ assignmentId: assignment.id, status: 'canceled' })
          } else if (casAssignmentStatusTx(tx, assignment.id, 'open', 'canceled')) {
            assignmentUpdates.push({ assignmentId: assignment.id, status: 'canceled' })
          }
        }
      }
      for (const cursor of joinCursors) {
        tx.insert(workgroupMemberCursors)
          .values({
            taskId,
            memberId: cursor.memberId,
            lastConsumedMessageId: cursor.messageId,
            updatedAt: Date.now(),
          })
          .onConflictDoNothing()
          .run()
      }
    })
    for (const update of assignmentUpdates) {
      broadcastWg(taskId, {
        type: 'wg.assignment.updated',
        assignmentId: update.assignmentId,
        status: update.status,
      })
    }
    // RFC-207 §3.4 (inherits RFC-181 A2, design-gate P0) — losing the LAST human
    // member dismisses in-flight clarify parks, so removing the humans works on a
    // task that is ALREADY parked on questions (session+round+park-run canceled,
    // worker cards requeued, stale answers rejected via the canceled round).
    // Rosters that still hold a human are natural no-ops. dynamic_workflow is
    // excluded (impl-gate P2): it has no turn engine, the roster predicate is
    // mode-inert there, and this must not sweep a generated node's ordinary
    // clarify park.
    if (hadHumanMember && !workgroupHasHumanMember(members) && config.mode !== 'dynamic_workflow') {
      const dismissed = await dismissOpenClarifyParksForAutonomous(deps.db, taskId, config.mode)
      if (dismissed.dismissedSessions > 0) {
        changes.push(
          `dismissed ${dismissed.dismissedSessions} open clarify session(s) (no human member left)`,
        )
        // Impl-gate P2 — the `task.status === 'awaiting_human'` gate further
        // down reads the row loaded BEFORE this dismissal, and the engine may
        // commit running→awaiting_human from its pre-dismissal snapshot a
        // beat later. Re-read fresh now and once more shortly after, so a
        // park landing right behind the dismissal still gets resumed
        // (kickResume no-ops on non-resumable states).
        const kickIfParked = async (): Promise<void> => {
          const fresh = (
            await deps.db
              .select({ status: tasks.status })
              .from(tasks)
              .where(eq(tasks.id, taskId))
              .limit(1)
          )[0]
          kickResumeIfResumable(taskId, fresh?.status)
        }
        await kickIfParked()
        const lateKick = setTimeout(() => void kickIfParked(), 2500)
        lateKick.unref?.()
      }
    }
    const msgId = ulid()
    await deps.db.insert(workgroupMessages).values(
      buildRoomMessageRow({
        id: msgId,
        taskId,
        round: await resolveRoomMessageRound(deps.db, taskId, config.mode),
        authorKind: 'human',
        authorUserId: actor.user.id,
        kind: 'system',
        bodyMd: `config updated: ${changes.join('; ')}`,
        createdAt: Date.now(),
      }),
    )
    broadcastWg(taskId, { type: 'wg.message.created', messageId: msgId, kind: 'system' })
    kickResumeIfResumable(taskId, task.status)
    return { changes }
  }

  return { updateTaskConfig }
}
