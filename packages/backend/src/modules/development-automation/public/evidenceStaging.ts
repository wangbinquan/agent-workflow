import type {
  EvidenceStagingFactory,
  EvidenceStagingLease,
  EvidenceStagingNamespace,
} from '../application/ports/evidenceStaging'

/** A selected content face is complete; composition never fills individual members. */
export function assertEvidenceStagingFactory(factory: EvidenceStagingFactory): void {
  if (
    factory?.namespace?.kind !== 'evidence-staging-namespace' ||
    factory.namespace.reference === null ||
    (typeof factory.namespace.reference !== 'object' &&
      typeof factory.namespace.reference !== 'function') ||
    typeof factory.create !== 'function'
  ) {
    throw new Error('evidence-staging-factory-incomplete')
  }
}

export function assertEvidenceStagingLease(
  lease: EvidenceStagingLease,
  namespace: EvidenceStagingNamespace,
): void {
  if (
    lease?.reference?.kind !== 'evidence-staging' ||
    lease.reference.namespace?.reference !== namespace.reference ||
    lease.reference.reference === null ||
    (typeof lease.reference.reference !== 'object' &&
      typeof lease.reference.reference !== 'function')
  ) {
    throw new Error('evidence-staging-namespace-mismatch')
  }
  for (const name of ['writeText', 'importTree', 'putDocument', 'close'] as const) {
    if (typeof lease[name] !== 'function') {
      throw new Error(`evidence-staging-lease-incomplete:${name}`)
    }
  }
}
