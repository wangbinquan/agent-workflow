// RFC-281 T1 — locks the opencode workspace-boundary permission synthesis.
//
// Why this file exists (do not delete on refactor): RFC-281 confines an agent's
// writes/execution to its own task worktree via opencode's `external_directory`
// permission key. The load-bearing invariant is KEY ORDER — proven by T0 live
// probes (design §5 E4/M1): the platform's `external_directory` deny baseline
// must sit AFTER the author's other keys (especially a `'*': 'allow'`), or the
// author's wildcard dissolves the boundary (越界放行). A value-only assertion
// cannot see an ordering regression, so several tests assert key INDICES.
//
// Anchor: production event that motivated the RFC — an agent wandered into a
// sibling task's worktree and executed there. See design/RFC-281 §1.

import { describe, expect, test } from 'bun:test'
import {
  composeOpencodeBoundary,
  type BoundaryCtx,
} from '../src/services/execution/workspaceBoundary'

const CTX: BoundaryCtx = {
  taskMounts: ['/home/aw/iso/T1/R1'],
  runDir: '/home/aw/runs/T1/R1',
  stagedSkillDirs: ['/home/aw/skills/audit/files'],
  tmpGlobs: ['/tmp/opencode/*'],
}

describe('composeOpencodeBoundary — deny baseline + re-allow', () => {
  test('undefined author yields a deny baseline with re-allow globs, baseline first', () => {
    const out = composeOpencodeBoundary(undefined, CTX)
    const ext = out['external_directory'] as Record<string, string>
    const keys = Object.keys(ext)
    // '*': 'deny' is the baseline and MUST be the first rule (findLast → later
    // allows win over it, never the reverse).
    expect(keys[0]).toBe('*')
    expect(ext['*']).toBe('deny')
    // every W(run) member is re-allowed as `<dir>/*`.
    expect(ext['/home/aw/runs/T1/R1/*']).toBe('allow')
    expect(ext['/home/aw/skills/audit/files/*']).toBe('allow')
    expect(ext['/home/aw/iso/T1/R1/*']).toBe('allow')
    expect(ext['/tmp/opencode/*']).toBe('allow')
  })

  test('gitMetaDirs are re-allowed when present', () => {
    const out = composeOpencodeBoundary(undefined, {
      ...CTX,
      gitMetaDirs: ['/home/user/repo/.git/worktrees/iso'],
    })
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['/home/user/repo/.git/worktrees/iso/*']).toBe('allow')
  })

  test('trailing slashes on dirs do not produce double slashes', () => {
    const out = composeOpencodeBoundary(undefined, { ...CTX, runDir: '/home/aw/runs/T1/R1/' })
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['/home/aw/runs/T1/R1/*']).toBe('allow')
    expect(ext['/home/aw/runs/T1/R1//*']).toBeUndefined()
  })
})

describe('composeOpencodeBoundary — key-order discipline (E4/M1)', () => {
  test("author '*':'allow' cannot dissolve the boundary — external_directory is appended AFTER it", () => {
    const out = composeOpencodeBoundary({ '*': 'allow' }, CTX)
    const keys = Object.keys(out)
    // The whole point: external_directory index > author '*' index, so opencode's
    // findLast picks the deny baseline over the author wildcard (E4 proven).
    expect(keys.indexOf('external_directory')).toBeGreaterThan(keys.indexOf('*'))
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['*']).toBe('deny')
    // author's top-level '*':'allow' is preserved in place (governs OTHER keys,
    // not external_directory, thanks to the ordering).
    expect(out['*']).toBe('allow')
  })

  test('author non-external keys keep their original order; external_directory is last', () => {
    const out = composeOpencodeBoundary({ bash: 'allow', '*': 'allow', read: 'allow' }, CTX)
    const keys = Object.keys(out)
    expect(keys).toEqual(['bash', '*', 'read', 'external_directory'])
  })
})

describe('composeOpencodeBoundary — author external_directory handling', () => {
  test('author record whitelist is honored AFTER the deny baseline (findLast wins)', () => {
    const out = composeOpencodeBoundary(
      { external_directory: { '/home/user/refrepo/*': 'allow' } },
      CTX,
    )
    const ext = out['external_directory'] as Record<string, string>
    const keys = Object.keys(ext)
    expect(keys[0]).toBe('*')
    expect(ext['*']).toBe('deny')
    // author's explicit allow sits after the baseline → it wins for that path.
    expect(ext['/home/user/refrepo/*']).toBe('allow')
    expect(keys.indexOf('/home/user/refrepo/*')).toBeGreaterThan(keys.indexOf('*'))
  })

  test("author scalar external_directory 'allow' takes over the whole key (no baseline)", () => {
    const out = composeOpencodeBoundary({ external_directory: 'allow' }, CTX)
    // explicit scalar = author owns it; platform does not synthesize a baseline
    // (design §3.3 — save-time warns that this waives the boundary).
    expect(out['external_directory']).toBe('allow')
  })

  test("author scalar external_directory 'deny' is left untouched", () => {
    const out = composeOpencodeBoundary({ external_directory: 'deny' }, CTX)
    expect(out['external_directory']).toBe('deny')
  })

  test('author record with its own deny/ask entries is carried through', () => {
    const out = composeOpencodeBoundary(
      { external_directory: { '/x/*': 'deny', '/y/*': 'ask' } },
      CTX,
    )
    const ext = out['external_directory'] as Record<string, string>
    expect(ext['/x/*']).toBe('deny')
    expect(ext['/y/*']).toBe('ask')
    expect(ext['*']).toBe('deny')
  })
})
