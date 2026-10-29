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
//
// A serving instance also follows its own execution lease (RFC-370 §3.2,
// crash-only). Losing the lease ends the instance: from that moment it only
// drains and exits, so every later write is refused and the next holder sees
// exactly the state a crash would have left. While the lease is held, a write
// is refused as soon as the control row names a newer holder, before this
// instance's renewal notices it. Without this, an instance that lost a
// handoff in the middle of a merge-back stamped `merge-failed` on a node whose
// workspace command it had only detached (2026-10-17 hosted acceptance).
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { DomainError } from '@/util/errors'
import type { ExecutionAuthorityState } from '../../application/ports/executionAuthority'
import {
  holdHostedExecutionControl,
  hostedLeaseOf,
  HostedExecutionLeaseLostError,
} from '../hostedExecutionControl'

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
  beforeWrite(tx: PersistenceDb): Promise<void>
  /** Govern every later write transaction (idempotent). */
  enforce(): void
  /** Whether later writes are governed yet; boot convergence before `enforce()` is not, and it
   * does not count as the generation's first live write either. */
  isEnforcing(): boolean
  /** Follow this instance's own execution lease: refuse writes once it is
   * lost, and while it is held whenever the control row names another holder. */
  follow(authority: {
    current(): ExecutionAuthorityState
    onLost(listener: (state: ExecutionAuthorityState) => void): () => void
  }): void
}

export function createHostedDatabaseWriteBarrier(
  input: { readonly enforcing?: boolean } = {},
): HostedDatabaseWriteBarrier {
  let enforcing = input.enforcing ?? true
  let authority: { current(): ExecutionAuthorityState } | undefined
  let lost: string | undefined
  return Object.freeze({
    enforce() {
      enforcing = true
    },
    isEnforcing: () => enforcing,
    follow(next: Parameters<HostedDatabaseWriteBarrier['follow']>[0]) {
      if (authority !== undefined) throw new Error('the write barrier already follows a lease')
      authority = next
      next.onLost((state) => {
        lost ??= state.kind === 'active' ? 'lease lost' : (state.reason ?? state.kind)
      })
    },
    async beforeWrite(tx: PersistenceDb) {
      if (!enforcing) return
      const row = await holdHostedExecutionControl(tx)
      if (row?.migrationOperationId != null) {
        throw new HostedDatabaseWriteUnavailableError(row.migrationOperationId)
      }
      // Read the lease first: an expired lease is lost while it is read.
      const state = authority?.current()
      if (lost !== undefined) throw new HostedExecutionLeaseLostError(lost)
      if (state?.kind !== 'active') return
      const lease = hostedLeaseOf(state.fence)
      if (row === undefined || row.epoch !== lease.epoch || row.owner !== lease.instanceId) {
        throw new HostedExecutionLeaseLostError('held by another instance')
      }
    },
  })
}
