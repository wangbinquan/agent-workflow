// RFC-401 A2 —— MCP 的唯一写入参与者（design §9.3）。
//
// 普通 CRUD、Intent 与资源包都经这里写 MCP，全部 SQL 在调用方传入的事务上执行。规则与错误就是普通编辑此前的那一份
// （用户 2026-11-02 确认以它为准）：配置按类型校验（`mcp-config-invalid`）→ 名称冲突（`mcp-name-in-use`）；更新是
// fence（`resource-operation-stale`，带两份 configHash）→ 类型不可变（`mcp-type-immutable`）→ 配置校验 → 语义 no-op 不写 →
// 写入并在同一事务里记下运行时测试会话的失效意图。
//
// 此前 Intent 与资源包各有一份：stale / 类型不可变的措辞与 details 不同，更新从不判 no-op。

import { canonicalJson, type Mcp } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type { McpMutationParticipant } from '../application/ports/mcpMutation'
import { validateMcpConfigForType } from '../domain/mcps/mcpConfig'
import {
  insertMcpRowInTx,
  mcpConfigHash,
  mcpFromPersistenceRow,
  updateMcpRowInTx,
} from './mcpPersistence'
import type { McpTransactionLifecycle } from './mcpRepository'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'

function nameConflict(name: string): ConflictError {
  return new ConflictError('mcp-name-in-use', `mcp '${name}' already exists`)
}

/** owner + name 唯一冲突：PG 给约束名 `mcps_owner_name_unique`，SQLite 给列清单 `mcps.owner_user_id, …`。 */
function isOwnerNameConflict(transaction: ResourceCatalogTransaction, error: unknown): boolean {
  const target = engineOf(transaction).uniqueViolationTarget(error)
  return target !== undefined && /mcps[._](?:owner|name)/i.test(target)
}

export interface McpMutationParticipantDependencies {
  readonly lifecycle: McpTransactionLifecycle
  readonly now?: () => number
}

export function createMcpMutationParticipant(
  transaction: ResourceCatalogTransaction,
  dependencies: McpMutationParticipantDependencies,
): McpMutationParticipant {
  const now = dependencies.now ?? Date.now
  return Object.freeze<McpMutationParticipant>({
    async create(input) {
      // 与此前普通编辑相同：按类型校验，写入提交的配置。
      validateMcpConfigForType(input.input.type, input.input.config)
      const { mcps } = tablesOf(transaction)
      const collision = await first(
        transaction
          .select({ id: mcps.id })
          .from(mcps)
          .where(and(eq(mcps.ownerUserId, input.ownerUserId), eq(mcps.name, input.input.name))),
      )
      if (collision !== undefined) throw nameConflict(input.input.name)
      let created: Awaited<ReturnType<typeof insertMcpRowInTx>>
      try {
        created = await insertMcpRowInTx(transaction, {
          id: input.id,
          input: input.input,
          ownerUserId: input.ownerUserId,
          visibility: 'private',
          aclRevision: 0,
          now: now(),
        })
      } catch (error) {
        if (isOwnerNameConflict(transaction, error)) throw nameConflict(input.input.name)
        throw error
      }
      if (created.length !== 1) throw new Error('mcp insert did not return one row')
      return mcpFromPersistenceRow(created[0]!)
    },

    async update(input) {
      const { mcps } = tablesOf(transaction)
      const row = await first(transaction.select().from(mcps).where(eq(mcps.id, input.id)))
      if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
      const current = mcpFromPersistenceRow(row)
      input.guard?.(current)
      const currentConfigHash = mcpConfigHash(current)
      if (currentConfigHash !== input.expectedConfigHash) {
        throw staleConflictError('mcp', 'the MCP changed; reload before modifying it', {
          expectedConfigHash: input.expectedConfigHash,
          currentConfigHash,
        })
      }
      const patch = input.patch(current)
      if (patch.type !== undefined && patch.type !== current.type) {
        throw new ValidationError(
          'mcp-type-immutable',
          `mcp '${current.name}' type cannot change`,
          { currentType: current.type, requestedType: patch.type },
        )
      }
      const config =
        patch.config === undefined
          ? current.config
          : validateMcpConfigForType(current.type, patch.config)
      const description = patch.description ?? current.description
      const enabled = patch.enabled ?? current.enabled
      const configChanged = canonicalJson(config) !== canonicalJson(current.config)
      // RFC-201：语义 no-op 也观测一次因果时钟（普通编辑注入的时钟），与此前普通编辑相同。
      const updatedAt = await (input.nextUpdatedAt ?? ((mcp: Mcp) => monotonicNow(mcp.updatedAt)))(
        current,
      )
      if (!configChanged && description === current.description && enabled === current.enabled) {
        return current
      }
      const set: Partial<PersistenceTables['mcps']['$inferInsert']> = { updatedAt }
      if (description !== current.description) set.description = description
      if (enabled !== current.enabled) set.enabled = enabled
      if (configChanged) set.config = JSON.stringify(config)
      const updated = await updateMcpRowInTx(transaction, { kind: 'captured-row', row }, set)
      if (updated.length !== 1) {
        throw staleConflictError('mcp', 'the MCP changed while saving; reload and retry')
      }
      await dependencies.lifecycle.transitionMutation(transaction, {
        mcpId: current.id,
        reason: enabled ? 'mcp-config-changed' : 'mcp-disabled',
        now: updatedAt,
      })
      return mcpFromPersistenceRow(updated[0]!)
    },
  })
}
