// RFC-282 C0+C2 — runtime-fence hardening locks.
//
// C0: the runner's re-export laundering channel is GONE — `import {x} from
//     '@/services/runner'` can no longer hand out opencode internals that the
//     importer-side ESLint rule cannot see; ProbeOpts has one definition
//     (runtime/types), util/opencode only re-exports it (until C3 moves it).
// C2: runtime dispatch is capability-driven — the `readInventory !==
//     undefined` proxy (an if-opencode-else-claude in disguise; a third
//     runtime silently fell into the claude branch) is gone from both
//     consumers, and an unknown runtime kind THROWS on execution paths while
//     read/display paths degrade per-row (决策 13 v2 / 设计门 P2-1).
//     The P2-E followup guard survives: observationRequiresFreshRun comes
//     FIRST, so an opencode followup still records NO verification row.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getRuntimeDriver, tryGetRuntimeDriver } from '../src/services/runtime'
import type { RuntimeKind } from '../src/services/runtime'

const SRC = resolve(import.meta.dir, '..', 'src')
const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8')

describe('RFC-282 C0 — laundering channel closed', () => {
  test('runner.ts no longer re-exports driver internals', () => {
    const text = read('services/runner.ts')
    expect(text).not.toMatch(/export\s+\{[^}]*\}\s+from\s+'\.\/runtime\/(?:opencode|claudeCode)\//)
  })

  test('ProbeOpts has ONE definition (runtime/types); util/opencode re-exports it', () => {
    expect(read('services/runtime/types.ts')).toContain('export interface ProbeOpts')
    const util = read('util/opencode.ts')
    expect(util).not.toContain('export interface ProbeOpts')
    expect(util).toContain("export type { ProbeOpts } from '@/services/runtime/types'")
  })
})

describe('RFC-282 C2 — capability-driven dispatch', () => {
  test('unknown runtime kind THROWS on the execution lookup (no silent opencode)', () => {
    expect(() => getRuntimeDriver('made-up-runtime' as RuntimeKind)).toThrow(
      /unknown runtime kind 'made-up-runtime'/,
    )
  })

  test('read/display lookup degrades to null instead of throwing (P2-1)', () => {
    expect(tryGetRuntimeDriver('made-up-runtime')).toBeNull()
    expect(tryGetRuntimeDriver(null)).toBeNull()
    expect(tryGetRuntimeDriver(undefined)).toBeNull()
    expect(tryGetRuntimeDriver('opencode')).not.toBeNull()
  })

  test('the readInventory proxy predicate is gone from both consumers', () => {
    for (const rel of ['services/runner.ts', 'services/mcpRuntimeTest.ts']) {
      const text = read(rel)
      expect(text, `${rel} still discriminates on readInventory presence`).not.toContain(
        'readInventory !== undefined',
      )
    }
  })

  test('runner switches on startupObservation with the fresh-run guard FIRST (P1-7 / P2-E)', () => {
    const text = read('services/runner.ts')
    const guardIdx = text.indexOf('caps.observationRequiresFreshRun && !wantsInventory')
    const switchIdx = text.indexOf('switch (caps.startupObservation)')
    expect(guardIdx).toBeGreaterThan(0)
    expect(switchIdx).toBeGreaterThan(guardIdx)
    // exhaustive arms incl. the third-runtime case
    expect(text).toContain("case 'inventory-file':")
    expect(text).toContain("case 'init-event':")
    expect(text).toContain("case 'none':")
    expect(text).toContain("reason: 'runtime-has-no-observation'")
  })

  test('C2 followup regression lock: fresh-run-only observation + no fresh run ⇒ skip recording', () => {
    // The guard is data-driven now: for opencode (observationRequiresFreshRun
    // = true) a followup (wantsInventory=false) must skip verification —
    // exactly RFC-280 实现门 P2-E's behavior, re-expressed over capabilities.
    const oc = getRuntimeDriver('opencode').capabilities
    expect(oc.observationRequiresFreshRun && !false).toBe(true) // followup shape skips
    const cl = getRuntimeDriver('claude-code').capabilities
    expect(cl.observationRequiresFreshRun).toBe(false) // claude always observes
  })

  test('DRIVERS fallback `?? opencodeDriver` is gone from the registry', () => {
    const text = read('services/runtime/index.ts')
    expect(text).not.toContain('?? opencodeDriver')
  })
})
