import type { PluginSourceKind, Skill } from '@agent-workflow/shared'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { VersionedIntentResourceChangesetPlan } from '../../public/types'

type SkillPlan = Extract<VersionedIntentResourceChangesetPlan, { readonly kind: 'skill' }>

// Persisted artifact fields are unchanged. The selected content owner interprets
// directory-named strings as file paths or opaque references; AW owns the journal.
export type IntentApplyArtifact =
  | Readonly<{
      readonly kind: 'plugin-install'
      readonly pluginId: string
      readonly generationId: string
      readonly generationDir: string
    }>
  | Readonly<{
      readonly kind: 'skill-stage'
      readonly skillId: string
      readonly operationId: string
      readonly stagingDirectory: string
    }>
  | Readonly<{
      readonly kind: 'skill-version-stage'
      readonly skillId: string
      readonly operationId: string
      readonly version: number
      readonly stagingDirectory: string
      readonly versionDirectory: string
    }>

export interface IntentArtifactStage<TResult> {
  readonly artifact: IntentApplyArtifact
  stage(): Promise<TResult>
  compensate(): Promise<void>
  rollForward(): Promise<void>
  complete(): Promise<void>
}

export interface IntentPluginPublication {
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
}

/**
 * Plugin content owner capability. Planning performs no storage effects;
 * the returned artifact is journaled before `stage` is called.
 */
export interface IntentPluginArtifactOwner {
  planInstall(input: {
    readonly pluginId: string
    readonly operationId: string
    readonly spec: string
  }): Promise<IntentArtifactStage<IntentPluginPublication>>
}

export interface IntentSkillPublication {
  readonly managedPath: string
  readonly filesPath: string
  readonly contentHash: string | null
  /** Consume the confirmed stage in AW's transaction; async storage effects
   * belong to stage/publication rather than this transaction callback. The
   * callback handle is derived from the neutral transaction, not its client. */
  commitInTransaction(
    transaction: Parameters<Parameters<DatabaseTransaction['transaction']>[0]>[0],
    versionIndex: number,
  ): Promise<void>
}

/**
 * Managed-skill content capability. Planning is side-effect free; the
 * Intent journal records `artifact` before the returned `stage` method acts.
 */
export interface IntentSkillArtifactOwner {
  planCreate(input: {
    readonly authority: DirectAuthenticatedAuthority
    readonly operationId: string
    readonly skillId: string
    readonly payload: SkillPlan['payload']
  }): Promise<IntentArtifactStage<IntentSkillPublication>>
  planUpdate(input: {
    readonly authority: DirectAuthenticatedAuthority
    readonly operationId: string
    readonly current: Skill
    readonly payload: SkillPlan['payload']
  }): Promise<IntentArtifactStage<IntentSkillPublication>>
}
