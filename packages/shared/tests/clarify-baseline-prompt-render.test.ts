// RFC-058 PR-A baseline (T1): byte-level lock of directive trailer / answer
// synthesis / Prior Output block rendering. Locks exact markdown layout
// consumed by the asking agent's next-round prompt. Any refactor that
// perturbs whitespace, heading shape, list ordering, or English wording will
// trip these — that is the regression signal.
//
// Locks RFC-023 (self) + RFC-039 (directive trailer) + RFC-056 §6 (update
// mode) prompt-render contracts. (RFC-148 removed the legacy Q&A-block and
// External Feedback renderers; their baselines were deleted with them.)

import { describe, expect, test } from 'bun:test'

import {
  buildPriorOutputBlock,
  renderClarifyDirectiveTrailer,
  summariseClarifyAnswer,
} from '../src/index'
import type { ClarifyQuestion } from '../src/schemas/clarify'

// --- shared fixtures ---------------------------------------------------------

const Q_DB: ClarifyQuestion = {
  id: 'q1',
  title: 'Database choice?',
  kind: 'single',
  recommended: false,
  options: [
    {
      label: 'Postgres',
      description: 'ACID, mature',
      recommended: true,
      recommendationReason: 'matches workload',
    },
    {
      label: 'MySQL',
      description: 'broadly deployed',
      recommended: false,
      recommendationReason: '',
    },
  ],
}

const Q_LANG: ClarifyQuestion = {
  id: 'q2',
  title: 'Languages?',
  kind: 'multi',
  recommended: false,
  options: [
    { label: 'Python', description: '', recommended: false, recommendationReason: '' },
    { label: 'TypeScript', description: '', recommended: false, recommendationReason: '' },
  ],
}

describe('RFC-058 baseline — renderClarifyDirectiveTrailer standalone', () => {
  test('undefined → empty string', () => {
    expect(renderClarifyDirectiveTrailer(undefined)).toBe('')
  })

  test('continue → byte-exact 3-line trailer (RFC-100 mandatory ask-back)', () => {
    expect(renderClarifyDirectiveTrailer('continue')).toBe(
      [
        '### User directive: KEEP CLARIFYING',
        '- The user has clicked "Keep clarifying" — they want another round. This node is in mandatory ask-back mode: your next reply MUST be another `<workflow-clarify>` envelope.',
        '- Keep probing every still-unresolved detail that matters. Do not attempt <workflow-output> — the framework will reject it until the user clicks "Stop clarifying".',
      ].join('\n'),
    )
  })

  test('stop → byte-exact 3-line trailer', () => {
    expect(renderClarifyDirectiveTrailer('stop')).toBe(
      [
        '### User directive: STOP CLARIFYING',
        '- The user has ended clarification. You are now RELEASED from ask-back mode — do NOT emit another <workflow-clarify> envelope.',
        '- Produce your final <workflow-output> reply now using the answers above. If any detail is still ambiguous, make your best informed call based on the answers and proceed.',
      ].join('\n'),
    )
  })

  test('stop without visible Q&A points at preserved context instead of nonexistent answers above', () => {
    const trailer = renderClarifyDirectiveTrailer('stop', { answersVisible: false })
    expect(trailer).toContain('resolved context preserved in Prior Output or the resumed session')
    expect(trailer).not.toContain('answers above')
  })
})

describe('RFC-058 baseline — summariseClarifyAnswer 6 cases', () => {
  test('empty → "User did not answer this question."', () => {
    expect(
      summariseClarifyAnswer(Q_DB, {
        questionId: 'q1',
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: '',
      }),
    ).toBe('User did not answer this question.')
  })

  test('single + label → User chose', () => {
    expect(
      summariseClarifyAnswer(Q_DB, {
        questionId: 'q1',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      }),
    ).toBe('User chose: "Postgres"')
  })

  test('single + custom only → User chose custom answer', () => {
    expect(
      summariseClarifyAnswer(Q_DB, {
        questionId: 'q1',
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: 'Cassandra',
      }),
    ).toBe('User chose custom answer: "Cassandra"')
  })

  test('multi + labels only → User selected', () => {
    expect(
      summariseClarifyAnswer(Q_LANG, {
        questionId: 'q2',
        selectedOptionIndices: [0, 1],
        selectedOptionLabels: ['Python', 'TypeScript'],
        customText: '',
      }),
    ).toBe('User selected: "Python", "TypeScript"')
  })

  test('multi + custom only → User selected only the custom answer', () => {
    expect(
      summariseClarifyAnswer(Q_LANG, {
        questionId: 'q2',
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: 'Zig',
      }),
    ).toBe('User selected only the custom answer: "Zig"')
  })

  test('multi + labels + custom → User selected ... with additional note', () => {
    expect(
      summariseClarifyAnswer(Q_LANG, {
        questionId: 'q2',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Python'],
        customText: 'plus Rust',
      }),
    ).toBe('User selected: "Python" with additional note: "plus Rust"')
  })
})

describe('RFC-058 baseline — buildPriorOutputBlock (cross-clarify update mode)', () => {
  test('two outputs: each port_name gets a heading + body, blank line separator', () => {
    const out = buildPriorOutputBlock([
      { portName: 'plan', content: 'step 1\nstep 2' },
      { portName: 'notes', content: 'be careful with edge X' },
    ])
    expect(out).toBe(
      ['### plan', '', 'step 1', 'step 2', '', '### notes', '', 'be careful with edge X'].join(
        '\n',
      ),
    )
  })

  test('empty-content port is dropped (no heading emitted)', () => {
    const out = buildPriorOutputBlock([
      { portName: 'p1', content: 'real content' },
      { portName: 'p2', content: '   ' },
      { portName: 'p3', content: 'tail' },
    ])
    expect(out).toBe(['### p1', '', 'real content', '', '### p3', '', 'tail'].join('\n'))
  })

  test('zero outputs → empty string', () => {
    expect(buildPriorOutputBlock([])).toBe('')
  })
})
