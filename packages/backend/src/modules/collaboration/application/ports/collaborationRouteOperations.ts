import type {
  ClarifyAnswer,
  ClarifyDirective,
  ClarifyDraftValue,
  ClarifyRound,
  ClarifyRoundSummary,
  DocVersion,
  DocVersionWithBodyAndComments,
  PatPurpose,
  Permission,
  ReviewAnchorRequest,
  ReviewAnchorWarning,
  ReviewAuthorRole,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewDetail,
  ReviewRoundSummary,
  ReviewSummary,
  Role,
  TaskActorRole,
  TaskQuestionPhase,
} from '@agent-workflow/shared'
import type {
  CollaborationClarifyTaskAccessDecision,
  CollaborationNodeRunTaskAccessDecision,
  CollaborationTaskAccessDecision,
} from './collaborationTaskAccess'
import type {
  SubmitReviewDecisionCommandInput,
  SubmitReviewDecisionCommandResult,
} from './reviewDecisionCommand'
import type {
  DispatchTaskQuestionsCommandInput,
  DispatchTaskQuestionsCommandResult,
} from './questionDispatchCommand'
import type {
  SubmitClarifyDecisionCommandInput,
  SubmitClarifyDecisionCommandResult,
} from './clarifyDecisionCommand'
import type { ReviewAccessDecision } from '../../domain/reviewAccess'

/**
 * Route-owned projection of the authenticated actor.  Keeping this structural
 * contract here lets the collaboration application layer serve HTTP without
 * importing the auth or route layers.
 */
export interface CollaborationRouteActor {
  readonly user: Readonly<{
    id: string
    username: string
    displayName: string
    role: Role
    status: 'active' | 'disabled' | 'invited'
  }>
  readonly source: 'session' | 'pat' | 'daemon'
  readonly permissions: ReadonlySet<Permission>
  readonly purpose?: PatPurpose
  readonly patId?: string
  readonly authorityRevision?: number
}

export interface CollaborationTaskQuestionView {
  readonly id: string
  readonly taskId: string
  readonly originNodeRunId: string | null
  readonly questionId: string
  readonly questionTitle: string
  readonly sourceKind: 'self' | 'cross' | 'manual'
  readonly roleKind: 'self' | 'questioner' | 'designer'
  readonly sourceNodeId: string | null
  readonly defaultTargetNodeId: string | null
  readonly overrideTargetNodeId: string | null
  readonly effectiveTargetNodeId: string | null
  readonly phase: TaskQuestionPhase
  readonly confirmation: 'open' | 'confirmed'
  readonly confirmedBy: string | null
  readonly staged: boolean
  readonly autoDispatchDeferred: boolean
  readonly sealed: boolean
  readonly reopenCount: number
  readonly answerSummary: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ReviewCommentWriteAuthority {
  readonly actorUserId: string
  readonly role: ReviewAuthorRole
  readonly resourceAclBypass?: boolean
}

export interface AddReviewCommentInput {
  readonly appHome: string
  readonly nodeRunId: string
  readonly anchor?: ReviewCommentAnchor
  readonly anchorRequest?: ReviewAnchorRequest
  readonly commentText: string
  readonly author: string
  readonly authorRole: ReviewAuthorRole
  readonly docVersionId?: string
}

export interface AddedReviewComment extends ReviewComment {
  readonly warnings: readonly ReviewAnchorWarning[]
}

export interface ListReviewSummariesInput {
  readonly status?: 'pending' | 'all' | 'approved' | 'rejected' | 'iterated'
  readonly taskId?: string
  readonly workflowId?: string
  readonly limit?: number
  readonly unbounded?: boolean
}

export interface ListClarifySummariesInput {
  readonly taskId?: string
  readonly kind?: 'self' | 'cross' | 'all'
  readonly status?: 'awaiting_human' | 'answered' | 'canceled' | 'abandoned' | 'all'
  readonly limit?: number
}

export interface SaveClarifyDraftInput {
  readonly intermediaryNodeRunId: string
  readonly roundId: string
  readonly questionId: string
  readonly value: ClarifyDraftValue
  readonly editor: Readonly<{
    userId: string
    displayName: string
    role: TaskActorRole
  }>
}

export interface SaveClarifyDraftResult {
  readonly roundId: string
  readonly questionId: string
  readonly updatedAt: number
}

export interface CollaborationClarifyDraftEventPublisher {
  publish(input: {
    readonly taskId: string
    readonly nodeRunId: string
    readonly roundId: string
    readonly questionId: string
    readonly editor: SaveClarifyDraftInput['editor']
    readonly occurredAt: number
  }): Promise<void>
}

export interface SealClarifyQuestionsInput {
  readonly originNodeRunId: string
  readonly answers: readonly ClarifyAnswer[]
  readonly sealedBy?: string
  readonly sealedByRole?: TaskActorRole
  readonly directive?: ClarifyDirective
  readonly autoStage?: boolean
  readonly allowResealFor?: readonly string[]
}

export interface SealClarifyQuestionsResult {
  readonly sealedQuestionIds: readonly string[]
  readonly resealedQuestionIds: readonly string[]
  readonly roundFullySealed: boolean
}

export type ReassignTaskQuestionAction = 'added-designer' | 'removed-designer' | 'moved-manual'

/**
 * Closed route-facing collaboration contract.  Every method is asynchronous
 * for SQLite/PostgreSQL parity; transport callers never receive a database
 * client or a provider-specific row.
 */
export interface CollaborationRouteOperations {
  readonly access: Readonly<{
    resolveTask(input: {
      readonly actor: CollaborationRouteActor
      readonly taskId: string
    }): Promise<CollaborationTaskAccessDecision>
    resolveNodeRunTask(input: {
      readonly actor: CollaborationRouteActor
      readonly nodeRunId: string
    }): Promise<CollaborationNodeRunTaskAccessDecision>
    resolveClarifyTask(input: {
      readonly actor: CollaborationRouteActor
      readonly intermediaryNodeRunId: string
    }): Promise<CollaborationClarifyTaskAccessDecision>
    visibleTaskIds(input: {
      readonly actor: CollaborationRouteActor
      readonly taskIds: readonly string[]
    }): Promise<ReadonlySet<string>>
    questionTaskId(entryId: string): Promise<string | null>
    resolveReview(input: {
      readonly actor: CollaborationRouteActor
      readonly nodeRunId: string
    }): Promise<ReviewAccessDecision | null>
    filterReviewSummaries(input: {
      readonly actor: CollaborationRouteActor
      readonly rows: readonly ReviewSummary[]
    }): Promise<readonly (ReviewSummary & { readonly accessScope: 'task' | 'review-node' })[]>
  }>
  readonly reviews: Readonly<{
    list(input: ListReviewSummariesInput): Promise<readonly ReviewSummary[]>
    countPending(actor: CollaborationRouteActor): Promise<number>
    detail(input: {
      readonly appHome: string
      readonly nodeRunId: string
    }): Promise<Omit<ReviewDetail, 'capabilities'>>
    listVersions(nodeRunId: string): Promise<readonly DocVersion[]>
    versionDetail(input: {
      readonly appHome: string
      readonly nodeRunId: string
      readonly versionId: string
    }): Promise<DocVersionWithBodyAndComments | null>
    listRounds(input: {
      readonly appHome: string
      readonly nodeRunId: string
    }): Promise<readonly ReviewRoundSummary[]>
    setSelection(input: {
      readonly nodeRunId: string
      readonly docVersionId: string
      readonly selection: 'accepted' | 'not_accepted'
    }): Promise<{
      readonly taskId: string
      readonly docVersionId: string
      readonly selection: 'accepted' | 'not_accepted'
    }>
    addComment(input: AddReviewCommentInput): Promise<AddedReviewComment>
    updateComment(input: {
      readonly nodeRunId: string
      readonly commentId: string
      readonly commentText: string
      readonly authority: ReviewCommentWriteAuthority
    }): Promise<ReviewComment>
    deleteComment(input: {
      readonly nodeRunId: string
      readonly commentId: string
      readonly authority: ReviewCommentWriteAuthority
    }): Promise<void>
    submitDecision(
      input: SubmitReviewDecisionCommandInput,
    ): Promise<SubmitReviewDecisionCommandResult>
  }>
  readonly questions: Readonly<{
    list(input: {
      readonly taskId: string
      readonly sourceNodeId?: string
      readonly phase?: TaskQuestionPhase
    }): Promise<readonly CollaborationTaskQuestionView[]>
    createManual(input: {
      readonly taskId: string
      readonly title: string
      readonly body: string
      readonly targetNodeId: string | null
      readonly actor: Readonly<{ userId: string; role: TaskActorRole }>
    }): Promise<Readonly<{ id: string }>>
    confirm(input: {
      readonly entryId: string
      readonly actor: Readonly<{ userId: string; role: TaskActorRole }>
    }): Promise<void>
    reassign(input: {
      readonly entryId: string
      readonly targetNodeId: string
      readonly actor: Readonly<{ userId: string; role: TaskActorRole }>
    }): Promise<ReassignTaskQuestionAction>
    stage(input: {
      readonly entryId: string
      readonly staged: boolean
      readonly actor: Readonly<{ userId: string; role: TaskActorRole }>
    }): Promise<void>
    dispatch(input: DispatchTaskQuestionsCommandInput): Promise<DispatchTaskQuestionsCommandResult>
  }>
  readonly clarify: Readonly<{
    list(input: ListClarifySummariesInput): Promise<readonly ClarifyRoundSummary[]>
    countPending(actor: CollaborationRouteActor): Promise<number>
    detail(intermediaryNodeRunId: string): Promise<ClarifyRound>
    seal(input: SealClarifyQuestionsInput): Promise<SealClarifyQuestionsResult>
    saveDraft(input: SaveClarifyDraftInput): Promise<SaveClarifyDraftResult>
    submitDecision(
      input: SubmitClarifyDecisionCommandInput,
    ): Promise<SubmitClarifyDecisionCommandResult>
  }>
}

export type CollaborationRoutePersistenceOperations = Readonly<{
  reviews: Omit<CollaborationRouteOperations['reviews'], 'submitDecision'>
  questions: Omit<CollaborationRouteOperations['questions'], 'dispatch'>
  clarify: Omit<CollaborationRouteOperations['clarify'], 'submitDecision'>
}>
