// RFC-359 W4-D9 —— 认证运行时与 PAT 审计的装配：两个 provider 同一份实现，入口收中立句柄。

import { createAuthRuntime, type AuthRuntime } from './application/authRuntime'
import type { AuthRuntimeOptions, DatabaseSourceWriteWindow } from './application/authPersistence'
import {
  createTokenCallAuditParticipant,
  type TokenCallAuditParticipant,
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
