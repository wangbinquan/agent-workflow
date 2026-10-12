// Lock the model fixture to real injected answers: it must not emit an
// unconditional success document when the application drops a deep answer.
import { expect, test } from 'bun:test'
import { readScenarioAnswers, renderScenarioDocument } from '../src/runtime/mindmapDesignScenario'

const answers = [
  ['首期服务哪些预约场景？', '仅会议室预约'],
  ['预约数据采用哪种一致性？', '事务强一致'],
  ['首期支持哪些操作方式？', '桌面浏览器, 移动浏览器'],
  ['并发预约如何裁决？', '先提交者成功'],
  ['冲突失败后如何提示？', '返回冲突并建议空闲时段'],
  ['重复提交如何识别？', '幂等请求键'],
]
const prompt = (rows: string[][]) =>
  '## Clarify Q&A\n' +
  rows
    .map(([q, a]) => `- Q: ${q}\n  Type: single-choice / Options: A, B\n  Answer: ${a}`)
    .join('\n')

test('final design preserves the actual answers including deep follow-up decisions', () => {
  const source = prompt(answers)
  expect(readScenarioAnswers(source).size).toBe(6)
  expect(renderScenarioDocument(source)).toContain('| 重复提交如何识别？ | 幂等请求键 |')
  expect(renderScenarioDocument(source.replace('事务强一致', '最终一致'))).toContain(
    '| 预约数据采用哪种一致性？ | 最终一致 |',
  )
})
test('missing follow-up context cannot silently produce a complete document', () => {
  expect(() => renderScenarioDocument(prompt(answers.slice(0, -1)))).toThrow(
    'lost confirmed answer: 重复提交如何识别？',
  )
})
