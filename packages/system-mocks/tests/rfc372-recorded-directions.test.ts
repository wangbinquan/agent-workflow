import { expect, test } from 'bun:test'
import recording from '../src/runtime/fixtures/rfc372-real-directions.json'
import { requireDirectionAnswers } from '../src/runtime/recordedDirectionsScenario'

test('recorded category directions require every confirmed answer in the final resume', () => {
  const prompt = recording.questions
    .map((question) => {
      const answer = recording.answers.find((item) => item.questionId === question.id)!
      return `- Q: ${question.title}\n  Kind: single\n  Answer: ${answer.selectedOptionLabels.join('; ')}`
    })
    .join('\n')
  expect(() => requireDirectionAnswers(prompt)).not.toThrow()
  for (const answer of recording.answers) {
    expect(() =>
      requireDirectionAnswers(prompt.replace(answer.selectedOptionLabels[0]!, 'lost choice')),
    ).toThrow(`Recorded directions lost answer: ${answer.questionId}`)
  }
})

test('real direction recording preserves peer, child, root and final document provenance', () => {
  expect(recording.source.taskId).toBe('01M4SZ1T6KTD54544KPDVVT7NX')
  expect(recording.source.finalStatus).toBe('done')
  expect(recording.source.modelMocked).toBe(false)
  expect(recording.source.model).toBe('opencode-go/deepseek-v4.1-flash')
  expect(recording.source.modelRuns).toHaveLength(2)
  expect(recording.questions).toHaveLength(6)
  expect(recording.stages.map((stage) => stage.kind)).toEqual(['category', 'deep', 'root'])
  expect(recording.questions[2]!.mindmap).toEqual({ categoryPath: ['性能'] })
  expect(recording.questions[3]!.mindmap).toEqual({ categoryPath: ['性能'] })
  expect(recording.questions[4]!.mindmap.parentQuestionId).toBe('db-query')
  expect(recording.questions[5]!.mindmap).toEqual({ categoryPath: ['用户体验'] })
  expect(recording.finalDocument.length).toBe(2070)
  for (const decision of ['50 QPS', '连接池', '10%', '一键重试', 'RTO'])
    expect(recording.finalDocument).toContain(decision)
  expect(JSON.stringify(recording)).not.toContain('confirmedBasis')
  expect(JSON.stringify(recording)).not.toContain('requestBasis')
})
