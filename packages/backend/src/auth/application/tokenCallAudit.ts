import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import { createLogger } from '@/util/log'
import { redactMcpRecord, redactRepoUrl } from './tokenSnapshotRedaction'

const log = createLogger('token-audit')

export type TokenAuditChannel = 'rest' | 'mcp'

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

export interface TokenAuditRecord {
  readonly id: string
  readonly patId: string
  readonly userId: string
  readonly channel: string
  readonly toolName: string | null
  readonly method: string | null
  readonly path: string | null
  readonly resourceKind: string | null
  readonly resourceId: string | null
  readonly statusCode: number
  readonly snapshotFailed: boolean
  readonly createdAt: number
}

export interface TokenDeleteSnapshotRecord {
  readonly id: string
  readonly auditId: string
  readonly resourceKind: string
  readonly resourceId: string
  readonly snapshotJson: string
  readonly createdAt: number
}

export interface TokenAuditPruneCursorV1 {
  readonly version: 1
  readonly phase: 'snapshots' | 'audits'
  readonly cutoff: number
}

export interface TokenAuditPruneSliceResult {
  readonly done: boolean
  readonly cursor: TokenAuditPruneCursorV1
  readonly counters: { readonly audits: number; readonly snapshots: number }
}

export const TOKEN_AUDIT_PRUNE_BATCH = 1_000

/** Provider-owned SQL mechanics. Application callers never receive its handle. */
export interface TokenCallAuditPersistence {
  insertAudit(record: TokenAuditRecord): Promise<void>
  insertDeleteSnapshot(record: TokenDeleteSnapshotRecord): Promise<void>
  markSnapshotFailed(auditId: string): Promise<void>
  listForUser(userId: string, limit: number): Promise<ReadonlyArray<TokenAuditRecord>>
  list(limit: number): Promise<ReadonlyArray<TokenAuditRecord>>
  pruneSlice(input: {
    readonly phase: TokenAuditPruneCursorV1['phase']
    readonly cutoff: number
    readonly batchSize: number
  }): Promise<number>
}

/**
 * Closed participant used by REST, MCP and maintenance composition. It keeps
 * provider selection and SQL outside transports while retaining the original
 * best-effort audit guarantee.
 */
export interface TokenCallAuditParticipant {
  record(record: TokenCallRecord, now?: number): Promise<string | null>
  listForUser(userId: string, limit?: number): Promise<ReadonlyArray<TokenAuditRecord>>
  list(limit?: number): Promise<ReadonlyArray<TokenAuditRecord>>
  prune(
    retentionDays: number,
    now?: number,
  ): Promise<{ readonly audits: number; readonly snapshots: number }>
  pruneSlice(
    retentionDays: number,
    cursorValue: unknown,
    now?: number,
    batchSize?: number,
  ): Promise<TokenAuditPruneSliceResult>
}

/**
 * Snapshots go through the same redactors as token-facing payloads. Keeping
 * this pure projection above the adapters makes SQLite and PostgreSQL persist
 * byte-for-byte equivalent evidence.
 */
export function redactSnapshot(value: unknown): unknown {
  const masked = redactMcpRecord(value)
  if (typeof masked === 'object' && masked !== null && 'repoUrl' in masked) {
    const withUrl = masked as Record<string, unknown>
    return { ...withUrl, repoUrl: redactRepoUrl(withUrl.repoUrl as string | null) }
  }
  return masked
}

function tokenAuditCursor(value: unknown, cutoff: number): TokenAuditPruneCursorV1 {
  if (value === null || value === undefined) return { version: 1, phase: 'snapshots', cutoff }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    !['snapshots', 'audits'].includes(String((value as { phase?: unknown }).phase)) ||
    !Number.isSafeInteger((value as { cutoff?: unknown }).cutoff)
  ) {
    throw new Error('maintenance-token-audit-cursor-invalid')
  }
  return value as TokenAuditPruneCursorV1
}

async function writeDeleteSnapshot(
  persistence: TokenCallAuditPersistence,
  auditId: string,
  record: TokenCallRecord,
  now: number,
): Promise<void> {
  try {
    const snapshotJson = JSON.stringify(redactSnapshot(record.deletedSnapshot))
    if (snapshotJson === undefined) throw new Error('token-audit-snapshot-not-serializable')
    await persistence.insertDeleteSnapshot({
      id: ulid(),
      auditId,
      resourceKind: record.resourceKind ?? 'unknown',
      resourceId: record.resourceId ?? 'unknown',
      snapshotJson,
      createdAt: now,
    })
  } catch (error) {
    log.warn('delete snapshot failed (audit row kept)', { auditId, error: String(error) })
    try {
      await persistence.markSnapshotFailed(auditId)
    } catch (markError) {
      log.warn('could not mark snapshot_failed', { auditId, error: String(markError) })
    }
  }
}

export function createTokenCallAuditParticipant(
  persistence: TokenCallAuditPersistence,
): TokenCallAuditParticipant {
  const participant: TokenCallAuditParticipant = {
    async record(record, now = Date.now()) {
      if (record.actor.source !== 'pat' || record.actor.patId === undefined) return null
      const id = ulid()
      try {
        await persistence.insertAudit({
          id,
          patId: record.actor.patId,
          userId: record.actor.user.id,
          channel: record.channel,
          toolName: record.toolName ?? null,
          method: record.method ?? null,
          path: record.path ?? null,
          resourceKind: record.resourceKind ?? null,
          resourceId: record.resourceId ?? null,
          statusCode: record.statusCode,
          snapshotFailed: false,
          createdAt: now,
        })
      } catch (error) {
        log.warn('audit insert failed (business call unaffected)', { error: String(error) })
        return null
      }
      if (record.deletedSnapshot !== undefined) {
        await writeDeleteSnapshot(persistence, id, record, now)
      }
      return id
    },
    listForUser: (userId, limit = 200) => persistence.listForUser(userId, limit),
    list: (limit = 200) => persistence.list(limit),
    async prune(retentionDays, now = Date.now()) {
      let cursor: TokenAuditPruneCursorV1 | null = null
      const total = { audits: 0, snapshots: 0 }
      for (;;) {
        const slice = await participant.pruneSlice(retentionDays, cursor, now)
        total.audits += slice.counters.audits
        total.snapshots += slice.counters.snapshots
        if (slice.done) return total
        cursor = slice.cursor
      }
    },
    async pruneSlice(
      retentionDays,
      cursorValue,
      now = Date.now(),
      batchSize = TOKEN_AUDIT_PRUNE_BATCH,
    ) {
      if (!Number.isInteger(batchSize) || batchSize < 1) {
        throw new Error('maintenance-token-audit-batch-invalid')
      }
      const cursor = tokenAuditCursor(cursorValue, now - retentionDays * 86_400_000)
      const deleted = await persistence.pruneSlice({
        phase: cursor.phase,
        cutoff: cursor.cutoff,
        batchSize,
      })
      if (cursor.phase === 'snapshots') {
        return {
          done: false,
          cursor:
            deleted < batchSize
              ? { ...cursor, phase: 'audits' }
              : { ...cursor, phase: 'snapshots' },
          counters: { audits: 0, snapshots: deleted },
        }
      }
      return {
        done: deleted < batchSize,
        cursor,
        counters: { audits: deleted, snapshots: 0 },
      }
    },
  }
  return Object.freeze(participant)
}
