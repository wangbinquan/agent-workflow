// RFC-401 A2 —— plugin 的唯一写入参与者合同（design §9.3）。
//
// 普通 CRUD、Intent 与资源包都经它写 plugin 行：选项校验、stale、语义 no-op、安装产物的发布与名称冲突只有一份实现。
// 安装（下载、复制到插件目录）是事务外的效果，由场景在事务前完成并把结果交进来；规格不变不重装（proposal §5 第 10 项），
// 重新解析版本由显式 upgrade 表达。

import type { Plugin } from '@agent-workflow/shared'

/** 一次安装的产物；写入时随行发布并推进 installedAt。 */
export interface PluginInstallation {
  readonly sourceKind: Plugin['sourceKind']
  readonly cachedPath: string
  readonly resolvedVersion: string | null
}

export interface PluginCreateMutation {
  readonly id: string
  readonly ownerUserId: string
  readonly input: Readonly<{
    name: string
    spec: string
    options: Readonly<Record<string, unknown>>
    description: string
    enabled: boolean
  }>
  readonly installation: PluginInstallation
}

export interface PluginPatch {
  readonly spec?: string
  readonly options?: unknown
  readonly description?: string
  readonly enabled?: boolean
}

export interface PluginUpdateMutation {
  readonly id: string
  readonly expectedConfigHash: string
  readonly guard?: (current: Plugin) => void
  readonly patch: (current: Plugin) => PluginPatch
  /**
   * 规格改变时（或显式 upgrade）事务前完成的新安装；`null` 沿用当前安装。规格改变却没有新安装是调用方的编程错误。
   */
  readonly installation: PluginInstallation | null
  readonly nextUpdatedAt?: (current: Plugin) => number
  readonly nextInstalledAt?: (current: Plugin) => number
}

/** 绑定在调用方事务上的 plugin 写入；全部 SQL 在该事务上执行。 */
export interface PluginMutationParticipant {
  create(input: PluginCreateMutation): Promise<Plugin>
  update(input: PluginUpdateMutation): Promise<Plugin>
}
