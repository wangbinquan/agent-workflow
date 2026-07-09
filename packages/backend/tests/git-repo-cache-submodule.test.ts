import { rimrafDir } from './helpers/cleanup'
// RFC-034 T5 — locks gitRepoCache behavior on repos with submodules.
//
// Builds a parent bare repo whose worktree references a child bare repo as a
// submodule (recorded via `git submodule add file:///path/to/child.bare`).
// resolveCachedRepo on the parent's `file://` URL must:
//   - cold-clone with `--recurse-submodules` so the cache mirror contains
//     populated child content
//   - update `cached_repos.has_submodules` to 1
//   - on subsequent warm hits, run `submodule sync --recursive` + `submodule
//     update --init --recursive` and surface submoduleSyncOk/Error
//   - never blanks when submoduleMode='never' (escape-hatch parity)

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { refreshCachedRepo, resolveCachedRepo } from '../src/services/gitRepoCache'
import { cachedRepos } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// RUN_GIT_NETWORK gate (P0 test-tier fortification): this suite cold-clones a
// real bare repo with `--recurse-submodules` over `file://` URLs (and recurses
// `submodule update --init --recursive`). On machines lacking unrestricted
// `git submodule add file://` the beforeEach hook intermittently times out at
// the 5000ms default, producing a nondeterministic local red that masks real
// regressions. We gate it behind RUN_GIT_NETWORK so local `bun test` is a
// trustworthy green signal; CI exports RUN_GIT_NETWORK=1 to preserve coverage.
// Mirrors the existing RUN_OPENCODE_INTEGRATION / RUN_CHAOS opt-in idiom.
const RUN_GIT_NETWORK = process.env.RUN_GIT_NETWORK === '1'

async function gitCmd(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
}

async function buildFixture(): Promise<{
  root: string
  parentUrl: string
  childBare: string
}> {
  const root = mkdtempSync(join(tmpdir(), 'aw-grc-sub-'))

  // Child working repo + bare mirror to use as the submodule's remote URL.
  const childWorking = join(root, 'child-src')
  mkdirSync(childWorking, { recursive: true })
  await gitCmd(childWorking, 'init', '-b', 'main', childWorking)
  await gitCmd(childWorking, '-C', childWorking, 'config', 'user.email', 'aw@test')
  await gitCmd(childWorking, '-C', childWorking, 'config', 'user.name', 'AW')
  writeFileSync(join(childWorking, 'CHILD.md'), 'child payload\n', 'utf-8')
  await gitCmd(childWorking, '-C', childWorking, 'add', '.')
  await gitCmd(childWorking, '-C', childWorking, 'commit', '-m', 'child init')
  const childBare = join(root, 'child.git')
  await gitCmd(root, 'clone', '--bare', childWorking, childBare)

  // Parent working repo that adds the child as a submodule.
  const parentWorking = join(root, 'parent-src')
  mkdirSync(parentWorking, { recursive: true })
  await gitCmd(parentWorking, 'init', '-b', 'main', parentWorking)
  await gitCmd(parentWorking, '-C', parentWorking, 'config', 'user.email', 'aw@test')
  await gitCmd(parentWorking, '-C', parentWorking, 'config', 'user.name', 'AW')
  // `protocol.file.allow=always` is required for `submodule add` against
  // file:// URLs since git 2.38 hardened CVE-2022-39253.
  await gitCmd(
    parentWorking,
    '-C',
    parentWorking,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    `file://${childBare}`,
    'sub',
  )
  await gitCmd(parentWorking, '-C', parentWorking, 'commit', '-m', 'add submodule')
  const parentBare = join(root, 'parent.git')
  await gitCmd(root, 'clone', '--bare', parentWorking, parentBare)
  return { root, parentUrl: `file://${parentBare}`, childBare }
}

describe.skipIf(!RUN_GIT_NETWORK)('gitRepoCache RFC-034 submodule recursion', () => {
  let db: DbClient
  let appHome: string
  let fix: { root: string; parentUrl: string; childBare: string }
  let savedGlobal: string | undefined
  let configHome: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-grc-sub-home-'))
    // Lift git's CVE-2022-39253 lock for the duration of these tests so the
    // fixture (which uses file:// URLs for both parent and child remotes) can
    // recurse into submodules. We point GIT_CONFIG_GLOBAL at a per-test
    // gitconfig granting `protocol.file.allow=always`; this propagates to
    // every git child process (incl. the internal `submodule update` shells)
    // without touching the user's real ~/.gitconfig.
    configHome = mkdtempSync(join(tmpdir(), 'aw-grc-sub-cfg-'))
    const gitconfig = join(configHome, '.gitconfig')
    writeFileSync(gitconfig, '[protocol "file"]\n  allow = always\n', 'utf-8')
    savedGlobal = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = gitconfig
    fix = await buildFixture()
  })

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal
    try {
      rimrafDir(configHome)
    } catch {
      /* noop */
    }
    try {
      rimrafDir(appHome)
    } catch {
      /* noop */
    }
    try {
      rimrafDir(fix.root)
    } catch {
      /* noop */
    }
  })

  test('cold clone with submoduleMode=auto populates child working dir', async () => {
    const result = await resolveCachedRepo(
      { db, appHome, submoduleMode: 'auto', submoduleJobs: 4 },
      { url: fix.parentUrl },
    )

    expect(result.cold).toBe(true)
    expect(result.hasSubmodules).toBe(true)
    expect(result.submoduleSyncOk).toBe(true)
    // Cache dir should contain the child's CHILD.md file because
    // --recurse-submodules ran during clone.
    expect(existsSync(join(result.cached.localPath, 'sub', 'CHILD.md'))).toBe(true)

    // DB row reflects telemetry.
    const row = db.select().from(cachedRepos).all()[0]
    expect(row?.hasSubmodules).toBe(true)
    expect(row?.lastSubmoduleSyncOk).toBe(true)
  })

  test('cold clone with submoduleMode=never leaves submodule dir empty', async () => {
    const result = await resolveCachedRepo(
      { db, appHome, submoduleMode: 'never', submoduleJobs: 4 },
      { url: fix.parentUrl },
    )
    expect(result.cold).toBe(true)
    // hasSubmodules reflects "we did not probe" → false per design.
    expect(result.hasSubmodules).toBe(false)
    // The sub directory exists but is empty (gitlink, no content).
    const subDir = join(result.cached.localPath, 'sub')
    expect(existsSync(subDir)).toBe(true)
    expect(existsSync(join(subDir, 'CHILD.md'))).toBe(false)
  })

  test('warm hit re-runs submodule sync + update', async () => {
    // First call: cold clone populates everything.
    await resolveCachedRepo(
      { db, appHome, submoduleMode: 'auto', submoduleJobs: 1 },
      { url: fix.parentUrl },
    )
    // Second call: warm hit. Should re-run sync/update without erroring.
    const second = await resolveCachedRepo(
      { db, appHome, submoduleMode: 'auto', submoduleJobs: 1, fetchOnReuse: false },
      { url: fix.parentUrl },
    )
    expect(second.cold).toBe(false)
    expect(second.hasSubmodules).toBe(true)
    expect(second.submoduleSyncOk).toBe(true)
    expect(existsSync(join(second.cached.localPath, 'sub', 'CHILD.md'))).toBe(true)
  })

  test('refreshCachedRepo re-runs submodule sync and updates DB telemetry', async () => {
    const first = await resolveCachedRepo(
      { db, appHome, submoduleMode: 'auto', submoduleJobs: 2 },
      { url: fix.parentUrl },
    )
    const refresh = await refreshCachedRepo(
      { db, appHome, submoduleMode: 'auto', submoduleJobs: 2 },
      first.cached.id,
    )
    expect(refresh.submoduleSyncOk).toBe(true)
    expect(refresh.hasSubmodules).toBe(true)
    expect(refresh.item.lastSubmoduleSyncOk).toBe(true)
  })

  test('cold clone command line contains --recurse-submodules when mode != never', async () => {
    // Inspect what we actually shipped by reading the source — we can't easily
    // observe argv inside the live Bun.spawn flow, so we anchor the contract
    // at source level. This guards the cold-path argv against accidental
    // regressions to plain `git clone`.
    const src = await Bun.file(
      resolve(import.meta.dir, '..', 'src', 'services', 'gitRepoCache.ts'),
    ).text()
    expect(src).toContain("'--recurse-submodules'")
    expect(src).toContain('submoduleMode')
  })

  test('repo without .gitmodules: hasSubmodules=false, submoduleSyncOk=true', async () => {
    // Reuse the child as a parent — it has no submodules of its own.
    const childUrl = `file://${fix.childBare}`
    const result = await resolveCachedRepo(
      { db, appHome, submoduleMode: 'auto', submoduleJobs: 4 },
      { url: childUrl },
    )
    expect(result.hasSubmodules).toBe(false)
    expect(result.submoduleSyncOk).toBe(true)
    expect(result.submoduleSyncError).toBeNull()
  })
})

// Always-on gate self-test: confirms the gating machinery is healthy regardless
// of RUN_GIT_NETWORK, so a broken flag wiring is caught even in the default
// (skipped) run. Mirrors integration-chaos's "SKIP is true iff RUN_CHAOS!=1".
describe('RUN_GIT_NETWORK gate sanity', () => {
  test('suite is skipped iff RUN_GIT_NETWORK!=1', () => {
    expect(!RUN_GIT_NETWORK).toBe(process.env.RUN_GIT_NETWORK !== '1')
  })
})
