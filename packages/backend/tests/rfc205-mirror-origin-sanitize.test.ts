// RFC-205 impl-gate P0-6 (Codex 2026-07-22) — the warm reuse path normalises the
// mirror origin to the credential-free redacted URL via `git remote set-url`.
// runGit does NOT reject on a nonzero git exit, so a FAILED set-url (read-only /
// locked / corrupt .git/config) was silently swallowed by `.catch(()=>null)` and
// the fetch then ran off an origin STILL holding a plaintext token. The reuse
// must fail closed (repo-origin-not-sanitized) instead of fetching credentialed.
//
// MUTATION CHECK: delete the post-set-url origin verification in gitRepoCache.ts
// → the read-only-config test stops throwing and reds.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'
import { resolveCachedRepo } from '../src/services/gitRepoCache'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let tmp: string
let appHome: string

async function seedRepo(name: string): Promise<string> {
  const repo = join(tmp, name)
  await runGit(tmp, ['init', '-q', '-b', 'main', name])
  await runGit(repo, [
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@t',
    'commit',
    '--allow-empty',
    '-q',
    '-m',
    'init',
  ])
  return repo
}

describe('RFC-205 P0-6 — warm reuse fails closed when the origin cannot be sanitized', () => {
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    tmp = mkdtempSync(join(tmpdir(), 'aw-RFC205-Origin-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-RFC205-OriginHome-'))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  // RFC-254: skipped on Windows — this forces "config unwritable" by chmod'ing
  // .git to 0o555 (POSIX: a read-only directory blocks git's lock-file create, so
  // set-url can't rewrite config). On Windows a directory's read-only attribute
  // does NOT block writes to files inside it, so the premise can't be established:
  // set-url succeeds and the scrub does not fail-closed. The fail-closed logic is
  // platform-agnostic and covered on the POSIX legs (forcing "unwritable" on
  // Windows would need an ACL deny-write, not a directory mode bit).
  test.skipIf(process.platform === 'win32')(
    'a read-only .git/config that blocks the credential scrub → repo-origin-not-sanitized',
    async () => {
      if (typeof process.getuid === 'function' && process.getuid() === 0) return // root ignores 0444
      const url = pathToFileURL(await seedRepo('src')).href
      const cold = await resolveCachedRepo(
        { store: composeSqliteRepositoryWorkspaceStore(db), appHome },
        { url },
      )
      const mirror = cold.cached.localPath
      // Simulate a pre-RFC-205 mirror whose origin STILL carries a credential, then
      // make .git/config read-only so the warm-path set-url scrub can't rewrite it.
      await runGit(mirror, ['remote', 'set-url', 'origin', 'https://user:tok@evil.example/r.git'])
      // git rewrites config via a lock file + rename, so the write is gated by the
      // DIRECTORY mode, not the file mode. Make .git read-only so set-url can't
      // create its lock → the scrub fails, exactly the corrupt/locked-config case.
      chmodSync(join(mirror, '.git'), 0o555)
      try {
        const err = await resolveCachedRepo(
          { store: composeSqliteRepositoryWorkspaceStore(db), appHome, fetchOnReuse: true },
          { url },
        ).catch((e: unknown) => e)
        expect((err as { code?: string }).code).toBe('repo-origin-not-sanitized')
      } finally {
        chmodSync(join(mirror, '.git'), 0o755)
      }
    },
  )

  test('a normal warm reuse (origin scrubbable) does NOT fail closed', async () => {
    const url = pathToFileURL(await seedRepo('ok')).href
    await resolveCachedRepo({ store: composeSqliteRepositoryWorkspaceStore(db), appHome }, { url })
    const warm = await resolveCachedRepo(
      { store: composeSqliteRepositoryWorkspaceStore(db), appHome, fetchOnReuse: true },
      { url },
    )
    expect(warm.cached.localPath.length).toBeGreaterThan(0)
  })
})
