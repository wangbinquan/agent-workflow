// RFC-115 config loss cases enter B before parsing strips legacy defaults.
import { expect, test } from 'bun:test'
import {
  runtimeConfigBlock,
  type RuntimeConfigFact,
} from '@/modules/runtime-management/infrastructure/migration/runtimeConfigRule'
const base: RuntimeConfigFact = {
  state: 'present',
  source: 'config.json',
  opencodePath: null,
  claudeCodePath: null,
  legacyDefaults: {},
  profiles: [],
}
test.each([
  'defaultModel',
  'defaultVariant',
  'defaultTemperature',
  'defaultSteps',
  'defaultMaxSteps',
  'defaultClaudeModel',
])('%s with missing/all-null canonical profiles blocks conversion', (key) => {
  expect(runtimeConfigBlock({ ...base, legacyDefaults: { [key]: 'legacy' } })).toBe(
    'v2-boot-runtime-defaults-unmigrated',
  )
})
test('a persisted canonical profile proves defaults survived the old upgrade', () => {
  expect(
    runtimeConfigBlock({
      ...base,
      legacyDefaults: { defaultModel: 'legacy' },
      profiles: [
        { id: 'canonical', name: 'opencode', protocol: 'opencode', values: { model: 'legacy' } },
      ],
    }),
  ).toBeNull()
})
test('absent/default-free config is accepted; unreadable source requires evidence', () => {
  expect(runtimeConfigBlock(base)).toBeNull()
  expect(runtimeConfigBlock({ ...base, state: 'absent' })).toBeNull()
  expect(runtimeConfigBlock({ ...base, state: 'unavailable' })).toBe(
    'v2-boot-runtime-config-unproven',
  )
  expect(runtimeConfigBlock({ ...base, state: 'invalid' })).toBe('v2-boot-runtime-config-unproven')
})

// The wrong-protocol canonical-name case is exercised by the frozen-source
// conversion matrix in rfc395-boot-runtime-config.test.ts (wrong-protocol).
