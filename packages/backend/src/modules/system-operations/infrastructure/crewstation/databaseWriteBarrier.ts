// RFC-370 v3 V7 — the hosted database write window, checked once per write
// transaction by the PostgreSQL client's write guard.
//
// While the platform freezes the service for a migration or a database
// restore, the frozen execution-control record names that operation and every
// hosted write is refused with a retryable 503; reads keep working, so the
// instance serves read-only (C7). The guard holds the control row for the rest
// of the transaction (`holdHostedExecutionControl`): a freeze waits for every
// write already admitted, and no write can start between the freeze and the
// platform being told the database is quiescent.
//
// There is no schema-version check here: hosted migrations are expand-only, so
// a release keeps writing while its successor's schema is already installed.
//
// A booting instance converges its own rows (identity admission, catalogs,
// projections) before it serves. Those idempotent writes precede admission and
// are not refused, so an instance restarted during a freeze boots into
// read-only standby instead of crash-looping. A serving instance calls
// `enforce()` when it starts competing for execution, right before it serves;
// a worker that borrows a lease enforces from the start.
import type { ProviderNeutralDatabase } from '@/db/query'
import { DomainError } from '@/util/errors'
import { holdHostedExecutionControl } from '../hostedExecutionControl'

export class HostedDatabaseWriteUnavailableError extends DomainError {
  constructor(readonly operationId: string) {
    super(
      'hosted-database-write-unavailable',
      'CrewStation is migrating or restoring this service database; reads keep working and writes resume when the platform finishes.',
      503,
      { operationId },
    )
    this.name = 'HostedDatabaseWriteUnavailableError'
  }
}

export interface HostedDatabaseWriteBarrier {
  /** The client's per-transaction write guard: refuse while the window is closed. */
  beforeWrite(tx: ProviderNeutralDatabase): Promise<void>
  /** Govern every later write transaction (idempotent). */
  enforce(): void
}

export function createHostedDatabaseWriteBarrier(
  input: { readonly enforcing?: boolean } = {},
): HostedDatabaseWriteBarrier {
  let enforcing = input.enforcing ?? true
  return Object.freeze({
    enforce() {
      enforcing = true
    },
    async beforeWrite(tx: ProviderNeutralDatabase) {
      if (!enforcing) return
      const row = await holdHostedExecutionControl(tx)
      if (row?.migrationOperationId != null) {
        throw new HostedDatabaseWriteUnavailableError(row.migrationOperationId)
      }
    },
  })
}
