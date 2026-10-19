import { describe, expect, test } from 'bun:test'
import {
  ClarifyRoundSchema,
  ClarifyAnswerSchema,
  ClarifyDraftSaveBodySchema,
  ClarifyDraftValueSchema,
  ClarifyQuestionSchema,
  CLARIFY_FORMAT_EXAMPLE,
  CLARIFY_STRUCTURAL_RULES,
  CLARIFY_MINDMAP_QUESTION_GUIDANCE,
  buildClarifyProtocolBlock,
  buildMandatoryClarifyPreamble,
  buildOptionalDualProtocolBlock,
  clarifyFormatExample,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyFollowupContext,
  isClarifyAnswerConfirmed,
  normalizeClarifyDecision,
  parseClarifyEnvelopeBody,
  renderFlatClarifyQueue,
  renderUserPrompt,
  summariseClarifyAnswer,
  summariseCrossAnswer,
  type ClarifyAnswer,
} from '../src'

const q = ClarifyQuestionSchema.parse({
  id: 'q',
  title: 'Limit bookings?',
  kind: 'single',
  options: ['Limit', 'Observe first'],
  mindmap: { categoryPath: ['Scope'] },
})
const decision = {
  status: 'provisional' as const,
  rationale: 'We have no baseline.',
  tradeoff: 'Some conflicts may remain.',
  uncertainty: 'No-show rate unknown.',
  validationOwner: 'Lin',
  revisitWhen: 'After one week of observations',
}
const answer: ClarifyAnswer = {
  questionId: q.id,
  selectedOptionIndices: [1],
  selectedOptionLabels: ['Observe first'],
  customText: '',
  decision,
}

describe('RFC-378 optional decision contract', () => {
  // CI 39274464447: expanded guidance pushed the real recorded review prompt
  // beyond Windows argv limits (32,770 chars, ENAMETOOLONG). Keep this added
  // instruction budget bounded; the recorded E2E retains the full long document.
  test('question guidance leaves room for the existing long-document review', () => {
    expect(CLARIFY_MINDMAP_QUESTION_GUIDANCE.length).toBeLessThan(2800)
  })
  // The tenth real model sample still bundled detection and enforcement despite
  // abstract instructions. The production example now demonstrates actual valid
  // independent alternatives and a compatible multi-select, rather than a
  // one-option pseudo-JSON template. Validate the literal example we send.
  test('mindmap examples parse as independent mechanisms, parameter values and compatible multi questions', () => {
    for (const nonce of [undefined, 'test-nonce']) {
      const example = clarifyFormatExample(nonce, true)
      const body = example.slice(
        example.indexOf('>\n') + 2,
        example.lastIndexOf('</workflow-clarify>'),
      )
      const result = parseClarifyEnvelopeBody(body, { mindmap: true })
      expect(result.errors).toEqual([])
      expect(result.warnings).toEqual([])
      const questions = result.body!.questions
      expect(questions.map((question) => question.kind)).toEqual(['single', 'single', 'multi'])
      expect(questions.map((question) => question.options.length)).toEqual([2, 2, 2])
      expect(questions.every((question) => question.mindmap?.categoryPath.length === 1)).toBe(true)
      expect(questions[0]!.options.map((option) => option.label)).toEqual([
        '启用到期提醒',
        '不启用到期提醒',
      ])
      expect(questions[0]!.options[0]!.description).toContain('渠道和时机另定')
      expect(questions[0]!.options[1]!.description).toContain('其他措施未定')
      expect(questions[2]!.options[0]!.description).toContain('需先建立可比基线')
      expect(questions[2]!.options[1]!.description).toContain('不能代替效果证据')
      expect(questions[1]!.options.map((option) => option.label)).toEqual([
        '全天时段',
        '固定高峰时段',
      ])
      expect(
        questions[1]!.options.every((option) => option.description.includes('记录时机另定')),
      ).toBe(true)
      const added = CLARIFY_MINDMAP_QUESTION_GUIDANCE + example
      // Quotes also expand in the Windows command line; the concrete examples
      // must fit the old combined guidance/example budget, not merely each part.
      expect(added.length + (added.match(/"/g)?.length ?? 0)).toBeLessThan(3350)
    }
  })
  // Real acceptance still bundled compatible measures and missed categoryPath:
  // the generic preamble contradicted mindmap guidance, and its example omitted
  // the required metadata. Assert the whole composed prompt, not only its tail.
  test('mindmap mandatory/optional self/cross prompts have consistent examples and maturity rules', () => {
    for (const kind of ['self', 'cross'] as const) {
      for (const directive of ['mandatory', 'optional'] as const) {
        for (const mode of ['isolated', 'inline'] as const) {
          const prompt = renderUserPrompt({
            promptTemplate: 'Clarify the requirement',
            inputs: {},
            meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
            agentOutputs: ['result'],
            envelopeNonce: 'test-nonce',
            clarifyChannel: { kind, directive, injectStopNotice: false },
            clarifyContext: { mode },
            clarifyMindmap: { categories: [], instructions: '' },
          })
          expect(prompt).not.toContain('Batch closely-related points into one question')
          expect(prompt).not.toContain('Treat every listed answer as an already-resolved decision')
          expect(prompt).not.toContain('Treat every unstated detail as a blocker')
          expect(prompt).not.toContain('each decision needed to do it correctly is settled')
          expect(prompt).not.toContain('The moment you catch yourself hedging')
          expect(prompt).toContain(CLARIFY_MINDMAP_QUESTION_GUIDANCE)
          for (const rule of [
            'values of ONE variable named in the title',
            'Allocation order, quotas and approval are independent',
            'time grid/minimum duration and channel/operator',
            'Neither option decides any other mechanism',
            'A negative choice does not prescribe a replacement process',
            'Multi: compatible additions on ONE axis',
            'Success criteria and evidence sources remain multi after choosing a primary goal',
            'single needs an explicitly named primary criterion',
            'No exclusive feature bundles or none/only/no-extra option',
            'Pilot size is scope, not evidence',
            'History/observations and scheduled/event-triggered reviews can coexist',
            'Review does not activate policy',
            'Evidence source, coverage window and recording time are separate',
            'Scheduled logs and event reports can coexist',
            'not proof the chosen goal is wrong',
            'or prove causality',
            'no added commitments or positional references',
            'Recommend only with a specific assumption and cost',
            'Never invent a baseline, main pain point, existing system or automatic collection',
            'Unknown source availability needs "if available"',
            'Preserve explicit decided/provisional status and unmarked maturity',
            'Unknown is not no/disabled/rejected',
          ])
            expect(prompt).toContain(rule)
          expect(prompt).toContain(
            'start with problem priority, observable success and feasible evidence',
          )
          expect(prompt).toContain('Honor a specific tradeoff requested by the user')
          expect(prompt).toContain('Selecting an option must leave other variables undecided')
          expect(prompt).not.toContain('"categoryPath":["Category","Subcategory"]')
          if (mode === 'isolated') {
            const example = prompt.slice(
              prompt.indexOf('Format:'),
              prompt.indexOf('</workflow-clarify>'),
            )
            expect(example).toContain('<workflow-clarify nonce="test-nonce">')
            expect(example).toContain('"kind": "single"')
            expect(example).toContain('"kind": "multi"')
            expect(example).toContain('渠道和时机另定')
            expect(example).toContain('其他措施未定')
            expect(example).toContain('用哪些结果判断方案有效？')
            expect(example).toContain('若遗漏会造成明显损失')
            expect(example).not.toContain('why the user should pick this one')
            expect(prompt).toContain('Confirmed answers may still be provisional or unmarked')
            if (directive === 'mandatory') {
              expect(prompt).toContain('never combine separate decisions to fit the limit')
              expect(prompt).toContain('A user-stated TBD is valid content')
              expect(prompt).toContain(
                'settled maturity and assigned validation owners are not prerequisites',
              )
              expect(prompt).not.toContain('<port name="result">')
            } else {
              expect(prompt).toContain('Option B — finalize')
              expect(prompt).toContain('<port name="result">')
            }
          }
        }
      }
    }
  })
  test('ordinary clarify builder defaults retain their legacy example and rules', () => {
    expect(buildMandatoryClarifyPreamble()).toBe(buildMandatoryClarifyPreamble(false))
    expect(buildMandatoryClarifyPreamble()).toContain(
      'Batch closely-related points into one question',
    )
    expect(buildMandatoryClarifyPreamble()).toContain('Treat every unstated detail as a blocker')
    expect(buildMandatoryClarifyPreamble()).toContain('The moment you catch yourself hedging')
    expect(CLARIFY_FORMAT_EXAMPLE).toBe(clarifyFormatExample(undefined, false))
    expect(CLARIFY_FORMAT_EXAMPLE).not.toContain('mindmap')
    for (const nonce of [undefined, 'test-nonce']) {
      const mandatory = buildClarifyProtocolBlock(nonce)
      expect(mandatory).toBe(buildClarifyProtocolBlock(nonce, false))
      const optional = buildOptionalDualProtocolBlock(['result'], undefined, nonce)
      expect(optional).toBe(
        buildOptionalDualProtocolBlock(['result'], undefined, nonce, undefined, false),
      )
      for (const protocol of [mandatory, optional]) {
        expect(protocol).toContain(CLARIFY_STRUCTURAL_RULES)
        expect(protocol).toContain('Treat every listed answer as an already-resolved decision')
        expect(protocol).not.toContain('categoryPath')
      }
    }
  })
  // Real acceptance exposed compatible measures rendered as exclusive choices
  // and positional option labels broken by recommendation-first presentation.
  test('initial self/cross questions carry independent-option and evidence constraints', () => {
    for (const kind of ['self', 'cross'] as const) {
      const prompt = renderUserPrompt({
        promptTemplate: 'Clarify the requirement',
        inputs: {},
        meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
        agentOutputs: ['result'],
        clarifyChannel: { kind, directive: 'mandatory', injectStopNotice: false },
        clarifyMindmap: { categories: [], instructions: '' },
      })
      expect(prompt).toContain(CLARIFY_MINDMAP_QUESTION_GUIDANCE)
      expect(prompt).toContain('Allocation order, quotas and approval are independent')
      expect(prompt).toContain('Unknown source availability needs "if available"')
      expect(prompt).toContain('Every question requires a non-empty mindmap.categoryPath')
      expect(prompt).toContain('even with a parent')
    }
  })
  test('all answer and draft schemas preserve independent notes without inventing a status', () => {
    expect(ClarifyAnswerSchema.parse(answer).decision).toEqual(decision)
    expect(ClarifyDraftSaveBodySchema.parse({ ...answer, roundId: 'round' }).decision).toEqual(
      decision,
    )
    expect(ClarifyDraftValueSchema.parse(answer).decision).toEqual(decision)
    expect(ClarifyRoundSchema.shape.draftAnswers.parse({ q: answer })?.q?.decision).toEqual(
      decision,
    )
    expect(
      ClarifyAnswerSchema.parse({ ...answer, decision: { uncertainty: 'Unknown' } }).decision,
    ).toEqual({ uncertainty: 'Unknown' })
    expect(
      ClarifyAnswerSchema.parse({ ...answer, decision: { rationale: '  ' } }).decision,
    ).toBeUndefined()
    expect(
      ClarifyAnswerSchema.safeParse({ ...answer, decision: { validationOwner: 'x'.repeat(201) } })
        .success,
    ).toBe(false)
    expect(
      ClarifyAnswerSchema.safeParse({ ...answer, decision: { tradeoff: 'x'.repeat(2001) } })
        .success,
    ).toBe(false)
    expect(normalizeClarifyDecision(undefined)).toBeUndefined()
  })
  test('legacy confirmation stays byte identical; every meaningful decision edit invalidates it', () => {
    const old = { ...answer, decision: undefined }
    const basis = clarifyContentKey([q, [1], ''])
    expect(clarifyAnswerBasis(q, old)).toBe(basis)
    expect(clarifyAnswerBasis(q, { ...old, decision: {} })).toBe(basis)
    expect(isClarifyAnswerConfirmed(q, { ...old, confirmedBasis: basis })).toBe(true)
    const confirmed = { ...answer, confirmedBasis: clarifyAnswerBasis(q, answer) }
    for (const field of [
      'status',
      'rationale',
      'tradeoff',
      'uncertainty',
      'validationOwner',
      'revisitWhen',
    ] as const) {
      const next = {
        ...confirmed,
        decision: { ...decision, [field]: field === 'status' ? 'decided' : 'changed' },
      } as ClarifyAnswer
      expect(isClarifyAnswerConfirmed(q, next)).toBe(false)
    }
    expect(isClarifyAnswerConfirmed(q, confirmed)).toBe(true)
  })
  test('branch and category contexts both carry decisions, invalidating an outstanding follow-up basis', () => {
    for (const target of ['q', ['Scope']]) {
      const before = clarifyFollowupContext([q], { q: answer }, target)
      expect(before[0]?.answer.decision).toEqual(decision)
      const after = clarifyFollowupContext(
        [q],
        { q: { ...answer, decision: { ...decision, uncertainty: 'Changed' } } },
        target,
      )
      expect(clarifyContentKey(before)).not.toBe(clarifyContentKey(after))
    }
  })
  test('self and cross prompts retain every original decision field and scope final guidance to mindmaps', () => {
    const summary = summariseClarifyAnswer(q, answer)
    for (const value of Object.values(decision)) expect(summary).toContain(value)
    expect(summariseCrossAnswer(q, answer)).toBe(summary)
    const input = {
      promptTemplate: 'Design',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['result'],
      clarifyChannel: { kind: 'self', directive: 'stopped', injectStopNotice: true },
    } as const
    const ordinary = renderUserPrompt(input)
    const mindmap = renderUserPrompt({
      ...input,
      clarifyMindmap: { categories: [], instructions: '' },
    })
    expect(ordinary).not.toContain('invent evidence')
    expect(mindmap).toContain('invent evidence')
    expect(mindmap).toContain('unnamed owner')
    expect(mindmap).toContain('Unmarked answers remain unmarked')
    expect(mindmap).toContain('model-inferred consequences separately')
    expect(mindmap).toContain('Maturity labels and validation arrangements are optional')
    expect(mindmap).toContain('Do not invent a requirement to mark every choice')
    expect(mindmap).toContain(
      'Missing, unselected and explicitly rejected are three different states',
    )
    expect(mindmap).toContain('including any later reference')
    expect(mindmap).toContain('make unresolved premises conditional')
    expect(mindmap).toContain('"reminders are undecided" must not become "no reminders"')
    expect(mindmap).toContain('ONE entry per answer')
    expect(mindmap).toContain('do not add a second scope list')
    expect(mindmap).toContain('Finish the requested output envelope')
    expect(mindmap).not.toContain('Every question must include mindmap')
  })
  // Fifth real acceptance exhausted 32k reasoning tokens while repeatedly
  // rewriting the same decision document. Bound the shared instructions and
  // provide a direct readback format instead of accumulating recursive audits.
  test('stopped self/cross mindmap prompts give one bounded readback, without question authoring rules', () => {
    for (const kind of ['self', 'cross'] as const) {
      const input = {
        promptTemplate: 'Write the decision document',
        inputs: {},
        meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
        agentOutputs: ['result'],
        clarifyChannel: { kind, directive: 'stopped' as const, injectStopNotice: true },
      }
      const ordinary = renderUserPrompt(input)
      const mindmap = renderUserPrompt({
        ...input,
        clarifyMindmap: { categories: [], instructions: '' },
      })
      expect(mindmap).toContain('ONE entry per answer')
      expect(mindmap).toContain('original choice and original decision notes')
      expect(mindmap).toContain('retain TBD owners and timing as open arrangements')
      expect(mindmap).not.toContain('Build a short set of independent decisions')
      expect(mindmap).not.toContain('check EVERY factual or policy claim')
      expect(mindmap.length - ordinary.length).toBeLessThan(2500)
      expect(ordinary).not.toContain('ONE entry per answer')
    }
  })
  // Fourth real output imported calendar/reminder policies from rejected options
  // despite preserving the custom answer verbatim. The authoritative flat Q&A
  // must carry selected content without reintroducing those proposed packages.
  test('mindmap continuation preserves selected and custom wording without rejected proposals', () => {
    const question = ClarifyQuestionSchema.parse({
      id: 'release',
      title: 'Enable automatic release?',
      kind: 'single',
      options: [
        { label: 'No release, with reminders', recommended: true },
        { label: 'Release after sign-in timeout' },
      ],
      mindmap: { categoryPath: ['Policy'] },
    })
    const custom: ClarifyAnswer = {
      questionId: question.id,
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      customText: '首版暂不自动释放；签到、记录和提醒均未决定。',
      decision: {
        status: 'provisional',
        uncertainty: '没有使用基线；负责人尚未商定。',
        revisitWhen: '两周后复核，具体日期待定。',
      },
    }
    for (const kind of ['self', 'cross'] as const) {
      const prompt = renderUserPrompt({
        promptTemplate: 'Write the decision document',
        inputs: {},
        meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
        agentOutputs: ['result'],
        clarifyChannel: { kind, directive: 'stopped', injectStopNotice: true },
        clarifyMindmap: { categories: [], instructions: '' },
        clarifyContext: {
          flatBlock: renderFlatClarifyQueue([{ question, answer: custom }]),
        },
      })
      expect(prompt).toContain(question.title)
      expect(prompt).toContain(custom.customText)
      for (const value of Object.values(custom.decision!)) expect(prompt).toContain(value)
      for (const option of question.options) expect(prompt).not.toContain(option.label)
      expect(prompt).not.toContain('[recommended]')
    }
    const selected = {
      ...custom,
      selectedOptionIndices: [1],
      selectedOptionLabels: [question.options[1]!.label],
      customText: '',
    }
    const block = renderFlatClarifyQueue([{ question, answer: selected }])!
    expect(block).toContain(`User chose: "${question.options[1]!.label}"`)
    expect(block).not.toContain(question.options[0]!.label)
    const ordinary = renderFlatClarifyQueue([
      { question: { ...question, mindmap: undefined }, answer: custom },
    ])!
    expect(ordinary).toContain(
      'Options: No release, with reminders [recommended], Release after sign-in timeout',
    )
  })
  // Real final output promoted confirmed, unmarked answers into "decided".
  // Both prompt paths must explicitly retain absence instead of asking the model to infer it.
  test('mindmap summaries carry unmarked maturity while ordinary answers stay unchanged', () => {
    for (const notes of [undefined, {}, { uncertainty: 'Still unknown' }]) {
      const unmarked = { ...answer, decision: notes }
      for (const summarize of [summariseClarifyAnswer, summariseCrossAnswer]) {
        const summary = summarize(q, unmarked)
        expect(summary).toContain('Decision status: "unmarked"')
        expect(summary).not.toContain('Decision status (user marked)')
        if (notes?.uncertainty) expect(summary).toContain(notes.uncertainty)
        expect(summarize({ ...q, mindmap: undefined }, { ...unmarked, decision: undefined })).toBe(
          'User chose: "Observe first"',
        )
      }
    }
    expect(summariseClarifyAnswer(q, answer)).not.toContain('"unmarked"')
  })
})
