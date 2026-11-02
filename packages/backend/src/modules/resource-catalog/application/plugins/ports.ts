import type { PluginInstallation, PluginPatch } from '../ports/pluginMutation'
import type { Plugin, PluginSourceKind, PluginUpdateCheck } from '@agent-workflow/shared'
import type { PluginOperationContext } from '../../public/participants'
import type { PluginCatalogResource } from '../../public/types'

export interface PluginAgentReference {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export interface PluginCreateRecord {
  readonly id: string
  readonly name: string
  readonly spec: string
  readonly options: Readonly<Record<string, unknown>>
  readonly description: string
  readonly enabled: boolean
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  readonly ownerUserId: string
  readonly visibility: 'private'
  readonly aclRevision: 0
  readonly now: number
}

export interface PluginRepository {
  list(): Promise<Plugin[]>
  get(id: string): Promise<Plugin | null>
  assertNameAvailable(input: {
    readonly purpose: 'create' | 'rename'
    readonly ownerUserId: string | null
    readonly name: string
    readonly excludeId?: string
  }): Promise<void>
  create(record: PluginCreateRecord): Promise<Plugin>
  /**
   * RFC-401 A2：stale、选项校验、no-op 与整行 CAS 发布都在唯一的 plugin 写入参与者里（同一事务）。`installation` 是事务前
   * 完成的新安装（规格改变或显式 upgrade），`null` 沿用当前安装。
   */
  publish(input: {
    readonly id: string
    readonly expectedConfigHash: string
    readonly patch: PluginPatch
    readonly installation: PluginInstallation | null
    readonly nextUpdatedAt: (current: Plugin) => number
    readonly nextInstalledAt: (current: Plugin) => number
  }): Promise<Plugin>
  rename(input: {
    readonly id: string
    readonly newName: string
    readonly expectedConfigHash: string
    readonly updatedAt: number
  }): Promise<Plugin>
  findAgentReferences(id: string): Promise<readonly PluginAgentReference[]>
  delete(input: {
    readonly id: string
    readonly expectedConfigHash: string
  }): Promise<readonly PluginAgentReference[]>
}

export interface PluginProjection {
  configHashOf(plugin: Plugin): string
  resourceOf(plugin: Plugin): PluginCatalogResource
}

export interface PluginAccessPort {
  filterVisible(
    authority: PluginOperationContext,
    rows: readonly Plugin[],
  ): Promise<readonly Plugin[]>
  canView(authority: PluginOperationContext, row: Plugin): Promise<boolean>
  requireResourceEdit(authority: PluginOperationContext, row: Plugin): Promise<void>
  requireResourceGovern(authority: PluginOperationContext, row: Plugin): Promise<void>
  discloseAgentReferences(
    authority: PluginOperationContext,
    references: readonly PluginAgentReference[],
  ): Promise<{
    readonly visible: ReadonlyArray<{ readonly id: string; readonly name: string }>
    readonly hiddenCount: number
  }>
}

export interface PluginOperationCoordinatorPort {
  runExclusive<T>(resourceId: string, task: () => Promise<T>): Promise<T>
  runDeduplicatedOperation<T>(
    resourceId: string,
    operationConfigHash: string,
    operation: () => Promise<T>,
  ): Promise<T>
}

export interface PluginInstallArtifact {
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  cleanup(): Promise<void>
}

export interface PluginInstallerPort {
  install(pluginId: string, spec: string): Promise<PluginInstallArtifact>
  checkForUpdate(
    pluginId: string,
    spec: string,
    currentCachedPath: string,
  ): Promise<PluginUpdateCheckWithoutFence>
}

export type PluginUpdateCheckWithoutFence = Pick<
  PluginUpdateCheck,
  'available' | 'latest' | 'identityStatus'
>

export interface PluginMutationClock {
  nextUpdatedAt(plugin: Plugin): number
  nextInstalledAt(plugin: Plugin): number
}
