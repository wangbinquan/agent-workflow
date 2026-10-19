import { normalizeClarifyDecision } from './schemas/clarifyDecision'
import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'
import type { ClarifyDraftValue } from './schemas/resourceAcl'
import type { ClarifyFollowupTarget } from './schemas/clarifyMindmap'

/** Product defaults shared by initial self/cross questions and branch follow-ups. */
export const CLARIFY_MINDMAP_QUESTION_GUIDANCE = [
  'Build a short set of independent decisions, using these question forms. Prioritize consequential unresolved choices across relevant sibling concerns; defer lower-priority choices instead of bundling them to fill the question limit.',
  '1. A mechanism is a binary question: "Enable <one mechanism>?", kind single, exactly two options "Enable <that mechanism>" and "Do not enable <that mechanism>". Neither option decides any other mechanism; preserve choices already made elsewhere. Separate evidence collection from enforcement: automatic release, sign-in, recording and reminders are four separate mechanisms, not levels of one "handling strength". A negative choice does not prescribe a replacement process. For example, "Do not enable automatic release" means only no automatic release; it does not also mean record, remind, inspect or prohibit sign-in.',
  '2. A parameter is a single-choice question naming ONE variable in its title. Offer values of that parameter only: for a retention duration, "7 days", "14 days", "30 days". Exceptions, permissions and cleanup methods are separate decisions. For a primary channel, compare channels only; who operates a channel is a separate question. Success criteria, rollout scope and validation ownership are separate axes.',
  '3. A set of compatible sources, observations, criteria or review triggers uses kind multi. Historical records and new observations can coexist; a calendar review and a loss-triggered review can coexist; recording usage and sending reminders are compatible. Do not manufacture exclusivity by adding "only" or forbidding another action. A review trigger calls for reconsideration, not automatic policy activation.',
  '4. Each label is just the value or action being selected. Each description is ONE short sentence explaining its incremental benefit and cost, not an implementation plan or an additional commitment. Use conditional consequences ("may", "could") when the effect is uncertain. Audit the full options, including descriptions, once for additional decisions; split or defer any such decision. The interface may reorder recommended options, so each option must stand alone without "the previous option", "上一档" or "上述方案".',
  '5. Offer a recommendation only with its specific assumption and cost. Do not assert a baseline, a main pain point or an existing system unless the user supplied evidence. An evidence-source option must say "if available" when availability is unknown. Distinguish an observation from its interpretation: a sampled empty room does not establish an unused whole time slot. Follow-ups should help examine evidence, counterexamples, consequences and a feasible way to check uncertainty.',
  '6. Preserve explicit decided/provisional status and unmarked maturity. Confirmation means the user reviewed an answer, not that its assumptions are verified. Keep unknowns open; do not replace them with negative decisions or repeat a choice the user already made.',
  '7. Every emitted question must contain mindmap.categoryPath as a non-empty array of concise category names in the user language. Parent attachment does not replace this required field. Preserve configured category names and ancestry; use the most specific meaningful subtopic, without decorative levels. Do not flatten hierarchy or split literal slashes in category names. parentQuestionId expresses a dependent follow-up, not a category.',
  'Additional focus notes are optional business preferences; empty notes leave these defaults active. Respect the selected follow-up target and the existing envelope and limits. Produce the question set directly after one brief check of variable, kind, option descriptions and categoryPath.',
].join('\n')

// A deterministic content identity, not a security credential. Four independent
// 32-bit lanes keep it synchronous in the canvas and identical across runtimes.
// Hashed over canonical JSON, so a re-parsed or re-spread object keeps its key.
export function clarifyContentKey(value: unknown): string {
  const text = canonicalClarifyJson(value)
  const lanes = [2166136261, 2246822519, 3266489917, 668265263]
  for (let i = 0; i < text.length; i++) {
    for (let lane = 0; lane < lanes.length; lane++) {
      lanes[lane] = Math.imul(lanes[lane]! ^ text.charCodeAt(i), 16777619 + lane * 2) >>> 0
    }
  }
  return 'v2:' + lanes.map((v) => v.toString(16).padStart(8, '0')).join('')
}
/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalClarifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return current
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(current).sort())
      sorted[key] = (current as Record<string, unknown>)[key]
    return sorted
  })
}
export function clarifyQuestionSetKey(questions: readonly ClarifyQuestion[]): string {
  return clarifyContentKey(questions)
}
export function clarifyAnswerBasis(question: ClarifyQuestion, answer: ClarifyDraftValue): string {
  const decision = normalizeClarifyDecision(answer.decision)
  return clarifyContentKey([
    question,
    [...answer.selectedOptionIndices].sort((a, b) => a - b),
    answer.customText,
    ...(decision ? [decision] : []),
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
    answer: ClarifyDraftValue
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
          ...(normalizeClarifyDecision(drafts[question.id]?.decision)
            ? { decision: normalizeClarifyDecision(drafts[question.id]?.decision) }
            : {}),
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
        ...(normalizeClarifyDecision(answer?.decision)
          ? { decision: normalizeClarifyDecision(answer?.decision) }
          : {}),
      },
    })
    question = question.mindmap?.parentQuestionId
      ? byId.get(question.mindmap.parentQuestionId)
      : undefined
  }
  return branch.reverse()
}
