import {
  isClarifyAnswerValid,
  isClarifySkipStatus,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'

/** RFC-490: things worth another look before submitting. Derived from the current
 *  answers only: no model call, no stored state, and never a submission gate. */
export type MindmapSuggestion =
  | { kind: 'empty-category'; path: string[] }
  | { kind: 'deferred'; questionIds: string[] }
  | { kind: 'provisional-unplanned'; questionId: string }
  | { kind: 'recommendation-unexamined'; questionId: string }
  | { kind: 'no-rationale'; questionIds: string[] }

export function suggestMindmapSteps(input: {
  questions: readonly ClarifyQuestion[]
  answers: Readonly<Record<string, ClarifyAnswer>>
  locked: ReadonlySet<string>
  categoryPaths: readonly (readonly string[])[]
}): MindmapSuggestion[] {
  const { questions, answers, locked } = input
  const result: MindmapSuggestion[] = []
  const used = (path: readonly string[]) =>
    questions.some((question) =>
      path.every((segment, index) => question.mindmap?.categoryPath[index] === segment),
    )
  // Report a gap once, at its deepest configured path: "A > B" covers "A". A map whose
  // questions are all sealed takes no more, so there is nothing left to suggest filling.
  const open = questions.some((question) => !locked.has(question.id))
  const empty = open ? input.categoryPaths.filter((path) => path.length > 0 && !used(path)) : []
  const seen = new Set<string>()
  for (const path of empty) {
    const key = JSON.stringify(path)
    const covered = empty.some(
      (other) =>
        other.length > path.length && path.every((segment, index) => other[index] === segment),
    )
    if (covered || seen.has(key)) continue
    seen.add(key)
    result.push({ kind: 'empty-category', path: [...path] })
  }
  const parents = new Set(questions.map((question) => question.mindmap?.parentQuestionId))
  const deferred: string[] = []
  const unplanned: string[] = []
  const unexamined: string[] = []
  const bare: string[] = []
  for (const question of questions) {
    if (locked.has(question.id)) continue
    const answer = answers[question.id]
    if (!answer || !isClarifyAnswerValid(question, answer)) continue
    const decision = answer.decision
    if (decision?.status === 'deferred') {
      deferred.push(question.id)
      continue
    }
    if (isClarifySkipStatus(decision?.status)) continue
    if (decision?.status === 'provisional' && (!decision.validationOwner || !decision.revisitWhen))
      unplanned.push(question.id)
    if (decision?.rationale?.trim()) continue
    const tookRecommendation = answer.selectedOptionIndices.some(
      (index) => question.options[index]?.recommended,
    )
    if (tookRecommendation && !parents.has(question.id)) unexamined.push(question.id)
    else bare.push(question.id)
  }
  if (deferred.length) result.push({ kind: 'deferred', questionIds: deferred })
  for (const questionId of unplanned) result.push({ kind: 'provisional-unplanned', questionId })
  for (const questionId of unexamined)
    result.push({ kind: 'recommendation-unexamined', questionId })
  if (bare.length) result.push({ kind: 'no-rationale', questionIds: bare })
  return result
}
