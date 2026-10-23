import {
  clarifyDecisionsEqual,
  effectiveClarifyAnswers,
  mergeSealedAnswers,
  type ClarifyAnswer,
  type ClarifyAnswerAttributions,
  type ClarifyDirective,
  type ClarifyDraftValue,
  type ClarifyQuestion,
  type TaskActorRole,
} from '@agent-workflow/shared'

/** RFC-395 II-a：按稳定题号建模；历史重复题号的 occurrence / 封口顺序不可丢失。 */
export interface ClarifyAnswerState {
  readonly answers: ReadonlyMap<string, readonly { ordinal: number; value: ClarifyAnswer }[]> | null
  readonly drafts: Record<string, ClarifyDraftValue> | null
  readonly attributions: ClarifyAnswerAttributions | null
}

export function clarifyAnswerState(
  answers: readonly ClarifyAnswer[] | null,
  drafts: Record<string, ClarifyDraftValue> | null = null,
  attributions: ClarifyAnswerAttributions | null = null,
): ClarifyAnswerState {
  if (answers === null) return { answers: null, drafts, attributions }
  const byQuestion = new Map<string, { ordinal: number; value: ClarifyAnswer }[]>()
  answers.forEach((value, ordinal) => {
    // 旧数组解码不校验 value；即使历史值不完整，详情投影也必须原样保留。
    const key = value?.questionId
    const occurrences = byQuestion.get(key) ?? []
    occurrences.push({ ordinal, value })
    byQuestion.set(key, occurrences)
  })
  return { answers: byQuestion, drafts, attributions }
}

/** 唯一数组 / map 投影。数组按 seal 顺序；board 取 first，queue / follow-up 取 last。 */
export function projectClarifyAnswers(state: ClarifyAnswerState) {
  const answers =
    state.answers === null
      ? null
      : [...state.answers.values()]
          .flat()
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((a) => a.value)
  return {
    answers,
    draftAnswers: state.drafts,
    answerAttributions: state.attributions,
    firstAnswer(questionId: string) {
      return answers?.find((answer) => answer.questionId === questionId)
    },
    answerMap(values: readonly ClarifyAnswer[] = answers ?? []) {
      return new Map(values.map((answer) => [answer.questionId, answer]))
    },
    effectiveAnswers(submitted = answers, drafts = state.drafts) {
      return effectiveClarifyAnswers<ClarifyDraftValue>(drafts ?? {}, submitted)
    },
  }
}

/** sealed_at 是逐题封口事实；answered 兼容整轮封口。答案存在性不是封口事实。 */
export function isClarifyQuestionSealed(
  roundStatus: string | undefined,
  sealedAt: number | null,
): boolean {
  return sealedAt !== null || roundStatus === 'answered'
}

export interface ClarifySealEntry {
  readonly questionId: string
  readonly sealedAt: number | null
  readonly stagedAt: number | null
  readonly dispatchedAt: number | null
}

export function sealedClarifyQuestionIds(
  questions: readonly ClarifyQuestion[],
  status: string,
  entries: readonly ClarifySealEntry[],
): Set<string> {
  const ids = new Set<string>()
  if (isClarifyQuestionSealed(status, null)) for (const q of questions) ids.add(q.id)
  for (const entry of entries) {
    if (isClarifyQuestionSealed(undefined, entry.sealedAt)) ids.add(entry.questionId)
  }
  return ids
}

export function classifyClarifyReseal(
  sealing: ReadonlySet<string>,
  alreadySealed: ReadonlySet<string>,
  entries: readonly ClarifySealEntry[],
  declared: readonly string[] = [],
) {
  const resealed = new Set<string>()
  const fresh = new Set<string>()
  for (const id of sealing) {
    if (!alreadySealed.has(id)) {
      fresh.add(id)
      continue
    }
    const rows = entries.filter((entry) => entry.questionId === id)
    if (
      !declared.includes(id) ||
      rows.length === 0 ||
      !rows.every((entry) => entry.dispatchedAt === null && entry.stagedAt === null)
    ) {
      return { fresh, resealed, rejected: id }
    }
    resealed.add(id)
  }
  return { fresh, resealed, rejected: null }
}

export function saveClarifyQuestionDraft(
  state: ClarifyAnswerState,
  questionId: string,
  value: ClarifyDraftValue,
  editor: { userId: string; role: TaskActorRole },
  now: number,
): ClarifyAnswerState {
  return {
    ...state,
    drafts: { ...state.drafts, [questionId]: value },
    attributions: {
      ...state.attributions,
      [questionId]: { userId: editor.userId, role: editor.role, updatedAt: now },
    },
  }
}

function draftMatchesAnswer(draft: ClarifyDraftValue | undefined, answer: ClarifyAnswer): boolean {
  if (draft === undefined) return false
  const a = [...(draft.selectedOptionIndices ?? [])].sort((x, y) => x - y)
  const b = [...(answer.selectedOptionIndices ?? [])].sort((x, y) => x - y)
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) return false
  return (
    (draft.customText ?? '') === (answer.customText ?? '') &&
    clarifyDecisionsEqual(draft.decision, answer.decision)
  )
}

export function freezeAnswerAttributions(args: {
  answers: readonly ClarifyAnswer[]
  draftAnswers: Record<string, ClarifyDraftValue> | null
  draftAttributions: ClarifyAnswerAttributions | null
  submitter: { userId: string; role: TaskActorRole }
  now: number
}): ClarifyAnswerAttributions {
  const out: ClarifyAnswerAttributions = {}
  for (const answer of args.answers) {
    const draft = args.draftAnswers?.[answer.questionId]
    const draftAttr = args.draftAttributions?.[answer.questionId]
    out[answer.questionId] =
      draftAttr !== undefined && draftMatchesAnswer(draft, answer)
        ? draftAttr
        : { userId: args.submitter.userId, role: args.submitter.role, updatedAt: args.now }
  }
  return out
}

export function sealClarifyAnswers(input: {
  state: ClarifyAnswerState
  questions: readonly ClarifyQuestion[]
  status: string
  alreadySealed: ReadonlySet<string>
  incoming: ClarifyAnswer[]
  directive: ClarifyDirective | null
  requestedDirective?: ClarifyDirective
  sealedBy?: string
  sealedByRole?: TaskActorRole
  now: number
}) {
  const merged = mergeSealedAnswers(
    projectClarifyAnswers(input.state).answers ?? [],
    input.incoming,
  )
  const sealed = new Set([...input.alreadySealed, ...input.incoming.map((a) => a.questionId)])
  const fullySealed = input.questions.every((q) => sealed.has(q.id))
  const flipNow = fullySealed && input.status !== 'answered'
  const directive =
    input.status === 'answered'
      ? (input.directive ?? 'continue')
      : (input.requestedDirective ?? input.directive ?? 'continue')
  const freeze = flipNow && input.sealedBy !== undefined && input.sealedByRole !== undefined
  const attributions = freeze
    ? freezeAnswerAttributions({
        answers: merged,
        draftAnswers: input.state.drafts,
        draftAttributions: input.state.attributions,
        submitter: { userId: input.sealedBy!, role: input.sealedByRole! },
        now: input.now,
      })
    : input.state.attributions
  return {
    state: clarifyAnswerState(merged, freeze ? null : input.state.drafts, attributions),
    fullySealed,
    flipNow,
    directive,
    freeze,
    sealedBy: input.sealedBy,
    sealedByRole: input.sealedByRole,
    now: input.now,
  }
}

/** 重开只清答案与 answeredAt；取消 / 放弃只改轮次终态。其余字段继续保留。 */
export function clarifyRoundTransition(kind: 'reopen' | 'cancel' | 'abandon', now: number) {
  switch (kind) {
    case 'reopen':
      return { status: 'awaiting_human' as const, answers: null, answeredAt: null }
    case 'cancel':
      return { status: 'canceled' as const }
    case 'abandon':
      return { status: 'abandoned' as const, abandonedAt: now }
  }
}
