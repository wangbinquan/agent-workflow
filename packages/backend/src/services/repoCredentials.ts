// RFC-204 T7 — Git credential sealing for `cached_repos`.
//
// Private repos are onboarded by putting a token in the URL, so the original
// URL is a secret. RFC-204 already stopped it leaving the daemon (the wire
// serves `urlRedacted` only); this module removes it from the DB file as well,
// because `POST /api/backup` and `agent-workflow backup` both `VACUUM INTO` a
// copy of db.sqlite. The backup tarball ships db.sqlite/config.json/skills/
// workflows but NOT `secret.key`, so a sealed DB in a backup is genuinely safe.
//
// Scope of the unseal: almost nothing needs the plaintext. Warm fetches run
// against the mirror's own `origin`; refresh/delete diagnostics read
// `url_redacted`; and refTaskCount joins `cached_repo_id`. The remaining readers
// are credential leases, reuse-by-cachedRepoId, webhook collision verification,
// and verified file:// legacy re-keying.
//
// NOT a boundary against local runtime children: they run at the daemon's uid
// and can read files available to that account. This module protects API,
// backup and Git transport surfaces only.

import {
  gitUrlCacheKeyWith,
  hasQueryCredential,
  parseGitUrl,
  redactGitUrl,
} from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'
import { and, eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { cachedRepos, scheduledTasks, taskRepos, tasks } from '@/db/schema'
import { createLogger } from '@/util/log'
import { redactSensitiveString } from '@/util/redact'

const log = createLogger('repo-credentials')

const sha1Hex = (s: string): string => createHash('sha1').update(s).digest('hex')
const LEGACY_URL_ESCROW_PREFIX = 'aw-legacy-url-hex-v1:'
const utf8Fatal = new TextDecoder('utf-8', { fatal: true })
const volatileRepoUrls = new WeakMap<DbClient, Map<string, string>>()

/**
 * Key-less embeddings may keep using a just-created cache row in this process,
 * but the original URL must never be persisted. The WeakMap is deliberately
 * scoped to the DbClient identity: a reopen creates a new client and therefore
 * cannot recover this volatile capability.
 */
export function rememberVolatileRepoUrl(db: DbClient, id: string, url: string): void {
  let byId = volatileRepoUrls.get(db)
  if (byId === undefined) {
    byId = new Map()
    volatileRepoUrls.set(db, byId)
  }
  byId.set(id, url)
}

export function forgetVolatileRepoUrl(db: DbClient, id: string): void {
  volatileRepoUrls.get(db)?.delete(id)
}

function decodeLegacyUrlEscrow(value: string): string {
  const hex = value.slice(LEGACY_URL_ESCROW_PREFIX.length)
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new DomainError(
      'cached-repo-legacy-url-escrow-invalid',
      'cached repo legacy URL escrow is malformed; refusing to continue',
      500,
    )
  }
  try {
    const plain = utf8Fatal.decode(Buffer.from(hex, 'hex'))
    if (plain.length === 0) throw new Error('empty escrow')
    return plain
  } catch {
    throw new DomainError(
      'cached-repo-legacy-url-escrow-invalid',
      'cached repo legacy URL escrow is malformed; refusing to continue',
      500,
    )
  }
}

/** Seal a repo URL for storage. */
export function sealRepoUrl(secretBox: SecretBox, url: string): string {
  return secretBox.seal(url)
}

/**
 * Recover the usable (credentialed) URL for a cached repo row.
 *
 * Migration escrow is deliberately rejected here: only the first boot sealing
 * gate may decode it. Without ciphertext/key, callers may recover only the
 * current DbClient's deliberately volatile capability; otherwise returns null.
 */
export function unsealRepoUrl(
  row: { id?: string; urlEnc: string | null },
  secretBox: SecretBox | undefined,
  db?: DbClient,
): string | null {
  if (row.urlEnc !== null && row.urlEnc.length > 0) {
    if (row.urlEnc.startsWith(LEGACY_URL_ESCROW_PREFIX)) {
      log.warn('cached repo legacy URL escrow reached an ordinary read path')
      return null
    }
    if (secretBox === undefined) {
      // Sealed at rest but no key wired in — refuse rather than fall back to a
      // blanked plaintext column and launch against the wrong thing.
      log.warn('cached repo is sealed but no SecretBox is available')
      return null
    }
    try {
      return secretBox.unseal(row.urlEnc)
    } catch {
      // Key rotated/lost: the credential is unrecoverable. Same story as OIDC
      // client_secret — the user re-enters it by re-launching the repo.
      log.warn('failed to unseal cached repo url (wrong or lost secret.key?)')
      return null
    }
  }
  if (db !== undefined && row.id !== undefined) {
    return volatileRepoUrls.get(db)?.get(row.id) ?? null
  }
  return null
}

/** Columns whose historical values may embed a `?access_token=` style secret. */
interface ScrubTarget {
  label: string
  run: (db: DbClient) => number
}

function scrubColumn(
  label: string,
  select: (db: DbClient) => Array<{ id: unknown; value: string | null }>,
  update: (db: DbClient, id: unknown, next: string) => void,
): ScrubTarget {
  return {
    label,
    run: (db) => {
      let n = 0
      for (const row of select(db)) {
        if (row.value === null || row.value.length === 0) continue
        const next = redactSensitiveString(row.value)
        if (next !== row.value) {
          update(db, row.id, next)
          n++
        }
      }
      return n
    },
  }
}

export interface SealResult {
  sealed: number
  linked: number
  scrubbed: number
}

/**
 * Idempotent, NETWORK-FREE sealing gate. Safe to run on every daemon start and
 * before every backup; a second run is a no-op.
 *
 * Deliberately never clones: converting a legacy row by re-resolving it would
 * make daemon startup (and `agent-workflow backup`) depend on remote
 * availability and valid credentials, so an unreachable remote could block an
 * upgrade for the whole clone timeout.
 *
 * ORDER MATTERS. `cached_repo_id` is derived from the still-raw `repo_url`
 * BEFORE that column is re-redacted: `canonicalForHash` includes the query, so
 * only the raw value hashes back to the cache row for a query-form URL. Doing
 * the scrub first would silently orphan exactly those rows.
 */
export function ensureCredentialsSealed(
  db: DbClient,
  secretBox: SecretBox | undefined,
  opts?: { blockOnCredentialedPath?: boolean },
): SealResult {
  const result: SealResult = { sealed: 0, linked: 0, scrubbed: 0 }

  // RFC-204 impl-gate P0-1 (Codex 2026-07-22): a cached repo onboarded from a
  // historical `?access_token=` URL slugged the token INTO cached_repos.local_path
  // (e.g. `<hash>-repo.git-access_token-TOPSECRET`). The seal only blanks the URL
  // column — the on-disk path (and its DB copy) still carries the token, and
  // `POST /api/backup` / `agent-workflow backup` VACUUM-INTO the local_path column
  // verbatim. New such URLs are now rejected at the door (schemas/task.ts +
  // repoBatchImport), but pre-existing rows remain. In a BACKUP context, refuse
  // rather than ship a plaintext token in the tarball. (Startup does not pass the
  // flag, so the daemon still boots — the operator deletes + re-adds the repo.)
  if (opts?.blockOnCredentialedPath === true) {
    const credentialed = db
      .select()
      .from(cachedRepos)
      .all()
      .filter((r) => hasQueryCredential(r.urlRedacted ?? ''))
    if (credentialed.length > 0) {
      throw new DomainError(
        'backup-credentialed-path',
        `refusing to back up: ${credentialed.length} cached repo(s) embed a query-string ` +
          `credential in their on-disk path (local_path), which VACUUM INTO would copy into ` +
          `the backup. Delete and re-add them (query credentials are now rejected — use a ` +
          `userinfo URL) before backing up.`,
        409,
        undefined,
      )
    }
  }

  // 1. Convert migration escrow to real ciphertext and repair a missing safe
  // display form from decryptable ciphertext. Ordinary readers never decode
  // the closed escrow prefix.
  const pending = db.select().from(cachedRepos).all()
  const escrowPending = pending.some((row) => row.urlEnc?.startsWith(LEGACY_URL_ESCROW_PREFIX))
  if (escrowPending && secretBox === undefined) {
    throw new DomainError(
      'cached-repo-legacy-url-escrow-key-unavailable',
      'cached repo legacy URL escrow requires SecretBox sealing before startup can continue',
      500,
    )
  }
  if (secretBox !== undefined) {
    for (const row of pending) {
      if (row.urlEnc === null || row.urlEnc.length === 0) continue
      const isEscrow = row.urlEnc.startsWith(LEGACY_URL_ESCROW_PREFIX)
      if (!isEscrow && row.urlRedacted !== null) continue
      let plain: string
      if (isEscrow) {
        plain = decodeLegacyUrlEscrow(row.urlEnc)
      } else {
        try {
          plain = secretBox.unseal(row.urlEnc)
        } catch {
          log.warn('failed to repair cached repo redaction (wrong or lost secret.key?)')
          continue
        }
      }
      db.update(cachedRepos)
        .set({
          urlEnc: isEscrow ? sealRepoUrl(secretBox, plain) : row.urlEnc,
          urlRedacted: redactGitUrl(plain),
        })
        .where(eq(cachedRepos.id, row.id))
        .run()
      result.sealed++
    }
  }

  // 2. Link task rows to their mirror — BEFORE step 3 rewrites repo_url.
  const hashToId = new Map<string, string>()
  for (const row of db.select().from(cachedRepos).all()) hashToId.set(row.urlHash, row.id)
  const linkFromUrl = (repoUrl: string | null): string | null => {
    if (repoUrl === null || repoUrl.length === 0) return null
    const parsed = parseGitUrl(repoUrl)
    if (parsed === null) return null
    return hashToId.get(gitUrlCacheKeyWith(parsed, sha1Hex).hash) ?? null
  }
  for (const row of db.select().from(taskRepos).all()) {
    if (row.cachedRepoId !== null) continue
    const id = linkFromUrl(row.repoUrl)
    if (id === null) continue
    db.update(taskRepos)
      .set({ cachedRepoId: id })
      .where(and(eq(taskRepos.taskId, row.taskId), eq(taskRepos.repoIndex, row.repoIndex)))
      .run()
    result.linked++
  }
  for (const row of db.select().from(tasks).all()) {
    if (row.cachedRepoId !== null) continue
    const id = linkFromUrl(row.repoUrl)
    if (id === null) continue
    db.update(tasks).set({ cachedRepoId: id }).where(eq(tasks.id, row.id)).run()
    result.linked++
  }

  // 2b. Scheduled tasks store the WHOLE launch body, so a credentialed repoUrl
  //     sat in `launch_payload` as plaintext (and went out through the API).
  //     Rewrite it to reference the mirror by id — `cachedRepoId` is already a
  //     first-class launch source (RFC-204 T1), so the payload stays valid and
  //     replayable while holding no secret. Rows with no matching mirror are
  //     left alone: they still need their URL to launch, and the read-side
  //     mapper redacts them on the way out.
  for (const row of db.select().from(scheduledTasks).all()) {
    let payload: Record<string, unknown>
    try {
      const raw: unknown = JSON.parse(row.launchPayload)
      if (raw === null || typeof raw !== 'object') continue
      payload = raw as Record<string, unknown>
    } catch {
      continue // corrupt payload — the migration/repair path owns it
    }
    let changed = false
    const convert = (obj: Record<string, unknown>): void => {
      const url = obj['repoUrl']
      if (typeof url !== 'string' || url.length === 0) return
      const id = linkFromUrl(url)
      if (id === null) return
      delete obj['repoUrl']
      obj['cachedRepoId'] = id
      changed = true
    }
    convert(payload)
    const repos = payload['repos']
    if (Array.isArray(repos)) {
      for (const r of repos) {
        if (r !== null && typeof r === 'object') convert(r as Record<string, unknown>)
      }
    }
    if (changed) {
      db.update(scheduledTasks)
        .set({ launchPayload: JSON.stringify(payload) })
        .where(eq(scheduledTasks.id, row.id))
        .run()
      result.scrubbed++
    }
  }

  // 3. Re-redact history written before redactGitUrl learned about query
  //    credentials — these columns are returned by their row mappers, and a
  //    VACUUM would otherwise just carry the token into the backup.
  const targets: ScrubTarget[] = [
    scrubColumn(
      'tasks.repo_url',
      (d) => d.select({ id: tasks.id, value: tasks.repoUrl }).from(tasks).all(),
      (d, id, next) =>
        d
          .update(tasks)
          .set({ repoUrl: next })
          .where(eq(tasks.id, id as string))
          .run(),
    ),
    scrubColumn(
      'cached_repos.last_submodule_sync_error',
      (d) =>
        d
          .select({ id: cachedRepos.id, value: cachedRepos.lastSubmoduleSyncError })
          .from(cachedRepos)
          .all(),
      (d, id, next) =>
        d
          .update(cachedRepos)
          .set({ lastSubmoduleSyncError: next })
          .where(eq(cachedRepos.id, id as string))
          .run(),
    ),
  ]
  for (const t of targets) result.scrubbed += t.run(db)

  // task_repos needs the composite key, so it is scrubbed inline.
  for (const row of db.select().from(taskRepos).all()) {
    for (const [col, value] of [
      ['repoUrl', row.repoUrl],
      ['submoduleInitError', row.submoduleInitError],
    ] as const) {
      if (value === null || value.length === 0) continue
      const next = redactSensitiveString(value)
      if (next === value) continue
      db.update(taskRepos)
        .set({ [col]: next })
        .where(and(eq(taskRepos.taskId, row.taskId), eq(taskRepos.repoIndex, row.repoIndex)))
        .run()
      result.scrubbed++
    }
  }

  // RFC-204 impl-gate P0-3 (Codex 2026-07-22): step 2b migrated every MATCHABLE
  // scheduled repoUrl to a cachedRepoId (no plaintext). Any REMAINING plaintext
  // credentialed repoUrl in a launch payload (no matching cache row) can't be
  // sealed by reference — VACUUM INTO would ship it in the backup. In a backup
  // context, refuse. (Startup doesn't set the flag; the operator re-saves the
  // schedule with a cachedRepoId source or a userinfo URL.)
  if (opts?.blockOnCredentialedPath === true) {
    const scheduledCred = db
      .select()
      .from(scheduledTasks)
      .all()
      .filter((r) => {
        let payload: unknown
        try {
          payload = JSON.parse(r.launchPayload)
        } catch {
          return false
        }
        if (payload === null || typeof payload !== 'object') return false
        const p = payload as Record<string, unknown>
        const urls: unknown[] = [p['repoUrl']]
        if (Array.isArray(p['repos'])) {
          for (const x of p['repos']) {
            if (x !== null && typeof x === 'object')
              urls.push((x as Record<string, unknown>)['repoUrl'])
          }
        }
        return urls.some((u) => typeof u === 'string' && u.length > 0 && redactGitUrl(u) !== u)
      })
    if (scheduledCred.length > 0) {
      throw new DomainError(
        'backup-credentialed-path',
        `refusing to back up: ${scheduledCred.length} scheduled task(s) hold a plaintext ` +
          `credentialed repoUrl in their launch payload (no matching cache row to seal by ` +
          `reference). Re-save them with a cachedRepoId source or a userinfo URL first.`,
        409,
        undefined,
      )
    }
  }

  // 4. Physical erase. Blanking a cell only changes the logical value; the WAL
  //    and freed pages keep the old bytes, which defeats the whole point for a
  //    stolen db.sqlite. secure_delete zeroes freed content, the checkpoint
  //    folds the WAL back in, VACUUM rewrites the file.
  if (result.sealed > 0 || result.scrubbed > 0) {
    try {
      db.run(sql`PRAGMA secure_delete = ON`)
      db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
      db.run(sql`VACUUM`)
    } catch (err) {
      log.warn('post-seal compaction failed', { error: (err as Error).message })
    }
  }

  if (result.sealed > 0 || result.linked > 0 || result.scrubbed > 0) {
    log.info('credential sealing gate applied', { ...result })
  }
  return result
}
