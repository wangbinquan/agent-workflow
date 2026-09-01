import {
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  WG_FC_CLAIM_BATCH_LIMIT,
  WG_LEADER_IDLE_NUDGE_LIMIT,
  WG_PORT_ASSIGNMENTS,
  WG_PORT_DECISION,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASK_RESULTS,
  WG_PORT_TASKS_ADD,
  buildBatchShardKey,
  buildMsgShardKey,
  normalizeWgTaskTitle,
  parseBatchShardKey,
  parseMsgShardKey,
  parseWgAssignmentsPort,
  parseWgDecisionPort,
  parseWgMessagesPort,
  parseWgResultPort,
  parseWgTaskResultsPort,
  parseWgTasksAddPort,
  resolveCompletionGate,
  resolveWorkgroupOutputContract,
  resolveWorkgroupSwitches,
  type Agent,
  type DwState,
  type WorkgroupAssignment,
  type WorkgroupAssignmentSource,
  type WorkgroupAssignmentStatus,
  type WorkgroupMessage,
  type WorkgroupMessageAuthorKind,
  type WorkgroupMessageKind,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import {
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  type WorkgroupHostLedgerMintOperation,
  type WorkgroupHostLedgerMintReceipt,
  type WorkgroupHostLedgerRun,
  type WorkgroupHostLedgerStampOperation,
  type WorkgroupTurnHostOperations,
  type WorkgroupTurnHostResult,
  type WorkgroupTurnLogger,
  type WorkgroupTurnsOperations,
} from '@/modules/task-execution/public/commands'

type WorkgroupTurnsDriveOutcome = Awaited<ReturnType<WorkgroupTurnsOperations['drive']>>

// Domain operation keys are wire identifiers, not host PATH lists. Naming the
// separator keeps the Windows platform guard from treating this join as a
// platform path-list operation while preserving the persisted bytes exactly.
const WORKGROUP_OPERATION_KEY_SEPARATOR = ':'

export {
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
} from '@/modules/task-execution/public/commands'

export const WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS: Readonly<
  Record<WorkgroupAssignmentStatus, readonly WorkgroupAssignmentStatus[]>
> = {
  open: ['dispatched', 'canceled'],
  dispatched: ['running', 'delivered', 'failed', 'canceled'],
  running: ['done', 'failed', 'awaiting_human', 'canceled', 'dispatched'],
  awaiting_human: ['running', 'failed', 'canceled', 'dispatched', 'open'],
  delivered: ['done', 'canceled'],
  done: [],
  failed: ['open'],
  canceled: [],
}

export type WorkgroupTurnGateStatus =
  | 'idle'
  | 'declared'
  | 'awaiting_confirmation'
  | 'approved'
  | 'rejected'

export const WORKGROUP_TURN_GATE_TRANSITIONS: Readonly<
  Record<WorkgroupTurnGateStatus, readonly WorkgroupTurnGateStatus[]>
> = {
  idle: ['declared'],
  declared: ['awaiting_confirmation'],
  awaiting_confirmation: ['approved', 'rejected'],
  approved: [],
  rejected: ['declared', 'idle'],
}

export interface WorkgroupTurnTaskState {
  readonly gateStatus: WorkgroupTurnGateStatus
  readonly gateSummary: string | null
  readonly gateRejectedComment: string | null
  readonly pauseReason: string | null
  readonly dynamicWorkflowState: DwState | null
  readonly resultMessageId: string | null
}

export interface WorkgroupTurnAssignment extends WorkgroupAssignment {
  readonly attemptCount: number
}

export interface WorkgroupTurnMemberAgent {
  readonly memberId: string
  readonly agent: Agent
  readonly capabilityCard: string
  readonly readonly: boolean
}

export type WorkgroupTurnHostRun = WorkgroupHostLedgerRun

export interface WorkgroupTurnsSnapshot {
  readonly taskId: string
  readonly config: WorkgroupRuntimeConfig
  readonly state: WorkgroupTurnTaskState
  readonly assignments: readonly WorkgroupTurnAssignment[]
  readonly messages: readonly WorkgroupMessage[]
  readonly cursors: ReadonlyMap<string, string>
  readonly memberAgents: readonly WorkgroupTurnMemberAgent[]
  readonly hostRuns: readonly WorkgroupTurnHostRun[]
  readonly leaderClarifyParked: boolean
}

export interface WorkgroupTurnMessageDraft {
  readonly id: string
  readonly round: number
  readonly authorKind: WorkgroupMessageAuthorKind
  readonly authorMemberId: string | null
  readonly authorUserId: string | null
  readonly kind: WorkgroupMessageKind
  readonly bodyMd: string
  readonly templateKey: string | null
  readonly templateParams: Readonly<Record<string, unknown>> | null
  readonly mentionMemberIds: readonly string[]
  readonly assignmentId: string | null
  readonly triggerMessageId: string | null
  readonly createdAt: number
}

export interface WorkgroupTurnAssignmentDraft {
  readonly id: string
  readonly round: number
  readonly source: WorkgroupAssignmentSource
  readonly createdByRunId: string | null
  readonly createdByUserId: string | null
  readonly assigneeMemberId: string | null
  readonly title: string
  readonly briefMd: string
  readonly status: WorkgroupAssignmentStatus
  readonly nodeRunId: string | null
  readonly resultMessageId: string | null
  readonly dedupKey: string | null
  readonly attemptCount: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface WorkgroupTurnLedgerOperationBase {
  readonly operationKey: string
}

export interface WorkgroupTurnEnsureStateOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'ensure-task-state'
  readonly dynamicWorkflowState?: DwState | null
}

export interface WorkgroupTurnSeedGoalOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'seed-goal-if-empty'
  readonly message: WorkgroupTurnMessageDraft
}

export type WorkgroupTurnMintHostRunOperation = WorkgroupHostLedgerMintOperation

export type WorkgroupTurnStampHostRunOperation = WorkgroupHostLedgerStampOperation

export interface WorkgroupTurnTransitionAssignmentOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'transition-assignment'
  readonly assignmentId: string
  readonly from: WorkgroupAssignmentStatus
  readonly to: WorkgroupAssignmentStatus
  readonly set?: Readonly<{
    readonly assigneeMemberId?: string | null
    readonly nodeRunId?: string | null
    readonly resultMessageId?: string | null
  }>
  readonly bumpAttempt?: boolean
}

export interface WorkgroupTurnRepointAssignmentOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'repoint-assignment-run'
  readonly assignmentId: string
  readonly nodeRunId: string
}

export interface WorkgroupTurnCreateAssignmentOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'create-assignment'
  readonly assignment: WorkgroupTurnAssignmentDraft
}

export interface WorkgroupTurnCreateMessageOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'create-message'
  readonly message: WorkgroupTurnMessageDraft
}

export interface WorkgroupTurnAdvanceCursorOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'advance-member-cursor'
  readonly memberId: string
  readonly messageId: string
}

export interface WorkgroupTurnGateOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'transition-gate'
  readonly from: readonly WorkgroupTurnGateStatus[]
  readonly to: WorkgroupTurnGateStatus
  readonly summary?: string
  readonly rejectedComment?: string
}

export interface WorkgroupTurnPauseOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'set-pause-reason'
  readonly reason: string | null
}

export interface WorkgroupTurnDynamicWorkflowOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'set-dynamic-workflow-state'
  readonly state: DwState
}

export interface WorkgroupTurnResultAnchorOperation extends WorkgroupTurnLedgerOperationBase {
  readonly kind: 'stamp-result-anchor'
  readonly messageId: string
}

export type WorkgroupTurnLedgerOperation =
  | WorkgroupTurnEnsureStateOperation
  | WorkgroupTurnSeedGoalOperation
  | WorkgroupTurnMintHostRunOperation
  | WorkgroupTurnStampHostRunOperation
  | WorkgroupTurnTransitionAssignmentOperation
  | WorkgroupTurnRepointAssignmentOperation
  | WorkgroupTurnCreateAssignmentOperation
  | WorkgroupTurnCreateMessageOperation
  | WorkgroupTurnAdvanceCursorOperation
  | WorkgroupTurnGateOperation
  | WorkgroupTurnPauseOperation
  | WorkgroupTurnDynamicWorkflowOperation
  | WorkgroupTurnResultAnchorOperation

export interface WorkgroupTurnsLedgerCommit {
  readonly taskId: string
  readonly operations: readonly WorkgroupTurnLedgerOperation[]
}

export type WorkgroupTurnMintedRun = WorkgroupHostLedgerMintReceipt

export type WorkgroupTurnsLedgerCommitReceipt =
  | Readonly<{ committed: true; mintedRuns: readonly WorkgroupTurnMintedRun[] }>
  | Readonly<{ committed: false; conflictOperationKey: string }>

export interface WorkgroupTurnsPersistencePort {
  load(taskId: string): Promise<WorkgroupTurnsSnapshot | null>
  commit(input: WorkgroupTurnsLedgerCommit): Promise<WorkgroupTurnsLedgerCommitReceipt>
}

interface ParsedTurn<T> {
  readonly ok: true
  readonly value: T
}

interface RejectedTurn {
  readonly ok: false
  readonly errors: readonly string[]
}

type TurnParse<T> = ParsedTurn<T> | RejectedTurn

type HostTurnOutcome<T> =
  | Readonly<{ kind: 'done'; value: T; runId: string }>
  | Readonly<{ kind: 'awaiting'; runId: string }>
  | Readonly<{ kind: 'canceled'; runId: string }>
  | Readonly<{ kind: 'failed'; runId: string; message: string }>
  | Readonly<{ kind: 'protocol-exhausted'; runId: string; errors: readonly string[] }>
  | Readonly<{ kind: 'lost' }>

interface HostTurnSpec<T> {
  readonly taskId: string
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly nodeId: string
  readonly agent: Agent
  readonly role: 'leader' | 'worker' | 'fc-member'
  readonly shardKey: string | null
  readonly wgRound: number | null
  readonly primaryCause: 'wg-leader-round' | 'wg-assignment' | 'wg-message-turn'
  readonly prompt: (envelopeNonce: string, errorNotice: string | null) => string
  readonly parse: (outputs: Readonly<Record<string, string>>) => TurnParse<T>
  readonly firstStartOperations: (runId: string) => readonly WorkgroupTurnLedgerOperation[]
  readonly retryStartOperations: (runId: string) => readonly WorkgroupTurnLedgerOperation[]
  readonly adoptedRun?: WorkgroupTurnHostRun
  readonly maxProtocolRetries?: number
  readonly registerMint?: (runId: string) => void
}

function maxMessageId(messages: readonly WorkgroupMessage[]): string {
  let max = ''
  for (const message of messages) if (message.id > max) max = message.id
  return max
}

function memberAgent(
  snapshot: WorkgroupTurnsSnapshot,
  memberId: string,
): WorkgroupTurnMemberAgent | null {
  return snapshot.memberAgents.find((projection) => projection.memberId === memberId) ?? null
}

function memberName(config: WorkgroupRuntimeConfig, memberId: string): string {
  return config.members.find((member) => member.id === memberId)?.displayName ?? memberId
}

function rosterNames(config: WorkgroupRuntimeConfig): ReadonlySet<string> {
  return new Set(config.members.map((member) => member.displayName))
}

function gateDeclared(state: WorkgroupTurnTaskState): boolean {
  return (
    state.gateStatus === 'declared' ||
    state.gateStatus === 'awaiting_confirmation' ||
    state.gateStatus === 'approved'
  )
}

function roundBudget(snapshot: WorkgroupTurnsSnapshot): number {
  if (snapshot.config.mode === 'leader_worker') {
    let stamped = 0
    let unstamped = 0
    for (const run of snapshot.hostRuns) {
      if (run.nodeId !== WORKGROUP_TURN_LEADER_NODE_ID || run.status === 'canceled') continue
      if (run.wgRound !== null) stamped = Math.max(stamped, run.wgRound)
      else if (run.rerunCause !== 'wg-gate' && run.rerunCause !== 'wg-protocol-retry') unstamped++
    }
    return stamped + unstamped
  }
  return snapshot.hostRuns.filter(
    (run) =>
      run.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID &&
      run.status !== 'canceled' &&
      run.status !== 'interrupted' &&
      run.rerunCause !== 'wg-protocol-retry',
  ).length
}

function messageRound(snapshot: WorkgroupTurnsSnapshot): number {
  return snapshot.config.mode === 'leader_worker' ? roundBudget(snapshot) : 0
}

function messageDraft(input: {
  readonly round: number
  readonly authorKind: WorkgroupMessageAuthorKind
  readonly authorMemberId?: string | null
  readonly kind: WorkgroupMessageKind
  readonly bodyMd: string
  readonly templateKey?: string
  readonly templateParams?: Readonly<Record<string, unknown>>
  readonly mentionMemberIds?: readonly string[]
  readonly assignmentId?: string | null
  readonly triggerMessageId?: string | null
}): WorkgroupTurnMessageDraft {
  return Object.freeze({
    id: ulid(),
    round: input.round,
    authorKind: input.authorKind,
    authorMemberId: input.authorMemberId ?? null,
    authorUserId: null,
    kind: input.kind,
    bodyMd: input.bodyMd,
    templateKey: input.templateKey ?? null,
    templateParams: input.templateParams ?? null,
    mentionMemberIds: Object.freeze([...(input.mentionMemberIds ?? [])]),
    assignmentId: input.assignmentId ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    createdAt: Date.now(),
  })
}

function createMessage(
  key: string,
  message: WorkgroupTurnMessageDraft,
): WorkgroupTurnCreateMessageOperation {
  return { kind: 'create-message', operationKey: key, message }
}

function assignmentDraft(input: {
  readonly round: number
  readonly source: WorkgroupAssignmentSource
  readonly createdByRunId?: string | null
  readonly assigneeMemberId?: string | null
  readonly title: string
  readonly briefMd: string
  readonly status: WorkgroupAssignmentStatus
  readonly dedupKey?: string | null
}): WorkgroupTurnAssignmentDraft {
  const now = Date.now()
  return Object.freeze({
    id: ulid(),
    round: input.round,
    source: input.source,
    createdByRunId: input.createdByRunId ?? null,
    createdByUserId: null,
    assigneeMemberId: input.assigneeMemberId ?? null,
    title: input.title,
    briefMd: input.briefMd,
    status: input.status,
    nodeRunId: null,
    resultMessageId: null,
    dedupKey: input.dedupKey ?? null,
    attemptCount: 0,
    createdAt: now,
    updatedAt: now,
  })
}

function protocolPorts(role: HostTurnSpec<unknown>['role']): readonly string[] {
  if (role === 'leader') return [WG_PORT_ASSIGNMENTS, WG_PORT_MESSAGES, WG_PORT_DECISION]
  if (role === 'fc-member') {
    return [WG_PORT_TASK_RESULTS, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]
  }
  return [WG_PORT_RESULT, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]
}

function protocolBlock(role: HostTurnSpec<unknown>['role'], envelopeNonce: string): string {
  return [
    '## Workgroup output protocol',
    `This is the ${role} turn.`,
    `Emit only declared workgroup JSON ports in <workflow-output nonce="${envelopeNonce}">.`,
    `Allowed ports: ${protocolPorts(role).join(', ')}.`,
  ].join('\n')
}

function visibleMessages(
  snapshot: WorkgroupTurnsSnapshot,
  memberId: string,
): readonly WorkgroupMessage[] {
  const cursor = snapshot.cursors.get(memberId) ?? ''
  const switches = resolveWorkgroupSwitches(snapshot.config.mode, snapshot.config.switches)
  return snapshot.messages.filter((message) => {
    if (message.id <= cursor || message.authorMemberId === memberId) return false
    if (snapshot.config.leaderMemberId === memberId) return true
    if (message.mentionMemberIds.includes(memberId)) return switches.directMessages
    if (message.kind === 'result' || message.kind === 'delivery') return switches.shareOutputs
    return switches.blackboard
  })
}

function composePrompt(
  snapshot: WorkgroupTurnsSnapshot,
  memberId: string,
  assignments: readonly WorkgroupAssignment[],
  addendum?: string,
): string {
  const projection = memberAgent(snapshot, memberId)
  const roster = snapshot.config.members
    .map((member) => {
      const card = snapshot.memberAgents.find(
        (entry) => entry.memberId === member.id,
      )?.capabilityCard
      return `- @${member.displayName}: ${member.roleDesc}${card ? `\n  ${card}` : ''}`
    })
    .join('\n')
  const room = visibleMessages(snapshot, memberId)
    .map((message) => `- ${message.authorMemberId ?? message.authorKind}: ${message.bodyMd}`)
    .join('\n')
  const cards = assignments
    .map((assignment, index) => `### Task ${index + 1}: ${assignment.title}\n${assignment.briefMd}`)
    .join('\n\n')
  return [
    `# ${snapshot.config.workgroupName}`,
    snapshot.config.instructions,
    `## Goal\n${snapshot.config.goal}`,
    `## Your identity\n@${memberName(snapshot.config, memberId)} (${projection?.agent.name ?? 'missing agent'})`,
    `## Roster\n${roster}`,
    room.length > 0 ? `## New room activity\n${room}` : '## New room activity\n(none)',
    cards.length > 0 ? `## Assigned work\n${cards}` : '',
    addendum ?? '',
  ]
    .filter((section) => section.length > 0)
    .join('\n\n')
}

async function commit(
  persistence: WorkgroupTurnsPersistencePort,
  taskId: string,
  operations: readonly WorkgroupTurnLedgerOperation[],
): Promise<WorkgroupTurnsLedgerCommitReceipt> {
  return await persistence.commit({ taskId, operations })
}

function mintedRun(
  receipt: WorkgroupTurnsLedgerCommitReceipt,
  operationKey: string,
): WorkgroupTurnMintedRun | null {
  if (!receipt.committed) return null
  return receipt.mintedRuns.find((run) => run.operationKey === operationKey) ?? null
}

async function executeHostTurn<T>(
  persistence: WorkgroupTurnsPersistencePort,
  spec: HostTurnSpec<T>,
): Promise<HostTurnOutcome<T>> {
  let adopted = spec.adoptedRun
  let errorNotice: string | null = null
  let lastRunId = adopted?.id ?? ''
  const retryBase = adopted?.retryIndex ?? 0
  const maxProtocolRetries = spec.maxProtocolRetries ?? DEFAULT_PROTOCOL_RETRY_BUDGET
  for (let attempt = 0; attempt <= maxProtocolRetries; attempt++) {
    let run: WorkgroupTurnMintedRun
    if (adopted !== undefined && attempt === 0) {
      const prepared = await commit(persistence, spec.taskId, spec.firstStartOperations(adopted.id))
      if (!prepared.committed) return { kind: 'lost' }
      run = {
        operationKey: 'adopted-run',
        runId: adopted.id,
        envelopeNonce: adopted.envelopeNonce,
      }
    } else {
      const runId = ulid()
      const operationKey = `mint-host-run:${runId}`
      const started = await commit(persistence, spec.taskId, [
        {
          kind: 'mint-host-run',
          operationKey,
          runId,
          nodeId: spec.nodeId,
          status: 'pending',
          cause: attempt === 0 ? spec.primaryCause : 'wg-protocol-retry',
          retryIndex: retryBase + attempt,
          shardKey: spec.shardKey,
          agentOverrideName: spec.agent.name,
          agentOverrideId: spec.agent.id,
          wgRound: spec.wgRound,
        },
        ...(attempt === 0 ? spec.firstStartOperations(runId) : spec.retryStartOperations(runId)),
      ])
      const minted = mintedRun(started, operationKey)
      if (minted === null) return { kind: 'lost' }
      run = minted
      spec.registerMint?.(run.runId)
      spec.host.broadcastNodeStatus?.(run.runId, spec.nodeId, 'pending')
    }
    adopted = undefined
    lastRunId = run.runId
    const result: WorkgroupTurnHostResult = await spec.host.runHost({
      nodeRunId: run.runId,
      nodeId: spec.nodeId,
      agent: spec.agent,
      promptTemplate: spec.prompt(run.envelopeNonce, errorNotice),
      workgroupProtocolBlock: protocolBlock(spec.role, run.envelopeNonce),
      clarifyEnabled:
        spec.snapshot.config.members.some((member) => member.memberType === 'human') &&
        (spec.snapshot.config.clarifyBudget ?? 3) > 0,
      hostOutputPorts: protocolPorts(spec.role),
    })
    if (result.status === 'canceled') return { kind: 'canceled', runId: run.runId }
    if (result.status === 'awaiting') return { kind: 'awaiting', runId: run.runId }
    if (result.status === 'failed') {
      if (result.processUnreaped === true || attempt === maxProtocolRetries) {
        return {
          kind: 'failed',
          runId: run.runId,
          message: result.errorMessage ?? 'workgroup host run failed',
        }
      }
      errorNotice = result.errorMessage ?? result.failureCode ?? 'workgroup host run failed'
      continue
    }
    const parsed = spec.parse(result.outputs)
    if (parsed.ok) return { kind: 'done', value: parsed.value, runId: run.runId }
    if (attempt === maxProtocolRetries) {
      return { kind: 'protocol-exhausted', runId: run.runId, errors: parsed.errors }
    }
    errorNotice = parsed.errors.map((error) => `- ${error}`).join('\n')
  }
  return { kind: 'failed', runId: lastRunId, message: 'workgroup turn retry budget exhausted' }
}

type DriveStep =
  | Readonly<{ kind: 'progress' }>
  | Readonly<{ kind: 'lost' }>
  | Readonly<{ kind: 'terminal'; outcome: WorkgroupTurnsDriveOutcome }>

function transitionAssignment(input: {
  readonly key: string
  readonly assignmentId: string
  readonly from: WorkgroupAssignmentStatus
  readonly to: WorkgroupAssignmentStatus
  readonly set?: WorkgroupTurnTransitionAssignmentOperation['set']
  readonly bumpAttempt?: boolean
}): WorkgroupTurnTransitionAssignmentOperation {
  return {
    kind: 'transition-assignment',
    operationKey: input.key,
    assignmentId: input.assignmentId,
    from: input.from,
    to: input.to,
    ...(input.set === undefined ? {} : { set: input.set }),
    ...(input.bumpAttempt === true ? { bumpAttempt: true } : {}),
  }
}

function cursorOperation(
  key: string,
  memberId: string,
  messageId: string,
): WorkgroupTurnAdvanceCursorOperation {
  return {
    kind: 'advance-member-cursor',
    operationKey: key,
    memberId,
    messageId,
  }
}

function memberOutputMessageOperations(input: {
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly memberId: string
  readonly round: number
  readonly messages: readonly { readonly to: string | null; readonly body: string }[]
  readonly triggerMessageId: string | null
  readonly allowDirect: boolean
  readonly allowBlackboard: boolean
  readonly keyPrefix: string
}): readonly WorkgroupTurnCreateMessageOperation[] {
  const operations: WorkgroupTurnCreateMessageOperation[] = []
  let index = 0
  for (const output of input.messages) {
    if (output.to === null) {
      if (!input.allowBlackboard) continue
      operations.push(
        createMessage(
          `${input.keyPrefix}:message:${index++}`,
          messageDraft({
            round: input.round,
            authorKind: 'member',
            authorMemberId: input.memberId,
            kind: 'chat',
            bodyMd: output.body,
            triggerMessageId: input.triggerMessageId,
          }),
        ),
      )
      continue
    }
    if (!input.allowDirect) continue
    const target = input.snapshot.config.members.find((member) => member.displayName === output.to)
    if (target === undefined) continue
    operations.push(
      createMessage(
        `${input.keyPrefix}:message:${index++}`,
        messageDraft({
          round: input.round,
          authorKind: 'member',
          authorMemberId: input.memberId,
          kind: 'chat',
          bodyMd: `@${output.to} ${output.body}`,
          mentionMemberIds: [target.id],
          triggerMessageId: input.triggerMessageId,
        }),
      ),
    )
  }
  return operations
}

function tasksAddOperations(input: {
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly memberId: string
  readonly raw: string | undefined
  readonly round: number
  readonly keyPrefix: string
}): readonly WorkgroupTurnLedgerOperation[] {
  if (input.raw === undefined || input.snapshot.config.mode !== 'free_collab') return []
  const parsed = parseWgTasksAddPort(input.raw)
  if (!parsed.ok) {
    return [
      createMessage(
        `${input.keyPrefix}:tasks-add-rejected`,
        messageDraft({
          round: input.round,
          authorKind: 'system',
          kind: 'system',
          bodyMd: `wg_tasks_add from @${memberName(input.snapshot.config, input.memberId)} rejected: ${parsed.errors.join('; ')}`,
          templateKey: 'tasksAddRejected',
          templateParams: {
            member: memberName(input.snapshot.config, input.memberId),
            detail: parsed.errors.join('; '),
          },
        }),
      ),
    ]
  }
  const occupied = new Set(
    input.snapshot.assignments
      .filter((assignment) => assignment.status !== 'canceled' && assignment.dedupKey !== null)
      .map((assignment) => assignment.dedupKey)
      .filter((key): key is string => key !== null),
  )
  const operations: WorkgroupTurnLedgerOperation[] = []
  let index = 0
  for (const item of parsed.value) {
    const dedupKey = normalizeWgTaskTitle(item.title)
    if (occupied.has(dedupKey)) continue
    occupied.add(dedupKey)
    const assignment = assignmentDraft({
      round: input.round,
      source: 'self_claim',
      title: item.title,
      briefMd: item.brief,
      status: 'open',
      dedupKey,
    })
    operations.push({
      kind: 'create-assignment',
      operationKey: `${input.keyPrefix}:task:${index}`,
      assignment,
    })
    operations.push(
      createMessage(
        `${input.keyPrefix}:task-message:${index}`,
        messageDraft({
          round: input.round,
          authorKind: 'member',
          authorMemberId: input.memberId,
          kind: 'dispatch',
          bodyMd: `+ task: ${item.title}`,
          assignmentId: assignment.id,
        }),
      ),
    )
    index++
  }
  return operations
}

interface AssignmentTurnValue {
  readonly summary: string
  readonly messages: readonly { readonly to: string | null; readonly body: string }[]
  readonly tasksAddRaw: string | undefined
}

function assignmentStartOperations(
  assignment: WorkgroupTurnAssignment,
  runId: string,
): readonly WorkgroupTurnLedgerOperation[] {
  if (assignment.status === 'dispatched' || assignment.status === 'awaiting_human') {
    return [
      transitionAssignment({
        key: `assignment-start:${assignment.id}:${runId}`,
        assignmentId: assignment.id,
        from: assignment.status,
        to: 'running',
        set: { nodeRunId: runId },
      }),
    ]
  }
  if (assignment.status === 'running' && assignment.nodeRunId !== runId) {
    return [
      {
        kind: 'repoint-assignment-run',
        operationKey: `assignment-repoint:${assignment.id}:${runId}`,
        assignmentId: assignment.id,
        nodeRunId: runId,
      },
    ]
  }
  return []
}

function assignmentFailureOperations(input: {
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly assignment: WorkgroupTurnAssignment
  readonly from: WorkgroupAssignmentStatus
  readonly detail: string
  readonly keyPrefix: string
  readonly effectiveAttemptCount?: number
  readonly protocolViolation?: boolean
}): readonly WorkgroupTurnLedgerOperation[] {
  const operations: WorkgroupTurnLedgerOperation[] = [
    transitionAssignment({
      key: `${input.keyPrefix}:failed`,
      assignmentId: input.assignment.id,
      from: input.from,
      to: 'failed',
    }),
    createMessage(
      `${input.keyPrefix}:message`,
      messageDraft({
        round: input.assignment.round,
        authorKind: 'system',
        kind: 'system',
        bodyMd:
          input.protocolViolation === true
            ? `assignment '${input.assignment.title}' violated the output protocol: ${input.detail}`
            : `assignment '${input.assignment.title}' failed: ${input.detail}`,
        templateKey:
          input.protocolViolation === true ? 'assignmentProtocolViolation' : 'assignmentFailed',
        templateParams: { title: input.assignment.title, detail: input.detail },
        assignmentId: input.assignment.id,
      }),
    ),
  ]
  const attempts = input.effectiveAttemptCount ?? input.assignment.attemptCount
  if (
    input.protocolViolation !== true &&
    input.snapshot.config.mode === 'free_collab' &&
    attempts < DEFAULT_PROTOCOL_RETRY_BUDGET
  ) {
    operations.push(
      transitionAssignment({
        key: `${input.keyPrefix}:reopen`,
        assignmentId: input.assignment.id,
        from: 'failed',
        to: 'open',
        set: { assigneeMemberId: null, nodeRunId: null },
      }),
    )
  }
  return operations
}

async function driveAssignmentTurn(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly assignment: WorkgroupTurnAssignment
  readonly adoptedRun?: WorkgroupTurnHostRun
  readonly registerMint?: (runId: string) => void
}): Promise<DriveStep> {
  const memberId = input.assignment.assigneeMemberId
  if (memberId === null) return { kind: 'lost' }
  const projection = memberAgent(input.snapshot, memberId)
  if (projection === null) {
    const receipt = await commit(
      input.persistence,
      input.snapshot.taskId,
      assignmentFailureOperations({
        snapshot: input.snapshot,
        assignment: input.assignment,
        from: input.assignment.status,
        detail: `agent for @${memberName(input.snapshot.config, memberId)} is not resolvable`,
        keyPrefix: `assignment-agent-missing:${input.assignment.id}`,
      }),
    )
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  const wgRound = input.snapshot.config.mode === 'leader_worker' ? input.assignment.round : null
  const outcome = await executeHostTurn<AssignmentTurnValue>(input.persistence, {
    taskId: input.snapshot.taskId,
    snapshot: input.snapshot,
    host: input.host,
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    agent: projection.agent,
    role: input.snapshot.config.mode === 'free_collab' ? 'fc-member' : 'worker',
    shardKey: input.assignment.id,
    wgRound,
    primaryCause: 'wg-assignment',
    adoptedRun: input.adoptedRun,
    registerMint: input.registerMint,
    firstStartOperations: (runId) => assignmentStartOperations(input.assignment, runId),
    retryStartOperations: (runId) => [
      {
        kind: 'repoint-assignment-run',
        operationKey: `assignment-retry-repoint:${input.assignment.id}:${runId}`,
        assignmentId: input.assignment.id,
        nodeRunId: runId,
      },
    ],
    prompt: (_nonce, errorNotice) =>
      composePrompt(input.snapshot, memberId, [input.assignment]) +
      (errorNotice === null ? '' : `\n\n## Protocol correction\n${errorNotice}`),
    parse: (outputs) => {
      const errors: string[] = []
      const resultRaw = outputs[WG_PORT_RESULT]
      const result = resultRaw === undefined ? null : parseWgResultPort(resultRaw)
      if (result === null) errors.push('missing required port wg_result')
      else if (!result.ok) errors.push(...result.errors.map((error) => `wg_result: ${error}`))
      const messagesRaw = outputs[WG_PORT_MESSAGES]
      const messages: ReturnType<typeof parseWgMessagesPort> =
        messagesRaw === undefined
          ? { ok: true, value: [] }
          : parseWgMessagesPort(messagesRaw, rosterNames(input.snapshot.config))
      if (!messages.ok) errors.push(...messages.errors.map((error) => `wg_messages: ${error}`))
      if (errors.length > 0 || result === null || !result.ok || !messages.ok) {
        return { ok: false, errors }
      }
      return {
        ok: true,
        value: {
          summary: result.value.summary,
          messages: messages.value,
          tasksAddRaw: outputs[WG_PORT_TASKS_ADD],
        },
      }
    },
  })
  if (outcome.kind === 'lost') return { kind: 'lost' }
  if (outcome.kind === 'canceled') {
    const receipt = await commit(input.persistence, input.snapshot.taskId, [
      transitionAssignment({
        key: `assignment-canceled:${input.assignment.id}:${outcome.runId}`,
        assignmentId: input.assignment.id,
        from: 'running',
        to: 'canceled',
      }),
    ])
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  if (outcome.kind === 'awaiting') {
    const receipt = await commit(input.persistence, input.snapshot.taskId, [
      transitionAssignment({
        key: `assignment-awaiting:${input.assignment.id}:${outcome.runId}`,
        assignmentId: input.assignment.id,
        from: 'running',
        to: 'awaiting_human',
      }),
    ])
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  if (outcome.kind === 'failed' || outcome.kind === 'protocol-exhausted') {
    const detail = outcome.kind === 'failed' ? outcome.message : outcome.errors.join('; ')
    const receipt = await commit(
      input.persistence,
      input.snapshot.taskId,
      assignmentFailureOperations({
        snapshot: input.snapshot,
        assignment: input.assignment,
        from: 'running',
        detail,
        keyPrefix: `assignment-host-failed:${input.assignment.id}:${outcome.runId}`,
        ...(outcome.kind === 'protocol-exhausted' ? { protocolViolation: true } : {}),
      }),
    )
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  const switches = resolveWorkgroupSwitches(
    input.snapshot.config.mode,
    input.snapshot.config.switches,
  )
  const resultMessage = messageDraft({
    round: input.assignment.round,
    authorKind: 'member',
    authorMemberId: memberId,
    kind: 'result',
    bodyMd: outcome.value.summary,
    assignmentId: input.assignment.id,
  })
  const operations: WorkgroupTurnLedgerOperation[] = [
    ...memberOutputMessageOperations({
      snapshot: input.snapshot,
      memberId,
      round: input.assignment.round,
      messages: outcome.value.messages,
      triggerMessageId: null,
      allowDirect: switches.directMessages,
      allowBlackboard: switches.blackboard,
      keyPrefix: `assignment-output:${outcome.runId}`,
    }),
    ...tasksAddOperations({
      snapshot: input.snapshot,
      memberId,
      raw: outcome.value.tasksAddRaw,
      round: input.assignment.round,
      keyPrefix: `assignment-tasks-add:${outcome.runId}`,
    }),
    createMessage(`assignment-result:${outcome.runId}`, resultMessage),
    transitionAssignment({
      key: `assignment-done:${input.assignment.id}:${outcome.runId}`,
      assignmentId: input.assignment.id,
      from: 'running',
      to: 'done',
      set: { resultMessageId: resultMessage.id },
    }),
  ]
  if (input.snapshot.config.mode === 'leader_worker') {
    operations.push(
      cursorOperation(
        `assignment-cursor:${outcome.runId}`,
        memberId,
        maxMessageId(input.snapshot.messages),
      ),
    )
  }
  const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
  return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
}

interface BatchReportedItem {
  readonly task: number
  readonly status: 'done' | 'failed'
  readonly summary: string
  readonly detail?: string
}

interface BatchTurnValue {
  readonly reported: readonly BatchReportedItem[]
  readonly messages: readonly { readonly to: string | null; readonly body: string }[]
  readonly tasksAddRaw: string | undefined
}

function batchStartOperations(
  cards: readonly WorkgroupTurnAssignment[],
  memberId: string,
  runId: string,
): readonly WorkgroupTurnLedgerOperation[] {
  const operations: WorkgroupTurnLedgerOperation[] = []
  for (const card of cards) {
    if (card.status === 'open') {
      operations.push(
        transitionAssignment({
          key: `batch-claim:${card.id}:${runId}`,
          assignmentId: card.id,
          from: 'open',
          to: 'dispatched',
          set: { assigneeMemberId: memberId },
          bumpAttempt: true,
        }),
        transitionAssignment({
          key: `batch-start:${card.id}:${runId}`,
          assignmentId: card.id,
          from: 'dispatched',
          to: 'running',
          set: { nodeRunId: runId },
        }),
      )
    } else if (card.status === 'dispatched' || card.status === 'awaiting_human') {
      operations.push(
        transitionAssignment({
          key: `batch-start:${card.id}:${runId}`,
          assignmentId: card.id,
          from: card.status,
          to: 'running',
          set: { nodeRunId: runId },
        }),
      )
    } else if (card.status === 'running' && card.nodeRunId !== runId) {
      operations.push({
        kind: 'repoint-assignment-run',
        operationKey: `batch-repoint:${card.id}:${runId}`,
        assignmentId: card.id,
        nodeRunId: runId,
      })
    }
  }
  return operations
}

function batchSettleOperations(input: {
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly cards: readonly WorkgroupTurnAssignment[]
  readonly reported: readonly BatchReportedItem[]
  readonly keyPrefix: string
}): readonly WorkgroupTurnLedgerOperation[] {
  const operations: WorkgroupTurnLedgerOperation[] = []
  for (const item of input.reported) {
    const card = input.cards[item.task - 1]
    if (card === undefined) continue
    if (item.status === 'done') {
      const result = messageDraft({
        round: card.round,
        authorKind: 'member',
        authorMemberId: card.assigneeMemberId,
        kind: 'result',
        bodyMd: item.summary,
        assignmentId: card.id,
      })
      operations.push(
        createMessage(`${input.keyPrefix}:result:${card.id}`, result),
        transitionAssignment({
          key: `${input.keyPrefix}:done:${card.id}`,
          assignmentId: card.id,
          from: 'running',
          to: 'done',
          set: { resultMessageId: result.id },
        }),
      )
    } else {
      operations.push(
        ...assignmentFailureOperations({
          snapshot: input.snapshot,
          assignment: card,
          from: 'running',
          detail: item.detail ?? item.summary,
          keyPrefix: `${input.keyPrefix}:reported-failed:${card.id}`,
          effectiveAttemptCount: card.attemptCount + (card.status === 'open' ? 1 : 0),
        }),
      )
    }
  }
  return operations
}

async function driveBatchTurn(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly memberId: string
  readonly candidateIds: readonly string[]
  readonly adoptedRun?: WorkgroupTurnHostRun
  readonly registerMint?: (runId: string) => void
}): Promise<DriveStep> {
  const cards = input.candidateIds.flatMap((id) => {
    const card = input.snapshot.assignments.find((candidate) => candidate.id === id)
    if (card === undefined) return []
    if (card.status === 'open') return [card]
    if (card.assigneeMemberId !== input.memberId) return []
    if (card.status === 'dispatched' || card.status === 'running') return [card]
    if (card.status === 'awaiting_human' && input.adoptedRun !== undefined) return [card]
    return []
  })
  if (cards.length === 0) return { kind: 'progress' }
  const projection = memberAgent(input.snapshot, input.memberId)
  if (projection === null) {
    const operations: WorkgroupTurnLedgerOperation[] = [
      createMessage(
        `batch-agent-missing:${input.memberId}:${cards
          .map((card) => card.id)
          .join(WORKGROUP_OPERATION_KEY_SEPARATOR)}`,
        messageDraft({
          round: messageRound(input.snapshot),
          authorKind: 'system',
          kind: 'system',
          bodyMd: `batch agent @${memberName(input.snapshot.config, input.memberId)} is not resolvable`,
          templateKey: 'batchAgentUnresolvable',
          templateParams: { member: memberName(input.snapshot.config, input.memberId) },
        }),
      ),
    ]
    for (const card of cards) {
      let from = card.status
      let attempts = card.attemptCount
      if (card.status === 'open') {
        operations.push(
          transitionAssignment({
            key: `batch-agent-missing-claim:${card.id}`,
            assignmentId: card.id,
            from: 'open',
            to: 'dispatched',
            set: { assigneeMemberId: input.memberId },
            bumpAttempt: true,
          }),
        )
        from = 'dispatched'
        attempts++
      }
      operations.push(
        ...assignmentFailureOperations({
          snapshot: input.snapshot,
          assignment: card,
          from,
          detail: `agent for @${memberName(input.snapshot.config, input.memberId)} is not resolvable`,
          keyPrefix: `batch-agent-missing-card:${card.id}`,
          effectiveAttemptCount: attempts,
        }),
      )
    }
    const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  const shardKey = buildBatchShardKey(
    input.memberId,
    cards.map((card) => card.id),
  )
  let lastReported: readonly BatchReportedItem[] = []
  let lastMissing = cards.map((_card, index) => index + 1)
  const outcome = await executeHostTurn<BatchTurnValue>(input.persistence, {
    taskId: input.snapshot.taskId,
    snapshot: input.snapshot,
    host: input.host,
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    agent: projection.agent,
    role: 'fc-member',
    shardKey,
    wgRound: null,
    primaryCause: 'wg-assignment',
    adoptedRun: input.adoptedRun,
    registerMint: input.registerMint,
    firstStartOperations: (runId) => batchStartOperations(cards, input.memberId, runId),
    retryStartOperations: (runId) =>
      cards.map((card) => ({
        kind: 'repoint-assignment-run',
        operationKey: `batch-retry-repoint:${card.id}:${runId}`,
        assignmentId: card.id,
        nodeRunId: runId,
      })),
    prompt: (_nonce, errorNotice) =>
      composePrompt(input.snapshot, input.memberId, cards) +
      (errorNotice === null ? '' : `\n\n## Protocol correction\n${errorNotice}`),
    parse: (outputs) => {
      const errors: string[] = []
      const resultsRaw = outputs[WG_PORT_TASK_RESULTS]
      const results =
        resultsRaw === undefined ? null : parseWgTaskResultsPort(resultsRaw, cards.length)
      if (results === null) {
        errors.push(`missing required port ${WG_PORT_TASK_RESULTS}`)
        lastReported = []
        lastMissing = cards.map((_card, index) => index + 1)
      } else if (!results.ok) {
        errors.push(...results.errors.map((error) => `${WG_PORT_TASK_RESULTS}: ${error}`))
        lastReported = []
        lastMissing = cards.map((_card, index) => index + 1)
      } else {
        lastReported = results.value
        lastMissing = results.missing
        if (results.missing.length > 0) {
          errors.push(
            `${WG_PORT_TASK_RESULTS}: missing ${results.missing.map((index) => `Task ${index}`).join(', ')}`,
          )
        }
      }
      const messagesRaw = outputs[WG_PORT_MESSAGES]
      const messages: ReturnType<typeof parseWgMessagesPort> =
        messagesRaw === undefined
          ? { ok: true, value: [] }
          : parseWgMessagesPort(messagesRaw, rosterNames(input.snapshot.config))
      if (!messages.ok) errors.push(...messages.errors.map((error) => `wg_messages: ${error}`))
      if (errors.length > 0 || results === null || !results.ok || !messages.ok) {
        return { ok: false, errors }
      }
      return {
        ok: true,
        value: {
          reported: results.value,
          messages: messages.value,
          tasksAddRaw: outputs[WG_PORT_TASKS_ADD],
        },
      }
    },
  })
  if (outcome.kind === 'lost') return { kind: 'lost' }
  if (outcome.kind === 'canceled' || outcome.kind === 'awaiting') {
    const to = outcome.kind === 'canceled' ? 'canceled' : 'awaiting_human'
    const receipt = await commit(
      input.persistence,
      input.snapshot.taskId,
      cards.map((card) =>
        transitionAssignment({
          key: `batch-${to}:${card.id}:${outcome.runId}`,
          assignmentId: card.id,
          from: 'running',
          to,
        }),
      ),
    )
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  if (outcome.kind === 'failed') {
    const operations: WorkgroupTurnLedgerOperation[] = [
      createMessage(
        `batch-failed:${outcome.runId}`,
        messageDraft({
          round: messageRound(input.snapshot),
          authorKind: 'system',
          kind: 'system',
          bodyMd: `batch run for @${memberName(input.snapshot.config, input.memberId)} failed: ${outcome.message}`,
          templateKey: 'batchFailed',
          templateParams: {
            count: cards.length,
            member: memberName(input.snapshot.config, input.memberId),
            detail: outcome.message,
          },
        }),
      ),
    ]
    for (const card of cards) {
      operations.push(
        ...assignmentFailureOperations({
          snapshot: input.snapshot,
          assignment: card,
          from: 'running',
          detail: outcome.message,
          keyPrefix: `batch-failed-card:${outcome.runId}:${card.id}`,
          effectiveAttemptCount: card.attemptCount + (card.status === 'open' ? 1 : 0),
        }),
      )
    }
    const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  const switches = resolveWorkgroupSwitches(
    input.snapshot.config.mode,
    input.snapshot.config.switches,
  )
  const operations: WorkgroupTurnLedgerOperation[] = []
  if (outcome.kind === 'protocol-exhausted') {
    operations.push(
      ...batchSettleOperations({
        snapshot: input.snapshot,
        cards,
        reported: lastReported,
        keyPrefix: `batch-partial:${outcome.runId}`,
      }),
      createMessage(
        `batch-protocol:${outcome.runId}`,
        messageDraft({
          round: messageRound(input.snapshot),
          authorKind: 'system',
          kind: 'system',
          bodyMd: `batch output protocol failed for @${memberName(input.snapshot.config, input.memberId)}: ${outcome.errors.join('; ')}`,
          templateKey: 'batchProtocolViolation',
          templateParams: {
            member: memberName(input.snapshot.config, input.memberId),
            detail: outcome.errors.join('; '),
          },
        }),
      ),
    )
    for (const index of lastMissing) {
      const card = cards[index - 1]
      if (card === undefined) continue
      operations.push(
        ...assignmentFailureOperations({
          snapshot: input.snapshot,
          assignment: card,
          from: 'running',
          detail: 'missing batch result',
          keyPrefix: `batch-missing:${outcome.runId}:${card.id}`,
          effectiveAttemptCount: card.attemptCount + (card.status === 'open' ? 1 : 0),
        }),
      )
    }
  } else {
    operations.push(
      ...memberOutputMessageOperations({
        snapshot: input.snapshot,
        memberId: input.memberId,
        round: cards[0]?.round ?? 0,
        messages: outcome.value.messages,
        triggerMessageId: null,
        allowDirect: switches.directMessages,
        allowBlackboard: switches.blackboard,
        keyPrefix: `batch-output:${outcome.runId}`,
      }),
      ...tasksAddOperations({
        snapshot: input.snapshot,
        memberId: input.memberId,
        raw: outcome.value.tasksAddRaw,
        round: cards[0]?.round ?? 0,
        keyPrefix: `batch-tasks-add:${outcome.runId}`,
      }),
      ...batchSettleOperations({
        snapshot: input.snapshot,
        cards,
        reported: outcome.value.reported,
        keyPrefix: `batch-settle:${outcome.runId}`,
      }),
    )
  }
  const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
  return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
}

interface MessageTurnValue {
  readonly messages: ReturnType<typeof parseWgMessagesPort>
  readonly resultRaw: string | undefined
  readonly tasksAddRaw: string | undefined
}

function messageTurnBoundary(
  snapshot: WorkgroupTurnsSnapshot,
  memberId: string,
  adoptedRun: WorkgroupTurnHostRun | undefined,
): { readonly maxId: string; readonly triggerId: string | null } {
  const parsed =
    adoptedRun?.shardKey === null || adoptedRun?.shardKey === undefined
      ? null
      : parseMsgShardKey(adoptedRun.shardKey)
  const maxId =
    parsed !== null && parsed.memberId === memberId
      ? parsed.maxMessageId
      : maxMessageId(snapshot.messages)
  let triggerId: string | null = null
  for (const message of snapshot.messages) {
    if (message.id > maxId || message.authorMemberId === memberId) continue
    if (message.mentionMemberIds.includes(memberId)) triggerId = message.id
  }
  return { maxId, triggerId }
}

async function driveMessageTurn(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly memberId: string
  readonly initial: boolean
  readonly adoptedRun?: WorkgroupTurnHostRun
  readonly registerMint?: (runId: string) => void
}): Promise<DriveStep> {
  const projection = memberAgent(input.snapshot, input.memberId)
  const boundary = messageTurnBoundary(input.snapshot, input.memberId, input.adoptedRun)
  if (projection === null) {
    const receipt = await commit(input.persistence, input.snapshot.taskId, [
      createMessage(
        `message-agent-missing:${input.memberId}:${boundary.maxId}`,
        messageDraft({
          round: messageRound(input.snapshot),
          authorKind: 'system',
          kind: 'system',
          bodyMd: `message turn skipped because @${memberName(input.snapshot.config, input.memberId)} has no resolvable agent`,
          templateKey: 'messageTurnFailed',
          templateParams: {
            member: memberName(input.snapshot.config, input.memberId),
            detail: 'agent unresolvable',
          },
        }),
      ),
      cursorOperation(
        `message-agent-missing-cursor:${input.memberId}:${boundary.maxId}`,
        input.memberId,
        boundary.maxId,
      ),
    ])
    return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
  }
  const round = messageRound(input.snapshot)
  const stamp: readonly WorkgroupTurnLedgerOperation[] =
    input.adoptedRun !== undefined &&
    input.adoptedRun.wgRound === null &&
    input.snapshot.config.mode === 'leader_worker'
      ? [
          {
            kind: 'stamp-host-run-round',
            operationKey: `stamp-message-round:${input.adoptedRun.id}`,
            runId: input.adoptedRun.id,
            wgRound: round,
          },
        ]
      : []
  const outcome = await executeHostTurn<MessageTurnValue>(input.persistence, {
    taskId: input.snapshot.taskId,
    snapshot: input.snapshot,
    host: input.host,
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    agent: projection.agent,
    role: input.snapshot.config.mode === 'free_collab' ? 'fc-member' : 'worker',
    shardKey: buildMsgShardKey(input.memberId, boundary.maxId || '0'),
    wgRound: input.snapshot.config.mode === 'leader_worker' ? round : null,
    primaryCause: 'wg-message-turn',
    adoptedRun: input.adoptedRun,
    registerMint: input.registerMint,
    maxProtocolRetries: 0,
    firstStartOperations: () => stamp,
    retryStartOperations: () => [],
    prompt: () =>
      composePrompt(
        input.snapshot,
        input.memberId,
        [],
        input.initial
          ? '## Initial planning turn\nBreak the group goal into concrete tasks with wg_tasks_add; check the blackboard first to avoid duplicates.'
          : undefined,
      ),
    parse: (outputs) => {
      const raw = outputs[WG_PORT_MESSAGES]
      const messages: ReturnType<typeof parseWgMessagesPort> =
        raw === undefined
          ? { ok: true, value: [] }
          : parseWgMessagesPort(raw, rosterNames(input.snapshot.config))
      return {
        ok: true,
        value: {
          messages,
          resultRaw: outputs[WG_PORT_RESULT],
          tasksAddRaw: outputs[WG_PORT_TASKS_ADD],
        },
      }
    },
  })
  if (outcome.kind === 'lost') return { kind: 'lost' }
  const operations: WorkgroupTurnLedgerOperation[] = [
    cursorOperation(
      `message-cursor:${input.memberId}:${boundary.maxId}:${outcome.runId}`,
      input.memberId,
      boundary.maxId,
    ),
  ]
  if (outcome.kind === 'failed' || outcome.kind === 'protocol-exhausted') {
    const detail = outcome.kind === 'failed' ? outcome.message : outcome.errors.join('; ')
    operations.push(
      createMessage(
        `message-failed:${outcome.runId}`,
        messageDraft({
          round,
          authorKind: 'system',
          kind: 'system',
          bodyMd: `message turn for @${memberName(input.snapshot.config, input.memberId)} failed: ${detail}`,
          templateKey: 'messageTurnFailed',
          templateParams: {
            member: memberName(input.snapshot.config, input.memberId),
            detail,
          },
        }),
      ),
    )
  } else if (outcome.kind === 'done') {
    const switches = resolveWorkgroupSwitches(
      input.snapshot.config.mode,
      input.snapshot.config.switches,
    )
    if (outcome.value.messages.ok) {
      operations.push(
        ...memberOutputMessageOperations({
          snapshot: input.snapshot,
          memberId: input.memberId,
          round,
          messages: outcome.value.messages.value,
          triggerMessageId: boundary.triggerId,
          allowDirect: switches.directMessages,
          allowBlackboard: switches.blackboard,
          keyPrefix: `message-output:${outcome.runId}`,
        }),
      )
    }
    if (outcome.value.resultRaw !== undefined) {
      const result = parseWgResultPort(outcome.value.resultRaw)
      if (result.ok) {
        operations.push(
          createMessage(
            `message-result:${outcome.runId}`,
            messageDraft({
              round,
              authorKind: 'member',
              authorMemberId: input.memberId,
              kind: 'chat',
              bodyMd: result.value.summary,
              triggerMessageId: boundary.triggerId,
            }),
          ),
        )
      }
    }
    operations.push(
      ...tasksAddOperations({
        snapshot: input.snapshot,
        memberId: input.memberId,
        raw: outcome.value.tasksAddRaw,
        round,
        keyPrefix: `message-tasks-add:${outcome.runId}`,
      }),
    )
  }
  const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
  return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
}

type WakeItem =
  | Readonly<{
      kind: 'leader'
      reason: 'initial' | 'new-content' | 'gate-rejected' | 'wrap-up'
    }>
  | Readonly<{ kind: 'assignment'; assignmentId: string }>
  | Readonly<{ kind: 'message-turn'; memberId: string }>
  | Readonly<{ kind: 'fc-initial'; memberId: string }>
  | Readonly<{ kind: 'fc-claim'; memberId: string; assignmentIds: readonly string[] }>

interface InflightTurns {
  leaderRunning: boolean
  readonly runningAssignmentIds: Set<string>
  readonly messageTurnMemberIds: Set<string>
  readonly initialPlanningMemberIds: Set<string>
  readonly taskTurnMemberIds: Set<string>
}

interface WakeSet {
  readonly items: readonly WakeItem[]
  readonly capExceeded: boolean
}

type WorkgroupOutcome =
  | Readonly<{ kind: 'running' }>
  | Readonly<{ kind: 'done' }>
  | Readonly<{ kind: 'awaiting-gate' }>
  | Readonly<{
      kind: 'awaiting-human'
      reason: 'clarify-or-delivery' | 'leader-idle' | 'leader-clarify' | 'max-rounds-wrapup'
    }>
  | Readonly<{ kind: 'leader-nudge' }>
  | Readonly<{ kind: 'failed'; reason: 'max-rounds' | 'fc-deadlock' }>

function agentMemberIds(snapshot: WorkgroupTurnsSnapshot): readonly string[] {
  return snapshot.config.members
    .filter((member) => member.memberType === 'agent')
    .map((member) => member.id)
}

function agentAssignee(
  snapshot: WorkgroupTurnsSnapshot,
  assignment: WorkgroupTurnAssignment,
): boolean {
  if (assignment.assigneeMemberId === null) return false
  return snapshot.config.members.some(
    (member) => member.id === assignment.assigneeMemberId && member.memberType === 'agent',
  )
}

function hasUnconsumed(snapshot: WorkgroupTurnsSnapshot, memberId: string): boolean {
  const cursor = snapshot.cursors.get(memberId) ?? ''
  return snapshot.messages.some(
    (message) => message.id > cursor && message.authorMemberId !== memberId,
  )
}

function hasUnconsumedMention(snapshot: WorkgroupTurnsSnapshot, memberId: string): boolean {
  const cursor = snapshot.cursors.get(memberId) ?? ''
  return snapshot.messages.some(
    (message) =>
      message.id > cursor &&
      message.authorMemberId !== memberId &&
      message.mentionMemberIds.includes(memberId),
  )
}

function cardBusyMemberIds(snapshot: WorkgroupTurnsSnapshot): Set<string> {
  const busy = new Set<string>()
  for (const assignment of snapshot.assignments) {
    if (assignment.assigneeMemberId === null) continue
    if (
      assignment.status === 'dispatched' ||
      assignment.status === 'running' ||
      assignment.status === 'awaiting_human'
    ) {
      busy.add(assignment.assigneeMemberId)
    }
  }
  return busy
}

function hasSalvageableWork(snapshot: WorkgroupTurnsSnapshot): boolean {
  return snapshot.assignments.some(
    (assignment) => assignment.status === 'done' || assignment.status === 'delivered',
  )
}

function trailingNudgeCount(messages: readonly WorkgroupMessage[]): number {
  let count = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.kind !== 'nudge') break
    count++
  }
  return count
}

function deriveWakeSet(snapshot: WorkgroupTurnsSnapshot, inflight: InflightTurns): WakeSet {
  if (snapshot.state.gateStatus === 'awaiting_confirmation') {
    return { items: [], capExceeded: false }
  }
  const switches = resolveWorkgroupSwitches(snapshot.config.mode, snapshot.config.switches)
  const budgetUsed = roundBudget(snapshot)
  const items: WakeItem[] = []
  let capExceeded = false
  if (snapshot.config.mode === 'leader_worker') {
    for (const assignment of snapshot.assignments) {
      if (
        assignment.status === 'dispatched' &&
        agentAssignee(snapshot, assignment) &&
        !inflight.runningAssignmentIds.has(assignment.id)
      ) {
        items.push({ kind: 'assignment', assignmentId: assignment.id })
      }
    }
    if (switches.directMessages) {
      const busy = cardBusyMemberIds(snapshot)
      for (const memberId of inflight.messageTurnMemberIds) busy.add(memberId)
      for (const memberId of agentMemberIds(snapshot)) {
        if (memberId === snapshot.config.leaderMemberId) continue
        if (busy.has(memberId) || !hasUnconsumedMention(snapshot, memberId)) continue
        items.push({ kind: 'message-turn', memberId })
      }
    }
    const leaderId = snapshot.config.leaderMemberId
    if (leaderId !== null && !inflight.leaderRunning && !snapshot.leaderClarifyParked) {
      const blocking = snapshot.assignments.some(
        (assignment) =>
          agentAssignee(snapshot, assignment) &&
          (assignment.status === 'dispatched' || assignment.status === 'running'),
      )
      const pendingAssignment = items.some((item) => item.kind === 'assignment')
      if (!blocking && !pendingAssignment && !gateDeclared(snapshot.state)) {
        const reason =
          budgetUsed === 0
            ? 'initial'
            : snapshot.state.gateStatus === 'rejected'
              ? 'gate-rejected'
              : hasUnconsumed(snapshot, leaderId)
                ? 'new-content'
                : null
        if (reason !== null) {
          if (budgetUsed >= snapshot.config.maxRounds) {
            if (budgetUsed === snapshot.config.maxRounds && hasSalvageableWork(snapshot)) {
              items.push({ kind: 'leader', reason: 'wrap-up' })
            } else {
              capExceeded = true
            }
          } else {
            items.push({ kind: 'leader', reason })
          }
        }
      }
    }
    return { items, capExceeded }
  }
  if (snapshot.config.mode !== 'free_collab') return { items: [], capExceeded: false }
  const nothingStarted =
    budgetUsed === 0 &&
    snapshot.assignments.length === 0 &&
    inflight.runningAssignmentIds.size === 0 &&
    inflight.messageTurnMemberIds.size === 0
  if (nothingStarted) {
    for (const memberId of agentMemberIds(snapshot)) {
      if (budgetUsed + items.length >= snapshot.config.maxRounds) {
        capExceeded = true
        break
      }
      items.push({ kind: 'fc-initial', memberId })
    }
    return { items, capExceeded }
  }
  if (inflight.initialPlanningMemberIds.size > 0) {
    return { items: [], capExceeded: false }
  }
  const claimedThisWake = new Set<string>()
  const orphaned = new Map<string, string[]>()
  for (const assignment of snapshot.assignments) {
    if (
      assignment.status !== 'dispatched' ||
      !agentAssignee(snapshot, assignment) ||
      assignment.assigneeMemberId === null ||
      inflight.runningAssignmentIds.has(assignment.id) ||
      inflight.taskTurnMemberIds.has(assignment.assigneeMemberId)
    ) {
      continue
    }
    const current = orphaned.get(assignment.assigneeMemberId)
    if (current === undefined) orphaned.set(assignment.assigneeMemberId, [assignment.id])
    else current.push(assignment.id)
  }
  for (const [memberId, assignmentIds] of orphaned) {
    if (budgetUsed + items.length >= snapshot.config.maxRounds) {
      capExceeded = true
      break
    }
    claimedThisWake.add(memberId)
    items.push({
      kind: 'fc-claim',
      memberId,
      assignmentIds: assignmentIds.slice(0, WG_FC_CLAIM_BATCH_LIMIT),
    })
  }
  if (!capExceeded) {
    const busy = cardBusyMemberIds(snapshot)
    for (const memberId of inflight.taskTurnMemberIds) busy.add(memberId)
    const open = snapshot.assignments
      .filter((assignment) => assignment.status === 'open')
      .map((assignment) => assignment.id)
    const idleAll = agentMemberIds(snapshot).filter(
      (memberId) => !busy.has(memberId) && !claimedThisWake.has(memberId),
    )
    const readonly = new Set(
      snapshot.memberAgents.filter((member) => member.readonly).map((member) => member.memberId),
    )
    const rosterHasWritable = agentMemberIds(snapshot).some((memberId) => !readonly.has(memberId))
    const idle = rosterHasWritable ? idleAll.filter((memberId) => !readonly.has(memberId)) : idleAll
    if (open.length > 0 && idle.length > 0) {
      const batchSize = Math.min(WG_FC_CLAIM_BATCH_LIMIT, Math.ceil(open.length / idle.length))
      for (let index = 0; index < idle.length; index++) {
        const memberId = idle[index]
        if (memberId === undefined) continue
        const assignmentIds = open.slice(index * batchSize, (index + 1) * batchSize)
        if (assignmentIds.length === 0) break
        if (budgetUsed + items.length >= snapshot.config.maxRounds) {
          capExceeded = true
          break
        }
        items.push({ kind: 'fc-claim', memberId, assignmentIds })
      }
    }
  }
  if (switches.directMessages) {
    for (const memberId of agentMemberIds(snapshot)) {
      if (
        inflight.messageTurnMemberIds.has(memberId) ||
        !hasUnconsumedMention(snapshot, memberId)
      ) {
        continue
      }
      if (budgetUsed + items.length >= snapshot.config.maxRounds) {
        capExceeded = true
        continue
      }
      items.push({ kind: 'message-turn', memberId })
    }
  }
  return { items, capExceeded }
}

function decideWorkgroupOutcome(
  snapshot: WorkgroupTurnsSnapshot,
  inflight: InflightTurns,
  wake: WakeSet,
): WorkgroupOutcome {
  if (
    wake.items.length > 0 ||
    inflight.leaderRunning ||
    inflight.runningAssignmentIds.size > 0 ||
    inflight.messageTurnMemberIds.size > 0 ||
    inflight.initialPlanningMemberIds.size > 0
  ) {
    return { kind: 'running' }
  }
  if (snapshot.leaderClarifyParked) {
    return { kind: 'awaiting-human', reason: 'leader-clarify' }
  }
  if (snapshot.state.gateStatus === 'awaiting_confirmation') {
    return { kind: 'awaiting-gate' }
  }
  if (wake.capExceeded) {
    return hasSalvageableWork(snapshot)
      ? { kind: 'awaiting-human', reason: 'max-rounds-wrapup' }
      : { kind: 'failed', reason: 'max-rounds' }
  }
  const humanPending = snapshot.assignments.some(
    (assignment) =>
      assignment.status === 'awaiting_human' ||
      (assignment.status === 'dispatched' && !agentAssignee(snapshot, assignment)),
  )
  if (snapshot.config.mode === 'leader_worker') {
    if (gateDeclared(snapshot.state)) {
      return resolveCompletionGate(snapshot.config.members, snapshot.config.completionGate)
        ? { kind: 'awaiting-gate' }
        : { kind: 'done' }
    }
    if (humanPending) return { kind: 'awaiting-human', reason: 'clarify-or-delivery' }
    return trailingNudgeCount(snapshot.messages) < WG_LEADER_IDLE_NUDGE_LIMIT
      ? { kind: 'leader-nudge' }
      : { kind: 'awaiting-human', reason: 'leader-idle' }
  }
  const openOrActive = snapshot.assignments.some(
    (assignment) =>
      assignment.status === 'open' ||
      assignment.status === 'dispatched' ||
      assignment.status === 'running' ||
      assignment.status === 'awaiting_human' ||
      assignment.status === 'delivered',
  )
  if (!openOrActive) return { kind: 'done' }
  if (humanPending) return { kind: 'awaiting-human', reason: 'clarify-or-delivery' }
  return snapshot.assignments.some((assignment) => assignment.status === 'open')
    ? { kind: 'failed', reason: 'fc-deadlock' }
    : { kind: 'awaiting-human', reason: 'clarify-or-delivery' }
}

function wakeKey(item: WakeItem): string {
  if (item.kind === 'leader') return 'leader'
  if (item.kind === 'assignment') return `assignment:${item.assignmentId}`
  if (item.kind === 'message-turn') return `message:${item.memberId}`
  if (item.kind === 'fc-initial') return `initial:${item.memberId}`
  return `claim:${item.memberId}`
}

function markWake(inflight: InflightTurns, item: WakeItem, active: boolean): void {
  const update = (set: Set<string>, value: string): void => {
    if (active) set.add(value)
    else set.delete(value)
  }
  if (item.kind === 'leader') {
    inflight.leaderRunning = active
  } else if (item.kind === 'assignment') {
    update(inflight.runningAssignmentIds, item.assignmentId)
  } else if (item.kind === 'message-turn') {
    update(inflight.messageTurnMemberIds, item.memberId)
  } else if (item.kind === 'fc-initial') {
    update(inflight.messageTurnMemberIds, item.memberId)
    update(inflight.initialPlanningMemberIds, item.memberId)
  } else {
    for (const assignmentId of item.assignmentIds) {
      update(inflight.runningAssignmentIds, assignmentId)
    }
    update(inflight.taskTurnMemberIds, item.memberId)
  }
}

function markAdoptedRun(
  inflight: InflightTurns,
  snapshot: WorkgroupTurnsSnapshot,
  run: WorkgroupTurnHostRun,
  active: boolean,
): void {
  if (run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID) {
    inflight.leaderRunning = active
    return
  }
  if (run.shardKey === null) return
  const message = parseMsgShardKey(run.shardKey)
  if (message !== null) {
    if (active) inflight.messageTurnMemberIds.add(message.memberId)
    else inflight.messageTurnMemberIds.delete(message.memberId)
    return
  }
  const batch = parseBatchShardKey(run.shardKey)
  if (batch !== null) {
    for (const assignmentId of batch.assignmentIds) {
      if (active) inflight.runningAssignmentIds.add(assignmentId)
      else inflight.runningAssignmentIds.delete(assignmentId)
    }
    if (active) inflight.taskTurnMemberIds.add(batch.memberId)
    else inflight.taskTurnMemberIds.delete(batch.memberId)
    return
  }
  if (active) inflight.runningAssignmentIds.add(run.shardKey)
  else inflight.runningAssignmentIds.delete(run.shardKey)
  const assignment = snapshot.assignments.find((candidate) => candidate.id === run.shardKey)
  if (assignment?.assigneeMemberId !== null && assignment?.assigneeMemberId !== undefined) {
    if (active) inflight.taskTurnMemberIds.add(assignment.assigneeMemberId)
    else inflight.taskTurnMemberIds.delete(assignment.assigneeMemberId)
  }
}

async function driveWakeItem(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly item: WakeItem
  readonly registerMint: (runId: string) => void
}): Promise<DriveStep> {
  if (input.item.kind === 'leader') {
    return await driveLeaderTurn({
      persistence: input.persistence,
      snapshot: input.snapshot,
      host: input.host,
      wrapUp: input.item.reason === 'wrap-up',
      registerMint: input.registerMint,
    })
  }
  if (input.item.kind === 'assignment') {
    const assignmentId = input.item.assignmentId
    const assignment = input.snapshot.assignments.find((candidate) => candidate.id === assignmentId)
    if (assignment === undefined) return { kind: 'lost' }
    return await driveAssignmentTurn({
      persistence: input.persistence,
      snapshot: input.snapshot,
      host: input.host,
      assignment,
      registerMint: input.registerMint,
    })
  }
  if (input.item.kind === 'fc-claim') {
    return await driveBatchTurn({
      persistence: input.persistence,
      snapshot: input.snapshot,
      host: input.host,
      memberId: input.item.memberId,
      candidateIds: input.item.assignmentIds,
      registerMint: input.registerMint,
    })
  }
  return await driveMessageTurn({
    persistence: input.persistence,
    snapshot: input.snapshot,
    host: input.host,
    memberId: input.item.memberId,
    initial: input.item.kind === 'fc-initial',
    registerMint: input.registerMint,
  })
}

async function driveAdoptedRun(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly run: WorkgroupTurnHostRun
  readonly registerMint: (runId: string) => void
}): Promise<DriveStep> {
  if (input.run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID) {
    return await driveLeaderTurn({
      persistence: input.persistence,
      snapshot: input.snapshot,
      host: input.host,
      adoptedRun: input.run,
      wrapUp:
        roundBudget(input.snapshot) >= input.snapshot.config.maxRounds &&
        hasSalvageableWork(input.snapshot),
      registerMint: input.registerMint,
    })
  }
  if (input.run.shardKey === null) return { kind: 'lost' }
  const message = parseMsgShardKey(input.run.shardKey)
  if (message !== null) {
    return await driveMessageTurn({
      persistence: input.persistence,
      snapshot: input.snapshot,
      host: input.host,
      memberId: message.memberId,
      initial: false,
      adoptedRun: input.run,
      registerMint: input.registerMint,
    })
  }
  const batch = parseBatchShardKey(input.run.shardKey)
  if (batch !== null) {
    return await driveBatchTurn({
      persistence: input.persistence,
      snapshot: input.snapshot,
      host: input.host,
      memberId: batch.memberId,
      candidateIds: batch.assignmentIds,
      adoptedRun: input.run,
      registerMint: input.registerMint,
    })
  }
  const assignment = input.snapshot.assignments.find(
    (candidate) => candidate.id === input.run.shardKey,
  )
  if (assignment === undefined) return { kind: 'lost' }
  return await driveAssignmentTurn({
    persistence: input.persistence,
    snapshot: input.snapshot,
    host: input.host,
    assignment,
    adoptedRun: input.run,
    registerMint: input.registerMint,
  })
}

function cancelLeftovers(
  snapshot: WorkgroupTurnsSnapshot,
): readonly WorkgroupTurnLedgerOperation[] {
  return snapshot.assignments.flatMap((assignment) => {
    if (
      assignment.status !== 'open' &&
      assignment.status !== 'dispatched' &&
      assignment.status !== 'awaiting_human' &&
      assignment.status !== 'delivered'
    ) {
      return []
    }
    return [
      transitionAssignment({
        key: `cancel-leftover:${assignment.id}`,
        assignmentId: assignment.id,
        from: assignment.status,
        to: 'canceled',
      }),
    ]
  })
}

async function openCompletionGate(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
}): Promise<boolean> {
  const runId = ulid()
  const operations: WorkgroupTurnLedgerOperation[] = []
  if (
    input.snapshot.state.gateStatus === 'idle' ||
    input.snapshot.state.gateStatus === 'rejected'
  ) {
    operations.push({
      kind: 'transition-gate',
      operationKey: `gate-declare:${runId}`,
      from: [input.snapshot.state.gateStatus],
      to: 'declared',
      ...(input.snapshot.state.gateSummary === null
        ? {}
        : { summary: input.snapshot.state.gateSummary }),
    })
  }
  operations.push(
    {
      kind: 'mint-host-run',
      operationKey: `gate-mint:${runId}`,
      runId,
      nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
      status: 'awaiting_review',
      cause: 'wg-gate',
      retryIndex: 0,
      shardKey: null,
      agentOverrideName: null,
      agentOverrideId: null,
      wgRound: messageRound(input.snapshot),
    },
    {
      kind: 'transition-gate',
      operationKey: `gate-await:${runId}`,
      from: ['declared'],
      to: 'awaiting_confirmation',
    },
    createMessage(
      `gate-message:${runId}`,
      messageDraft({
        round: messageRound(input.snapshot),
        authorKind: 'system',
        kind: 'system',
        bodyMd: `completion gate: waiting for human confirmation${input.snapshot.state.gateSummary === null ? '' : ` — ${input.snapshot.state.gateSummary}`}`,
        templateKey: 'completionGateWaiting',
        templateParams: { summary: input.snapshot.state.gateSummary ?? '' },
      }),
    ),
  )
  const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
  if (!receipt.committed) return false
  input.host.broadcastNodeStatus?.(runId, WORKGROUP_TURN_LEADER_NODE_ID, 'awaiting_review')
  return true
}

async function warnIfZeroDelta(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly log: WorkgroupTurnLogger
}): Promise<void> {
  if (resolveWorkgroupOutputContract(input.snapshot.config.outputContract) !== 'files') return
  const doneCount = input.snapshot.assignments.filter(
    (assignment) => assignment.status === 'done',
  ).length
  if (doneCount === 0 || input.host.getCanonicalFilesChanged === undefined) return
  let changed: number
  try {
    changed = await input.host.getCanonicalFilesChanged()
  } catch {
    return
  }
  if (changed !== 0) return
  await commit(input.persistence, input.snapshot.taskId, [
    createMessage(
      `zero-delta:${ulid()}`,
      messageDraft({
        round: messageRound(input.snapshot),
        authorKind: 'system',
        kind: 'decision',
        bodyMd: `workgroup completed ${doneCount} assignment(s) without a canonical file delta`,
        templateKey: 'zeroDeltaDone',
        templateParams: { count: doneCount },
      }),
    ),
  ])
  input.log.warn('workgroup done with zero canonical delta despite completed work', {
    taskId: input.snapshot.taskId,
    doneAssignmentCount: doneCount,
  })
}

async function reconcileRunningAssignments(
  persistence: WorkgroupTurnsPersistencePort,
  snapshot: WorkgroupTurnsSnapshot,
): Promise<void> {
  const operations: WorkgroupTurnLedgerOperation[] = []
  for (const assignment of snapshot.assignments) {
    if (assignment.status !== 'running') continue
    const direct =
      assignment.nodeRunId === null
        ? undefined
        : snapshot.hostRuns.find((run) => run.id === assignment.nodeRunId)
    const byShard = snapshot.hostRuns.filter(
      (run) => run.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID && run.shardKey === assignment.id,
    )
    const latest = direct ?? byShard[byShard.length - 1]
    if (latest?.status === 'pending' || latest?.status === 'running') continue
    operations.push(
      transitionAssignment({
        key: `reconcile-running:${assignment.id}`,
        assignmentId: assignment.id,
        from: 'running',
        to: latest?.status === 'done' ? 'done' : 'dispatched',
      }),
    )
  }
  if (operations.length > 0) {
    await commit(persistence, snapshot.taskId, operations)
  }
}

async function finalizeDone(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly log: WorkgroupTurnLogger
}): Promise<WorkgroupTurnsDriveOutcome | null> {
  const operations: WorkgroupTurnLedgerOperation[] = [...cancelLeftovers(input.snapshot)]
  if (
    input.snapshot.config.mode === 'free_collab' &&
    input.snapshot.state.resultMessageId === null
  ) {
    const doneCards = input.snapshot.assignments.filter(
      (assignment) => assignment.status === 'done',
    )
    const lines = doneCards.map((assignment) => {
      const result =
        assignment.resultMessageId === null
          ? undefined
          : input.snapshot.messages.find((message) => message.id === assignment.resultMessageId)
              ?.bodyMd
      return `- ${assignment.title}${result === undefined ? '' : `: ${result}`}`
    })
    const summary = messageDraft({
      round: messageRound(input.snapshot),
      authorKind: 'system',
      kind: 'decision',
      bodyMd:
        lines.length === 0
          ? 'free_collab converged with no completed assignment'
          : `free_collab converged (${doneCards.length})\n${lines.join('\n')}`,
      templateKey: lines.length === 0 ? 'freeCollabConvergedEmpty' : 'freeCollabConverged',
      templateParams:
        lines.length === 0 ? {} : { count: doneCards.length, details: lines.join('\n') },
    })
    operations.push(createMessage(`free-collab-summary:${summary.id}`, summary), {
      kind: 'stamp-result-anchor',
      operationKey: `free-collab-anchor:${summary.id}`,
      messageId: summary.id,
    })
  }
  if (operations.length > 0) {
    const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
    if (!receipt.committed) return null
  }
  const completionGate = resolveCompletionGate(
    input.snapshot.config.members,
    input.snapshot.config.completionGate,
  )
  if (
    completionGate &&
    input.snapshot.state.gateStatus !== 'approved' &&
    input.snapshot.state.gateStatus !== 'awaiting_confirmation'
  ) {
    const opened = await openCompletionGate(input)
    return opened
      ? {
          kind: 'awaiting_review',
          detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
        }
      : null
  }
  if (input.snapshot.state.gateStatus === 'awaiting_confirmation') {
    return {
      kind: 'awaiting_review',
      detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
    }
  }
  await warnIfZeroDelta(input)
  return { kind: 'ok' }
}

/**
 * Provider-neutral workgroup turn loop. All durable reads and transitions are
 * expressed through the closed ledger port; providers own transactionality.
 */
export function createWorkgroupTurnsOperations(
  persistence: WorkgroupTurnsPersistencePort,
): WorkgroupTurnsOperations {
  return Object.freeze({
    async drive(
      input: Parameters<WorkgroupTurnsOperations['drive']>[0],
    ): Promise<WorkgroupTurnsDriveOutcome> {
      const first = await persistence.load(input.taskId)
      if (first === null || first.config.mode === 'dynamic_workflow') {
        return {
          kind: 'failed',
          detail: {
            summary: 'workgroup config missing or invalid',
            message: 'workgroup_config_json unreadable',
          },
        }
      }
      const initialOperations: WorkgroupTurnLedgerOperation[] = [
        { kind: 'ensure-task-state', operationKey: 'ensure-task-state' },
      ]
      if (
        roundBudget(first) === 0 &&
        first.messages.length === 0 &&
        first.config.goal.trim().length > 0
      ) {
        const directed =
          first.config.mode === 'leader_worker' && first.config.leaderMemberId !== null
        initialOperations.push({
          kind: 'seed-goal-if-empty',
          operationKey: 'seed-goal',
          message: messageDraft({
            round: 0,
            authorKind: 'system',
            kind: 'chat',
            bodyMd: first.config.goal.trim(),
            mentionMemberIds:
              directed && first.config.leaderMemberId !== null ? [first.config.leaderMemberId] : [],
          }),
        })
      }
      await commit(persistence, input.taskId, initialOperations)
      await reconcileRunningAssignments(persistence, first)

      const inflightState: InflightTurns = {
        leaderRunning: false,
        runningAssignmentIds: new Set(),
        messageTurnMemberIds: new Set(),
        initialPlanningMemberIds: new Set(),
        taskTurnMemberIds: new Set(),
      }
      const inflight = new Map<string, Promise<DriveStep>>()
      const mintedHere = new Set<string>()
      let fatalOutcome: WorkgroupTurnsDriveOutcome | null = null
      const registerMint = (runId: string): void => {
        mintedHere.add(runId)
      }

      for (;;) {
        if (input.signal?.aborted === true) {
          await Promise.allSettled(inflight.values())
          return { kind: 'canceled' }
        }
        if (fatalOutcome !== null) {
          await Promise.allSettled(inflight.values())
          return fatalOutcome
        }
        const snapshot = await persistence.load(input.taskId)
        if (snapshot === null || snapshot.config.mode === 'dynamic_workflow') {
          return {
            kind: 'failed',
            detail: {
              summary: 'workgroup config missing or invalid',
              message: 'workgroup_config_json unreadable',
            },
          }
        }
        const adoptable = snapshot.hostRuns.filter(
          (run) =>
            run.status === 'pending' && !inflight.has(`run:${run.id}`) && !mintedHere.has(run.id),
        )
        for (const run of adoptable) {
          const key = `run:${run.id}`
          markAdoptedRun(inflightState, snapshot, run, true)
          const pending = driveAdoptedRun({
            persistence,
            snapshot,
            host: input.host,
            run,
            registerMint,
          })
            .then((step) => {
              if (step.kind === 'terminal') fatalOutcome = step.outcome
              return step
            })
            .catch((error: unknown): DriveStep => {
              const message = error instanceof Error ? error.message : String(error)
              input.log.error('adopted workgroup turn threw', {
                taskId: input.taskId,
                runId: run.id,
                error: message,
              })
              if (run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID) {
                fatalOutcome = {
                  kind: 'failed',
                  detail: { summary: 'workgroup leader turn failed', message },
                }
              }
              return { kind: 'lost' }
            })
            .finally(() => {
              inflight.delete(key)
              markAdoptedRun(inflightState, snapshot, run, false)
            })
          inflight.set(key, pending)
        }

        const wake = deriveWakeSet(snapshot, inflightState)
        for (const item of wake.items) {
          const key = wakeKey(item)
          if (inflight.has(key)) continue
          markWake(inflightState, item, true)
          const pending = driveWakeItem({
            persistence,
            snapshot,
            host: input.host,
            item,
            registerMint,
          })
            .then((step) => {
              if (step.kind === 'terminal') fatalOutcome = step.outcome
              return step
            })
            .catch(async (error: unknown): Promise<DriveStep> => {
              const message = error instanceof Error ? error.message : String(error)
              input.log.error('workgroup turn threw', {
                taskId: input.taskId,
                item: key,
                error: message,
              })
              await commit(persistence, input.taskId, [
                createMessage(
                  `internal-error:${ulid()}`,
                  messageDraft({
                    round: messageRound(snapshot),
                    authorKind: 'system',
                    kind: 'system',
                    bodyMd: `workgroup turn ${key} failed internally: ${message}`,
                    templateKey: 'internalDriveError',
                    templateParams: { item: key, detail: message },
                  }),
                ),
              ])
              if (item.kind === 'leader') {
                fatalOutcome = {
                  kind: 'failed',
                  detail: { summary: 'workgroup leader turn failed', message },
                }
              }
              return { kind: 'lost' }
            })
            .finally(() => {
              inflight.delete(key)
              markWake(inflightState, item, false)
            })
          inflight.set(key, pending)
        }

        if (inflight.size > 0) {
          await Promise.race(inflight.values())
          continue
        }
        const outcome = decideWorkgroupOutcome(snapshot, inflightState, wake)
        if (outcome.kind === 'running') {
          await commit(persistence, input.taskId, [
            {
              kind: 'set-pause-reason',
              operationKey: 'pause-engine-stall',
              reason: 'engine-stall',
            },
          ])
          return { kind: 'awaiting_human' }
        }
        if (outcome.kind === 'done') {
          const finalized = await finalizeDone({
            persistence,
            snapshot,
            host: input.host,
            log: input.log,
          })
          if (finalized !== null) return finalized
          continue
        }
        if (outcome.kind === 'awaiting-gate') {
          if (snapshot.state.gateStatus === 'approved') {
            await warnIfZeroDelta({
              persistence,
              snapshot,
              host: input.host,
              log: input.log,
            })
            return { kind: 'ok' }
          }
          if (snapshot.state.gateStatus !== 'awaiting_confirmation') {
            const opened = await openCompletionGate({
              persistence,
              snapshot,
              host: input.host,
            })
            if (!opened) continue
          }
          return {
            kind: 'awaiting_review',
            detail: { summary: 'workgroup completion gate', message: 'wg-gate' },
          }
        }
        if (outcome.kind === 'leader-nudge') {
          const leaderId = snapshot.config.leaderMemberId
          const receipt = await commit(persistence, input.taskId, [
            createMessage(
              `leader-nudge:${ulid()}`,
              messageDraft({
                round: messageRound(snapshot),
                authorKind: 'system',
                kind: 'nudge',
                bodyMd:
                  'Autonomous mode: declare done if the goal is complete; otherwise dispatch the next work or report what is blocking.',
                templateKey: 'leaderNudge',
                templateParams: {},
                mentionMemberIds: leaderId === null ? [] : [leaderId],
              }),
            ),
          ])
          if (!receipt.committed) continue
          continue
        }
        if (outcome.kind === 'awaiting-human') {
          const receipt = await commit(persistence, input.taskId, [
            {
              kind: 'set-pause-reason',
              operationKey: `pause:${outcome.reason}`,
              reason: outcome.reason,
            },
          ])
          if (!receipt.committed) continue
          const summary =
            outcome.reason === 'leader-idle'
              ? 'workgroup idle — waiting for human input'
              : outcome.reason === 'leader-clarify'
                ? 'workgroup leader is waiting on a human answer to its clarify'
                : outcome.reason === 'max-rounds-wrapup'
                  ? 'workgroup hit max_rounds with completed work — review the deliverable'
                  : 'workgroup waiting on clarify answers / human delivery'
          return {
            kind: 'awaiting_human',
            detail: { summary, message: outcome.reason },
          }
        }
        const failureMessage =
          outcome.reason === 'max-rounds'
            ? `workgroup hit max_rounds (${snapshot.config.maxRounds})`
            : 'free_collab deadlock: open tasks but no claimable agent member'
        const receipt = await commit(persistence, input.taskId, [
          createMessage(
            `workgroup-failed:${ulid()}`,
            messageDraft({
              round: messageRound(snapshot),
              authorKind: 'system',
              kind: 'system',
              bodyMd: failureMessage,
              templateKey:
                outcome.reason === 'max-rounds' ? 'maxRoundsFailed' : 'freeCollabDeadlock',
              templateParams:
                outcome.reason === 'max-rounds' ? { maxRounds: snapshot.config.maxRounds } : {},
            }),
          ),
          ...cancelLeftovers(snapshot),
        ])
        if (!receipt.committed) continue
        return {
          kind: 'failed',
          detail: { summary: failureMessage, message: outcome.reason },
        }
      }
    },
  })
}

interface LeaderTurnValue {
  readonly action: 'continue' | 'done'
  readonly summary: string | undefined
  readonly assignments: readonly {
    readonly member: string
    readonly title: string
    readonly brief: string
  }[]
  readonly messages: readonly { readonly to: string | null; readonly body: string }[]
}

async function driveLeaderTurn(input: {
  readonly persistence: WorkgroupTurnsPersistencePort
  readonly snapshot: WorkgroupTurnsSnapshot
  readonly host: WorkgroupTurnHostOperations
  readonly adoptedRun?: WorkgroupTurnHostRun
  readonly wrapUp: boolean
  readonly registerMint?: (runId: string) => void
}): Promise<DriveStep> {
  const leaderId = input.snapshot.config.leaderMemberId
  if (leaderId === null) {
    return {
      kind: 'terminal',
      outcome: {
        kind: 'failed',
        detail: {
          summary: 'workgroup leader is missing',
          message: 'workgroup-leader-missing',
        },
      },
    }
  }
  const projection = memberAgent(input.snapshot, leaderId)
  if (projection === null) {
    const note = messageDraft({
      round: messageRound(input.snapshot),
      authorKind: 'system',
      kind: 'system',
      bodyMd: `leader agent unresolvable (${memberName(input.snapshot.config, leaderId)}) — failing task`,
      templateKey: 'leaderAgentUnresolvable',
      templateParams: { member: memberName(input.snapshot.config, leaderId) },
    })
    await commit(input.persistence, input.snapshot.taskId, [createMessage('leader-missing', note)])
    return {
      kind: 'terminal',
      outcome: {
        kind: 'failed',
        detail: {
          summary: 'workgroup leader agent unresolvable',
          message: 'workgroup-leader-agent-unresolvable',
        },
      },
    }
  }
  const round =
    input.adoptedRun === undefined
      ? roundBudget(input.snapshot) + 1
      : (input.adoptedRun.wgRound ?? roundBudget(input.snapshot))
  const stamp: readonly WorkgroupTurnLedgerOperation[] =
    input.adoptedRun !== undefined && input.adoptedRun.wgRound === null
      ? [
          {
            kind: 'stamp-host-run-round',
            operationKey: `stamp-leader-round:${input.adoptedRun.id}`,
            runId: input.adoptedRun.id,
            wgRound: round,
          },
        ]
      : []
  const outcome = await executeHostTurn<LeaderTurnValue>(input.persistence, {
    taskId: input.snapshot.taskId,
    snapshot: input.snapshot,
    host: input.host,
    nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
    agent: projection.agent,
    role: 'leader',
    shardKey: null,
    wgRound: round,
    primaryCause: 'wg-leader-round',
    adoptedRun: input.adoptedRun,
    registerMint: input.registerMint,
    firstStartOperations: () => stamp,
    retryStartOperations: () => [],
    prompt: (nonce, errorNotice) =>
      composePrompt(input.snapshot, leaderId, []) +
      (input.wrapUp
        ? '\n\n## FINAL round\nAggregate completed work, declare done, and do not dispatch.'
        : '') +
      (errorNotice === null
        ? ''
        : `\n\n## Protocol correction\n${errorNotice}\nUse nonce ${nonce}.`),
    parse: (outputs) => {
      const errors: string[] = []
      const decisionRaw = outputs[WG_PORT_DECISION]
      const decision = decisionRaw === undefined ? null : parseWgDecisionPort(decisionRaw)
      if (decision === null) errors.push('missing required port wg_decision')
      else if (!decision.ok) errors.push(...decision.errors.map((error) => `wg_decision: ${error}`))
      const assignmentsRaw = outputs[WG_PORT_ASSIGNMENTS]
      const assignments: ReturnType<typeof parseWgAssignmentsPort> =
        assignmentsRaw === undefined
          ? { ok: true, value: [] }
          : parseWgAssignmentsPort(assignmentsRaw, rosterNames(input.snapshot.config), {
              allowSameMemberFanOut: input.snapshot.config.fanOut === true,
            })
      if (!assignments.ok) {
        errors.push(...assignments.errors.map((error) => `wg_assignments: ${error}`))
      }
      const messagesRaw = outputs[WG_PORT_MESSAGES]
      const messages: ReturnType<typeof parseWgMessagesPort> =
        messagesRaw === undefined
          ? { ok: true, value: [] }
          : parseWgMessagesPort(messagesRaw, rosterNames(input.snapshot.config))
      if (!messages.ok) errors.push(...messages.errors.map((error) => `wg_messages: ${error}`))
      if (
        decision !== null &&
        decision.ok &&
        decision.value.action === 'done' &&
        assignments.ok &&
        assignments.value.length > 0
      ) {
        errors.push('wg_decision done cannot be combined with wg_assignments')
      }
      if (
        errors.length > 0 ||
        decision === null ||
        !decision.ok ||
        !assignments.ok ||
        !messages.ok
      ) {
        return { ok: false, errors }
      }
      return {
        ok: true,
        value: {
          action: decision.value.action,
          summary: decision.value.summary,
          assignments: input.wrapUp ? [] : assignments.value,
          messages: messages.value,
        },
      }
    },
  })
  if (outcome.kind === 'lost') return { kind: 'lost' }
  if (outcome.kind === 'canceled') {
    return { kind: 'terminal', outcome: { kind: 'canceled' } }
  }
  if (outcome.kind === 'awaiting') return { kind: 'progress' }
  if (outcome.kind === 'failed' || outcome.kind === 'protocol-exhausted') {
    const detail =
      outcome.kind === 'failed' ? outcome.message : `protocol: ${outcome.errors.join('; ')}`
    return {
      kind: 'terminal',
      outcome: {
        kind: 'failed',
        detail: { summary: 'workgroup leader turn failed', message: detail },
      },
    }
  }
  const operations: WorkgroupTurnLedgerOperation[] = [
    ...memberOutputMessageOperations({
      snapshot: input.snapshot,
      memberId: leaderId,
      round,
      messages: outcome.value.messages,
      triggerMessageId: null,
      allowDirect: true,
      allowBlackboard: true,
      keyPrefix: `leader:${outcome.runId}`,
    }),
  ]
  let dispatchIndex = 0
  for (const dispatch of outcome.value.assignments) {
    const member = input.snapshot.config.members.find(
      (candidate) => candidate.displayName === dispatch.member,
    )
    if (member === undefined) continue
    const assignment = assignmentDraft({
      round,
      source: 'leader',
      createdByRunId: outcome.runId,
      assigneeMemberId: member.id,
      title: dispatch.title,
      briefMd: dispatch.brief,
      status: 'dispatched',
    })
    operations.push({
      kind: 'create-assignment',
      operationKey: `leader-assignment:${outcome.runId}:${dispatchIndex}`,
      assignment,
    })
    operations.push(
      createMessage(
        `leader-dispatch:${outcome.runId}:${dispatchIndex}`,
        messageDraft({
          round,
          authorKind: 'member',
          authorMemberId: leaderId,
          kind: 'dispatch',
          bodyMd: `@${dispatch.member} ${dispatch.title}`,
          mentionMemberIds: [member.id],
          assignmentId: assignment.id,
        }),
      ),
    )
    dispatchIndex++
  }
  for (const assignment of input.snapshot.assignments) {
    if (assignment.status === 'delivered') {
      operations.push(
        transitionAssignment({
          key: `leader-consume-delivery:${assignment.id}`,
          assignmentId: assignment.id,
          from: 'delivered',
          to: 'done',
        }),
      )
    }
  }
  if (outcome.value.action === 'done') {
    const decision = messageDraft({
      round,
      authorKind: 'member',
      authorMemberId: leaderId,
      kind: 'decision',
      bodyMd: outcome.value.summary ?? '',
    })
    operations.push(createMessage(`leader-decision:${outcome.runId}`, decision))
    operations.push({
      kind: 'stamp-result-anchor',
      operationKey: `leader-result-anchor:${outcome.runId}`,
      messageId: decision.id,
    })
    operations.push({
      kind: 'transition-gate',
      operationKey: `leader-declare:${outcome.runId}`,
      from: input.snapshot.state.gateStatus === 'rejected' ? ['rejected'] : ['idle'],
      to: 'declared',
      ...(outcome.value.summary === undefined ? {} : { summary: outcome.value.summary }),
    })
  } else if (input.snapshot.state.gateStatus === 'rejected') {
    operations.push({
      kind: 'transition-gate',
      operationKey: `leader-consume-rejection:${outcome.runId}`,
      from: ['rejected'],
      to: 'idle',
    })
  }
  operations.push(
    cursorOperation(
      `leader-cursor:${outcome.runId}`,
      leaderId,
      maxMessageId(input.snapshot.messages),
    ),
  )
  const receipt = await commit(input.persistence, input.snapshot.taskId, operations)
  return receipt.committed ? { kind: 'progress' } : { kind: 'lost' }
}
