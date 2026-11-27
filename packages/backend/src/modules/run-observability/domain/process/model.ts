// RFC-616 §4 — the one model every process metric is computed from.
//
// A workflow task, a workgroup task and a digital employee's case are all a
// *unit*; a canvas node, a workgroup member and a work item are all a *stage*.
// The assemblers of the three subject kinds turn their facts into these types;
// nothing below this file knows which kind it is looking at.

import type {
  ProcessCause,
  ProcessGateKind,
  ProcessOperationAction,
  ProcessOperationSubjectKind,
  ProcessOrigin,
  ProcessStageKind,
  ProcessUnitStatus,
} from '@agent-workflow/shared'
import type { ProcessGateMeasure } from '@/platform/contracts/processFacts'

export type ProcessLabel = string | { readonly 'zh-CN': string; readonly 'en-US': string }

/** One run of a subject. */
export interface ProcessUnit {
  readonly id: string
  /** The task a reader can open; null for a digital employee's case. */
  readonly taskId: string | null
  readonly subjectId: string | null
  readonly subjectRevision: number | null
  readonly name: string
  readonly status: ProcessUnitStatus
  /** Raw task status, or the case's terminal kind. */
  readonly outcome: string
  readonly origin: ProcessOrigin
  readonly ownerUserId: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  /** Time spent executing; null when the unit has no running-time record. */
  readonly autoMs: number | null
  /** Canceled because it exceeded its time or token limit. */
  readonly limitCanceled: boolean
}

export interface ProcessStage {
  readonly key: string
  readonly label: ProcessLabel
  readonly kind: ProcessStageKind
  readonly parentKey: string | null
  readonly order: number
  /** Executed by some unit but absent from the newest definition. */
  readonly removed: boolean
}

/** Executions of one stage for one cause inside one unit. */
export interface ProcessExecution {
  readonly stageKey: string
  readonly cause: ProcessCause
  /** Workgroup round; null elsewhere. */
  readonly round: number | null
  readonly runs: number
  readonly endedRuns: number
  readonly failedRuns: number
  readonly interruptedRuns: number
  readonly activeMs: number
}

/** Failed executions of one stage by failure code inside one unit. */
export interface ProcessFailureCode {
  readonly stageKey: string
  readonly code: string
  readonly runs: number
}

/** A span a unit spent waiting for a person. */
export interface ProcessGateRound {
  readonly stageKey: string
  /** The reviewed stage, or the stage that asked. */
  readonly relatedStageKey: string | null
  readonly kind: ProcessGateKind
  /** What human operations are recorded against; null when nothing is. */
  readonly subject: { readonly kind: ProcessOperationSubjectKind; readonly id: string } | null
  /** Rounds of one instance are numbered together. */
  readonly instanceKey: string
  /** 1-based among the instance's valid rounds; 0 for a void round. */
  readonly ordinal: number
  /** Counts toward waiting time only. */
  readonly void: boolean
  /**
   * The round happened in a task this unit called. It is part of the unit's
   * waiting time and of its human interventions, but the gate statistics of
   * the subject describe its own gates only.
   */
  readonly inherited?: boolean
  readonly openedAt: number
  readonly closedAt: number | null
  readonly outcome: string | null
  readonly deciderUserId: string | null
  /** Workgroup: the round the gate was opened in. */
  readonly round?: number | null
  readonly mindmap: boolean
  readonly measures: Readonly<Partial<Record<ProcessGateMeasure, number>>>
  readonly people: readonly {
    readonly userId: string
    readonly comments: number
    readonly answers: number
  }[]
  /** A mindmap round: the top-level categories its questions fall under. */
  readonly categories?: readonly string[]
}

/** Tokens of one stage for one cause inside one unit. */
export interface ProcessUsageSlice {
  readonly stageKey: string
  readonly cause: ProcessCause
  readonly tokens: number
  readonly costNano: number
}

export interface ProcessUsageTotals {
  readonly calls: number
  readonly tokens: number
  readonly costNano: number
  /** Calls whose usage is a lower bound. */
  readonly incompleteCalls: number
  readonly unpricedCalls: number
}

export const NO_USAGE: ProcessUsageTotals = {
  calls: 0,
  tokens: 0,
  costNano: 0,
  incompleteCalls: 0,
  unpricedCalls: 0,
}

/** Something a person did, recorded by the route registry. */
export interface ProcessOperation {
  readonly action: ProcessOperationAction
  readonly subjectKind: ProcessOperationSubjectKind
  readonly subjectId: string
  readonly actorUserId: string
  readonly firstAt: number
  readonly lastAt: number
}

/** One invocation of a loop or fan-out wrapper. */
export interface ProcessWrapperRun {
  readonly stageKey: string
  readonly status: string
  readonly rounds: number
  readonly shards: number
  /** Start to finish of the invocation; null while it has not finished. */
  readonly durationMs: number | null
}

/** Everything known about one unit. */
export interface ProcessUnitFacts {
  readonly unit: ProcessUnit
  readonly executions: readonly ProcessExecution[]
  readonly failureCodes: readonly ProcessFailureCode[]
  readonly gates: readonly ProcessGateRound[]
  readonly usage: readonly ProcessUsageSlice[]
  readonly usageTotals: ProcessUsageTotals
  /** false: the unit started before the first recorded runtime call. */
  readonly hasUsageRecord: boolean
  readonly operations: readonly ProcessOperation[]
  /** Manual retries: placeholders in the ledger, or recorded retry operations where those are more. */
  readonly manualRetries: number
  /** Wrapper invocations that ended failed or exhausted: failures no leaf execution shows. */
  readonly failedWrappers: number
  /** Executions whose cause was never recorded. */
  readonly runsWithoutCause: number
  readonly wrappers: readonly ProcessWrapperRun[]
  /**
   * Set by subject kinds that judge first-pass themselves (digital employee);
   * `undefined` lets the generic rule decide, `null` means not applicable.
   */
  readonly firstPassOverride?: boolean | null
}

/**
 * Operations a unit's "human interventions" count besides gate rounds and manual retries.
 * Resuming a digital-employee case is not among them: only a blocked case can be resumed, so
 * every resume closes a blocked round, and that round is already the intervention.
 */
export const INTERVENTION_ACTIONS: ReadonlySet<ProcessOperationAction> = new Set([
  'task.resume',
  'task.repair',
  'task.sync-workflow',
  'task.cancel',
  'employee-case.terminate',
])

/** Operations the stability block counts as resume / repair. */
export const RECOVERY_ACTIONS: ReadonlySet<ProcessOperationAction> = new Set([
  'task.resume',
  'task.repair',
  'employee-case.resume',
])

export function unitEnded(unit: ProcessUnit): boolean {
  return unit.status !== 'active'
}

export function tokensOfUsage(row: {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
}): number {
  return row.input + row.cacheRead + row.cacheWrite + row.output
}
