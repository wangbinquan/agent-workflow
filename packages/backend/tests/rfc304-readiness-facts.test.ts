// RFC-304/RFC-375 — retain the live readiness verdict after retiring its unused reader.
import { describe, expect, test } from 'bun:test'
import {
  deriveReadiness,
  type ReadinessInput,
} from '../src/modules/code-capability/domain/templateLayers'

const unconfigured: ReadinessInput = {
  enabled: true,
  hasBinding: false,
  frameworkExists: false,
  hasTrigger: false,
  codeHostConfigured: false,
  invisibleAgentSlots: ['reviewer'],
  requiresWakeSource: false,
  hasWakeSource: false,
}

describe('RFC-304 — facts feed the verdict', () => {
  test('an unconfigured repository derives MISCONFIGURED, naming what is missing', () => {
    const { state, issues } = deriveReadiness(unconfigured)
    expect(state).toBe('misconfigured')
    const codes = issues.map((issue) => issue.code)
    expect(codes).toContain('no-binding')
    expect(codes).toContain('code-host-unconfigured')
  })
  test('a disabled cell is DISABLED, not misconfigured', () => {
    expect(deriveReadiness({ ...unconfigured, enabled: false }).state).toBe('disabled')
  })
})
