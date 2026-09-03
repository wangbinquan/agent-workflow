// RFC-333 T7 — immutable clarify-open manifest consumed by TaskParkTx.

import { sha256Hex } from '@/util/hash'
import { canonicalHumanGateValueJson } from './canonicalGateRequest'
import { HumanGateOperationError } from './humanGateOperation'

export type ClarifyGateNodeProjection = Readonly<{
  mode: 'mint' | 'reuse-pending' | 'reuse-running' | 'reuse-awaiting'
  id: string
  taskId: string
  nodeId: string
  runIteration: number
  parentNodeRunId: string | null
  /** RFC-354 — the frame the park row lives in (the asking run's frame). */
  containerRunId: string | null
  shardKey: string | null
  previousStartedAt: number | null
  startedAt: number | null
  cause: 'clarify-park' | 'cross-clarify-park'
}>

export type ClarifyGateRoundProjection = Readonly<{
  id: string
  taskId: string
  kind: 'self' | 'cross'
  askingNodeId: string
  askingNodeRunId: string
  askingShardKey: string | null
  intermediaryNodeId: string
  intermediaryNodeRunId: string
  targetConsumerNodeId: string | null
  loopIter: number
  /** RFC-354 — the frame the round (and its park row) lives in; null = top scope. */
  containerRunId: string | null
  iteration: number
  questionsJson: string
  answersJson: null
  directive: null
  status: 'awaiting_human'
  truncationWarningsJson: string | null
  designerRunTriggeredAt: null
  abandonedAt: null
  createdAt: number
  answeredAt: null
  answeredBy: null
  submittedByRole: null
  answerAttributionsJson: null
  draftAnswersJson: null
}>

export type ClarifyGateQuestionProjection = Readonly<{
  mode: 'insert' | 'refresh-existing'
  id: string
  taskId: string
  originNodeRunId: string
  questionId: string
  questionTitle: string
  sourceKind: 'self' | 'cross'
  roleKind: 'self' | 'questioner'
  iteration: number
  loopIter: number
  defaultTargetNodeId: string | null
  createdAt: number
  updatedAt: number
  previousQuestionTitle: string | null
  previousDefaultTargetNodeId: string | null
  previousUpdatedAt: number | null
}>

export interface ClarifyGateOpenManifest {
  readonly schemaVersion: 1
  readonly kind: 'clarify-open'
  readonly gateRef: string
  readonly sourceSnapshotDigest: string
  readonly nodeProjectionDigest: string
  readonly committedEventRef: string
  readonly node: ClarifyGateNodeProjection
  readonly round: ClarifyGateRoundProjection
  readonly questions: readonly ClarifyGateQuestionProjection[]
}

function invalid(message: string): never {
  throw new HumanGateOperationError('human-gate-operation-manifest-invalid', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0) invalid(`clarify-open ${key} is invalid`)
  return field
}

function nullableString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  if (field !== null && typeof field !== 'string') invalid(`clarify-open ${key} is invalid`)
  return field as string | null
}

function nonNegativeInteger(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (!Number.isSafeInteger(field) || (field as number) < 0) {
    invalid(`clarify-open ${key} is invalid`)
  }
  return field as number
}

function nullableNonNegativeInteger(value: Record<string, unknown>, key: string): number | null {
  const field = value[key]
  if (field === null) return null
  return nonNegativeInteger(value, key)
}

function decodeNode(value: unknown): ClarifyGateNodeProjection {
  if (!isRecord(value)) invalid('clarify-open node projection is invalid')
  const mode = value.mode
  if (
    mode !== 'mint' &&
    mode !== 'reuse-pending' &&
    mode !== 'reuse-running' &&
    mode !== 'reuse-awaiting'
  ) {
    invalid('clarify-open node projection mode is invalid')
  }
  const cause = value.cause
  if (cause !== 'clarify-park' && cause !== 'cross-clarify-park') {
    invalid('clarify-open node cause is invalid')
  }
  const previousStartedAt = nullableNonNegativeInteger(value, 'previousStartedAt')
  const startedAt = nullableNonNegativeInteger(value, 'startedAt')
  if (mode === 'mint' && (previousStartedAt !== null || startedAt === null)) {
    invalid('clarify-open minted node timing is invalid')
  }
  if ((mode === 'reuse-pending' || mode === 'reuse-running') && startedAt === null) {
    invalid('clarify-open parked node timing is invalid')
  }
  return {
    mode,
    id: stringField(value, 'id'),
    taskId: stringField(value, 'taskId'),
    nodeId: stringField(value, 'nodeId'),
    containerRunId: nullableString(value, 'containerRunId'),
    runIteration: nonNegativeInteger(value, 'runIteration'),
    parentNodeRunId: nullableString(value, 'parentNodeRunId'),
    shardKey: nullableString(value, 'shardKey'),
    previousStartedAt,
    startedAt,
    cause,
  }
}

function decodeRound(value: unknown): ClarifyGateRoundProjection {
  if (!isRecord(value)) invalid('clarify-open round projection is invalid')
  const kind = value.kind
  if (kind !== 'self' && kind !== 'cross') invalid('clarify-open round kind is invalid')
  if (
    value.answersJson !== null ||
    value.directive !== null ||
    value.status !== 'awaiting_human' ||
    value.designerRunTriggeredAt !== null ||
    value.abandonedAt !== null ||
    value.answeredAt !== null ||
    value.answeredBy !== null ||
    value.submittedByRole !== null ||
    value.answerAttributionsJson !== null ||
    value.draftAnswersJson !== null
  ) {
    invalid('clarify-open round mutable fields are invalid')
  }
  const askingShardKey = nullableString(value, 'askingShardKey')
  const targetConsumerNodeId = nullableString(value, 'targetConsumerNodeId')
  const loopIter = nonNegativeInteger(value, 'loopIter')
  const truncationWarningsJson = nullableString(value, 'truncationWarningsJson')
  if (
    (kind === 'self' && (targetConsumerNodeId !== null || loopIter !== 0)) ||
    (kind === 'cross' && askingShardKey !== null)
  ) {
    invalid('clarify-open round kind-specific projection is invalid')
  }
  for (const [label, raw] of [
    ['questionsJson', stringField(value, 'questionsJson')],
    ['truncationWarningsJson', truncationWarningsJson],
  ] as const) {
    if (raw === null) continue
    try {
      const decoded: unknown = JSON.parse(raw)
      if (!Array.isArray(decoded)) invalid(`clarify-open ${label} must be an array`)
    } catch (error) {
      if (error instanceof HumanGateOperationError) throw error
      invalid(`clarify-open ${label} is invalid JSON`)
    }
  }
  return {
    id: stringField(value, 'id'),
    taskId: stringField(value, 'taskId'),
    kind,
    askingNodeId: stringField(value, 'askingNodeId'),
    askingNodeRunId: stringField(value, 'askingNodeRunId'),
    askingShardKey,
    intermediaryNodeId: stringField(value, 'intermediaryNodeId'),
    intermediaryNodeRunId: stringField(value, 'intermediaryNodeRunId'),
    targetConsumerNodeId,
    loopIter,
    containerRunId: nullableString(value, 'containerRunId'),
    iteration: nonNegativeInteger(value, 'iteration'),
    questionsJson: stringField(value, 'questionsJson'),
    answersJson: null,
    directive: null,
    status: 'awaiting_human',
    truncationWarningsJson,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt: nonNegativeInteger(value, 'createdAt'),
    answeredAt: null,
    answeredBy: null,
    submittedByRole: null,
    answerAttributionsJson: null,
    draftAnswersJson: null,
  }
}

function decodeQuestion(value: unknown): ClarifyGateQuestionProjection {
  if (!isRecord(value)) invalid('clarify-open question projection is invalid')
  const mode = value.mode
  if (mode !== 'insert' && mode !== 'refresh-existing') {
    invalid('clarify-open question projection mode is invalid')
  }
  const sourceKind = value.sourceKind
  const roleKind = value.roleKind
  if (
    (sourceKind !== 'self' && sourceKind !== 'cross') ||
    (roleKind !== 'self' && roleKind !== 'questioner') ||
    (sourceKind === 'self') !== (roleKind === 'self')
  ) {
    invalid('clarify-open question role is invalid')
  }
  const previousQuestionTitle = nullableString(value, 'previousQuestionTitle')
  const previousDefaultTargetNodeId = nullableString(value, 'previousDefaultTargetNodeId')
  const previousUpdatedAt = nullableNonNegativeInteger(value, 'previousUpdatedAt')
  if (
    (mode === 'insert' &&
      (previousQuestionTitle !== null ||
        previousDefaultTargetNodeId !== null ||
        previousUpdatedAt !== null)) ||
    (mode === 'refresh-existing' && (previousQuestionTitle === null || previousUpdatedAt === null))
  ) {
    invalid('clarify-open question previous projection is invalid')
  }
  return {
    mode,
    id: stringField(value, 'id'),
    taskId: stringField(value, 'taskId'),
    originNodeRunId: stringField(value, 'originNodeRunId'),
    questionId: stringField(value, 'questionId'),
    questionTitle: stringField(value, 'questionTitle'),
    sourceKind,
    roleKind,
    iteration: nonNegativeInteger(value, 'iteration'),
    loopIter: nonNegativeInteger(value, 'loopIter'),
    defaultTargetNodeId: nullableString(value, 'defaultTargetNodeId'),
    createdAt: nonNegativeInteger(value, 'createdAt'),
    updatedAt: nonNegativeInteger(value, 'updatedAt'),
    previousQuestionTitle,
    previousDefaultTargetNodeId,
    previousUpdatedAt,
  }
}

export function clarifyGateProjectionDigest(input: {
  readonly sourceSnapshotDigest: string
  readonly node: ClarifyGateNodeProjection
  readonly round: ClarifyGateRoundProjection
  readonly questions: readonly ClarifyGateQuestionProjection[]
}): string {
  return sha256Hex(canonicalHumanGateValueJson(input))
}

export function encodeClarifyGateOpenManifest(manifest: ClarifyGateOpenManifest): string {
  return canonicalHumanGateValueJson(manifest)
}

export function decodeClarifyGateOpenManifest(raw: string): ClarifyGateOpenManifest {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalid('clarify-open manifest is invalid JSON')
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== 'clarify-open') {
    invalid('clarify-open manifest envelope is invalid')
  }
  const node = decodeNode(value.node)
  const round = decodeRound(value.round)
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    invalid('clarify-open manifest must contain eager question snapshots')
  }
  const questions = value.questions.map(decodeQuestion)
  const sourceSnapshotDigest = stringField(value, 'sourceSnapshotDigest')
  const declaredDigest = stringField(value, 'nodeProjectionDigest')
  if (
    clarifyGateProjectionDigest({ sourceSnapshotDigest, node, round, questions }) !== declaredDigest
  ) {
    invalid('clarify-open projection digest changed')
  }
  if (
    stringField(value, 'gateRef') !== `clarify:${node.id}` ||
    round.taskId !== node.taskId ||
    round.intermediaryNodeId !== node.nodeId ||
    round.intermediaryNodeRunId !== node.id ||
    (round.kind === 'self') !== (node.cause === 'clarify-park') ||
    questions.some(
      (question) =>
        question.taskId !== round.taskId ||
        question.originNodeRunId !== round.intermediaryNodeRunId ||
        question.sourceKind !== round.kind ||
        question.iteration !== round.iteration ||
        question.loopIter !== round.loopIter ||
        question.defaultTargetNodeId !== round.askingNodeId,
    ) ||
    new Set(questions.map((question) => `${question.questionId}\u0000${question.roleKind}`))
      .size !== questions.length
  ) {
    invalid('clarify-open projections do not share one gate identity')
  }
  let parsedQuestions: unknown
  try {
    parsedQuestions = JSON.parse(round.questionsJson)
  } catch {
    invalid('clarify-open questions are invalid JSON')
  }
  if (
    !Array.isArray(parsedQuestions) ||
    parsedQuestions.length !== questions.length ||
    parsedQuestions.some((question, index) => {
      if (!isRecord(question)) return true
      return (
        question.id !== questions[index]!.questionId ||
        question.title !== questions[index]!.questionTitle
      )
    })
  ) {
    invalid('clarify-open eager question snapshots do not match the round')
  }
  return {
    schemaVersion: 1,
    kind: 'clarify-open',
    gateRef: `clarify:${node.id}`,
    sourceSnapshotDigest,
    nodeProjectionDigest: declaredDigest,
    committedEventRef: stringField(value, 'committedEventRef'),
    node,
    round,
    questions,
  }
}
