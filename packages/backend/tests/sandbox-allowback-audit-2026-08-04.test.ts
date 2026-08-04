// Locks the 2026-08-04 sandbox/containment audit fixes (docs/audit-backlog.md
// §「沙箱 / containment 功能性审计」). Each test names the exact production
// failure it prevents, so a future refactor that turns one red can tell whether
// it broke a boundary or merely moved one.
//
// Covered here (policy layer only — the ctx/derivation fixes live in
// sandbox-allowback-derivation.test.ts):
//   1. `<appHome>/repos` is created lazily by the FIRST clone, so a repo-less
//      deployment used to emit `--bind <missing>` and bwrap aborted EVERY
//      sandboxed spawn — blamed on the runtime binary (three independent
//      finders).
//   2. A `readOnlyWorktrees` run collapses allowSubtrees to the run dir, which
//      dropped every worktree ancestor from `allowMetadataFiles`; macOS
//      `/bin/sh`'s `cd` and git's upward repo probe stat each path prefix and
//      then failed with an unactionable "Not a directory".
//   3. The bwrap renderer used to take a SECOND, un-realpath'd appHome and
//      emit its own mirror bind — a duplicate mount plus a string compare that
//      silently missed under a symlinked appHome, re-binding the mirror
//      read-WRITE under a policy that had moved it to read-only.

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
} from '../src/services/sandbox/policy'

const HOME = '/h/.agent-workflow'
const MIRROR = join(HOME, 'repos')
const WT = join(HOME, 'worktrees', 'r1', 't1')
const RUN_DIR = join(HOME, 'runs', 't1', 'n1')
const base = { appHome: HOME, taskWorktrees: [WT], runDir: RUN_DIR }

function bindPairs(args: readonly string[], flag: '--bind' | '--ro-bind'): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1] !== undefined) out.push(args[i + 1]!)
  }
  return out
}

describe('git mirror allow-back is gated on the directory existing', () => {
  test('present (default) ⇒ mirror is a read-write allow-back and one bwrap bind', () => {
    const policy = computeSandboxPolicy(base)
    expect(policy.allowSubtrees).toContain(MIRROR)
    // Exactly ONE bind: the renderer used to add its own on top of the
    // allowSubtrees loop, so the argv carried the same mount twice.
    expect(bindPairs(renderBwrapArgs(policy), '--bind').filter((p) => p === MIRROR)).toEqual([
      MIRROR,
    ])
  })

  test('absent ⇒ no mirror allow-back and NO bwrap bind (a missing SOURCE aborts the spawn)', () => {
    const policy = computeSandboxPolicy({ ...base, gitMirrorPresent: false })
    expect(policy.allowSubtrees).not.toContain(MIRROR)
    expect(renderBwrapArgs(policy).join(' ')).not.toContain(MIRROR)
    // Seatbelt is a deny-list, so an absent mirror simply has no allow rule;
    // nothing else about the profile may change.
    expect(renderSeatbeltProfile(policy)).not.toContain(`(subpath "${MIRROR}")`)
    // The worktree and run dir are untouched by the mirror decision.
    expect(policy.allowSubtrees).toEqual([WT, RUN_DIR])
  })

  test('absent + readOnlyWorktrees ⇒ mirror is not read-only-allowed either', () => {
    const policy = computeSandboxPolicy({
      ...base,
      readOnlyWorktrees: true,
      gitMirrorPresent: false,
    })
    expect(policy.readOnlyAllowSubtrees).toEqual([WT])
    expect(renderBwrapArgs(policy).join(' ')).not.toContain(MIRROR)
  })
})

describe('allowMetadataFiles covers read-only allow-backs, not just read-write ones', () => {
  // Production failure: a `readonly: true` script node (RFC-253) runs against
  // the canonical worktree with allowSubtrees = [runDir]. Deriving the ancestor
  // metadata allows from allowSubtrees alone left `<appHome>/worktrees` and
  // `<appHome>/worktrees/r1` unreadable, and every tool that stats each path
  // prefix (POSIX `sh`'s `cd`, git's upward probe) died on the prefix.
  test('readOnlyWorktrees run keeps the worktree ancestor chain stat-able', () => {
    const policy = computeSandboxPolicy({ ...base, readOnlyWorktrees: true })
    expect(policy.allowSubtrees).toEqual([RUN_DIR])
    expect(policy.readOnlyAllowSubtrees).toContain(WT)
    for (const ancestor of [HOME, join(HOME, 'worktrees'), join(HOME, 'worktrees', 'r1')]) {
      expect(policy.allowMetadataFiles).toContain(ancestor)
    }
    const profile = renderSeatbeltProfile(policy)
    expect(profile).toContain(`(allow file-read-metadata (literal "${join(HOME, 'worktrees')}"))`)
  })

  test('plugin read-only allow-back also gets its ancestors (RFC-251 shape)', () => {
    const pluginRoot = join(HOME, 'plugins', 'plg_1')
    const policy = computeSandboxPolicy({ ...base, readOnlyAllowSubtrees: [pluginRoot] })
    expect(policy.allowMetadataFiles).toContain(join(HOME, 'plugins'))
  })
})

describe('the bwrap renderer reads the appHome off the policy', () => {
  // The renderer used to receive a second copy from the caller. `wrapSandbox`
  // realpaths every policy root but passed the RAW ctx.appHome, so a symlinked
  // appHome masked one path while the allow-backs bound another.
  test('tmpfs target is the policy appHome, and the policy carries it', () => {
    const policy = computeSandboxPolicy(base)
    expect(policy.appHome).toBe(HOME)
    const args = renderBwrapArgs(policy)
    expect(args[args.indexOf('--tmpfs') + 1]).toBe(HOME)
  })

  test('readOnlyWorktrees emits the mirror only as --ro-bind, never --bind', () => {
    const args = renderBwrapArgs(computeSandboxPolicy({ ...base, readOnlyWorktrees: true }))
    expect(bindPairs(args, '--bind')).not.toContain(MIRROR)
    expect(bindPairs(args, '--ro-bind')).toContain(MIRROR)
  })
})
