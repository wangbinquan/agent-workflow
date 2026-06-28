// RFC-117 — filterSelectableRuntimes is the testable core of useRuntimesList,
// shared by the AgentForm runtime picker and the settings runtime selectors
// (distiller / commit / fusion). Locks the RFC-118 disabled-filter + the
// claude-protocol gating + the "keep the already-selected runtime even if
// disabled" rule (RFC-118 D6) — so the settings pickers can't drift from the
// agent picker.

import { describe, expect, test } from 'vitest'
import { filterSelectableRuntimes } from '../src/hooks/useRuntimesList'

const RT = (name: string, protocol: string, enabled: boolean) => ({ name, protocol, enabled })

const ALL = [
  RT('opencode', 'opencode', true),
  RT('claude-code', 'claude-code', true),
  RT('oc-haiku', 'opencode', true),
  RT('oc-old', 'opencode', false), // disabled
]

describe('filterSelectableRuntimes (RFC-117 / RFC-118)', () => {
  test('keeps enabled runtimes; drops disabled', () => {
    const names = filterSelectableRuntimes(ALL, null, true).map((r) => r.name)
    expect(names).toEqual(['opencode', 'claude-code', 'oc-haiku'])
    expect(names).not.toContain('oc-old')
  })

  test('keeps a disabled runtime when it is the current selection (RFC-118 D6)', () => {
    const names = filterSelectableRuntimes(ALL, 'oc-old', true).map((r) => r.name)
    expect(names).toContain('oc-old')
  })

  test('drops claude-protocol runtimes when claude-code is disabled', () => {
    const names = filterSelectableRuntimes(ALL, null, false).map((r) => r.name)
    expect(names).not.toContain('claude-code')
    expect(names).toEqual(['opencode', 'oc-haiku'])
  })

  test('a disabled claude runtime stays hidden even as current when claude is off', () => {
    const withDisabledClaude = [...ALL, RT('cc-fork', 'claude-code', false)]
    const names = filterSelectableRuntimes(withDisabledClaude, 'cc-fork', false).map((r) => r.name)
    // current-value passes the enabled gate, but the claude-off gate still drops it.
    expect(names).not.toContain('cc-fork')
  })
})
