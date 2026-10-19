// Model-boundary replay derived from the second daily AW acceptance task.
// The application, append transactions, answers and task continuation remain real.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import recording from './fixtures/rfc372-real-directions.json'
import { readScenarioAnswers } from './mindmapDesignScenario'
import { emitClarifyEvent, emitTextEvent, envelope, requireEnvelopeOpen } from './skeleton'

interface DirectionRecording {
  initialQuestionCount?: number
  configuredCategoryPaths?: string[][]
  questions: Array<{ id: string; title: string; mindmap: { categoryPath: string[] } }>
  answers: Array<{
    questionId: string
    selectedOptionIndices: number[]
    selectedOptionLabels: string[]
    customText: string
  }>
  stages: Array<{
    kind: string
    categoryPath: string[] | null
    instruction: string
    contextQuestionIds: string[]
    questionIds: string[]
  }>
  finalDocument: string
}

export function requireDirectionAnswers(
  prompt: string,
  fixture: DirectionRecording = recording,
): void {
  const actual = readScenarioAnswers(prompt)
  for (const question of fixture.questions) {
    const answer = fixture.answers.find((item) => item.questionId === question.id)!
    const value = actual.get(question.title)
    if (
      !value ||
      answer.selectedOptionLabels.some((label) => !value.includes(label)) ||
      (answer.customText && !value.includes(answer.customText))
    )
      throw new Error(`Recorded directions lost answer: ${question.id}`)
  }
}
export async function runRecordedDirectionsScenario(
  prompt: string,
  stateDir: string,
  fixture: DirectionRecording = recording,
  logName = 'recorded-directions.ndjson',
): Promise<void> {
  const log = (kind: string) =>
    appendFileSync(join(stateDir, logName), JSON.stringify({ kind }) + '\n')
  if (
    fixture.configuredCategoryPaths &&
    !readScenarioAnswers(prompt).size &&
    (!prompt.includes('non-empty mindmap.categoryPath array') ||
      !prompt.includes('Preserve configured names/ancestry') ||
      !prompt.includes('Empty focus notes keep these defaults'))
  )
    throw new Error('Missing built-in question guidance with empty business notes')
  if (prompt.startsWith('Ask 1–4 consequential follow-up questions')) {
    const request = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as {
      categoryPath?: string[]
      configuredCategoryPaths?: string[][]
      branch: Array<{ question: { title: string }; answer: { selectedOptionIndices: number[] } }>
      userRequest: string
    }
    if (
      fixture.configuredCategoryPaths &&
      JSON.stringify(request.configuredCategoryPaths) !==
        JSON.stringify(fixture.configuredCategoryPaths)
    )
      throw new Error('Follow-up lost configured category ancestry')
    const stage = fixture.stages.find((item) => item.instruction === request.userRequest)
    if (!stage) throw new Error('Unknown recorded direction')
    if (JSON.stringify(request.categoryPath ?? null) !== JSON.stringify(stage.categoryPath))
      throw new Error('Direction attached to wrong category or question')
    const expected = stage.contextQuestionIds.map(
      (id) => fixture.questions.find((q) => q.id === id)!,
    )
    if (
      JSON.stringify(request.branch.map((item) => item.question.title)) !==
      JSON.stringify(expected.map((q) => q.title))
    )
      throw new Error('Direction lost its complete branch context')
    for (const item of request.branch) {
      const question = fixture.questions.find((q) => q.title === item.question.title)!
      const answer = fixture.answers.find((a) => a.questionId === question.id)!
      if (
        JSON.stringify(item.answer.selectedOptionIndices) !==
        JSON.stringify(answer.selectedOptionIndices)
      )
        throw new Error('Direction lost confirmed choices')
    }
    log(stage.kind)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    emitClarifyEvent(
      '<workflow-clarify>',
      JSON.stringify({
        questions: stage.questionIds.map((id) => {
          const question = fixture.questions.find((q) => q.id === id)!
          return { ...question, mindmap: { categoryPath: question.mindmap!.categoryPath } }
        }),
      }),
    )
    return
  }
  const open = requireEnvelopeOpen(prompt, 'rfc372-recorded-directions')
  if (!readScenarioAnswers(prompt).has(fixture.questions[0]!.title)) {
    for (const path of fixture.configuredCategoryPaths ?? [])
      if (!prompt.includes(JSON.stringify(path)))
        throw new Error('Initial questions lost configured category ancestry')
    for (const category of ['性能', '可靠性'])
      if (!prompt.includes(category)) throw new Error('Missing preset direction')
    log('initial')
    emitClarifyEvent(
      open.clarify,
      JSON.stringify({ questions: fixture.questions.slice(0, fixture.initialQuestionCount ?? 2) }),
    )
  } else {
    requireDirectionAnswers(prompt, fixture)
    log('final')
    emitTextEvent(envelope(open.output, [['design', fixture.finalDocument]]))
  }
}
