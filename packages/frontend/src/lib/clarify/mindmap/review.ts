import {
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  isClarifySkipStatus,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'

/** RFC-490: the review dialog's reading order and its headline counts. */
export interface ReviewEntry {
  question: ClarifyQuestion
  /** Position in the round, for the stable "Qn" label. */
  index: number
  /** 0 for a question filed directly under its category; 1+ for follow-ups. */
  depth: number
  parentIndex: number | null
  answer: ClarifyAnswer | undefined
  answered: boolean
  confirmed: boolean
  attention: boolean
}
export interface ReviewGroup {
  path: string[]
  entries: ReviewEntry[]
}
export interface ReviewSummary {
  total: number
  confirmed: number
  provisional: number
  /** Answered without a maturity mark; an unanswered question is not "unmarked". */
  unmarked: number
  notApplicable: number
  deferred: number
  noRationale: number
  attention: number
}

export function reviewMindmapDecisions(
  questions: readonly ClarifyQuestion[],
  answers: Readonly<Record<string, ClarifyAnswer>>,
  locked: ReadonlySet<string>,
): { summary: ReviewSummary; groups: ReviewGroup[] } {
  const indexOf = new Map(questions.map((question, index) => [question.id, index]))
  const children = new Map<string, ClarifyQuestion[]>()
  const roots: ClarifyQuestion[] = []
  for (const question of questions) {
    const parent = question.mindmap?.parentQuestionId
    if (parent !== undefined && indexOf.has(parent)) {
      const list = children.get(parent) ?? []
      list.push(question)
      children.set(parent, list)
    } else roots.push(question)
  }
  const summary: ReviewSummary = {
    total: questions.length,
    confirmed: 0,
    provisional: 0,
    unmarked: 0,
    notApplicable: 0,
    deferred: 0,
    noRationale: 0,
    attention: 0,
  }
  const groups = new Map<string, ReviewGroup>()
  for (const root of roots) {
    const path = root.mindmap?.categoryPath ?? []
    const key = JSON.stringify(path)
    const group = groups.get(key) ?? { path: [...path], entries: [] }
    groups.set(key, group)
    // Iterative: follow-up chains can be arbitrarily deep.
    const stack: { question: ClarifyQuestion; depth: number }[] = [{ question: root, depth: 0 }]
    const visited = new Set<string>()
    while (stack.length) {
      const { question, depth } = stack.pop()!
      if (visited.has(question.id)) continue
      visited.add(question.id)
      const answer = answers[question.id]
      const answered = answer !== undefined && isClarifyAnswerValid(question, answer)
      const confirmed = locked.has(question.id) || isClarifyAnswerConfirmed(question, answer)
      const status = answer?.decision?.status
      const skipped = isClarifySkipStatus(status)
      const bare = answered && !skipped && !answer?.decision?.rationale?.trim()
      const attention = !confirmed || status === 'provisional' || status === 'deferred' || bare
      if (confirmed) summary.confirmed++
      if (status === 'provisional') summary.provisional++
      else if (status === 'not-applicable') summary.notApplicable++
      else if (status === 'deferred') summary.deferred++
      else if (!status && answered) summary.unmarked++
      if (bare) summary.noRationale++
      if (attention) summary.attention++
      const parent = question.mindmap?.parentQuestionId
      group.entries.push({
        question,
        index: indexOf.get(question.id)!,
        depth,
        parentIndex: parent !== undefined ? (indexOf.get(parent) ?? null) : null,
        answer,
        answered,
        confirmed,
        attention,
      })
      const next = children.get(question.id) ?? []
      for (let i = next.length - 1; i >= 0; i--)
        stack.push({ question: next[i]!, depth: depth + 1 })
    }
  }
  return { summary, groups: [...groups.values()] }
}
