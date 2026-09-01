import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { CommandContext } from '@/modules/identity-access/public/participants'
import { sha256Hex } from '@/util/hash'
import { createResourcePackageApplication } from '../application/package/packageApplication'
import type {
  ResourcePackageExecutionPort,
  ResourcePackageHumanMemberMapping,
  ResourcePackageImportDecision,
  ResourcePackageOwnedResourceLookupPort,
  ResourcePackageReadPort,
  ResourcePackageSecretInput,
  ResourcePackageSkillTree,
} from '../application/package/ports'
import {
  createSqliteResourcePackageOwnedResourceLookup,
  createSqliteResourcePackageReadPort,
} from '../infrastructure/sqlitePackageResourceRows'
import { readSqlitePackageSkillTree } from '../infrastructure/sqlitePackageSkillTree'
import { createResourcePackageOperationDescriptors } from './catalogOperationDescriptors'
import type { ResourcePackageCatalogModule } from '../public/operations'
import {
  type PackageResourceKind,
  type PackageResourceRef,
  type ApplyResourcePackage,
  type ExportResourcePackage,
  type InspectResourcePackage,
} from '../public/types'
import { PACKAGE_RESOURCE_KINDS } from '../domain/resourceKinds'

export interface ResourcePackageExportFence {
  readonly expectedVersion?: number
  readonly expectedContentVersion?: number
  readonly expectedUpdatedAt?: number
  readonly expectedAclRevision?: number
  readonly expectedMetaRevision?: number
  readonly expectedConfigHash?: string
}

export interface ResourcePackageInspectExecutionInput {
  readonly kind: 'inspect'
  readonly actor: Actor
  readonly bytes: Uint8Array
}

export interface ResourcePackageApplyExecutionInput {
  readonly kind: 'apply'
  readonly actor: Actor
  readonly bytes: Uint8Array
  readonly previewToken: string
  readonly decisions: readonly ResourcePackageImportDecision[]
  readonly humanMemberMappings: readonly ResourcePackageHumanMemberMapping[]
  readonly secretInputs: readonly ResourcePackageSecretInput[]
}

export interface ResourcePackageExportExecutionInput {
  readonly kind: 'export'
  readonly actor: Actor
  readonly root: PackageResourceRef
  readonly exportedAt: number
  readonly expect: ResourcePackageExportFence
}

type StagedResourcePackageInput =
  | ResourcePackageInspectExecutionInput
  | ResourcePackageApplyExecutionInput
  | ResourcePackageExportExecutionInput

/**
 * Provider-neutral execution seam. Composition retains ownership of the
 * one-shot staged handles while the selected provider owns all persistence and
 * transaction mechanics behind these closed inputs.
 */
export interface ResourcePackageExecutionAdapter {
  inspect(context: CommandContext, input: ResourcePackageInspectExecutionInput): Promise<string>
  apply(context: CommandContext, input: ResourcePackageApplyExecutionInput): Promise<string>
  export(
    context: CommandContext,
    input: ResourcePackageExportExecutionInput,
  ): Promise<Readonly<{ zip: Uint8Array; filename: string }>>
}

/**
 * Closed provider capabilities consumed by the external W6 execution owner.
 * The bundle algorithms stay outside Resource Catalog while provider-specific
 * lookup and managed-skill reads remain owned here.
 */
export interface ResourcePackageProviderComposition {
  readonly resources: ResourcePackageOwnedResourceLookupPort
  readonly reads: ResourcePackageReadPort
  readonly readSkillTree: (skillId: string) => Promise<ResourcePackageSkillTree>
}

export interface ResourcePackageTransport {
  findOwnedResourceIdsByName(
    actor: Actor,
    input: Readonly<{ kind: PackageResourceKind; name: string }>,
  ): Promise<readonly string[]>
  stageInspect(actor: Actor, bytes: Uint8Array): InspectResourcePackage
  stageApply(
    actor: Actor,
    input: Readonly<{
      bytes: Uint8Array
      previewToken: string
      decisions: readonly ResourcePackageImportDecision[]
      humanMemberMappings: readonly ResourcePackageHumanMemberMapping[]
      secretInputs: readonly ResourcePackageSecretInput[]
    }>,
  ): ApplyResourcePackage
  stageExport(
    actor: Actor,
    input: Readonly<{
      root: PackageResourceRef
      exportedAt: number
      expect: ResourcePackageExportFence
    }>,
  ): ExportResourcePackage
  takeExport(packageId: string): Uint8Array
}

export interface ComposedResourcePackageCatalog extends ResourcePackageCatalogModule {
  readonly transport: ResourcePackageTransport
}

export interface SqliteResourcePackageProviderDependencies {
  readonly db: DbClient
  readonly appHome: string
}

export interface ResourcePackageAdapterCompositionDependencies {
  readonly execution: ResourcePackageExecutionAdapter
  readonly resources: ResourcePackageOwnedResourceLookupPort
  readonly id?: () => string
}

export function composeResourcePackageOperationsFromAdapters(
  deps: ResourcePackageAdapterCompositionDependencies,
): ComposedResourcePackageCatalog {
  const nextId = deps.id ?? ulid
  const staged = new Map<string, StagedResourcePackageInput>()
  const exports = new Map<string, Uint8Array>()
  const packageKinds = new Set<PackageResourceKind>(PACKAGE_RESOURCE_KINDS)

  const stage = (input: StagedResourcePackageInput): string => {
    const handle = nextId()
    staged.set(handle, input)
    return handle
  }
  const take = (handle: string): StagedResourcePackageInput => {
    const input = staged.get(handle)
    if (input === undefined) throw new Error('resource-package-staged-input-not-found')
    staged.delete(handle)
    return input
  }

  const execution: ResourcePackageExecutionPort = Object.freeze({
    async inspect(context: CommandContext, handle: string): Promise<string> {
      const input = take(handle)
      if (input.kind !== 'inspect') throw new Error('resource-package-staged-input-kind-mismatch')
      return deps.execution.inspect(context, input)
    },
    async apply(context: CommandContext, handle: string): Promise<string> {
      const input = take(handle)
      if (input.kind !== 'apply') throw new Error('resource-package-staged-input-kind-mismatch')
      return deps.execution.apply(context, input)
    },
    async export(context: CommandContext, handle: string) {
      const input = take(handle)
      if (input.kind !== 'export') throw new Error('resource-package-staged-input-kind-mismatch')
      const pkg = await deps.execution.export(context, input)
      const packageId = nextId()
      exports.set(packageId, pkg.zip)
      return Object.freeze({ packageId, filename: pkg.filename })
    },
  })
  const application = createResourcePackageApplication({
    execution,
    ids: Object.freeze({ next: nextId }),
  })
  const operations = createResourcePackageOperationDescriptors(
    application.commands,
    application.queries,
  )
  const transport: ResourcePackageTransport = Object.freeze({
    findOwnedResourceIdsByName(
      actor: Actor,
      input: Readonly<{ kind: PackageResourceKind; name: string }>,
    ): Promise<readonly string[]> {
      return deps.resources.findOwnedIdsByName({
        kind: input.kind,
        ownerUserId: actor.user.id,
        name: input.name,
      })
    },
    stageInspect(actor: Actor, bytes: Uint8Array): InspectResourcePackage {
      return Object.freeze({
        submission: Object.freeze({
          kind: 'staged-resource-package' as const,
          handle: stage({ kind: 'inspect', actor, bytes }),
        }),
      })
    },
    stageApply(
      actor: Actor,
      input: Parameters<ResourcePackageTransport['stageApply']>[1],
    ): ApplyResourcePackage {
      return Object.freeze({
        submission: Object.freeze({
          kind: 'staged-resource-package' as const,
          handle: stage({ kind: 'apply', actor, ...input }),
        }),
        idempotencyKey: sha256Hex(input.previewToken),
      })
    },
    stageExport(
      actor: Actor,
      input: Parameters<ResourcePackageTransport['stageExport']>[1],
    ): ExportResourcePackage {
      if (!packageKinds.has(input.root.kind)) {
        throw new Error(`resource-package-kind-not-packageable:${input.root.kind}`)
      }
      return Object.freeze({
        submission: Object.freeze({
          kind: 'staged-resource-package' as const,
          handle: stage({ kind: 'export', actor, ...input }),
        }),
      })
    },
    takeExport(packageId: string): Uint8Array {
      const bytes = exports.get(packageId)
      if (bytes === undefined) throw new Error('resource-package-export-not-found')
      exports.delete(packageId)
      return bytes
    },
  })
  return Object.freeze({
    commands: application.commands,
    queries: application.queries,
    operations,
    transport,
  })
}

export function composeSqliteResourcePackageProvider(
  deps: SqliteResourcePackageProviderDependencies,
): ResourcePackageProviderComposition {
  return Object.freeze({
    resources: createSqliteResourcePackageOwnedResourceLookup(deps.db),
    reads: createSqliteResourcePackageReadPort(deps.db),
    readSkillTree: (skillId: string) => readSqlitePackageSkillTree(deps.db, deps.appHome, skillId),
  })
}

export function composeResourcePackageOperations(
  deps: ResourcePackageAdapterCompositionDependencies,
): ComposedResourcePackageCatalog {
  return composeResourcePackageOperationsFromAdapters(deps)
}
