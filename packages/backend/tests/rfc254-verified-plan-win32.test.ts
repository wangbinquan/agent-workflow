// RFC-254 T31 — the verified OpenCode BUSINESS plan build (the Code→Audit→Fix
// mainline) was ENTIRELY broken on Windows, and neither the acceptance VM nor
// the suite caught it. THREE independent production defects, all in the sensitive
// RFC-224/227/251 verified core, each surfaced only by going one layer deeper:
//
//   bug #1 — resolveNetlessGitCommonDirs (netlessProjection.ts), called
//     UNCONDITIONALLY by verifiedPlan.ts (`resolveGitCommonDirs`, "a verified
//     OpenCode business plan always runs in a real repository"), rejected
//     git-for-Windows's forward-slash `--git-common-dir` output (`C:/repo/.git`)
//     because isLexicallyCanonical uses the real-OS `path` codec (backslash on
//     win32). Every plan build aborted `execution-identity-source-changed`.
//
//   bug #2 — snapshotManagedSkillTree (sealedInputs.ts) asserted the sealed
//     snapshot root carried POSIX mode 0o500, but win32 `chmod` is synthesized
//     from the read-only attribute (any read-only dir reports 0o444) and does
//     not actually seal a directory. Every managed-skill plan failed
//     `execution-identity-store-unsafe`.
//
//   bug #3 — assertRegisteredGitWorktree (netlessProjection.ts), reached only
//     when the common dir lives OUTSIDE the worktree — i.e. a LINKED worktree,
//     which is EXACTLY what every real task uses (`git worktree add` per task).
//     `git worktree list --porcelain` also reports forward-slash on win32, so
//     the registered path failed the same canonicality check → `store-unsafe`.
//     The bug #1/#2 sub-function probes used a plain clone and never hit it; the
//     full-plan sweep below (a real linked worktree) is what caught it.
//
// WHY IT WAS INVISIBLE: the acceptance VM's working copy (C:\aw) is a non-git
// overlay, so no acceptance run ever built a plan in a real repo; AND the
// rfc224-verified-plan suite FORCES process.platform='darwin' for deterministic
// POSIX simulation, which gives the real-win32 production path ZERO coverage.
// All three were confirmed AND fixed against real git + real fs on a Windows 11
// ARM64 VM by calling the exact production functions with the real (non-forced)
// platform (STATE 续二十二/续二十三).
//
// Two layers of protection, mirroring rfc254-git-windows.test.ts:
//   1. source anchors that run on every (POSIX) CI leg — a revert of any fix
//      goes red immediately, before any Windows runner exists;
//   2. win32-gated runtime tests that exercise the fixed functions AND the whole
//      buildVerifiedOpencodeBusinessPlan against real git + real fs, so the
//      behavior is asserted on the VM today and on the Windows CI leg
//      (windows-platform.yml) — the forced-darwin suite never will.

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent } from '@agent-workflow/shared'
import { ContainmentCoordinator } from '@/services/sandbox'
import { createLogger } from '@/util/log'
import type { BusinessNodeSpawnContext } from '@/services/runtime/types'
import {
  buildVerifiedOpencodeBusinessPlan,
  type VerifiedBusinessPlanDependencies,
} from '@/services/runtime/opencode/verifiedPlan'
import { resolveNetlessGitCommonDirs } from '@/services/runtime/netlessProjection'
import { snapshotManagedSkillTree } from '@/services/runtime/opencode/sealedInputs'

const src = (path: string): string =>
  readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8')

const TEST_BINARY_DIGEST = 'f'.repeat(64)

// The four binary/toolchain seams buildVerifiedOpencodeBusinessPlan depends on,
// mirrored from rfc224-verified-plan.test.ts so this probe freezes a tiny file
// instead of copying the host's Bun binary.
const PLAN_DEPENDENCIES: VerifiedBusinessPlanDependencies = {
  inspectBinary: async () => ({ resolvedPath: '/runtime/opencode', digest: TEST_BINARY_DIGEST }),
  snapshotBinary: async ({ snapshotPath }) => {
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await writeFile(snapshotPath, 'official test seam', { flag: 'wx', mode: 0o500 })
    await chmod(snapshotPath, 0o500)
    return { resolvedPath: '/runtime/opencode', snapshotPath, digest: TEST_BINARY_DIGEST }
  },
  resolveToolchainBinary: (token) => (token === 'bun' ? '/runtime/bun' : null),
  snapshotToolchainBinary: async ({ snapshotPath }) => {
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 })
    await writeFile(snapshotPath, 'bun test seam', { flag: 'wx', mode: 0o500 })
    await chmod(snapshotPath, 0o500)
    return { resolvedPath: '/runtime/bun', snapshotPath, digest: 'e'.repeat(64) }
  },
}

function probeAgent(): Agent {
  return {
    id: 'agent-worker',
    name: 'worker',
    description: 'verified worker',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: { bash: 'deny' },
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'frozen persona',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('RFC-254 T31 — verified business plan build on Windows (source anchors)', () => {
  test('bug#1: git --git-common-dir output is re-joined onto the host separator', () => {
    // Git for Windows reports forward-slash paths even under
    // `--path-format=absolute`; the reported common dir MUST be re-joined onto
    // the host `sep` before isLexicallyCanonical (which uses the real-OS codec)
    // sees it, or the whole plan build aborts on win32. A plain `.trim()` here
    // is the exact regression.
    const text = src('services/runtime/netlessProjection.ts')
    expect(text).toContain("common.stdout.trim().split('/').join(sep)")
    // bug#3 (same root cause, linked-worktree path only): `git worktree list
    // --porcelain` ALSO reports forward-slash on win32, so the registered path
    // must be re-joined too or a real (linked-worktree) task aborts store-unsafe.
    expect(text).toContain("record.slice('worktree '.length).split('/').join(sep)")
  })

  test('bug#2: the sealed-tree mode assertion is gated by stat authority + DACL seal', () => {
    const text = src('services/runtime/opencode/sealedInputs.ts')
    // The exact-0o500 root-mode check only holds where stat mode is
    // authoritative (POSIX). On win32 the mode is synthesized, so the seal is
    // proven by the owner+TCB DACL instead — both halves must be present.
    expect(text).toContain(
      'statMetadataIsAuthoritative(process.platform) && (root.mode & 0o777) !== 0o500',
    )
    expect(text).toContain('sealDirectoryOwnerOnly(snapshotPath)')
  })

  test('bug#4: RFC-256 machine-config count uses realHome, not sourceEnv.HOME', () => {
    // Native Windows does not populate HOME (only USERPROFILE), so reading
    // `sourceEnv.HOME` here re-introduced the RFC-254 T11b bug: the whole plan
    // build aborts store-unsafe on a stock Windows install. Must use `realHome`
    // (= platformHomeEnvForHost, USERPROFILE on win32), identical on POSIX.
    const text = src('services/runtime/opencode/verifiedPlan.ts')
    expect(text).toContain('machineConfigDeclaredPluginCount(join(realHome')
    expect(text).not.toContain('safeAbsoluteHome(sourceEnv.HOME)')
  })
})

// Real behavior on real win32 — the coverage the forced-darwin suite structurally
// cannot provide. Skipped on POSIX (registered in test-suite-policy).
describe.skipIf(process.platform !== 'win32')(
  'RFC-254 T31 — verified business plan build on real win32 (runtime)',
  () => {
    // `realpathSync.native` (NOT plain `realpathSync`) because the GitHub
    // windows-latest runner's `os.tmpdir()` is an 8.3 SHORT name
    // (`C:\Users\RUNNER~1\...`), and plain `realpathSync` does NOT expand 8.3 on
    // Windows — it returns the short form, resolve-stable. Git then reports the
    // LONG form from `--git-common-dir`, and the short↔long mismatch trips the
    // canonicality/containment checks (measured on the VM). Production is immune
    // (worktree roots derive from `os.homedir()`, always long form); only this
    // test's temp base needs the native expansion to match what git returns.
    const longTemp = (prefix: string): string =>
      realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))

    test('bug#1: resolveNetlessGitCommonDirs accepts a real git repo on win32', async () => {
      const base = longTemp('rfc254-vp-git-')
      try {
        const repo = join(base, 'repo')
        mkdirSync(repo)
        execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' })
        const canonical = realpathSync(repo)
        // Before the fix this threw execution-identity-source-changed on win32.
        // A plain clone keeps `.git` inside the worktree, so no external common
        // dir is projected — the point is that it RESOLVES rather than aborts.
        const dirs = await resolveNetlessGitCommonDirs({
          repoWorktreePaths: [canonical],
          primaryWorktree: canonical,
          undescribableRepo: 'fail-closed',
        })
        expect(Array.isArray(dirs)).toBe(true)
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    })

    test('bug#2: snapshotManagedSkillTree seals + verifies a managed skill tree on win32', async () => {
      const base = longTemp('rfc254-vp-skill-')
      try {
        const source = join(base, 'skill')
        mkdirSync(join(source, 'sub'), { recursive: true })
        writeFileSync(join(source, 'SKILL.md'), '# test skill\nbody\n')
        writeFileSync(join(source, 'sub', 'aux.txt'), 'aux\n')
        // Before the fix this threw execution-identity-store-unsafe on win32
        // because the sealed root read back as mode 0o444, not 0o500.
        const snapshot = await snapshotManagedSkillTree({
          sourcePath: realpathSync(source),
          snapshotPath: join(base, 'snap'),
          expectedContentVersion: 0,
          readContentVersion: async () => 0,
        })
        expect(snapshot.entries.length).toBe(3)
        expect(snapshot.skillMarkdown).toContain('test skill')
      } finally {
        rmSync(base, { recursive: true, force: true })
      }
    })

    // bug#3+ sweep: the two fixes above prove the SUB-functions. This drives the
    // WHOLE buildVerifiedOpencodeBusinessPlan against real git + real fs with a
    // no-containment admission (Windows v1 has no provider — RFC-254 D1 — so
    // mode:'off' → a 'none' plan is the realistic production containment), which
    // is the only way to learn whether any OTHER step of the verified mainline
    // is broken on win32. The forced-darwin suite cannot reach this.
    test('the whole verified business plan builds on real win32 (no-containment)', async () => {
      const root = longTemp('rfc254-vp-full-')
      const originalAuth = process.env.OPENCODE_AUTH_CONTENT
      const originalHome = process.env.HOME
      try {
        // Simulate a STOCK Windows install, where native processes do not
        // populate HOME (only USERPROFILE). This deterministically exercises
        // bug#4 — the RFC-256 machine-config count once read `sourceEnv.HOME`
        // and aborted the whole plan store-unsafe when HOME was unset. On win32
        // `realHome` reads USERPROFILE, so deleting HOME is safe here (and the
        // CI runner's HOME, set by git-bash but not pwsh, no longer masks it).
        delete process.env.HOME
        const appHome = join(root, 'app')
        const scratchRepo = join(appHome, 'scratch', 'task-1')
        const worktreePath = join(appHome, 'iso', 'task-1', 'run-full')
        const runRoot = join(appHome, 'runs', 'task-1', 'run-full')
        mkdirSync(scratchRepo, { recursive: true })
        mkdirSync(dirname(worktreePath), { recursive: true })

        const git = (args: string[]): void => {
          execFileSync('git', args, { stdio: 'ignore' })
        }
        git(['init', '-q', '-b', 'main', scratchRepo])
        writeFileSync(join(scratchRepo, 'README.md'), 'fixture\n')
        git(['-C', scratchRepo, 'add', 'README.md'])
        git([
          '-C',
          scratchRepo,
          '-c',
          'user.email=a@b.c',
          '-c',
          'user.name=a',
          'commit',
          '-q',
          '-m',
          'fixture',
        ])
        git(['-C', scratchRepo, 'worktree', 'add', '-q', '--detach', worktreePath, 'HEAD'])

        // Windows has no bwrap/seatbelt; mode:'off' yields the platform-agnostic
        // 'none' admission that the real Windows daemon would carry today.
        const containment = await new ContainmentCoordinator({
          provider: {
            mode: 'off',
            status: { mechanism: 'none', available: false, detail: null },
            appHome,
          },
        }).admit('model-child-netless-v1')

        process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({
          openai: { type: 'api', key: 'test-only-key' },
        })

        const ctx: BusinessNodeSpawnContext = {
          agent: probeAgent(),
          prompt: 'do stable work',
          injectedMemoryBlock: null,
          dependents: [],
          mcps: [],
          plugins: [],
          resolvedParamsByAgent: new Map([
            [
              'worker',
              {
                model: 'openai/gpt-5.6',
                variant: null,
                temperature: null,
                steps: null,
                maxSteps: null,
              },
            ],
          ]),
          skills: [],
          worktreePath,
          repoWorktreePaths: [worktreePath],
          runRoot,
          configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
          wantsInventory: false,
          nodeRunId: 'run-full',
          log: createLogger('rfc254-vp-full-probe'),
          appHome,
          taskId: 'task-1',
          nodeId: 'node-1',
          opencodeControlNonce: 'c'.repeat(32),
          opencodeLeaseNonceDigest: 'c'.repeat(64),
          containment,
        }

        const plan = await buildVerifiedOpencodeBusinessPlan(ctx, ['opencode'], PLAN_DEPENDENCIES)
        // A clean OpenCode session plan is the whole point — anything else means
        // some later step of the mainline is still win32-broken (bug#3+).
        expect(plan.control?.kind).toBe('opencode-session')
      } finally {
        if (originalAuth === undefined) delete process.env.OPENCODE_AUTH_CONTENT
        else process.env.OPENCODE_AUTH_CONTENT = originalAuth
        if (originalHome === undefined) delete process.env.HOME
        else process.env.HOME = originalHome
        rmSync(root, { recursive: true, force: true })
      }
    })
  },
)
