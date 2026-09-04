// RFC-341 —— collaboration committed event 的**同步**参与者（dbTxSync 体内用）。
//
// RFC-359：事件形状只有一份，在 `collaborationCommittedEvents.ts`；这里只是把同一份形状交给同步的
// `appendCommittedEventTx`。其余 dbTxSync 调用方迁到 `DatabaseSession` 后本文件删除。

import type { DbTxSync } from '@/db/txSync'
import { appendCommittedEventTx } from '@/platform/events/committed/sqliteStore'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import {
  humanGateDecisionCommittedEventInput,
  humanGateOpenedCommittedEventInput,
  questionDispatchCommittedEventInput,
  reviewCommentsChangedCommittedEventInput,
  reviewSelectionChangedCommittedEventInput,
  type HumanGateDecisionCommittedEventInput,
  type HumanGateOpenedCommittedEventInput,
  type QuestionDispatchCommittedEventInput,
  type ReviewCommentsChangedCommittedEventInput,
  type ReviewSelectionChangedCommittedEventInput,
} from './collaborationCommittedEvents'

export type { CollaborationCommittedEventIdentity } from './collaborationCommittedEvents'

export function appendHumanGateOpenedCommittedEventTx(
  tx: DbTxSync,
  input: HumanGateOpenedCommittedEventInput,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, humanGateOpenedCommittedEventInput(input)).eventRef
}

export function appendHumanGateDecisionCommittedEventTx(
  tx: DbTxSync,
  input: HumanGateDecisionCommittedEventInput,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, humanGateDecisionCommittedEventInput(input)).eventRef
}

export function appendReviewCommentsChangedCommittedEventTx(
  tx: DbTxSync,
  input: ReviewCommentsChangedCommittedEventInput,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, reviewCommentsChangedCommittedEventInput(input)).eventRef
}

export function appendReviewSelectionChangedCommittedEventTx(
  tx: DbTxSync,
  input: ReviewSelectionChangedCommittedEventInput,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, reviewSelectionChangedCommittedEventInput(input)).eventRef
}

export function appendQuestionDispatchCommittedEventTx(
  tx: DbTxSync,
  input: QuestionDispatchCommittedEventInput,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, questionDispatchCommittedEventInput(input)).eventRef
}
