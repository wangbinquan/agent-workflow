import { normalizeClarifyDecision } from './schemas/clarifyDecision'
import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'
import type { ClarifyDraftValue } from './schemas/resourceAcl'
import type { ClarifyFollowupTarget } from './schemas/clarifyMindmap'

/** Product defaults shared by initial self/cross questions and branch follow-ups. */
export const CLARIFY_MINDMAP_QUESTION_GUIDANCE = [
  'Every emitted question must contain mindmap.categoryPath as a non-empty array of category names, including questions attached to a selected parent. Parent attachment does not replace this required field. Check this field on every question before returning the envelope.',
  'Organize questions into concise categories in the user language. Use multi-level categoryPath arrays for meaningful subtopics; never flatten a supplied hierarchy or treat slash characters inside a category name as separators.',
  'Configured category paths are the requested coverage outline. Preserve their exact names and ancestry, and use the most specific relevant configured path. When a category is broad, introduce useful subcategories instead of putting unrelated decisions in one flat bucket. Do not add empty or decorative levels.',
  'Ask the most consequential unresolved decisions first. Consider relevant sibling concerns rather than repeatedly exploring one aspect: for performance, consider application behavior, database queries/indexes/connection pools, capacity and external dependencies when applicable. Do not force irrelevant topics or repeat resolved questions.',
  'A category expresses a topic; parentQuestionId expresses a dependent follow-up to a concrete question. Do not use question dependency to imitate a category hierarchy. Respect existing answers, ask about missing constraints or consequences, and provide concrete choices with their tradeoffs.',
  'Ask one independently decidable tradeoff per question. Do not bundle unrelated parameters into a package. Use multi-choice for compatible criteria and single-choice only for mutually exclusive alternatives.',
  'Construct a single-choice question by naming ONE variable in its title and offering only alternative values of that variable. Keep every other decision open. In both labels and descriptions, do not attach an independently configurable mechanism, exception, permission or workflow to only one value. Consequences of a value are valid explanations; extra decisions are not consequences.',
  'For example, ask "How long should records be retained?" with values "7 days", "14 days", "30 days"; ask automatic deletion and administrator exceptions separately if needed. "7 days with manual cleanup" versus "30 days with automatic cleanup" is invalid even though the complete packages are mutually exclusive. The same rule applies to any duration, granularity, quota or policy.',
  'Audit the full options, including descriptions, before returning: if choosing a value also chooses a second variable, split or defer that variable. Two clean options are better than adding a third bundled exception to fill the picker. Broad titles such as "How should we handle this?" must be narrowed to the one variable actually being decided.',
  'Related topics are not necessarily one decision. Success criteria, rollout scope and validation ownership are separate axes: never offer a small pilot as an alternative to measuring success. Ask the highest-priority axes now and defer the others instead of compressing them to meet the question limit.',
  'Before emitting each single-choice question, check every pair of options: could a user reasonably want both? If yes, use multi-choice or split the decision. For example, recording usage and sending reminders are compatible; neither is an exclusive alternative to the other.',
  'Separate evidence collection from enforcement. For example, ask a single-choice question about automatic release (enable or do not enable), and a separate multi-choice question about compatible observations and reminders. Do not frame recording, voluntary cancellation, automatic release and manual inspection as four mutually exclusive strategies.',
  'A confirmed answer is a user-reviewed choice, not proof of a settled decision or a verified fact. Preserve explicit decided/provisional status and unmarked maturity; ask about unresolved evidence without upgrading or silently changing the current choice.',
  'Every option must be understandable on its own. The interface may reorder recommended options, so never use labels such as "the previous option plus", "上一档", "上述方案" or refer to another option by its display position.',
  'Do not call a problem the main pain point, the most common case, or the highest priority unless the user supplied evidence. When evidence is absent, state the assumption explicitly and offer a reversible way to gather evidence before stronger controls.',
  'Recommendations must state the assumptions under which they apply and the cost accepted. Without evidence, use conditional language; do not invent a baseline or claim one option is uniquely correct. Follow-ups should examine evidence, counterexamples, consequences and how uncertainty can be checked.',
  'Additional focus notes are optional business preferences. Empty notes do not disable these built-in classification and follow-up rules. The selected follow-up target and the workflow envelope/limits below still apply.',
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
