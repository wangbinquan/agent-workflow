// RFC-169 (T15) — locks the MCP probe freshness oracle: fresh iff the probe
// started strictly after the last config save; ms-equal = stale (fail-closed);
// null probe = not fresh.

import { describe, expect, test } from 'vitest'
import type { McpProbe } from '@agent-workflow/shared'
import { probeFreshness } from '../src/lib/probe-freshness'
import { probeUiStatus } from '../src/routes/mcps'

function probe(status: McpProbe['status'], startedAt: number): McpProbe {
  return { status, startedAt } as McpProbe
}

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

describe('probeUiStatus', () => {
  test('missing, stale, or ms-equal probes collapse to unknown', () => {
    expect(probeUiStatus(null, 100)).toBe('unknown')
    expect(probeUiStatus(probe('ok', 99), 100)).toBe('unknown')
    expect(probeUiStatus(probe('error', 100), 100)).toBe('unknown')
  })

  test('fresh probes preserve their operational result', () => {
    expect(probeUiStatus(probe('ok', 101), 100)).toBe('ok')
    expect(probeUiStatus(probe('error', 101), 100)).toBe('error')
  })
})
