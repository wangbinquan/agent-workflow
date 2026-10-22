// RFC-370 v3 V6 — the one platform-neutral hosted object publication journal.
//
// A publication is one application reference (pin) of one immutable CS object,
// identified by (owner, key). Owners bind publications inside their own
// transactions and keep their own reference rows; the journal never interprets
// owner rows. The hosted object maintenance job (one job, registered once)
// resolves abandoned uploads, unpins owner-released objects behind the backup
// release horizon and purges settled rows.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

export interface HostedObjectReceipt {
  readonly id: string
  readonly sha256: string
  readonly size: number
}

export interface HostedObjectContent {
  readonly sha256: string
  readonly size: number
  /** Reopened only when the platform confirms the upload still needs bytes. */
  open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>
}

interface HostedObjectPublicationIdentity {
  /** The owning context's publication family, for example `task-artifact`. */
  readonly owner: string
  /** Permanent identity inside the owner family. */
  readonly key: string
  /** Owner-defined release group, for example the task id. */
  readonly scope?: string | null
  /** Deterministic lifetime identity; omitted for a fresh random lifetime. */
  readonly attempt?: string
}

export type HostedObjectPublicationRequest = HostedObjectPublicationIdentity &
  (
    | {
        /** Streamed upload; the caller alone can reopen the source. */
        readonly content: HostedObjectContent
        readonly bytes?: never
        readonly object?: never
      }
    | {
        /** In-memory upload. `recoverable` seals the bytes into the journal
         * until the object is ready, so maintenance can finish the upload
         * after this process is gone. */
        readonly bytes: Uint8Array
        readonly recoverable?: boolean
        readonly content?: never
        readonly object?: never
      }
    | {
        /** Link an existing immutable object without copying its bytes. */
        readonly object: HostedObjectReceipt
        readonly content?: never
        readonly bytes?: never
      }
  )

export interface HostedObjectPublishOptions {
  /** Runs in the fenced transaction that marks every publication ready, so the
   * owner's reference rows and the ready publications become visible together. */
  readonly commit?: (tx: PersistenceDb, receipts: readonly HostedObjectReceipt[]) => Promise<void>
  /** Bounded parallel transfers (default 1). */
  readonly concurrency?: number
}

export interface HostedObjectReleaseSelection {
  readonly owner: string
  readonly keys?: readonly string[]
  readonly scope?: string
  readonly keyPrefix?: string
}

/** The participant owners use. All writes check the hosted execution fence. */
export interface HostedObjectPublications {
  publish(
    requests: readonly HostedObjectPublicationRequest[],
    options?: HostedObjectPublishOptions,
  ): Promise<readonly HostedObjectReceipt[]>
  /** The ready object of (owner, key), or null. */
  find(owner: string, key: string): Promise<HostedObjectReceipt | null>
  /** Owner release. Runs inside `tx` (the owner's own transaction) when given.
   * Physical unpin is deferred to maintenance behind the release horizon. */
  release(selection: HostedObjectReleaseSelection, tx?: PersistenceDb): Promise<number>
  /** Live (pending/ready) scopes of one owner whose oldest live row was created
   * at or before `before`, ordered and paged by scope. */
  scopes(
    owner: string,
    page: { readonly before: number; readonly after?: string; readonly limit: number },
  ): Promise<readonly string[]>
}

/** An owner's own reconciliation of references it dropped implicitly (for
 * example rows removed by a task cascade). It releases through the participant
 * above; the maintenance job runs every registered sweep before settling. */
export interface HostedObjectOwnerSweep {
  readonly name: string
  sweep(input: { readonly now: number }): Promise<number>
}

/** Backups retain the objects their snapshot references by time, not by pins. */
export interface HostedBackupReleaseHorizon {
  /** True while a building/ready backup may reference an object whose owner
   * reference existed somewhere inside [createdAt, releasedAt]. */
  protects(lifetime: { readonly createdAt: number; readonly releasedAt: number }): Promise<boolean>
}

/** The single hosted object maintenance command (one maintenance job). */
export interface HostedObjectPublicationMaintenance {
  run(): Promise<Readonly<Record<string, number>>>
}
