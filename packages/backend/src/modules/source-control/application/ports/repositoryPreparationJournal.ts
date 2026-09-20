/** RFC-363 private persistence contract. Serialized facts stay inside Source Control. */
import type { RepositoryPreparationState } from '../../domain/repositoryPreparationState'
export type { RepositoryPreparationState } from '../../domain/repositoryPreparationState'

export interface RepositorySourceRecord {
  readonly id: string
  readonly requestKey: string
  readonly requestDigest: string
  readonly kind: 'repository' | 'repository-group' | 'public-url'
  readonly factsJson: string
  readonly createdAt: number
}

export interface RepositorySnapshotRecord {
  readonly id: string
  readonly sourceRef: string
  readonly revision: string
  readonly factsJson: string
  readonly createdAt: number
}

export interface RepositoryPreparationRecord {
  readonly id: string
  readonly snapshotRef: string
  readonly state: RepositoryPreparationState
  readonly version: number
  readonly resolvedJson: string | null
  readonly receiptRef: string | null
  readonly receiptJson: string | null
  readonly failureCode: string | null
  readonly diagnosticsJson: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RepositoryPreparationJournal {
  source(id: string): Promise<RepositorySourceRecord | null>
  sourceByRequest(requestKey: string): Promise<RepositorySourceRecord | null>
  seal(input: RepositorySourceRecord): Promise<RepositorySourceRecord>
  snapshot(id: string): Promise<RepositorySnapshotRecord | null>
  freeze(input: RepositorySnapshotRecord): Promise<RepositorySnapshotRecord>
  operation(id: string): Promise<RepositoryPreparationRecord | null>
  plan(input: {
    readonly id: string
    readonly snapshotRef: string
    readonly now: number
  }): Promise<RepositoryPreparationRecord>
  advance(input: {
    readonly id: string
    readonly expectedVersion: number
    readonly from: RepositoryPreparationState
    readonly to: RepositoryPreparationState
    readonly now: number
    readonly resolvedJson?: string
    readonly receiptRef?: string
    readonly receiptJson?: string
    readonly failureCode?: string
    readonly diagnosticsJson?: string
  }): Promise<RepositoryPreparationRecord | null>
}
