// RFC-059 Cross-Clarify Per-Question Scope — shared layer guards.
//
// Why this test exists:
//   - Locks the new `ClarifyQuestionScopeSchema` enum (only 'designer' /
//     'questioner' accepted; nothing else, no defaulting bugs).
//   - Locks `SubmitClarifyAnswersSchema.questionScopes` as optional (so old
//     clients that omit it keep working, byte-for-byte with RFC-056/058).
//   - Locks `ClarifyRoundSchema.questionScopes` + `CrossClarifySessionSchema.
//     questionScopes` as nullable with default null (dual-write target during
//     RFC-058 dual-write era — both legacy + unified DTOs must accept null).
//   - Locks the three pure helpers (`resolveQuestionScope` /
//     `extractDesignerScopedSubset` / `countDesignerScopedAcrossSources`)
//     against the corner cases that the runtime path will hit: row with
//     null scopes (predates RFC-059), scopes that don't cover every
//     question id, mixed scope distribution, and "no answer for that
//     question" skipping.
//
// Part of the C2 regression guard surface (proposal.md §C2).

import { describe, expect, test } from 'vitest'

import {
  CLARIFY_QUESTION_SCOPE_DEFAULT,
  ClarifyQuestionScopeSchema,
  ClarifyRoundSchema,
  CrossClarifySessionSchema,
  SubmitClarifyAnswersSchema,
  countDesignerScopedAcrossSources,
  extractDesignerScopedSubset,
  resolveQuestionScope,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
} from '../src'

const mkQ = (id: string, title: string): ClarifyQuestion => ({
  id,
  title,
  kind: 'single',
  recommended: false,
  options: [
    { label: 'opt1', description: '', recommended: false, recommendationReason: '' },
    { label: 'opt2', description: '', recommended: false, recommendationReason: '' },
  ],
})

const mkA = (questionId: string, label: string): ClarifyAnswer => ({
  questionId,
  selectedOptionIndices: [0],
  selectedOptionLabels: [label],
  customText: '',
})

describe('RFC-059 — ClarifyQuestionScopeSchema enum', () => {
  test("accepts 'designer' and 'questioner'", () => {
    expect(ClarifyQuestionScopeSchema.parse('designer')).toBe('designer')
    expect(ClarifyQuestionScopeSchema.parse('questioner')).toBe('questioner')
  })

  test('rejects anything else (no silent defaulting)', () => {
    expect(() => ClarifyQuestionScopeSchema.parse('both')).toThrow()
    expect(() => ClarifyQuestionScopeSchema.parse('')).toThrow()
    expect(() => ClarifyQuestionScopeSchema.parse('DESIGNER')).toThrow()
    expect(() => ClarifyQuestionScopeSchema.parse(null)).toThrow()
    expect(() => ClarifyQuestionScopeSchema.parse(undefined)).toThrow()
  })

  test('CLARIFY_QUESTION_SCOPE_DEFAULT is the literal "designer"', () => {
    expect(CLARIFY_QUESTION_SCOPE_DEFAULT).toBe('designer')
  })
})

describe('RFC-059 — SubmitClarifyAnswersSchema.questionScopes', () => {
  test('omitting questionScopes parses cleanly (old client compat)', () => {
    const out = SubmitClarifyAnswersSchema.parse({ answers: [] })
    expect(out.questionScopes).toBeUndefined()
    expect(out.directive).toBe('continue')
  })

  test('explicit empty object parses', () => {
    const out = SubmitClarifyAnswersSchema.parse({ answers: [], questionScopes: {} })
    expect(out.questionScopes).toEqual({})
  })

  test('valid map parses verbatim', () => {
    const out = SubmitClarifyAnswersSchema.parse({
      answers: [],
      questionScopes: { q1: 'designer', q2: 'questioner' },
    })
    expect(out.questionScopes).toEqual({ q1: 'designer', q2: 'questioner' })
  })

  test('rejects unknown scope values', () => {
    expect(() =>
      SubmitClarifyAnswersSchema.parse({
        answers: [],
        questionScopes: { q1: 'both' as unknown as ClarifyQuestionScope },
      }),
    ).toThrow()
  })
})

describe('RFC-059 — ClarifyRoundSchema.questionScopes (unified DTO)', () => {
  const baseRound = {
    id: 'rnd_1',
    taskId: 'tsk_1',
    kind: 'cross' as const,
    askingNodeId: 'nodeQ',
    askingNodeRunId: 'nr_q',
    intermediaryNodeId: 'nodeC',
    intermediaryNodeRunId: 'nr_c',
    iteration: 0,
    questions: [],
    status: 'awaiting_human' as const,
    createdAt: 1_700_000_000_000,
  }

  test('null is the default when omitted', () => {
    const out = ClarifyRoundSchema.parse(baseRound)
    expect(out.questionScopes).toBeNull()
  })

  test('explicit null is preserved', () => {
    const out = ClarifyRoundSchema.parse({ ...baseRound, questionScopes: null })
    expect(out.questionScopes).toBeNull()
  })

  test('valid object is preserved', () => {
    const out = ClarifyRoundSchema.parse({
      ...baseRound,
      questionScopes: { q1: 'designer', q2: 'questioner' },
    })
    expect(out.questionScopes).toEqual({ q1: 'designer', q2: 'questioner' })
  })

  test('kind=self can also carry null (always null in practice)', () => {
    const out = ClarifyRoundSchema.parse({
      ...baseRound,
      kind: 'self',
      targetConsumerNodeId: null,
      status: 'awaiting_human',
    })
    expect(out.questionScopes).toBeNull()
  })
})

describe('RFC-059 — CrossClarifySessionSchema.questionScopes (legacy DTO)', () => {
  const baseSession = {
    id: 'sess_1',
    taskId: 'tsk_1',
    crossClarifyNodeId: 'nodeC',
    crossClarifyNodeRunId: 'nr_c',
    sourceQuestionerNodeId: 'nodeQ',
    sourceQuestionerNodeRunId: 'nr_q',
    targetDesignerNodeId: 'nodeD',
    loopIter: 0,
    iteration: 0,
    questions: [],
    directive: null,
    status: 'awaiting_human' as const,
    designerRunTriggeredAt: null,
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    abandonedAt: null,
  }

  test('null is the default when omitted (dual-write back-compat)', () => {
    const out = CrossClarifySessionSchema.parse(baseSession)
    expect(out.questionScopes).toBeNull()
  })

  test('valid object is preserved', () => {
    const out = CrossClarifySessionSchema.parse({
      ...baseSession,
      questionScopes: { q1: 'questioner' },
    })
    expect(out.questionScopes).toEqual({ q1: 'questioner' })
  })
})

describe('RFC-059 — resolveQuestionScope', () => {
  test('null scopes → default designer', () => {
    expect(resolveQuestionScope(null, 'q1')).toBe('designer')
  })

  test('missing key → default designer', () => {
    expect(resolveQuestionScope({ q2: 'questioner' }, 'q1')).toBe('designer')
  })

  test('present key → returns stored value', () => {
    expect(resolveQuestionScope({ q1: 'questioner' }, 'q1')).toBe('questioner')
    expect(resolveQuestionScope({ q1: 'designer' }, 'q1')).toBe('designer')
  })

  test('empty object → default designer', () => {
    expect(resolveQuestionScope({}, 'q1')).toBe('designer')
  })
})

describe('RFC-059 — extractDesignerScopedSubset', () => {
  const q1 = mkQ('q1', 'first')
  const q2 = mkQ('q2', 'second')
  const q3 = mkQ('q3', 'third')
  const a1 = mkA('q1', 'one')
  const a2 = mkA('q2', 'two')
  const a3 = mkA('q3', 'three')

  test('null scopes → all questions enter designer subset (RFC-056 compat)', () => {
    const out = extractDesignerScopedSubset([q1, q2, q3], [a1, a2, a3], null)
    expect(out.questions).toEqual([q1, q2, q3])
    expect(out.answers).toEqual([a1, a2, a3])
  })

  test('all designer scopes → all in subset', () => {
    const out = extractDesignerScopedSubset([q1, q2, q3], [a1, a2, a3], {
      q1: 'designer',
      q2: 'designer',
      q3: 'designer',
    })
    expect(out.questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3'])
  })

  test('all questioner scopes → empty subset', () => {
    const out = extractDesignerScopedSubset([q1, q2, q3], [a1, a2, a3], {
      q1: 'questioner',
      q2: 'questioner',
      q3: 'questioner',
    })
    expect(out.questions).toEqual([])
    expect(out.answers).toEqual([])
  })

  test('mixed scopes → only designer-scoped questions kept, paired with their answers', () => {
    const out = extractDesignerScopedSubset([q1, q2, q3], [a1, a2, a3], {
      q1: 'designer',
      q2: 'questioner',
      q3: 'designer',
    })
    expect(out.questions.map((q) => q.id)).toEqual(['q1', 'q3'])
    expect(out.answers.map((a) => a.questionId)).toEqual(['q1', 'q3'])
  })

  test('question with no matching answer is skipped entirely', () => {
    const out = extractDesignerScopedSubset(
      [q1, q2, q3],
      [a1, a3], // missing a2
      { q1: 'designer', q2: 'designer', q3: 'designer' },
    )
    expect(out.questions.map((q) => q.id)).toEqual(['q1', 'q3'])
    expect(out.answers.map((a) => a.questionId)).toEqual(['q1', 'q3'])
  })

  test('preserves source order (no implicit sorting)', () => {
    const out = extractDesignerScopedSubset([q3, q1, q2], [a3, a1, a2], {
      q1: 'designer',
      q2: 'designer',
      q3: 'designer',
    })
    expect(out.questions.map((q) => q.id)).toEqual(['q3', 'q1', 'q2'])
  })
})

describe('RFC-059 — countDesignerScopedAcrossSources', () => {
  const q1 = mkQ('q1', 'first')
  const q2 = mkQ('q2', 'second')
  const a1 = mkA('q1', 'one')
  const a2 = mkA('q2', 'two')

  test('empty sources array → 0', () => {
    expect(countDesignerScopedAcrossSources([])).toBe(0)
  })

  test('single source all designer → counts every question', () => {
    expect(
      countDesignerScopedAcrossSources([
        {
          questions: [q1, q2],
          answers: [a1, a2],
          scopes: { q1: 'designer', q2: 'designer' },
        },
      ]),
    ).toBe(2)
  })

  test('single source all questioner → 0', () => {
    expect(
      countDesignerScopedAcrossSources([
        {
          questions: [q1, q2],
          answers: [a1, a2],
          scopes: { q1: 'questioner', q2: 'questioner' },
        },
      ]),
    ).toBe(0)
  })

  test('multi source aggregation (mix + null + all-questioner) sums correctly', () => {
    const n = countDesignerScopedAcrossSources([
      {
        questions: [q1, q2],
        answers: [a1, a2],
        scopes: { q1: 'designer', q2: 'questioner' }, // 1 designer
      },
      {
        questions: [q1, q2],
        answers: [a1, a2],
        scopes: null, // RFC-056 row → all designer → 2 designer
      },
      {
        questions: [q1, q2],
        answers: [a1, a2],
        scopes: { q1: 'questioner', q2: 'questioner' }, // 0 designer
      },
    ])
    expect(n).toBe(3)
  })

  test('missing answers are not double-counted', () => {
    const n = countDesignerScopedAcrossSources([
      {
        questions: [q1, q2],
        answers: [a1], // q2 has no answer → not counted even if designer-scoped
        scopes: { q1: 'designer', q2: 'designer' },
      },
    ])
    expect(n).toBe(1)
  })
})
