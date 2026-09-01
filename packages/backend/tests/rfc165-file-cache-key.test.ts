// LOCKS: RFC-165 T4 — file:// cache-key canonicalization v2 + verified lazy
// re-key (design §9.2 F19-r4, §11.14).
//
//   K1 the NEW file canonicalization preserves case and the `.git` suffix
//      (case-sensitive FS correctness); the legacy form folds both — which is
//      exactly why adopting a legacy-key hit requires verification.
//   K2 dual-read + lazy re-key: a pre-165 cache row (stored under the lossy
//      legacy hash) is found on the new-key miss, VERIFIED (its own url
//      re-canonicalizes to our key), re-keyed in place — same localPath, no
//      second clone.
//   K3 lossy collision is NOT adopted: a row whose legacy key matches but
//      whose url is a DIFFERENT repo under the new canonicalization stays
//      untouched; the request cold-clones its own mirror.
import { beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync } from 'node:fs'
import { removeTempDirSync } from './fixtures/tempDir'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import {
  gitUrlCacheKeyWith,
  gitUrlLegacyFileCacheKeyWith,
  parseGitUrl,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { composeSqliteRepositoryWorkspaceStore } from '../src/modules/source-control/composition'
import { cachedRepos } from '../src/db/schema'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { resolveCachedRepo } from '../src/services/gitRepoCache'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')
const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 19))

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

// RFC-254: file:// clone is slow on Windows; default 5s timeout kills the in-flight clone.
setDefaultTimeout(60_000)

describe('RFC-165 T4 — file cache key v2 + verified lazy re-key', () => {
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    // The fixture prefix MUST contain an uppercase letter: when the repo path
    // happens to be all-lowercase (a ~4% all-[a-z0-9] mkdtemp suffix draw on
    // /tmp), the NEW canonicalization equals the LEGACY one for a `.git`-less
    // name, the two hashes collapse, and K2's distinct-hash premise / K3's
    // downgraded-row setup silently break (2026-07-11 CI: K2 then K3 red on
    // ubuntu, unreproducible locally). Uppercase in the path pins new ≠ legacy.
    tmp = mkdtempSync(join(tmpdir(), 'aw-RFC165-Key-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-RFC165-KeyHome-'))
  })

  test('K1 new canonicalization preserves case + .git; legacy folds both', () => {
    const a = parseGitUrl('file:///tmp/Foo')!
    const b = parseGitUrl('file:///tmp/foo')!
    const c = parseGitUrl('file:///tmp/foo.git')!
    expect(gitUrlCacheKeyWith(a, sha1).hash).not.toBe(gitUrlCacheKeyWith(b, sha1).hash)
    expect(gitUrlCacheKeyWith(b, sha1).hash).not.toBe(gitUrlCacheKeyWith(c, sha1).hash)
    // …but all three collapse to ONE lossy legacy key — the collision that
    // makes verification mandatory before re-keying.
    const la = gitUrlLegacyFileCacheKeyWith(a, sha1)!.hash
    expect(gitUrlLegacyFileCacheKeyWith(b, sha1)!.hash).toBe(la)
    expect(gitUrlLegacyFileCacheKeyWith(c, sha1)!.hash).toBe(la)
    // Non-file URLs have no legacy form.
    expect(gitUrlLegacyFileCacheKeyWith(parseGitUrl('https://x/a.git')!, sha1)).toBe(null)
  })

  test('K2 pre-165 row is verified + re-keyed in place — no second clone', async () => {
    const repo = await seedRepo('repo-a')
    const url = pathToFileURL(repo).href
    // First resolve creates the row under the NEW hash; downgrade it to the
    // legacy hash to simulate a pre-165 cache.
    const first = await resolveCachedRepo(
      { store: composeSqliteRepositoryWorkspaceStore(db), appHome, secretBox },
      { url },
    )
    const parsed = parseGitUrl(url)!
    const newHash = gitUrlCacheKeyWith(parsed, sha1).hash
    const legacyHash = gitUrlLegacyFileCacheKeyWith(parsed, sha1)!.hash
    expect(newHash).not.toBe(legacyHash) // realpath contains no case fold, but .git-less path still differs? ensure distinct fixture
    await db
      .update(cachedRepos)
      .set({ urlHash: legacyHash })
      .where(eq(cachedRepos.urlHash, newHash))

    const mirrorsBefore = readdirSync(join(appHome, 'repos')).length
    const second = await resolveCachedRepo(
      { store: composeSqliteRepositoryWorkspaceStore(db), appHome, secretBox },
      { url },
    )
    // Same mirror adopted (no second clone), row re-keyed to the new hash.
    expect(second.cached.localPath).toBe(first.cached.localPath)
    expect(readdirSync(join(appHome, 'repos')).length).toBe(mirrorsBefore)
    const rows = await db.select().from(cachedRepos)
    expect(rows.length).toBe(1)
    expect(rows[0]!.urlHash).toBe(newHash)
    removeTempDirSync(tmp)
    removeTempDirSync(appHome)
  })

  test('K3 lossy collision is not adopted — the other repo stays, ours cold-clones', async () => {
    // Two REAL repos whose legacy keys collide: `x` and `x.git`.
    const plain = await seedRepo('x')
    const suffixed = await seedRepo('x.git')
    const urlPlain = pathToFileURL(plain).href
    const urlSuffixed = pathToFileURL(suffixed).href
    const parsedPlain = parseGitUrl(urlPlain)!
    const parsedSuffixed = parseGitUrl(urlSuffixed)!
    const legacyPlain = gitUrlLegacyFileCacheKeyWith(parsedPlain, sha1)!.hash
    expect(gitUrlLegacyFileCacheKeyWith(parsedSuffixed, sha1)!.hash).toBe(legacyPlain)

    // Cache the SUFFIXED repo, then downgrade its row to the shared legacy key.
    const firstSuffixed = await resolveCachedRepo(
      { store: composeSqliteRepositoryWorkspaceStore(db), appHome, secretBox },
      { url: urlSuffixed },
    )
    const newSuffixedHash = gitUrlCacheKeyWith(parsedSuffixed, sha1).hash
    await db
      .update(cachedRepos)
      .set({ urlHash: legacyPlain })
      .where(eq(cachedRepos.urlHash, newSuffixedHash))

    // Resolving the PLAIN repo finds the legacy row, VERIFIES, rejects it
    // (different repo!) and cold-clones its own mirror.
    const plainResolved = await resolveCachedRepo(
      { store: composeSqliteRepositoryWorkspaceStore(db), appHome, secretBox },
      { url: urlPlain },
    )
    expect(plainResolved.cold).toBe(true)
    expect(plainResolved.cached.localPath).not.toBe(firstSuffixed.cached.localPath)
    const rows = await db.select().from(cachedRepos)
    expect(rows.length).toBe(2)
    // The suffixed row was NOT re-keyed onto the plain repo's new hash.
    const hashes = rows.map((r) => r.urlHash).sort()
    expect(hashes).toContain(legacyPlain)
    expect(hashes).toContain(gitUrlCacheKeyWith(parsedPlain, sha1).hash)
    removeTempDirSync(tmp)
    removeTempDirSync(appHome)
  })
})
