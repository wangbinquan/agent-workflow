// RFC-111 PR-A — locks `resolveRuntime`'s three-layer fallback + the
// getRuntimeDriver factory. resolveRuntime is the single source for "which
// runtime does a fresh dispatch use" (D1 global default + per-agent override);
// D15 freezes the result onto node_runs.runtime so resume never re-resolves.
//
// If this goes red after an agent/default schema change, the runtime selection
// contract drifted — every spawn + the frozen-runtime resume path depends on it.

import { describe, expect, it } from 'bun:test'
import { getRuntimeDriver, resolveRuntime } from '@/services/runtime'

describe('resolveRuntime — three-layer fallback (RFC-111 D1)', () => {
  it('per-agent runtime wins over the global default', () => {
    expect(resolveRuntime('claude-code', 'opencode')).toBe('claude-code')
    expect(resolveRuntime('opencode', 'claude-code')).toBe('opencode')
  })

  it('falls back to the global default when the agent inherits', () => {
    expect(resolveRuntime(null, 'claude-code')).toBe('claude-code')
    expect(resolveRuntime(undefined, 'claude-code')).toBe('claude-code')
    expect(resolveRuntime('', 'claude-code')).toBe('claude-code') // '' = inherit, not a value
  })

  it('falls back to opencode when neither is set (legacy zero-change default)', () => {
    expect(resolveRuntime(null, null)).toBe('opencode')
    expect(resolveRuntime(undefined, undefined)).toBe('opencode')
    expect(resolveRuntime('', '')).toBe('opencode')
  })

  it('coerces an unrecognized value to opencode (fresh-dispatch only)', () => {
    expect(resolveRuntime('bogus', null)).toBe('opencode')
    expect(resolveRuntime(null, 'who-knows')).toBe('opencode')
  })
})

describe('getRuntimeDriver — factory (RFC-111 PR-A)', () => {
  it('returns the opencode driver for opencode', () => {
    expect(getRuntimeDriver('opencode').kind).toBe('opencode')
  })

  it('returns the claude-code driver (RFC-111 PR-B registered it)', () => {
    expect(getRuntimeDriver('claude-code').kind).toBe('claude-code')
  })
})
