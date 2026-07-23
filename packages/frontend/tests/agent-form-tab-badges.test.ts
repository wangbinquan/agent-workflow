// RFC-169 (T7) — the AgentForm tab-count badge oracles, unit-tested directly.
// These replace the RFC-155 hasResourceContent/hasAdvancedContent rising-edge
// oracles: the "there's content here" hint is now a count badge on the Ports
// and Resources tabs.

import { describe, expect, test } from 'vitest'
import { emptyAgent, portBadgeCount, resourceRefCount } from '../src/components/AgentForm'

describe('portBadgeCount', () => {
  test('empty draft → 0', () => {
    expect(portBadgeCount(emptyAgent())).toBe(0)
  })
  test('inputs + outputs summed', () => {
    expect(
      portBadgeCount({
        ...emptyAgent(),
        inputs: [
          { name: 'a', kind: 'string' },
          { name: 'b', kind: 'string' },
        ],
        outputs: ['x'],
      }),
    ).toBe(3)
  })
  test('missing inputs field treated as 0', () => {
    const v = { ...emptyAgent(), outputs: ['x', 'y'] }
    delete (v as { inputs?: unknown }).inputs
    expect(portBadgeCount(v)).toBe(2)
  })
})

describe('resourceRefCount', () => {
  test('empty draft → 0', () => {
    expect(resourceRefCount(emptyAgent())).toBe(0)
  })
  test('skills + mcp + plugins + dependsOn summed', () => {
    expect(
      resourceRefCount({
        ...emptyAgent(),
        skills: [
          { kind: 'project', name: 's1' },
          { kind: 'project', name: 's2' },
        ],
        mcp: ['m'],
        plugins: ['p'],
        dependsOn: ['d1', 'd2'],
      }),
    ).toBe(6)
  })
})
