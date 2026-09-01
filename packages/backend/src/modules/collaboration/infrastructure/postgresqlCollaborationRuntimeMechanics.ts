import {
  ClarifyEnvelopeBodySchema,
  ClarifyQuestionSchema,
  REVIEW_APPROVAL_META_PORT,
  REVIEW_APPROVED_PORT_MULTI,
  SYSTEM_DECIDER,
  SIBLING_OUTPUTS_INSTRUCTION,
  buildPriorSelectionLookup,
  buildWorkflowScopeParentMap,
  findQuestionerNodeForCrossClarify,
  inheritSelection,
  isInlineMarkdownListReviewInput,
  isMultiDocReviewInput,
  isMultiMarkdownUpstream,
  migrateWorkflowDefinitionToLatest,
  parseBatchShardKey,
  parseMsgShardKey,
  renderFlatClarifyQueue,
  resolveWorkflowSourceRef,
  resolveClarifyBudget,
  wgClarifyAskerKey,
  workgroupHasHumanMember,
  WorkflowDefinitionSchema,
  type ClarifyAnswer,
  type ClarifyDirective,
  type ClarifyQuestion,
  type FlatClarifyEntry,
  type ReviewPromptContext,
  type PriorRoundMember,
  type RunLineageView,
  type WorkflowDefinition,
  type WorkgroupAssignmentStatus,
  splitListItems,
  splitMarkdownDocs,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'

import {
  agents,
  clarifyRounds,
  docVersions,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskQuestions,
  tasks,
  workgroupAssignments,
} from '@/db/schema'
import {
  appendPostgresqlTaskNodeStatusesTx,
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  type PostgresqlTaskExecutionTransaction,
  transitionPostgresqlHumanGateTaskTx,
  withPostgresqlSerializableTaskExecution,
} from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction'
import { createPostgresqlNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/postgresqlNodeRunMintParticipant'
import type { NodeRunLifecycleParticipantInTx } from '@/modules/task-execution/public/commands'
import {
  finalizeCommittedHumanGate,
  prepareClarifyGateOpen,
  prepareReviewGateOpen,
} from '@/modules/collaboration/public/commands'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { isPathishKindString, readPortArtifact } from '@/services/portArtifacts'
import { pickFreshestRun, pickVisibleUpstreamRun } from '@/services/freshness'
import { parseConsumedJson } from '@/services/freshness'
import { ConflictError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import { TASK_QUESTION_CONFLICT } from '@/services/taskQuestionConflicts'
import type {
  CollaborationAutonomousDismissalResult,
  CollaborationClarifyQueueContext,
  CollaborationClarifyQueueInput,
  CollaborationReviewDispatchInput,
  CollaborationRuntimeMechanics,
  CollaborationTaskRuntimeOperations,
} from '../application/ports/collaborationRuntimeMechanics'
import { createPostgresqlCollaborationCommandContext } from '../composition/commandContext'
import { isDispatchedEntryConsumed, isTargetNodeConsumed } from './legacySqliteClarify/rerunLedger'
import { createPostgresqlClarifyDirectiveStore } from './postgresqlClarifyDirectiveStore'
import { PostgresqlCommittedReviewArtifactReader } from './postgresqlCommittedReviewArtifactReader'

const log = createLogger('collaboration-runtime-mechanics')
const WG_LEADER_NODE_ID = '__wg_leader__'

export interface PostgresqlCollaborationRuntimeMechanicsDependencies {
  readonly taskRuntime: CollaborationTaskRuntimeOperations
  readonly nodeRunLifecycle: PostgresqlCollaborationNodeRunLifecycleParticipantFactory
}

export interface PostgresqlCollaborationNodeRunLifecycleParticipantFactory {
  inTransaction(transaction: PostgresqlTaskExecutionTransaction): NodeRunLifecycleParticipantInTx
}

type TaskQuestionRow = typeof taskQuestions.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

interface AgentQueueEntry {
  readonly id: string
  readonly dispatchedAt: number | null
  readonly questionId: string
  readonly originNodeRunId: string
  readonly render: FlatClarifyEntry
}

function safeArray<T>(value: string | null): T[] | undefined {
  if (value === null) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : undefined
  } catch {
    return undefined
  }
}

async function outputRunIds(
  db: PostgresqlDatabaseClient,
  runIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, [...runIds]))
  return new Set(rows.map((row) => row.nodeRunId))
}

async function selectAgentQueue(
  db: PostgresqlDatabaseClient,
  input: CollaborationClarifyQueueInput,
): Promise<readonly AgentQueueEntry[]> {
  const candidates = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, input.taskId),
        isNotNull(taskQuestions.dispatchedAt),
        or(
          eq(taskQuestions.overrideTargetNodeId, input.consumerNodeId),
          and(
            isNull(taskQuestions.overrideTargetNodeId),
            eq(taskQuestions.defaultTargetNodeId, input.consumerNodeId),
          ),
        ),
      ),
    )
  const dispatched = candidates.filter(
    (entry) => entry.sealedAt !== null || entry.sourceKind === 'manual',
  )
  if (dispatched.length === 0) return []

  const runRows = await db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.id, input.dispatchedRunId))
    .limit(1)
  const dispatchedRun = runRows[0]
  const iteration = dispatchedRun?.iteration ?? 0
  const sameNode =
    dispatchedRun === undefined
      ? []
      : await db
          .select()
          .from(nodeRuns)
          .where(
            and(
              eq(nodeRuns.taskId, input.taskId),
              eq(nodeRuns.nodeId, input.consumerNodeId),
              eq(nodeRuns.iteration, iteration),
              ...(input.shardKey === undefined
                ? []
                : [
                    input.shardKey === null
                      ? isNull(nodeRuns.shardKey)
                      : eq(nodeRuns.shardKey, input.shardKey),
                  ]),
            ),
          )
  const outputs = await outputRunIds(
    db,
    sameNode.map((run) => run.id),
  )
  const unaged = dispatched.filter(
    (entry) =>
      !isTargetNodeConsumed(input.consumerNodeId, iteration, entry.triggerRunId, sameNode, outputs),
  )
  const visible =
    input.currentRunOnly === true
      ? unaged.filter(
          (entry) => entry.triggerRunId === null || entry.triggerRunId === input.dispatchedRunId,
        )
      : unaged
  if (visible.length === 0) return []

  const originIds = [
    ...new Set(
      visible
        .filter((entry) => entry.sourceKind !== 'manual')
        .map((entry) => entry.originNodeRunId),
    ),
  ]
  const roundRows =
    originIds.length === 0
      ? []
      : await db
          .select()
          .from(clarifyRounds)
          .where(inArray(clarifyRounds.intermediaryNodeRunId, originIds))
  const roundByOrigin = new Map(
    roundRows.map((round) => [
      round.intermediaryNodeRunId,
      {
        askingShardKey: round.askingShardKey,
        questions: new Map(
          (safeArray<ClarifyQuestion>(round.questionsJson) ?? []).map((question) => [
            question.id,
            question,
          ]),
        ),
        answers: new Map(
          (safeArray<ClarifyAnswer>(round.answersJson) ?? []).map((answer) => [
            answer.questionId,
            answer,
          ]),
        ),
        renderable:
          round.status !== 'canceled' && round.status !== 'abandoned' && round.answersJson !== null,
      },
    ]),
  )

  const result: AgentQueueEntry[] = []
  for (const entry of visible) {
    let render: FlatClarifyEntry | undefined
    if (entry.sourceKind === 'manual') {
      if (entry.questionTitle.trim().length > 0 || (entry.manualBody ?? '').trim().length > 0) {
        render = { manualTitle: entry.questionTitle, manualBody: entry.manualBody }
      }
    } else {
      const round = roundByOrigin.get(entry.originNodeRunId)
      if (
        round?.renderable === true &&
        (input.shardKey === undefined || round.askingShardKey === input.shardKey)
      ) {
        const question = round.questions.get(entry.questionId)
        if (question !== undefined) {
          render = { question, answer: round.answers.get(entry.questionId) }
        }
      }
    }
    if (render !== undefined) {
      result.push({
        id: entry.id,
        dispatchedAt: entry.dispatchedAt,
        questionId: entry.questionId,
        originNodeRunId: entry.originNodeRunId,
        render,
      })
    }
  }
  result.sort(
    (left, right) =>
      (left.dispatchedAt ?? 0) - (right.dispatchedAt ?? 0) || left.id.localeCompare(right.id),
  )
  return result
}

async function buildPostgresqlClarifyQueueContext(
  db: PostgresqlDatabaseClient,
  input: CollaborationClarifyQueueInput,
): Promise<CollaborationClarifyQueueContext | undefined> {
  const entries = await selectAgentQueue(db, input)
  if (entries.length === 0) return undefined
  const seen = new Set<string>()
  const rendered = entries.filter((entry) => {
    const key = `${entry.originNodeRunId}\u001f${entry.questionId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const block = renderFlatClarifyQueue(
    rendered.map((entry) => entry.render),
    input.envelopeNonce ?? '',
  )
  if (block === undefined) return undefined
  await db
    .update(taskQuestions)
    .set({ triggerRunId: input.dispatchedRunId, updatedAt: Date.now() })
    .where(
      and(
        inArray(
          taskQuestions.id,
          entries.map((entry) => entry.id),
        ),
        or(
          isNull(taskQuestions.triggerRunId),
          ne(taskQuestions.triggerRunId, input.dispatchedRunId),
        ),
      ),
    )
    .run()
  return {
    block,
    sourceRunIds: [...new Set(entries.map((entry) => entry.originNodeRunId))],
  }
}

async function countClarifyAsks(
  db: PostgresqlDatabaseClient,
  taskId: string,
  askerKey: string,
): Promise<number> {
  const rows = await db
    .select({ nodeId: clarifyRounds.askingNodeId, shardKey: clarifyRounds.askingShardKey })
    .from(clarifyRounds)
    .where(and(eq(clarifyRounds.kind, 'self'), eq(clarifyRounds.taskId, taskId)))
  return rows.filter(
    (row) => wgClarifyAskerKey(row.nodeId, row.shardKey, WG_LEADER_NODE_ID) === askerKey,
  ).length
}

async function isPostgresqlTaskClarifySuppressed(
  db: PostgresqlDatabaseClient,
  directives: ReturnType<typeof createPostgresqlClarifyDirectiveStore>,
  input: Parameters<CollaborationRuntimeMechanics['isTaskClarifySuppressed']>[0],
): Promise<boolean> {
  const rows = await db
    .select({ config: tasks.workgroupConfigJson })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  const raw = rows[0]?.config
  if (raw === null || raw === undefined) return false
  try {
    const parsed = JSON.parse(raw) as { members?: unknown; clarifyBudget?: number }
    if (!Array.isArray(parsed.members)) return false
    const members = parsed.members.filter(
      (member): member is { memberType: 'agent' | 'human' } =>
        typeof member === 'object' && member !== null && 'memberType' in member,
    )
    if (!workgroupHasHumanMember(members)) return true
    if (input.nodeId === undefined) return false
    const budget = resolveClarifyBudget({ clarifyBudget: parsed.clarifyBudget })
    if (budget <= 0) return true
    const askerKey = wgClarifyAskerKey(input.nodeId, input.shardKey ?? null, WG_LEADER_NODE_ID)
    if (
      (
        await directives.get({
          taskId: input.taskId,
          nodeId: input.nodeId,
          shardKey: askerKey,
        })
      )?.directive === 'stop'
    ) {
      return true
    }
    return (await countClarifyAsks(db, input.taskId, askerKey)) >= budget
  } catch {
    return false
  }
}

function canRequeueAssignment(
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
): boolean {
  return from === 'awaiting_human' && (to === 'open' || to === 'dispatched')
}

async function dismissPostgresqlClarifyParks(
  db: PostgresqlDatabaseClient,
  dependencies: PostgresqlCollaborationRuntimeMechanicsDependencies,
  input: Parameters<CollaborationRuntimeMechanics['dismissOpenClarifyParksForAutonomous']>[0],
): Promise<CollaborationAutonomousDismissalResult> {
  const resolvedMode =
    input.mode ??
    (await (async () => {
      const rows = await db
        .select({ config: tasks.workgroupConfigJson })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
      try {
        const parsed = JSON.parse(rows[0]?.config ?? '{}') as { mode?: unknown }
        return typeof parsed.mode === 'string' ? parsed.mode : 'leader_worker'
      } catch {
        return 'leader_worker'
      }
    })())
  const result = await withPostgresqlSerializableTaskExecution(db, async (tx) => {
    const nodeRunLifecycle = dependencies.nodeRunLifecycle.inTransaction(tx)
    const dismissed: CollaborationAutonomousDismissalResult = {
      dismissedSessions: 0,
      canceledParkRuns: [],
      requeuedAssignments: [],
    }
    const open = await tx
      .select({
        id: clarifyRounds.id,
        nodeRunId: clarifyRounds.intermediaryNodeRunId,
        nodeId: clarifyRounds.intermediaryNodeId,
        shardKey: clarifyRounds.askingShardKey,
      })
      .from(clarifyRounds)
      .where(
        and(
          eq(clarifyRounds.kind, 'self'),
          eq(clarifyRounds.taskId, input.taskId),
          eq(clarifyRounds.status, 'awaiting_human'),
        ),
      )
    for (const round of open) {
      ;(dismissed as { dismissedSessions: number }).dismissedSessions += 1
      const parked = (
        await tx
          .select({ status: nodeRuns.status })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, round.nodeRunId))
          .limit(1)
      )[0]
      if (parked?.status === 'awaiting_human') {
        await nodeRunLifecycle.set({
          nodeRunId: round.nodeRunId,
          to: 'canceled',
          allowedFrom: ['awaiting_human'],
          extra: {
            finishedAt: Date.now(),
            errorMessage: 'wg-clarify-disabled',
          },
          reason: 'wg-clarify-disabled',
        })
        ;(dismissed.canceledParkRuns as Array<{ nodeRunId: string; nodeId: string }>).push({
          nodeRunId: round.nodeRunId,
          nodeId: round.nodeId,
        })
      }
      await tx
        .update(clarifyRounds)
        .set({ status: 'canceled' })
        .where(and(eq(clarifyRounds.id, round.id), eq(clarifyRounds.status, 'awaiting_human')))
        .run()
      const shard = round.shardKey
      if (shard === null || parseMsgShardKey(shard) !== null) continue
      const batch = parseBatchShardKey(shard)
      const ids = batch === null ? [shard] : batch.assignmentIds
      const to: WorkgroupAssignmentStatus = resolvedMode === 'free_collab' ? 'open' : 'dispatched'
      if (!canRequeueAssignment('awaiting_human', to)) {
        throw new Error(`illegal workgroup assignment transition awaiting_human -> ${to}`)
      }
      const requeued = await tx
        .update(workgroupAssignments)
        .set({
          status: to,
          nodeRunId: null,
          ...(resolvedMode === 'free_collab' ? { assigneeMemberId: null } : {}),
          updatedAt: Date.now(),
        })
        .where(
          and(
            inArray(workgroupAssignments.id, ids),
            eq(workgroupAssignments.taskId, input.taskId),
            eq(workgroupAssignments.status, 'awaiting_human'),
          ),
        )
        .returning({ id: workgroupAssignments.id })
      for (const row of requeued) {
        ;(
          dismissed.requeuedAssignments as Array<{ id: string; to: WorkgroupAssignmentStatus }>
        ).push({ id: row.id, to })
      }
    }
    return dismissed
  })
  for (const run of result.canceledParkRuns) {
    taskBroadcaster.broadcast(TASK_CHANNEL(input.taskId), {
      id: -1,
      type: 'node.status',
      nodeRunId: run.nodeRunId,
      nodeId: run.nodeId,
      status: 'canceled',
    })
  }
  for (const assignment of result.requeuedAssignments) {
    taskBroadcaster.broadcast(TASK_CHANNEL(input.taskId), {
      id: -1,
      type: 'wg.assignment.updated',
      assignmentId: assignment.id,
      status: assignment.to,
    })
  }
  return result
}

interface BorrowLedger {
  readonly open: boolean
  readonly borrowAgentName: string | null
  readonly anchorRunIds: ReadonlySet<string>
}

const CLOSED_BORROW_LEDGER: BorrowLedger = Object.freeze({
  open: false,
  borrowAgentName: null,
  anchorRunIds: new Set<string>(),
})

function effectiveTarget(entry: TaskQuestionRow): string | null {
  return entry.overrideTargetNodeId ?? entry.defaultTargetNodeId
}

function borrowNodeFor(entry: TaskQuestionRow, nodeId: string): string | null {
  const home = entry.defaultTargetNodeId ?? entry.overrideTargetNodeId
  return home === nodeId &&
    entry.overrideTargetNodeId !== null &&
    entry.overrideTargetNodeId !== home
    ? entry.overrideTargetNodeId
    : null
}

function agentNameFor(definition: WorkflowDefinition, nodeId: string): string | null {
  return (
    (
      definition.nodes.find((node) => node.id === nodeId) as
        | { readonly agentName?: string }
        | undefined
    )?.agentName ?? null
  )
}

function lineageViews(runs: readonly NodeRunRow[], outputs: ReadonlySet<string>): RunLineageView[] {
  return runs.map((run) => ({
    id: run.id,
    nodeId: run.nodeId,
    iteration: run.iteration,
    loopIter: 0,
    rerunCause: run.rerunCause,
    status: run.status,
    startedAt: run.startedAt,
    hasOutput: outputs.has(run.id),
    parentNodeRunId: run.parentNodeRunId,
    shardKey: run.shardKey,
  }))
}

async function loadBorrowRuns(db: PostgresqlDatabaseClient, taskId: string) {
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  return {
    runs,
    outputs: await outputRunIds(
      db,
      runs.map((run) => run.id),
    ),
  }
}

async function designerBorrowLedger(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRuntimeMechanics['resolveBorrowForNode']>[0],
): Promise<BorrowLedger> {
  const candidates = (
    await db
      .select()
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.taskId, input.taskId),
          eq(taskQuestions.roleKind, 'designer'),
          eq(taskQuestions.loopIter, input.iteration),
          isNotNull(taskQuestions.dispatchedAt),
        ),
      )
  )
    .filter((entry) => effectiveTarget(entry) === input.nodeId)
    .sort((left, right) => left.id.localeCompare(right.id))
  if (candidates.length === 0) return CLOSED_BORROW_LEDGER
  const loaded = await loadBorrowRuns(db, input.taskId)
  const views = lineageViews(loaded.runs, loaded.outputs)
  const open = candidates.filter(
    (entry) => !isDispatchedEntryConsumed(entry, loaded.runs, views, 'revivable'),
  )
  if (open.length === 0) return CLOSED_BORROW_LEDGER
  const borrowNode =
    open.map((entry) => borrowNodeFor(entry, input.nodeId)).find((value) => value !== null) ?? null
  return {
    open: true,
    borrowAgentName: borrowNode === null ? null : agentNameFor(input.definition, borrowNode),
    anchorRunIds: new Set(
      open.flatMap((entry) => (entry.triggerRunId === null ? [] : [entry.triggerRunId])),
    ),
  }
}

async function selfQuestionerBorrowLedger(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRuntimeMechanics['resolveBorrowForNode']>[0],
): Promise<BorrowLedger> {
  const candidates = (
    await db
      .select()
      .from(taskQuestions)
      .where(
        and(
          eq(taskQuestions.taskId, input.taskId),
          inArray(taskQuestions.roleKind, ['self', 'questioner']),
          isNotNull(taskQuestions.dispatchedAt),
        ),
      )
  ).filter((entry) => effectiveTarget(entry) === input.nodeId)
  if (candidates.length === 0) return CLOSED_BORROW_LEDGER
  const originIds = [...new Set(candidates.map((entry) => entry.originNodeRunId))]
  const rounds = await db
    .select()
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.taskId, input.taskId),
        inArray(clarifyRounds.intermediaryNodeRunId, originIds),
      ),
    )
  const roundByOrigin = new Map(rounds.map((round) => [round.intermediaryNodeRunId, round]))
  const loaded = await loadBorrowRuns(db, input.taskId)
  const runById = new Map(loaded.runs.map((run) => [run.id, run]))
  const views = lineageViews(loaded.runs, loaded.outputs)
  const open = candidates.filter((entry) => {
    const round = roundByOrigin.get(entry.originNodeRunId)
    const askingRun = round === undefined ? undefined : runById.get(round.askingNodeRunId)
    return (
      askingRun?.iteration === input.iteration &&
      !isDispatchedEntryConsumed(entry, loaded.runs, views, 'revivable')
    )
  })
  if (open.length === 0) return CLOSED_BORROW_LEDGER
  const borrowNodes = new Set(open.map((entry) => borrowNodeFor(entry, input.nodeId)))
  if (borrowNodes.size > 1) {
    throw new ConflictError(
      TASK_QUESTION_CONFLICT.homeMultiBorrow,
      `node '${input.nodeId}' (iter ${input.iteration}) has dispatched self/questioner questions reassigned to conflicting handlers (${[
        ...borrowNodes,
      ]
        .map((value) => value ?? '(self)')
        .join(', ')}) in one continuation; align them to one handler.`,
    )
  }
  const borrowNode = [...borrowNodes][0] ?? null
  return {
    open: true,
    borrowAgentName: borrowNode === null ? null : agentNameFor(input.definition, borrowNode),
    anchorRunIds: new Set(
      open.flatMap((entry) => (entry.triggerRunId === null ? [] : [entry.triggerRunId])),
    ),
  }
}

async function resolvePostgresqlBorrowForNode(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRuntimeMechanics['resolveBorrowForNode']>[0],
): Promise<string | null> {
  const dispatched = await db
    .select({ id: taskQuestions.id })
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, input.taskId), isNotNull(taskQuestions.dispatchedAt)))
    .limit(1)
  if (dispatched.length === 0) return null
  const designer = await designerBorrowLedger(db, input)
  const selfQuestioner = await selfQuestionerBorrowLedger(db, input)
  if (designer.open && selfQuestioner.open) {
    const coalesced = [...designer.anchorRunIds].some((id) => selfQuestioner.anchorRunIds.has(id))
    if (!coalesced) {
      const describe = (ledger: BorrowLedger) =>
        ledger.borrowAgentName === null ? 'open (run self)' : `-> ${ledger.borrowAgentName}`
      throw new ConflictError(
        TASK_QUESTION_CONFLICT.borrowLedgerConflict,
        `node '${input.nodeId}' (iter ${input.iteration}) has multiple open reassignment ledgers (dispatched designer ${describe(designer)}, dispatched self/questioner ${describe(selfQuestioner)}); resolve or serialize them before the node reruns.`,
      )
    }
  }
  return (designer.open ? designer : selfQuestioner).borrowAgentName
}

async function buildPostgresqlSiblingOutputs(input: {
  readonly db: PostgresqlDatabaseClient
  readonly taskId: string
  readonly upstreamNodeId: string
  readonly targetPortName: string
}): Promise<string | undefined> {
  const taskRows = await input.db
    .select({ workflowSnapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  const snapshot = taskRows[0]?.workflowSnapshot
  if (snapshot === undefined) return undefined
  let definition: WorkflowDefinition
  try {
    definition = JSON.parse(snapshot) as WorkflowDefinition
  } catch {
    return undefined
  }
  const node = definition.nodes.find((candidate) => candidate.id === input.upstreamNodeId)
  const agentId = (node as { readonly agentId?: unknown } | undefined)?.agentId
  if (typeof agentId !== 'string' || agentId.length === 0) return undefined
  const agentRows = await input.db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
  const agent = agentRows[0]
  if (agent === undefined) return undefined
  let outputKinds: Record<string, string> = {}
  let outputs: string[]
  try {
    const extra = JSON.parse(agent.frontmatterExtra) as Record<string, unknown>
    const rawKinds = extra.outputKinds
    if (rawKinds !== null && typeof rawKinds === 'object') {
      outputKinds = Object.fromEntries(
        Object.entries(rawKinds as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    }
    const rawOutputs: unknown = JSON.parse(agent.outputs)
    if (!Array.isArray(rawOutputs) || rawOutputs.some((value) => typeof value !== 'string')) {
      return undefined
    }
    outputs = rawOutputs as string[]
  } catch {
    return undefined
  }
  const resolved = isMultiMarkdownUpstream({
    outputs: outputs.map((name) =>
      outputKinds[name] === undefined ? { name } : { name, kind: outputKinds[name]! },
    ),
    syncOutputsOnIterate: agent.syncOutputsOnIterate,
  })
  if (!resolved.trigger) return undefined
  const siblingPorts = resolved.markdownPorts.filter((name) => name !== input.targetPortName)
  const sections: string[] = []
  for (const portName of siblingPorts) {
    const rows = await input.db
      .select({ sourceFilePath: docVersions.sourceFilePath })
      .from(docVersions)
      .where(
        and(
          eq(docVersions.taskId, input.taskId),
          eq(docVersions.sourceNodeId, input.upstreamNodeId),
          eq(docVersions.sourcePortName, portName),
        ),
      )
      .orderBy(desc(docVersions.reviewIteration), desc(docVersions.createdAt))
      .limit(1)
    const path = rows[0]?.sourceFilePath?.trim()
    if (path !== undefined && path.length > 0) sections.push(`- ${portName}: ${path}`)
  }
  return sections.length === 0
    ? undefined
    : `${SIBLING_OUTPUTS_INSTRUCTION}\n\n${sections.join('\n')}`
}

async function buildPostgresqlReviewPromptContext(
  db: PostgresqlDatabaseClient,
  input: Parameters<CollaborationRuntimeMechanics['buildReviewPromptContext']>[0],
): Promise<ReviewPromptContext | undefined> {
  const rows = await db
    .select()
    .from(docVersions)
    .where(
      and(
        eq(docVersions.taskId, input.taskId),
        eq(docVersions.sourceNodeId, input.upstreamNodeId),
        ne(docVersions.decision, 'pending'),
        ne(docVersions.decidedBy, SYSTEM_DECIDER),
      ),
    )
    .orderBy(desc(docVersions.decidedAt))
    .limit(1)
  const version = rows[0]
  if (version === undefined) return undefined
  void input.iteration
  if (version.decision === 'rejected') {
    return { rejection: version.decisionReason ?? '' }
  }
  if (version.decision !== 'iterated') return undefined
  let context: ReviewPromptContext
  if (version.itemIndex !== null) {
    const round = await db
      .select({ decisionReason: docVersions.decisionReason })
      .from(docVersions)
      .where(
        and(
          eq(docVersions.taskId, input.taskId),
          eq(docVersions.sourceNodeId, input.upstreamNodeId),
          eq(docVersions.decision, 'iterated'),
          eq(docVersions.reviewIteration, version.reviewIteration),
          ne(docVersions.decidedBy, SYSTEM_DECIDER),
        ),
      )
      .orderBy(asc(docVersions.itemIndex))
    context = {
      comments: round
        .map((row) => (row.decisionReason ?? '').trim())
        .filter((value) => value.length > 0)
        .join('\n\n'),
      iterateTargetPort: version.sourcePortName,
    }
  } else {
    context = {
      comments: version.decisionReason ?? '',
      iterateTargetPort: version.sourcePortName,
    }
    const siblings = await buildPostgresqlSiblingOutputs({
      db,
      taskId: input.taskId,
      upstreamNodeId: input.upstreamNodeId,
      targetPortName: version.sourcePortName,
    })
    if (siblings !== undefined) context.siblingOutputs = siblings
  }
  const taskRows = await db
    .select({ workflowSnapshot: tasks.workflowSnapshot })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  const snapshot = taskRows[0]?.workflowSnapshot
  if (snapshot === undefined) return context
  try {
    const definition = migrateWorkflowDefinitionToLatest(
      WorkflowDefinitionSchema.parse(JSON.parse(snapshot)),
    )
    const reviewNode = definition.nodes.find((node) => node.id === version.reviewNodeId)
    const template = (reviewNode as Record<string, unknown> | undefined)?.commentInjectTemplate
    if (reviewNode?.kind === 'review' && typeof template === 'string' && template.trim() !== '') {
      context.commentInjectTemplate = template
    }
  } catch (error) {
    log.warn('review prompt snapshot is invalid; using default comments', {
      taskId: input.taskId,
      reviewNodeId: version.reviewNodeId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return context
}

async function findSelfGateRun(
  db: PostgresqlDatabaseClient,
  input: Extract<
    Parameters<CollaborationRuntimeMechanics['openAgentClarify']>[0],
    { readonly kind: 'self' }
  >,
): Promise<NodeRunRow | undefined> {
  const rounds = await db
    .select({ nodeRunId: clarifyRounds.intermediaryNodeRunId })
    .from(clarifyRounds)
    .where(
      and(
        eq(clarifyRounds.kind, 'self'),
        eq(clarifyRounds.taskId, input.taskId),
        eq(clarifyRounds.intermediaryNodeId, input.intermediaryNodeId),
        eq(clarifyRounds.iteration, input.iteration),
        input.askingShardKey === null
          ? isNull(clarifyRounds.askingShardKey)
          : eq(clarifyRounds.askingShardKey, input.askingShardKey),
      ),
    )
    .orderBy(asc(clarifyRounds.createdAt))
    .limit(1)
  const id = rounds[0]?.nodeRunId
  if (id === undefined) return undefined
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).limit(1)
  return runs[0]
}

async function openPostgresqlAgentClarify(
  db: PostgresqlDatabaseClient,
  dependencies: PostgresqlCollaborationRuntimeMechanicsDependencies,
  input: Parameters<CollaborationRuntimeMechanics['openAgentClarify']>[0],
): Promise<{ readonly intermediaryNodeRunId: string }> {
  const questions =
    input.kind === 'self'
      ? ClarifyEnvelopeBodySchema.parse({ questions: input.questions }).questions
      : input.questions.map((question) => ClarifyQuestionSchema.parse(question))
  const now = Date.now()
  const existing = input.kind === 'self' ? await findSelfGateRun(db, input) : undefined
  if (
    existing !== undefined &&
    !['pending', 'running', 'awaiting_human'].includes(existing.status)
  ) {
    throw new ValidationError(
      'clarify-node-run-not-parkable',
      `clarify node run ${existing.id} cannot reopen from '${existing.status}'`,
    )
  }
  const iteration =
    input.kind === 'self'
      ? input.iteration
      : ((
          await db
            .select({ iteration: clarifyRounds.iteration })
            .from(clarifyRounds)
            .where(
              and(
                eq(clarifyRounds.kind, 'cross'),
                eq(clarifyRounds.taskId, input.taskId),
                eq(clarifyRounds.intermediaryNodeId, input.intermediaryNodeId),
                eq(clarifyRounds.loopIter, input.loopIter),
              ),
            )
            .orderBy(desc(clarifyRounds.iteration))
            .limit(1)
        )[0]?.iteration ?? -1) + 1
  const taskRows = await db
    .select({ lifecycleRevision: tasks.lifecycleEventRevision })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  const task = taskRows[0]
  if (task === undefined) {
    throw new ValidationError('clarify-task-not-found', `task ${input.taskId} not found`)
  }
  const warningsJson =
    input.kind === 'self' &&
    input.truncationWarnings !== undefined &&
    input.truncationWarnings.length > 0
      ? JSON.stringify(input.truncationWarnings)
      : null
  const questionsJson = JSON.stringify(questions)
  const projection = {
    schemaVersion: 1,
    taskId: input.taskId,
    kind: input.kind,
    askingNodeId: input.askingNodeId,
    askingNodeRunId: input.askingNodeRunId,
    askingShardKey: input.kind === 'self' ? input.askingShardKey : null,
    intermediaryNodeId: input.intermediaryNodeId,
    targetConsumerNodeId: input.kind === 'cross' ? input.targetConsumerNodeId : null,
    parentNodeRunId: input.kind === 'self' ? (input.parentNodeRunId ?? null) : null,
    loopIter: input.kind === 'cross' ? input.loopIter : 0,
    iteration,
    questionsJson,
    truncationWarningsJson: warningsJson,
  } as const
  const context = createPostgresqlCollaborationCommandContext({ db })
  const prepared = await prepareClarifyGateOpen(context, {
    taskId: input.taskId,
    kind: input.kind,
    askingNodeId: input.askingNodeId,
    askingNodeRunId: input.askingNodeRunId,
    askingShardKey: projection.askingShardKey,
    intermediaryNodeId: input.intermediaryNodeId,
    targetConsumerNodeId: projection.targetConsumerNodeId,
    parentNodeRunId: projection.parentNodeRunId,
    loopIter: projection.loopIter,
    iteration,
    questionsJson,
    questions: questions.map((question) => ({ id: question.id, title: question.title })),
    truncationWarningsJson: warningsJson,
    sourceSnapshotDigest: sha256Hex(JSON.stringify(projection)),
    idempotencyKey: `clarify-open:v1:${input.taskId}:${input.askingNodeRunId}:${input.intermediaryNodeId}:${sha256Hex(JSON.stringify(projection))}`,
    expectedTaskRevision: task.lifecycleRevision,
    ...(existing === undefined
      ? {}
      : {
          reuseNodeRun: {
            id: existing.id,
            status: existing.status as 'pending' | 'running' | 'awaiting_human',
            iteration: existing.iteration,
            parentNodeRunId: existing.parentNodeRunId,
            shardKey: existing.shardKey,
            startedAt: existing.startedAt,
          },
        }),
    now,
  })
  if (prepared.kind === 'prepared') {
    await dependencies.taskRuntime.humanGates.parkPrepared({
      prepared: prepared.prepared,
      ...(input.executionContext === undefined ? {} : { token: input.executionContext.token }),
      now,
    })
  }
  const stored = await db
    .select({ id: clarifyRounds.id })
    .from(clarifyRounds)
    .where(eq(clarifyRounds.id, prepared.roundId))
    .limit(1)
  if (stored[0] === undefined) throw new Error('clarify-open-committed-round-projection-missing')
  return { intermediaryNodeRunId: prepared.nodeRunId }
}

async function inspectPostgresqlCrossClarify(
  db: PostgresqlDatabaseClient,
  directives: ReturnType<typeof createPostgresqlClarifyDirectiveStore>,
  dependencies: PostgresqlCollaborationRuntimeMechanicsDependencies,
  input: Parameters<CollaborationRuntimeMechanics['inspectCrossClarify']>[0],
) {
  const questionerNodeId = findQuestionerNodeForCrossClarify(
    input.definition,
    input.crossClarifyNodeId,
  )
  if (questionerNodeId === undefined) return { kind: 'no-questioner' as const }
  const directive = await directives.get({
    taskId: input.taskId,
    nodeId: questionerNodeId,
  })
  if (directive?.directive !== 'stop') return { kind: 'awaiting' as const }
  const now = Date.now()
  await withPostgresqlSerializableTaskExecution(db, async (tx) => {
    if (input.executionContext === undefined) {
      await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
    } else {
      if (input.executionContext.token.taskId !== input.taskId) {
        throw new ConflictError(
          'task-execution-context-mismatch',
          `execution context for '${input.executionContext.token.taskId}' cannot mutate task '${input.taskId}'`,
        )
      }
      await assertPostgresqlTaskOwnerTx(tx, input.executionContext.token, now)
    }
    await dependencies.nodeRunLifecycle.inTransaction(tx).set({
      nodeRunId: input.nodeRunId,
      to: 'done',
      allowedFrom: ['pending'],
      extra: { finishedAt: now },
      reason: 'cross-clarify-stop',
    })
  })
  return { kind: 'short-circuit-stop' as const }
}

function reviewInputSource(node: WorkflowDefinition['nodes'][number]) {
  const value = (node as Record<string, unknown>).inputSource
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  return typeof record.nodeId === 'string' && typeof record.portName === 'string'
    ? { nodeId: record.nodeId, portName: record.portName }
    : null
}

async function postgresqlUpstreamPortKind(
  db: PostgresqlDatabaseClient,
  definition: WorkflowDefinition,
  nodeId: string,
  portName: string,
): Promise<string | undefined> {
  const node = definition.nodes.find((candidate) => candidate.id === nodeId)
  if (node?.kind !== 'agent-single') return undefined
  const agentId = (node as { readonly agentId?: unknown }).agentId
  if (typeof agentId !== 'string' || agentId.length === 0) return undefined
  const rows = await db
    .select({ frontmatterExtra: agents.frontmatterExtra })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)
  try {
    const parsed = JSON.parse(rows[0]?.frontmatterExtra ?? '{}') as Record<string, unknown>
    const kinds = parsed.outputKinds
    const value =
      kinds !== null && typeof kinds === 'object'
        ? (kinds as Record<string, unknown>)[portName]
        : undefined
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

async function loadPostgresqlPriorRound(input: {
  readonly db: PostgresqlDatabaseClient
  readonly appHome: string
  readonly taskId: string
  readonly reviewNodeId: string
  readonly iteration: number
}): Promise<{ readonly members: readonly PriorRoundMember[]; readonly nextGeneration: number }> {
  const runRows = await input.db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, input.taskId),
        eq(nodeRuns.nodeId, input.reviewNodeId),
        eq(nodeRuns.iteration, input.iteration),
      ),
    )
  if (runRows.length === 0) return { members: [], nextGeneration: 1 }
  const versions = (
    await input.db
      .select()
      .from(docVersions)
      .where(
        and(
          eq(docVersions.reviewNodeId, input.reviewNodeId),
          inArray(
            docVersions.reviewNodeRunId,
            runRows.map((row) => row.id),
          ),
        ),
      )
  ).filter((row) => row.itemIndex !== null && row.roundGeneration !== null)
  if (versions.length === 0) return { members: [], nextGeneration: 1 }
  const maxGeneration = Math.max(...versions.map((row) => row.roundGeneration!))
  const byIndex = new Map<number, (typeof versions)[number]>()
  for (const row of versions) {
    if (row.roundGeneration !== maxGeneration || row.itemIndex === null) continue
    const current = byIndex.get(row.itemIndex)
    if (current === undefined || row.id > current.id) byIndex.set(row.itemIndex, row)
  }
  const reader = new PostgresqlCommittedReviewArtifactReader(input.db, input.appHome)
  const members: PriorRoundMember[] = []
  for (const row of byIndex.values()) {
    let body = ''
    try {
      body = await reader.read(row.bodyPath)
    } catch {
      body = ''
    }
    members.push({
      itemIndex: row.itemIndex!,
      itemPath: row.itemPath,
      selection: (row.selection ?? 'unselected') as PriorRoundMember['selection'],
      selectionStale: row.selectionStale ?? false,
      body,
    })
  }
  return { members, nextGeneration: maxGeneration + 1 }
}

async function autoApproveEmptyPostgresqlReview(input: {
  readonly db: PostgresqlDatabaseClient
  readonly nodeRunLifecycle: PostgresqlCollaborationNodeRunLifecycleParticipantFactory
  readonly taskStatus: string
  readonly expectedTaskRevision: number
  readonly taskId: string
  readonly nodeId: string
  readonly iteration: number
  readonly reviewIteration: number
  readonly sourceNodeId: string
  readonly sourcePortName: string
  readonly consumedUpstreamRunsJson: string
  readonly acceptedKind: string
  readonly reuse?: NodeRunRow
  readonly refresh: boolean
  readonly pendingDocumentIds: readonly string[]
  readonly executionContext?: CollaborationReviewDispatchInput['executionContext']
}): Promise<void> {
  const now = Date.now()
  const meta = JSON.stringify({
    decision: 'approved',
    decidedAt: now,
    reviewIteration: input.reviewIteration,
    sourceNodeId: input.sourceNodeId,
    sourcePortName: input.sourcePortName,
    itemCount: 0,
    acceptedCount: 0,
    acceptedItemIndices: [],
    auto: 'empty-list',
  })
  const eventRefs = await withPostgresqlSerializableTaskExecution(input.db, async (tx) => {
    const nodeRunLifecycle = input.nodeRunLifecycle.inTransaction(tx)
    if (input.executionContext === undefined) {
      await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
    } else {
      if (input.executionContext.token.taskId !== input.taskId) {
        throw new ConflictError(
          'task-execution-context-mismatch',
          `execution context for '${input.executionContext.token.taskId}' cannot mutate task '${input.taskId}'`,
        )
      }
      await assertPostgresqlTaskOwnerTx(tx, input.executionContext.token, now)
    }

    const currentTasks = await tx
      .select({ status: tasks.status, lifecycleRevision: tasks.lifecycleEventRevision })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
    const currentTask = currentTasks[0]
    if (
      currentTask === undefined ||
      currentTask.status !== input.taskStatus ||
      currentTask.lifecycleRevision !== input.expectedTaskRevision
    ) {
      throw new ConflictError(
        'review-refresh-stale',
        `task ${input.taskId} changed before empty-source review approval`,
      )
    }

    let nodeRunId: string
    if (input.refresh && input.reuse !== undefined) {
      const currentRuns = await tx
        .select({
          status: nodeRuns.status,
          consumedUpstreamRunsJson: nodeRuns.consumedUpstreamRunsJson,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, input.reuse.id))
        .limit(1)
      const currentPendingIds = (
        await tx
          .select({ id: docVersions.id })
          .from(docVersions)
          .where(
            and(
              eq(docVersions.reviewNodeRunId, input.reuse.id),
              eq(docVersions.sourcePortName, input.sourcePortName),
              eq(docVersions.decision, 'pending'),
            ),
          )
      )
        .map((document) => document.id)
        .sort()
      const expectedPendingIds = [...input.pendingDocumentIds].sort()
      if (
        currentRuns[0]?.status !== 'awaiting_review' ||
        currentRuns[0].consumedUpstreamRunsJson !== input.reuse.consumedUpstreamRunsJson ||
        currentPendingIds.length !== expectedPendingIds.length ||
        currentPendingIds.some((documentId, index) => documentId !== expectedPendingIds[index])
      ) {
        throw new ConflictError(
          'review-refresh-stale',
          `review ${input.reuse.id} changed before empty-source refresh`,
        )
      }
      if (currentPendingIds.length > 0) {
        await tx
          .delete(reviewComments)
          .where(inArray(reviewComments.docVersionId, currentPendingIds))
        await tx
          .update(docVersions)
          .set({
            decision: 'superseded',
            decisionReason: 'upstream-refreshed',
            decidedBy: SYSTEM_DECIDER,
            decidedAt: now,
          })
          .where(inArray(docVersions.id, currentPendingIds))
      }
      await tx
        .update(nodeRuns)
        .set({ consumedUpstreamRunsJson: input.consumedUpstreamRunsJson })
        .where(eq(nodeRuns.id, input.reuse.id))
      nodeRunId = input.reuse.id
    } else if (input.reuse?.status === 'pending') {
      try {
        await nodeRunLifecycle.set({
          nodeRunId: input.reuse.id,
          to: 'awaiting_review',
          allowedFrom: ['pending'],
          extra: {
            startedAt: input.reuse.startedAt ?? now,
            consumedUpstreamRunsJson: input.consumedUpstreamRunsJson,
          },
          reason: 'review-empty-auto-approve',
        })
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
        throw new ConflictError(
          'review-refresh-stale',
          `review ${input.reuse.id} changed before empty-source approval`,
        )
      }
      nodeRunId = input.reuse.id
    } else {
      nodeRunId = await createPostgresqlNodeRunMintParticipantInTx(tx).mint({
        taskId: input.taskId,
        nodeId: input.nodeId,
        status: 'awaiting_review',
        cause: 'review-park',
        iteration: input.iteration,
        overrides: {
          reviewIteration: input.reviewIteration,
          consumedUpstreamRunsJson: input.consumedUpstreamRunsJson,
        },
        ...(input.executionContext === undefined
          ? {}
          : { executionContext: input.executionContext }),
      })
    }

    await tx
      .insert(nodeRunOutputs)
      .values({
        nodeRunId,
        portName: REVIEW_APPROVED_PORT_MULTI,
        content: '',
        kind: input.acceptedKind,
        archiveJson: null,
      })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: '', kind: input.acceptedKind, archiveJson: null },
      })
    await tx
      .insert(nodeRunOutputs)
      .values({ nodeRunId, portName: REVIEW_APPROVAL_META_PORT, content: meta })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: meta },
      })
    try {
      await nodeRunLifecycle.set({
        nodeRunId,
        to: 'done',
        allowedFrom: ['awaiting_review'],
        extra: { finishedAt: now },
        reason: 'review-empty-auto-approve',
      })
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error
      throw new ConflictError(
        'review-refresh-stale',
        `review ${nodeRunId} changed before empty-source approval`,
      )
    }
    await tx.insert(nodeRunEvents).values({
      nodeRunId,
      ts: now,
      kind: 'text',
      payload: `[rfc202/review-auto-approved] ${JSON.stringify({
        rfc: 'RFC-202',
        reason: 'empty-list',
        itemCount: 0,
        sourceNodeId: input.sourceNodeId,
        sourcePortName: input.sourcePortName,
      })}`,
    })
    const nodeChanges = [
      {
        nodeRunId,
        nodeId: input.nodeId,
        status: 'done' as const,
        cause: 'review-empty-auto-approve',
      },
    ]
    if (input.taskStatus !== 'awaiting_review') {
      const eventRef = await appendPostgresqlTaskNodeStatusesTx(tx, {
        taskId: input.taskId,
        nodeChanges,
        occurredAt: now,
        identity: {
          operationRef: `review-empty-auto-approve:${input.taskId}:${nodeRunId}`,
        },
      })
      return eventRef === null ? [] : [eventRef]
    }
    return (
      await transitionPostgresqlHumanGateTaskTx(tx, {
        taskId: input.taskId,
        expectedTaskRevision: input.expectedTaskRevision,
        transition: 'release-review',
        now,
        nodeChanges,
        committedEventIdentity: {
          operationRef: `review-empty-auto-approve:${input.taskId}:${nodeRunId}`,
        },
      })
    ).eventRefs
  })
  await publishCommittedEventsAfterCommit(eventRefs)
}

async function dispatchPostgresqlReviewNode(
  db: PostgresqlDatabaseClient,
  dependencies: PostgresqlCollaborationRuntimeMechanicsDependencies,
  input: Parameters<CollaborationRuntimeMechanics['dispatchReviewNode']>[0],
): Promise<Awaited<ReturnType<CollaborationRuntimeMechanics['dispatchReviewNode']>>> {
  const taskRows = await db
    .select({
      status: tasks.status,
      lifecycleRevision: tasks.lifecycleEventRevision,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  const task = taskRows[0]
  if (task === undefined) {
    return {
      kind: 'failed',
      summary: `review node ${input.node.id}: task '${input.taskId}' no longer exists`,
      message: 'task-not-found',
    }
  }
  if (task.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: `review node ${input.node.id}: task '${input.taskId}' was canceled before dispatch`,
      message: 'task-canceled',
    }
  }
  if (task.status !== 'running' && task.status !== 'awaiting_review') {
    return {
      kind: 'failed',
      summary: `review node ${input.node.id}: task '${input.taskId}' is not dispatchable (${task.status})`,
      message: 'review-task-not-dispatchable',
    }
  }
  const configured = reviewInputSource(input.node)
  if (configured === null) {
    return {
      kind: 'failed',
      summary: `review node ${input.node.id} missing inputSource`,
      message: 'review-input-source-missing',
    }
  }
  const source = resolveWorkflowSourceRef(
    input.definition,
    configured,
    input.node.id,
    buildWorkflowScopeParentMap(input.definition),
  )
  if (!source.ok) {
    return {
      kind: 'failed',
      summary: `review node ${input.node.id}: source '${configured.nodeId}.${configured.portName}' is not exposed by wrapper '${source.wrapperId}'`,
      message: 'wrapper-output-boundary-missing',
    }
  }
  const sourceNodeId = source.source.nodeId
  const sourcePortName = source.source.portName
  const sourceRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, input.taskId), eq(nodeRuns.nodeId, sourceNodeId)))
  const sourceRun = pickVisibleUpstreamRun(sourceRuns, input.iteration)
  if (sourceRun === undefined || sourceRun.status !== 'done') {
    return {
      kind: 'failed',
      summary: `review node ${input.node.id}: upstream '${sourceNodeId}' has no completed run yet`,
      message: 'review-upstream-not-done',
    }
  }
  const outputRows = await db
    .select()
    .from(nodeRunOutputs)
    .where(
      and(eq(nodeRunOutputs.nodeRunId, sourceRun.id), eq(nodeRunOutputs.portName, sourcePortName)),
    )
    .limit(1)
  const output = outputRows[0]
  if (output === undefined) {
    return {
      kind: 'failed',
      summary: `review node ${input.node.id}: upstream '${sourceNodeId}' did not emit port '${sourcePortName}'`,
      message: 'review-source-port-missing',
    }
  }
  const upstreamKind =
    output.kind ??
    (await postgresqlUpstreamPortKind(db, input.definition, sourceNodeId, sourcePortName)) ??
    (await postgresqlUpstreamPortKind(db, input.definition, configured.nodeId, configured.portName))
  const multi = isMultiDocReviewInput(upstreamKind ?? '')
  const inline = multi && isInlineMarkdownListReviewInput(upstreamKind ?? '')
  const artifact = readPortArtifact({
    appHome: input.appHome,
    taskId: input.taskId,
    archiveJson: output.archiveJson,
    content: output.content,
    kind: upstreamKind ?? null,
    fallbackWorktreeRoot: input.scopeRoot,
    legacyRepoDirName: input.repoDirName ?? '',
  })
  const inlineBodies = multi && inline ? splitMarkdownDocs(output.content) : []
  const itemPaths = multi && !inline ? splitListItems(output.content) : []
  let singleBody = ''
  let sourceFilePath: string | undefined
  if (!multi) {
    const item = artifact.items[0]
    if (item === undefined || item.source === 'missing') {
      return {
        kind: 'failed',
        summary: `review node ${input.node.id}: source content unavailable (archive missing and '${item?.path ?? output.content}' not readable under scope root)`,
        message: 'review-source-resolve-failed',
      }
    }
    singleBody = item.body
    if (isPathishKindString(upstreamKind ?? null)) sourceFilePath = output.content.trim()
  }
  const reviewRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, input.taskId),
        eq(nodeRuns.nodeId, input.node.id),
        eq(nodeRuns.iteration, input.iteration),
      ),
    )
  const reuse = pickFreshestRun(reviewRuns, { topLevelOnly: true })
  const latestDone = pickFreshestRun(reviewRuns, {
    topLevelOnly: true,
    statusIn: ['done'],
  })
  const coversSource = (run: NodeRunRow) =>
    parseConsumedJson(run.consumedUpstreamRunsJson)[sourceNodeId] === undefined ||
    parseConsumedJson(run.consumedUpstreamRunsJson)[sourceNodeId] === sourceRun.id
  if (latestDone !== undefined && coversSource(latestDone)) {
    return { kind: 'ok', summary: '', message: '' }
  }
  const existingVersions =
    reuse?.status === 'pending' || reuse?.status === 'awaiting_review'
      ? await db
          .select()
          .from(docVersions)
          .where(
            and(
              eq(docVersions.reviewNodeRunId, reuse.id),
              eq(docVersions.sourcePortName, sourcePortName),
            ),
          )
      : []
  const pending = existingVersions.filter((version) => version.decision === 'pending')
  const refresh = reuse?.status === 'awaiting_review' && !coversSource(reuse)
  if (reuse?.status === 'awaiting_review' && !refresh && pending.length > 0) {
    return {
      kind: 'awaiting_review',
      summary: multi
        ? `review node ${input.node.id} awaiting decision (${pending.length} document${pending.length === 1 ? '' : 's'})`
        : `review node ${input.node.id} awaiting decision`,
      message: 'awaiting_review',
    }
  }
  const nextVersion = (itemIndex: number | null) =>
    Math.max(
      0,
      ...existingVersions
        .filter((version) => version.itemIndex === itemIndex)
        .map((version) => version.versionIndex),
    ) + 1
  const reviewIteration = reuse?.reviewIteration ?? 0
  const documents = [] as Array<{
    body: string
    sourceNodeId: string
    sourcePortName: string
    versionIndex: number
    reviewIteration: number
    sourceFilePath?: string
    itemIndex?: number
    selection?: 'unselected' | 'accepted' | 'not_accepted'
    itemPath?: string
    selectionStale?: boolean
    roundGeneration?: number
  }>
  if (multi) {
    const prior = await loadPostgresqlPriorRound({
      db,
      appHome: input.appHome,
      taskId: input.taskId,
      reviewNodeId: input.node.id,
      iteration: input.iteration,
    })
    const lookup = buildPriorSelectionLookup(prior.members)
    const itemCount = inline ? inlineBodies.length : itemPaths.length
    for (let index = 0; index < itemCount; index += 1) {
      const itemPath = inline ? undefined : itemPaths[index]!
      const body = inline
        ? inlineBodies[index]!
        : artifact.items[index] !== undefined && artifact.items[index]!.source !== 'missing'
          ? artifact.items[index]!.body
          : `> ⚠️ RFC-079: file not found in worktree: \`${itemPath}\``
      const inherited = inheritSelection(
        { itemIndex: index, itemPath: itemPath ?? null, body },
        lookup,
      )
      documents.push({
        body,
        sourceNodeId,
        sourcePortName,
        versionIndex: nextVersion(index),
        reviewIteration,
        ...(itemPath === undefined ? {} : { sourceFilePath: itemPath, itemPath }),
        itemIndex: index,
        selection: inherited.selection,
        selectionStale: inherited.stale,
        roundGeneration: prior.nextGeneration,
      })
    }
  } else {
    documents.push({
      body: singleBody,
      sourceNodeId,
      sourcePortName,
      versionIndex: nextVersion(null),
      reviewIteration,
      ...(sourceFilePath === undefined ? {} : { sourceFilePath }),
    })
  }
  const consumed = JSON.stringify({ [sourceNodeId]: sourceRun.id })
  if (documents.length === 0) {
    await autoApproveEmptyPostgresqlReview({
      db,
      nodeRunLifecycle: dependencies.nodeRunLifecycle,
      taskStatus: task.status,
      expectedTaskRevision: task.lifecycleRevision,
      taskId: input.taskId,
      nodeId: input.node.id,
      iteration: input.iteration,
      reviewIteration,
      sourceNodeId,
      sourcePortName,
      consumedUpstreamRunsJson: consumed,
      acceptedKind: inline ? 'list<markdown>' : 'list<path<md>>',
      ...(reuse === undefined ? {} : { reuse }),
      refresh,
      pendingDocumentIds: pending.map((document) => document.id),
      ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    })
    return {
      kind: 'ok',
      summary: `review node ${input.node.id} auto-approved (0 documents, empty list)`,
      message: 'review-auto-approved',
    }
  }
  const sourceSnapshotDigest = sha256Hex(
    JSON.stringify({
      sourceRunId: sourceRun.id,
      sourceNodeId,
      sourcePortName,
      upstreamKind: upstreamKind ?? null,
      documents: documents.map((document) => ({
        bodySha256: sha256Hex(document.body),
        itemIndex: document.itemIndex ?? null,
        itemPath: document.itemPath ?? null,
        selection: document.selection ?? null,
        selectionStale: document.selectionStale ?? null,
        roundGeneration: document.roundGeneration ?? null,
      })),
    }),
  )
  const context = createPostgresqlCollaborationCommandContext({ db, appHome: input.appHome })
  const prepared = await prepareReviewGateOpen(context, {
    taskId: input.taskId,
    reviewNodeId: input.node.id,
    iteration: input.iteration,
    reviewIteration,
    consumedUpstreamRunsJson: consumed,
    sourceSnapshotDigest,
    idempotencyKey: `review-open:v1:${input.taskId}:${input.node.id}:${String(input.iteration)}:${String(task.lifecycleRevision)}:${sourceSnapshotDigest}`,
    expectedTaskRevision: task.lifecycleRevision,
    ...(reuse?.status === 'pending' ? { reusePendingNodeRunId: reuse.id } : {}),
    ...(refresh && reuse !== undefined
      ? {
          reuseAwaitingNodeRun: {
            id: reuse.id,
            consumedUpstreamRunsJson: reuse.consumedUpstreamRunsJson!,
          },
          supersedePendingDocumentIds: pending.map((document) => document.id),
        }
      : {}),
    documents,
  })
  if (prepared.kind === 'prepared') {
    await dependencies.taskRuntime.humanGates.parkPrepared({
      prepared: prepared.prepared,
      ...(input.executionContext === undefined ? {} : { token: input.executionContext.token }),
      now: Date.now(),
    })
  }
  try {
    await finalizeCommittedHumanGate(context, { operationId: prepared.operationId })
  } catch (error) {
    log.warn('review-open artifact finalization deferred to recovery', {
      taskId: input.taskId,
      operationId: prepared.operationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    kind: 'awaiting_review',
    summary: multi
      ? `review node ${input.node.id} awaiting decision (${documents.length} document${documents.length === 1 ? '' : 's'})`
      : `review node ${input.node.id} awaiting decision`,
    message: 'awaiting_review',
  }
}

export function createPostgresqlCollaborationRuntimeMechanics(
  db: PostgresqlDatabaseClient,
  dependencies: PostgresqlCollaborationRuntimeMechanicsDependencies,
): CollaborationRuntimeMechanics {
  const directives = createPostgresqlClarifyDirectiveStore(db)
  return Object.freeze({
    dispatchReviewNode: (input) => dispatchPostgresqlReviewNode(db, dependencies, input),
    inspectCrossClarify: (input) =>
      inspectPostgresqlCrossClarify(db, directives, dependencies, input),
    openAgentClarify: (input) => openPostgresqlAgentClarify(db, dependencies, input),
    resolveBorrowForNode: (input) => resolvePostgresqlBorrowForNode(db, input),
    buildReviewPromptContext: (input) => buildPostgresqlReviewPromptContext(db, input),
    async getNodeClarifyDirective(input): Promise<ClarifyDirective | undefined> {
      return (await directives.get(input))?.directive
    },
    buildClarifyQueueContext: (input) => buildPostgresqlClarifyQueueContext(db, input),
    isTaskClarifySuppressed: (input) => isPostgresqlTaskClarifySuppressed(db, directives, input),
    dismissOpenClarifyParksForAutonomous: (input) =>
      dismissPostgresqlClarifyParks(db, dependencies, input),
  } satisfies CollaborationRuntimeMechanics)
}
