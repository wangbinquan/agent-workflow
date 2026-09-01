import type { BundleResourceType, ResourceVisibility } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { CommandContext } from '@/modules/identity-access/public/participants'
import type { PackageResourceKind } from '../../public/types'

export interface ResourcePackageExportReceipt {
  readonly packageId: string
  readonly filename: string
}

/**
 * Composition-owned execution adapter. Handles identify one-shot, privately
 * staged transport material; neither bytes nor credentials enter application
 * DTOs.
 */
export interface ResourcePackageExecutionPort {
  inspect(context: CommandContext, handle: string): Promise<string>
  apply(context: CommandContext, handle: string): Promise<string>
  export(context: CommandContext, handle: string): Promise<ResourcePackageExportReceipt>
}

export interface ResourcePackageResultIdFactory {
  next(): string
}

/**
 * Provider-owned owner/name lookup used by the HTTP and CLI transport before
 * they stage an export. The application receives only resource identities;
 * neither a database client nor an ORM row crosses this boundary.
 */
export interface ResourcePackageOwnedResourceLookupPort {
  findOwnedIdsByName(input: {
    readonly kind: PackageResourceKind
    readonly ownerUserId: string
    readonly name: string
  }): Promise<readonly string[]>
}

/**
 * Closed provider-neutral snapshot. `document` is an internal compatibility
 * codec for the established package serializer, not an ORM row or public
 * surface. Identity/ACL fields stay explicit so policy decisions never parse
 * an opaque document.
 */
export interface ResourcePackageResourceSnapshot {
  readonly type: BundleResourceType
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly builtin: boolean
  readonly document: string
}

export interface ResourcePackageSuggestedUser {
  readonly username: string
  readonly userId: string
}

export type ResourcePackageImportAction = 'new' | 'reuse' | 'overwrite'

export interface ResourcePackageImportDecision {
  readonly localSlug: string
  readonly action: ResourcePackageImportAction
  readonly targetId?: string
  readonly finalName?: string
}

export interface ResourcePackageHumanMemberMapping {
  readonly workgroupSlug: string
  readonly username: string
  readonly userId?: string | null
}

export interface ResourcePackageSecretInput {
  readonly resourceType: PackageResourceKind
  readonly resourceName: string
  readonly field: string
  readonly value: string
}

/** Provider-neutral managed-skill payload consumed by package export. */
export interface ResourcePackageSkillTree {
  readonly frontmatterExtra: Record<string, unknown>
  readonly bodyMd: string
  readonly files: Array<{ path: string; bytes: Uint8Array }>
}

/** Async read model shared by preview/export on both database providers. */
export interface ResourcePackageReadPort {
  listByIds(
    type: BundleResourceType,
    ids: readonly string[],
    options?: Readonly<{ orderById?: boolean }>,
  ): Promise<readonly ResourcePackageResourceSnapshot[]>
  listByNames(
    type: BundleResourceType,
    names: readonly string[],
    options?: Readonly<{ orderById?: boolean }>,
  ): Promise<readonly ResourcePackageResourceSnapshot[]>
  getById(
    type: BundleResourceType,
    id: string,
  ): Promise<ResourcePackageResourceSnapshot | undefined>
  listGrantedResourceIds(actor: Actor, type: BundleResourceType): Promise<ReadonlySet<string>>
  findActiveUsersByUsername(
    usernames: readonly string[],
  ): Promise<readonly ResourcePackageSuggestedUser[]>
}
