// RFC-370 v3 V5 — owner restore normalization. A hosted restore imports the
// logical archive through the standalone PostgreSQL import path, then lets each
// owner normalize only its own rows (standalone RFC-213 semantics): no
// non-terminal task resumes automatically and no intent recorded by the backed-up
// instance is replayed as if this instance had issued it. System Operations
// never writes another context's tables; bootstrap wires the participants.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface HostedRestoreNormalizationParticipant {
  /** Owner context name, used for diagnostics only. */
  readonly name: string
  /** Idempotent: a resumed restore runs every participant again. */
  normalize(
    tx: PersistenceDb,
    input: { readonly restoreOperationId: string; readonly now: number },
  ): Promise<Readonly<Record<string, number>>>
}
