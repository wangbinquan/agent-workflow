// RFC-024 T3 — locks the cold-clone / warm-hit / fetch-on-reuse /
// concurrent-same-URL behavior of services/gitRepoCache.ts. Uses a real
// local bare repo as the "remote" so the suite exercises git itself.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import {
  deleteCachedRepo,
  listCachedRepos,
  refreshCachedRepo,
  resolveCachedRepo,
} from '../src/services/gitRepoCache'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function spawnGitInit(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
}

async function buildFixtureRemote(): Promise<{ dir: string; url: string }> {
  // A working clone with a couple of commits, then `git clone --bare` it into
  // a sibling "remote" we can hand to resolveCachedRepo as `file://...`.
  const root = mkdtempSync(join(tmpdir(), 'aw-grc-fixture-'))
  const working = join(root, 'src')
  mkdirSync(working, { recursive: true })
  await spawnGitInit(working, 'init', '-b', 'main', working)
  // Identity is required for `git commit`.
  await spawnGitInit(working, '-C', working, 'config', 'user.email', 'aw-test@example.com')
  await spawnGitInit(working, '-C', working, 'config', 'user.name', 'AW Test')
  writeFileSync(join(working, 'README.md'), '# fixture\n', 'utf-8')
  await spawnGitInit(working, '-C', working, 'add', '.')
  await spawnGitInit(working, '-C', working, 'commit', '-m', 'init')
  const bare = join(root, 'remote.git')
  await spawnGitInit(root, 'clone', '--bare', working, bare)
  return { dir: root, url: `file://${bare}` }
}

describe('gitRepoCache (RFC-024 T3)', () => {
  let db: DbClient
  let appHome: string
  let remoteDir: string
  let remoteUrl: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-grc-home-'))
    const r = await buildFixtureRemote()
    remoteDir = r.dir
    remoteUrl = r.url
  })

  afterEach(() => {
    try {
      rmSync(appHome, { recursive: true, force: true })
    } catch {
      /* noop */
    }
    try {
      rmSync(remoteDir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  })

  test('cold clone creates cache row, dir, and detects default branch', async () => {
    const r = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(r.cold).toBe(true)
    expect(r.cached.defaultBranch).toBe('main')
    expect(existsSync(r.cached.localPath)).toBe(true)
    // The cache dir IS a git repo.
    const inside = await runGit(r.cached.localPath, ['rev-parse', '--git-dir'])
    expect(inside.exitCode).toBe(0)
    const rows = db.select().from(cachedRepos).all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.localPath).toBe(r.cached.localPath)
  })

  test('second call hits cache without re-cloning', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    const b = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(a.cold).toBe(true)
    expect(b.cold).toBe(false)
    expect(a.cached.id).toBe(b.cached.id)
    expect(a.cached.localPath).toBe(b.cached.localPath)
  })

  test('fetchOnReuse=true runs git fetch and bumps lastFetchedAt', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    const aTs = a.cached.lastFetchedAt
    // Force time forward so the second fetch's timestamp is strictly greater.
    let t = Date.parse(aTs)
    const b = await resolveCachedRepo(
      { db, appHome, fetchOnReuse: true, now: () => (t += 1000) },
      { url: remoteUrl },
    )
    expect(b.cold).toBe(false)
    expect(b.fetchOk).toBe(true)
    expect(Date.parse(b.cached.lastFetchedAt)).toBeGreaterThan(Date.parse(aTs))
  })

  test('concurrent same-URL cold launches result in a single cache row', async () => {
    const [a, b] = await Promise.all([
      resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl }),
      resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl }),
    ])
    // Exactly one of the two callers experienced the cold path; the other
    // observed a warm cache after the first finished.
    expect([a.cold, b.cold].filter(Boolean).length).toBe(1)
    expect(a.cached.id).toBe(b.cached.id)
    expect(db.select().from(cachedRepos).all().length).toBe(1)
  })

  test('invalid URL throws repo-url-invalid', async () => {
    let err: unknown
    try {
      await resolveCachedRepo({ db, appHome }, { url: '/not/a/url' })
    } catch (e) {
      err = e
    }
    // @ts-expect-error inspect at runtime
    expect(err?.code).toBe('repo-url-invalid')
  })

  test('clone of nonexistent remote fails with repo-clone-failed and leaves no row', async () => {
    let err: unknown
    try {
      await resolveCachedRepo(
        { db, appHome },
        { url: 'file:///tmp/aw-grc-definitely-not-a-repo-xyz.git' },
      )
    } catch (e) {
      err = e
    }
    // @ts-expect-error inspect at runtime
    expect(err?.code).toBe('repo-clone-failed')
    expect(db.select().from(cachedRepos).all().length).toBe(0)
  })

  test('cache row pointing at missing dir self-heals on next resolve', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    rmSync(a.cached.localPath, { recursive: true, force: true })
    const b = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(b.cold).toBe(true)
    expect(existsSync(b.cached.localPath)).toBe(true)
    expect(db.select().from(cachedRepos).all().length).toBe(1)
  })

  test('listCachedRepos sorts by lastFetchedAt desc and redacts URL', async () => {
    // Two remotes so we have two rows. The second uses a credential-bearing
    // URL (which we won't actually use, but it exercises redaction).
    const r2 = await buildFixtureRemote()
    try {
      await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
      // Force timestamps apart.
      let t = Date.now() + 10_000
      await resolveCachedRepo({ db, appHome, fetchOnReuse: false, now: () => t++ }, { url: r2.url })
      const items = await listCachedRepos(db)
      expect(items.length).toBe(2)
      expect(Date.parse(items[0]!.lastFetchedAt)).toBeGreaterThanOrEqual(
        Date.parse(items[1]!.lastFetchedAt),
      )
      // urlRedacted is always populated.
      for (const it of items) expect(it.urlRedacted.length).toBeGreaterThan(0)
    } finally {
      rmSync(r2.dir, { recursive: true, force: true })
    }
  })

  test('refreshCachedRepo runs fetch and updates timestamp', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    let t = Date.parse(a.cached.lastFetchedAt) + 5_000
    const r = await refreshCachedRepo({ db, appHome, now: () => t++ }, a.cached.id)
    expect(r.fetchOk).toBe(true)
    expect(Date.parse(r.item.lastFetchedAt)).toBeGreaterThan(Date.parse(a.cached.lastFetchedAt))
  })

  test('refreshCachedRepo on missing dir throws repo-cache-corrupt', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    rmSync(a.cached.localPath, { recursive: true, force: true })
    let err: unknown
    try {
      await refreshCachedRepo({ db, appHome }, a.cached.id)
    } catch (e) {
      err = e
    }
    // @ts-expect-error inspect at runtime
    expect(err?.code).toBe('repo-cache-corrupt')
  })

  test('deleteCachedRepo removes dir + row when no references', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(existsSync(a.cached.localPath)).toBe(true)
    const r = await deleteCachedRepo({ db, appHome }, a.cached.id)
    expect(r.deletedLocalPath).toBe(a.cached.localPath)
    expect(existsSync(a.cached.localPath)).toBe(false)
    expect(db.select().from(cachedRepos).all().length).toBe(0)
  })
})

// -----------------------------------------------------------------------------
// RFC-068 — fast-forward base branch to origin on warm path
// -----------------------------------------------------------------------------

async function advanceFixtureRemote(bareUrl: string): Promise<string> {
  // `bareUrl` is "file://<absPath>". Re-derive the bare path, clone it
  // temporarily, push a new commit, return the new HEAD sha for assertions.
  const barePath = bareUrl.replace(/^file:\/\//, '')
  const workRoot = mkdtempSync(join(tmpdir(), 'aw-grc-advance-'))
  try {
    const work = join(workRoot, 'work')
    await spawnGitInit(workRoot, 'clone', barePath, work)
    await spawnGitInit(work, '-C', work, 'config', 'user.email', 'aw-test@example.com')
    await spawnGitInit(work, '-C', work, 'config', 'user.name', 'AW Test')
    writeFileSync(join(work, 'NEW.md'), '# new\n', 'utf-8')
    await spawnGitInit(work, '-C', work, 'add', '.')
    await spawnGitInit(work, '-C', work, 'commit', '-m', 'second commit on main')
    await spawnGitInit(work, '-C', work, 'push', 'origin', 'main')
    const r = await runGit(work, ['rev-parse', 'HEAD'])
    return r.stdout.trim()
  } finally {
    try {
      rmSync(workRoot, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  }
}

describe('gitRepoCache RFC-068 fast-forward', () => {
  let db: DbClient
  let appHome: string
  let remoteDir: string
  let remoteUrl: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-grc-068-home-'))
    const r = await buildFixtureRemote()
    remoteDir = r.dir
    remoteUrl = r.url
  })

  afterEach(() => {
    try {
      rmSync(appHome, { recursive: true, force: true })
    } catch {
      /* noop */
    }
    try {
      rmSync(remoteDir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  })

  test('BC-01 cold clone RESOLVES requested branches too (RFC-165 F19-r3 closed the cold-FF gap)', async () => {
    // Pre-RFC-165 the cold path skipped syncBranches entirely — a non-default
    // branch that only exists as origin/<branch> in the fresh clone made the
    // first launch's `rev-parse <branch>` fail. Cold now runs the same FF
    // loop as warm (syncBranchToRemote CREATES the missing local ref).
    const r = await resolveCachedRepo({ db, appHome, syncBranches: ['main'] }, { url: remoteUrl })
    expect(r.cold).toBe(true)
    expect(r.ffOutcomes.length).toBe(1)
    expect(r.ffOutcomes[0]!.warning).toBe(null)
    const head = await runGit(r.cached.localPath, ['rev-parse', '--verify', 'refs/heads/main'])
    expect(head.exitCode).toBe(0)
  })

  test('BC-02 warm reuse + origin advanced → FF moves local branch and surfaces toSha', async () => {
    const first = await resolveCachedRepo(
      { db, appHome, syncBranches: ['main'] },
      { url: remoteUrl },
    )
    // Pre-advance: local main equals origin/main at clone time.
    const beforeLocal = (await runGit(first.cached.localPath, ['rev-parse', 'main'])).stdout.trim()
    const newSha = await advanceFixtureRemote(remoteUrl)
    expect(newSha).not.toBe(beforeLocal)

    const second = await resolveCachedRepo(
      { db, appHome, syncBranches: ['main'] },
      { url: remoteUrl },
    )
    expect(second.cold).toBe(false)
    expect(second.fetchOk).toBe(true)
    expect(second.ffOutcomes.length).toBe(1)
    const fo = second.ffOutcomes[0]!
    expect(fo.branch).toBe('main')
    expect(fo.advanced).toBe(true)
    expect(fo.fromSha).toBe(beforeLocal)
    expect(fo.toSha).toBe(newSha)
    expect(fo.warning).toBeNull()

    // Local main is now at newSha (subsequent rev-parse picks up the FF).
    const afterLocal = (await runGit(first.cached.localPath, ['rev-parse', 'main'])).stdout.trim()
    expect(afterLocal).toBe(newSha)
  })

  test('BC-02b same warm reuse but origin unchanged → ffOutcome.advanced=false', async () => {
    await resolveCachedRepo({ db, appHome, syncBranches: ['main'] }, { url: remoteUrl })
    const r = await resolveCachedRepo({ db, appHome, syncBranches: ['main'] }, { url: remoteUrl })
    expect(r.ffOutcomes.length).toBe(1)
    expect(r.ffOutcomes[0]!.advanced).toBe(false)
    expect(r.ffOutcomes[0]!.warning).toBeNull()
  })

  test('BC-04 tag base ref is skipped (no FF attempt)', async () => {
    const first = await resolveCachedRepo({ db, appHome }, { url: remoteUrl })
    await runGit(first.cached.localPath, ['tag', 'v1.0', 'main'])
    const r = await resolveCachedRepo({ db, appHome, syncBranches: ['v1.0'] }, { url: remoteUrl })
    expect(r.ffOutcomes).toEqual([])
  })

  test('BC-05 sha base ref is skipped (no FF attempt)', async () => {
    const first = await resolveCachedRepo({ db, appHome }, { url: remoteUrl })
    const sha = (await runGit(first.cached.localPath, ['rev-parse', 'main'])).stdout.trim()
    const r = await resolveCachedRepo({ db, appHome, syncBranches: [sha] }, { url: remoteUrl })
    expect(r.ffOutcomes).toEqual([])
  })

  test('BC-03 origin/<branch> base ref is skipped (already remote-tracking)', async () => {
    await resolveCachedRepo({ db, appHome }, { url: remoteUrl })
    const r = await resolveCachedRepo(
      { db, appHome, syncBranches: ['origin/main'] },
      { url: remoteUrl },
    )
    expect(r.ffOutcomes).toEqual([])
  })

  test('BC-07 yanked file:// source → HARD FAIL, never a stale-mirror launch (RFC-165 F19)', async () => {
    // Pre-RFC-165 a failed fetch was a warning and the task launched off the
    // stale mirror. For file:// that silently diverges from the retired
    // path-mode fidelity contract ("read the source's live state") — the
    // source dir being gone must fail the launch. Non-file schemes keep the
    // warning-and-stale behavior (network blips are expected there).
    await resolveCachedRepo({ db, appHome, syncBranches: ['main'] }, { url: remoteUrl })
    // Nuke the bare remote so subsequent fetch fails.
    rmSync(remoteDir, { recursive: true, force: true })
    await expect(
      resolveCachedRepo({ db, appHome, syncBranches: ['main'] }, { url: remoteUrl }),
    ).rejects.toThrow(/missing or unreadable/)
  })

  test('BC-10 requested branch missing in a file:// source → HARD FAIL (RFC-165 F19)', async () => {
    // Pre-RFC-165 this was warning=origin-ref-missing and the launch kept the
    // stale local branch. A file:// source's deleted branch must fail loudly.
    const first = await resolveCachedRepo(
      { db, appHome, syncBranches: ['main'] },
      { url: remoteUrl },
    )
    // Create a local-only branch (no origin/feature in the remote).
    await runGit(first.cached.localPath, ['branch', 'feature/local-only', 'main'])
    await expect(
      resolveCachedRepo({ db, appHome, syncBranches: ['feature/local-only'] }, { url: remoteUrl }),
    ).rejects.toThrow(/ref 'feature\/local-only' not found in/)
  })

  test('BC-06 branch name containing slash works', async () => {
    // Create a slash-named branch in the working clone, push, then exercise FF.
    const workRoot = mkdtempSync(join(tmpdir(), 'aw-grc-068-slash-'))
    try {
      const work = join(workRoot, 'work')
      const barePath = remoteUrl.replace(/^file:\/\//, '')
      await spawnGitInit(workRoot, 'clone', barePath, work)
      await spawnGitInit(work, '-C', work, 'config', 'user.email', 'aw-test@example.com')
      await spawnGitInit(work, '-C', work, 'config', 'user.name', 'AW Test')
      await spawnGitInit(work, '-C', work, 'checkout', '-b', 'feature/foo')
      writeFileSync(join(work, 'FOO.md'), '# foo\n', 'utf-8')
      await spawnGitInit(work, '-C', work, 'add', '.')
      await spawnGitInit(work, '-C', work, 'commit', '-m', 'foo')
      await spawnGitInit(work, '-C', work, 'push', 'origin', 'feature/foo')
    } finally {
      rmSync(workRoot, { recursive: true, force: true })
    }
    // First resolve clones the cache. classifyBaseRef on cold-clone won't see
    // the local branch yet — but warm path will. Run twice.
    await resolveCachedRepo({ db, appHome }, { url: remoteUrl })
    // Manually create the local branch in the cache so classifyBaseRef sees
    // it as 'branch' (otherwise it'd be 'unknown' and the FF still runs but
    // wouldn't actually advance an existing ref). We mimic what a real user
    // path would do: select 'feature/foo' (matches remote-tracking) → ref
    // dropdown picks the launcher-canonical name. Either way, FF works.
    const before = await resolveCachedRepo(
      { db, appHome, syncBranches: ['feature/foo'] },
      { url: remoteUrl },
    )
    expect(before.ffOutcomes.length).toBe(1)
    expect(before.ffOutcomes[0]!.branch).toBe('feature/foo')
    expect(before.ffOutcomes[0]!.warning).toBeNull()
    // Re-resolve: local feature/foo now exists, FF is now a happy no-op
    // (advanced=false) since origin didn't move further.
    const second = await resolveCachedRepo(
      { db, appHome, syncBranches: ['feature/foo'] },
      { url: remoteUrl },
    )
    expect(second.ffOutcomes[0]!.warning).toBeNull()
  })

  test('BC-09 deduplicates same branch listed twice in syncBranches', async () => {
    await resolveCachedRepo({ db, appHome }, { url: remoteUrl })
    const r = await resolveCachedRepo(
      { db, appHome, syncBranches: ['main', 'main'] },
      { url: remoteUrl },
    )
    expect(r.ffOutcomes.length).toBe(1)
  })

  test('BC-11 syncBranches undefined → empty ffOutcomes (RFC-024 callers unaffected)', async () => {
    await resolveCachedRepo({ db, appHome }, { url: remoteUrl })
    const r = await resolveCachedRepo({ db, appHome }, { url: remoteUrl })
    expect(r.ffOutcomes).toEqual([])
  })
})
