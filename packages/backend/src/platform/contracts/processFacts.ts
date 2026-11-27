// RFC-616 §3.2 — neutral contracts for the facts process metrics are computed from.
//
// Process metrics (run-observability) read facts that five other contexts own.
// In the target dependency graph only task-execution may import
// run-observability, so the contracts cannot live there: collaboration,
// digital-employee and event-center would have no legal way to name them.
// They live here instead. Owners implement an interface in their own
// infrastructure and hand a factory out through their composition; the
// composition root binds them; run-observability depends on this file only.
//
// Types only. Every `…Ids` argument holds at most PROCESS_FACT_ID_BATCH ids;
// callers chunk, implementations throw a RangeError beyond it.

import type {
  NodeRunStatus,
  ProcessOrigin,
  ProcessTextSource,
  TaskStatus,
  WorkflowDefinition,
  WorkgroupMode,
} from '@agent-workflow/shared'

export const PROCESS_FACT_ID_BATCH = 500

/** Who is asking. Owners apply their own visibility rule to it. */
export interface ProcessViewer {
  readonly userId: string
  /** The account may read every task (`tasks:read:all`). */
  readonly canReadAll: boolean
}

export interface ProcessWindow {
  readonly from: number
  readonly to: number
}

// --- task-execution: tasks and node runs ------------------------------------

export interface ProcessTaskUnitRow {
  readonly taskId: string
  readonly name: string
  /** `task_definitions.source_id`; null when the task has no source. */
  readonly subjectId: string | null
  /** Workgroup tasks carry the group name frozen at launch; workflow tasks carry none. */
  readonly subjectName: string | null
  readonly subjectRevision: number | null
  /** `dag`, `workgroup-turns` or `dw-generate`. */
  readonly engineKind: string
  readonly status: TaskStatus
  readonly errorSummary: string | null
  readonly origin: ProcessOrigin
  readonly ownerUserId: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  /**
   * Effective running time: time in status `running` minus the time call nodes
   * spent waiting for people inside child tasks. null when an ended task has no
   * running-time record.
   */
  readonly autoMs: number | null
}

export interface ProcessTaskSummaryRow {
  readonly taskId: string
  readonly status: TaskStatus
  readonly errorSummary: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly autoMs: number | null
}

/** A task reached from `unitTaskId` through call nodes. */
export interface ProcessDescendantRow {
  readonly unitTaskId: string
  readonly taskId: string
  /** The call node of `unitTaskId` the descendant hangs under; null when unknown. */
  readonly callNodeId: string | null
  /** The run of that call node (a node run of `unitTaskId`) that started the branch. */
  readonly callNodeRunId: string | null
}

/** Node runs of one (task, node, rerun cause, wrapper invocation, workgroup round). */
export interface ProcessExecutionRow {
  readonly taskId: string
  readonly nodeId: string
  /** The raw rerun cause; classification happens in the engine. */
  readonly rerunCause: string | null
  readonly containerRunId: string | null
  readonly wgRound: number | null
  readonly runs: number
  /** Rows with both a start and a finish time. */
  readonly endedRuns: number
  readonly failedRuns: number
  readonly interruptedRuns: number
  /** Summed finish − start of the ended rows. */
  readonly activeMs: number
}

/**
 * One row on a wrapper's slot (loop, fan-out, git). Usually an invocation; a
 * manual retry aimed at the wrapper leaves a placeholder there too, told apart
 * by its rerun cause.
 */
export interface ProcessWrapperRow {
  readonly taskId: string
  readonly runId: string
  readonly nodeId: string
  /** The raw rerun cause of the wrapper's own row; classification happens in the engine. */
  readonly rerunCause: string | null
  /** The frame the invocation itself sits in. */
  readonly containerRunId: string | null
  readonly iteration: number
  readonly seq: number
  readonly status: NodeRunStatus
  readonly startedAt: number | null
  readonly finishedAt: number | null
  /** Highest inner iteration + 1; 0 when nothing ran inside, or when counts were not asked for. */
  readonly rounds: number
  /** Distinct shard keys among the inner rows; 0 when counts were not asked for. */
  readonly shards: number
}

/** One non-container node run. */
export interface ProcessNodeRunRow {
  readonly taskId: string
  readonly nodeRunId: string
  readonly nodeId: string
  readonly rerunCause: string | null
  readonly containerRunId: string | null
  readonly wgRound: number | null
  readonly shardKey: string | null
  readonly agentOverrideId: string | null
  readonly status: NodeRunStatus
  readonly failureCode: string | null
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly seq: number
}

export interface ProcessTaskFacts {
  /**
   * Visible tasks of one subject kind that started in the window, newest first.
   * Internal tasks and child tasks are included. `subjectId` narrows to one
   * subject; `null` selects tasks without a source id.
   */
  units(
    viewer: ProcessViewer,
    query: ProcessWindow & {
      readonly kind: 'workflow' | 'workgroup'
      readonly subjectId?: string | null
      readonly limit: number
    },
  ): Promise<readonly ProcessTaskUnitRow[]>
  /** One visible task as a unit; null when it does not exist or is not visible. */
  unit(viewer: ProcessViewer, taskId: string): Promise<ProcessTaskUnitRow | null>
  /** Summaries of existing tasks; callers pass ids they already may read. */
  taskSummaries(taskIds: readonly string[]): Promise<readonly ProcessTaskSummaryRow[]>
  /** Every task reached from the given tasks through call nodes, at any depth. */
  descendants(taskIds: readonly string[]): Promise<readonly ProcessDescendantRow[]>
  /** Grouped node runs, container rows excluded. */
  executions(taskIds: readonly string[]): Promise<readonly ProcessExecutionRow[]>
  /**
   * The rows on wrapper slots. With `counts: false` the rows carry what says why each was
   * minted and how it ended, and `rounds` and `shards` are 0: no inner row is read.
   */
  wrappers(
    taskIds: readonly string[],
    options?: { readonly counts: boolean },
  ): Promise<readonly ProcessWrapperRow[]>
  /** Non-container node runs; `nodeIds` narrows to those nodes. */
  nodeRuns(
    taskIds: readonly string[],
    filter?: { readonly nodeIds?: readonly string[] },
  ): Promise<readonly ProcessNodeRunRow[]>
  /** The task's frozen workflow definition; null when absent or unreadable. */
  definition(taskId: string): Promise<WorkflowDefinition | null>
  /** Host tasks of digital-employee rounds, oldest first per round. */
  reactionHostTasks(
    roundIds: readonly string[],
  ): Promise<readonly { readonly roundId: string; readonly taskId: string }[]>
}

// --- task-execution: workgroup ----------------------------------------------------

export interface ProcessWorkgroupMember {
  readonly id: string
  readonly memberType: 'agent' | 'human'
  readonly displayName: string | null
  readonly agentId: string | null
  readonly agentName: string | null
  /** Human members: the account. */
  readonly userId: string | null
  /** The role description the group gives the member. */
  readonly roleNote: string | null
}

export interface ProcessWorkgroupRosterRow {
  readonly taskId: string
  readonly mode: WorkgroupMode | null
  readonly leaderMemberId: string | null
  /** Members of the running configuration (it can change mid-task). */
  readonly members: readonly ProcessWorkgroupMember[]
  /** Round limit (leader mode) or member-run limit (free collaboration). */
  readonly maxRounds: number | null
  readonly pauseReason: string | null
  /** Revisions of the running configuration; 1 means it never changed. */
  readonly configRevision: number
  /** Dynamic workflow: how often the generated plan was rejected. */
  readonly planRejections: number
}

export interface ProcessWorkgroupAssignmentRow {
  readonly taskId: string
  readonly assignmentId: string
  readonly round: number
  readonly source: 'leader' | 'human' | 'self_claim' | 'system'
  readonly assigneeMemberId: string | null
  readonly status: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Delivery message of an assignment a human member delivered. */
  readonly deliveredAt: number | null
  readonly deliveredByUserId: string | null
}

/** The holder run of a completion gate or a plan confirmation. */
export interface ProcessWorkgroupGateRunRow {
  readonly taskId: string
  readonly nodeRunId: string
  readonly kind: 'completion' | 'plan-confirm'
  readonly openedAt: number
  readonly closedAt: number | null
  /** The round the gate was opened in. */
  readonly round: number | null
  /** The task ended while the gate waited: the platform closed the holder, nobody decided. */
  readonly canceled: boolean
}

/** One decision on the completion gate, as written to the room. */
export interface ProcessWorkgroupGateDecisionRow {
  readonly taskId: string
  readonly at: number
  readonly userId: string | null
  readonly approved: boolean
}

export interface ProcessWorkgroupActivityRow {
  readonly taskId: string
  /** Chat and dispatch messages written by people. */
  readonly humanMessages: number
}

export interface ProcessWorkgroupFacts {
  rosters(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupRosterRow[]>
  assignments(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupAssignmentRow[]>
  gateRuns(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupGateRunRow[]>
  gateDecisions(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupGateDecisionRow[]>
  activity(taskIds: readonly string[]): Promise<readonly ProcessWorkgroupActivityRow[]>
  /** People's chat and dispatch messages, and completion-gate rejection comments. */
  texts(taskIds: readonly string[]): Promise<readonly ProcessTextItem[]>
}

// --- collaboration: review and clarify ------------------------------------------------

/** Counts carried by a gate round. Absent keys are zero. */
export type ProcessGateMeasure =
  | 'comments'
  | 'commenters'
  | 'documents'
  | 'documentsAccepted'
  | 'questions'
  | 'questionsInitial'
  | 'questionsFollowup'
  | 'followupRequests'
  | 'depthSum'
  | 'depthMax'
  | 'answersRecommended'
  | 'answersOther'
  | 'answersCustom'
  | 'answersSkipped'
  | 'questionsWithRecommendation'
  | 'maturityDecided'
  | 'maturityProvisional'
  | 'maturityUnmarked'

export interface ProcessGatePerson {
  readonly userId: string
  readonly comments: number
  readonly answers: number
}

export interface ProcessTaskGateRoundRow {
  readonly taskId: string
  readonly kind: 'review' | 'clarify'
  /** The review node, or the clarify mediator node. */
  readonly stageNodeId: string
  /** The reviewed node, or the asking node. */
  readonly relatedNodeId: string | null
  /** Workgroup clarify: the shard key of the asking host run. */
  readonly askingShardKey: string | null
  /** The node run human operations are recorded against. */
  readonly gateNodeRunId: string
  /** Rounds of one instance are numbered together: a review node run, or an asking node in a frame. */
  readonly instanceKey: string
  /** 1-based among the instance's non-void rounds, by ready time; 0 for a void round. */
  readonly ordinal: number
  /**
   * Void rounds count toward waiting time only: superseded or system-voided
   * review versions, canceled or abandoned clarify rounds.
   */
  readonly void: boolean
  readonly openedAt: number
  readonly closedAt: number | null
  /** `approved` / `iterated` / `rejected`, `continue` / `stop`, or the void status. */
  readonly outcome: string | null
  readonly deciderUserId: string | null
  /** Clarify in mindmap mode. */
  readonly mindmap: boolean
  /** Empty when the caller asked for intervals only. */
  readonly measures: Readonly<Partial<Record<ProcessGateMeasure, number>>>
  readonly people: readonly ProcessGatePerson[]
  /**
   * A mindmap round counted with its measures: the top-level categories its questions fall
   * under, by name. Nothing restricts a question to the categories its node configures, so
   * coverage is judged by the reader against the configured names, not by this list's length.
   */
  readonly categories?: readonly string[]
}

export interface ProcessGateFacts {
  /**
   * Review and clarify rounds of the tasks. With `measures: false` the rows
   * carry intervals, ordinals and outcomes only, and no stored JSON is parsed.
   */
  rounds(
    taskIds: readonly string[],
    options: { readonly measures: boolean },
  ): Promise<readonly ProcessTaskGateRoundRow[]>
  /** Review comments and send-back reasons; clarify questions with their answers. */
  texts(
    taskIds: readonly string[],
    sources: readonly ('review' | 'clarify')[],
  ): Promise<readonly ProcessTextItem[]>
}

/** One piece of text a person wrote, for theme analysis. */
export interface ProcessTextItem {
  readonly source: ProcessTextSource
  /** The task the text belongs to; null for text attached to a digital employee's case. */
  readonly taskId: string | null
  readonly caseId: string | null
  /** Node id, member id or work item the text is about. */
  readonly stageRef: string | null
  readonly at: number
  readonly text: string
}

// --- digital-employee ----------------------------------------------------------------------

export interface ProcessEmployeeCaseRow {
  readonly caseId: string
  readonly name: string
  readonly employeeId: string
  /** The employee's current name; null when the employee no longer exists. */
  readonly employeeName: string | null
  readonly employeeRevision: number
  readonly typeId: string
  readonly typeRevision: number
  readonly origin: ProcessOrigin
  readonly ownerUserId: string | null
  readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
  readonly terminalKind: string | null
  /** Set only while the case is blocked. */
  readonly blockReason: string | null
  readonly createdAt: number
  readonly terminalAt: number | null
}

export interface ProcessEmployeeRoundRow {
  readonly caseId: string
  readonly roundId: string
  readonly workItemRef: string
  readonly state: 'planned' | 'running' | 'settling' | 'completed' | 'failed' | 'obsolete'
  /** Attempts beyond the first. */
  readonly attemptOrdinal: number
  readonly createdAt: number
  readonly settledAt: number | null
}

export interface ProcessEmployeeMeteringRow {
  readonly caseId: string
  readonly roundId: string
  readonly durationMs: number
  readonly totalTokens: number
}

export interface ProcessEmployeeTransitionRow {
  readonly caseId: string
  readonly at: number
  readonly from: 'active' | 'waiting' | 'blocked' | 'terminal' | null
  readonly to: 'active' | 'waiting' | 'blocked' | 'terminal'
}

export interface ProcessEmployeeApprovalRow {
  readonly caseId: string
  readonly submittedAt: number
  /** When a final status was observed; null while pending. */
  readonly settledAt: number | null
  readonly status: string
}

export interface ProcessEmployeeFeedbackCountRow {
  readonly caseId: string
  /** null: the employee type provides no human feedback. */
  readonly items: number | null
}

export interface ProcessBilingual {
  readonly 'zh-CN': string
  readonly 'en-US': string
}

export interface ProcessEmployeeManifest {
  readonly typeId: string
  readonly typeRevision: number
  readonly regions: readonly {
    readonly regionId: string
    readonly label: ProcessBilingual
    readonly order: number
    readonly lanes: readonly {
      readonly laneId: string
      readonly label: ProcessBilingual
      readonly order: number
      readonly kind: 'spine' | 'branch'
    }[]
  }[]
  readonly workItems: readonly {
    readonly workItemRef: string
    readonly regionId: string
    readonly laneId: string
    readonly order: number
    readonly label: ProcessBilingual
    readonly nodeKind: 'business-tool' | 'system' | 'collaboration'
  }[]
  /** Work items the type declares as rework; null when it declares none. */
  readonly reworkWorkItemRefs: readonly string[] | null
}

/** One event of a subject, as stored by the event center. */
export interface ProcessSubjectEventRow {
  readonly subjectRef: string
  readonly occurredAt: number
  readonly eventTypeId: string
  /** The stored summary document, verbatim. */
  readonly summaryJson: string
}

export interface ProcessEmployeeFacts {
  /** Visible cases created in the window, newest first. `employeeId` narrows to one employee. */
  cases(
    viewer: ProcessViewer,
    query: ProcessWindow & { readonly employeeId?: string; readonly limit: number },
  ): Promise<readonly ProcessEmployeeCaseRow[]>
  /** One visible case; null when it does not exist or is not visible. */
  case(viewer: ProcessViewer, caseId: string): Promise<ProcessEmployeeCaseRow | null>
  rounds(caseIds: readonly string[]): Promise<readonly ProcessEmployeeRoundRow[]>
  metering(caseIds: readonly string[]): Promise<readonly ProcessEmployeeMeteringRow[]>
  /** Read case lifecycle events as state changes, oldest first per case. Pure. */
  transitions(events: readonly ProcessSubjectEventRow[]): readonly ProcessEmployeeTransitionRow[]
  approvals(caseIds: readonly string[]): Promise<readonly ProcessEmployeeApprovalRow[]>
  humanFeedbackCounts(
    caseIds: readonly string[],
  ): Promise<readonly ProcessEmployeeFeedbackCountRow[]>
  /** The responsibility map of an employee type revision; null when it is not available. */
  manifest(typeId: string, typeRevision: number): Promise<ProcessEmployeeManifest | null>
  /** Feedback people wrote, through the type's own projection. */
  texts(caseIds: readonly string[]): Promise<readonly ProcessTextItem[]>
}

/** The subject type case lifecycle events are published under. */
export const PROCESS_EMPLOYEE_CASE_SUBJECT = 'digital-employee.case'

// --- event-center -----------------------------------------------------------------------------

export interface ProcessSubjectEvents {
  /** Events of the subjects, oldest first per subject. */
  history(
    subjectType: string,
    subjectRefs: readonly string[],
  ): Promise<readonly ProcessSubjectEventRow[]>
}
