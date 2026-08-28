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
  requireCollaborationAppHome,
  requireClarifyDecisionCommand,
  requireQuestionDispatchCommand,
  requireReviewDecisionCommand,
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
import { FsHumanGateArtifactStore } from '../infrastructure/fsHumanGateArtifactStore'
import { SqliteClarifyQuestionSnapshotReader } from '../infrastructure/sqliteClarifyQuestionSnapshotReader'
import { SqliteHumanGateOperationStore } from '../infrastructure/sqliteHumanGateOperationStore'
import { SqliteManualQuestionOpenWriter } from '../infrastructure/sqliteManualQuestionOpenWriter'
import type { CollaborationCommandContext } from './types'
import type { Actor } from '@/auth/actor'
import type {
  ReplaceReviewNodeReviewersBody,
  ReviewNodeReviewerConfig,
} from '@agent-workflow/shared'
import { replaceReviewNodeReviewers as replaceReviewNodeReviewersInternal } from '../application/reviewNodeReviewers'
import { reviewNodeReviewerDependencies } from '../composition/reviewNodeReviewerDependencies'

export function replaceReviewNodeReviewers(
  context: CollaborationCommandContext,
  input: {
    readonly actor: Actor
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
): ReviewGateOpenReceipt {
  const result = new ReviewGateOpenPreparation(
    resolveCollaborationCommandContext(context).db,
    new SqliteHumanGateOperationStore(),
    new FsHumanGateArtifactStore(requireCollaborationAppHome(context)),
  ).prepare(input)
  const common = {
    operationId: result.operation.id,
    documentIds: result.manifest.documents.map((document) => document.id),
    nodeRunId: result.manifest.node.id,
  }
  return result.kind === 'prepared'
    ? { kind: result.kind, ...common, prepared: result.prepared }
    : { kind: result.kind, ...common }
}

export function prepareClarifyGateOpen(
  context: CollaborationCommandContext,
  input: PrepareClarifyGateOpenInput,
): ClarifyGateOpenReceipt {
  const result = new ClarifyGateOpenPreparation(
    resolveCollaborationCommandContext(context).db,
    new SqliteHumanGateOperationStore(),
    new SqliteClarifyQuestionSnapshotReader(),
  ).prepare(input)
  const common = {
    operationId: result.operation.id,
    roundId: result.manifest.round.id,
    nodeRunId: result.manifest.node.id,
  }
  return result.kind === 'prepared'
    ? { kind: result.kind, ...common, prepared: result.prepared }
    : { kind: result.kind, ...common }
}

export function createManualQuestionOpen(
  context: CollaborationCommandContext,
  input: CreateManualQuestionOpenInput,
): ManualQuestionOpenReceipt {
  const result = new ManualQuestionOpenCreation(
    new SqliteManualQuestionOpenWriter(
      resolveCollaborationCommandContext(context).db,
      new SqliteHumanGateOperationStore(),
    ),
  ).create(input)
  return { questionId: result.id, operationId: result.operation.id }
}

export function finalizeCommittedHumanGate(
  context: CollaborationCommandContext,
  input: {
    readonly operationId: string
    readonly now?: number
  },
): void {
  new CommittedHumanGateFinalizer(
    resolveCollaborationCommandContext(context).db,
    new SqliteHumanGateOperationStore(),
    new FsHumanGateArtifactStore(requireCollaborationAppHome(context)),
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
