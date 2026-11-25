// RFC-595 — the resource session Intent apply drives, in Intent's own shapes (RFC-294 S9: the consumer declares the port it
// calls). Resource Catalog implements it (`createIntentApplyResourceSession` behind `composeIntentApplyResourceBinding`);
// bootstrap binds the two, and the compiler checks the implementation against this shape there and in the RFC-595 test.
// Only what the engine calls and passes is written down: the manifest and changeset it reads off the session row, the
// plans it builds, the artifacts it records, its own transaction, and a commit receipt it does not read.
import type { IntentChangeset } from '@agent-workflow/shared'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type {
  IntentApplyArtifact,
  VersionedIntentResourceChangesetPlan,
} from '@/modules/resource-catalog/public/types'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { IntentManifestEntry } from '../manifest'

export interface IntentApplyResourcePreflight {
  /** Copy-only targets bundle resolution must honour (target → source), as Resource Catalog decided them. */
  readonly copyOnlyTargets: ReadonlyMap<string, string>
}

export interface IntentApplyResourcePrepareContext {
  readonly pendingIds: ReadonlySet<string>
  readonly pendingAgentNames: ReadonlyMap<string, string>
  /** RFC-401 A1: the final dependsOn of every agent in this bundle. */
  readonly agentDependencies: ReadonlyMap<string, readonly string[]>
  readonly clientMutationId: string
}

export interface IntentApplyResourcePrestageContext {
  recordArtifact(artifact: IntentApplyArtifact): Promise<void>
}

export interface IntentApplyResourceCommitContext {
  readonly bundleCreatedNames: Readonly<{
    readonly workflow: ReadonlySet<string>
    readonly workgroup: ReadonlySet<string>
  }>
}

export interface IntentApplyResourceTransactionAttempt {
  readonly participant: {
    /** The receipt is Resource Catalog's; the engine records its own applied entry and does not read it. */
    authorizeAndCommit(
      authority: ResourceRequestContext,
      plan: VersionedIntentResourceChangesetPlan,
    ): Promise<unknown>
  }
  /** Promote this attempt's tail only after the outer Intent transaction commits. */
  commitSucceeded(): void
}

export interface IntentApplyResourceSession {
  preflight(
    manifest: readonly IntentManifestEntry[],
    changeset: IntentChangeset,
  ): Promise<IntentApplyResourcePreflight>
  prepare(
    plan: VersionedIntentResourceChangesetPlan,
    context: IntentApplyResourcePrepareContext,
  ): Promise<void>
  prestage(
    plan: VersionedIntentResourceChangesetPlan,
    context: IntentApplyResourcePrestageContext,
  ): Promise<void>
  createTransactionAttempt(
    transaction: PersistenceTx,
    context: IntentApplyResourceCommitContext,
  ): IntentApplyResourceTransactionAttempt
  rollForwardCommitted(): Promise<void>
  broadcastCommitted(): Promise<void>
  abortPrepared(input: { readonly databaseCommitted: boolean }): Promise<void>
}
