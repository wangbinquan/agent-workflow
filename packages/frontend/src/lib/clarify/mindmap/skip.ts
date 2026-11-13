import {
  clarifyAnswerBasis,
  clarifySkipStatus,
  isClarifySkipStatus,
  normalizeClarifyDecision,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifySkipStatus,
} from '@agent-workflow/shared'

/** RFC-490 (design §6.2): skipping is one step. The answer is emptied, marked and
 *  confirmed together, so a skipped question never blocks the round. Switching
 *  between the two skip kinds keeps the note already written. */
export function skipClarifyAnswer(
  question: ClarifyQuestion,
  answer: ClarifyAnswer,
  status: ClarifySkipStatus,
): ClarifyAnswer {
  const note = clarifySkipStatus(answer) ? answer.decision?.rationale : undefined
  const next: ClarifyAnswer = {
    questionId: answer.questionId,
    selectedOptionIndices: [],
    selectedOptionLabels: [],
    customText: '',
    decision: { status, ...(note ? { rationale: note } : {}) },
  }
  return { ...next, confirmedBasis: clarifyAnswerBasis(question, next) }
}

/** The note on a skipped question. The skip stays confirmed while it is edited:
 *  adding a sentence must not turn the question back into something to confirm. */
export function explainClarifySkip(
  question: ClarifyQuestion,
  answer: ClarifyAnswer,
  note: string,
): ClarifyAnswer {
  const status = clarifySkipStatus(answer)
  if (!status) return answer
  const { confirmedBasis: _confirmed, ...rest } = answer
  const next: ClarifyAnswer = {
    ...rest,
    decision: { status, ...(note ? { rationale: note } : {}) },
  }
  return { ...next, confirmedBasis: clarifyAnswerBasis(question, next) }
}

/** Back to answering: what was there before the skip returns, unconfirmed. The note
 *  is the user's wording and is kept unless an earlier rationale takes its place. */
export function resumeClarifyAnswer(
  answer: ClarifyAnswer,
  before: ClarifyAnswer | undefined,
): ClarifyAnswer {
  const base: ClarifyAnswer = before ?? {
    questionId: answer.questionId,
    selectedOptionIndices: [],
    selectedOptionLabels: [],
    customText: '',
  }
  const { confirmedBasis: _confirmed, decision: earlier, ...plain } = base
  const decision = normalizeClarifyDecision({
    ...earlier,
    status: isClarifySkipStatus(earlier?.status) ? undefined : earlier?.status,
    rationale: earlier?.rationale?.trim() ? earlier.rationale : answer.decision?.rationale,
  })
  return decision ? { ...plain, decision } : plain
}
