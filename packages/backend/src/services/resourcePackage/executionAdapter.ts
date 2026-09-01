import { ulid } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import type { CommandContext } from '@/modules/identity-access/public/participants'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type { PackageResourceRef } from '@/modules/resource-catalog/public/types'
import { legacyResourcePackageMutationRuntimeFactory } from '@/services/bundle/legacyResourcePackageMutationDependencies'
import {
  commitResourcePackage,
  type CommitPackageDeps,
  type HumanMemberMapping,
  type ImportDecision,
} from '@/services/resourcePackage/commit'
import { exportResourcePackageFromReadPort } from '@/services/resourcePackage/export'
import { parseResourcePackage, type ParsedPackage } from '@/services/resourcePackage/parse'
import { buildPackagePreviewFromReadPort } from '@/services/resourcePackage/preview'
import type { PackageSecretInput } from '@/services/resourcePackage/secretInputs'

interface ResourcePackageExportFence {
  readonly expectedVersion?: number
  readonly expectedContentVersion?: number
  readonly expectedUpdatedAt?: number
  readonly expectedAclRevision?: number
  readonly expectedMetaRevision?: number
  readonly expectedConfigHash?: string
}

interface ResourcePackageInspectExecutionInput {
  readonly actor: Actor
  readonly bytes: Uint8Array
}

interface ResourcePackageApplyExecutionInput {
  readonly actor: Actor
  readonly bytes: Uint8Array
  readonly previewToken: string
  readonly decisions: readonly ImportDecision[]
  readonly humanMemberMappings: readonly HumanMemberMapping[]
  readonly secretInputs: readonly PackageSecretInput[]
}

interface ResourcePackageExportExecutionInput {
  readonly actor: Actor
  readonly root: PackageResourceRef
  readonly exportedAt: number
  readonly expect: ResourcePackageExportFence
}

/** Consumer-owned structural port implemented outside Resource Catalog. */
export interface ResourcePackageExecutionAdapter {
  inspect(context: CommandContext, input: ResourcePackageInspectExecutionInput): Promise<string>
  apply(context: CommandContext, input: ResourcePackageApplyExecutionInput): Promise<string>
  export(
    context: CommandContext,
    input: ResourcePackageExportExecutionInput,
  ): Promise<Readonly<{ zip: Uint8Array; filename: string }>>
}

interface ResourcePackageReadProvider {
  readonly reads: Parameters<typeof buildPackagePreviewFromReadPort>[0]
  readonly readSkillTree: Parameters<typeof exportResourcePackageFromReadPort>[1]
}

interface ResourcePackageExecutionAdapterDependencies {
  readonly box: SecretBox
  readonly provider: ResourcePackageReadProvider
  readonly id?: () => string
  apply(
    context: CommandContext,
    input: Parameters<ResourcePackageExecutionAdapter['apply']>[1],
    pkg: ParsedPackage,
  ): Promise<unknown>
}

function createResourcePackageExecutionAdapter(
  dependencies: ResourcePackageExecutionAdapterDependencies,
): ResourcePackageExecutionAdapter {
  const nextId = dependencies.id ?? ulid
  return Object.freeze({
    async inspect(
      _context: CommandContext,
      input: Parameters<ResourcePackageExecutionAdapter['inspect']>[1],
    ): Promise<string> {
      const pkg = await parseResourcePackage(input.bytes)
      const preview = await buildPackagePreviewFromReadPort(
        dependencies.provider.reads,
        input.actor,
        pkg,
        {
          box: dependencies.box,
          importId: nextId(),
        },
      )
      return JSON.stringify(preview)
    },
    async apply(
      context: CommandContext,
      input: Parameters<ResourcePackageExecutionAdapter['apply']>[1],
    ): Promise<string> {
      const pkg = await parseResourcePackage(input.bytes)
      return JSON.stringify(await dependencies.apply(context, input, pkg))
    },
    async export(
      _context: CommandContext,
      input: Parameters<ResourcePackageExecutionAdapter['export']>[1],
    ) {
      const exported = await exportResourcePackageFromReadPort(
        dependencies.provider.reads,
        dependencies.provider.readSkillTree,
        input.actor,
        { type: input.root.kind, id: input.root.id },
        {
          exportedAt: input.exportedAt,
          expect: { ...input.expect },
        },
      )
      return Object.freeze({ zip: exported.zip, filename: exported.filename })
    },
  })
}

export interface SqliteResourcePackageExecutionAdapterDependencies {
  readonly db: CommitPackageDeps['db']
  readonly appHome: string
  readonly box: SecretBox
  readonly provider: ResourcePackageReadProvider
  readonly id?: () => string
  readonly pluginInstallOpts?: {
    readonly pluginsDir?: string
    readonly npmBin?: string
    readonly timeoutMs?: number
  }
}

export function createSqliteResourcePackageExecutionAdapter(
  dependencies: SqliteResourcePackageExecutionAdapterDependencies,
): ResourcePackageExecutionAdapter {
  return createResourcePackageExecutionAdapter({
    box: dependencies.box,
    provider: dependencies.provider,
    ...(dependencies.id === undefined ? {} : { id: dependencies.id }),
    async apply(context, input, pkg) {
      return commitResourcePackage(
        {
          db: dependencies.db,
          appHome: dependencies.appHome,
          box: dependencies.box,
          resourcePackageMutations: legacyResourcePackageMutationRuntimeFactory,
          currentAuthority: () => context.authority,
          ...(dependencies.pluginInstallOpts === undefined
            ? {}
            : { pluginInstallOpts: dependencies.pluginInstallOpts }),
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
    },
  })
}

interface PostgresqlResourcePackageAtomicApplyInput<TMutationSessionFactory> {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
  readonly package: ParsedPackage
  readonly previewToken: string
  readonly decisions: readonly ImportDecision[]
  readonly humanMemberMappings: readonly HumanMemberMapping[]
  readonly secretInputs: readonly PackageSecretInput[]
  readonly mutationSessionFactory: TMutationSessionFactory
}

interface PostgresqlResourcePackageAtomicApply<TMutationSessionFactory> {
  apply(input: PostgresqlResourcePackageAtomicApplyInput<TMutationSessionFactory>): Promise<unknown>
}

export interface PostgresqlResourcePackageExecutionAdapterDependencies<TMutationSessionFactory> {
  readonly box: SecretBox
  readonly provider: ResourcePackageReadProvider & {
    readonly mutationSessionFactory: TMutationSessionFactory
  }
  readonly atomicApply: PostgresqlResourcePackageAtomicApply<TMutationSessionFactory>
  readonly id?: () => string
}

export function createPostgresqlResourcePackageExecutionAdapter<TMutationSessionFactory>(
  dependencies: PostgresqlResourcePackageExecutionAdapterDependencies<TMutationSessionFactory>,
): ResourcePackageExecutionAdapter {
  return createResourcePackageExecutionAdapter({
    box: dependencies.box,
    provider: dependencies.provider,
    ...(dependencies.id === undefined ? {} : { id: dependencies.id }),
    apply(context, input, pkg) {
      return dependencies.atomicApply.apply({
        authority: context.authority,
        actor: input.actor,
        package: pkg,
        previewToken: input.previewToken,
        decisions: input.decisions,
        humanMemberMappings: input.humanMemberMappings,
        secretInputs: input.secretInputs,
        mutationSessionFactory: dependencies.provider.mutationSessionFactory,
      })
    },
  })
}
