import {
  DwStateSchema,
  WorkgroupRuntimeConfigSchema,
  perCardInputDescriptionBudget,
  renderAgentCapabilityCard,
  type WorkgroupMessage,
} from '@agent-workflow/shared'
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'

import {
  agents,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
  workgroupTaskState,
} from '@/db/schema'
import type {
  WorkgroupHostLedgerOperation,
  WorkgroupHostLedgerParticipantInTx,
  WorkgroupTurnsOperations,
} from '@/modules/task-execution/public/commands'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS,
  WORKGROUP_TURN_GATE_TRANSITIONS,
  createWorkgroupTurnsOperations,
  type WorkgroupTurnAssignment,
  type WorkgroupTurnGateOperation,
  type WorkgroupTurnLedgerOperation,
  type WorkgroupTurnMessageDraft,
  type WorkgroupTurnMintedRun,
  type WorkgroupTurnsLedgerCommitReceipt,
  type WorkgroupTurnsPersistencePort,
  type WorkgroupTurnsSnapshot,
} from '../application/workgroups/workgroupTurnsDriver'
import { agentFromPersistenceRow } from './agentPersistence'
import {
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

const ROSTER_CARD_PROMPT_BUDGET = 240
const ROSTER_INPUT_DESCRIPTION_TOTAL_BUDGET = 2_400
const ROSTER_CARD_INPUT_DESCRIPTION_MAX = 240

export interface PostgresqlWorkgroupHostLedgerParticipantFactory {
  inTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
  ): WorkgroupHostLedgerParticipantInTx
}

export interface PostgresqlWorkgroupTurnsDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly hostLedgerFactory: PostgresqlWorkgroupHostLedgerParticipantFactory
}

class WorkgroupLedgerConflict extends Error {
  constructor(readonly operationKey: string) {
    super(`workgroup ledger operation '${operationKey}' lost its fence`)
    this.name = 'WorkgroupLedgerConflict'
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function stringArray(value: string): string[] {
  const parsed = parseJson(value)
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function recordJson(value: string | null): Readonly<Record<string, unknown>> | null {
  if (value === null) return null
  const parsed = parseJson(value)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return Object.fromEntries(Object.entries(parsed))
}

function readonlyPermission(permission: unknown): boolean {
  if (typeof permission !== 'object' || permission === null || Array.isArray(permission)) {
    return false
  }
  return Reflect.get(permission, 'edit') === 'deny' && Reflect.get(permission, 'write') === 'deny'
}

function messageFromRow(row: typeof workgroupMessages.$inferSelect): WorkgroupMessage {
  const templateParams = recordJson(row.templateParamsJson)
  const templateKey = templateParams === null ? null : row.templateKey
  return {
    id: row.id,
    taskId: row.taskId,
    round: row.round,
    authorKind: row.authorKind,
    authorMemberId: row.authorMemberId,
    authorUserId: row.authorUserId,
    kind: row.kind,
    bodyMd: row.bodyMd,
    templateKey,
    templateParams: templateKey === null ? null : templateParams,
    mentionMemberIds: stringArray(row.mentionsJson),
    assignmentId: row.assignmentId,
    triggerMessageId: row.triggerMessageId,
    createdAt: row.createdAt,
  }
}

function assignmentFromRow(row: typeof workgroupAssignments.$inferSelect): WorkgroupTurnAssignment {
  return {
    id: row.id,
    taskId: row.taskId,
    round: row.round,
    source: row.source,
    createdByRunId: row.createdByRunId,
    createdByUserId: row.createdByUserId,
    assigneeMemberId: row.assigneeMemberId,
    title: row.title,
    briefMd: row.briefMd,
    status: row.status,
    nodeRunId: row.nodeRunId,
    resultMessageId: row.resultMessageId,
    dedupKey: row.dedupKey,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

async function loadSnapshot(
  transaction: PostgresqlResourceCatalogTransaction,
  hostLedger: WorkgroupHostLedgerParticipantInTx,
  taskId: string,
): Promise<WorkgroupTurnsSnapshot | null> {
  const hostSnapshot = await hostLedger.load(taskId)
  if (
    hostSnapshot?.workgroupConfigJson === null ||
    hostSnapshot?.workgroupConfigJson === undefined
  ) {
    return null
  }
  const config = WorkgroupRuntimeConfigSchema.safeParse(parseJson(hostSnapshot.workgroupConfigJson))
  if (!config.success) return null
  const [stateRow, assignmentRows, messageRows, cursorRows] = await Promise.all([
    transaction
      .select()
      .from(workgroupTaskState)
      .where(eq(workgroupTaskState.taskId, taskId))
      .get(),
    transaction
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
      .orderBy(asc(workgroupAssignments.id))
      .all(),
    transaction
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
      .orderBy(asc(workgroupMessages.id))
      .all(),
    transaction
      .select()
      .from(workgroupMemberCursors)
      .where(eq(workgroupMemberCursors.taskId, taskId))
      .all(),
  ])
  const agentIds = [
    ...new Set(
      config.data.members.flatMap((member) =>
        member.memberType === 'agent' &&
        typeof member.agentId === 'string' &&
        member.agentId.length > 0
          ? [member.agentId]
          : [],
      ),
    ),
  ]
  const agentRows =
    agentIds.length === 0
      ? []
      : await transaction.select().from(agents).where(inArray(agents.id, agentIds)).all()
  const agentById = new Map(
    agentRows.map((row) => {
      const agent = agentFromPersistenceRow(row)
      return [agent.id, agent]
    }),
  )
  const agentMemberCount = config.data.members.filter(
    (member) => member.memberType === 'agent',
  ).length
  const inputDescriptionBudget = perCardInputDescriptionBudget(
    ROSTER_INPUT_DESCRIPTION_TOTAL_BUDGET,
    agentMemberCount,
    ROSTER_CARD_INPUT_DESCRIPTION_MAX,
  )
  const memberAgents = config.data.members.flatMap((member) => {
    if (
      member.memberType !== 'agent' ||
      typeof member.agentId !== 'string' ||
      member.agentId.length === 0
    ) {
      return []
    }
    const agent = agentById.get(member.agentId)
    if (agent === undefined) return []
    return [
      {
        memberId: member.id,
        agent,
        capabilityCard: renderAgentCapabilityCard(agent, {
          promptBudget: ROSTER_CARD_PROMPT_BUDGET,
          inputDescriptionBudget,
        }),
        readonly: readonlyPermission(agent.permission),
      },
    ]
  })
  const dw =
    stateRow?.dwStateJson === null || stateRow?.dwStateJson === undefined
      ? null
      : DwStateSchema.safeParse(parseJson(stateRow.dwStateJson))
  return {
    taskId,
    config: config.data,
    state: {
      gateStatus: stateRow?.gateStatus ?? 'idle',
      gateSummary: stateRow?.gateSummary ?? null,
      gateRejectedComment: stateRow?.gateRejectedComment ?? null,
      pauseReason: stateRow?.pauseReason ?? null,
      dynamicWorkflowState: dw !== null && dw.success ? dw.data : null,
      resultMessageId: stateRow?.resultMessageId ?? null,
    },
    assignments: assignmentRows.map(assignmentFromRow),
    messages: messageRows.map(messageFromRow),
    cursors: new Map(cursorRows.map((row) => [row.memberId, row.lastConsumedMessageId])),
    memberAgents,
    hostRuns: hostSnapshot.hostRuns,
    leaderClarifyParked: hostSnapshot.leaderClarifyParked,
  }
}

async function insertMessage(
  transaction: PostgresqlResourceCatalogTransaction,
  taskId: string,
  message: WorkgroupTurnMessageDraft,
): Promise<void> {
  await transaction
    .insert(workgroupMessages)
    .values({
      id: message.id,
      taskId,
      round: message.round,
      authorKind: message.authorKind,
      authorMemberId: message.authorMemberId,
      authorUserId: message.authorUserId,
      kind: message.kind,
      bodyMd: message.bodyMd,
      templateKey: message.templateKey,
      templateParamsJson:
        message.templateParams === null ? null : JSON.stringify(message.templateParams),
      mentionsJson: JSON.stringify(message.mentionMemberIds),
      assignmentId: message.assignmentId,
      triggerMessageId: message.triggerMessageId,
      createdAt: message.createdAt,
    })
    .run()
}

function assertAssignmentTransition(
  operation: Extract<WorkgroupTurnLedgerOperation, { readonly kind: 'transition-assignment' }>,
): void {
  if (!WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS[operation.from].includes(operation.to)) {
    throw new Error(`illegal workgroup assignment transition ${operation.from} -> ${operation.to}`)
  }
}

function assertGateTransition(operation: WorkgroupTurnGateOperation): void {
  if (
    operation.from.length === 0 ||
    operation.from.some((from) => !WORKGROUP_TURN_GATE_TRANSITIONS[from].includes(operation.to))
  ) {
    throw new Error(
      `illegal workgroup gate transition ${operation.from.join('|')} -> ${operation.to}`,
    )
  }
}

function gatePatch(operation: WorkgroupTurnGateOperation): Readonly<{
  gateSummary?: string | null
  gateRejectedComment?: string | null
}> {
  if (operation.to === 'declared') {
    return { gateSummary: operation.summary ?? null, gateRejectedComment: null }
  }
  if (operation.to === 'rejected') {
    return { gateRejectedComment: operation.rejectedComment ?? '' }
  }
  if (operation.to === 'idle') {
    return { gateSummary: null, gateRejectedComment: null }
  }
  return {}
}

type WorkgroupTurnResourceCatalogOperation = Exclude<
  WorkgroupTurnLedgerOperation,
  WorkgroupHostLedgerOperation
>

function isHostLedgerOperation(
  operation: WorkgroupTurnLedgerOperation,
): operation is WorkgroupHostLedgerOperation {
  return operation.kind === 'mint-host-run' || operation.kind === 'stamp-host-run-round'
}

async function applyResourceCatalogOperation(
  transaction: PostgresqlResourceCatalogTransaction,
  taskId: string,
  operation: WorkgroupTurnResourceCatalogOperation,
): Promise<void> {
  const now = Date.now()
  if (operation.kind === 'ensure-task-state') {
    await transaction
      .insert(workgroupTaskState)
      .values({
        taskId,
        gateStatus: 'idle',
        dwStateJson:
          operation.dynamicWorkflowState === undefined || operation.dynamicWorkflowState === null
            ? null
            : JSON.stringify(DwStateSchema.parse(operation.dynamicWorkflowState)),
        updatedAt: now,
      })
      .onConflictDoNothing({ target: workgroupTaskState.taskId })
      .run()
    return
  }
  if (operation.kind === 'seed-goal-if-empty') {
    const existing = await transaction
      .select({ id: workgroupMessages.id })
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
      .limit(1)
      .get()
    if (existing === undefined) await insertMessage(transaction, taskId, operation.message)
    return
  }
  if (operation.kind === 'transition-assignment') {
    assertAssignmentTransition(operation)
    const changed = await transaction
      .update(workgroupAssignments)
      .set({
        status: operation.to,
        updatedAt: now,
        ...(operation.set?.assigneeMemberId === undefined
          ? {}
          : { assigneeMemberId: operation.set.assigneeMemberId }),
        ...(operation.set?.nodeRunId === undefined ? {} : { nodeRunId: operation.set.nodeRunId }),
        ...(operation.set?.resultMessageId === undefined
          ? {}
          : { resultMessageId: operation.set.resultMessageId }),
        ...(operation.bumpAttempt === true
          ? { attemptCount: sql`${workgroupAssignments.attemptCount} + 1` }
          : {}),
      })
      .where(
        and(
          eq(workgroupAssignments.taskId, taskId),
          eq(workgroupAssignments.id, operation.assignmentId),
          eq(workgroupAssignments.status, operation.from),
        ),
      )
      .returning({ id: workgroupAssignments.id })
      .all()
    if (changed.length !== 1) throw new WorkgroupLedgerConflict(operation.operationKey)
    return
  }
  if (operation.kind === 'repoint-assignment-run') {
    const changed = await transaction
      .update(workgroupAssignments)
      .set({ nodeRunId: operation.nodeRunId, updatedAt: now })
      .where(
        and(
          eq(workgroupAssignments.taskId, taskId),
          eq(workgroupAssignments.id, operation.assignmentId),
          eq(workgroupAssignments.status, 'running'),
        ),
      )
      .returning({ id: workgroupAssignments.id })
      .all()
    if (changed.length !== 1) throw new WorkgroupLedgerConflict(operation.operationKey)
    return
  }
  if (operation.kind === 'create-assignment') {
    if (operation.assignment.dedupKey !== null) {
      const occupied = await transaction
        .select({ id: workgroupAssignments.id })
        .from(workgroupAssignments)
        .where(
          and(
            eq(workgroupAssignments.taskId, taskId),
            eq(workgroupAssignments.dedupKey, operation.assignment.dedupKey),
            ne(workgroupAssignments.status, 'canceled'),
          ),
        )
        .limit(1)
        .get()
      if (occupied !== undefined) return
    }
    await transaction
      .insert(workgroupAssignments)
      .values({ ...operation.assignment, taskId })
      .run()
    return
  }
  if (operation.kind === 'create-message') {
    if (operation.message.kind === 'dispatch' && operation.message.assignmentId !== null) {
      const assignment = await transaction
        .select({ id: workgroupAssignments.id })
        .from(workgroupAssignments)
        .where(
          and(
            eq(workgroupAssignments.taskId, taskId),
            eq(workgroupAssignments.id, operation.message.assignmentId),
          ),
        )
        .get()
      if (assignment === undefined) return
    }
    await insertMessage(transaction, taskId, operation.message)
    return
  }
  if (operation.kind === 'advance-member-cursor') {
    await transaction
      .insert(workgroupMemberCursors)
      .values({
        taskId,
        memberId: operation.memberId,
        lastConsumedMessageId: operation.messageId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workgroupMemberCursors.taskId, workgroupMemberCursors.memberId],
        set: {
          lastConsumedMessageId: sql`GREATEST(${workgroupMemberCursors.lastConsumedMessageId}, excluded.last_consumed_message_id)`,
          updatedAt: now,
        },
      })
      .run()
    return
  }
  if (operation.kind === 'transition-gate') {
    assertGateTransition(operation)
    const changed = await transaction
      .update(workgroupTaskState)
      .set({ gateStatus: operation.to, updatedAt: now, ...gatePatch(operation) })
      .where(
        and(
          eq(workgroupTaskState.taskId, taskId),
          inArray(workgroupTaskState.gateStatus, [...operation.from]),
        ),
      )
      .returning({ taskId: workgroupTaskState.taskId })
      .all()
    if (changed.length !== 1) throw new WorkgroupLedgerConflict(operation.operationKey)
    return
  }
  if (operation.kind === 'set-pause-reason') {
    const changed = await transaction
      .update(workgroupTaskState)
      .set({ pauseReason: operation.reason, updatedAt: now })
      .where(eq(workgroupTaskState.taskId, taskId))
      .returning({ taskId: workgroupTaskState.taskId })
      .all()
    if (changed.length !== 1) throw new WorkgroupLedgerConflict(operation.operationKey)
    return
  }
  if (operation.kind === 'set-dynamic-workflow-state') {
    const changed = await transaction
      .update(workgroupTaskState)
      .set({
        dwStateJson: JSON.stringify(DwStateSchema.parse(operation.state)),
        updatedAt: now,
      })
      .where(eq(workgroupTaskState.taskId, taskId))
      .returning({ taskId: workgroupTaskState.taskId })
      .all()
    if (changed.length !== 1) throw new WorkgroupLedgerConflict(operation.operationKey)
    return
  }
  const changed = await transaction
    .update(workgroupTaskState)
    .set({ resultMessageId: operation.messageId, updatedAt: now })
    .where(eq(workgroupTaskState.taskId, taskId))
    .returning({ taskId: workgroupTaskState.taskId })
    .all()
  if (changed.length !== 1) throw new WorkgroupLedgerConflict(operation.operationKey)
}

function createPostgresqlWorkgroupTurnsPersistence(
  dependencies: PostgresqlWorkgroupTurnsDependencies,
): WorkgroupTurnsPersistencePort {
  return Object.freeze({
    async load(taskId: string): Promise<WorkgroupTurnsSnapshot | null> {
      return await runPostgresqlResourceCatalogTransaction(
        dependencies.db,
        async (transaction) =>
          await loadSnapshot(
            transaction,
            dependencies.hostLedgerFactory.inTransaction(transaction),
            taskId,
          ),
      )
    },
    async commit(
      input: Parameters<WorkgroupTurnsPersistencePort['commit']>[0],
    ): Promise<WorkgroupTurnsLedgerCommitReceipt> {
      try {
        return await runPostgresqlResourceCatalogTransaction(
          dependencies.db,
          async (transaction) => {
            const hostLedger = dependencies.hostLedgerFactory.inTransaction(transaction)
            const mintedRuns: WorkgroupTurnMintedRun[] = []
            for (const operation of input.operations) {
              if (isHostLedgerOperation(operation)) {
                const receipt = await hostLedger.apply({
                  taskId: input.taskId,
                  operations: [operation],
                })
                if (!receipt.committed) {
                  throw new WorkgroupLedgerConflict(receipt.conflictOperationKey)
                }
                mintedRuns.push(...receipt.mintedRuns)
                continue
              }
              await applyResourceCatalogOperation(transaction, input.taskId, operation)
            }
            return { committed: true, mintedRuns }
          },
        )
      } catch (error) {
        if (error instanceof WorkgroupLedgerConflict) {
          return { committed: false, conflictOperationKey: error.operationKey }
        }
        throw error
      }
    },
  })
}

/** Real PostgreSQL Resource Catalog owner for the TaskExecution consumer port. */
export function createPostgresqlWorkgroupTurnsOperations(
  dependencies: PostgresqlWorkgroupTurnsDependencies,
): WorkgroupTurnsOperations {
  return createWorkgroupTurnsOperations(createPostgresqlWorkgroupTurnsPersistence(dependencies))
}
