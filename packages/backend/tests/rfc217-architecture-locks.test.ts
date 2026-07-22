// RFC-217 — architecture guard locks (table-driven, grows with each PR).
//
// T1 locks (G1 family): the module-init-cycle guard is only real if
//   (a) the dependency-cruiser rule exists,
//   (b) CI actually RUNS depcheck (design-gate finding: the script existed
//       for months while neither `lint` nor ci.yml ever invoked it), and
//   (c) services/workgroup/constants.ts stays a ZERO-IMPORT leaf — it was
//       extracted precisely to cut `launch → task → scheduler → runner →
//       rounds → launch` (RFC-079 class: top-level const evaluates to
//       undefined under an unlucky init order; only build:binary caught it).
//   (d) production code never re-grows the cycle edge by importing the
//       sentinel constants from workgroup/launch again.
//
// Every lock here has been mutation-verified (break it → this file reds).

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8')

describe('rfc217 G1 — no-circular guard is real', () => {
  test('dependency-cruiser config carries an error-severity no-circular rule', () => {
    const cfg = read('.dependency-cruiser.cjs')
    expect(cfg).toContain("name: 'no-circular'")
    expect(cfg).toContain('circular: true')
    // type-only edges vanish at emit — the rule must keep ignoring them,
    // otherwise the 5 outputKinds type-import cycles instantly red CI.
    expect(cfg).toContain("viaOnly: { dependencyTypesNot: ['type-only'] }")
  })

  test('CI wires depcheck (a rule nobody runs is not a lock)', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('bun run depcheck')
  })

  test('workgroup/constants.ts is a zero-import leaf module', () => {
    const src = read('packages/backend/src/services/workgroup/constants.ts')
    expect(src).not.toMatch(/^\s*import\b/m)
    expect(src).not.toMatch(/\brequire\s*\(/)
    // the sentinels themselves must stay here (wire-frozen values)
    expect(src).toContain("'__wg_leader__'")
    expect(src).toContain("'__wg_member__'")
    expect(src).toContain("'__wg_clarify__'")
  })

  test('production src never imports sentinel constants from workgroup/launch', () => {
    // the launch re-export exists for legacy TEST importers only; production
    // importing constants via launch re-opens the heavy-module cycle edge.
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`
        if (e.isDirectory()) walk(rel)
        else if (e.name.endsWith('.ts')) {
          const src = read(rel)
          const re = /import\s*\{([^}]*)\}\s*from\s*'(?:@\/services\/workgroup\/launch|\.\/launch|\.\.\/workgroup\/launch)'/g
          for (const m of src.matchAll(re)) {
            if (/WG_|WORKGROUP_HOST/.test(m[1] ?? '')) offenders.push(rel)
          }
        }
      }
    }
    walk('packages/backend/src')
    expect(offenders).toEqual([])
  })
})
