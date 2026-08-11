// RFC-282 A3 (§4.3) — boot self-check: a driver that has not taken a stance
// on every declaration face must be refused at startup, because a face it
// silently lacks makes the verification layer believe it is verifying
// (RFC-247 rationale / RFC-280 实现门 P2-D).
//
// Positive proof lives here too (只有能抓到违规的守卫才算守卫): a mock driver
// with a face removed / an illegal observation source is actually refused.

import { describe, expect, test } from 'bun:test'
import {
  assertRuntimeDeclarations,
  declarationFaceUniverse,
  verifyRuntimeDeclarations,
} from '../src/services/runtime/selfCheck'
import { getRuntimeDriver, RUNTIME_KINDS } from '../src/services/runtime'
import {
  DISABLED_RESOURCE_POLICY,
  notModeledDisabledKinds,
} from '../src/services/execution/resourcePolicy'
import type { RuntimeDriver } from '../src/services/runtime/types'

const REAL_DRIVERS = RUNTIME_KINDS.map(getRuntimeDriver)

function mockDriverWith(caps: unknown): RuntimeDriver {
  return { kind: 'opencode', capabilities: caps } as unknown as RuntimeDriver
}

const FULL_FACES = Object.fromEntries(
  declarationFaceUniverse().map((f) => [f, 'supported']),
) as Record<string, string>

describe('RFC-282 A3 — self-check accepts the real registry', () => {
  test('every registered driver passes; not-modeled rows are reported separately', () => {
    const { notModeled } = assertRuntimeDeclarations(REAL_DRIVERS)
    // agent.enabled is not consumed anywhere today — the gap must stay visible.
    expect(notModeled.length).toBe(1)
    expect(notModeled[0]).toContain('agent')
  })

  test('face universe derives from the runtime manifest shape (9 faces today)', () => {
    expect([...declarationFaceUniverse()].sort() as string[]).toEqual(
      [
        'mcpServers',
        'skippedDisabledMcps',
        'skills',
        'subagents',
        'plugins',
        'tools',
        'droppedParams',
        'unsupported',
        'unobservable',
      ].sort(),
    )
  })
})

describe('RFC-282 A3 — self-check refuses broken declarations (positive proof)', () => {
  test('a driver missing one face is refused, by name', () => {
    const { plugins: _dropped, ...missingOne } = FULL_FACES
    const report = verifyRuntimeDeclarations([
      mockDriverWith({
        startupObservation: 'none',
        observationRequiresFreshRun: false,
        declarationFaces: missingOne,
      }),
    ])
    expect(report.problems.length).toBe(1)
    expect(report.problems[0]).toContain("missing a stance for 'plugins'")
    expect(() =>
      assertRuntimeDeclarations([
        mockDriverWith({
          startupObservation: 'none',
          observationRequiresFreshRun: false,
          declarationFaces: missingOne,
        }),
      ]),
    ).toThrow(/self-check failed/)
  })

  test('an illegal startupObservation is refused', () => {
    const report = verifyRuntimeDeclarations([
      mockDriverWith({
        startupObservation: 'telepathy',
        observationRequiresFreshRun: false,
        declarationFaces: FULL_FACES,
      }),
    ])
    expect(report.problems.some((p) => p.includes("'telepathy'"))).toBe(true)
  })

  test('an illegal face stance is refused', () => {
    const report = verifyRuntimeDeclarations([
      mockDriverWith({
        startupObservation: 'none',
        observationRequiresFreshRun: false,
        declarationFaces: { ...FULL_FACES, tools: 'maybe' },
      }),
    ])
    expect(report.problems.some((p) => p.includes("declarationFaces['tools'] = 'maybe'"))).toBe(
      true,
    )
  })

  test('absent capabilities object is refused', () => {
    const report = verifyRuntimeDeclarations([mockDriverWith(undefined)])
    expect(report.problems).toEqual(["driver 'opencode': capabilities missing"])
  })
})

describe('RFC-282 A3 — driver stances are pinned (copied from today, change = review)', () => {
  test('opencode', () => {
    const d = getRuntimeDriver('opencode')
    expect(d.capabilities.startupObservation).toBe('inventory-file')
    expect(d.capabilities.observationRequiresFreshRun).toBe(true)
    expect(d.capabilities.declarationFaces).toEqual({
      mcpServers: 'supported',
      skills: 'supported',
      subagents: 'supported',
      plugins: 'unobservable',
      tools: 'unsupported',
      droppedParams: 'unsupported',
      skippedDisabledMcps: 'supported',
      unsupported: 'supported',
      unobservable: 'supported',
    })
  })

  test('claude-code', () => {
    const d = getRuntimeDriver('claude-code')
    expect(d.capabilities.startupObservation).toBe('init-event')
    expect(d.capabilities.observationRequiresFreshRun).toBe(false)
    expect(d.capabilities.declarationFaces).toEqual({
      mcpServers: 'supported',
      skills: 'supported',
      subagents: 'supported',
      plugins: 'unsupported',
      tools: 'supported',
      droppedParams: 'supported',
      skippedDisabledMcps: 'supported',
      unsupported: 'supported',
      unobservable: 'supported',
    })
  })
})

describe('RFC-282 A3 — DISABLED_RESOURCE_POLICY (values copied, one readable point)', () => {
  test('dispositions are exactly the pre-RFC rules — v2: zero product behavior change', () => {
    expect(DISABLED_RESOURCE_POLICY.plugin.disposition).toBe('fail-closed')
    expect(DISABLED_RESOURCE_POLICY.mcp.disposition).toBe('skip-and-declare')
    expect(DISABLED_RESOURCE_POLICY.mcp.declaredField).toBe('skippedDisabledMcps')
    expect(DISABLED_RESOURCE_POLICY.agent.disposition).toBe('not-modeled')
    expect(notModeledDisabledKinds()).toEqual(['agent'])
  })

  test('every entry carries its why (the table is the readable point, not a bare enum)', () => {
    for (const entry of Object.values(DISABLED_RESOURCE_POLICY)) {
      expect(entry.why.length).toBeGreaterThan(10)
    }
  })
})
