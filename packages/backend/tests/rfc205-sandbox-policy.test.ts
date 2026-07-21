// RFC-205 T1 — sandbox policy: the deny/allow single source of truth and its
// two mechanism renderers. Locks design §4-1:
//   - every threat-list item (A1/A2/A3/A5) has a corresponding deny;
//   - THIS task's worktrees + run dir are allowed back; skills/ is NOT;
//   - SBPL escaping survives paths with spaces/quotes/backslashes;
//   - bwrap arg ORDER: tmpfs(appHome) first, allow-binds after (later mounts
//     stack over earlier ones — reversed order would mask the allows).

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
} from '../src/services/sandbox/policy'

const HOME = '/h/.agent-workflow'
const input = {
  appHome: HOME,
  taskWorktrees: [join(HOME, 'worktrees', 'r1', 't1'), join(HOME, 'worktrees', 'multi', 't1')],
  runDir: join(HOME, 'runs', 't1', 'n1'),
}

describe('computeSandboxPolicy', () => {
  test('threat list → denies; own dirs → allows; skills stays denied', () => {
    const p = computeSandboxPolicy(input)
    // A1/A2 + platform secrets as files
    for (const f of [
      'secret.key',
      'db.sqlite',
      'db.sqlite-wal',
      'db.sqlite-shm',
      'token',
      'config.json',
    ]) {
      expect(p.denyFiles).toContain(join(HOME, f))
    }
    // A3/A5 + platform subtrees
    for (const d of ['backups', 'logs', 'worktrees', 'runs', 'skills', 'plugins']) {
      expect(p.denySubtrees).toContain(join(HOME, d))
    }
    // own task dirs allowed back (multi-repo = both worktrees)
    expect(p.allowSubtrees).toEqual([...input.taskWorktrees, input.runDir])
    // skills is NOT allowed back (design Q5)
    expect(p.allowSubtrees.some((a) => a.includes('skills'))).toBe(false)
  })
})

describe('renderSeatbeltProfile', () => {
  test('allow default first, denies, then allow-backs LAST (last-match-wins)', () => {
    const prof = renderSeatbeltProfile(computeSandboxPolicy(input))
    const lines = prof.split('\n')
    expect(lines[0]).toBe('(version 1)')
    expect(lines[1]).toBe('(allow default)')
    const firstDeny = lines.findIndex((l) => l.startsWith('(deny'))
    const lastDeny = lines.length - 1 - [...lines].reverse().findIndex((l) => l.startsWith('(deny'))
    const firstAllowBack = lines.findIndex((l, i) => i > 1 && l.startsWith('(allow file'))
    expect(firstDeny).toBeGreaterThan(1)
    expect(firstAllowBack).toBeGreaterThan(lastDeny) // allows must come after every deny
    expect(prof).toContain(`(deny file-read* file-write* (literal "${join(HOME, 'secret.key')}"))`)
    expect(prof).toContain(
      `(allow file-read* file-write* (subpath "${join(HOME, 'runs', 't1', 'n1')}"))`,
    )
  })

  test('SBPL escaping: quotes and backslashes in paths', () => {
    const weird = computeSandboxPolicy({
      appHome: '/h/we "ird\\dir/.agent-workflow',
      taskWorktrees: [],
      runDir: '/h/we "ird\\dir/.agent-workflow/runs/t/n',
    })
    const prof = renderSeatbeltProfile(weird)
    expect(prof).toContain('we \\"ird\\\\dir')
    // no raw unescaped quote sequence that would break the SBPL string
    expect(prof).not.toContain('we "ird\\dir/.agent-workflow/secret.key')
  })
})

describe('renderBwrapArgs', () => {
  test('order: bind / first, tmpfs appHome, then repos + allow binds', () => {
    const args = renderBwrapArgs(computeSandboxPolicy(input), { appHome: HOME })
    const tmpfsIdx = args.indexOf('--tmpfs')
    expect(args[tmpfsIdx + 1]).toBe(HOME)
    const bindPairs: string[] = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--bind') bindPairs.push(args[i + 1]!)
    }
    // "/" bind comes before the tmpfs; every allow-bind after it
    expect(bindPairs[0]).toBe('/')
    const reposIdx = args.indexOf(join(HOME, 'repos'))
    expect(reposIdx).toBeGreaterThan(tmpfsIdx)
    for (const a of [...input.taskWorktrees, input.runDir]) {
      expect(args.indexOf(a)).toBeGreaterThan(tmpfsIdx)
    }
    expect(args).toContain('--die-with-parent')
  })
})
