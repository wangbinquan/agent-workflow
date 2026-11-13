// RFC-490 (design/RFC-490-mindmap-guided-thinking-and-panorama/design.md §2.1–§2.4):
// a mindmap question can be skipped as "not applicable" or "decide later". Both are
// decision statuses, so every surface that already carries `decision` carries them.
// This file protects what had to change in shared:
//   §2.1 the four status values and the skip predicate;
//   §2.2 the one ruling "a real answer wins over a skip status", and the validity and
//        confirmation basis that follow from it;
//   §2.3 the answer wording the agent reads and the two short prompt sentences
//        (the third sentence lives in the backend follow-up prompt and is covered there);
//   §2.4 the saved origin of generated questions.
import { describe, expect, test } from 'bun:test'
import {
  CLARIFY_DECISION_OUTPUT_GUIDANCE,
  CLARIFY_MINDMAP_QUESTION_GUIDANCE,
  CLARIFY_STRUCTURAL_RULES,
  ClarifyAnswerSchema,
  ClarifyDraftSaveBodySchema,
  ClarifyDraftValueSchema,
  ClarifyQuestionSchema,
  ClarifyRoundSchema,
  buildClarifyProtocolBlock,
  buildOptionalDualProtocolBlock,
  clarifyAnswerBasis,
  clarifyContentKey,
  clarifyFollowupContext,
  clarifyQuestionSetKey,
  clarifySkipStatus,
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  isClarifySkipStatus,
  renderFlatClarifyQueue,
  renderUserPrompt,
  summariseClarifyAnswer,
  summariseCrossAnswer,
  withoutStaleClarifySkip,
  type ClarifyAnswer,
} from '../src'

const single = ClarifyQuestionSchema.parse({
  id: 'q',
  title: 'Which replica lag is acceptable?',
  kind: 'single',
  options: ['Seconds', 'Minutes'],
  mindmap: { categoryPath: ['Performance'] },
})
const multi = ClarifyQuestionSchema.parse({ ...single, id: 'm', kind: 'multi' })
const empty: ClarifyAnswer = {
  questionId: 'q',
  selectedOptionIndices: [],
  selectedOptionLabels: [],
  customText: '',
}
const SKIPS = ['deferred', 'not-applicable'] as const
const skipped = (status: (typeof SKIPS)[number], rationale?: string): ClarifyAnswer => ({
  ...empty,
  decision: { status, ...(rationale ? { rationale } : {}) },
})

describe('RFC-490 §2.1 decision status values', () => {
  test('every answer and draft schema round-trips all four statuses and rejects any other', () => {
    for (const status of ['decided', 'provisional', ...SKIPS] as const) {
      const decision = { status, rationale: 'No replica in the first release' }
      const value = { ...empty, decision }
      expect(ClarifyAnswerSchema.parse(value).decision).toEqual(decision)
      expect(ClarifyDraftValueSchema.parse(value).decision).toEqual(decision)
      expect(ClarifyDraftSaveBodySchema.parse({ ...value, roundId: 'r' }).decision).toEqual(
        decision,
      )
      expect(ClarifyRoundSchema.shape.draftAnswers.parse({ q: value })?.q?.decision).toEqual(
        decision,
      )
      // A status alone is meaningful content; it is not normalised away.
      expect(ClarifyAnswerSchema.parse({ ...empty, decision: { status } }).decision).toEqual({
        status,
      })
    }
    for (const status of ['skipped', 'not_applicable', 'later', ''])
      expect(ClarifyAnswerSchema.safeParse({ ...empty, decision: { status } }).success).toBe(false)
  })

  test('only the two skip statuses are skip statuses', () => {
    for (const status of SKIPS) expect(isClarifySkipStatus(status)).toBe(true)
    for (const status of ['decided', 'provisional', 'unmarked', '', undefined, null, 0, {}])
      expect(isClarifySkipStatus(status)).toBe(false)
  })
})

describe('RFC-490 §2.2 a real answer wins over a skip status', () => {
  test('an answer that needs no change comes back as the same reference', () => {
    const withNote = skipped('not-applicable', 'Keep this note')
    const blankText = { ...skipped('deferred'), customText: '   ' }
    const decided = {
      ...empty,
      selectedOptionIndices: [0],
      decision: { status: 'decided' as const, rationale: 'Measured' },
    }
    const notesOnly = { ...empty, customText: 'Five minutes', decision: { tradeoff: 'Slower' } }
    const plain = { ...empty, selectedOptionIndices: [1] }
    for (const answer of [empty, withNote, blankText, decided, notesOnly, plain])
      expect(withoutStaleClarifySkip(answer)).toBe(answer)
  })

  test('a selected option or written text drops only the status and keeps every note', () => {
    for (const status of SKIPS) {
      const notes = {
        rationale: 'Keep this note',
        tradeoff: 'Accepted cost',
        uncertainty: 'Unknown load',
        validationOwner: 'Lin',
        revisitWhen: 'After the pilot',
      }
      const stale = { ...empty, selectedOptionIndices: [1], decision: { status, ...notes } }
      const canonical = withoutStaleClarifySkip(stale)
      expect(canonical).not.toBe(stale)
      expect(canonical).toEqual({ ...empty, selectedOptionIndices: [1], decision: notes })
      // The input is left as it was.
      expect(stale.decision.status).toBe(status)
      const written = withoutStaleClarifySkip({ ...skipped(status), customText: 'Five minutes' })
      expect(written).toEqual({ ...empty, customText: 'Five minutes' })
      // Nothing is left of the decision, so the key itself is gone.
      expect('decision' in written).toBe(false)
      expect(
        'decision' in
          withoutStaleClarifySkip({
            ...empty,
            selectedOptionIndices: [0],
            decision: { status, rationale: '  ' },
          }),
      ).toBe(false)
    }
  })

  test('other fields of the answer pass through untouched, in both answer shapes', () => {
    const sealed = withoutStaleClarifySkip({
      ...skipped('deferred', 'Why'),
      selectedOptionIndices: [0],
      selectedOptionLabels: ['Seconds'],
      confirmedBasis: 'v2:basis',
    })
    expect(sealed).toEqual({
      questionId: 'q',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['Seconds'],
      customText: '',
      confirmedBasis: 'v2:basis',
      decision: { rationale: 'Why' },
    })
    // A draft value has no questionId or labels; the same function serves it.
    expect(
      withoutStaleClarifySkip({
        selectedOptionIndices: [],
        customText: 'Own answer',
        decision: { status: 'not-applicable' as const },
      }),
    ).toEqual({ selectedOptionIndices: [], customText: 'Own answer' })
  })

  test('the skip status in effect is reported only without a real answer', () => {
    for (const status of SKIPS) {
      expect(clarifySkipStatus(skipped(status))).toBe(status)
      expect(clarifySkipStatus(skipped(status, 'Note'))).toBe(status)
      expect(clarifySkipStatus({ ...skipped(status), customText: ' \n ' })).toBe(status)
      expect(clarifySkipStatus({ ...skipped(status), selectedOptionIndices: [0] })).toBeUndefined()
      expect(clarifySkipStatus({ ...skipped(status), customText: 'x' })).toBeUndefined()
    }
    expect(clarifySkipStatus(undefined)).toBeUndefined()
    expect(clarifySkipStatus(empty)).toBeUndefined()
    expect(clarifySkipStatus({ ...empty, decision: { rationale: 'note only' } })).toBeUndefined()
    for (const status of ['decided', 'provisional'] as const)
      expect(clarifySkipStatus({ ...empty, decision: { status } })).toBeUndefined()
    // Agrees with the canonical form: what the ruling drops is never reported as in effect.
    const stale = { ...skipped('deferred'), selectedOptionIndices: [1] }
    expect(clarifySkipStatus(withoutStaleClarifySkip(stale))).toBeUndefined()
  })

  test('a skip in effect is a valid answer; a skip status next to an answer is judged as that answer', () => {
    for (const question of [single, multi]) {
      for (const status of SKIPS) {
        expect(isClarifyAnswerValid(question, skipped(status))).toBe(true)
        expect(isClarifyAnswerValid(question, skipped(status, 'Not in this release'))).toBe(true)
        // Ordinary rule: a valid choice or written text is a valid answer…
        expect(
          isClarifyAnswerValid(question, { ...skipped(status), selectedOptionIndices: [0] }),
        ).toBe(true)
        expect(isClarifyAnswerValid(question, { ...skipped(status), customText: 'x' })).toBe(true)
        // …and an invalid one stays invalid; the stale status does not rescue it.
        expect(
          isClarifyAnswerValid(question, { ...skipped(status), selectedOptionIndices: [5] }),
        ).toBe(false)
        expect(
          isClarifyAnswerValid(question, { ...skipped(status), selectedOptionIndices: [0, 0] }),
        ).toBe(false)
      }
    }
    expect(
      isClarifyAnswerValid(single, {
        ...skipped('deferred'),
        selectedOptionIndices: [0],
        customText: 'also written',
      }),
    ).toBe(false)
    // Unchanged: nothing at all is still unanswered, notes alone do not answer.
    expect(isClarifyAnswerValid(single, empty)).toBe(false)
    expect(isClarifyAnswerValid(single, { ...empty, decision: { rationale: 'note only' } })).toBe(
      false,
    )
    expect(isClarifyAnswerValid(single, { ...empty, decision: { status: 'decided' } })).toBe(false)
    expect(isClarifyAnswerValid(single, { ...empty, selectedOptionIndices: [1] })).toBe(true)
  })

  test('a skip is confirmed against its own status and note', () => {
    for (const status of SKIPS) {
      const answer = skipped(status, 'Waiting for the capacity test')
      const confirmed = { ...answer, confirmedBasis: clarifyAnswerBasis(single, answer) }
      expect(isClarifyAnswerConfirmed(single, confirmed)).toBe(true)
      expect(isClarifyAnswerConfirmed(single, answer)).toBe(false)
      const other = status === 'deferred' ? 'not-applicable' : 'deferred'
      expect(
        isClarifyAnswerConfirmed(single, {
          ...confirmed,
          decision: { ...answer.decision, status: other },
        }),
      ).toBe(false)
      expect(
        isClarifyAnswerConfirmed(single, {
          ...confirmed,
          decision: { ...answer.decision, rationale: 'Changed' },
        }),
      ).toBe(false)
      expect(isClarifyAnswerConfirmed(single, { ...confirmed, decision: { status } })).toBe(false)
      // A skip never shares a basis with the unanswered question or with the other skip.
      expect(clarifyAnswerBasis(single, skipped(status))).not.toBe(
        clarifyAnswerBasis(single, empty),
      )
      expect(clarifyAnswerBasis(single, skipped(status))).not.toBe(
        clarifyAnswerBasis(single, skipped(other)),
      )
    }
  })

  test('the basis is taken over the canonical answer, whether or not the writer normalised first', () => {
    for (const status of SKIPS) {
      const chosen = { ...empty, selectedOptionIndices: [1] }
      const stale = { ...chosen, decision: { status } }
      expect(clarifyAnswerBasis(single, stale)).toBe(clarifyAnswerBasis(single, chosen))
      expect(clarifyAnswerBasis(single, stale)).toBe(
        clarifyAnswerBasis(single, withoutStaleClarifySkip(stale)),
      )
      const noted = { ...chosen, decision: { rationale: 'Measured last week' } }
      const staleNoted = { ...chosen, decision: { status, rationale: 'Measured last week' } }
      expect(clarifyAnswerBasis(single, staleNoted)).toBe(clarifyAnswerBasis(single, noted))
      expect(clarifyAnswerBasis(single, staleNoted)).not.toBe(clarifyAnswerBasis(single, chosen))
      // So a confirmation made on either form holds for the other.
      const basis = clarifyAnswerBasis(single, withoutStaleClarifySkip(staleNoted))
      expect(isClarifyAnswerConfirmed(single, { ...staleNoted, confirmedBasis: basis })).toBe(true)
      const written = { ...empty, customText: 'Five minutes', decision: { status } }
      expect(clarifyAnswerBasis(single, written)).toBe(
        clarifyAnswerBasis(single, { ...empty, customText: 'Five minutes' }),
      )
    }
    // A maturity status is never stale: it stays part of the basis.
    const decided = {
      ...empty,
      selectedOptionIndices: [1],
      decision: { status: 'decided' as const },
    }
    expect(clarifyAnswerBasis(single, decided)).not.toBe(
      clarifyAnswerBasis(single, { ...empty, selectedOptionIndices: [1] }),
    )
  })

  test('answers without a decision keep the hash they had before', () => {
    const chosen = { ...empty, selectedOptionIndices: [1, 0] }
    const legacy = clarifyContentKey([multi, [0, 1], ''])
    expect(clarifyAnswerBasis(multi, chosen)).toBe(legacy)
    expect(clarifyAnswerBasis(multi, { ...chosen, decision: undefined })).toBe(legacy)
    expect(clarifyAnswerBasis(multi, { ...chosen, decision: {} })).toBe(legacy)
    expect(clarifyAnswerBasis(single, { ...empty, customText: 'Own' })).toBe(
      clarifyContentKey([single, [], 'Own']),
    )
    expect(clarifyAnswerBasis(single, empty)).toBe(clarifyContentKey([single, [], '']))
    // With a decision the shape is the one RFC-378 introduced: the decision is appended.
    expect(clarifyAnswerBasis(single, skipped('deferred', 'Later'))).toBe(
      clarifyContentKey([single, [], '', { status: 'deferred', rationale: 'Later' }]),
    )
  })
})

describe('RFC-490 §2.3 what the agent reads', () => {
  test('a skip reads as its own state, never as unanswered and never as a choice', () => {
    for (const summarise of [summariseClarifyAnswer, summariseCrossAnswer]) {
      const na = summarise(single, skipped('not-applicable', 'Single node only'))
      expect(na).toBe(
        'User marked this question as not applicable.; Decision status (user marked): "not-applicable"; User rationale: "Single node only"',
      )
      const later = summarise(single, skipped('deferred'))
      expect(later).toBe(
        'User deliberately left this question undecided for now.; Decision status (user marked): "deferred"',
      )
      for (const text of [na, later]) {
        expect(text).not.toContain('User did not answer this question.')
        expect(text).not.toContain('User chose')
        expect(text).not.toContain('User selected')
        expect(text).not.toContain('"unmarked"')
      }
      // Truly unanswered keeps its own wording, with or without notes.
      expect(summarise(single, empty)).toContain('User did not answer this question.')
      expect(summarise(single, { ...empty, decision: { rationale: 'Thinking' } })).toContain(
        'User did not answer this question.',
      )
      // An ordinary question that carries one of the two values reads the same way.
      const plain = { ...single, mindmap: undefined }
      expect(summarise(plain, skipped('not-applicable'))).toBe(
        'User marked this question as not applicable.; Decision status (user marked): "not-applicable"',
      )
      expect(summarise(plain, empty)).toBe('User did not answer this question.')
      // A real answer is rendered as that answer.
      expect(
        summarise(single, {
          ...empty,
          selectedOptionIndices: [0],
          selectedOptionLabels: ['Seconds'],
        }),
      ).toContain('User chose: "Seconds"')
    }
    const block = renderFlatClarifyQueue([
      { question: single, answer: skipped('not-applicable') },
      { question: multi, answer: { ...skipped('deferred'), questionId: 'm' } },
      { question: single, answer: undefined },
    ])!
    expect(block).toContain('Answer: User marked this question as not applicable.')
    expect(block).toContain('Answer: User deliberately left this question undecided for now.')
    expect(block).toContain('Answer: User did not answer this question.')
  })

  const base = {
    promptTemplate: 'Design',
    inputs: {},
    meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
    agentOutputs: ['result'],
  }
  const mindmap = { categories: [], instructions: '' }
  const ASKING_RULE =
    'A question answered as not applicable is closed: never ask it again; a deferred question stays open and is not yet decided.'
  const FINAL_RULE =
    'A question marked not applicable is out of scope; a deferred question is an open item; neither is a choice, so never pick an option for the user.'

  test('the asking rules end with the skip sentence, in the mindmap branch only', () => {
    expect(ASKING_RULE).toContain('answered as not applicable is closed: never ask it again')
    expect(ASKING_RULE).toContain('a deferred question stays open')
    expect(ASKING_RULE.length).toBeLessThan(200)
    // Nothing else moved: the mindmap rules are the ordinary ones with their last sentence
    // replaced by the RFC-378 wording, followed by exactly this sentence.
    const ordinaryTail = 'Treat every listed answer as an already-resolved decision.'
    expect(CLARIFY_STRUCTURAL_RULES.endsWith(ordinaryTail)).toBe(true)
    const mindmapRules =
      CLARIFY_STRUCTURAL_RULES.slice(0, -ordinaryTail.length) +
      'Respect each current user choice and its explicit decision maturity. Confirmed answers may still be provisional or unmarked; do not treat them as settled or validated facts. Follow up on unresolved evidence or consequences without silently changing the user choice. ' +
      ASKING_RULE
    for (const nonce of [undefined, 'test-nonce']) {
      expect(buildClarifyProtocolBlock(nonce, true).endsWith(mindmapRules)).toBe(true)
      expect(
        buildOptionalDualProtocolBlock(['result'], undefined, nonce, undefined, true),
      ).toContain(mindmapRules)
    }
    for (const kind of ['self', 'cross'] as const)
      for (const directive of ['mandatory', 'optional'] as const) {
        const asking = { ...base, clarifyChannel: { kind, directive, injectStopNotice: false } }
        expect(renderUserPrompt({ ...asking, clarifyMindmap: mindmap })).toContain(ASKING_RULE)
        expect(renderUserPrompt(asking)).not.toContain('not applicable')
        expect(renderUserPrompt(asking)).not.toContain('deferred')
      }
  })

  test('the final-output guidance carries the skip sentence before its closing instruction', () => {
    for (const fragment of [
      'not applicable is out of scope',
      'a deferred question is an open item',
      'never pick an option for the user',
    ])
      expect(FINAL_RULE).toContain(fragment)
    expect(FINAL_RULE.length).toBeLessThan(200)
    const lines = CLARIFY_DECISION_OUTPUT_GUIDANCE.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[1]!.endsWith(`including any later reference. ${FINAL_RULE}`)).toBe(true)
    expect(lines[3]!.endsWith('do not repeatedly reformulate or expand it.')).toBe(true)
    expect(CLARIFY_DECISION_OUTPUT_GUIDANCE.split(FINAL_RULE)).toHaveLength(2)
    for (const kind of ['self', 'cross'] as const) {
      const stopped = {
        ...base,
        clarifyChannel: { kind, directive: 'stopped', injectStopNotice: true },
      } as const
      const final = renderUserPrompt({ ...stopped, clarifyMindmap: mindmap })
      expect(final).toContain(FINAL_RULE)
      // The asking rule belongs to ask-back rounds; it is not repeated when finalising.
      expect(final).not.toContain(ASKING_RULE)
      expect(renderUserPrompt(stopped)).not.toContain('not applicable')
      expect(renderUserPrompt(stopped)).not.toContain('deferred')
      // Same budget as before (rfc378-decision.test.ts), now with the sentence included.
      const delta = final.length - renderUserPrompt(stopped).length
      expect(delta).toBeLessThan(2500)
      expect(delta).toBeGreaterThan(FINAL_RULE.length)
    }
  })

  test('question guidance and ordinary prompts are exactly what they were', () => {
    // Lengths measured on the commit before this change (design baseline).
    expect(CLARIFY_MINDMAP_QUESTION_GUIDANCE.length).toBe(2149)
    expect(CLARIFY_MINDMAP_QUESTION_GUIDANCE).not.toContain('not applicable')
    expect(CLARIFY_MINDMAP_QUESTION_GUIDANCE).not.toContain('deferred')
    expect(buildClarifyProtocolBlock().length).toBe(2103)
    expect(buildClarifyProtocolBlock()).toBe(buildClarifyProtocolBlock(undefined, false))
    for (const text of [
      CLARIFY_STRUCTURAL_RULES,
      buildClarifyProtocolBlock(),
      buildClarifyProtocolBlock('test-nonce'),
      buildOptionalDualProtocolBlock(['result'], undefined, 'test-nonce'),
    ]) {
      expect(text).not.toContain('not applicable')
      expect(text).not.toContain('deferred')
    }
    // The mindmap ask-back block grew by the one sentence and its separating space.
    expect(buildClarifyProtocolBlock(undefined, true).length).toBe(2830 + 1 + ASKING_RULE.length)
  })
})

describe('RFC-490 §2.4 where a generated question came from', () => {
  const generated = (mindmap: Record<string, unknown>) =>
    ClarifyQuestionSchema.safeParse({
      ...single,
      id: 'fq-1',
      mindmap: { categoryPath: ['Performance'], ...mindmap },
    })

  test('the target and the direction round-trip with the question', () => {
    for (const requestTarget of ['question', 'category', 'root'] as const) {
      const parsed = generated({
        ...(requestTarget === 'question' ? { parentQuestionId: 'q' } : {}),
        requestId: 'r1',
        requestBasis: 'v2:x',
        requestTarget,
        requestInstruction: 'Check the missing baseline',
      })
      expect(parsed.success).toBe(true)
      expect(parsed.data!.mindmap).toMatchObject({
        requestTarget,
        requestInstruction: 'Check the missing baseline',
      })
      // Stored JSON reads back unchanged.
      expect(ClarifyQuestionSchema.parse(JSON.parse(JSON.stringify(parsed.data)))).toEqual(
        parsed.data!,
      )
    }
    // Both are optional and independent: a target without a direction is the common case.
    const bare = generated({ requestTarget: 'root' }).data!
    expect(bare.mindmap?.requestTarget).toBe('root')
    expect(bare.mindmap).not.toHaveProperty('requestInstruction')
    expect(single.mindmap).not.toHaveProperty('requestTarget')
    expect(single.mindmap).not.toHaveProperty('requestInstruction')
    // The direction is kept as written, quoting wrapper and surrounding space included.
    const quoted = 'Quoted passage: "No baseline"\n\n Check the evidence. '
    expect(generated({ requestInstruction: quoted }).data!.mindmap?.requestInstruction).toBe(quoted)
  })

  test('an unknown target and an over-long direction are rejected', () => {
    for (const requestTarget of ['branch', 'Question', '', 1])
      expect(generated({ requestTarget }).success).toBe(false)
    expect(generated({ requestInstruction: 'x'.repeat(2000) }).success).toBe(true)
    expect(generated({ requestInstruction: 'x'.repeat(2001) }).success).toBe(false)
    expect(generated({ requestInstruction: 7 }).success).toBe(false)
  })

  test('both fields are part of the question set and of the follow-up context', () => {
    const question = generated({
      parentQuestionId: 'q',
      requestTarget: 'question',
      requestInstruction: 'Check the missing baseline',
    }).data!
    const variants = [
      { ...question, mindmap: { ...question.mindmap!, requestInstruction: 'Another' } },
      { ...question, mindmap: { ...question.mindmap!, requestTarget: 'category' as const } },
    ]
    for (const other of variants) {
      expect(clarifyQuestionSetKey([single, question])).not.toBe(
        clarifyQuestionSetKey([single, other]),
      )
      expect(clarifyContentKey(clarifyFollowupContext([single, question], {}, 'fq-1'))).not.toBe(
        clarifyContentKey(clarifyFollowupContext([single, other], {}, 'fq-1')),
      )
    }
    // Both ends compute from the same stored questions, so the keys agree.
    const reread = ClarifyQuestionSchema.parse(JSON.parse(JSON.stringify(question)))
    expect(clarifyQuestionSetKey([single, reread])).toBe(clarifyQuestionSetKey([single, question]))
  })

  test('a category without questions has an empty, stable follow-up context', () => {
    expect(clarifyFollowupContext([single], {}, ['Reliability'])).toEqual([])
    expect(clarifyFollowupContext([single], { q: empty }, ['Performance', 'Replicas'])).toEqual([])
    expect(clarifyContentKey(clarifyFollowupContext([single], { q: empty }, ['Reliability']))).toBe(
      clarifyContentKey([]),
    )
  })
})
