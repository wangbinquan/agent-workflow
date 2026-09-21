// RFC-273 missing-envelope evidence classification.
//
// RFC-367 T2b moved `classifyMissingEnvelope` out of the intent turn engine and
// next to its only evidence producer (`runSystemAgent`), so the memory
// distiller can use the same answer without a cross-context import or a forked
// copy that would drift. These assertions came with it verbatim — the priority
// order they pin (cap-hit beats no-text beats terminal beats stopped) is the
// contract both callers now depend on: the distiller reports "the reply
// outgrew maxEventTextBytes" differently from "the model wrote the wrong
// format", and only this ordering keeps a truncated reply from being blamed on
// the model.

import { describe, expect, test } from 'bun:test'
import {
  classifyMissingEnvelope,
  emptySystemAgentOutputEvidence,
} from '../src/services/systemAgentRun'

describe('RFC-273 missing-envelope evidence classification', () => {
  const evidence = (over: Partial<ReturnType<typeof emptySystemAgentOutputEvidence>> = {}) => ({
    ...emptySystemAgentOutputEvidence(),
    ...over,
  })

  test('classifies cap, no-text, terminal and stopped shapes in fixed priority order', () => {
    expect(
      classifyMissingEnvelope(
        evidence({
          assistantTextSeen: true,
          observedAssistantTextBytes: 10,
          retainedAssistantTextBytes: 5,
          terminalResult: 'success',
        }),
      ),
    ).toBe('output-cap-hit')
    expect(classifyMissingEnvelope(evidence({ terminalResult: 'success' }))).toBe(
      'no-assistant-text',
    )
    expect(
      classifyMissingEnvelope(
        evidence({
          assistantTextSeen: true,
          observedAssistantTextBytes: 5,
          retainedAssistantTextBytes: 5,
          terminalResult: 'success',
        }),
      ),
    ).toBe('terminal-without-envelope')
    expect(
      classifyMissingEnvelope(
        evidence({
          assistantTextSeen: true,
          observedAssistantTextBytes: 5,
          retainedAssistantTextBytes: 5,
        }),
      ),
    ).toBe('assistant-stopped-without-envelope')
    expect(classifyMissingEnvelope(undefined)).toBe('runtime-shape-unknown')
  })

  test('the eventTextCapHit flag alone is enough (no byte-count inference needed)', () => {
    // RFC-367: runSystemAgent sets this when the 8MB retention cap drops
    // assistant text. The distiller turns it into a distinct `last_error`, so a
    // future refactor must not make it depend on the byte counters.
    expect(
      classifyMissingEnvelope(evidence({ assistantTextSeen: true, eventTextCapHit: true })),
    ).toBe('output-cap-hit')
  })
})
