import {
  clarifyQuestionSetKey,
  validateClarifyMindmap,
  type ClarifyQuestion,
} from '@agent-workflow/shared'

/** II-a 用题集 key 表达 questions_revision；II-b 将在 round 上存储递增 revision。 */
export function clarifyQuestionsRevision(questions: readonly ClarifyQuestion[]) {
  return { questions, key: clarifyQuestionSetKey(questions) }
}

export function duplicateClarifyQuestionIds(questions: readonly ClarifyQuestion[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const question of questions) {
    if (seen.has(question.id)) duplicates.add(question.id)
    seen.add(question.id)
  }
  return [...duplicates]
}

/** 只追加：既有题目对象与顺序原样保留；旧快照的重复 id 由源转换器逐项处置。 */
export function appendClarifyQuestions(
  current: ReturnType<typeof clarifyQuestionsRevision>,
  additions: readonly ClarifyQuestion[],
) {
  const questions = [...current.questions, ...additions]
  return {
    ...clarifyQuestionsRevision(questions),
    previousKey: current.key,
    duplicateIds: duplicateClarifyQuestionIds(questions),
    error: validateClarifyMindmap(questions, true),
  }
}
