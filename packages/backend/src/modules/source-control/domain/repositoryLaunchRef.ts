/** RFC-362 wire syntax only. Decoding a reference does not resolve its record. */
import type {
  SealedPublicRepositorySourceRef,
  FrozenRepositoryPreparationRef,
  RepositoryPreparationOperationRef,
  RepositoryPreparationReceiptRef,
  RepositoryPreparationStopReceipt,
  RepositoryPreparationDiagnosticsRef,
  AuthorizedWorkspaceSnapshotRef,
} from '../public/types'

interface RepositoryLaunchRefs {
  source: SealedPublicRepositorySourceRef
  preparation: FrozenRepositoryPreparationRef
  operation: RepositoryPreparationOperationRef
  receipt: RepositoryPreparationReceiptRef
  stopped: RepositoryPreparationStopReceipt
  diagnostics: RepositoryPreparationDiagnosticsRef
  workspace: AuthorizedWorkspaceSnapshotRef
}

/** Exact kind/version round-trip. Record lookup and lifetime belong to the provider. */
export function decodeRepositoryLaunchRef<K extends keyof RepositoryLaunchRefs>(
  kind: K,
  value: string,
): RepositoryLaunchRefs[K] {
  const prefix = `sc:${kind}:v1:`
  if (!value.startsWith(prefix) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.slice(prefix.length))) {
    throw new Error(`invalid-repository-launch-ref:${kind}`)
  }
  return value as RepositoryLaunchRefs[K]
}
