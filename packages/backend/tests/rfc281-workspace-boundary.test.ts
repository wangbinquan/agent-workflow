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
  claudeExpressibleAuthorDirs,
  composeClaudeBoundarySettings,
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

// ---------------------------------------------------------------------------
// claude side (T2/T3) — write-only boundary, no deny lists
// ---------------------------------------------------------------------------

describe('composeClaudeBoundarySettings — write boundary only', () => {
  test('emits sandbox with allowWrite for this task’s mounts and nothing else', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/home/aw/iso/T1/R1'],
      explicitPermission: false,
    })
    expect(s.sandbox.enabled).toBe(true)
    expect(s.sandbox.allowUnsandboxedCommands).toBe(false)
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/home/aw/iso/T1/R1'])
    // bypassPermissions nodes read freely; no additionalDirectories needed.
    expect(s.permissions).toBeUndefined()
  })

  test('NEVER emits denyWrite or a deny list (T0 §5-2: it would kill the agent’s own cwd)', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/home/aw/iso/T1/R1', '/home/aw/iso/T1/R2'],
      gitMetaDirs: ['/home/user/repo/.git/worktrees/iso'],
      authorAllowDirs: ['/home/user/refrepo'],
      explicitPermission: true,
    })
    const json = JSON.stringify(s)
    // The §0 lock: any denyWrite/denyRead/permissions.deny would risk breaking
    // legitimate business writes (an appHome-ancestor denyWrite shadows cwd).
    expect(json).not.toContain('denyWrite')
    expect(json).not.toContain('denyRead')
    expect(json).not.toContain('"deny"')
    // appHome root itself must never appear as a governed path.
    expect(s.sandbox.filesystem.allowWrite).not.toContain('/home/aw')
  })

  test('explicit-permission nodes get additionalDirectories so multi-repo mounts stay readable (B4)', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/mnt/a', '/mnt/b'],
      authorAllowDirs: ['/ref'],
      explicitPermission: true,
    })
    expect(s.permissions?.additionalDirectories).toEqual(['/mnt/a', '/mnt/b', '/ref'])
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/mnt/a', '/mnt/b', '/ref'])
  })

  test('dedupes and strips trailing slashes across mounts / git dirs / author dirs', () => {
    const s = composeClaudeBoundarySettings({
      taskMounts: ['/mnt/a/', '/mnt/a'],
      gitMetaDirs: ['/mnt/a'],
      authorAllowDirs: ['/ref/', ''],
      explicitPermission: false,
    })
    expect(s.sandbox.filesystem.allowWrite).toEqual(['/mnt/a', '/ref'])
  })
})

describe('claudeExpressibleAuthorDirs — literal dirs only, lossy globs disclosed', () => {
  test('literal dirs (with or without /*) become claude-expressible paths', () => {
    const r = claudeExpressibleAuthorDirs({
      external_directory: { '/home/me/refrepo/*': 'allow', '/opt/data': 'allow' },
    })
    expect(r.dirs).toEqual(['/home/me/refrepo', '/opt/data'])
    expect(r.lossy).toEqual([])
  })

  test('mid-pattern globs are reported as lossy, never silently dropped', () => {
    const r = claudeExpressibleAuthorDirs({ external_directory: { '/a/*/b': 'allow' } })
    expect(r.dirs).toEqual([])
    expect(r.lossy).toEqual(['/a/*/b'])
  })

  test('non-allow entries and the bare wildcard are ignored', () => {
    const r = claudeExpressibleAuthorDirs({
      external_directory: { '*': 'allow', '/x': 'deny', '/y': 'ask' },
    })
    expect(r.dirs).toEqual([])
    expect(r.lossy).toEqual([])
  })

  test('missing / scalar external_directory yields nothing', () => {
    expect(claudeExpressibleAuthorDirs(undefined).dirs).toEqual([])
    expect(claudeExpressibleAuthorDirs({ external_directory: 'allow' }).dirs).toEqual([])
  })
})
