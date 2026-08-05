// RFC-213 AC-12 — cross-machine restore silently bricks sealed repo credentials.
//
// The backup correctly excludes secret.key, so `cached_repos` URLs sealed with
// the OLD machine's key can't be decrypted after restoring onto a machine with a
// different / absent secret.key. doctor's checkSealedCredentials surfaces this
// LOUDLY (fails doctor) instead of leaving the user to hit silent clone failures.
//
// MUTATION CHECK (manually verified): make checkSealedCredentials always return
// ok:true → the mismatched-key and missing-key cases red.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, unlinkSync } from 'node:fs'
import { removeTempDirSync } from './fixtures/tempDir'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSecretBox } from '../src/auth/secretBox'
import { openDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { checkSealedCredentials } from '../src/cli/doctor'
import { sealRepoUrl } from '../src/services/repoCredentials'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-cred-'))
  tmps.push(d)
  return d
}
const savedHome = process.env.AGENT_WORKFLOW_HOME
// RFC-254 T32: same teardown shape as rfc213-worktree-capture — each temp dir
// holds an open `db.sqlite`, and on Windows an open handle makes the delete
// fail outright (measured: all four of this file's tests reported EBUSY
// teardown failures with their assertions already green). `removeTempDirSync`
// retries then warns on win32 only; every dir is attempted and the first real
// error re-thrown AFTER the loop so a POSIX host that cannot delete its own
// temp dir still fails loudly.
afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = savedHome
  let first: unknown
  for (const d of tmps.splice(0)) {
    try {
      removeTempDirSync(d)
    } catch (error) {
      first ??= error
    }
  }
  if (first !== undefined) throw first
})

/** Seed a DB with one cached_repos row sealed by the key at appHome/secret.key. */
function seed(appHome: string): void {
  process.env.AGENT_WORKFLOW_HOME = appHome
  const keyPath = join(appHome, 'secret.key')
  const box = createSecretBox(keyPath)
  const db: DbClient = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
  db.insert(cachedRepos)
    .values({
      id: ulid(),
      urlHash: 'abcd1234',
      url: '',
      urlEnc: sealRepoUrl(box, 'https://user:token@github.com/a/b.git'),
      localPath: '/x',
      lastFetchedAt: 0,
      createdAt: 0,
    })
    .run()
  const s = (db as unknown as { $client: Database }).$client
  s.exec('PRAGMA wal_checkpoint(TRUNCATE);')
  s.close()
}

describe('RFC-213 AC-12 sealed-credential decryptability', () => {
  test('correct key → ok (all decryptable)', () => {
    const appHome = tmp()
    seed(appHome)
    const r = checkSealedCredentials()
    expect(r.ok).toBe(true)
    expect(r.message).toContain('decryptable')
  })

  test('missing secret.key → FAILS loudly', () => {
    const appHome = tmp()
    seed(appHome)
    unlinkSync(join(appHome, 'secret.key'))
    const r = checkSealedCredentials()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('MISSING')
  })

  test('mismatched secret.key (cross-machine) → FAILS with re-enter guidance', () => {
    const appHome = tmp()
    seed(appHome)
    // Simulate restoring onto a different machine: replace secret.key with a NEW one.
    unlinkSync(join(appHome, 'secret.key'))
    createSecretBox(join(appHome, 'secret.key')) // generates a fresh, different key
    const r = checkSealedCredentials()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('cannot be decrypted')
  })

  test('no sealed credentials → ok', () => {
    const appHome = tmp()
    process.env.AGENT_WORKFLOW_HOME = appHome
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const s = (db as unknown as { $client: Database }).$client
    s.exec('PRAGMA wal_checkpoint(TRUNCATE);') // fold migrations into the base (immutable read)
    s.close()
    const r = checkSealedCredentials()
    expect(r.ok).toBe(true)
    expect(r.message).toContain('no sealed')
  })
})
