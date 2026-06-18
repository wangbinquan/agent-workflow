// RFC-058 PR-A baseline (T1): byte-level lock of Q&A block / directive trailer
// / External Feedback block / Prior Output block rendering. Locks exact
// markdown layout consumed by the asking agent's next-round prompt. Any
// PR-B refactor that perturbs whitespace, heading shape, list ordering,
// or English wording will trip these — that is the regression signal.
//
// Locks RFC-023 (self) + RFC-056 (cross) + RFC-039 (directive trailer) +
// RFC-056 §6 (update mode) prompt-render contracts.

import { describe, expect, test } from 'bun:test'

import {
  buildClarifyPromptBlock,
  buildExternalFeedbackBlock,
  buildPriorOutputBlock,
  renderClarifyDirectiveTrailer,
  renderClarifyQuestionsBlock,
  summariseClarifyAnswer,
  type CrossClarifySourceContext,
} from '../src/index'
import type { ClarifyAnswer, ClarifyQuestion } from '../src/schemas/clarify'

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

describe('RFC-058 baseline — renderClarifyQuestionsBlock', () => {
  test('single-question render shape: Q1 heading + Type + Candidate + options w/ recommended', () => {
    const out = renderClarifyQuestionsBlock([Q_DB])
    expect(out).toBe(
      [
        '### Q1: Database choice?',
        '- Type: single-choice',
        '- Candidate options:',
        '  1. Postgres [recommended]',
        '     description: ACID, mature',
        '     reason: matches workload',
        '  2. MySQL',
        '     description: broadly deployed',
      ].join('\n'),
    )
  })

  test('multi-question render: each question its own block; multi-choice label; no leading sep', () => {
    const out = renderClarifyQuestionsBlock([Q_DB, Q_LANG])
    expect(out).toBe(
      [
        '### Q1: Database choice?',
        '- Type: single-choice',
        '- Candidate options:',
        '  1. Postgres [recommended]',
        '     description: ACID, mature',
        '     reason: matches workload',
        '  2. MySQL',
        '     description: broadly deployed',
        '',
        '### Q2: Languages?',
        '- Type: multi-choice',
        '- Candidate options:',
        '  1. Python',
        '  2. TypeScript',
      ].join('\n'),
    )
  })
})

describe('RFC-058 baseline — buildClarifyPromptBlock (Q&A render)', () => {
  test('single answer + single chose label', () => {
    const ans: ClarifyAnswer[] = [
      {
        questionId: 'q1',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ]
    const out = buildClarifyPromptBlock([Q_DB], ans)
    expect(out).toBe(['### Q1: Database choice?', '- User chose: "Postgres"'].join('\n'))
  })

  test('multi answer with custom: Q index from array position (Q_LANG alone → Q1)', () => {
    const ans: ClarifyAnswer[] = [
      {
        questionId: 'q2',
        selectedOptionIndices: [0, 1],
        selectedOptionLabels: ['Python', 'TypeScript'],
        customText: 'plus some Rust',
      },
    ]
    const out = buildClarifyPromptBlock([Q_LANG], ans)
    // RFC-058 baseline locks: Q index is array-position-based, NOT question.id.
    // Q_LANG.id='q2' but rendered as Q1 when alone.
    expect(out).toBe(
      [
        '### Q1: Languages?',
        '- User selected: "Python", "TypeScript" with additional note: "plus some Rust"',
      ].join('\n'),
    )
  })

  // RFC-100: the continue trailer is now mandatory ask-back (3 lines, no output
  // escape hatch); the old RFC-039 "you may emit <workflow-output> if zero
  // unresolved decisions remain" soft escape was removed.
  test('directive=continue appends KEEP CLARIFYING trailer (3 lines)', () => {
    const ans: ClarifyAnswer[] = [
      {
        questionId: 'q1',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ]
    const out = buildClarifyPromptBlock([Q_DB], ans, 'continue')
    expect(out).toBe(
      [
        '### Q1: Database choice?',
        '- User chose: "Postgres"',
        '',
        '### User directive: KEEP CLARIFYING',
        '- The user has clicked "Keep clarifying" — they want another round. This node is in mandatory ask-back mode: your next reply MUST be another `<workflow-clarify>` envelope.',
        '- Keep probing every still-unresolved detail that matters. Do not attempt <workflow-output> — the framework will reject it until the user clicks "Stop clarifying".',
      ].join('\n'),
    )
  })

  test('directive=stop appends STOP CLARIFYING trailer (3 lines)', () => {
    const ans: ClarifyAnswer[] = [
      {
        questionId: 'q1',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '',
      },
    ]
    const out = buildClarifyPromptBlock([Q_DB], ans, 'stop')
    expect(out).toBe(
      [
        '### Q1: Database choice?',
        '- User chose: "Postgres"',
        '',
        '### User directive: STOP CLARIFYING',
        '- The user has ended clarification. You are now RELEASED from ask-back mode — do NOT emit another <workflow-clarify> envelope.',
        '- Produce your final <workflow-output> reply now using the answers above. If any detail is still ambiguous, make your best informed call based on the answers and proceed.',
      ].join('\n'),
    )
  })

  test('unanswered question yields literal "User did not answer this question."', () => {
    const out = buildClarifyPromptBlock([Q_DB], [])
    expect(out).toBe(
      ['### Q1: Database choice?', '- User did not answer this question.'].join('\n'),
    )
  })
})

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

describe('RFC-058 baseline — buildExternalFeedbackBlock (cross-clarify designer side)', () => {
  test('single source: ### From + Q heading shifted to #### + Answers line', () => {
    const src: CrossClarifySourceContext = {
      sourceQuestionerNodeId: 'questioner-a',
      crossClarifyNodeId: 'cc1',
      iteration: 1,
      questions: [Q_DB],
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['Postgres'],
          customText: '',
        },
      ],
    }
    const out = buildExternalFeedbackBlock([src])
    expect(out).toBe(
      [
        "### From 'questioner-a' (round 1)",
        '',
        '#### Q1: Database choice?',
        '- Type: single-choice',
        '- Candidate options:',
        '  1. Postgres [recommended]',
        '     description: ACID, mature',
        '     reason: matches workload',
        '  2. MySQL',
        '     description: broadly deployed',
        '',
        'Answers:',
        '- Q1 (Database choice?): User chose: "Postgres"',
      ].join('\n'),
    )
  })

  test('multi source: sources sorted by sourceQuestionerNodeId dictionary order', () => {
    // Submit in non-dictionary order — renderer must sort.
    const src1: CrossClarifySourceContext = {
      sourceQuestionerNodeId: 'zeta',
      crossClarifyNodeId: 'cc_z',
      iteration: 1,
      questions: [
        {
          id: 'qz',
          title: 'zeta question',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'X', description: '', recommended: false, recommendationReason: '' },
            { label: 'Y', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      answers: [
        {
          questionId: 'qz',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['X'],
          customText: '',
        },
      ],
    }
    const src2: CrossClarifySourceContext = {
      sourceQuestionerNodeId: 'alpha',
      crossClarifyNodeId: 'cc_a',
      iteration: 2,
      questions: [
        {
          id: 'qa',
          title: 'alpha question',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'A', description: '', recommended: false, recommendationReason: '' },
            { label: 'B', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      answers: [
        {
          questionId: 'qa',
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: '',
        },
      ],
    }
    const out = buildExternalFeedbackBlock([src1, src2])
    // alpha < zeta dictionary; first sub-section must be alpha; unanswered Q
    // renders literal "User did not answer this question."
    expect(out.split('\n')[0]).toBe("### From 'alpha' (round 2)")
    expect(out).toContain('- Q1 (alpha question): User did not answer this question.')
    expect(out).toContain("### From 'zeta' (round 1)")
    // zeta comes AFTER alpha in dictionary sort
    expect(out.indexOf("### From 'alpha'")).toBeLessThan(out.indexOf("### From 'zeta'"))
  })

  test('empty sources → empty string', () => {
    expect(buildExternalFeedbackBlock([])).toBe('')
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
