import type { ProcessSubjectKind, ProcessThemeGroup } from '@agent-workflow/shared'
import type { ProcessLabel } from '../../../domain/process/model'

export type InsightScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'user'; readonly userId: string }

export interface InsightSubject {
  readonly kind: ProcessSubjectKind
  /** null: units without a source id. */
  readonly id: string | null
  readonly name: string | null
}

export interface InsightInput {
  readonly sources: readonly {
    readonly source: string
    readonly items: number
    readonly truncated: boolean
  }[]
  /** Time of the newest text the analysis read; null when it read nothing. */
  readonly newestAt: number | null
}

export interface InsightResultDocument {
  readonly groups: readonly ProcessThemeGroup[]
  readonly stageLabels: Readonly<Record<string, ProcessLabel>>
}

export interface InsightAnalysis {
  readonly id: string
  readonly subject: InsightSubject
  readonly scope: InsightScope
  readonly windowFrom: number
  readonly windowTo: number
  readonly trigger: 'manual' | 'scheduled'
  readonly requestedBy: string | null
  readonly status: 'pending' | 'running' | 'done' | 'failed'
  readonly input: InsightInput | null
  readonly result: InsightResultDocument | null
  readonly errorCode: string | null
  readonly errorMessage: string | null
  readonly createdAt: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
}

export interface NewInsightAnalysis {
  readonly id: string
  readonly subject: InsightSubject
  readonly scope: InsightScope
  readonly windowFrom: number
  readonly windowTo: number
  readonly trigger: 'manual' | 'scheduled'
  readonly requestedBy: string | null
  readonly createdAt: number
}

/** How many analyses of one subject and scope are kept. */
export const INSIGHT_KEEP = 5

/** RFC-616 §9/§10.2 — text-theme analyses: a small job queue and its results. */
export interface InsightStore {
  /** The queued or running analysis of this subject and scope, if any. */
  active(subject: InsightSubject, scope: InsightScope): Promise<InsightAnalysis | null>
  /** Newest first. */
  recent(
    subject: InsightSubject,
    scope: InsightScope,
    limit: number,
  ): Promise<readonly InsightAnalysis[]>
  /** The newest successful analysis, however many attempts came after it. */
  lastDone(subject: InsightSubject, scope: InsightScope): Promise<InsightAnalysis | null>
  insert(analysis: NewInsightAnalysis): Promise<void>
  /** Claim the oldest pending analysis; null when the queue is empty. */
  claimNext(at: number): Promise<InsightAnalysis | null>
  finish(
    id: string,
    outcome:
      | {
          readonly status: 'done'
          readonly input: InsightInput
          readonly result: InsightResultDocument
        }
      | {
          readonly status: 'failed'
          readonly input: InsightInput | null
          readonly errorCode: string
          readonly errorMessage: string
        },
    at: number,
  ): Promise<void>
  /** Analyses left running by a previous daemon can no longer finish. */
  failRunning(errorCode: string, errorMessage: string, at: number): Promise<number>
  /**
   * Drop all but the newest INSIGHT_KEEP analyses of this subject and scope. The newest
   * successful one is kept whatever its age: failures must not erase the last good result.
   */
  prune(subject: InsightSubject, scope: InsightScope): Promise<void>
  /** Finish time of the newest scheduled-scope (`all`) analysis per subject of one kind. */
  lastScheduled(kind: ProcessSubjectKind): Promise<ReadonlyMap<string, number>>
}
