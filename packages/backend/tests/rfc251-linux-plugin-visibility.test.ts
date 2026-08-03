// RFC-251 — WITNESS TEST for a KNOWN, UNFIXED defect (Codex impl-gate #4).
//
// ⚠️ These assertions encode CURRENT BROKEN BEHAVIOUR on purpose. They are not
// the desired contract. When the defect is fixed, this file MUST go red — that
// is the point — and the fixer should invert the expectations (or delete the
// file and lock the fixed behaviour instead).
//
// The defect: RFC-251 restored plugin support, but on Linux the sandbox denies
// the whole appHome with `--tmpfs` and binds back only what a run needs
// (RFC-205 impl-gate P0-3). `appHome/plugins/…` is not in that allow-back set,
// so with `sandboxMode=enforce` OpenCode gets `ENOENT` on every
// `file://<cachedPath>` — the feature is effectively undelivered on Linux.
//
// Why this can be proven from macOS: `computeSandboxPolicy` and
// `renderBwrapArgs` are pure ("Pure — no fs access", policy.ts), so the exact
// argv Linux would use is reproducible anywhere. No bwrap, no container.

import { describe, expect, test } from 'bun:test'
import { computeSandboxPolicy, renderBwrapArgs } from '@/services/sandbox/policy'

const APP_HOME = '/home/aw/.agent-workflow'
const RUN_DIR = `${APP_HOME}/runs/task-1/run-1`
const WORKTREE = '/home/aw/wt/task-1'
/** Where pluginInstaller actually materialises an npm/git plugin. */
const PLUGIN_CACHED_PATH = `${APP_HOME}/plugins/01PLUGIN/node_modules/dd`

interface Mount {
  kind: 'tmpfs' | 'bind' | 'ro-bind'
  path: string
}

function bwrapMounts(): Mount[] {
  const policy = computeSandboxPolicy({
    appHome: APP_HOME,
    taskWorktrees: [WORKTREE],
    runDir: RUN_DIR,
    readOnlySubtrees: [`${RUN_DIR}/opencode-identity-seal`],
  })
  const args = renderBwrapArgs(policy, { appHome: APP_HOME })
  const mounts: Mount[] = []
  for (let i = 0; i < args.length; i += 1) {
    // `--tmpfs DEST`, `--bind SRC DEST`, `--ro-bind SRC DEST`
    if (args[i] === '--tmpfs') mounts.push({ kind: 'tmpfs', path: args[i + 1]! })
    if (args[i] === '--bind') mounts.push({ kind: 'bind', path: args[i + 2]! })
    if (args[i] === '--ro-bind') mounts.push({ kind: 'ro-bind', path: args[i + 2]! })
  }
  return mounts
}

/**
 * bwrap applies mounts in argv order and the DEEPEST mount covering a path
 * decides what is visible there: a tmpfs at an ancestor hides everything below
 * it unless something is bound back at or under the path.
 */
function deepestMountFor(target: string, mounts: readonly Mount[]): Mount | null {
  let best: Mount | null = null
  for (const mount of mounts) {
    const prefix = mount.path.endsWith('/') ? mount.path : `${mount.path}/`
    if (target !== mount.path && !target.startsWith(prefix)) continue
    if (best === null || mount.path.length >= best.path.length) best = mount
  }
  return best
}

function isReadable(target: string, mounts: readonly Mount[]): boolean {
  const mount = deepestMountFor(target, mounts)
  return mount?.kind === 'bind' || mount?.kind === 'ro-bind'
}

describe('RFC-251 — plugins are unreachable under the Linux sandbox (KNOWN DEFECT)', () => {
  test('appHome is denied wholesale by a tmpfs', () => {
    const mounts = bwrapMounts()
    expect(deepestMountFor(APP_HOME, mounts)).toEqual({ kind: 'tmpfs', path: APP_HOME })
  })

  test('the allow-back set does not include the plugin cache', () => {
    const policy = computeSandboxPolicy({
      appHome: APP_HOME,
      taskWorktrees: [WORKTREE],
      runDir: RUN_DIR,
    })
    for (const allowed of policy.allowSubtrees) {
      expect(PLUGIN_CACHED_PATH.startsWith(allowed)).toBe(false)
    }
  })

  test('⚠️ KNOWN DEFECT: the plugin cachedPath is NOT readable in the namespace', () => {
    const mounts = bwrapMounts()
    // Control: the two things a run legitimately needs ARE bound back, which
    // proves the helper models bwrap correctly rather than reporting
    // "everything is hidden".
    expect(isReadable(`${APP_HOME}/repos`, mounts)).toBe(true)
    expect(isReadable(RUN_DIR, mounts)).toBe(true)

    // The defect. `file://<cachedPath>` therefore resolves to ENOENT inside the
    // OpenCode server whenever containment is enforced on Linux.
    expect(isReadable(PLUGIN_CACHED_PATH, mounts)).toBe(false)
  })
})
