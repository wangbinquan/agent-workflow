// RFC-333 public collaboration commands. Command context is opaque; public
// inputs contain business data only and results are narrow receipts.

import {
  ManualQuestionOpenCreation,
  type CreateManualQuestionOpenInput,
} from '../application/createManualQuestionOpen'
import {
  ClarifyGateOpenPreparation,
  type PrepareClarifyGateOpenInput,
} from '../application/prepareClarifyGateOpen'
import { CommittedHumanGateFinalizer } from '../application/finalizeCommittedHumanGate'
import {
  ReviewGateOpenPreparation,
  type PrepareReviewGateOpenInput,
} from '../application/prepareReviewGateOpen'
import {
  requireHumanGateArtifactStore,
  requireClarifyDirectiveStore,
  requireClarifyDecisionCommand,
  requireQuestionDispatchCommand,
  requireReviewDecisionCommand,
  requireReviewTaskAccess,
  requireTaskFeedbackStore,
  resolveCollaborationCommandContext,
} from '../composition/commandContext'
import type {
  SubmitReviewDecisionCommandInput,
  SubmitReviewDecisionCommandResult,
} from '../application/ports/reviewDecisionCommand'
import type {
  DispatchTaskQuestionsCommandInput,
  DispatchTaskQuestionsCommandResult,
} from '../application/ports/questionDispatchCommand'
import type {
  SubmitClarifyDecisionCommandInput,
  SubmitClarifyDecisionCommandResult,
} from '../application/ports/clarifyDecisionCommand'
import type { PreparedHumanGateRef } from '../domain/humanGateOperation'
import type { CollaborationCommandContext, ReviewActor } from './types'
import type {
  ReplaceReviewNodeReviewersBody,
  ReviewNodeReviewerConfig,
} from '@agent-workflow/shared'
import { replaceReviewNodeReviewers as replaceReviewNodeReviewersInternal } from '../application/reviewNodeReviewers'
import { reviewNodeReviewerDependencies } from '../composition/reviewNodeReviewerDependencies'
import { TaskFeedbackService } from '../application/taskFeedback'
import type { MemoryDistillEnqueuer } from '@/modules/memory/public/participants'
import type { ClarifyDirective } from '@agent-workflow/shared'

export function replaceReviewNodeReviewers(
  context: CollaborationCommandContext,
  input: {
    readonly actor: ReviewActor
    readonly taskId: string
    readonly body: ReplaceReviewNodeReviewersBody
  },
): Promise<ReviewNodeReviewerConfig> {
  return replaceReviewNodeReviewersInternal(
    reviewNodeReviewerDependencies(context),
    input.actor,
    input.taskId,
    input.body,
  )
}

export function createTaskFeedback(
  context: CollaborationCommandContext,
  input: {
    readonly actor: ReviewActor
    readonly taskId: string
    readonly bodyMd: string
  },
  memoryDistillEnqueuer: MemoryDistillEnqueuer,
) {
  return new TaskFeedbackService(
    requireTaskFeedbackStore(context),
    requireReviewTaskAccess(context),
  ).create(input, memoryDistillEnqueuer)
}

export {
  canonicalHumanGateJson,
  canonicalHumanGateRequestHash,
  deriveHumanGateCompatibilityKey,
} from '../domain/canonicalGateRequest'
export { encodeGateDecisionReceipt, gateDecisionReceipt } from '../domain/gateReceipt'
export { preparedHumanGateRef } from '../domain/humanGateOperation'

export type ReviewGateOpenReceipt =
  | Readonly<{
      kind: 'prepared'
      operationId: string
      prepared: PreparedHumanGateRef
      documentIds: readonly string[]
      nodeRunId: string
    }>
  | Readonly<{
      kind: 'already-committed'
      operationId: string
      documentIds: readonly string[]
      nodeRunId: string
    }>

export type ClarifyGateOpenReceipt =
  | Readonly<{
      kind: 'prepared'
      operationId: string
      prepared: PreparedHumanGateRef
      roundId: string
      nodeRunId: string
    }>
  | Readonly<{
      kind: 'already-committed'
      operationId: string
      roundId: string
      nodeRunId: string
    }>

export type ManualQuestionOpenReceipt = Readonly<{
  questionId: string
  operationId: string
}>

export function prepareReviewGateOpen(
  context: CollaborationCommandContext,
  input: PrepareReviewGateOpenInput,
): Promise<ReviewGateOpenReceipt> {
  const dependencies = resolveCollaborationCommandContext(context)
  const result = new ReviewGateOpenPreparation(
    dependencies.persistence.operations,
    requireHumanGateArtifactStore(context),
  ).prepare(input)
  return result.then((prepared) => {
    const common = {
      operationId: prepared.operation.id,
      documentIds: prepared.manifest.documents.map((document) => document.id),
      nodeRunId: prepared.manifest.node.id,
    }
    return prepared.kind === 'prepared'
      ? { kind: prepared.kind, ...common, prepared: prepared.prepared }
      : { kind: prepared.kind, ...common }
  })
}

export function prepareClarifyGateOpen(
  context: CollaborationCommandContext,
  input: PrepareClarifyGateOpenInput,
): Promise<ClarifyGateOpenReceipt> {
  const dependencies = resolveCollaborationCommandContext(context)
  const result = new ClarifyGateOpenPreparation(
    dependencies.persistence.operations,
    dependencies.persistence.clarifyQuestions,
  ).prepare(input)
  return result.then((prepared) => {
    const common = {
      operationId: prepared.operation.id,
      roundId: prepared.manifest.round.id,
      nodeRunId: prepared.manifest.node.id,
    }
    return prepared.kind === 'prepared'
      ? { kind: prepared.kind, ...common, prepared: prepared.prepared }
      : { kind: prepared.kind, ...common }
  })
}

export function createManualQuestionOpen(
  context: CollaborationCommandContext,
  input: CreateManualQuestionOpenInput,
): Promise<ManualQuestionOpenReceipt> {
  const result = new ManualQuestionOpenCreation(
    resolveCollaborationCommandContext(context).persistence.manualQuestions,
  ).create(input)
  return result.then((created) => ({
    questionId: created.id,
    operationId: created.operation.id,
  }))
}

export function finalizeCommittedHumanGate(
  context: CollaborationCommandContext,
  input: {
    readonly operationId: string
    readonly now?: number
  },
): Promise<void> {
  const dependencies = resolveCollaborationCommandContext(context)
  return new CommittedHumanGateFinalizer(
    dependencies.persistence.operations,
    requireHumanGateArtifactStore(context),
  ).finalize(input)
}

/** RFC-333 T8: the sole REST/MCP-facing review decision command. */
export async function submitReviewDecision(
  context: CollaborationCommandContext,
  input: SubmitReviewDecisionCommandInput,
): Promise<SubmitReviewDecisionCommandResult> {
  return requireReviewDecisionCommand(context).submit(input)
}

/** RFC-333 T9: the sole REST/MCP-facing task-question dispatch command. */
export async function dispatchTaskQuestions(
  context: CollaborationCommandContext,
  input: DispatchTaskQuestionsCommandInput,
): Promise<DispatchTaskQuestionsCommandResult> {
  return requireQuestionDispatchCommand(context).dispatch(input)
}

/** RFC-333 T9: the sole REST/MCP-facing quick clarify decision command. */
export async function submitClarifyDecision(
  context: CollaborationCommandContext,
  input: SubmitClarifyDecisionCommandInput,
): Promise<SubmitClarifyDecisionCommandResult> {
  return requireClarifyDecisionCommand(context).submit(input)
}

export function setCollaborationClarifyDirective(
  context: CollaborationCommandContext,
  input: {
    readonly taskId: string
    readonly nodeId: string
    readonly directive: ClarifyDirective
    readonly setBy: string | null
    readonly shardKey?: string | null
  },
): Promise<void> {
  return requireClarifyDirectiveStore(context).set(input)
}
