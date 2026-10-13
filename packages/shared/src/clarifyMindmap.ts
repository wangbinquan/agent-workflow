import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'
import type { ClarifyDraftValue } from './schemas/resourceAcl'
import type { ClarifyFollowupTarget } from './schemas/clarifyMindmap'

/** Product defaults shared by initial self/cross questions and branch follow-ups. */
export const CLARIFY_MINDMAP_QUESTION_GUIDANCE = [
  'Organize questions into concise categories in the user language. Use multi-level categoryPath arrays for meaningful subtopics; never flatten a supplied hierarchy or treat slash characters inside a category name as separators.',
  'Configured category paths are the requested coverage outline. Preserve their exact names and ancestry, and use the most specific relevant configured path. When a category is broad, introduce useful subcategories instead of putting unrelated decisions in one flat bucket. Do not add empty or decorative levels.',
  'Ask the most consequential unresolved decisions first. Consider relevant sibling concerns rather than repeatedly exploring one aspect: for performance, consider application behavior, database queries/indexes/connection pools, capacity and external dependencies when applicable. Do not force irrelevant topics or repeat resolved questions.',
  'A category expresses a topic; parentQuestionId expresses a dependent follow-up to a concrete question. Do not use question dependency to imitate a category hierarchy. Respect existing answers, ask about missing constraints or consequences, and provide concrete choices with their tradeoffs.',
  'Additional focus notes are optional business preferences. Empty notes do not disable these built-in classification and follow-up rules. The selected follow-up target and the workflow envelope/limits below still apply.',
].join('\n')

// A deterministic content identity, not a security credential. Four independent
// 32-bit lanes keep it synchronous in the canvas and identical across runtimes.
export function clarifyContentKey(value: unknown): string {
  const text = JSON.stringify(value)
  const lanes = [2166136261, 2246822519, 3266489917, 668265263]
  for (let i = 0; i < text.length; i++) {
    for (let lane = 0; lane < lanes.length; lane++) {
      lanes[lane] = Math.imul(lanes[lane]! ^ text.charCodeAt(i), 16777619 + lane * 2) >>> 0
    }
  }
  return 'v1:' + lanes.map((v) => v.toString(16).padStart(8, '0')).join('')
}
export function clarifyQuestionSetKey(questions: readonly ClarifyQuestion[]): string {
  return clarifyContentKey(questions)
}
export function clarifyAnswerBasis(question: ClarifyQuestion, answer: ClarifyDraftValue): string {
  return clarifyContentKey([
    question,
    [...answer.selectedOptionIndices].sort((a, b) => a - b),
    answer.customText,
  ])
}
export function isClarifyAnswerConfirmed(
  question: ClarifyQuestion,
  answer: ClarifyAnswer | undefined,
): boolean {
  return (
    answer !== undefined &&
    isClarifyAnswerValid(question, answer) &&
    answer.confirmedBasis === clarifyAnswerBasis(question, answer)
  )
}
export function isClarifyAnswerValid(
  question: ClarifyQuestion,
  answer: ClarifyDraftValue,
): boolean {
  const indices = answer.selectedOptionIndices
  return (
    (indices.length > 0 || answer.customText.trim().length > 0) &&
    indices.every((i) => Number.isInteger(i) && i >= 0 && i < question.options.length) &&
    new Set(indices).size === indices.length &&
    (question.kind !== 'single' ||
      (indices.length <= 1 && !(indices.length && answer.customText.trim())))
  )
}
export function isMindmapRound(questions: readonly ClarifyQuestion[]): boolean {
  return questions.some((q) => q.mindmap !== undefined)
}
/** Original sealed answers win over drafts, including partially answered rounds. */
export function effectiveClarifyAnswers<T extends ClarifyDraftValue>(
  drafts: Readonly<Record<string, T>>,
  submitted: readonly (T & { questionId: string })[] | null | undefined,
): Record<string, T> {
  const effective = { ...drafts }
  for (const answer of submitted ?? []) effective[answer.questionId] = answer
  return effective
}
/** Iterative graph validation: arbitrarily deep chains cannot overflow the stack. */
export function validateClarifyMindmap(
  questions: readonly ClarifyQuestion[],
  required = false,
): string | null {
  if (!required && !isMindmapRound(questions)) return null
  const byId = new Map<string, ClarifyQuestion>()
  for (const q of questions) {
    if (byId.has(q.id)) return `duplicate question id: ${q.id}`
    if (!q.mindmap) return `missing mindmap category: ${q.id}`
    byId.set(q.id, q)
  }
  const done = new Set<string>()
  for (const q of questions) {
    const chain = new Set<string>()
    let current: ClarifyQuestion | undefined = q
    while (current && !done.has(current.id)) {
      if (chain.has(current.id)) return `cyclic parent question: ${current.id}`
      chain.add(current.id)
      const parent: string | undefined = current.mindmap?.parentQuestionId
      if (parent && !byId.has(parent)) return `missing parent question: ${parent}`
      current = parent ? byId.get(parent) : undefined
    }
    for (const id of chain) done.add(id)
  }
  return null
}

export function clarifyFollowupContext(
  questions: readonly ClarifyQuestion[],
  drafts: Readonly<Record<string, ClarifyDraftValue>>,
  target: ClarifyFollowupTarget,
) {
  const byId = new Map(questions.map((q) => [q.id, q]))
  const branch: {
    question: ClarifyQuestion
    answer: { selectedOptionIndices: number[]; customText: string }
  }[] = []
  const seen = new Set<string>()
  if (typeof target !== 'string') {
    return questions
      .filter((question) =>
        target.every((category, index) => question.mindmap?.categoryPath[index] === category),
      )
      .map((question) => ({
        question,
        answer: {
          selectedOptionIndices: [...(drafts[question.id]?.selectedOptionIndices ?? [])].sort(
            (a, b) => a - b,
          ),
          customText: drafts[question.id]?.customText ?? '',
        },
      }))
  }
  let question = byId.get(target)
  while (question && !seen.has(question.id)) {
    seen.add(question.id)
    const answer = drafts[question.id]
    branch.push({
      question,
      answer: {
        selectedOptionIndices: [...(answer?.selectedOptionIndices ?? [])].sort((a, b) => a - b),
        customText: answer?.customText ?? '',
      },
    })
    question = question.mindmap?.parentQuestionId
      ? byId.get(question.mindmap.parentQuestionId)
      : undefined
  }
  return branch.reverse()
}
