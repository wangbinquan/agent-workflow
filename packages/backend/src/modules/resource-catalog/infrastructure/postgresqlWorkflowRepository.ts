import {
  WorkflowDraftSnapshotSchema,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  type CopyWorkflowRequest,
  type CreateWorkflow,
  type DeleteWorkflow,
  type SaveWorkflowReceipt,
  type UpdateWorkflow,
  type Workflow,
  type WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { workflows } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { NotFoundError, staleConflictError } from '@/util/errors'
import type { WorkflowAclIdentity, WorkflowRepository } from '../application/workflows/ports'
import type { WorkflowOperationContext } from '../public/participants'
import {
  createWorkflowPersistenceValues,
  workflowDetailOf,
  workflowDraftSnapshotOf,
  workflowFromPersistenceRow,
  workflowRevisionOf,
} from './workflowPersistence'
import {
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

export interface PostgresqlWorkflowPersistenceSemantics {
  canonicalizeCreate(
    authority: WorkflowOperationContext,
    input: CreateWorkflow,
    id: string,
  ): Promise<CreateWorkflow>
  assertCreateInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    candidate: CreateWorkflow,
  ): Promise<void>
  copyNameAndAssertInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    source: Workflow,
  ): Promise<string>
  canonicalizeUpdate(
    authority: WorkflowOperationContext,
    current: Workflow,
    input: UpdateWorkflow,
  ): Promise<WorkflowDraftSnapshot>
  assertUpdateInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    current: Workflow,
    candidate: WorkflowDraftSnapshot,
  ): Promise<void>
  assertDeleteInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    authority: WorkflowOperationContext,
    current: Workflow,
  ): Promise<void>
  created?(workflow: Workflow): Promise<void> | void
  updated?(receipt: SaveWorkflowReceipt): Promise<void> | void
  deleted?(id: string, version: number, input: DeleteWorkflow): Promise<void> | void
}

function notFound(id: string): NotFoundError {
  return new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
}

function stale(id: string, current: Workflow) {
  return staleConflictError('workflow', `workflow '${id}' changed; reload`, {
    current: workflowRevisionOf(current),
  })
}

function aclIdentity(row: typeof workflows.$inferSelect): WorkflowAclIdentity {
  return Object.freeze({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId ?? null,
    visibility: row.visibility ?? 'public',
    builtin: row.builtin === true,
  })
}

export function createPostgresqlWorkflowRepository(input: {
  readonly db: PostgresqlDatabaseClient
  readonly semantics: PostgresqlWorkflowPersistenceSemantics
  readonly id?: () => string
  readonly now?: () => number
}): WorkflowRepository {
  const mintId = input.id ?? ulid
  const now = input.now ?? Date.now

  async function get(id: string) {
    const row = await input.db.select().from(workflows).where(eq(workflows.id, id)).limit(1).get()
    return row === undefined ? null : workflowDetailOf(workflowFromPersistenceRow(row))
  }

  const repository: WorkflowRepository = {
    async list() {
      return (await input.db.select().from(workflows).all()).map(workflowFromPersistenceRow)
    },
    get,
    async getAclIdentity(id) {
      const row = await input.db.select().from(workflows).where(eq(workflows.id, id)).limit(1).get()
      return row === undefined ? null : aclIdentity(row)
    },
    async create(authority, submitted) {
      const id = mintId()
      const canonical = await input.semantics.canonicalizeCreate(authority, submitted, id)
      const values = createWorkflowPersistenceValues({
        id,
        workflow: canonical,
        ownerUserId: authority.user.id,
        now: now(),
      })
      const created = await runPostgresqlResourceCatalogTransaction(
        input.db,
        async (transaction) => {
          await input.semantics.assertCreateInTransaction(transaction, authority, canonical)
          const row = await transaction.insert(workflows).values(values).returning().get()
          if (row === undefined) throw new Error('workflow insert returned no row')
          return workflowFromPersistenceRow(row)
        },
      )
      await input.semantics.created?.(created)
      return workflowDetailOf(created)
    },
    async copy(authority, id, copy: CopyWorkflowRequest) {
      const created = await runPostgresqlResourceCatalogTransaction(
        input.db,
        async (transaction) => {
          const sourceRow = await transaction
            .select()
            .from(workflows)
            .where(eq(workflows.id, id))
            .get()
          if (sourceRow === undefined) throw notFound(id)
          const source = workflowFromPersistenceRow(sourceRow)
          const revision = workflowRevisionOf(source)
          if (
            revision.version !== copy.expectedVersion ||
            revision.snapshotHash !== copy.expectedSnapshotHash
          ) {
            throw stale(id, source)
          }
          const name = await input.semantics.copyNameAndAssertInTransaction(
            transaction,
            authority,
            source,
          )
          const values = createWorkflowPersistenceValues({
            id: mintId(),
            workflow: {
              name,
              description: source.description,
              definition: source.definition,
            },
            ownerUserId: authority.user.id,
            now: now(),
          })
          const row = await transaction.insert(workflows).values(values).returning().get()
          if (row === undefined) throw new Error('workflow copy insert returned no row')
          return workflowFromPersistenceRow(row)
        },
      )
      await input.semantics.created?.(created)
      return workflowDetailOf(created)
    },
    async update(authority, id, submitted) {
      const before = await get(id)
      if (before === null) throw notFound(id)
      const candidate = WorkflowDraftSnapshotSchema.parse(
        await input.semantics.canonicalizeUpdate(authority, before, submitted),
      )
      const candidateBytes = serializeWorkflowEditableSnapshotV1(candidate)
      const definition = serializeWorkflowDefinitionStorageV1(candidate.definition)
      const result = await runPostgresqlResourceCatalogTransaction(
        input.db,
        async (transaction): Promise<{ receipt: SaveWorkflowReceipt; committed: boolean }> => {
          const row = await transaction.select().from(workflows).where(eq(workflows.id, id)).get()
          if (row === undefined) throw notFound(id)
          const current = workflowFromPersistenceRow(row)
          await input.semantics.assertUpdateInTransaction(
            transaction,
            authority,
            current,
            candidate,
          )
          const currentSnapshot = workflowDraftSnapshotOf(current)
          const logicalSame =
            serializeWorkflowEditableSnapshotV1(currentSnapshot) === candidateBytes
          const currentRevision = workflowRevisionOf(current)
          if (current.version !== submitted.expectedVersion) {
            if (!logicalSame) throw stale(id, current)
            return {
              receipt: {
                clientMutationId: submitted.clientMutationId,
                requestedBaseVersion: submitted.expectedVersion,
                revision: currentRevision,
                snapshot: candidate,
                outcome: 'already-current',
              },
              committed: false,
            }
          }
          if (logicalSame && row.definition === definition) {
            return {
              receipt: {
                clientMutationId: submitted.clientMutationId,
                requestedBaseVersion: submitted.expectedVersion,
                revision: currentRevision,
                snapshot: candidate,
                outcome: 'already-current',
              },
              committed: false,
            }
          }
          const changed = await transaction
            .update(workflows)
            .set({
              name: candidate.name,
              description: candidate.description,
              definition,
              version: current.version + 1,
              updatedAt: now(),
            })
            .where(and(eq(workflows.id, id), eq(workflows.version, submitted.expectedVersion)))
            .returning()
            .get()
          if (changed === undefined) throw stale(id, current)
          const committed = workflowFromPersistenceRow(changed)
          return {
            receipt: {
              clientMutationId: submitted.clientMutationId,
              requestedBaseVersion: submitted.expectedVersion,
              revision: workflowRevisionOf(committed),
              snapshot: candidate,
              outcome: 'committed',
            },
            committed: true,
          }
        },
      )
      if (result.committed) await input.semantics.updated?.(result.receipt)
      return result.receipt
    },
    async delete(authority, id, deletion) {
      const deletedVersion = await runPostgresqlResourceCatalogTransaction(
        input.db,
        async (transaction) => {
          const row = await transaction.select().from(workflows).where(eq(workflows.id, id)).get()
          if (row === undefined) throw notFound(id)
          const current = workflowFromPersistenceRow(row)
          if (current.version !== deletion.expectedVersion) throw stale(id, current)
          await input.semantics.assertDeleteInTransaction(transaction, authority, current)
          const removed = await transaction
            .delete(workflows)
            .where(and(eq(workflows.id, id), eq(workflows.version, deletion.expectedVersion)))
            .returning({ version: workflows.version })
            .get()
          if (removed === undefined) throw stale(id, current)
          return removed.version
        },
      )
      await input.semantics.deleted?.(id, deletedVersion, deletion)
    },
  }
  return Object.freeze(repository)
}
