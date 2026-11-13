// RFC-111 PR-A — locks the getRuntimeDriver factory (kind → driver).
//
// RFC-143: the sibling `resolveRuntime` pure fn (a hardcoded
// `raw === 'claude-code' ? ... : 'opencode'` three-way, zero production
// callers — the fresh-dispatch runtime selection actually flows through
// runtimeRegistry.resolveAgentRuntime) was deleted: it was a flag-audit旁路
// (a third runtime would be silently coerced to opencode). This file now
// locks only the factory.

import { describe, expect, it } from 'bun:test'
import { getRuntimeDriver } from '@/modules/runtime-management/infrastructure/drivers'

describe('getRuntimeDriver — factory (RFC-111 PR-A)', () => {
  it('returns the opencode driver for opencode', () => {
    expect(getRuntimeDriver('opencode').kind).toBe('opencode')
  })

  it('returns the claude-code driver (RFC-111 PR-B registered it)', () => {
    expect(getRuntimeDriver('claude-code').kind).toBe('claude-code')
  })
})
