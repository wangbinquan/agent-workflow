import { ulid } from 'ulid'
import {
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  workgroupHasHumanMember,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray } from 'drizzle-orm'
import {
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
  workgroupTaskState,
} from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { WorkgroupTaskRoomCommands } from '../public/commands'
import {
  ConfigPatchSchema,
  ConfirmSchema,
  DeliverSchema,
  PostMessageSchema,
  SaveAsWorkflowSchema,
  firstLine,
  identity,
  inputBody,
  isResumable,
  loadVisibleTask,
  mentions,
  messageRound,
  requeueDismissedAssignments,
  transitionAssignment,
  visibleAgentRows,
  type AssignmentStatus,
  type PostgresqlWorkgroupTaskRoomDependencies,
  type WorkgroupTaskRoomTransactionRunner,
} from './postgresqlWorkgroupTaskRoom'

export function createPostgresqlWorkgroupTaskRoomCommands(
  dependencies: PostgresqlWorkgroupTaskRoomDependencies,
  withTransaction: WorkgroupTaskRoomTransactionRunner,
): WorkgroupTaskRoomCommands {
  const now = dependencies.now ?? Date.now
  const nextId = dependencies.id ?? ulid
  const commands = Object.freeze<WorkgroupTaskRoomCommands>({
    async postMessage(authority, input) {
      const result = await withTransaction(async (transaction, participant) => {
        const loaded = await loadVisibleTask(transaction, participant, authority, input.taskId)
        const parsed = PostMessageSchema.safeParse(inputBody(input.submission))
        if (!parsed.success) {
          throw new ValidationError('workgroup-message-invalid', 'invalid message payload', {
            issues: parsed.error.issues,
          })
        }
        if (['done', 'failed', 'canceled'].includes(loaded.task.status)) {
          throw new ConflictError(
            'workgroup-task-terminal',
            'cannot message a finished workgroup task',
          )
        }
        const at = now()
        const round = await messageRound(participant, input.taskId, loaded.config.mode)
        const mentioned = mentions(parsed.data.body, loaded.config)
        const assignmentIds: string[] = []
        for (const member of mentioned) {
          const assignmentId = nextId()
          await transaction.insert(workgroupAssignments).values({
            id: assignmentId,
            taskId: input.taskId,
            round,
            source: 'human',
            createdByUserId: authority.user.id,
            assigneeMemberId: member.id,
            title: firstLine(parsed.data.body),
            briefMd: parsed.data.body,
            status: 'dispatched',
            createdAt: at,
            updatedAt: at,
          })
          assignmentIds.push(assignmentId)
        }
        const messageId = nextId()
        await transaction.insert(workgroupMessages).values({
          id: messageId,
          taskId: input.taskId,
          round,
          authorKind: 'human',
          authorUserId: authority.user.id,
          kind: mentioned.length > 0 ? 'dispatch' : 'chat',
          bodyMd: parsed.data.body,
          mentionsJson: JSON.stringify(mentioned.map((member) => member.id)),
          assignmentId: assignmentIds[0] ?? null,
          createdAt: at,
        })
        if (isResumable(loaded.task.status)) {
          await participant.continueTask({
            taskId: input.taskId,
            expectedStatus: loaded.task.status,
            actorUserId: authority.user.id,
            occurredAt: at,
            identity: identity('workgroup-task-room.post-message.v1', nextId),
          })
        }
        return {
          receipt: { messageId, assignmentIds: Object.freeze(assignmentIds) },
          events: [
            ...assignmentIds.map((assignmentId) => ({
              type: 'wg.assignment.updated' as const,
              assignmentId,
              status: 'dispatched',
            })),
            {
              type: 'wg.message.created' as const,
              messageId,
              kind: mentioned.length > 0 ? 'dispatch' : 'chat',
            },
          ],
        }
      })
      for (const event of result.events) dependencies.broadcast(input.taskId, event)
      return result.receipt
    },
    async deliverAssignment(authority, input) {
      const result = await withTransaction(async (transaction, participant) => {
        const loaded = await loadVisibleTask(transaction, participant, authority, input.taskId)
        const parsed = DeliverSchema.safeParse(inputBody(input.submission))
        if (!parsed.success) {
          throw new ValidationError('workgroup-delivery-invalid', 'invalid delivery payload', {
            issues: parsed.error.issues,
          })
        }
        const assignment = await transaction
          .select()
          .from(workgroupAssignments)
          .where(
            and(
              eq(workgroupAssignments.id, input.assignmentId),
              eq(workgroupAssignments.taskId, input.taskId),
            ),
          )
          .limit(1)
          .get()
        if (assignment === undefined) {
          throw new NotFoundError('workgroup-assignment-not-found', 'assignment not found')
        }
        const member = loaded.config.members.find(
          (candidate) => candidate.id === assignment.assigneeMemberId,
        )
        if (member?.memberType !== 'human') {
          throw new ValidationError(
            'workgroup-delivery-not-human',
            'only human-member assignments accept deliveries',
          )
        }
        const messageId = nextId()
        const at = now()
        const delivered = await transitionAssignment(transaction, {
          id: input.assignmentId,
          taskId: input.taskId,
          from: 'dispatched',
          to: 'delivered',
          now: at,
          patch: { resultMessageId: messageId },
        })
        if (!delivered) {
          throw new ConflictError(
            'workgroup-delivery-conflict',
            `assignment is '${assignment.status}' — only dispatched human cards accept delivery`,
          )
        }
        const bodyMd =
          parsed.data.body ??
          `${parsed.data.summary ?? ''}${parsed.data.detail ? `\n\n${parsed.data.detail}` : ''}`
        await transaction.insert(workgroupMessages).values({
          id: messageId,
          taskId: input.taskId,
          round: assignment.round,
          authorKind: 'human',
          authorMemberId: member.id,
          authorUserId: authority.user.id,
          kind: 'delivery',
          bodyMd,
          mentionsJson: '[]',
          assignmentId: input.assignmentId,
          createdAt: at,
        })
        if (isResumable(loaded.task.status)) {
          await participant.continueTask({
            taskId: input.taskId,
            expectedStatus: loaded.task.status,
            actorUserId: authority.user.id,
            occurredAt: at,
            identity: identity('workgroup-task-room.deliver-assignment.v1', nextId),
          })
        }
        return { messageId }
      })
      dependencies.broadcast(input.taskId, {
        type: 'wg.assignment.updated',
        assignmentId: input.assignmentId,
        status: 'delivered',
      })
      dependencies.broadcast(input.taskId, {
        type: 'wg.message.created',
        messageId: result.messageId,
        kind: 'delivery',
      })
      return result
    },
    async confirmGate(authority, input) {
      const result = await withTransaction(async (transaction, participant) => {
        const loaded = await loadVisibleTask(transaction, participant, authority, input.taskId)
        const parsed = ConfirmSchema.safeParse(inputBody(input.submission))
        if (!parsed.success) {
          throw new ValidationError('workgroup-confirm-invalid', 'invalid confirm payload', {
            issues: parsed.error.issues,
          })
        }
        if (
          loaded.state.gateStatus !== 'awaiting_confirmation' ||
          loaded.task.status !== 'awaiting_review'
        ) {
          throw new ConflictError(
            'workgroup-gate-not-open',
            'the completion gate is not awaiting confirmation',
          )
        }
        const at = now()
        const nextGate = parsed.data.decision === 'approve' ? 'approved' : 'rejected'
        const changed = await transaction
          .update(workgroupTaskState)
          .set({
            gateStatus: nextGate,
            gateRejectedComment:
              parsed.data.decision === 'reject' ? (parsed.data.comment ?? '') : null,
            updatedAt: at,
          })
          .where(
            and(
              eq(workgroupTaskState.taskId, input.taskId),
              eq(workgroupTaskState.gateStatus, 'awaiting_confirmation'),
            ),
          )
          .returning({ taskId: workgroupTaskState.taskId })
          .all()
        if (changed.length !== 1) {
          throw new ConflictError(
            'workgroup-gate-not-open',
            'the completion gate is not awaiting confirmation',
          )
        }
        const continued = await participant.continueTask({
          taskId: input.taskId,
          expectedStatus: 'awaiting_review',
          actorUserId: authority.user.id,
          occurredAt: at,
          identity: identity('workgroup-task-room.confirm-gate.v1', nextId),
          closeHolder: {
            rerunCause: 'wg-gate',
            reason: parsed.data.decision === 'approve' ? 'wg-gate-approved' : 'wg-gate-rejected',
          },
        })
        if (continued === null) {
          throw new ConflictError(
            'workgroup-gate-not-open',
            'the completion gate is not awaiting confirmation',
          )
        }
        const messageId = nextId()
        await transaction.insert(workgroupMessages).values({
          id: messageId,
          taskId: input.taskId,
          round: await messageRound(participant, input.taskId, loaded.config.mode),
          authorKind: 'human',
          authorUserId: authority.user.id,
          kind: 'system',
          bodyMd:
            parsed.data.decision === 'approve'
              ? 'completion gate APPROVED'
              : `completion gate REJECTED: ${parsed.data.comment ?? ''}`,
          mentionsJson: '[]',
          createdAt: at,
        })
        return { decision: parsed.data.decision, messageId, closed: continued.closedHolderIds }
      })
      for (const nodeRunId of result.closed) {
        dependencies.broadcast(input.taskId, {
          type: 'node.status',
          nodeRunId,
          nodeId: '__wg_leader__',
          status: 'done',
        })
      }
      dependencies.broadcast(input.taskId, {
        type: 'wg.message.created',
        messageId: result.messageId,
        kind: 'system',
      })
      dependencies.broadcast(input.taskId, {
        type: 'wg.gate.updated',
        awaitingConfirmation: false,
      })
      return { decision: result.decision }
    },
    async confirmDynamicWorkflow(authority, input) {
      return await withTransaction(async (transaction, participant) => {
        const loaded = await loadVisibleTask(transaction, participant, authority, input.taskId)
        const parsed = ConfirmSchema.safeParse(inputBody(input.submission))
        if (!parsed.success) {
          throw new ValidationError('workgroup-confirm-invalid', 'invalid confirm payload', {
            issues: parsed.error.issues,
          })
        }
        const dw = loaded.state.dw
        if (
          loaded.config.mode !== 'dynamic_workflow' ||
          dw === null ||
          dw.phase !== 'awaiting_confirm' ||
          loaded.task.status !== 'awaiting_review'
        ) {
          throw new ConflictError(
            'workgroup-dw-gate-not-open',
            'the dynamic workflow confirm gate is not awaiting confirmation',
          )
        }
        const at = now()
        if (parsed.data.decision === 'approve') {
          const stored = WorkflowDefinitionSchema.safeParse(dw.generatedDef)
          if (!stored.success) {
            throw new ConflictError(
              'dw-generated-def-invalid',
              'the stored generated workflow is unreadable — reject with feedback to regenerate',
            )
          }
          const definition = await dependencies.dynamicWorkflow.validateGenerated(authority, {
            definition: migrateWorkflowDefinitionToLatest(stored.data),
            triggerContextJson: loaded.task.triggerContextJson,
            poolAgentIds: loaded.config.members.flatMap((member) =>
              member.memberType === 'agent' && typeof member.agentId === 'string'
                ? [member.agentId]
                : [],
            ),
          })
          const { rejectionComment: _rejectionComment, ...rest } = dw
          await transaction
            .update(workgroupTaskState)
            .set({ dwStateJson: JSON.stringify({ ...rest, phase: 'executing' }), updatedAt: at })
            .where(eq(workgroupTaskState.taskId, input.taskId))
            .run()
          const continued = await participant.continueTask({
            taskId: input.taskId,
            expectedStatus: 'awaiting_review',
            actorUserId: authority.user.id,
            occurredAt: at,
            workflowSnapshot: JSON.stringify(definition),
            identity: identity('workgroup-task-room.confirm-dynamic-workflow.v1', nextId),
            closeHolder: { rerunCause: 'dw-gate', reason: 'dw-gate-approved' },
          })
          if (continued === null) {
            throw new ConflictError(
              'workgroup-dw-gate-not-open',
              'the dynamic workflow confirm gate is not awaiting confirmation',
            )
          }
          return { decision: 'approve' as const }
        }
        const rejectRounds = dw.rejectRounds + 1
        const comment = parsed.data.comment ?? ''
        if (rejectRounds >= 10) {
          const nextDw = {
            ...dw,
            phase: 'rejected' as const,
            rejectRounds,
            rejectionComment: comment,
          }
          await transaction
            .update(workgroupTaskState)
            .set({ dwStateJson: JSON.stringify(nextDw), updatedAt: at })
            .where(eq(workgroupTaskState.taskId, input.taskId))
            .run()
          const failed = await participant.failTask({
            taskId: input.taskId,
            expectedStatus: 'awaiting_review',
            errorSummary: 'dw-reject-exhausted',
            errorMessage: `dynamic workflow rejected ${rejectRounds} time(s) — DW_MAX_REJECT_ROUNDS reached`,
            occurredAt: at,
            identity: identity('workgroup-task-room.reject-dynamic-workflow.v1', nextId),
            closeHolder: { rerunCause: 'dw-gate', reason: 'dw-gate-rejected' },
          })
          if (failed === null) {
            throw new ConflictError(
              'workgroup-dw-gate-not-open',
              'the dynamic workflow confirm gate is not awaiting confirmation',
            )
          }
          return { decision: 'reject' as const, exhausted: true as const }
        }
        const { generatedDef: _generatedDef, ...rest } = dw
        const nextDw = {
          ...rest,
          phase: 'generating' as const,
          generateAttempts: 0,
          rejectRounds,
          rejectionComment: comment,
        }
        await transaction
          .update(workgroupTaskState)
          .set({ dwStateJson: JSON.stringify(nextDw), updatedAt: at })
          .where(eq(workgroupTaskState.taskId, input.taskId))
          .run()
        const continued = await participant.continueTask({
          taskId: input.taskId,
          expectedStatus: 'awaiting_review',
          actorUserId: authority.user.id,
          occurredAt: at,
          identity: identity('workgroup-task-room.reject-dynamic-workflow.v1', nextId),
          closeHolder: { rerunCause: 'dw-gate', reason: 'dw-gate-rejected' },
        })
        if (continued === null) {
          throw new ConflictError(
            'workgroup-dw-gate-not-open',
            'the dynamic workflow confirm gate is not awaiting confirmation',
          )
        }
        return { decision: 'reject' as const }
      })
    },
    async saveDynamicWorkflow(authority, input) {
      const prepared = await withTransaction(async (transaction, participant) => {
        const loaded = await loadVisibleTask(transaction, participant, authority, input.taskId)
        const parsed = SaveAsWorkflowSchema.safeParse(inputBody(input.submission))
        if (!parsed.success) {
          throw new ValidationError('workgroup-save-as-invalid', 'invalid save-as-workflow body', {
            issues: parsed.error.issues,
          })
        }
        const definition = WorkflowDefinitionSchema.safeParse(loaded.state.dw?.generatedDef)
        if (
          loaded.config.mode !== 'dynamic_workflow' ||
          loaded.state.dw === null ||
          !definition.success
        ) {
          throw new ConflictError(
            'dw-no-generated-workflow',
            'this task has no generated workflow to save',
          )
        }
        return {
          name: parsed.data.name,
          description: parsed.data.description ?? '',
          definition: migrateWorkflowDefinitionToLatest(definition.data),
        }
      })
      return dependencies.dynamicWorkflow.create(authority, prepared)
    },
    async updateConfig(authority, input) {
      const result = await withTransaction(async (transaction, participant) => {
        const loaded = await loadVisibleTask(transaction, participant, authority, input.taskId)
        if (['done', 'failed', 'canceled'].includes(loaded.task.status)) {
          throw new ConflictError(
            'workgroup-task-terminal',
            'cannot edit a finished workgroup task',
          )
        }
        const parsed = ConfigPatchSchema.safeParse(inputBody(input.submission))
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
        const addedAgents = await visibleAgentRows(transaction, authority, addedAgentIds)
        const missingAgents = addedAgentIds.filter((id) => !addedAgents.has(id))
        if (missingAgents.length > 0) {
          throw new ValidationError(
            'workgroup-config-agent-missing',
            `agent member(s) do not exist: ${missingAgents.join(', ')}`,
            { missingAgentIds: missingAgents },
          )
        }
        const changes: string[] = []
        let members = [...loaded.config.members]
        const hadHumanMember = workgroupHasHumanMember(members)
        const removing = new Set(patch.removeMemberIds ?? [])
        if (removing.size > 0) {
          if (loaded.config.leaderMemberId !== null && removing.has(loaded.config.leaderMemberId)) {
            throw new ValidationError(
              'workgroup-config-leader-immutable',
              'cannot remove the leader',
            )
          }
          const removed = members.filter((member) => removing.has(member.id))
          members = members.filter((member) => !removing.has(member.id))
          if (!members.some((member) => member.memberType === 'agent')) {
            throw new ValidationError(
              'workgroup-config-no-agents',
              'removing these members would leave no agent member',
            )
          }
          for (const member of removed) changes.push(`removed @${member.displayName}`)
        }
        const latestMessageId = (
          await transaction
            .select({ id: workgroupMessages.id })
            .from(workgroupMessages)
            .where(eq(workgroupMessages.taskId, input.taskId))
            .orderBy(asc(workgroupMessages.id))
            .all()
        ).at(-1)?.id
        const humanIds: string[] = []
        const joinCursors: Array<{ memberId: string; messageId: string }> = []
        const names = new Set(members.map((member) => member.displayName))
        for (const submitted of patch.addMembers ?? []) {
          if (names.has(submitted.displayName)) {
            throw new ValidationError(
              'workgroup-config-duplicate-member',
              `displayName '${submitted.displayName}' already exists in the group`,
            )
          }
          if (submitted.memberType === 'human' && submitted.userId === dependencies.systemUserId) {
            throw new ValidationError(
              'workgroup-config-invalid',
              'cannot add the system user as a member',
            )
          }
          const memberId = nextId()
          const agent =
            submitted.memberType === 'agent' && submitted.agentId
              ? addedAgents.get(submitted.agentId)
              : undefined
          members.push({
            id: memberId,
            memberType: submitted.memberType,
            agentName: agent?.name ?? null,
            agentId: agent?.id ?? null,
            userId: submitted.memberType === 'human' ? (submitted.userId ?? null) : null,
            displayName: submitted.displayName,
            roleDesc: submitted.roleDesc,
          })
          if (
            submitted.memberType === 'human' &&
            submitted.userId !== undefined &&
            submitted.userId !== loaded.task.ownerUserId &&
            !humanIds.includes(submitted.userId)
          ) {
            humanIds.push(submitted.userId)
          }
          if (latestMessageId !== undefined) {
            joinCursors.push({ memberId, messageId: latestMessageId })
          }
          names.add(submitted.displayName)
          changes.push(`added @${submitted.displayName} (${submitted.memberType})`)
        }
        if (humanIds.length > 0) {
          const active = await dependencies.activeUsers.findActiveUserIds(humanIds)
          const inactive = humanIds.find((id) => !active.has(id))
          if (inactive !== undefined) {
            throw new ValidationError(
              'workgroup-config-invalid',
              `human member '${inactive}' is not an active user`,
            )
          }
        }
        if (patch.switches !== undefined) changes.push('switches updated')
        if (patch.maxRounds !== undefined) changes.push(`maxRounds → ${patch.maxRounds}`)
        if (patch.completionGate !== undefined) {
          changes.push(`completionGate → ${patch.completionGate}`)
        }
        if (patch.clarifyBudget !== undefined) {
          changes.push(`clarifyBudget → ${patch.clarifyBudget}`)
        }
        if (patch.fanOut !== undefined) changes.push(`fanOut → ${patch.fanOut}`)
        if (patch.outputContract !== undefined) {
          changes.push(`outputContract → ${patch.outputContract}`)
        }
        if (changes.length === 0) {
          throw new ValidationError('workgroup-config-empty', 'nothing to change')
        }
        const nextConfig = {
          ...loaded.raw,
          members,
          ...(patch.switches === undefined ? {} : { switches: patch.switches }),
          ...(patch.maxRounds === undefined ? {} : { maxRounds: patch.maxRounds }),
          ...(patch.completionGate === undefined ? {} : { completionGate: patch.completionGate }),
          ...(patch.clarifyBudget === undefined ? {} : { clarifyBudget: patch.clarifyBudget }),
          ...(patch.fanOut === undefined ? {} : { fanOut: patch.fanOut }),
          ...(patch.outputContract === undefined ? {} : { outputContract: patch.outputContract }),
        }
        const at = now()
        const replaced = await participant.replaceConfig({
          taskId: input.taskId,
          expectedConfigJson: loaded.task.workgroupConfigJson ?? '',
          nextConfigJson: JSON.stringify(nextConfig),
          newCollaborators: humanIds.map((userId) => ({
            userId,
            addedBy: authority.user.id,
            addedAt: at,
          })),
        })
        if (!replaced) {
          throw new ConflictError(
            'workgroup-config-conflict',
            'the workgroup roster changed while editing; reload and retry',
          )
        }
        const assignmentEvents: Array<{ assignmentId: string; status: AssignmentStatus }> = []
        if (removing.size > 0) {
          const assignments = await transaction
            .select()
            .from(workgroupAssignments)
            .where(eq(workgroupAssignments.taskId, input.taskId))
            .all()
          for (const assignment of assignments) {
            if (
              assignment.assigneeMemberId === null ||
              !removing.has(assignment.assigneeMemberId) ||
              !['open', 'dispatched', 'awaiting_human', 'running'].includes(assignment.status)
            ) {
              continue
            }
            if (assignment.status === 'running') {
              throw new ConflictError(
                'workgroup-member-running',
                `member '${assignment.assigneeMemberId}' still owns a running assignment`,
              )
            }
            if (loaded.config.mode === 'free_collab') {
              if (assignment.status === 'dispatched') {
                if (
                  !(await transitionAssignment(transaction, {
                    id: assignment.id,
                    taskId: input.taskId,
                    from: 'dispatched',
                    to: 'failed',
                    now: at,
                  })) ||
                  !(await transitionAssignment(transaction, {
                    id: assignment.id,
                    taskId: input.taskId,
                    from: 'failed',
                    to: 'open',
                    now: at,
                    patch: { assigneeMemberId: null, nodeRunId: null },
                  }))
                ) {
                  throw new ConflictError(
                    'workgroup-config-conflict',
                    `assignment '${assignment.id}' changed while editing the roster`,
                  )
                }
                assignmentEvents.push({ assignmentId: assignment.id, status: 'open' })
              } else if (assignment.status === 'awaiting_human') {
                if (
                  !(await transitionAssignment(transaction, {
                    id: assignment.id,
                    taskId: input.taskId,
                    from: 'awaiting_human',
                    to: 'open',
                    now: at,
                    patch: { assigneeMemberId: null, nodeRunId: null },
                  }))
                ) {
                  throw new ConflictError(
                    'workgroup-config-conflict',
                    `assignment '${assignment.id}' changed while editing the roster`,
                  )
                }
                assignmentEvents.push({ assignmentId: assignment.id, status: 'open' })
              }
            } else if (
              await transitionAssignment(transaction, {
                id: assignment.id,
                taskId: input.taskId,
                from: assignment.status,
                to: 'canceled',
                now: at,
              })
            ) {
              assignmentEvents.push({ assignmentId: assignment.id, status: 'canceled' })
            } else {
              throw new ConflictError(
                'workgroup-config-conflict',
                `assignment '${assignment.id}' changed while editing the roster`,
              )
            }
          }
        }
        for (const cursor of joinCursors) {
          await transaction
            .insert(workgroupMemberCursors)
            .values({
              taskId: input.taskId,
              memberId: cursor.memberId,
              lastConsumedMessageId: cursor.messageId,
              updatedAt: at,
            })
            .onConflictDoNothing()
        }
        if (
          hadHumanMember &&
          !workgroupHasHumanMember(members) &&
          loaded.config.mode !== 'dynamic_workflow'
        ) {
          const dismissed = await participant.dismissOpenClarifyParksForAutonomous({
            taskId: input.taskId,
            occurredAt: at,
          })
          assignmentEvents.push(
            ...(await requeueDismissedAssignments(transaction, {
              taskId: input.taskId,
              mode: loaded.config.mode,
              shardKeys: dismissed.assignmentShardKeys,
              now: at,
            })),
          )
          if (dismissed.dismissedSessions > 0) {
            changes.push(
              `dismissed ${dismissed.dismissedSessions} open clarify session(s) (no human member left)`,
            )
          }
        }
        const messageId = nextId()
        await transaction.insert(workgroupMessages).values({
          id: messageId,
          taskId: input.taskId,
          round: await messageRound(participant, input.taskId, loaded.config.mode),
          authorKind: 'human',
          authorUserId: authority.user.id,
          kind: 'system',
          bodyMd: `config updated: ${changes.join('; ')}`,
          mentionsJson: '[]',
          createdAt: at,
        })
        if (isResumable(loaded.task.status)) {
          await participant.continueTask({
            taskId: input.taskId,
            expectedStatus: loaded.task.status,
            actorUserId: authority.user.id,
            occurredAt: at,
            identity: identity('workgroup-task-room.update-config.v1', nextId),
          })
        }
        return { changes, assignmentEvents, messageId }
      })
      for (const event of result.assignmentEvents) {
        dependencies.broadcast(input.taskId, {
          type: 'wg.assignment.updated',
          assignmentId: event.assignmentId,
          status: event.status,
        })
      }
      dependencies.broadcast(input.taskId, {
        type: 'wg.message.created',
        messageId: result.messageId,
        kind: 'system',
      })
      return { changes: result.changes }
    },
    async cancelAssignment(authority, input) {
      const messageId = await withTransaction(async (transaction, participant) => {
        await loadVisibleTask(transaction, participant, authority, input.taskId)
        const assignment = await transaction
          .select()
          .from(workgroupAssignments)
          .where(
            and(
              eq(workgroupAssignments.id, input.assignmentId),
              eq(workgroupAssignments.taskId, input.taskId),
            ),
          )
          .limit(1)
          .get()
        if (assignment === undefined) {
          throw new NotFoundError('workgroup-assignment-not-found', 'assignment not found')
        }
        const at = now()
        const canceled = await transaction
          .update(workgroupAssignments)
          .set({ status: 'canceled', updatedAt: at })
          .where(
            and(
              eq(workgroupAssignments.id, input.assignmentId),
              eq(workgroupAssignments.taskId, input.taskId),
              inArray(workgroupAssignments.status, ['open', 'dispatched']),
            ),
          )
          .returning({ id: workgroupAssignments.id })
          .all()
        if (canceled.length !== 1) {
          throw new ConflictError(
            'workgroup-assignment-not-cancelable',
            `assignment is '${assignment.status}' — only open/dispatched cards can be canceled`,
          )
        }
        const id = nextId()
        await transaction.insert(workgroupMessages).values({
          id,
          taskId: input.taskId,
          round: assignment.round,
          authorKind: 'system',
          kind: 'system',
          bodyMd: `assignment '${assignment.title}' canceled by a task member`,
          templateKey: 'assignmentCanceledByMember',
          templateParamsJson: JSON.stringify({ title: assignment.title }),
          mentionsJson: '[]',
          assignmentId: input.assignmentId,
          createdAt: at,
        })
        return id
      })
      dependencies.broadcast(input.taskId, {
        type: 'wg.assignment.updated',
        assignmentId: input.assignmentId,
        status: 'canceled',
      })
      dependencies.broadcast(input.taskId, {
        type: 'wg.message.created',
        messageId,
        kind: 'system',
      })
    },
  })
  return commands
}
