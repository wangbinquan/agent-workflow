// LOCKS: RFC-204 impl-gate P0-2 (Codex 2026-07-22) — the cold-clone path seals
// the credentialed URL AT INSERT time when a SecretBox is wired in, so a fresh
// private-repo row never persists its token as plaintext in db.sqlite/WAL while
// waiting for the next `ensureCredentialsSealed` pass (daemon start / pre-backup).
//
// Mutation proof: revert gitRepoCache's cold INSERT to `url: input.url, urlEnc:
// null` and the first test goes red (row.url is the plaintext, urlEnc is null).
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { resolveCachedRepo } from '../src/services/gitRepoCache'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { unsealRepoUrl } from '../src/services/repoCredentials'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const box = createSecretBoxFromKey(Buffer.alloc(32, 7))

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

describe('RFC-204 impl-gate P0-2 — cold clone seals at insert', () => {
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    tmp = mkdtempSync(join(tmpdir(), 'aw-RFC204-seal-'))
    appHome = mkdtempSync(join(tmpdir(), 'aw-RFC204-sealHome-'))
  })

  test('with a SecretBox: row stores url_enc + blanked url, and it round-trips', async () => {
    const url = pathToFileURL(await seedRepo('sealme')).href
    const res = await resolveCachedRepo({ db, appHome, secretBox: box }, { url })
    const row = db.select().from(cachedRepos).where(eq(cachedRepos.id, res.cached.id)).get()
    expect(row).toBeDefined()
    if (row === undefined) return
    // No plaintext credentialed URL sits in the DB.
    expect(row.url).toBe('')
    expect(row.urlEnc).not.toBeNull()
    // The sealed form recovers the exact original URL for a reuse-by-id launch.
    expect(unsealRepoUrl(row, box)).toBe(url)
    // The redacted display form is still populated for the wire.
    expect(row.urlRedacted).not.toBeNull()
  })

  test('without a SecretBox: legacy plaintext stays (startup gate seals later)', async () => {
    const url = pathToFileURL(await seedRepo('plain')).href
    const res = await resolveCachedRepo({ db, appHome }, { url })
    const row = db.select().from(cachedRepos).where(eq(cachedRepos.id, res.cached.id)).get()
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(row.url).toBe(url)
    expect(row.urlEnc).toBeNull()
  })
})
