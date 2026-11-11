// RFC-480 —— collaboration 命令的入口函数（原直接声明在 `public/commands.ts`：评审 / 反问人工门的准备与提交后收尾、手动提问、
// 评审 / 反问决定、问题派发、反问指令写入）。它们模块外零消费，只被本模块的 composition / infrastructure / application 适配器调用，
// 按 RFC-294 常驻规则 12 撤出 public；函数体只取命令上下文与 application 用例类，按内容（C10）归 application。函数体原样迁来。
import type { PreparedHumanGateRef } from '@/modules/task-execution/public/types'
import type { CollaborationCommandContext } from '../public/types'
import { type PrepareReviewGateOpenInput, ReviewGateOpenPreparation } from './prepareReviewGateOpen'
import {
  resolveCollaborationCommandContext,
  requireHumanGateArtifactStore,
  requireReviewDecisionCommand,
  requireQuestionDispatchCommand,
  requireClarifyDecisionCommand,
  requireClarifyDirectiveStore,
} from './commandContext'
import {
  type PrepareClarifyGateOpenInput,
  ClarifyGateOpenPreparation,
} from './prepareClarifyGateOpen'
import {
  type CreateManualQuestionOpenInput,
  ManualQuestionOpenCreation,
} from './createManualQuestionOpen'
import { CommittedHumanGateFinalizer } from './finalizeCommittedHumanGate'
import type {
  SubmitReviewDecisionCommandInput,
  SubmitReviewDecisionCommandResult,
} from './ports/reviewDecisionCommand'
import type {
  DispatchTaskQuestionsCommandInput,
  DispatchTaskQuestionsCommandResult,
} from './ports/questionDispatchCommand'
import type {
  SubmitClarifyDecisionCommandInput,
  SubmitClarifyDecisionCommandResult,
} from './ports/clarifyDecisionCommand'
import type { ClarifyDirective } from '@agent-workflow/shared'

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
  context: CollaborationCommandContext<'reviewDecisions'>,
  input: SubmitReviewDecisionCommandInput,
): Promise<SubmitReviewDecisionCommandResult> {
  return requireReviewDecisionCommand(context).submit(input)
}

/** RFC-333 T9: the sole REST/MCP-facing task-question dispatch command. */
export async function dispatchTaskQuestions(
  context: CollaborationCommandContext<'questionDispatches'>,
  input: DispatchTaskQuestionsCommandInput,
): Promise<DispatchTaskQuestionsCommandResult> {
  return requireQuestionDispatchCommand(context).dispatch(input)
}

/** RFC-333 T9: the sole REST/MCP-facing quick clarify decision command. */
export async function submitClarifyDecision(
  context: CollaborationCommandContext<'clarifyDecisions'>,
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
