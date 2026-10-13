// A recorded model response must never conceal lost answers in the real resume prompt.
import { expect, test } from 'bun:test'
import recording from '../src/runtime/fixtures/rfc372-real-mindmap.json'
import { requireRecordedAnswers } from '../src/runtime/recordedMindmapScenario'

for (const round of ['self', 'cross'] as const) {
  test(`recorded ${round} model requires every actual answer and custom response`, () => {
    const prompt = recording[round].questions
      .map((question) => {
        const answer = recording[round].answers.find((a) => a.questionId === question.id)!
        return `- Q: ${question.title}\n  Kind: single\n  Answer: ${[...answer.selectedOptionLabels, answer.customText].filter(Boolean).join('; ')}`
      })
      .join('\n')
    expect(() => requireRecordedAnswers(prompt, round)).not.toThrow()
    const custom = recording[round].answers.find((a) => a.customText)!.customText
    expect(() =>
      requireRecordedAnswers(prompt.replace(custom, 'lost custom input'), round),
    ).toThrow('lost the real answer')
    const option = recording[round].answers.find((a) => a.selectedOptionLabels.length)!
      .selectedOptionLabels[0]!
    expect(() => requireRecordedAnswers(prompt.replace(option, 'wrong choice'), round)).toThrow(
      'lost the real answer',
    )
  })
}
test('recording links the genuine completed task and retains rich text and two follow-up levels', () => {
  expect(recording.source.taskId).toBe('01M4SK0C3RQH0FPWSBQHER3FES')
  expect(recording.source.model).toBe('opencode-go/deepseek-v4.1-flash')
  expect(recording.source.finalStatus).toBe('done')
  expect(recording.self.questions[4]!.mindmap.parentQuestionId).toBe(
    recording.self.questions[3]!.id,
  )
  expect(recording.self.questions[3]!.mindmap.parentQuestionId).toBe(
    recording.self.questions[1]!.id,
  )
  expect(recording.self.questions[0]!.options[0]!.description.length).toBeGreaterThan(60)
  expect(recording.finalDocument.length).toBe(29038)
  expect(recording.finalDocument).toContain('Idempotency-Key')
  expect(JSON.stringify(recording)).not.toContain('confirmedBasis')
})
