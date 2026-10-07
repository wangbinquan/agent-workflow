import type { EvidenceBudget, EvidenceBundleRecord } from '../../domain/evidence'

/** Content and its producing program share one adapter-owned namespace. */
export interface EvidenceStagingNamespace {
  readonly kind: 'evidence-staging-namespace'
  readonly reference: object
}

export interface EvidenceStagingReference {
  readonly kind: 'evidence-staging'
  readonly namespace: EvidenceStagingNamespace
  readonly reference: object
}

/** A lease retains the same content receiver through writes, adoption and close. */
export interface EvidenceStagingLease {
  readonly reference: EvidenceStagingReference
  writeText(input: { readonly relativeName: string; readonly text: string }): void | Promise<void>
  importTree(budget: EvidenceBudget): EvidenceBundleRecord | Promise<EvidenceBundleRecord>
  putDocument(
    text: string,
  ):
    | { readonly sha256: string; readonly bytes: number }
    | Promise<{ readonly sha256: string; readonly bytes: number }>
  close(): void | Promise<void>
}

/** Native allocation details and remote transport details belong to implementations. */
export interface EvidenceStagingFactory {
  readonly namespace: EvidenceStagingNamespace
  create(): EvidenceStagingLease | Promise<EvidenceStagingLease>
}

/** The three original pipeline allocation mechanisms are selected as one family. */
export interface PipelineStagingFactories {
  readonly collect: EvidenceStagingFactory
  readonly trigger: EvidenceStagingFactory
  readonly rerun: EvidenceStagingFactory
}
