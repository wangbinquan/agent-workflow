// RFC-370: every missing-envelope consumer must use the same original policy,
// including cap priority over absent text and already-observed terminal events.
import { expect, test } from 'bun:test'
import {
  classifyMissingEnvelope,
  type MissingEnvelopeReason,
  type WorkflowOutputEvidence,
} from '../src/workflowOutputEvidence'

const evidence: WorkflowOutputEvidence = {
  assistantTextSeen: true,
  observedAssistantTextBytes: 10,
  retainedAssistantTextBytes: 10,
  eventTextCapHit: false,
  terminalResult: 'not-observed',
}

const cases: readonly {
  readonly name: string
  readonly input: WorkflowOutputEvidence | undefined
  readonly expected: MissingEnvelopeReason
}[] = [
  { name: 'absent evidence', input: undefined, expected: 'runtime-shape-unknown' },
  {
    name: 'explicit cap precedes absent text and terminal',
    input: {
      ...evidence,
      eventTextCapHit: true,
      assistantTextSeen: false,
      terminalResult: 'error',
    },
    expected: 'output-cap-hit',
  },
  {
    name: 'observed bytes exceeding retained bytes imply cap',
    input: { ...evidence, observedAssistantTextBytes: 11 },
    expected: 'output-cap-hit',
  },
  {
    name: 'absent assistant text precedes a terminal error',
    input: { ...evidence, assistantTextSeen: false, terminalResult: 'error' },
    expected: 'no-assistant-text',
  },
  {
    name: 'a successful terminal without an envelope',
    input: { ...evidence, terminalResult: 'success' },
    expected: 'terminal-without-envelope',
  },
  {
    name: 'an error terminal without an envelope',
    input: { ...evidence, terminalResult: 'error' },
    expected: 'terminal-without-envelope',
  },
  {
    name: 'assistant stops without a terminal',
    input: evidence,
    expected: 'assistant-stopped-without-envelope',
  },
]

for (const scenario of cases) {
  test(`RFC-370 shared workflow evidence: ${scenario.name}`, () => {
    expect(classifyMissingEnvelope(scenario.input)).toBe(scenario.expected)
  })
}
