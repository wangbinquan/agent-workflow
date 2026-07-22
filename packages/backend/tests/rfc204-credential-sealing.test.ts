// RFC-204 T7 — the at-rest sealing gate.
//
// Wire redaction (T1/T3) stopped the credential leaving the daemon; this locks
// the other half: it must not survive in the DB file either, because both
// backup entry points `VACUUM INTO` a copy of db.sqlite and the tarball does not
// contain secret.key.
//
// The two subtle properties, both from design-gate review findings:
//   * ORDER — `cached_repo_id` is derived from the RAW repo_url before that
//     column is re-redacted. canonicalForHash includes the query, so a
//     query-form URL only hashes back to its cache row while still raw.
//   * NETWORK-FREE — the gate runs on daemon start and before every backup, so
//     it must never re-clone; otherwise an unreachable remote could block an
//     upgrade for a whole clone timeout.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos, scheduledTasks, taskRepos, tasks, workflows } from '../src/db/schema'
import { gitUrlCacheKeyWith, parseGitUrl } from '@agent-workflow/shared'
import { createHash } from 'node:crypto'
import { ensureCredentialsSealed, unsealRepoUrl } from '../src/services/repoCredentials'

/** The real cache key for a URL — the gate links task rows by exactly this. */
function hashOf(url: string): string {
  return gitUrlCacheKeyWith(parseGitUrl(url)!, (s: string) =>
    createHash('sha1').update(s).digest('hex'),
  ).hash
}

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const KEY = Buffer.alloc(32, 7)
const box = createSecretBoxFromKey(KEY)
const TOKEN = 'ghp_ATRESTSECRET'
const CRED_URL = `https://x-access-token:${TOKEN}@github.com/acme/private.git`

function seedRepo(db: DbClient, id: string, url: string, hash = hashOf(url)): void {
  const now = Date.now()
  db.insert(cachedRepos)
    .values({
      id,
      urlHash: hash,
      url,
      localPath: `/tmp/repos/${hash}`,
      lastFetchedAt: now,
      createdAt: now,
    })
    .run()
}

function seedTask(db: DbClient, repoUrl: string | null): string {
  const wfId = ulid()
  const taskId = ulid()
  const now = Date.now()
  db.insert(workflows)
    .values({ id: wfId, name: 'wf', definition: '{}', version: 1, createdAt: now, updatedAt: now })
    .run()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      repoUrl,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      startedAt: now,
    })
    .run()
  db.insert(taskRepos)
    .values({
      taskId,
      repoIndex: 0,
      repoPath: '/tmp/wt',
      repoUrl,
      branch: `agent-workflow/${taskId}`,
      worktreePath: '/tmp/wt',
      worktreeDirName: '',
    })
    .run()
  return taskId
}

describe('RFC-204 T7 — credential sealing gate', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('seals the credential and blanks the plaintext column', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    const r = ensureCredentialsSealed(db, box)
    expect(r.sealed).toBe(1)

    const row = db.select().from(cachedRepos).all()[0]!
    expect(row.url).toBe('')
    expect(row.urlEnc).not.toBeNull()
    expect(row.urlRedacted).toBe('https://***@github.com/acme/private.git')
    // the ciphertext must not simply be the secret in disguise
    expect(row.urlEnc).not.toContain(TOKEN)
    // ...and it must round-trip, or reuse-by-id could never launch again
    expect(unsealRepoUrl(row, box)).toBe(CRED_URL)
  })

  test('no row anywhere still holds the token', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    seedTask(db, CRED_URL)
    ensureCredentialsSealed(db, box)

    const dump = JSON.stringify([
      db.select().from(cachedRepos).all(),
      db.select().from(tasks).all(),
      db.select().from(taskRepos).all(),
    ])
    expect(dump).not.toContain(TOKEN)
  })

  test('is idempotent — a second run changes nothing', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    const first = ensureCredentialsSealed(db, box)
    expect(first.sealed).toBe(1)
    const before = JSON.stringify(db.select().from(cachedRepos).all())

    const second = ensureCredentialsSealed(db, box)
    expect(second.sealed).toBe(0)
    expect(JSON.stringify(db.select().from(cachedRepos).all())).toBe(before)
  })

  test('links task rows to their mirror by hash', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    const taskId = seedTask(db, CRED_URL)
    // precondition: unlinked
    expect(db.select().from(tasks).all()[0]?.cachedRepoId).toBeNull()

    ensureCredentialsSealed(db, box)

    expect(
      db
        .select()
        .from(tasks)
        .all()
        .find((t) => t.id === taskId)?.cachedRepoId,
    ).toBe('cr-1')
    expect(db.select().from(taskRepos).all()[0]?.cachedRepoId).toBe('cr-1')
  })

  test('ORDER: a query-form row is linked before its column is re-redacted', () => {
    // The historical redactor did not mask query credentials, so this is exactly
    // what a pre-RFC-204 task row looks like. If the scrub ran first the raw
    // value would be gone and the hash could never match its cache row again.
    const qUrl = `https://github.com/acme/p.git?access_token=${TOKEN}`
    seedRepo(db, 'cr-q', qUrl)
    seedTask(db, qUrl)

    ensureCredentialsSealed(db, box)

    expect(db.select().from(tasks).all()[0]?.cachedRepoId).toBe('cr-q')
    // and the token is gone from the task column afterwards
    const dump = JSON.stringify(db.select().from(tasks).all())
    expect(dump).not.toContain(TOKEN)
  })

  test('NETWORK-FREE: a row whose mirror is unreachable is still sealed', () => {
    // No git binary is ever invoked — the local path does not even exist. A gate
    // that re-resolved the URL would hang the daemon boot here.
    seedRepo(db, 'cr-gone', CRED_URL)
    const r = ensureCredentialsSealed(db, box)
    expect(r.sealed).toBe(1)
    expect(db.select().from(cachedRepos).all()[0]?.url).toBe('')
  })

  test('without a SecretBox nothing is sealed and nothing is destroyed', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    const r = ensureCredentialsSealed(db, undefined)
    expect(r.sealed).toBe(0)
    expect(db.select().from(cachedRepos).all()[0]?.url).toBe(CRED_URL)
  })

  test('a sealed row read without the key fails closed rather than guessing', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    ensureCredentialsSealed(db, box)
    const row = db.select().from(cachedRepos).all()[0]!
    expect(unsealRepoUrl(row, undefined)).toBeNull()
    // wrong key → also null, never a partial/garbage URL
    expect(unsealRepoUrl(row, createSecretBoxFromKey(Buffer.alloc(32, 9)))).toBeNull()
  })
})

describe('RFC-204 T5 — scheduled launch payloads hold no credential', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  function seedSchedule(payload: unknown): string {
    const id = ulid()
    const now = Date.now()
    db.insert(scheduledTasks)
      .values({
        id,
        name: 'nightly',
        ownerUserId: '__system__',
        launchKind: 'workflow',
        launchPayload: JSON.stringify(payload),
        scheduleSpec: JSON.stringify({ kind: 'interval', everyMs: 3600000 }),
        enabled: true,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return id
  }

  test('a stored credentialed repoUrl is rewritten to a cachedRepoId reference', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    const id = seedSchedule({ workflowId: 'w', name: 'n', repoUrl: CRED_URL, inputs: {} })

    ensureCredentialsSealed(db, box)

    const row = db
      .select()
      .from(scheduledTasks)
      .all()
      .find((r) => r.id === id)!
    expect(row.launchPayload).not.toContain(TOKEN)
    const after = JSON.parse(row.launchPayload) as Record<string, unknown>
    // still launchable — just by id now, which the launch schema accepts
    expect(after['cachedRepoId']).toBe('cr-1')
    expect(after['repoUrl']).toBeUndefined()
  })

  test('multi-repo entries are converted too', () => {
    seedRepo(db, 'cr-1', CRED_URL)
    const id = seedSchedule({
      workflowId: 'w',
      name: 'n',
      repos: [{ repoUrl: CRED_URL, ref: 'main' }],
      inputs: {},
    })

    ensureCredentialsSealed(db, box)

    const row = db
      .select()
      .from(scheduledTasks)
      .all()
      .find((r) => r.id === id)!
    expect(row.launchPayload).not.toContain(TOKEN)
    const repos = (JSON.parse(row.launchPayload) as { repos: Array<Record<string, unknown>> }).repos
    expect(repos[0]?.cachedRepoId).toBe('cr-1')
    expect(repos[0]?.ref).toBe('main') // ref survives the rewrite
  })

  test('a payload with no matching mirror is left launchable (not destroyed)', () => {
    // No cache row: the URL is the only way to launch it, so the gate must not
    // strip it. The read-side mapper is what keeps it off the wire.
    const id = seedSchedule({ workflowId: 'w', name: 'n', repoUrl: CRED_URL, inputs: {} })
    ensureCredentialsSealed(db, box)
    const row = db
      .select()
      .from(scheduledTasks)
      .all()
      .find((r) => r.id === id)!
    expect(JSON.parse(row.launchPayload)['repoUrl']).toBe(CRED_URL)
  })
})

describe('RFC-204 — the delete guard sees schedule references', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('a schedule referencing the mirror by id counts as a reference', () => {
    // Converting schedule payloads to `cachedRepoId` (T5) made schedules depend
    // on the cache row, so the delete guard has to count them — otherwise
    // deleting the mirror silently breaks the next fire with
    // cached-repo-not-found.
    seedRepo(db, 'cr-1', CRED_URL)
    const now = Date.now()
    db.insert(scheduledTasks)
      .values({
        id: ulid(),
        name: 'nightly',
        ownerUserId: '__system__',
        launchKind: 'workflow',
        launchPayload: JSON.stringify({ workflowId: 'w', name: 'n', cachedRepoId: 'cr-1' }),
        scheduleSpec: JSON.stringify({ kind: 'interval', everyMs: 3600000 }),
        enabled: true,
        nextRunAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    const rows = db.select().from(scheduledTasks).all()
    expect(rows[0]?.launchPayload).toContain('"cachedRepoId":"cr-1"')
  })
})

describe('RFC-204 impl-gate P0-1 — backup refuses a query-credential on-disk path', () => {
  test('startup seals but does NOT block; backup context throws (token would ship)', () => {
    const db = createInMemoryDb(MIGRATIONS)
    // Historical row onboarded from a ?access_token= URL — the token is slugged
    // into local_path, which VACUUM INTO copies verbatim into the backup.
    db.insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'h1',
        url: 'https://h/r.git?access_token=TOPSECRET',
        urlRedacted: null,
        localPath: '/h/.agent-workflow/repos/h1-r.git-access_token-TOPSECRET',
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      .run()

    // Startup context (no flag): must NOT block — the daemon has to boot. It
    // seals the URL column (blanks it) but leaves urlRedacted with the query key.
    expect(() => ensureCredentialsSealed(db, box)).not.toThrow()

    // Backup context: refuse — the local_path still embeds the plaintext token.
    let code: string | undefined
    try {
      ensureCredentialsSealed(db, box, { blockOnCredentialedPath: true })
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe('backup-credentialed-path')
  })

  test('a credential-free cached repo never blocks a backup', () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'h2',
        url: 'https://h/clean.git',
        urlRedacted: null,
        localPath: '/h/.agent-workflow/repos/h2-clean',
        defaultBranch: 'main',
        lastFetchedAt: 1,
        createdAt: 1,
      })
      .run()
    expect(() => ensureCredentialsSealed(db, box, { blockOnCredentialedPath: true })).not.toThrow()
  })
})
