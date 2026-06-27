// RFC-112 PR-C — pickRuntimeHead golden contract. The spawn argv head selection
// is the ONE place custom binaries diverge from RFC-111: a custom runtime's
// frozen binary overrides the protocol default, while a built-in (null binary)
// must fall back to the EXACT RFC-111 head so the opencode/claude spawn stays
// byte-for-byte identical. This locks both directions.

import { describe, expect, test } from 'bun:test'
import { pickRuntimeHead } from '../src/services/runner'

describe('pickRuntimeHead (RFC-112 PR-C)', () => {
  test('built-in (null/empty binary) falls back to the RFC-111 head (golden)', () => {
    // opencode built-in: fallback = opts.opencodeCmd (production opencodePath / test mock).
    expect(pickRuntimeHead(null, ['bun', 'run', '/mock-opencode.ts'])).toEqual([
      'bun',
      'run',
      '/mock-opencode.ts',
    ])
    expect(pickRuntimeHead(undefined, ['opencode'])).toEqual(['opencode'])
    expect(pickRuntimeHead('', ['opencode'])).toEqual(['opencode'])
  })

  test('built-in claude (null binary, no fallback) → undefined → buildClaudeSpawn defaults to [claude]', () => {
    expect(pickRuntimeHead(null, undefined)).toBeUndefined()
    expect(pickRuntimeHead(undefined, undefined)).toBeUndefined()
  })

  test('a custom binary wins over the fallback (the registered fork runs)', () => {
    expect(pickRuntimeHead('/usr/local/bin/my-oc', ['opencode'])).toEqual(['/usr/local/bin/my-oc'])
    expect(pickRuntimeHead('/opt/my-cc', undefined)).toEqual(['/opt/my-cc'])
    // even with a test fallback present, the custom binary takes precedence.
    expect(pickRuntimeHead('/opt/fork', ['bun', 'run', '/mock.ts'])).toEqual(['/opt/fork'])
  })
})
