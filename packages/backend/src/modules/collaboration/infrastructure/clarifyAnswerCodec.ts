import type {
  ClarifyAnswer,
  ClarifyAnswerAttributions,
  ClarifyDraftValue,
} from '@agent-workflow/shared'
import { clarifyAnswerState, projectClarifyAnswers } from '../domain/clarifyAnswers'
import type { ClarifyAnswerContent } from '../domain/clarifyAnswerContent'

/** RFC-395 II-a 源读者：纯函数，供 II-b 转换器复用，不访问数据库。 */
function decodeLegacyClarifyJson(raw: string | null) {
  if (raw === null) return { kind: 'absent' as const }
  try {
    return { kind: 'value' as const, value: JSON.parse(raw) as unknown }
  } catch (error) {
    return { kind: 'malformed' as const, text: raw, error }
  }
}

export function decodeLegacyClarifyArray<T>(raw: string | null): T[] | undefined {
  const decoded = decodeLegacyClarifyJson(raw)
  return decoded.kind === 'value' && Array.isArray(decoded.value)
    ? (decoded.value as T[])
    : undefined
}

function decodeLegacyClarifyMap<T>(raw: string | null): T | null {
  const decoded = decodeLegacyClarifyJson(raw)
  return decoded.kind === 'value' &&
    decoded.value !== null &&
    typeof decoded.value === 'object' &&
    !Array.isArray(decoded.value)
    ? (decoded.value as T)
    : null
}

export function decodeLegacyClarifyAnswerColumns(columns: {
  answersJson?: string | null
  draftAnswersJson?: string | null
  answerAttributionsJson?: string | null
}) {
  // Each column is decoded only if the reader asks for it. Answer-only readers
  // never parse draft or attribution payloads, and repeated access reuses the projection.
  let decoded: ReturnType<typeof decodeLegacyClarifyJson> | undefined
  const answers = () => (decoded ??= decodeLegacyClarifyJson(columns.answersJson ?? null))
  let projection: ReturnType<typeof projectClarifyAnswers> | undefined
  const answerProjection = () => {
    if (projection === undefined) {
      const value = answers()
      projection = projectClarifyAnswers(
        clarifyAnswerState(
          value.kind === 'value' && Array.isArray(value.value)
            ? (value.value as ClarifyAnswer[])
            : null,
        ),
      )
    }
    return projection
  }
  let drafts: Record<string, ClarifyDraftValue> | null | undefined
  let attributions: ClarifyAnswerAttributions | null | undefined
  const draftAnswers = () =>
    drafts === undefined
      ? (drafts = decodeLegacyClarifyMap<Record<string, ClarifyDraftValue>>(
          columns.draftAnswersJson ?? null,
        ))
      : drafts
  const answerAttributions = () =>
    attributions === undefined
      ? (attributions = decodeLegacyClarifyMap<ClarifyAnswerAttributions>(
          columns.answerAttributionsJson ?? null,
        ))
      : attributions
  return {
    get state() {
      return clarifyAnswerState(answerProjection().answers, draftAnswers(), answerAttributions())
    },
    get answers() {
      return answerProjection().answers
    },
    get draftAnswers() {
      return draftAnswers()
    },
    get answerAttributions() {
      return answerAttributions()
    },
    firstAnswer(questionId: string) {
      return answerProjection().firstAnswer(questionId)
    },
    answerMap(values?: readonly ClarifyAnswer[]) {
      return answerProjection().answerMap(values)
    },
    effectiveAnswers(submitted = answerProjection().answers, values = draftAnswers()) {
      return answerProjection().effectiveAnswers(submitted, values)
    },
    get content(): ClarifyAnswerContent {
      const value = answers()
      if (value.kind === 'absent') return { kind: 'absent' }
      if (value.kind === 'malformed') return { kind: 'malformed', text: value.text }
      const projected = answerProjection().answers
      return projected === null
        ? { kind: 'legacy-value', json: JSON.stringify(value.value) }
        : { kind: 'answers', values: projected }
    },
    get optionalAnswers() {
      return answerProjection().answers ?? undefined
    },
    // REST 历史解析接受任意合法 JSON；service / WS 则只接受数组。
    get detailAnswers() {
      const value = answers()
      return (
        answerProjection().answers ??
        (value.kind === 'value' ? (value.value as ClarifyAnswer[]) : undefined)
      )
    },
    requireAnswers(): ClarifyAnswer[] {
      const value = answers()
      if (value.kind === 'malformed') throw value.error
      return (
        answerProjection().answers ??
        ((value.kind === 'absent' ? [] : value.value) as ClarifyAnswer[])
      )
    },
    requireAnswerMap() {
      return answerProjection().answerMap(this.requireAnswers())
    },
    requireEffectiveAnswers() {
      // follow-up 原先严格 JSON.parse，保留其失败语义。
      const values = decodeLegacyClarifyJson(columns.draftAnswersJson ?? '{}')
      if (values.kind === 'malformed') throw values.error
      const submitted = this.requireAnswers()
      return answerProjection().effectiveAnswers(
        submitted,
        (values.kind === 'value' ? values.value : {}) as Record<string, ClarifyDraftValue>,
      )
    },
  }
}
