import { normalizeClarifyDecision } from './schemas/clarifyDecision'
import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'
import type { ClarifyDraftValue } from './schemas/resourceAcl'
import type { ClarifyFollowupTarget } from './schemas/clarifyMindmap'

/** Product defaults shared by initial self/cross questions and branch follow-ups. */
export const CLARIFY_MINDMAP_QUESTION_GUIDANCE = [
  'Ask the highest-impact unresolved decisions first; defer others within the question limit. Use these forms:',
  '1. One mechanism: kind single, exactly two options "Enable <that mechanism>" / "Do not enable <that mechanism>". Neither option decides any other mechanism. A negative choice does not prescribe a replacement process or imply "only manual handling". Example disabled description: "避免误动作，但原风险可能仍在；其他处理方式未定。" Separate evidence collection from enforcement: release, sign-in, recording and reminders are independent.',
  '2. One parameter: kind single, naming ONE variable in its title, with values only. Time grid and minimum duration are separate. Allocation order and approval are separate. For channels, who operates a channel is a separate question. Success criteria, rollout scope and validation ownership are separate axes.',
  '3. Compatible features, sources, criteria or review triggers: kind multi. Each set concerns ONE axis: features OR data sources OR triggers. Pilot size is rollout scope, not evidence; omit it from evidence-source options. Offer individual additions, never single-choice "basic / basic plus X / basic plus Y" packages. Do not manufacture exclusivity: no "only", "none" or "no extra collection" option inside a compatible set. Historical records and new observations can coexist; a calendar review and a loss-triggered review can coexist. Review means reconsideration, not automatic policy activation.',
  '4. Each description is ONE short sentence: possible benefit and cost, no extra commitments. Audit the full options, including descriptions. Options may be reordered: no positional references such as "上一档" or "上述方案".',
  '5. Recommendations need a specific assumption and cost; uncertain effects use "may/could". Never invent a baseline, main pain point, existing system or automatic data collection. An evidence-source option must say "if available" when availability is unknown. A sample does not prove a whole period. Follow-ups examine evidence, counterexamples, consequences and feasible validation.',
  '6. Preserve explicit decided/provisional status and unmarked maturity. Confirmation is review, not verified assumptions. Unknown is not no/disabled/rejected. Respect prior choices.',
  '7. Every question requires a non-empty mindmap.categoryPath array in the user language, even with a parent. Preserve configured names/ancestry and literal slashes; otherwise use one category level. parentQuestionId denotes a dependent question, not a category.',
  'Empty focus notes keep these defaults. Respect the selected target and envelope. Check variable, kind, descriptions and categoryPath once, then emit questions directly.',
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
