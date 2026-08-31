import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import type { CommandContext } from '@/modules/identity-access/public/participants'
import { legacyResourcePackageMutationRuntimeFactory } from '@/services/bundle/legacyResourcePackageMutationDependencies'
import type { HumanMemberMapping, ImportDecision } from '@/services/resourcePackage/commit'
import { commitResourcePackage } from '@/services/resourcePackage/commit'
import { exportResourcePackage } from '@/services/resourcePackage/export'
import { parseResourcePackage } from '@/services/resourcePackage/parse'
import { buildPackagePreview } from '@/services/resourcePackage/preview'
import type { PackageSecretInput } from '@/services/resourcePackage/secretInputs'
import { sha256Hex } from '@/util/hash'
import { createResourcePackageApplication } from '../application/package/packageApplication'
import type { ResourcePackageExecutionPort } from '../application/package/ports'
import {
  createResourcePackageOperationDescriptors,
  type ResourcePackageCatalogModule,
} from '../public/operations'
import {
  PACKAGE_RESOURCE_KINDS,
  type PackageResourceKind,
  type PackageResourceRef,
  type ApplyResourcePackage,
  type ExportResourcePackage,
  type InspectResourcePackage,
} from '../public/types'

export interface ResourcePackageExportFence {
  readonly expectedVersion?: number
  readonly expectedContentVersion?: number
  readonly expectedUpdatedAt?: number
  readonly expectedAclRevision?: number
  readonly expectedMetaRevision?: number
  readonly expectedConfigHash?: string
}

interface StagedInspect {
  readonly kind: 'inspect'
  readonly actor: Actor
  readonly bytes: Uint8Array
}

interface StagedApply {
  readonly kind: 'apply'
  readonly actor: Actor
  readonly bytes: Uint8Array
  readonly previewToken: string
  readonly decisions: readonly ImportDecision[]
  readonly humanMemberMappings: readonly HumanMemberMapping[]
  readonly secretInputs: readonly PackageSecretInput[]
}

interface StagedExport {
  readonly kind: 'export'
  readonly actor: Actor
  readonly root: PackageResourceRef
  readonly exportedAt: number
  readonly expect: ResourcePackageExportFence
}

type StagedResourcePackageInput = StagedInspect | StagedApply | StagedExport

export interface ResourcePackageTransport {
  stageInspect(actor: Actor, bytes: Uint8Array): InspectResourcePackage
  stageApply(
    actor: Actor,
    input: Readonly<{
      bytes: Uint8Array
      previewToken: string
      decisions: readonly ImportDecision[]
      humanMemberMappings: readonly HumanMemberMapping[]
      secretInputs: readonly PackageSecretInput[]
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

export interface ResourcePackageCompositionDependencies {
  readonly db: DbClient
  readonly appHome: string
  readonly box: SecretBox
  readonly pluginInstallOpts?: { pluginsDir?: string; npmBin?: string; timeoutMs?: number }
  readonly id?: () => string
}

export function composeResourcePackageOperations(
  deps: ResourcePackageCompositionDependencies,
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
    async inspect(_context: CommandContext, handle: string): Promise<string> {
      const input = take(handle)
      if (input.kind !== 'inspect') throw new Error('resource-package-staged-input-kind-mismatch')
      const pkg = await parseResourcePackage(input.bytes)
      const preview = await buildPackagePreview(deps.db, input.actor, pkg, {
        box: deps.box,
        importId: nextId(),
      })
      return JSON.stringify(preview)
    },
    async apply(context: CommandContext, handle: string): Promise<string> {
      const input = take(handle)
      if (input.kind !== 'apply') throw new Error('resource-package-staged-input-kind-mismatch')
      const pkg = await parseResourcePackage(input.bytes)
      const receipt = await commitResourcePackage(
        {
          db: deps.db,
          appHome: deps.appHome,
          box: deps.box,
          resourcePackageMutations: legacyResourcePackageMutationRuntimeFactory,
          currentAuthority: () => context.authority,
          ...(deps.pluginInstallOpts === undefined
            ? {}
            : { pluginInstallOpts: deps.pluginInstallOpts }),
        },
        input.actor,
        {
          pkg,
          previewToken: input.previewToken,
          decisions: [...input.decisions],
          humanMemberMappings: [...input.humanMemberMappings],
          secretInputs: [...input.secretInputs],
        },
      )
      return JSON.stringify(receipt)
    },
    async export(_context: CommandContext, handle: string) {
      const input = take(handle)
      if (input.kind !== 'export') throw new Error('resource-package-staged-input-kind-mismatch')
      const pkg = await exportResourcePackage(
        deps.db,
        input.actor,
        { type: input.root.kind, id: input.root.id },
        {
          appHome: deps.appHome,
          exportedAt: input.exportedAt,
          expect: { ...input.expect },
        },
      )
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
