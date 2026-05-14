// P-5-09: restart-banner detection logic. Routes file co-locates the helper
// next to its only consumer; tested here in isolation so we don't have to
// drive the full settings page through happy-dom.

import { describe, expect, test } from 'vitest'
import { hasRestartRequiredChange, RESTART_REQUIRED_KEYS } from '../src/routes/settings'

describe('hasRestartRequiredChange', () => {
  test('bindPort change triggers restart banner', () => {
    expect(
      hasRestartRequiredChange(['bindHost', 'bindPort'], { bindPort: 0 }, { bindPort: 9000 }),
    ).toBe(true)
  })

  test('bindHost change triggers restart banner', () => {
    expect(
      hasRestartRequiredChange(
        ['bindHost', 'bindPort'],
        { bindHost: '127.0.0.1' },
        { bindHost: '0.0.0.0' },
      ),
    ).toBe(true)
  })

  test('saving the same value does NOT trigger', () => {
    expect(
      hasRestartRequiredChange(
        ['bindHost', 'bindPort'],
        { bindHost: '127.0.0.1', bindPort: 7700 },
        { bindHost: '127.0.0.1', bindPort: 7700 },
      ),
    ).toBe(false)
  })

  test('non-restart keys never trigger even when value moves', () => {
    expect(hasRestartRequiredChange(['theme'], { theme: 'system' }, { theme: 'dark' })).toBe(false)
  })

  test('tab that does not touch restart keys never triggers', () => {
    expect(
      hasRestartRequiredChange(
        ['maxConcurrentNodes'],
        { maxConcurrentNodes: 4 },
        { maxConcurrentNodes: 8 },
      ),
    ).toBe(false)
  })

  test('exported set is exactly {bindHost, bindPort}', () => {
    expect([...RESTART_REQUIRED_KEYS].sort()).toEqual(['bindHost', 'bindPort'])
  })
})
