import { afterEach, describe, expect, test } from 'vitest'
import type { IntentTurnDto } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import {
  formatIntentDiagnosticBytes,
  intentFailureDiagnostic,
} from '../src/lib/intent-failure-diagnostic'

function turn(over: Partial<IntentTurnDto> = {}): IntentTurnDto {
  return {
    id: 'turn-1',
    seq: 1,
    role: 'agent',
    kind: 'error',
    content: { code: 'intent-envelope-missing', reason: 'no-assistant-text' },
    contextRevision: 0,
    runMeta: {
      scratchRetentionHours: 24,
      outputEvidence: {
        assistantTextSeen: false,
        observedAssistantTextBytes: 0,
        retainedAssistantTextBytes: 0,
        eventTextCapHit: false,
        unparsedStdoutSeen: false,
        lastNormalizedEventKind: 'step_start',
        lastRuntimeEventType: 'system',
        terminalResult: 'not-observed',
      },
    },
    scratchRetained: true,
    execution: null,
    createdAt: 1,
    ...over,
  }
}

afterEach(async () => {
  await i18n.changeLanguage('zh-CN')
})

describe('RFC-273 intent failure diagnostics', () => {
  test('all four evidence-backed reasons are localized in zh-CN and en-US', async () => {
    const reasons = [
      'output-cap-hit',
      'no-assistant-text',
      'terminal-without-envelope',
      'assistant-stopped-without-envelope',
    ] as const
    for (const locale of ['zh-CN', 'en-US'] as const) {
      await i18n.changeLanguage(locale)
      for (const reason of reasons) {
        const diagnostic = intentFailureDiagnostic(
          turn({ content: { code: 'intent-envelope-missing', reason } }),
          i18n.t.bind(i18n),
        )
        expect(diagnostic.title).not.toContain('failureDiagnostic')
        expect(diagnostic.suggestion.length).toBeGreaterThan(20)
        expect(diagnostic.evidence).toHaveLength(3)
        expect(diagnostic.scratchNotice).toContain('24')
      }
    }
  })

  test('legacy or malformed metadata is ignored without hiding the retry diagnosis', async () => {
    await i18n.changeLanguage('zh-CN')
    const diagnostic = intentFailureDiagnostic(
      turn({
        content: { code: 'intent-envelope-missing', reason: 'future-reason' },
        runMeta: { outputEvidence: { observedAssistantTextBytes: 'secret' } },
        scratchRetained: false,
      }),
      i18n.t.bind(i18n),
    )
    expect(diagnostic.title).toContain('信封')
    expect(diagnostic.evidence).toEqual([])
    expect(diagnostic.scratchNotice).toBeNull()
  })

  test('byte formatting is bounded and stable', () => {
    expect(formatIntentDiagnosticBytes(0)).toBe('0 B')
    expect(formatIntentDiagnosticBytes(1024)).toBe('1 KiB')
    expect(formatIntentDiagnosticBytes(1536)).toBe('1.5 KiB')
    expect(formatIntentDiagnosticBytes(2 * 1024 * 1024)).toBe('2 MiB')
  })
})
