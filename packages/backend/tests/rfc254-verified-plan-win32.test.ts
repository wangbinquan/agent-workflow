// RFC-254 T31 — the verified OpenCode BUSINESS plan build (the Code→Audit→Fix
// mainline) was ENTIRELY broken on Windows, and neither the acceptance VM nor
// the suite caught it. Two independent production defects, both in the sensitive
// RFC-224/227/251 verified core:
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
// WHY IT WAS INVISIBLE: the acceptance VM's working copy (C:\aw) is a non-git
// overlay, so no acceptance run ever built a plan in a real repo; AND the
// rfc224-verified-plan suite FORCES process.platform='darwin' for deterministic
// POSIX simulation, which gives the real-win32 production path ZERO coverage.
// Both defects were confirmed AND fixed against real git + real fs on a
// Windows 11 ARM64 VM by calling the exact production functions with the real
// (non-forced) platform (STATE 续二十二).
//
// Two layers of protection, mirroring rfc254-git-windows.test.ts:
//   1. source anchors that run on every (POSIX) CI leg — a revert of either fix
//      goes red immediately, before any Windows runner exists;
//   2. a win32-gated runtime test that exercises both fixed functions against
//      real git + real fs, so the behavior is asserted on the VM today and on
//      the Windows CI leg once it lands (the forced-darwin suite never will).

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveNetlessGitCommonDirs } from '@/services/runtime/netlessProjection'
import { snapshotManagedSkillTree } from '@/services/runtime/opencode/sealedInputs'

const src = (path: string): string =>
  readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8')

describe('RFC-254 T31 — verified business plan build on Windows (source anchors)', () => {
  test('bug#1: git --git-common-dir output is re-joined onto the host separator', () => {
    // Git for Windows reports forward-slash paths even under
    // `--path-format=absolute`; the reported common dir MUST be re-joined onto
    // the host `sep` before isLexicallyCanonical (which uses the real-OS codec)
    // sees it, or the whole plan build aborts on win32. A plain `.trim()` here
    // is the exact regression.
    const text = src('services/runtime/netlessProjection.ts')
    expect(text).toContain("common.stdout.trim().split('/').join(sep)")
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
})

// Real behavior on real win32 — the coverage the forced-darwin suite structurally
// cannot provide. Skipped on POSIX (registered in test-suite-policy).
describe.skipIf(process.platform !== 'win32')(
  'RFC-254 T31 — verified business plan build on real win32 (runtime)',
  () => {
    test('bug#1: resolveNetlessGitCommonDirs accepts a real git repo on win32', async () => {
      const base = mkdtempSync(join(tmpdir(), 'rfc254-vp-git-'))
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
      const base = mkdtempSync(join(tmpdir(), 'rfc254-vp-skill-'))
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
  },
)
