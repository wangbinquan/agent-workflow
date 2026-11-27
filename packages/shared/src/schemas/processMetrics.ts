import { z } from 'zod'
import { utf16MaxLength } from './utf16Length'
import { OBSERVATION_MAX_WINDOW_MS } from './observation'
import { NODE_KIND, type WorkflowDefinition } from './workflow'
import { TASK_LAUNCH_ORIGINS } from '../taskOperations'
import type { WorkgroupMode } from './workgroup'
import type { ProcessCauseGroup } from '../processCause'

// RFC-616 (design/RFC-616-process-metrics) — the HTTP contract of process
// metrics. Like run observation, every statistic is computed on demand from the
// ledgers; durations are wall-clock milliseconds, tokens are exact integers,
// cost is CNY nano-yuan, rates are fractions in [0, 1]. `null` always means
// "no sample", never zero.

// --- vocabulary -------------------------------------------------------------

export const PROCESS_SUBJECT_KINDS = ['workflow', 'workgroup', 'digital-employee'] as const
export const ProcessSubjectKindSchema = z.enum(PROCESS_SUBJECT_KINDS)
export type ProcessSubjectKind = z.infer<typeof ProcessSubjectKindSchema>

/** How one unit (a task, or a digital employee's case) ended. */
export const PROCESS_UNIT_STATUSES = ['succeeded', 'failed', 'canceled', 'active'] as const
export type ProcessUnitStatus = (typeof PROCESS_UNIT_STATUSES)[number]

/** Where a unit came from. `subtask` and `digital-employee` are derived, not launch origins. */
export const PROCESS_ORIGINS = [...TASK_LAUNCH_ORIGINS, 'subtask', 'digital-employee'] as const
export const ProcessOriginSchema = z.enum(PROCESS_ORIGINS)
export type ProcessOrigin = z.infer<typeof ProcessOriginSchema>

/** A span of time a unit spent waiting for a person. */
export const PROCESS_GATE_KINDS = [
  'review',
  'clarify',
  'completion',
  'delivery',
  'plan-confirm',
  'approval',
  'blocked',
] as const
export type ProcessGateKind = (typeof PROCESS_GATE_KINDS)[number]

export const PROCESS_STAGE_KINDS = [
  ...NODE_KIND,
  /** Platform work with a synthetic node id (repository preparation, commit and push, …). */
  'system',
  /** Work that could not be attributed to a stage. */
  'unattributed',
  'leader',
  'member-agent',
  'member-human',
  'work-item-tool',
  'work-item-system',
  'work-item-collaboration',
] as const
export type ProcessStageKind = (typeof PROCESS_STAGE_KINDS)[number]

/** Fixed stages for platform work; they are not on any canvas. */
export const PROCESS_SYSTEM_STAGES = [
  'system:repo-prep',
  'system:commit-push',
  'system:merge-resolve',
  'system:orchestrator',
  'system:other',
] as const
export type ProcessSystemStage = (typeof PROCESS_SYSTEM_STAGES)[number]
export const PROCESS_UNATTRIBUTED_STAGE = 'unattributed'

/** Human operations the route registry records (RFC-616 §5.4). */
export const PROCESS_OPERATION_ACTIONS = [
  'review.view',
  'review.comment',
  'clarify.view',
  'clarify.followup',
  'task.cancel',
  'task.resume',
  'task.retry-node',
  'task.repair',
  'task.sync-workflow',
  'question.dispatch',
  'question.manual',
  'workgroup.message',
  'workgroup.deliver',
  'workgroup.confirm',
  'workgroup.plan-confirm',
  'workgroup.cancel-assignment',
  'workgroup.config',
  'employee-case.resume',
  'employee-case.terminate',
] as const
export type ProcessOperationAction = (typeof PROCESS_OPERATION_ACTIONS)[number]

export const PROCESS_OPERATION_SUBJECT_KINDS = ['task', 'node-run', 'employee-case'] as const
export type ProcessOperationSubjectKind = (typeof PROCESS_OPERATION_SUBJECT_KINDS)[number]

/** A repeated `session` operation within this window updates the same record. */
export const PROCESS_OPERATION_SESSION_MS = 30 * 60_000
/** A `session` record's last-seen time is refreshed at most this often. */
export const PROCESS_OPERATION_TOUCH_MS = 60_000

// --- limits -----------------------------------------------------------------

/** Units one subject summary aggregates before it is marked partial. */
export const PROCESS_SUMMARY_UNIT_LIMIT = 2_000
/** Units one subject listing aggregates before it is marked partial. */
export const PROCESS_LIST_UNIT_LIMIT = 5_000
export const PROCESS_UNIT_PAGE_SIZE = 25

// --- queries ----------------------------------------------------------------

const windowShape = {
  from: z.coerce.number().int().min(0),
  to: z.coerce.number().int().min(1),
}
const validWindow = (v: { from: number; to: number }) =>
  v.to > v.from && v.to - v.from <= OBSERVATION_MAX_WINDOW_MS

export const ProcessSubjectsQuerySchema = z
  .object({ ...windowShape, kind: ProcessSubjectKindSchema })
  .refine(validWindow, { message: 'invalid-window' })
export type ProcessSubjectsQuery = z.infer<typeof ProcessSubjectsQuerySchema>

export const PROCESS_COMPARE_MODES = ['off', 'period', 'version'] as const
export type ProcessCompareMode = (typeof PROCESS_COMPARE_MODES)[number]

export const ProcessSummaryQuerySchema = z
  .object({
    ...windowShape,
    /** Minutes east of UTC used to cut weekly buckets. */
    tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
    compare: z.enum(PROCESS_COMPARE_MODES).default('off'),
    /** With `compare=version`: units of a revision below it are the baseline. */
    split: z.coerce.number().int().min(0).optional(),
    origin: ProcessOriginSchema.optional(),
  })
  .refine(validWindow, { message: 'invalid-window' })
  .refine((v) => v.compare !== 'version' || v.split !== undefined, { message: 'split-required' })
export type ProcessSummaryQuery = z.infer<typeof ProcessSummaryQuerySchema>

export const PROCESS_UNIT_FILTERS = ['all', 'succeeded', 'unsuccessful', 'active'] as const
export type ProcessUnitFilter = (typeof PROCESS_UNIT_FILTERS)[number]

export const ProcessUnitsQuerySchema = z
  .object({
    ...windowShape,
    status: z.enum(PROCESS_UNIT_FILTERS).default('all'),
    origin: ProcessOriginSchema.optional(),
    cursor: z.string().min(1).check(utf16MaxLength(200)).optional(),
  })
  .refine(validWindow, { message: 'invalid-window' })
export type ProcessUnitsQuery = z.infer<typeof ProcessUnitsQuerySchema>

export const ProcessInsightQuerySchema = z
  .object(windowShape)
  .refine(validWindow, { message: 'invalid-window' })
export type ProcessInsightQuery = z.infer<typeof ProcessInsightQuerySchema>

/** The reserved path segment for units that have no source id. */
export const PROCESS_NO_SUBJECT = '-'

// --- shared response pieces ---------------------------------------------------

/** Distribution of one measure over its sample. */
export interface ProcessStat {
  readonly n: number
  readonly p50: number | null
  readonly p90: number | null
  readonly mean: number | null
}

/** A headline number with the same number of the comparison baseline. */
export interface ProcessCompared {
  readonly value: number | null
  /** null when comparison is off or the baseline has no sample. */
  readonly baseline: number | null
}

export interface ProcessUnitCounts {
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly canceled: number
  readonly active: number
}

/** What the numbers on this page do and do not cover. */
export interface ProcessDataNote {
  /** Units the statistics were computed from. */
  readonly units: number
  /** More units exist than the limit; only the newest were aggregated. */
  readonly partial: boolean
  readonly unitLimit: number
  /** Ended units that started before the first recorded runtime call: no token statistics. */
  readonly unitsWithoutUsage: number
  /** Ended units with no running-time record (very old tasks): no time split. */
  readonly unitsWithoutRuntime: number
  /** Executions whose cause was never recorded; they count as first executions. */
  readonly runsWithoutCause: number
  /** Some calls reported partial usage: token totals are a lower bound. */
  readonly usageLowerBound: boolean
  /** Some calls have tokens but no price: cost totals are a lower bound. */
  readonly unpriced: boolean
}

export interface ProcessIdentity {
  readonly id: string
  readonly username: string
  readonly displayName: string
}

export const PROCESS_METRIC_IDS = [
  'units',
  'successRate',
  'leadP50',
  'leadP90',
  'flowEfficiency',
  'tokensPerUnit',
  'costNanoPerUnit',
  'firstPassRate',
  'interventionsPerUnit',
  'roundsPerUnit',
  'roundCapRate',
  'assignmentsPerUnit',
  'coordinationShare',
  'protocolRetryRate',
  'mergeRate',
  'blockedRate',
] as const
export type ProcessMetricId = (typeof PROCESS_METRIC_IDS)[number]

/** Which way is an improvement, so a delta can be called better or worse. */
export const PROCESS_METRIC_BETTER = {
  units: 'up',
  successRate: 'up',
  leadP50: 'down',
  leadP90: 'down',
  flowEfficiency: 'up',
  tokensPerUnit: 'down',
  costNanoPerUnit: 'down',
  firstPassRate: 'up',
  interventionsPerUnit: 'down',
  roundsPerUnit: 'down',
  roundCapRate: 'down',
  assignmentsPerUnit: 'down',
  coordinationShare: 'down',
  protocolRetryRate: 'down',
  mergeRate: 'up',
  blockedRate: 'down',
} as const satisfies Record<ProcessMetricId, 'up' | 'down'>

/** Mean time of one succeeded unit, split into what it was doing. */
export interface ProcessTimeSplit {
  /** Succeeded units that have a running-time record. */
  readonly sampleUnits: number
  readonly leadMs: number | null
  readonly autoMs: number
  readonly waits: readonly { readonly kind: ProcessGateKind; readonly ms: number }[]
  /** Queueing, interruption and anything else. */
  readonly otherMs: number
}

/** Mean tokens of one unit by why the execution ran. */
export interface ProcessCauseSlice {
  readonly cause: ProcessCauseGroup
  readonly tokens: number
  readonly costNano: number
  /** Share of the summed node-run durations; parallel runs overlap, so no absolute value. */
  readonly durationShare: number | null
}

export interface ProcessInterventions {
  /** Closed, non-void human gate rounds per unit, by kind. */
  readonly gates: readonly { readonly kind: ProcessGateKind; readonly perUnit: number }[]
  readonly manualRetriesPerUnit: number
  /** Resume, repair, sync and cancel operations per unit; recorded only since launch. */
  readonly operationsPerUnit: number
}

export interface ProcessTrendPoint {
  /** First day (`YYYY-MM-DD`, at the requested offset) of the week. */
  readonly week: string
  readonly units: number
  readonly leadP50: number | null
  readonly tokensPerUnit: number | null
  readonly firstPassRate: number | null
}

export interface ProcessStability {
  readonly failureCodes: readonly { readonly code: string; readonly runs: number }[]
  readonly autoRetries: number
  readonly interruptions: number
  /** Executions that resumed after a failure, an interruption, a cancel or a manual retry. */
  readonly recoveries: number
  readonly manualRetries: number
  /** Units canceled because they exceeded their time or token limit. */
  readonly limitCancellations: number
  /** Resume and repair operations; recorded only since launch. */
  readonly operations: number
}

// --- hints --------------------------------------------------------------------

export const PROCESS_HINT_IDS = [
  'wait-dominant',
  'gate-slow',
  'output-rejected',
  'rework-cost',
  'clarify-mostly-recommended',
  'options-unfit',
  'loop-capped',
  'auto-retry-high',
  'first-pass-low',
  'coordination-high',
  'completion-rejected',
  'human-delivery-slow',
  'blocked-high',
  'work-item-repeated',
] as const
export type ProcessHintId = (typeof PROCESS_HINT_IDS)[number]

export const PROCESS_HINT_SEVERITIES = ['high', 'mid', 'info'] as const
export type ProcessHintSeverity = (typeof PROCESS_HINT_SEVERITIES)[number]

/** Tabs a hint can point at; the page maps them per subject kind. */
export const PROCESS_HINT_TARGETS = ['overview', 'stages', 'gates', 'members', 'rounds'] as const
export type ProcessHintTarget = (typeof PROCESS_HINT_TARGETS)[number]

export interface ProcessHint {
  readonly id: ProcessHintId
  readonly severity: ProcessHintSeverity
  readonly target: ProcessHintTarget
  /** Numbers and names the localized sentence is filled with. */
  readonly params: Readonly<Record<string, string | number | null>>
}

// --- stages (workflow nodes) ----------------------------------------------------

export interface ProcessLoopFacts {
  readonly roundsMean: number | null
  readonly roundsMax: number | null
  readonly maxIterations: number | null
  /** Share of loop invocations that hit the cap. */
  readonly capRate: number | null
  /** true: the loop continues after the cap, so "ran every round" also counts. */
  readonly capIncludesFullRuns: boolean
}

export interface ProcessFanoutFacts {
  readonly shardsMean: number | null
  readonly shardFailureRate: number | null
}

export interface ProcessStageRow {
  readonly key: string
  /** A plain name, or both languages for digital-employee work items. */
  readonly label: string | { readonly 'zh-CN': string; readonly 'en-US': string }
  readonly kind: ProcessStageKind
  readonly parentKey: string | null
  readonly order: number
  /** Executed by some unit but no longer in the newest definition. */
  readonly removed: boolean
  /** Units in which this stage executed or held a gate. */
  readonly units: number
  readonly runsPerUnit: number | null
  /** Per-unit sum of this stage's execution time. */
  readonly durationMs: ProcessStat
  readonly tokensPerUnit: number | null
  readonly costNanoPerUnit: number | null
  /** Share of all tokens of the subject. */
  readonly tokenShare: number | null
  readonly failureRate: number | null
  readonly autoRetryRate: number | null
  readonly topFailureCode: string | null
  /** Share of this stage's failures that carry the top failure code. */
  readonly topFailureShare: number | null
  /** Reviews of this stage's output that were sent back. */
  readonly rejectRate: number | null
  /** Units in which this stage asked a person. */
  readonly clarifyRate: number | null
  /** Tokens review rework spent on this stage, as a share of its tokens. */
  readonly reworkTokenShare: number | null
  /** Human gates held at this stage. */
  readonly gateRoundsPerUnit: number | null
  readonly gateWaitMsPerUnit: number | null
  readonly gateFirstPassRate: number | null
  readonly loop: ProcessLoopFacts | null
  readonly fanout: ProcessFanoutFacts | null
  /** Comparison baseline of the two compared columns; null when comparison is off. */
  readonly baseline: {
    readonly durationP50: number | null
    readonly tokensPerUnit: number | null
  } | null
}

// --- human gates ------------------------------------------------------------------

export interface ProcessPersonRow {
  readonly userId: string
  readonly decisions: number
  readonly comments: number
  readonly answers: number
  /** Ready-to-first-open; recorded only since launch. */
  readonly responseP50: number | null
}

export interface ProcessReviewStageRow {
  readonly stageKey: string
  readonly relatedStageKey: string | null
  readonly roundsPerUnit: number | null
  readonly durationMs: ProcessStat
  readonly commentsPerRound: number | null
  readonly firstPassRate: number | null
}

export interface ProcessReviewSummary {
  /** Closed, non-void rounds. */
  readonly rounds: number
  /** Rounds voided by an upstream refresh or a sibling's rejection; their wait still counts. */
  readonly voidRounds: number
  readonly durationMs: ProcessStat
  /** Ready to first open, and first open to decision; recorded only since launch. */
  readonly responseMs: ProcessStat
  readonly handlingMs: ProcessStat
  readonly roundsPerUnit: number | null
  readonly firstPassRate: number | null
  readonly commentsPerRound: number | null
  /** Mean over rounds with comments of comments ÷ people who commented. */
  readonly commentsPerCommenter: number | null
  readonly commentersPerRound: number | null
  /** Sent back to the next version being ready. */
  readonly reworkMs: ProcessStat
  readonly decisions: {
    readonly approved: number
    readonly iterated: number
    readonly rejected: number
  }
  readonly commentsByRound: readonly {
    readonly ordinal: number
    readonly rounds: number
    readonly comments: number
  }[]
  /** Multi-document reviews: accepted documents ÷ documents. */
  readonly documentAcceptRate: number | null
  readonly byStage: readonly ProcessReviewStageRow[]
  /** null when the viewer may not see per-person detail. */
  readonly people: readonly ProcessPersonRow[] | null
}

export interface ProcessAnswerMix {
  readonly recommended: number
  readonly other: number
  readonly custom: number
  readonly skipped: number
}

export interface ProcessClarifySummary {
  /** Answered rounds. */
  readonly rounds: number
  /** Canceled or abandoned rounds; never part of the answer time. */
  readonly voidRounds: number
  /** Units that asked at least once ÷ units. */
  readonly triggerRate: number | null
  readonly unitsAsking: number
  readonly roundsPerUnit: number | null
  readonly questionsPerRound: number | null
  readonly answerMs: ProcessStat
  readonly responseMs: ProcessStat
  readonly handlingMs: ProcessStat
  /** Rounds submitted with "stop asking". */
  readonly stopRate: number | null
  readonly answers: ProcessAnswerMix
  /** Answered questions that offered a recommendation: what `recommendedRate` is a share of. */
  readonly answersWithRecommendation: number
  /** Recommended answers ÷ answered questions that offered a recommendation. */
  readonly recommendedRate: number | null
  readonly byStage: readonly {
    readonly stageKey: string
    readonly askingStageKey: string | null
    readonly roundsPerUnit: number | null
  }[]
  readonly people: readonly ProcessPersonRow[] | null
}

export interface ProcessMindmapSummary {
  /** Submitted mindmaps. */
  readonly maps: number
  readonly depthMean: number | null
  readonly depthMax: number | null
  /** Mindmaps submitted per asking node in a unit. */
  readonly mapsPerNode: number | null
  readonly followupsPerMap: number | null
  readonly questionsPerMap: number | null
  readonly initialQuestionsPerMap: number | null
  readonly followupQuestionsPerMap: number | null
  readonly durationMs: ProcessStat
  /** Mean time and tokens of generating one follow-up. */
  readonly followupGenerationMs: number | null
  readonly followupGenerationTokens: number | null
  readonly maturity: {
    readonly decided: number
    readonly provisional: number
    readonly unmarked: number
    readonly skipped: number
  }
  /** Configured categories that received at least one question. */
  readonly categoryCoverage: number | null
}

// --- workgroup ----------------------------------------------------------------------

export interface ProcessWorkgroupRoundRow {
  readonly round: number
  /** Units that reached this round. */
  readonly units: number
  readonly assignmentsMean: number | null
  readonly durationMs: number | null
  readonly tokens: number | null
  readonly leaderTokenShare: number | null
}

export const PROCESS_MEMBER_ROLES = [
  'leader',
  'member-agent',
  'member-human',
  'unattributed',
] as const
export type ProcessMemberRole = (typeof PROCESS_MEMBER_ROLES)[number]

export interface ProcessWorkgroupMemberRow {
  readonly key: string
  readonly name: string | null
  readonly role: ProcessMemberRole
  /** The member's role description from the group, when it has one. */
  readonly roleNote: string | null
  readonly assignmentsPerUnit: number | null
  readonly durationMs: ProcessStat
  readonly tokensPerUnit: number | null
  readonly failureRate: number | null
  readonly protocolRetryRate: number | null
  readonly clarifyPerUnit: number | null
  /** Human members: assigned to delivered. */
  readonly deliveryMs: ProcessStat
}

export interface ProcessWorkgroupActorSlice {
  readonly actor: 'leader' | 'member' | 'system' | 'unattributed'
  readonly tokens: number
  readonly costNano: number
}

export interface ProcessDecisionGate {
  /** Closed gate spans. */
  readonly rounds: number
  readonly waitMs: ProcessStat
  readonly rejections: number
  readonly rejectRate: number | null
  /** Rounds run between a rejection and the next confirmation. */
  readonly extraRoundsAfterReject: number | null
}

export interface ProcessWorkgroupInterventions {
  /** Chat messages and direct assignments written by people. */
  readonly messagesPerUnit: number | null
  readonly directAssignmentsPerUnit: number | null
  readonly configChangesPerUnit: number | null
  readonly deliveryMs: ProcessStat
}

// --- digital employee ------------------------------------------------------------------

export interface ProcessEmployeeOutcomes {
  readonly merged: number
  readonly noChange: number
  readonly otherFinished: number
  readonly failed: number
}

export interface ProcessEmployeeRegion {
  readonly regionId: string
  readonly label: { readonly 'zh-CN': string; readonly 'en-US': string }
  readonly order: number
  readonly lanes: readonly {
    readonly laneId: string
    readonly label: { readonly 'zh-CN': string; readonly 'en-US': string }
    readonly order: number
    readonly kind: 'spine' | 'branch'
  }[]
}

export interface ProcessWorkItemRow {
  readonly key: string
  readonly label: { readonly 'zh-CN': string; readonly 'en-US': string } | string
  readonly kind: ProcessStageKind
  readonly regionId: string | null
  readonly laneId: string | null
  readonly order: number
  /** Declared by the employee type as rework. */
  readonly rework: boolean
  readonly units: number
  readonly roundsPerUnit: number | null
  /** Created to settled, queueing included. */
  readonly roundMs: ProcessStat
  readonly attemptsPerRound: number | null
  readonly tokensPerUnit: number | null
  readonly failureRate: number | null
  readonly autoRetryRate: number | null
  /** Human gates held at this work item. */
  readonly gateRoundsPerUnit: number | null
  readonly gateWaitMsPerUnit: number | null
}

export interface ProcessEmployeeCycle {
  /** Merged cases the split was computed from. */
  readonly sampleUnits: number
  /** Median time from assignment to the end of the first region's spine. */
  readonly beforeBoundaryMs: number | null
  readonly afterBoundaryMs: number | null
  readonly waitMs: number | null
  /** The work item that ends the first segment. */
  readonly boundaryKey: string | null
}

export interface ProcessEmployeeBlocked {
  /** Cases that were blocked at least once. */
  readonly units: number
  readonly perUnit: number | null
  readonly durationMs: ProcessStat
  /** Resume and terminate operations; recorded only since launch. */
  readonly resumes: number
  readonly terminations: number
  /** Reasons of cases blocked right now; a resolved block no longer has its reason. */
  readonly current: readonly { readonly reason: string; readonly units: number }[]
}

// --- subject summary -----------------------------------------------------------------

export interface ProcessCompareInfo {
  readonly mode: ProcessCompareMode
  readonly split: number | null
  /** Units of the baseline group. */
  readonly baselineUnits: number
}

interface ProcessSummaryBase {
  readonly asOf: number
  readonly from: number
  readonly to: number
  readonly subjectId: string | null
  /** null: the workflow no longer exists. */
  readonly subjectName: string | null
  /** `all`: every unit; `own`: units the viewer owns or takes part in. */
  readonly scope: 'all' | 'own'
  readonly note: ProcessDataNote
  readonly identities: readonly ProcessIdentity[]
  readonly compare: ProcessCompareInfo
  readonly counts: ProcessUnitCounts
  readonly metrics: Readonly<Partial<Record<ProcessMetricId, ProcessCompared>>>
  readonly time: ProcessTimeSplit
  readonly causes: readonly ProcessCauseSlice[]
  readonly interventions: ProcessInterventions
  readonly trend: readonly ProcessTrendPoint[]
  readonly stability: ProcessStability
  readonly hints: readonly ProcessHint[]
  /** Revisions seen in the window, newest first, for the "split at revision" control. */
  readonly revisions: readonly { readonly revision: number; readonly units: number }[]
}

export interface ProcessWorkflowSummary extends ProcessSummaryBase {
  readonly kind: 'workflow'
  readonly origins: readonly { readonly origin: ProcessOrigin; readonly units: number }[]
  readonly stages: readonly ProcessStageRow[]
  /** The newest unit's frozen definition, for the read-only canvas. */
  readonly definition: WorkflowDefinition | null
  readonly review: ProcessReviewSummary | null
  readonly clarify: ProcessClarifySummary | null
  readonly mindmap: ProcessMindmapSummary | null
}

export interface ProcessWorkgroupSummary extends ProcessSummaryBase {
  readonly kind: 'workgroup'
  /** Mode of the newest unit. */
  readonly mode: WorkgroupMode | null
  readonly actors: readonly ProcessWorkgroupActorSlice[]
  /** Leader-dispatch mode only. */
  readonly rounds: readonly ProcessWorkgroupRoundRow[]
  /** Free collaboration: member runs used against the configured limit. */
  readonly budget: { readonly usedMean: number | null; readonly limitMean: number | null } | null
  readonly assignmentSources: {
    readonly leader: number | null
    readonly human: number | null
    readonly self: number | null
  }
  /** Members; in dynamic-workflow mode one row per agent. */
  readonly members: readonly ProcessWorkgroupMemberRow[]
  readonly human: ProcessWorkgroupInterventions
  readonly completion: ProcessDecisionGate | null
  readonly planConfirm: ProcessDecisionGate | null
  readonly clarify: ProcessClarifySummary | null
  /** Clarify rounds per unit asked by the leader and by members. */
  readonly clarifyByAsker: {
    readonly leader: number | null
    readonly member: number | null
  } | null
}

export interface ProcessEmployeeSummary extends ProcessSummaryBase {
  readonly kind: 'digital-employee'
  /** The employee type and revision the responsibility map was read from (the newest case's). */
  readonly typeId: string | null
  readonly typeRevision: number | null
  readonly outcomes: ProcessEmployeeOutcomes
  readonly cycle: ProcessEmployeeCycle | null
  /** false: the employee type declares no rework work items, so first-pass is not computed. */
  readonly firstPassApplicable: boolean
  readonly regions: readonly ProcessEmployeeRegion[]
  readonly workItems: readonly ProcessWorkItemRow[]
  readonly review: ProcessReviewSummary | null
  /** null: the employee type does not provide human feedback. */
  readonly feedbackPerUnit: number | null
  readonly approvals: { readonly perUnit: number | null; readonly waitMs: ProcessStat }
  readonly blocked: ProcessEmployeeBlocked
}

export type ProcessSubjectSummary =
  | ProcessWorkflowSummary
  | ProcessWorkgroupSummary
  | ProcessEmployeeSummary

// --- subject listing ---------------------------------------------------------------------

export interface ProcessSubjectRow {
  readonly subjectId: string | null
  readonly name: string | null
  readonly units: number
  readonly successRate: number | null
  readonly leadP50: number | null
  /** Waiting for people ÷ lead time, over succeeded units. */
  readonly waitShare: number | null
  readonly tokensPerUnit: number | null
  readonly costNanoPerUnit: number | null
  readonly interventionsPerUnit: number | null
  readonly firstPassRate: number | null
  /** Workgroup only. */
  readonly mode: WorkgroupMode | null
  readonly roundsPerUnit: number | null
  readonly assignmentsPerUnit: number | null
  readonly coordinationShare: number | null
  /** Digital employee only. */
  readonly mergeRate: number | null
  readonly blockedRate: number | null
}

export interface ProcessSubjectList {
  readonly asOf: number
  readonly from: number
  readonly to: number
  readonly kind: ProcessSubjectKind
  readonly scope: 'all' | 'own'
  readonly partial: boolean
  readonly unitLimit: number
  readonly items: readonly ProcessSubjectRow[]
}

// --- units -----------------------------------------------------------------------------------

export interface ProcessUnitRow {
  readonly unitId: string
  /** The task to open; null for a digital employee's case. */
  readonly taskId: string | null
  readonly name: string
  readonly status: ProcessUnitStatus
  /** The raw task status, or the case's terminal kind. */
  readonly outcome: string
  readonly origin: ProcessOrigin
  readonly ownerUserId: string | null
  readonly revision: number | null
  readonly startedAt: number
  readonly endedAt: number | null
  /** To now for a unit that is still active. */
  readonly leadMs: number
  /** null: no running-time record. */
  readonly autoMs: number | null
  readonly waits: readonly { readonly kind: ProcessGateKind; readonly ms: number }[]
  readonly otherMs: number | null
  readonly tokens: number
  readonly costNano: number
  readonly usageLowerBound: boolean
  readonly unpriced: boolean
  readonly gateRounds: readonly { readonly kind: ProcessGateKind; readonly rounds: number }[]
  readonly autoRetries: number
  readonly manualRetries: number
  readonly firstPass: boolean | null
  /** Workgroup: rounds run, assignments made, and how the completion gate went. */
  readonly rounds: number | null
  readonly assignments: number | null
  readonly completionRejections: number | null
  readonly capped: boolean
  /** Digital employee: rounds of each rework work item. */
  readonly rework: readonly { readonly key: string; readonly rounds: number }[]
}

export interface ProcessUnitPage {
  readonly asOf: number
  readonly items: readonly ProcessUnitRow[]
  readonly nextCursor: string | null
  readonly identities: readonly ProcessIdentity[]
  /** Labels of the rework work items the rows refer to. */
  readonly stageLabels: Readonly<
    Record<string, string | { readonly 'zh-CN': string; readonly 'en-US': string }>
  >
}

export interface ProcessUnitStageRow {
  readonly key: string
  readonly label: string | { readonly 'zh-CN': string; readonly 'en-US': string }
  readonly kind: ProcessStageKind
  readonly parentKey: string | null
  readonly removed: boolean
  readonly runs: number
  readonly failedRuns: number
  readonly autoRetries: number
  readonly durationMs: number
  readonly tokens: number
  readonly gateRounds: number
  readonly gateWaitMs: number
  /** Review comments or clarify questions raised at this stage. */
  readonly comments: number
  readonly questions: number
}

export interface ProcessUnitDetail {
  readonly asOf: number
  readonly unit: ProcessUnitRow
  readonly stages: readonly ProcessUnitStageRow[]
  readonly identities: readonly ProcessIdentity[]
}

// --- text themes ---------------------------------------------------------------------------------

export const PROCESS_TEXT_SOURCES = [
  'review',
  'clarify',
  'workgroup-message',
  'workgroup-rejection',
  'employee-feedback',
] as const
export type ProcessTextSource = (typeof PROCESS_TEXT_SOURCES)[number]

export const PROCESS_INSIGHT_SCHEDULES = ['manual', 'weekly'] as const
export const ProcessInsightScheduleSchema = z.enum(PROCESS_INSIGHT_SCHEDULES)
export type ProcessInsightSchedule = z.infer<typeof ProcessInsightScheduleSchema>

/** Input limits of one analysis. */
export const PROCESS_INSIGHT_MAX_ITEMS = 400
export const PROCESS_INSIGHT_MAX_BYTES = 240_000
export const PROCESS_INSIGHT_ITEM_CHARS = 600
export const PROCESS_INSIGHT_MAX_THEMES = 6

export interface ProcessTheme {
  readonly name: string
  readonly items: number
  /** Share of the source's items. */
  readonly share: number
  readonly stages: readonly string[]
  /** Verbatim excerpts. */
  readonly quotes: readonly { readonly text: string; readonly unitId: string }[]
  readonly advice: string
}

export interface ProcessThemeGroup {
  readonly source: ProcessTextSource
  readonly items: number
  readonly truncated: boolean
  readonly themes: readonly ProcessTheme[]
  /** Items no theme claimed. */
  readonly otherItems: number
}

export interface ProcessInsightResult {
  readonly id: string
  readonly trigger: 'manual' | 'scheduled'
  readonly windowFrom: number
  readonly windowTo: number
  readonly finishedAt: number
  readonly groups: readonly ProcessThemeGroup[]
  /** Stage keys the themes refer to, with their names at analysis time. */
  readonly stageLabels: Readonly<
    Record<string, string | { readonly 'zh-CN': string; readonly 'en-US': string }>
  >
}

export interface ProcessInsightView {
  readonly asOf: number
  readonly scope: 'all' | 'own'
  readonly schedule: ProcessInsightSchedule
  /** The newest finished analysis the viewer may see. */
  readonly result: ProcessInsightResult | null
  /** An analysis that is queued or running. */
  readonly active: {
    readonly id: string
    readonly status: 'pending' | 'running'
    readonly requestedAt: number
  } | null
  /** The newest attempt failed after `result`. */
  readonly failure: { readonly code: string; readonly message: string; readonly at: number } | null
  /** New text has appeared since `result`. */
  readonly stale: boolean
}

export interface ProcessInsightAccepted {
  readonly id: string
  /** `empty`: there is nothing to analyse, so nothing was queued. */
  readonly status: 'pending' | 'running' | 'empty'
}

/** What the model must return; every number is computed by the platform. */
export const ProcessInsightModelOutputSchema = z.object({
  groups: z
    .array(
      z.object({
        source: z.string(),
        themes: z
          .array(
            z.object({
              name: z.string().trim().min(1),
              itemIds: z.array(z.string()).default([]),
              advice: z.string().default(''),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
})
export type ProcessInsightModelOutput = z.infer<typeof ProcessInsightModelOutputSchema>
