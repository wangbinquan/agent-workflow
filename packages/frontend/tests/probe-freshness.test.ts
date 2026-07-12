// RFC-169 (T15) — locks the MCP probe freshness oracle: fresh iff the probe
// started strictly after the last config save; ms-equal = stale (fail-closed);
// null probe = not fresh.

import { describe, expect, test } from 'vitest'
import { probeFreshness } from '../src/lib/probe-freshness'

describe('probeFreshness', () => {
  test('probe started after the last save → fresh', () => {
    expect(probeFreshness({ startedAt: 200 }, 100)).toBe(true)
  })
  test('probe started before the last save → stale', () => {
    expect(probeFreshness({ startedAt: 100 }, 200)).toBe(false)
  })
  test('ms-equal → stale (fail-closed)', () => {
    expect(probeFreshness({ startedAt: 100 }, 100)).toBe(false)
  })
  test('null / undefined probe → not fresh', () => {
    expect(probeFreshness(null, 100)).toBe(false)
    expect(probeFreshness(undefined, 100)).toBe(false)
  })
  test('probe-start → save → probe-finish race: the earlier start reads stale', () => {
    // Probe started at t=100, a config save landed at t=150; even a later finish
    // cannot make the result fresh — startedAt (100) < updatedAt (150).
    expect(probeFreshness({ startedAt: 100 }, 150)).toBe(false)
  })
})
