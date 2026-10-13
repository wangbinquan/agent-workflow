// RFC-372: replay of the completed daily AW real-model task, not a synthetic
// acceptance substitute. Stable IDs replace request IDs; product state stays real.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import recording from './fixtures/rfc372-real-mindmap.json'
import { readScenarioAnswers } from './mindmapDesignScenario'
import { emitClarifyEvent, emitTextEvent, envelope, requireEnvelopeOpen } from './skeleton'

export function requireRecordedAnswers(prompt: string, round: 'self' | 'cross'): void {
  const actual = readScenarioAnswers(prompt)
  const expected = recording[round]
  for (const question of expected.questions) {
    const answer = expected.answers.find((item) => item.questionId === question.id)!
    const value = actual.get(question.title)
    if (
      value === undefined ||
      (answer.customText && !value.includes(answer.customText)) ||
      answer.selectedOptionLabels.some((label) => !value.includes(label))
    )
      throw new Error(`Recorded mindmap resume lost the real answer: ${question.id}`)
  }
}

export async function runRecordedMindmapScenario(prompt: string, stateDir: string): Promise<void> {
  const log = (kind: string, detail: object = {}) =>
    appendFileSync(
      join(stateDir, 'recorded-mindmap.ndjson'),
      JSON.stringify({ kind, ...detail }) + '\n',
    )
  if (prompt.startsWith('Ask 1–4 consequential follow-up questions')) {
    const request = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as {
      branch: Array<{ question: { title: string }; answer: { selectedOptionIndices: number[] } }>
      guidance: string
      userRequest: string
    }
    const parent = request.branch.at(-1)
    const first = recording.self.questions[1]!,
      child = recording.self.questions[3]!,
      deep = recording.self.questions[4]!
    if (
      !parent ||
      !request.guidance.includes('祖先回答') ||
      request.branch.some((item) => item.answer.selectedOptionIndices[0] !== 0)
    )
      throw new Error('Recorded follow-up lost the ancestor answers or guidance')
    let question: typeof child
    if (parent.question.title === first.title && request.branch.length === 1) question = child
    else if (
      parent.question.title === child.title &&
      request.branch.length === 2 &&
      request.branch[0]!.question.title === first.title
    )
      question = deep
    else throw new Error('Recorded follow-up has the wrong selected branch or hierarchy')
    const invalid = request.userRequest === recording.hints.invalid
    log(invalid ? 'followup-missing-category' : 'followup', {
      depth: request.branch.length,
      title: question.title,
      instruction: request.userRequest,
    })
    // A brief model-boundary delay also exercises editing another question while
    // production holds the follow-up request; cancellation is covered separately.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const { mindmap, ...content } = question
    emitClarifyEvent(
      '<workflow-clarify>',
      JSON.stringify({
        questions: [
          invalid ? content : { ...content, mindmap: { categoryPath: mindmap.categoryPath } },
        ],
      }),
    )
    return
  }
  const open = requireEnvelopeOpen(prompt, 'rfc372-recorded-mindmap')
  const review = prompt.includes('审阅下列已澄清的设计')
  const round = review ? 'cross' : 'self'
  const questions = recording[round].questions
  const answers = readScenarioAnswers(prompt)
  if (review && !prompt.includes('会议室预约系统'))
    throw new Error('Recorded review lost its upstream document')
  if (!answers.has(questions[0]!.title)) {
    for (const category of ['业务范围', '数据一致性', '体验与验收']) {
      if (!prompt.includes(category))
        throw new Error(`Recorded prompt lost the preset direction: ${category}`)
    }
    log(`${round}-questions`)
    emitClarifyEvent(open.clarify, JSON.stringify({ questions: questions.slice(0, 3) }))
  } else {
    requireRecordedAnswers(prompt, round)
    log(`${round}-final`, { count: questions.length })
    emitTextEvent(
      envelope(open.output, [
        [
          review ? 'document' : 'design',
          review ? recording.finalDocument : recording.draftDocument,
        ],
      ]),
    )
  }
}
