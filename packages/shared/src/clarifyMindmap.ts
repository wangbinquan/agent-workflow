import { normalizeClarifyDecision } from './schemas/clarifyDecision'
import type { ClarifyAnswer, ClarifyQuestion } from './schemas/clarify'
import type { ClarifyDraftValue } from './schemas/resourceAcl'
import type { ClarifyFollowupTarget } from './schemas/clarifyMindmap'

/** Product defaults shared by initial self/cross questions and branch follow-ups. */
export const CLARIFY_MINDMAP_QUESTION_GUIDANCE = [
  'Ask 2–3 questions. With no baseline and no specifically requested mechanism/parameter, start with problem priority, observable success and feasible evidence; leave policy design for later. Honor a specific tradeoff requested by the user.',
  'Single: values of ONE variable named in the title. Allocation order, quotas and approval are independent, as are time grid/minimum duration and channel/operator. Keep success criteria, rollout scope and validation ownership separate.',
  'One mechanism: enable / do not enable only. Neither option decides any other mechanism. Detection signal, threshold, sign-in, recording and reminders remain independent. A negative choice does not prescribe a replacement process.',
  'Multi: compatible additions on ONE axis. Success criteria and evidence sources remain multi after choosing a primary goal; single needs an explicitly named primary criterion. No exclusive feature bundles or none/only/no-extra option. Pilot size is scope, not evidence. History/observations and scheduled/event-triggered reviews can coexist.',
  'Evidence source, coverage window and recording time are separate. Scheduled logs and event reports can coexist. Review does not activate policy or prove causality. Missing or unchanged data invites review, not proof the chosen goal is wrong.',
  'Descriptions: possible benefit and cost, no added commitments or positional references. Selecting an option must leave other variables undecided; otherwise split/defer it.',
  'Recommend only with a specific assumption and cost. Never invent a baseline, main pain point, existing system or automatic collection. Unknown source availability needs "if available". A sample does not prove a whole period.',
  'Preserve explicit decided/provisional status and unmarked maturity. Confirmation is not verified evidence. Unknown is not no/disabled/rejected. Follow-ups test evidence, counterexamples and feasible validation; respect prior choices.',
  'Every question requires a non-empty mindmap.categoryPath array in the user language, even with a parent. Preserve configured names/ancestry and literal slashes; otherwise use one category level.',
  'Empty focus notes keep these defaults.',
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
