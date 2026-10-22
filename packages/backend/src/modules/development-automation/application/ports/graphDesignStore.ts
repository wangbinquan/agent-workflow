import type { GraphArtifactReference } from './graphDesignArtifacts'

export interface GraphDesignIdentity {
  readonly id: string
  readonly caseId: string
  readonly revision: number
  readonly presentationJson: string
  readonly presentationRevision: number
  readonly createdAt: number
  readonly updatedAt: number
}
export interface GraphStoredRevision extends GraphArtifactReference {
  readonly designId: string
  readonly revision: number
  readonly requestId: string
  readonly createdAt: number
}
export interface GraphStoredRecord {
  readonly designId: string
  readonly id: string
  readonly kind: string
  readonly requestDigest: string
  readonly status: string
  readonly version: number
  readonly payloadJson: string
  readonly createdAt: number
  readonly updatedAt: number
}
export interface GraphStoredBasis extends GraphArtifactReference {
  readonly designId: string
  readonly id: string
  readonly createdAt: number
}
export interface GraphStoredLink {
  readonly designId: string
  readonly id: string
  readonly kind: 'trace' | 'evidence' | 'execution' | 'import'
  readonly payloadJson: string
  readonly createdAt: number
}
export interface GraphDesignStore {
  find(id: string): Promise<GraphDesignIdentity | null>
  findByCase(caseId: string): Promise<GraphDesignIdentity | null>
  create(identity: GraphDesignIdentity, revision: GraphStoredRevision): Promise<GraphDesignIdentity>
  revision(id: string, revision: number): Promise<GraphStoredRevision | null>
  revisions(id: string): Promise<readonly GraphStoredRevision[]>
  /** CAS + immutable revision + idempotent command receipt in one database transaction. */
  commit(input: {
    readonly expectedRevision: number
    readonly revision: GraphStoredRevision
    readonly requestDigest: string
  }): Promise<GraphStoredRevision>
  presentation(input: {
    readonly id: string
    readonly expectedRevision: number
    readonly json: string
    readonly now: number
  }): Promise<void>
  record(id: string, recordId: string): Promise<GraphStoredRecord | null>
  records(id: string): Promise<readonly GraphStoredRecord[]>
  insertRecord(record: GraphStoredRecord): Promise<GraphStoredRecord>
  updateRecord(record: GraphStoredRecord, expectedVersion: number): Promise<void>
  interruptRunningActions(now: number): Promise<void>
  basis(id: string, basisId: string): Promise<GraphStoredBasis | null>
  bases(id: string): Promise<readonly GraphStoredBasis[]>
  insertBasis(basis: GraphStoredBasis): Promise<GraphStoredBasis>
  links(id: string): Promise<readonly GraphStoredLink[]>
  insertLink(link: GraphStoredLink): Promise<void>
}
