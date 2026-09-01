import type { EmployeePublishLookup } from '../../domain/digitalEmployee'

export interface DevelopmentResourceIdentity {
  readonly id: string
  readonly name: string
  readonly draftJson: string
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

export interface DevelopmentResourceIdentityPersistence {
  create(input: {
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly draftJson: string
    readonly now: number
  }): Promise<DevelopmentResourceIdentity>
  get(id: string): Promise<DevelopmentResourceIdentity | null>
  listActive(): Promise<readonly DevelopmentResourceIdentity[]>
  revise(input: {
    readonly id: string
    readonly draftJson: string
    readonly name?: string
    readonly now: number
  }): Promise<void>
  archive(id: string, now: number): Promise<void>
  /** Atomic immutable revision append plus identity pointer advance. */
  publish(input: {
    readonly id: string
    readonly expectedDraftJson: string
    readonly contentJson: string
    readonly contentDigest: string
    readonly publishedBy: string | null
    readonly now: number
  }): Promise<{ readonly revision: number; readonly contentDigest: string }>
}

export interface DevelopmentAssignmentRecord {
  readonly id: string
  readonly scopeKind: 'repository' | 'repository-group' | 'global-default'
  readonly scopeRef: string | null
  readonly employeeId: string | null
  readonly employeeRevision: number | null
  readonly selectionPolicyId: string | null
  readonly selectionPolicyRevision: number | null
  readonly executionPolicyId: string | null
  readonly executionPolicyRevision: number | null
  readonly defaultRequirementSourceKey: string | null
}

export interface DevelopmentAssignmentPersistence {
  list(): Promise<readonly DevelopmentAssignmentRecord[]>
  upsert(input: {
    readonly scopeKind: DevelopmentAssignmentRecord['scopeKind']
    readonly scopeRef: string | null
    readonly employee: { readonly id: string; readonly revision: number } | null
    readonly selectionPolicy: { readonly id: string; readonly revision: number } | null
    readonly executionPolicy: { readonly id: string; readonly revision: number } | null
    readonly defaultRequirementSourceKey: string | null
    readonly updatedBy: string | null
    readonly now: number
  }): Promise<DevelopmentAssignmentRecord>
  delete(
    scopeKind: DevelopmentAssignmentRecord['scopeKind'],
    scopeRef: string | null,
  ): Promise<void>
}

export type AsyncEmployeePublishLookup = {
  readonly [K in keyof Required<EmployeePublishLookup>]: (
    ...args: Parameters<Required<EmployeePublishLookup>[K]>
  ) => Promise<ReturnType<Required<EmployeePublishLookup>[K]>>
}

export interface DevelopmentConfigPersistence {
  readonly employees: DevelopmentResourceIdentityPersistence
  readonly policies: DevelopmentResourceIdentityPersistence
  readonly assignments: DevelopmentAssignmentPersistence
  readonly publishLookup: AsyncEmployeePublishLookup
}
