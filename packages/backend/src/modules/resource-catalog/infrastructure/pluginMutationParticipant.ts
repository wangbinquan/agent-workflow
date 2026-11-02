// RFC-401 A2 —— plugin 的唯一写入参与者（design §9.3）。
//
// 普通 CRUD、Intent 与资源包都经这里写 plugin 行，全部 SQL 在调用方传入的事务上执行。规则与错误就是普通编辑此前的那一份：
// 创建先查名称冲突（`plugin-name-in-use`）再插入；更新是 fence（`resource-operation-stale`，带两份 configHash）→ 选项校验 →
// 语义 no-op 不写 → 以整行 CAS 发布。安装是事务外的效果：规格不变不重装、installedAt 不动（proposal §5 第 10 项），
// 规格改变或显式 upgrade 才带新安装进来。
//
// 此前资源包每次覆盖都重新安装并推进 installedAt；Intent 与资源包的 stale 措辞不同、更新从不判 no-op。

import { PluginOptionsSchema, type Plugin } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type { PluginMutationParticipant } from '../application/ports/pluginMutation'
import {
  insertPluginRowInTx,
  pluginConfigHash,
  pluginFromPersistenceRow,
  publishPluginRowInTx,
} from './pluginPersistence'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'

function nameConflict(name: string): ConflictError {
  return new ConflictError('plugin-name-in-use', `plugin '${name}' already exists`)
}

/** owner + name 唯一冲突：PG 给约束名 `plugins_owner_name_unique`，SQLite 给列清单 `plugins.owner_user_id, …`。 */
function isOwnerNameConflict(transaction: ResourceCatalogTransaction, error: unknown): boolean {
  const target = engineOf(transaction).uniqueViolationTarget(error)
  return target !== undefined && /plugins[._](?:owner|name)/i.test(target)
}

export interface PluginMutationParticipantDependencies {
  readonly now?: () => number
}

export function createPluginMutationParticipant(
  transaction: ResourceCatalogTransaction,
  dependencies: PluginMutationParticipantDependencies = {},
): PluginMutationParticipant {
  const now = dependencies.now ?? Date.now
  return Object.freeze<PluginMutationParticipant>({
    async create(input) {
      const options = PluginOptionsSchema.parse(input.input.options)
      const { plugins } = tablesOf(transaction)
      const collision = await first(
        transaction
          .select({ id: plugins.id })
          .from(plugins)
          .where(
            and(eq(plugins.ownerUserId, input.ownerUserId), eq(plugins.name, input.input.name)),
          ),
      )
      if (collision !== undefined) throw nameConflict(input.input.name)
      let created: Awaited<ReturnType<typeof insertPluginRowInTx>>
      try {
        created = await insertPluginRowInTx(transaction, {
          id: input.id,
          name: input.input.name,
          spec: input.input.spec,
          options,
          description: input.input.description,
          enabled: input.input.enabled,
          sourceKind: input.installation.sourceKind,
          cachedPath: input.installation.cachedPath,
          resolvedVersion: input.installation.resolvedVersion,
          ownerUserId: input.ownerUserId,
          visibility: 'private',
          aclRevision: 0,
          now: now(),
        })
      } catch (error) {
        if (isOwnerNameConflict(transaction, error)) throw nameConflict(input.input.name)
        throw error
      }
      if (created.length !== 1) throw new Error('plugin insert did not return one row')
      return pluginFromPersistenceRow(created[0]!)
    },

    async update(input) {
      const { plugins } = tablesOf(transaction)
      const row = await first(transaction.select().from(plugins).where(eq(plugins.id, input.id)))
      if (row === undefined) {
        throw new NotFoundError('plugin-not-found', `plugin '${input.id}' not found`)
      }
      const current = pluginFromPersistenceRow(row)
      input.guard?.(current)
      const currentConfigHash = pluginConfigHash(current)
      if (currentConfigHash !== input.expectedConfigHash) {
        throw staleConflictError(
          'plugin',
          'plugin changed since this operation was prepared; reload and retry',
          { expectedConfigHash: input.expectedConfigHash, currentConfigHash },
        )
      }
      const patch = input.patch(current)
      const options =
        patch.options === undefined ? current.options : PluginOptionsSchema.parse(patch.options)
      const spec = patch.spec ?? current.spec
      const description = patch.description ?? current.description
      const enabled = patch.enabled ?? current.enabled
      const installation = input.installation
      if (spec !== current.spec && installation === null) {
        throw new Error('plugin-installation-required-for-spec-change')
      }
      const changed =
        installation !== null ||
        spec !== current.spec ||
        JSON.stringify(options) !== JSON.stringify(current.options) ||
        description !== current.description ||
        enabled !== current.enabled
      if (!changed) return current
      const [updated] = await publishPluginRowInTx(transaction, row, {
        spec,
        optionsJson: JSON.stringify(options),
        description,
        enabled,
        sourceKind: installation?.sourceKind ?? current.sourceKind,
        cachedPath: installation?.cachedPath ?? current.cachedPath,
        resolvedVersion:
          installation === null ? current.resolvedVersion : installation.resolvedVersion,
        installedAt:
          installation === null
            ? current.installedAt
            : (input.nextInstalledAt ?? ((plugin: Plugin) => monotonicNow(plugin.installedAt)))(
                current,
              ),
        updatedAt: (input.nextUpdatedAt ?? ((plugin: Plugin) => monotonicNow(plugin.updatedAt)))(
          current,
        ),
      })
      if (updated === undefined) {
        throw staleConflictError('plugin', 'plugin changed during generation publication')
      }
      return pluginFromPersistenceRow(updated)
    },
  })
}
