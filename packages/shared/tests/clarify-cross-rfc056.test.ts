// RFC-056 — shared/clarify-cross.ts pure functions.
//
// LOCKS:
//   * parseCrossClarifyEnvelopeBody lifts the 5-question cap; per-question
//     validation (options 2-4, single/multi kind, custom-text length) still
//     funnels through the RFC-023 parser.
//   * buildExternalFeedbackBlock sorts sources dictionary-order by
//     `sourceQuestionerNodeId`; per-source body uses RFC-023 synthesis lines.
//   * resolveCrossClarifySessionMode defaults to 'isolated' per direction.
//
// If any of these go red the runtime / prompt assembly for the cross-clarify
// path has drifted — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import type { ClarifyQuestion, ClarifyAnswer } from '@agent-workflow/shared'
import {
  buildExternalFeedbackBlock,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE,
  parseCrossClarifyEnvelopeBody,
  renderCrossClarifySource,
  resolveCrossClarifySessionMode,
  summariseCrossAnswer,
} from '@agent-workflow/shared'

function mkQ(id: string, title: string, kind: 'single' | 'multi' = 'single'): ClarifyQuestion {
  return {
    id,
    title,
    kind,
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function mkA(qid: string, labels: string[] = [], custom = ''): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [],
    selectedOptionLabels: labels,
    customText: custom,
  }
}

describe('RFC-056 parseCrossClarifyEnvelopeBody — lifts question cap, keeps per-question rules', () => {
  test('accepts 1 question (lower bound preserved)', () => {
    const env = JSON.stringify({
      questions: [{ id: 'q1', title: 'one', kind: 'single', options: ['A', 'B'] }],
    })
    const r = parseCrossClarifyEnvelopeBody(env)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(1)
  })

  test('accepts 7 questions (RFC-023 would have truncated at 5)', () => {
    const questions = Array.from({ length: 7 }, (_, i) => ({
      id: `q${i + 1}`,
      title: `t${i + 1}`,
      kind: 'single',
      options: ['A', 'B'],
    }))
    const r = parseCrossClarifyEnvelopeBody(JSON.stringify({ questions }))
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(7)
  })

  test('still truncates per-question options at 4 (RFC-023 rule preserved)', () => {
    const env = JSON.stringify({
      questions: [
        {
          id: 'q1',
          title: 't',
          kind: 'single',
          options: ['A', 'B', 'C', 'D', 'E'],
        },
      ],
    })
    const r = parseCrossClarifyEnvelopeBody(env)
    expect(r.body?.questions[0]?.options.length).toBe(4)
    expect(r.warnings.some((w) => w.code === 'clarify-options-too-many')).toBe(true)
  })

  test('still rejects options < 2 (RFC-023 hard rule preserved)', () => {
    const env = JSON.stringify({
      questions: [{ id: 'q1', title: 't', kind: 'single', options: ['only'] }],
    })
    const r = parseCrossClarifyEnvelopeBody(env)
    expect(r.body).toBeNull()
    expect(r.errors.some((e) => e.code === 'clarify-options-too-few')).toBe(true)
  })

  test('rejects malformed JSON', () => {
    const r = parseCrossClarifyEnvelopeBody('not-json')
    expect(r.body).toBeNull()
    expect(r.errors.some((e) => e.code === 'clarify-questions-malformed')).toBe(true)
  })

  test('rejects empty questions array (lower bound 1)', () => {
    const r = parseCrossClarifyEnvelopeBody(JSON.stringify({ questions: [] }))
    expect(r.body).toBeNull()
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

describe('RFC-056 buildExternalFeedbackBlock — dictionary-sorted multi-source render', () => {
  test('empty sources returns empty string (caller may suppress section)', () => {
    expect(buildExternalFeedbackBlock([])).toBe('')
  })

  test('single source renders ### From + Q&A block', () => {
    const q = mkQ('q1', 'Why Redis?')
    const a = mkA('q1', ['Already in the cluster'], '')
    const out = buildExternalFeedbackBlock([
      {
        sourceQuestionerNodeId: 'auditor',
        crossClarifyNodeId: 'cc1',
        iteration: 1,
        questions: [q],
        answers: [a],
      },
    ])
    expect(out).toContain("### From 'auditor' (round 1)")
    expect(out).toContain('#### Q1: Why Redis?')
    expect(out).toContain('User chose: "Already in the cluster"')
  })

  test('multi-source dictionary-sorted by sourceQuestionerNodeId', () => {
    const q1 = mkQ('q1', 't1')
    const a1 = mkA('q1', ['A'], '')
    const out = buildExternalFeedbackBlock([
      {
        sourceQuestionerNodeId: 'ux',
        crossClarifyNodeId: 'cc2',
        iteration: 1,
        questions: [q1],
        answers: [a1],
      },
      {
        sourceQuestionerNodeId: 'security',
        crossClarifyNodeId: 'cc1',
        iteration: 1,
        questions: [q1],
        answers: [a1],
      },
    ])
    // 'security' < 'ux' in dictionary order
    const securityIdx = out.indexOf("### From 'security'")
    const uxIdx = out.indexOf("### From 'ux'")
    expect(securityIdx).toBeGreaterThan(-1)
    expect(uxIdx).toBeGreaterThan(securityIdx)
  })

  test('renders "User did not answer this question." for missing answers', () => {
    const q = mkQ('q1', 'open question')
    const out = buildExternalFeedbackBlock([
      {
        sourceQuestionerNodeId: 'a',
        crossClarifyNodeId: 'cc1',
        iteration: 0,
        questions: [q],
        answers: [],
      },
    ])
    expect(out).toContain('User did not answer this question.')
  })

  test('renderCrossClarifySource(src) === buildExternalFeedbackBlock([src])', () => {
    const q = mkQ('q1', 't', 'multi')
    const a = mkA('q1', ['A', 'B'], 'note')
    const src = {
      sourceQuestionerNodeId: 'a',
      crossClarifyNodeId: 'cc1',
      iteration: 2,
      questions: [q],
      answers: [a],
    }
    expect(renderCrossClarifySource(src)).toBe(buildExternalFeedbackBlock([src]))
  })

  test('renders FULL per-question detail: title + Type + Candidate options + descriptions + [recommended] flags + reasons (2026-05-22 enrichment)', () => {
    // The original 2025 implementation only emitted `#### Q{N}: title` +
    // `User chose: …` synthesis — losing the candidate option set that the
    // questioner surfaced. Designer reading the prompt then had no clue
    // whether the user picked Jest over Vitest / Mocha / Cypress, or
    // whether the questioner even raised those alternatives. This lock
    // pins the richer rendering that matches RFC-023 self-clarify info
    // density via `renderClarifyQuestionsBlock`.
    const q: ClarifyQuestion = {
      id: 'q1',
      title: 'Pick test framework',
      kind: 'single',
      recommended: false,
      options: [
        {
          label: 'Jest',
          description: 'Mature, widely adopted',
          recommended: true,
          recommendationReason: 'Best ecosystem fit for our stack',
        },
        {
          label: 'Vitest',
          description: 'Vite-native, faster',
          recommended: false,
          recommendationReason: '',
        },
        { label: 'Mocha', description: '', recommended: false, recommendationReason: '' },
      ],
    }
    const a = mkA('q1', ['Jest'], '')
    const out = buildExternalFeedbackBlock([
      {
        sourceQuestionerNodeId: 'tester',
        crossClarifyNodeId: 'cc1',
        iteration: 0,
        questions: [q],
        answers: [a],
      },
    ])
    // Title + section heading.
    expect(out).toContain("### From 'tester' (round 0)")
    expect(out).toContain('#### Q1: Pick test framework')
    // Full question detail surfaces — locks each piece independently so a
    // refactor that drops one part fails fast.
    expect(out).toContain('Type: single-choice')
    expect(out).toContain('Candidate options:')
    expect(out).toContain('Jest [recommended]')
    expect(out).toContain('description: Mature, widely adopted')
    expect(out).toContain('reason: Best ecosystem fit for our stack')
    expect(out).toContain('Vitest')
    expect(out).toContain('description: Vite-native, faster')
    expect(out).toContain('Mocha')
    // Answer synthesis still rendered (NOT mutually exclusive with full Q).
    expect(out).toContain('User chose: "Jest"')
  })

  test('Q heading is `#### Q{N}` (one deeper than RFC-023 `### Q{N}` since cross-clarify nests under `### From <id>`)', () => {
    // Verify the heading-shift step in buildExternalFeedbackBlock didn't
    // leave a stray `### Q1` from renderClarifyQuestionsBlock that would
    // collide with the `### From '<id>'` sibling heading and break the
    // markdown outline.
    const q = mkQ('q1', 't')
    const a = mkA('q1', ['A'], '')
    const out = buildExternalFeedbackBlock([
      {
        sourceQuestionerNodeId: 'a',
        crossClarifyNodeId: 'cc1',
        iteration: 0,
        questions: [q],
        answers: [a],
      },
    ])
    expect(out).toContain('#### Q1:')
    // No bare `### Q1` (would only appear if the shift regex missed).
    expect(out).not.toMatch(/^### Q1:/m)
  })
})

describe('RFC-056 summariseCrossAnswer — reuses RFC-023 single-question synthesis', () => {
  test('single chose option → User chose: "X"', () => {
    const q = mkQ('q1', 't')
    const a = mkA('q1', ['A'], '')
    expect(summariseCrossAnswer(q, a)).toBe('User chose: "A"')
  })

  test('multi with custom → User selected: ... with additional note: "..."', () => {
    const q = mkQ('q1', 't', 'multi')
    const a = mkA('q1', ['A', 'B'], 'note')
    expect(summariseCrossAnswer(q, a)).toBe('User selected: "A", "B" with additional note: "note"')
  })
})

describe('RFC-056 resolveCrossClarifySessionMode — defaults to isolated per direction', () => {
  test('missing fields → isolated', () => {
    const node = {
      id: 'cc1',
      kind: 'clarify-cross-agent' as const,
      title: '',
      description: '',
    }
    expect(resolveCrossClarifySessionMode(node, 'designer')).toBe('isolated')
    expect(resolveCrossClarifySessionMode(node, 'questioner')).toBe('isolated')
  })

  test('explicit fields round-trip independently', () => {
    const node = {
      id: 'cc1',
      kind: 'clarify-cross-agent' as const,
      title: '',
      description: '',
      sessionModeForDesigner: 'inline' as const,
      sessionModeForQuestioner: 'isolated' as const,
    }
    expect(resolveCrossClarifySessionMode(node, 'designer')).toBe('inline')
    expect(resolveCrossClarifySessionMode(node, 'questioner')).toBe('isolated')
  })
})

describe('RFC-056 constant exports for grep-guard', () => {
  test('CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE locks the section heading', () => {
    expect(CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE).toBe('## External Feedback')
  })
})
