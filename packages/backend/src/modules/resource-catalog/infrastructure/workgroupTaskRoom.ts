import {
  DwStateSchema,
  WorkgroupOutputContractSchema,
  WorkgroupRuntimeConfigSchema,
  WorkflowNameSchema,
  WORKGROUP_MAX_ROUNDS_LIMIT,
  isWorkgroupTask,
  parseBatchShardKey,
  parseMsgShardKey,
  type DwState,
  type WorkflowDefinition,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { agents, resourceGrants, workgroupAssignments, workgroupTaskState } from '@/db/schema'
import type {
  WorkgroupTaskRoomEventIdentity,
  WorkgroupTaskRoomTaskParticipantInTx,
} from '@/modules/task-execution/public/commands'
import type { ProviderNeutralDatabase } from '@/db/query'
import { NotFoundError, ValidationError } from '@/util/errors'
import { deriveBudgetUsed, roundedModeOf } from '../application/workgroups/workgroupRoomProjection'
import {
  hasPrivateResourceAccess,
  hasResourceAclBypass,
  isVisibleRow,
} from '../domain/resourceAccess'
import type { WorkgroupOperationContext } from '../public/participants'
import type { WorkgroupTaskJsonDocument } from '../public/types'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'
import { workgroupTaskSubmissionBody } from './workgroupTaskSubmission'

type AssignmentRow = typeof workgroupAssignments.$inferSelect
export type AssignmentStatus = AssignmentRow['status']
export type RoomEvent =
  | Readonly<{ type: 'wg.message.created'; messageId: string; kind: string }>
  | Readonly<{ type: 'wg.assignment.updated'; assignmentId: string; status: string }>
  | Readonly<{ type: 'wg.gate.updated'; awaitingConfirmation: boolean }>
  | Readonly<{ type: 'node.status'; nodeRunId: string; nodeId: string; status: 'done' }>

export interface WorkgroupTaskRoomTaskParticipantFactory {
  inTransaction(transaction: ResourceCatalogTransaction): WorkgroupTaskRoomTaskParticipantInTx
}

export interface WorkgroupTaskRoomActiveUserDirectory {
  findActiveUserIds(userIds: readonly string[]): Promise<ReadonlySet<string>>
}

export interface WorkgroupTaskRoomDynamicWorkflowOperations {
  validateGenerated(
    authority: WorkgroupOperationContext,
    input: Readonly<{
      definition: WorkflowDefinition
      triggerContextJson: string | null
      poolAgentIds: readonly string[]
    }>,
  ): Promise<WorkflowDefinition>
  create(
    authority: WorkgroupOperationContext,
    input: Readonly<{ name: string; description: string; definition: WorkflowDefinition }>,
  ): Promise<Readonly<{ id: string; name: string }>>
}

/**
 * RFC-359 W4-D19b —— 房间「恢复执行」的部署形态差异，收成一个注入端口（按 daemon 在不在同一进程里分，
 * 不按数据库分）。房间自己只负责在一笔事务里把决策与继续执行的意图一起落库；意图统一是
 * `gate-continuation` 类，落库形态两端完全一致。
 *
 * - 单进程部署（SQLite 单二进制）：受理请求的进程就是持有工作树、也持有调度器的那个进程。
 *   于是提交前能判定这次恢复是否可行——工作树被 GC 回收掉的任务直接 410 打回，闸门 / holder /
 *   消息随事务整体回滚、决策保持可重试（rfc164「confirm 恢复失败时全部保持可重试」与 rfc167 的
 *   相位复位锁的就是这条）；提交后就地认领意图把执行驱起来。
 * - 多进程部署（PostgreSQL daemon）：受理请求的进程未必看得到该任务的工作树、也未必该驱动它，
 *   两件都是空操作，由 daemon 的 `human-gate-continuation` worker 轮询认领
 *   （`humanGateContinuationRecovery.ts` / `humanGateContinuationWorker.ts`）。
 */
export interface WorkgroupTaskRoomContinuationDriver {
  /** 提交前的可恢复性预检；不可恢复就抛（房间的写入随事务回滚）。 */
  assertResumable(taskId: string, verb: string): Promise<void>
  /** 提交后驱动这条**已准入**的继续意图：只认领它，不做第二次生命周期转移、不落第二条意图。 */
  driveAfterCommit(continuation: Readonly<{ taskId: string; intentId: string }>): Promise<void>
}

export interface WorkgroupTaskRoomDependencies {
  readonly db: ProviderNeutralDatabase
  readonly taskParticipantFactory: WorkgroupTaskRoomTaskParticipantFactory
  readonly continuation: WorkgroupTaskRoomContinuationDriver
  readonly activeUsers: WorkgroupTaskRoomActiveUserDirectory
  readonly dynamicWorkflow: WorkgroupTaskRoomDynamicWorkflowOperations
  readonly systemUserId: string
  readonly broadcast: (taskId: string, event: RoomEvent) => void
  readonly now?: () => number
  readonly id?: () => string
}

const JsonObjectSchema = z.record(z.string(), z.unknown())
export const PostMessageSchema = z.object({ body: z.string().trim().min(1).max(65_536) })
export const DeliverSchema = z
  .object({
    body: z.string().trim().min(1).max(65_536).optional(),
    summary: z.string().trim().min(1).max(16_384).optional(),
    detail: z.string().max(65_536).optional(),
  })
  .refine((input) => input.body !== undefined || input.summary !== undefined, {
    message: 'body or summary is required',
  })
export const ConfirmSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    comment: z.string().trim().max(65_536).optional(),
  })
  .refine(
    (input) =>
      input.decision !== 'reject' || (input.comment !== undefined && input.comment.length > 0),
    { message: 'reject requires a comment' },
  )
export const SaveAsWorkflowSchema = z.object({
  name: WorkflowNameSchema,
  description: z.string().max(4096).optional(),
})
export const ConfigPatchSchema = z.object({
  switches: z
    .object({
      shareOutputs: z.boolean(),
      directMessages: z.boolean(),
      blackboard: z.boolean(),
    })
    .optional(),
  maxRounds: z.number().int().positive().max(WORKGROUP_MAX_ROUNDS_LIMIT).optional(),
  completionGate: z.boolean().optional(),
  clarifyBudget: z.number().int().min(0).max(50).optional(),
  fanOut: z.boolean().optional(),
  outputContract: WorkgroupOutputContractSchema.optional(),
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
        .superRefine((member, context) => {
          if (member.memberType === 'agent' && member.agentId === undefined) {
            context.addIssue({ code: 'custom', message: 'agent member requires agentId' })
          }
          if (member.memberType === 'agent' && member.userId !== undefined) {
            context.addIssue({ code: 'custom', message: 'agent member must not carry userId' })
          }
          if (member.memberType === 'human' && member.userId === undefined) {
            context.addIssue({ code: 'custom', message: 'human member requires userId' })
          }
          if (member.memberType === 'human' && member.agentId !== undefined) {
            context.addIssue({ code: 'custom', message: 'human member must not carry agentId' })
          }
        }),
    )
    .max(16)
    .optional(),
  removeMemberIds: z.array(z.string().min(1)).max(64).optional(),
})

interface LoadedState {
  readonly gateStatus: typeof workgroupTaskState.$inferSelect.gateStatus
  readonly gateSummary: string | null
  readonly gateRejectedComment: string | null
  readonly pauseReason: string | null
  readonly dw: DwState | null
}

/** 与 SQLite adapter 共用同一份判据，见 `workgroupTaskSubmission.ts`。 */
export const inputBody = workgroupTaskSubmissionBody

export function document(value: unknown): WorkgroupTaskJsonDocument {
  return Object.freeze({ kind: 'json-document' as const, body: JSON.stringify(value) })
}

export function parseConfig(value: string | null): {
  readonly config: WorkgroupRuntimeConfig
  readonly raw: Record<string, unknown>
} | null {
  if (value === null) return null
  try {
    const raw = JsonObjectSchema.parse(JSON.parse(value))
    const config = WorkgroupRuntimeConfigSchema.safeParse(raw)
    return config.success ? { config: config.data, raw } : null
  } catch {
    return null
  }
}

function parseState(row: typeof workgroupTaskState.$inferSelect | undefined): LoadedState {
  let dw: DwState | null = null
  if (row?.dwStateJson != null) {
    try {
      const parsed = DwStateSchema.safeParse(JSON.parse(row.dwStateJson))
      if (parsed.success) dw = parsed.data
    } catch {
      // Corrupt optional checkpoint is projected as absent, matching SQLite.
    }
  }
  return {
    gateStatus: row?.gateStatus ?? 'idle',
    gateSummary: row?.gateSummary ?? null,
    gateRejectedComment: row?.gateRejectedComment ?? null,
    pauseReason: row?.pauseReason ?? null,
    dw,
  }
}

async function loadState(
  transaction: ResourceCatalogTransaction,
  taskId: string,
): Promise<LoadedState> {
  return parseState(
    (
      await transaction
        .select()
        .from(workgroupTaskState)
        .where(eq(workgroupTaskState.taskId, taskId))
        .limit(1)
    )[0],
  )
}

export async function loadVisibleTask(
  transaction: ResourceCatalogTransaction,
  participant: WorkgroupTaskRoomTaskParticipantInTx,
  authority: WorkgroupOperationContext,
  taskId: string,
) {
  const task = await participant.loadVisible(authority, taskId)
  const parsed = parseConfig(task?.workgroupConfigJson ?? null)
  if (task === null || !isWorkgroupTask(task) || parsed === null) {
    throw new NotFoundError('workgroup-task-not-found', `workgroup task '${taskId}' not found`)
  }
  return { task, ...parsed, state: await loadState(transaction, taskId) }
}

export function identity(
  operationRef: string,
  nextId: () => string,
): WorkgroupTaskRoomEventIdentity {
  const eventGroupId = nextId()
  return Object.freeze({
    operationRef,
    eventGroupId,
    eventGroupOrdinal: 0,
    correlationRef: eventGroupId,
  })
}

export function isResumable(status: string): status is 'awaiting_human' | 'interrupted' {
  return status === 'awaiting_human' || status === 'interrupted'
}

export function firstLine(body: string): string {
  const line = body.split('\n')[0]?.trim() ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}…` : line.length > 0 ? line : '(untitled)'
}

export function mentions(body: string, config: WorkgroupRuntimeConfig) {
  const byName = new Map(config.members.map((member) => [member.displayName, member]))
  const resolved = new Map<string, WorkgroupRuntimeConfig['members'][number]>()
  for (const match of body.matchAll(/@([^\s@,]+)/gu)) {
    const member = byName.get(match[1] ?? '')
    if (member !== undefined) resolved.set(member.id, member)
  }
  return [...resolved.values()]
}

export function mentionIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export async function transitionAssignment(
  transaction: ResourceCatalogTransaction,
  input: Readonly<{
    id: string
    taskId: string
    from: AssignmentStatus
    to: AssignmentStatus
    now: number
    patch?: Partial<typeof workgroupAssignments.$inferInsert>
  }>,
): Promise<boolean> {
  const changed = await transaction
    .update(workgroupAssignments)
    .set({ ...input.patch, status: input.to, updatedAt: input.now })
    .where(
      and(
        eq(workgroupAssignments.id, input.id),
        eq(workgroupAssignments.taskId, input.taskId),
        eq(workgroupAssignments.status, input.from),
      ),
    )
    .returning({ id: workgroupAssignments.id })
  return changed.length === 1
}

export async function messageRound(
  participant: WorkgroupTaskRoomTaskParticipantInTx,
  taskId: string,
  mode: WorkgroupRuntimeConfig['mode'],
): Promise<number> {
  const rounded = roundedModeOf(mode)
  if (rounded !== 'leader_worker') return 0
  return deriveBudgetUsed(rounded, await participant.listHostRuns(taskId))
}

export async function visibleAgentRows(
  transaction: ResourceCatalogTransaction,
  authority: WorkgroupOperationContext,
  ids: readonly string[],
): Promise<ReadonlyMap<string, Readonly<{ id: string; name: string }>>> {
  if (ids.length === 0) return new Map()
  const rows = await transaction
    .select({
      id: agents.id,
      name: agents.name,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(inArray(agents.id, [...ids]))
  let granted = new Set<string>()
  if (!hasResourceAclBypass(authority) && hasPrivateResourceAccess(authority)) {
    granted = new Set(
      (
        await transaction
          .select({ resourceId: resourceGrants.resourceId })
          .from(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, 'agent'),
              eq(resourceGrants.userId, authority.user.id),
              inArray(resourceGrants.resourceId, [...ids]),
            ),
          )
      ).map((row) => row.resourceId),
    )
  }
  const visible = hasResourceAclBypass(authority)
    ? rows
    : rows.filter((row) =>
        hasPrivateResourceAccess(authority)
          ? isVisibleRow(authority, row, granted)
          : row.visibility === 'public',
      )
  const visibleIds = new Set(visible.map((row) => row.id))
  const hidden = ids.filter((id) => rows.some((row) => row.id === id) && !visibleIds.has(id))
  if (hidden.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${hidden.map((id) => `agent '${id}'`).join(', ')}`,
      { missing: hidden.map((id) => ({ type: 'agent', name: id })) },
    )
  }
  return new Map(visible.map((row) => [row.id, { id: row.id, name: row.name }]))
}

export async function requeueDismissedAssignments(
  transaction: ResourceCatalogTransaction,
  input: Readonly<{
    taskId: string
    mode: WorkgroupRuntimeConfig['mode']
    shardKeys: readonly string[]
    now: number
  }>,
): Promise<readonly Readonly<{ assignmentId: string; status: AssignmentStatus }>[]> {
  const ids = new Set<string>()
  for (const shardKey of input.shardKeys) {
    if (parseMsgShardKey(shardKey) !== null) continue
    const batch = parseBatchShardKey(shardKey)
    for (const id of batch?.assignmentIds ?? [shardKey]) ids.add(id)
  }
  if (ids.size === 0) return []
  const status = input.mode === 'free_collab' ? 'open' : 'dispatched'
  const changed = await transaction
    .update(workgroupAssignments)
    .set({
      status,
      nodeRunId: null,
      ...(input.mode === 'free_collab' ? { assigneeMemberId: null } : {}),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(workgroupAssignments.taskId, input.taskId),
        eq(workgroupAssignments.status, 'awaiting_human'),
        inArray(workgroupAssignments.id, [...ids]),
      ),
    )
    .returning({ id: workgroupAssignments.id })
  return changed.map((row) => ({ assignmentId: row.id, status }))
}

export type WorkgroupTaskRoomTransactionRunner = <T>(
  body: (
    transaction: ResourceCatalogTransaction,
    participant: WorkgroupTaskRoomTaskParticipantInTx,
  ) => Promise<T>,
) => Promise<T>

export function createWorkgroupTaskRoomTransactionRunner(
  dependencies: Pick<WorkgroupTaskRoomDependencies, 'db' | 'taskParticipantFactory'>,
): WorkgroupTaskRoomTransactionRunner {
  return async <T>(
    body: (
      transaction: ResourceCatalogTransaction,
      participant: WorkgroupTaskRoomTaskParticipantInTx,
    ) => Promise<T>,
  ): Promise<T> =>
    runResourceCatalogTransaction(dependencies.db, async (transaction) =>
      body(transaction, dependencies.taskParticipantFactory.inTransaction(transaction)),
    )
}
