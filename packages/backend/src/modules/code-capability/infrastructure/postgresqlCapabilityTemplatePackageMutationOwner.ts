import { eq } from 'drizzle-orm'

import { capabilityTemplates } from '@/db/schema'
import { prepareCapabilityTemplatePackageWrite } from '../application/capabilityTemplateOperations'
import type { CapabilityTemplateRecord } from '../application/ports/capabilityTemplatePersistence'
import { createPostgresqlCapabilityTemplatePersistence } from './postgresqlCapabilityTemplatePersistence'
import { createPostgresqlCapabilityTemplatePackageCommit } from './capabilityTemplatePackageCommit'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { PostgresqlCapabilityTemplatePackageMutationOwner } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { PostgresqlResourceCatalogTransaction } from '@/modules/resource-catalog/infrastructure/postgresql/repositorySupport'
import { ValidationError } from '@/util/errors'

type CapabilityTemplateOwnerPrepareContext = Parameters<
  PostgresqlCapabilityTemplatePackageMutationOwner['prepareOwnerNative']
>[0]
type CapabilityTemplateOwnerPrepareRequest = Parameters<
  PostgresqlCapabilityTemplatePackageMutationOwner['prepareOwnerNative']
>[1]
type CapabilityTemplateOwnerCommitContext = Parameters<
  PostgresqlCapabilityTemplatePackageMutationOwner['commitOwnerNativeInTransaction']
>[1]
type CapabilityTemplateOwnerCommitRequest = Parameters<
  PostgresqlCapabilityTemplatePackageMutationOwner['commitOwnerNativeInTransaction']
>[2]

async function ownerNameExists(
  transaction: PostgresqlResourceCatalogTransaction,
  input: {
    readonly ownerUserId: string | null
    readonly name: string
    readonly excludeId: string | null
  },
): Promise<boolean> {
  const rows = await transaction
    .select({ id: capabilityTemplates.id, ownerUserId: capabilityTemplates.ownerUserId })
    .from(capabilityTemplates)
    .where(eq(capabilityTemplates.name, input.name))
    .all()
  return rows.some((row) => row.ownerUserId === input.ownerUserId && row.id !== input.excludeId)
}

/**
 * Code Capability's owner-native arm for the PostgreSQL ResourcePackage
 * transaction. Preparation freezes the existing owner row; final payload
 * normalization, privilege checks, uniqueness and the write all execute
 * against the aggregate's reserved transaction.
 */
export function createPostgresqlCapabilityTemplatePackageMutationOwner(input: {
  readonly db: PostgresqlDatabaseClient
  readonly now?: () => number
}): PostgresqlCapabilityTemplatePackageMutationOwner {
  const persistence = createPostgresqlCapabilityTemplatePersistence(input.db)
  const now = input.now ?? Date.now
  const preparedStates = new WeakMap<object, CapabilityTemplateRecord | null>()
  return Object.freeze({
    async prepareOwnerNative(
      _context: CapabilityTemplateOwnerPrepareContext,
      request: CapabilityTemplateOwnerPrepareRequest,
    ) {
      const update = request.mutation.kind.endsWith('-update')
      const existing = update ? await persistence.load(request.resourceId) : null
      if (update && existing === null) {
        throw new ValidationError(
          'capability-template-not-found',
          `template '${request.resourceId}' no longer exists`,
        )
      }
      const token = Object.freeze({ kind: 'capability-template-package-owner-state' as const })
      preparedStates.set(token, existing)
      return token
    },
    async commitOwnerNativeInTransaction(
      transaction: PostgresqlResourceCatalogTransaction,
      context: CapabilityTemplateOwnerCommitContext,
      request: CapabilityTemplateOwnerCommitRequest,
    ) {
      if (typeof request.prepared !== 'object' || request.prepared === null) {
        throw new Error('capability-template-package-owner-state-invalid')
      }
      const existing = preparedStates.get(request.prepared)
      if (!preparedStates.has(request.prepared)) {
        throw new Error('capability-template-package-owner-state-invalid')
      }
      const prepared = await prepareCapabilityTemplatePackageWrite({
        actor: context.actor,
        raw: request.payload,
        resourceId: request.resourceId,
        existing: existing ?? null,
        nameExists: (candidate) => ownerNameExists(transaction, candidate),
        now: now(),
      })
      await createPostgresqlCapabilityTemplatePackageCommit(transaction).commit(prepared)
    },
  })
}
