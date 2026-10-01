import type { PluginSourceKind } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { PackageResourceKind } from '../../domain/resourceKinds'
import type { ResourceRequestContext } from '../../public/participants'
import type {
  PluginPackageMutation,
  ResourcePackageMutationReceipt,
  SkillPackageMutation,
} from '../../public/types'
import type { ResourcePackageHumanMemberMapping, ResourcePackageSecretInput } from './ports'

// Existing package side-effect contracts shared by both database providers.
// Persisted directory-named fields remain compatible opaque storage references;
// only the selected content adapter interprets them as filesystem paths.

export interface ResourcePackagePendingResourceId {
  readonly type: PackageResourceKind
  readonly localSlug: string
  readonly resourceId: string
}

export interface ResourcePackageRequestIds {
  mintCreate(input: { readonly type: PackageResourceKind; readonly localSlug: string }): string
  findCreate(input: {
    readonly type: PackageResourceKind
    readonly localSlug: string
  }): string | null
  listPending(): readonly ResourcePackagePendingResourceId[]
}

export interface ResourcePackageArtifactContext {
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly humanMemberMappings: readonly ResourcePackageHumanMemberMapping[]
  readonly secretInputs: readonly ResourcePackageSecretInput[]
  readonly readSkillFile?: (ref: string) => Uint8Array
  readonly ids: ResourcePackageRequestIds
}

export interface ResourcePackageSkillPublication {
  readonly managedPath: string
  readonly filesPath: string
  readonly contentHash: string | null
}

export interface ResourcePackagePluginPublication {
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
}

export interface ResourcePackageArtifactReceipt {
  readonly journalId: string
  readonly applied: readonly ResourcePackageMutationReceipt[]
  readonly root?: Readonly<{
    resourceType: ResourcePackageMutationReceipt['resourceType']
    resourceId: string
    name: string
    action: 'create' | 'update' | 'reuse'
  }>
  readonly skippedSecrets?: readonly Readonly<{
    resourceType: PackageResourceKind
    resourceName: string
    field: string
  }>[]
}

/** Durable, JSON-safe record written before each plugin/skill side effect. */
export type ResourcePackageMutationArtifact =
  | Readonly<{
      kind: 'plugin-install'
      operationId: string
      pluginId: string
      generationId: string
      generationDirectory: string
    }>
  | Readonly<{
      kind: 'skill-stage'
      operationId: string
      skillId: string
      stagingDirectory: string
      targetDirectory: string
    }>
  | Readonly<{
      kind: 'skill-version-stage'
      operationId: string
      skillId: string
      publishId: string
      version: number
      stagingDirectory: string
      versionDirectory: string
    }>

export type ResourcePackagePluginArtifact = Extract<
  ResourcePackageMutationArtifact,
  { kind: 'plugin-install' }
>

export type ResourcePackageSkillArtifact = Extract<
  ResourcePackageMutationArtifact,
  { kind: 'skill-stage' | 'skill-version-stage' }
>

export interface ResourcePackagePluginInstallPlan {
  /** Planning is side-effect free; install may run only after artifact persistence. */
  readonly artifact: ResourcePackagePluginArtifact
  install(): Promise<ResourcePackagePluginPublication>
}

export interface ResourcePackagePluginArtifactOwner {
  planInstall(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      mutation: PluginPackageMutation
      pluginId: string
      generationId: string
    }>,
  ): ResourcePackagePluginInstallPlan
  compensate(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      artifact: ResourcePackagePluginArtifact
      databaseCommitted: boolean
    }>,
  ): Promise<void>
  rollForward(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      artifact: ResourcePackagePluginArtifact
      receipt: ResourcePackageArtifactReceipt
    }>,
  ): Promise<void>
  afterCommitted(
    context: ResourcePackageArtifactContext,
    receipt: ResourcePackageArtifactReceipt,
  ): Promise<void>
}

export interface ResourcePackageSkillStagePlan {
  /** Planning is side-effect free; stage may run only after artifact persistence. */
  readonly artifact: ResourcePackageSkillArtifact
  stage(): Promise<ResourcePackageSkillPublication>
}

export interface ResourcePackageSkillArtifactOwner {
  planCreate(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      mutation: Extract<SkillPackageMutation, { kind: 'skill-create' }>
      skillId: string
    }>,
  ): ResourcePackageSkillStagePlan
  planUpdate(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      mutation: Extract<SkillPackageMutation, { kind: 'skill-update' }>
      skillId: string
      publishId: string
      version: number
    }>,
  ): ResourcePackageSkillStagePlan
  compensate(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      artifact: ResourcePackageSkillArtifact
      databaseCommitted: boolean
    }>,
  ): Promise<void>
  rollForward(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      artifact: ResourcePackageSkillArtifact
      receipt: ResourcePackageArtifactReceipt
    }>,
  ): Promise<void>
  afterCommitted(
    context: ResourcePackageArtifactContext,
    receipt: ResourcePackageArtifactReceipt,
  ): Promise<void>
}
