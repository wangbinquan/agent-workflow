// RFC-251 — the selected plugin cache must be READABLE (never writable) inside
// the sandbox on both platforms.
//
// Why this exists: RFC-251 restored plugin support, but the linux sandbox
// denies the WHOLE appHome with `--tmpfs` and binds back only what a run needs
// (RFC-205 impl-gate P0-3). `appHome/plugins/…` was not in that allow-back set,
// so with containment enforced OpenCode got ENOENT on every
// `file://<cachedPath>` — the feature was undelivered on linux. Confirmed on a
// real Debian container with bubblewrap 0.11.0 using the platform's own argv,
// then fixed by `readOnlyAllowSubtrees` (Codex impl-gate #4).
//
// These assertions are reproducible from any OS: computeSandboxPolicy and the
// two renderers are pure ("Pure — no fs access", policy.ts).

import { describe, expect, test } from 'bun:test'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
} from '@/services/sandbox/policy'

const APP_HOME = '/home/aw/.agent-workflow'
const RUN_DIR = `${APP_HOME}/runs/task-1/run-1`
const WORKTREE = '/home/aw/wt/task-1'
/** A selected plugin's private install root (pluginInstaller: plugins/<id>). */
const PLUGIN_ROOT = `${APP_HOME}/plugins/01PLUGIN`
const PLUGIN_ENTRY = `${PLUGIN_ROOT}/generations/01OP/node_modules/dd/index.js`

interface Mount {
  kind: 'tmpfs' | 'bind' | 'ro-bind'
  path: string
}

function policyFor(readOnlyAllowSubtrees?: readonly string[]) {
  return computeSandboxPolicy({
    appHome: APP_HOME,
    taskWorktrees: [WORKTREE],
    runDir: RUN_DIR,
    readOnlySubtrees: [`${RUN_DIR}/opencode-identity-seal`],
    ...(readOnlyAllowSubtrees === undefined ? {} : { readOnlyAllowSubtrees }),
  })
}

function mountsOf(readOnlyAllowSubtrees?: readonly string[]): Mount[] {
  const args = renderBwrapArgs(policyFor(readOnlyAllowSubtrees))
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

// RFC-254: both describes drive the POSIX sandbox-policy layer (computeSandboxPolicy
// → renderBwrapArgs / renderSeatbeltProfile) with POSIX fixture paths. Windows v1 has
// no sandbox provider (D1): computeSandboxPolicy is never reached in production, and
// validatePolicyPath's '/'-only canonicalization rejects the POSIX fixtures here
// (verified on ARM64: "invalid sandbox appHome path"). Same class as the skipIf'd
// rfc205-sandbox-policy render describes; the RFC-251 Linux fix itself is verified on
// real Debian (see file header).
describe.skipIf(process.platform === 'win32')(
  'RFC-251 — plugin cache visibility under the linux sandbox',
  () => {
    test('without the allow-back the plugin cache does not exist (the original defect)', () => {
      // Kept as the regression's rationale: this is exactly what shipped first,
      // and what a real Debian/bubblewrap run reproduced as ENOENT.
      const mounts = mountsOf()
      expect(deepestMountFor(PLUGIN_ENTRY, mounts)).toEqual({ kind: 'tmpfs', path: APP_HOME })
    })

    test('with the allow-back it is bound back READ-ONLY', () => {
      const mounts = mountsOf([PLUGIN_ROOT])
      expect(deepestMountFor(PLUGIN_ENTRY, mounts)).toEqual({ kind: 'ro-bind', path: PLUGIN_ROOT })
      // Control: the run's legitimate read-write areas are unaffected.
      expect(deepestMountFor(`${APP_HOME}/repos`, mounts)?.kind).toBe('bind')
      expect(deepestMountFor(RUN_DIR, mounts)?.kind).toBe('bind')
    })

    test('the ro-bind is emitted after the appHome tmpfs, never before', () => {
      const args = renderBwrapArgs(policyFor([PLUGIN_ROOT]))
      const tmpfsAt = args.indexOf('--tmpfs')
      const roAt = args.lastIndexOf(PLUGIN_ROOT)
      expect(tmpfsAt).toBeGreaterThanOrEqual(0)
      expect(roAt).toBeGreaterThan(tmpfsAt)
    })

    test('seatbelt restores read but never grants write', () => {
      const profile = renderSeatbeltProfile(policyFor([PLUGIN_ROOT]))
      expect(profile).toContain(`(allow file-read* (subpath "${PLUGIN_ROOT}"))`)
      expect(profile).not.toContain(`(allow file-read* file-write* (subpath "${PLUGIN_ROOT}"))`)
      // The enclosing appHome deny is still emitted before it.
      expect(profile.indexOf(`(deny file-read* file-write* (subpath "${APP_HOME}"))`)).toBeLessThan(
        profile.indexOf(`(allow file-read* (subpath "${PLUGIN_ROOT}"))`),
      )
    })
  },
)

describe.skipIf(process.platform === 'win32')(
  'RFC-251 — read-only allow-backs are validated, not trusted',
  () => {
    test('rejects a path that is not inside a denied subtree', () => {
      // Outside appHome it is already reachable via the base `--bind / /`; taking
      // it would be meaningless noise that looks like a granted permission.
      expect(() => policyFor(['/home/aw/elsewhere'])).toThrow(/nested below a denied subtree/)
    })

    test('rejects overlap with a read-write allow (linux would silently grant write)', () => {
      expect(() => policyFor([RUN_DIR])).toThrow(/must not overlap a read-write allow/)
      expect(() => policyFor([`${RUN_DIR}/nested`])).toThrow(/must not overlap a read-write allow/)
    })

    test('rejects duplicates', () => {
      expect(() => policyFor([PLUGIN_ROOT, PLUGIN_ROOT])).toThrow(/duplicate/)
    })
  },
)
