import type {
  GraphAnchor,
  GraphImplementationBasis,
  GraphSource,
  RepositoryContentBaseline,
} from '@agent-workflow/shared'
import type { GraphArtifactReference } from './graphDesignArtifacts'

export interface GraphCaseSnapshot {
  readonly caseId: string
  readonly employeeId: string
  readonly state: 'active' | 'waiting' | 'blocked' | 'terminal'
  readonly workItemRef: string | null
  readonly executionRef: string | null
  readonly editableClarify: { readonly taskId: string; readonly roundId: string } | null
}
/** Case remains the only business work owner. Requests use its existing event intake. */
export interface GraphDesignCasePort {
  inspect(caseId: string): Promise<GraphCaseSnapshot>
  requestWork(input: {
    readonly caseId: string
    readonly requestId: string
    readonly kind: 'review' | 'implementation' | 'clarification' | 'verification'
    readonly payloadRef: GraphArtifactReference
    readonly withdrawReview: boolean
  }): Promise<{ readonly eventId: string; readonly caseId: string; readonly queued: boolean }>
  followOn(input: {
    readonly caseId: string
    readonly requestId: string
    readonly body: string
    readonly artifactRef: GraphArtifactReference
  }): Promise<{ readonly caseId: string }>
}

export interface GraphCommittedArtifact {
  readonly taskId: string
  readonly nodeRunId: string
  readonly outputPort: string
  readonly digest: string
  readonly content: string
}
export interface GraphReviewReceipt {
  readonly id: string
  readonly caseId: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly basisDigest: string
  readonly decision: 'approved' | 'rejected' | 'iterated'
  readonly reason: string
  readonly decidedAt: number
}
/** These are reads of committed owner records; this port cannot mint or settle Task / NodeRun. */
export interface GraphDesignExecutionPort {
  committedArtifacts(input: {
    readonly caseId: string
    readonly executionRef: string
  }): Promise<readonly GraphCommittedArtifact[]>
  humanSources(input: {
    readonly caseId: string
    readonly sources: readonly GraphSource[]
  }): Promise<readonly GraphSource[]>
  reviewReceipt(input: {
    readonly caseId: string
    readonly executionRef: string
    readonly basisDigest: string
  }): Promise<GraphReviewReceipt | null>
  assertMaterialsReadable(input: {
    readonly caseId: string
    readonly basis: GraphImplementationBasis
    readonly artifact: GraphArtifactReference
  }): Promise<void>
  resolveRepositoryBaseline(input: {
    readonly caseId: string
    readonly repositoryId: string
  }): Promise<RepositoryContentBaseline>
  /** An explicit new preview may adopt the current MR source head as a new semantic basis. */
  resolveImplementationBaseline?(input: {
    readonly caseId: string
    readonly designId: string
    readonly repositoryId: string
  }): Promise<RepositoryContentBaseline | null>
}

export interface GraphClarificationRequest {
  readonly requestId: string
  readonly expectedRevision: number
  readonly instruction: string
  readonly anchor: GraphAnchor | null
  readonly previousSourceIds: readonly string[]
  readonly withdrawReview: boolean
}
