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
          expect(prompt).toContain('naming ONE variable in its title')
          expect(prompt).toContain('Audit the full options, including descriptions')
          expect(prompt).toContain('exactly two options "Enable <that mechanism>"')
          expect(prompt).toContain('Neither option decides any other mechanism')
          expect(prompt).toContain('A negative choice does not prescribe a replacement process')
          expect(prompt).toContain('who operates a channel is a separate question')
          expect(prompt).toContain('Each description is ONE short sentence')
          expect(prompt).toContain('Time grid and minimum duration are separate')
          expect(prompt).toContain(
            'Compatible features, sources, criteria or review triggers: kind multi',
          )
          expect(prompt).toContain('no "only", "none" or "no extra collection" option')
          expect(prompt).toContain(
            'Each set concerns ONE axis: features OR data sources OR triggers',
          )
          expect(prompt).toContain('Pilot size is rollout scope, not evidence')
          expect(prompt).toContain('or imply "only manual handling"')
          expect(prompt).toContain(
            'never single-choice "basic / basic plus X / basic plus Y" packages',
          )
          expect(prompt).toContain(
            'Never invent a baseline, main pain point, existing system or automatic data collection',
          )
          expect(prompt).toContain(
            'Success criteria, rollout scope and validation ownership are separate axes',
          )
          expect(prompt).toContain('Separate evidence collection from enforcement')
          expect(prompt).toContain('Do not manufacture exclusivity')
          expect(prompt).toContain('Historical records and new observations can coexist')
          expect(prompt).toContain('a calendar review and a loss-triggered review can coexist')
          expect(prompt).toContain('An evidence-source option must say "if available"')
          expect(prompt).toContain(
            'Preserve explicit decided/provisional status and unmarked maturity',
          )
          if (mode === 'isolated') {
            const example = prompt.slice(
              prompt.indexOf('Format:'),
              prompt.indexOf('</workflow-clarify>'),
            )
            expect(example).toContain('<workflow-clarify nonce="test-nonce">')
            expect(example).toContain('"mindmap": {"categoryPath": ["<meaningful category>"]}')
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
      expect(prompt).toContain('release, sign-in, recording and reminders are independent')
      expect(prompt).toContain('Options may be reordered: no positional references')
      expect(prompt).toContain('Never invent a baseline, main pain point, existing system')
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
