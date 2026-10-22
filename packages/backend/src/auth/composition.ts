// RFC-359 W4-D9 —— 认证运行时与 PAT 审计的装配：两个 provider 同一份实现，入口收中立句柄。

import { createAuthRuntime, type AuthRuntime } from './application/authRuntime'
import type { AuthRuntimeOptions, DatabaseSourceWriteWindow } from './application/authPersistence'
import {
  createTokenCallAuditParticipant,
  type TokenCallAuditParticipant,
  type TokenCallRecord,
} from './application/tokenCallAudit'
import { allowsLegacyDaemonTestAccess } from '@/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { triggerRevalidation } from '@/ws/revalidationHook'
import { createAuthPersistence } from './infrastructure/authPersistence'
import { createTokenCallAuditPersistence } from './infrastructure/tokenCallAudit'

export interface CreateAuthRuntimeInput {
  readonly db: PersistenceDb
  /**
   * Post-commit transport invalidation; never receives a DB handle. Defaults to the WS
   * revalidation hook (the daemon's live credential cache); standalone CLI / tests pass their own.
   */
  readonly onCredentialRevoked?: NonNullable<AuthRuntimeOptions['onCredentialRevoked']>
  /** RFC-349 T10: omitted everywhere except daemon bootstrap (always writable). */
  readonly sourceWriteWindow?: DatabaseSourceWriteWindow
}

export function createAuthRuntimeFor(input: CreateAuthRuntimeInput): AuthRuntime {
  return createAuthRuntime({
    provider: databaseSessionFor(input.db).engine.provider,
    persistence: createAuthPersistence(input.db),
    options: {
      allowLegacyDaemonTestAccess: allowsLegacyDaemonTestAccess(input.db),
      onCredentialRevoked: input.onCredentialRevoked ?? ((reason) => triggerRevalidation(reason)),
      ...(input.sourceWriteWindow === undefined
        ? {}
        : { sourceWriteWindow: input.sourceWriteWindow }),
    },
  })
}

export function createTokenCallAudit(db: PersistenceDb): TokenCallAuditParticipant {
  return createTokenCallAuditParticipant(createTokenCallAuditPersistence(db))
}

/**
 * Compatibility bridge for callers not yet assembled by provider bootstrap.
 * The legacy service delegates here and therefore contains no SQL mechanism;
 * root composition can replace each call site with one long-lived participant.
 */
export const legacyTokenCallAudit = Object.freeze({
  record(db: PersistenceDb, record: TokenCallRecord, now?: number) {
    return createTokenCallAudit(db).record(record, now)
  },
  prune(db: PersistenceDb, retentionDays: number, now?: number) {
    return createTokenCallAudit(db).prune(retentionDays, now)
  },
  pruneSlice(
    db: PersistenceDb,
    retentionDays: number,
    cursor: unknown,
    now?: number,
    batchSize?: number,
  ) {
    return createTokenCallAudit(db).pruneSlice(retentionDays, cursor, now, batchSize)
  },
})
