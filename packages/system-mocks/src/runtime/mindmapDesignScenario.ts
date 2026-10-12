// RFC-372: deterministic model boundary for a complete real TaskEngine journey.
// No application API, database, draft, confirmation or output transport is mocked.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { emitClarifyEvent, emitTextEvent, envelope, requireEnvelopeOpen } from './skeleton'

type Question = {
  id: string
  title: string
  kind: 'single' | 'multi'
  options: string[]
  mindmap: { categoryPath: string[] }
}
const question = (
  id: string,
  title: string,
  category: string,
  options: string[],
  multi = false,
): Question => ({
  id,
  title,
  kind: multi ? 'multi' : 'single',
  options,
  mindmap: { categoryPath: [category] },
})
const initial = [
  question('scope', '首期服务哪些预约场景？', '业务范围', ['仅会议室预约', '会议室和工位预约']),
  question('consistency', '预约数据采用哪种一致性？', '数据一致性', ['事务强一致', '最终一致']),
  question(
    'experience',
    '首期支持哪些操作方式？',
    '体验与验收',
    ['桌面浏览器', '移动浏览器', '键盘操作'],
    true,
  ),
]
const review = [
  question('acceptance', '验收场景必须覆盖哪些状态？', '体验与验收', [
    '正常、冲突和恢复',
    '仅正常流程',
  ]),
  question('delivery', '设计文档采用哪种交付形式？', '业务范围', [
    '可实施的 Markdown 设计文档',
    '只有结论摘要',
  ]),
]

function requireText(prompt: string, text: string): void {
  if (!prompt.includes(text))
    throw new Error(`RFC-372 scenario missing real prompt context: ${text}`)
}

export function readScenarioAnswers(prompt: string): Map<string, string> {
  return new Map(
    [...prompt.matchAll(/- Q: ([^\n]+)\n[^\n]*\n {2}Answer: ([^\n]*)/g)].map((match) => [
      match[1]!,
      match[2]!,
    ]),
  )
}

export function renderScenarioDocument(prompt: string): string {
  const answers = readScenarioAnswers(prompt)
  for (const title of [
    ...initial.map((q) => q.title),
    '并发预约如何裁决？',
    '冲突失败后如何提示？',
    '重复提交如何识别？',
  ]) {
    if (!answers.get(title)) throw new Error(`RFC-372 scenario lost confirmed answer: ${title}`)
  }
  return [
    '# 会议室预约系统设计',
    '',
    '## 已确认的设计决策',
    '',
    '| 设计问题 | 用户确认结果 |',
    '| --- | --- |',
    ...[...answers].map(([title, answer]) => `| ${title} | ${answer.replaceAll('|', '\\|')} |`),
    '',
    '## 实施流程',
    '',
    '1. 用户选择会议室和时间段，提交预约请求。',
    '2. 服务端按已确认的一致性与冲突裁决规则保存预约，按幂等规则处理重复提交。',
    '3. 冲突时返回已确认的提示与恢复方式；客户端保留当前输入。',
    '4. 用最终验收清单验证正常、冲突、刷新与取消恢复。',
  ].join('\n')
}

export async function runMindmapDesignScenario(prompt: string, stateDir: string): Promise<void> {
  const log = (kind: string, data: object = {}) =>
    appendFileSync(
      join(stateDir, 'mindmap-journey.ndjson'),
      JSON.stringify({ kind, ...data }) + '\n',
    )
  if (prompt.startsWith('Ask 1–4 consequential follow-up questions')) {
    const request = JSON.parse(prompt.slice(prompt.lastIndexOf('\n\n') + 2)) as {
      branch: {
        question: Question
        answer: { selectedOptionIndices: number[]; customText: string }
      }[]
      guidance: string
      userRequest: string
    }
    const parent = request.branch.at(-1)!
    if (!parent || !parent.answer.selectedOptionIndices.length)
      throw new Error('follow-up lost the selected answer')
    requireText(request.guidance, '最终输出可实施的设计文档')
    log('followup', { request })
    // Faults live only in the model fixture; production still performs real
    // cancellation, protocol validation, error recovery and question appending.
    if (request.userRequest === '验证取消恢复') {
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      throw new Error('canceled model fixture was not terminated')
    }
    if (request.userRequest === '验证失败重试') {
      emitTextEvent('fixture: invalid clarification envelope')
      return
    }
    let questions: Question[]
    switch (parent.question.title) {
      case '预约数据采用哪种一致性？':
        questions = [
          question('concurrency', '并发预约如何裁决？', '数据一致性', [
            '先提交者成功',
            '后提交者覆盖',
          ]),
          question('conflict', '冲突失败后如何提示？', '数据一致性', [
            '返回冲突并建议空闲时段',
            '静默重试',
          ]),
        ]
        break
      case '并发预约如何裁决？':
        if (request.branch.length !== 2) throw new Error('deep follow-up lost its ancestor')
        questions = [
          question('idempotency', '重复提交如何识别？', '数据一致性', ['幂等请求键', '按时间猜测']),
        ]
        break
      case '验收场景必须覆盖哪些状态？':
        questions = [
          question('recovery', '必须验证哪类恢复？', '体验与验收', [
            '刷新与取消恢复',
            '只验证刷新',
          ]),
        ]
        break
      default:
        throw new Error(`unexpected selected branch: ${parent.question.title}`)
    }
    emitClarifyEvent('<workflow-clarify>', JSON.stringify({ questions }))
    return
  }
  const open = requireEnvelopeOpen(prompt, 'rfc372-mindmap-design')
  const answers = readScenarioAnswers(prompt)
  if (prompt.includes('RFC372_DESIGN_REVIEW')) {
    requireText(prompt, '# 会议室预约系统设计')
    if (!answers.size) {
      requireText(prompt, '体验与验收')
      log('cross-questions')
      emitClarifyEvent(open.clarify, JSON.stringify({ questions: review }))
    } else {
      for (const title of [...review.map((q) => q.title), '必须验证哪类恢复？']) {
        if (!answers.get(title)) throw new Error(`cross resume lost answer: ${title}`)
      }
      const draft = /<design-draft>([\s\S]*?)<\/design-draft>/.exec(prompt)?.[1]
      if (!draft) throw new Error('cross resume lost the upstream design')
      // The production prompt wraps upstream ports as aw-input and prefixes
      // Markdown headings. A model reads that content; those transport markers
      // must not leak into the final document produced by this model fixture.
      const design = (
        /<aw-input name="design"[^>]*>([\s\S]*?)<\/aw-input>/.exec(draft)?.[1] ?? draft
      )
        .replace(/^\u200b/gm, '')
        .trim()
      const document =
        design +
        '\n\n## 最终验收与交付\n\n' +
        [...answers].map(([title, answer]) => `- ${title} ${answer}`).join('\n') +
        '\n'
      log('cross-final', { answers: Object.fromEntries(answers), document })
      emitTextEvent(envelope(open.output, [['document', document]]))
    }
  } else {
    requireText(prompt, 'RFC372_DESIGN_DRAFT')
    if (!answers.size) {
      for (const category of ['业务范围', '数据一致性', '体验与验收']) requireText(prompt, category)
      requireText(prompt, '最终输出可实施的设计文档')
      log('self-questions', { directions: initial.map((q) => q.mindmap.categoryPath[0]) })
      emitClarifyEvent(open.clarify, JSON.stringify({ questions: initial }))
    } else {
      const document = renderScenarioDocument(prompt)
      log('self-final', { answers: Object.fromEntries(answers), document })
      emitTextEvent(envelope(open.output, [['design', document]]))
    }
  }
}
