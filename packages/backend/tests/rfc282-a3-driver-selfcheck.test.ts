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
    // RFC-284 T3 改判：v1 断言 notModeled 含 'agent'——那个条目声称 agents.enabled
    // 存在，实测 schema 里没有该列（审计 N1，决策 D2 删除）。现表内条目全部
    // 有真实 disposition，not-modeled 报告为空；列存在性由
    // rfc284-resource-policy-schema-guard.test.ts 反射 drizzle 表守住。
    expect(notModeled).toEqual([])
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

  // RFC-284 T4（审计 N2）——观测声明 ⇒ 观测方法已实现 的蕴含守卫红→绿对。
  // 红：声明 inventory-file 但没有 readInventory 的 driver 必须被点名拒绝
  // （此前它能通过自检，运行期每次落 observationFromInventory(null) → unavailable，
  // 业务面挂常驻「无法验证」告警——正是 selfCheck 头注要防的形态）。
  test("declaring 'inventory-file' without readInventory() is refused (RFC-284 T4)", () => {
    const caps = {
      startupObservation: 'inventory-file',
      observationRequiresFreshRun: true,
      declarationFaces: FULL_FACES,
    }
    const red = verifyRuntimeDeclarations([mockDriverWith(caps)])
    expect(red.problems.some((p) => p.includes('does not implement readInventory()'))).toBe(true)
    // 绿：同一 capabilities + 真的实现了 readInventory → 零 problems。
    const green = verifyRuntimeDeclarations([
      {
        kind: 'opencode',
        capabilities: caps,
        readInventory: async () => null,
      } as unknown as RuntimeDriver,
    ])
    expect(green.problems).toEqual([])
  })

  // RFC-297 T15: 判据从「实现了 parseStartupInventory 方法」换成「parseEvent 对
  // 该运行时的真实 init 样本能挂出清单载荷」——方法已随 T11 删除（它与 parseEvent
  // 对同一行各解析一遍），但**能力本身仍须可核**，否则声明 'init-event' 就成了
  // 空头支票。样本由 driver 自陈，自检只问「解析得出载荷吗」。
  test("declaring 'init-event' without a parseable inventory payload is refused (RFC-284 T4 / RFC-297 T15)", () => {
    const caps = {
      startupObservation: 'init-event',
      observationRequiresFreshRun: false,
      declarationFaces: FULL_FACES,
    }
    const red = verifyRuntimeDeclarations([mockDriverWith(caps)])
    expect(red.problems.some((p) => p.includes('does not produce an inventory payload'))).toBe(true)
    // 给了样本、但 parseEvent 产不出载荷——空头支票的第二种形态，同样拒绝。
    const stillRed = verifyRuntimeDeclarations([
      {
        kind: 'claude-code',
        capabilities: caps,
        initEventSample: () => '{"type":"system","subtype":"init"}',
        parseEvent: () => null,
      } as unknown as RuntimeDriver,
    ])
    expect(stillRed.problems.some((p) => p.includes('does not produce an inventory payload'))).toBe(
      true,
    )
    const green = verifyRuntimeDeclarations([
      {
        kind: 'claude-code',
        capabilities: caps,
        initEventSample: () => 'sample',
        parseEvent: () => ({
          kind: 'step_start',
          rawLine: 'sample',
          data: { inventory: { faces: { skills: [] } } },
        }),
      } as unknown as RuntimeDriver,
    ])
    expect(green.problems).toEqual([])
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
    // RFC-284 T3 改判：'agent' 条目已删（agents 表无 enabled 列，原条目是虚构
    // 事实——审计 N1/决策 D2）；将来要给 agent 加启停须随功能 RFC 连列带语义一起来。
    expect(Object.keys(DISABLED_RESOURCE_POLICY).sort()).toEqual(['mcp', 'plugin'])
    expect(notModeledDisabledKinds()).toEqual([])
  })

  test('every entry carries its why (the table is the readable point, not a bare enum)', () => {
    for (const entry of Object.values(DISABLED_RESOURCE_POLICY)) {
      expect(entry.why.length).toBeGreaterThan(10)
    }
  })
})
