import { rimrafDir } from './helpers/cleanup'
// RFC-068 — path mode opt-in `git fetch` helper. Locks behavior we *must
// not* regress: never `pull` / `merge` / `checkout` / `reset` on a user-
// supplied local repo; never mutate the user's HEAD branch or working tree.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fetchPathRepoBeforeLaunch } from '../src/services/repo'
import { runGit } from '../src/util/git'

async function buildLocalRepoWithRemote(): Promise<{
  root: string
  repoPath: string
  bareRemote: string
  remoteHeadSha: string
}> {
  const root = mkdtempSync(join(tmpdir(), 'aw-068-path-'))
  // Build a "remote" bare repo from a temp working clone with one commit.
  const seed = join(root, 'seed')
  mkdirSync(seed, { recursive: true })
  await runGit(seed, ['init', '-q', '-b', 'main'])
  await runGit(seed, ['config', 'user.email', 'aw-test@example.com'])
  await runGit(seed, ['config', 'user.name', 'AW Test'])
  writeFileSync(join(seed, 'README.md'), '# seed\n')
  await runGit(seed, ['add', '.'])
  await runGit(seed, ['commit', '-q', '-m', 'first commit'])
  const bareRemote = join(root, 'remote.git')
  await runGit(root, ['clone', '--bare', seed, bareRemote])

  // The "user-supplied local repo" is a working clone of that remote.
  const repoPath = join(root, 'user-repo')
  await runGit(root, ['clone', bareRemote, repoPath])
  await runGit(repoPath, ['config', 'user.email', 'aw-test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'AW Test'])

  const head = await runGit(repoPath, ['rev-parse', 'HEAD'])
  return { root, repoPath, bareRemote, remoteHeadSha: head.stdout.trim() }
}

async function advanceRemote(bareRemote: string, root: string): Promise<string> {
  const tmpWork = join(root, 'advance-' + Date.now())
  await runGit(root, ['clone', bareRemote, tmpWork])
  await runGit(tmpWork, ['config', 'user.email', 'aw-test@example.com'])
  await runGit(tmpWork, ['config', 'user.name', 'AW Test'])
  writeFileSync(join(tmpWork, 'NEW.md'), '# new\n')
  await runGit(tmpWork, ['add', '.'])
  await runGit(tmpWork, ['commit', '-q', '-m', 'advance'])
  await runGit(tmpWork, ['push', 'origin', 'main'])
  const r = await runGit(tmpWork, ['rev-parse', 'HEAD'])
  rimrafDir(tmpWork)
  return r.stdout.trim()
}

describe('fetchPathRepoBeforeLaunch (RFC-068)', () => {
  let fx: Awaited<ReturnType<typeof buildLocalRepoWithRemote>>

  beforeEach(async () => {
    fx = await buildLocalRepoWithRemote()
  })

  afterEach(() => {
    try {
      rimrafDir(fx.root)
    } catch {
      /* noop */
    }
  })

  test('BP-01 success: refreshes origin/* refs without touching local main', async () => {
    // Capture user state before.
    const beforeLocalMain = (await runGit(fx.repoPath, ['rev-parse', 'main'])).stdout.trim()
    const beforeOriginMain = (await runGit(fx.repoPath, ['rev-parse', 'origin/main'])).stdout.trim()
    // Add an uncommitted user change so we can prove it survives the fetch.
    writeFileSync(join(fx.repoPath, 'UNCOMMITTED.md'), 'user wip\n')

    // Remote advances.
    const newSha = await advanceRemote(fx.bareRemote, fx.root)
    expect(newSha).not.toBe(beforeOriginMain)

    const r = await fetchPathRepoBeforeLaunch(fx.repoPath)
    expect(r.ok).toBe(true)
    expect(r.error).toBeNull()

    // origin/main MUST move; local main MUST NOT.
    const afterOrigin = (await runGit(fx.repoPath, ['rev-parse', 'origin/main'])).stdout.trim()
    const afterLocal = (await runGit(fx.repoPath, ['rev-parse', 'main'])).stdout.trim()
    expect(afterOrigin).toBe(newSha)
    expect(afterLocal).toBe(beforeLocalMain)

    // User's uncommitted file survives.
    expect(readFileSync(join(fx.repoPath, 'UNCOMMITTED.md'), 'utf-8')).toBe('user wip\n')
  })

  test('BP-02 failure: remote unreachable returns ok=false without throwing', async () => {
    // Yank the bare remote so fetch fails.
    rimrafDir(fx.bareRemote)

    const beforeLocal = (await runGit(fx.repoPath, ['rev-parse', 'main'])).stdout.trim()
    const r = await fetchPathRepoBeforeLaunch(fx.repoPath)
    expect(r.ok).toBe(false)
    expect(r.error).not.toBeNull()

    // User repo untouched.
    const afterLocal = (await runGit(fx.repoPath, ['rev-parse', 'main'])).stdout.trim()
    expect(afterLocal).toBe(beforeLocal)
  })

  test('BP-03 idempotency: re-running yields ok=true and does not advance local main', async () => {
    const before = (await runGit(fx.repoPath, ['rev-parse', 'main'])).stdout.trim()
    const a = await fetchPathRepoBeforeLaunch(fx.repoPath)
    const b = await fetchPathRepoBeforeLaunch(fx.repoPath)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    const after = (await runGit(fx.repoPath, ['rev-parse', 'main'])).stdout.trim()
    expect(after).toBe(before)
  })
})

// Source-level guard: the helper MUST NEVER invoke pull / merge / reset / checkout.
// If a future refactor adds any of those, this test fails fast.
describe('fetchPathRepoBeforeLaunch source-level invariants (RFC-068)', () => {
  test('BP-05..08 helper source contains no pull/merge/reset/checkout', () => {
    // Normalize CRLF->LF: on a Windows working tree checked out before the
    // repo's `eol=lf` .gitattributes landed, source files can still carry CRLF,
    // which would break the `\n}\n` helper-boundary regex below. The guard's
    // intent (no pull/merge/reset/checkout tokens) is line-ending-agnostic.
    const src = readFileSync(resolve(__dirname, '../src/services/repo.ts'), 'utf-8').replace(
      /\r\n/g,
      '\n',
    )
    const helperStart = src.indexOf('export async function fetchPathRepoBeforeLaunch')
    expect(helperStart).toBeGreaterThan(-1)
    // Capture the helper body (up to the next top-level export or EOF).
    const after = src.slice(helperStart)
    const helperEnd = after.search(/\n}\n/)
    expect(helperEnd).toBeGreaterThan(0)
    const body = after.slice(0, helperEnd + 2)
    // Forbidden tokens — runtime would mutate user work tree / branch.
    expect(body).not.toMatch(/['"]pull['"]/)
    expect(body).not.toMatch(/['"]merge['"]/)
    expect(body).not.toMatch(/['"]reset['"]/)
    expect(body).not.toMatch(/['"]checkout['"]/)
  })
})
