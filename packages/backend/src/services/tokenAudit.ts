// RFC-247 D16 / §6 — the token call audit.
//
// One row per call made with a token, on either channel. It answers the
// questions an operator actually has after "a token did something unexpected":
// which token, whose, what did it touch, did it work, and when.
//
// ## What is deliberately NOT stored
//
// The request body. `resource_write` payloads carry MCP `env` values and repo
// credentials, so a table that kept them would be a new place for secrets to
// live — a breach surface dressed up as a control. Metadata plus, for deletes,
// a redacted snapshot of what was removed covers the real need without that.
//
// ## Never blocks the business call (F13)
//
// Auditing is a side channel. If the insert fails the call still succeeds and
// the failure is logged: a daemon that refuses to serve because it could not
// write a log row has turned an observability feature into an outage.

import { eq, lt } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Context } from 'hono'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { tokenAudit, tokenDeleteSnapshot } from '@/db/schema'
import { redactMcpRecord, redactRepoUrl } from '@/services/tokenRedaction'
import { createLogger } from '@/util/log'

const log = createLogger('token-audit')

export type TokenAuditChannel = 'rest' | 'mcp'

/**
 * RFC-247 AC-20 — the row a DELETE is about to remove.
 *
 * The audit hook runs AFTER the response, by which time the row is gone; the
 * first version therefore recorded metadata and never once wrote a snapshot in
 * production, even though the table, the redactor and the tests all existed.
 * "Who deleted what" without "what was it" is the half of the question that
 * stops mattering the moment you need the other half.
 *
 * Keyed off the Hono context rather than `c.set`, for two reasons: it needs no
 * typed context variable (route handlers are not middleware), and it is
 * automatically collected with the request. Only PAT callers pay anything —
 * for everyone else this is a branch and a return.
 */
const pendingSnapshots = new WeakMap<object, unknown>()

/** Call from a delete route AFTER loading the row and BEFORE removing it. */
export function captureDeleteSnapshot(c: Context, actor: Actor, row: unknown): void {
  if (actor.source !== 'pat') return
  pendingSnapshots.set(c, row)
}

/** Consume it. Returns undefined when the route captured nothing. */
export function takeDeleteSnapshot(c: Context): unknown {
  const row = pendingSnapshots.get(c)
  if (row !== undefined) pendingSnapshots.delete(c)
  return row
}

export interface TokenCallRecord {
  readonly actor: Actor
  readonly channel: TokenAuditChannel
  /** MCP only — which tool was invoked. */
  readonly toolName?: string
  readonly method?: string
  readonly path?: string
  readonly resourceKind?: string
  readonly resourceId?: string
  readonly statusCode: number
  /** For deletes: the row as it was, before it went away. */
  readonly deletedSnapshot?: unknown
}

/**
 * Record one token call. Returns the audit row id, or null when nothing was
 * written (a non-token actor, or a failure that must not surface).
 *
 * Non-token actors are skipped entirely rather than recorded with a null
 * `pat_id`: this table's whole purpose is per-token attribution, and rows that
 * cannot be attributed would dilute exactly the query it exists to serve.
 */
export async function recordTokenCall(
  db: DbClient,
  record: TokenCallRecord,
  now: number = Date.now(),
): Promise<string | null> {
  if (record.actor.source !== 'pat') return null
  const patId = record.actor.patId
  if (patId === undefined) return null

  const id = ulid()
  try {
    await db.insert(tokenAudit).values({
      id,
      patId,
      userId: record.actor.user.id,
      channel: record.channel,
      toolName: record.toolName ?? null,
      method: record.method ?? null,
      path: record.path ?? null,
      resourceKind: record.resourceKind ?? null,
      resourceId: record.resourceId ?? null,
      statusCode: record.statusCode,
      createdAt: now,
    })
  } catch (err) {
    log.warn('audit insert failed (business call unaffected)', { error: String(err) })
    return null
  }

  if (record.deletedSnapshot !== undefined) {
    await writeDeleteSnapshot(db, id, record, now)
  }
  return id
}

/**
 * F14 — a snapshot that cannot be serialized must not lose the audit row that
 * points at it. The row stays; only the snapshot is missing, and the failure is
 * logged rather than thrown.
 */
async function writeDeleteSnapshot(
  db: DbClient,
  auditId: string,
  record: TokenCallRecord,
  now: number,
): Promise<void> {
  try {
    await db.insert(tokenDeleteSnapshot).values({
      id: ulid(),
      auditId,
      resourceKind: record.resourceKind ?? 'unknown',
      resourceId: record.resourceId ?? 'unknown',
      snapshotJson: JSON.stringify(redactSnapshot(record.deletedSnapshot)),
      createdAt: now,
    })
  } catch (err) {
    log.warn('delete snapshot failed (audit row kept)', { auditId, error: String(err) })
    // F14 — mark the row. A swallowed failure that leaves no trace turns "we
    // could not capture the evidence" into "there was no evidence to capture",
    // which is the reading an investigator would take.
    try {
      await db.update(tokenAudit).set({ snapshotFailed: true }).where(eq(tokenAudit.id, auditId))
    } catch (markErr) {
      // Still must not break the business call (F13). At this point the row
      // exists and the snapshot does not; a lost marker is the least bad of
      // the three outcomes.
      log.warn('could not mark snapshot_failed', { auditId, error: String(markErr) })
    }
  }
}

/**
 * Snapshots go through the same redactor as every other token-facing payload.
 *
 * A snapshot is the one place where "we kept a copy of what was deleted" and
 * "we kept a copy of a credential" are the same sentence — an MCP row's `env`
 * would otherwise outlive the resource it belonged to, in a table nobody thinks
 * of as holding secrets.
 */
export function redactSnapshot(value: unknown): unknown {
  const masked = redactMcpRecord(value)
  if (typeof masked === 'object' && masked !== null && 'repoUrl' in masked) {
    const withUrl = masked as Record<string, unknown>
    return { ...withUrl, repoUrl: redactRepoUrl(withUrl.repoUrl as string | null) }
  }
  return masked
}

/**
 * Delete audit rows (and their snapshots) older than the retention window.
 *
 * Snapshots are removed by AGE rather than by joining their audit row: the two
 * tables share a retention clock and the same `created_at`, so an age sweep is
 * both simpler and immune to an orphan row left by a partial failure.
 */
export async function pruneTokenAudit(
  db: DbClient,
  retentionDays: number,
  now: number = Date.now(),
): Promise<{ audits: number; snapshots: number }> {
  const cutoff = now - retentionDays * 86_400_000
  const snapshots = await db
    .delete(tokenDeleteSnapshot)
    .where(lt(tokenDeleteSnapshot.createdAt, cutoff))
    .returning({ id: tokenDeleteSnapshot.id })
  const audits = await db
    .delete(tokenAudit)
    .where(lt(tokenAudit.createdAt, cutoff))
    .returning({ id: tokenAudit.id })
  return { audits: audits.length, snapshots: snapshots.length }
}

/** Rows for one user, newest first. Used by the owner's self-audit view. */
export async function listTokenAuditForUser(
  db: DbClient,
  userId: string,
  limit = 200,
): Promise<Array<typeof tokenAudit.$inferSelect>> {
  const rows = await db.select().from(tokenAudit)
  return rows
    .filter((r) => r.userId === userId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
}

/** Every row, newest first. Administrator view (D8: read-only). */
export async function listTokenAudit(
  db: DbClient,
  limit = 200,
): Promise<Array<typeof tokenAudit.$inferSelect>> {
  const rows = await db.select().from(tokenAudit)
  return rows.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}
