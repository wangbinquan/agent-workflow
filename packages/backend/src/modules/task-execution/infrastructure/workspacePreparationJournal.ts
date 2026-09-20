import { and, eq, isNull, inArray } from 'drizzle-orm'
import { taskWorkspacePreparations } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { ConflictError } from '@/util/errors'
import type {
  WorkspacePreparationJournal,
  WorkspacePreparationState,
} from '../application/ports/workspacePreparationJournal'

const next: Readonly<Record<WorkspacePreparationState, readonly WorkspacePreparationState[]>> = {
  preparing: ['prepared', 'compensating', 'failed'],
  prepared: ['admitted', 'compensating'],
  admitted: [],
  compensating: ['cleaned', 'failed'],
  cleaned: [],
  failed: ['compensating'],
}

/** Admission passes its existing live transaction; this journal never inserts a Task. */
export function createWorkspacePreparationJournal(
  db: ProviderNeutralDatabase,
): WorkspacePreparationJournal {
  return {
    async read(id) {
      return (
        (
          await db
            .select()
            .from(taskWorkspacePreparations)
            .where(eq(taskWorkspacePreparations.id, id))
        )[0] ?? null
      )
    },
    async forTask(taskId) {
      return (
        (
          await db
            .select()
            .from(taskWorkspacePreparations)
            .where(eq(taskWorkspacePreparations.admittedTaskId, taskId))
        )[0] ?? null
      )
    },
    async bindTask(input) {
      const rows = await db
        .update(taskWorkspacePreparations)
        .set({
          admittedTaskId: input.taskId,
          version: input.expectedVersion + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskWorkspacePreparations.id, input.id),
            eq(taskWorkspacePreparations.version, input.expectedVersion),
            eq(taskWorkspacePreparations.ownerFence, input.ownerFence),
            eq(taskWorkspacePreparations.lane, 'repository-preparation'),
            eq(taskWorkspacePreparations.state, 'preparing'),
            isNull(taskWorkspacePreparations.admittedTaskId),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
    async adoptOwner(input) {
      if (input.ownerFence < input.previousFence) return null
      const rows = await db
        .update(taskWorkspacePreparations)
        .set({
          ownerFence: input.ownerFence,
          version: input.expectedVersion + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskWorkspacePreparations.id, input.id),
            eq(taskWorkspacePreparations.version, input.expectedVersion),
            eq(taskWorkspacePreparations.ownerFence, input.previousFence),
            inArray(taskWorkspacePreparations.state, [
              'preparing',
              'prepared',
              'compensating',
              'failed',
            ]),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
    async replaceOperation(input) {
      const rows = await db
        .update(taskWorkspacePreparations)
        .set({
          operationRef: input.operationRef,
          state: 'preparing',
          artifactJson: null,
          version: input.expectedVersion + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskWorkspacePreparations.id, input.id),
            eq(taskWorkspacePreparations.version, input.expectedVersion),
            eq(taskWorkspacePreparations.ownerFence, input.ownerFence),
            eq(taskWorkspacePreparations.operationRef, input.previousOperationRef),
            inArray(taskWorkspacePreparations.state, ['preparing', 'prepared']),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
    async prepare(input) {
      const { now, ...identity } = input
      await db
        .insert(taskWorkspacePreparations)
        .values({ ...identity, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
      const row = (
        await db
          .select()
          .from(taskWorkspacePreparations)
          .where(eq(taskWorkspacePreparations.admissionKey, input.admissionKey))
      )[0]
      if (
        !row ||
        row.requestDigest !== input.requestDigest ||
        row.lane !== input.lane ||
        row.operationRef !== input.operationRef ||
        row.ownerFence !== input.ownerFence
      )
        throw new ConflictError(
          'workspace-preparation-request-mismatch',
          'workspace preparation request changed',
        )
      return row
    },
    async checkpointUploadPlan(input) {
      const current = (
        await db
          .select()
          .from(taskWorkspacePreparations)
          .where(eq(taskWorkspacePreparations.id, input.id))
      )[0]
      if (
        current === undefined ||
        current.artifactJson === null ||
        current.state !== 'prepared' ||
        current.admittedTaskId !== null
      )
        return null
      const artifact = JSON.parse(current.artifactJson) as Record<string, unknown>
      if (artifact.uploads !== undefined) return null
      const rows = await db
        .update(taskWorkspacePreparations)
        .set({
          artifactJson: JSON.stringify({
            ...artifact,
            uploadPlan: { requestDigest: input.requestDigest, placements: input.placements },
          }),
          version: input.expectedVersion + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskWorkspacePreparations.id, input.id),
            eq(taskWorkspacePreparations.version, input.expectedVersion),
            eq(taskWorkspacePreparations.ownerFence, input.ownerFence),
            eq(taskWorkspacePreparations.state, 'prepared'),
            eq(taskWorkspacePreparations.lane, 'pre-materialized'),
            isNull(taskWorkspacePreparations.admittedTaskId),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
    async completeUploads(input) {
      const current = (
        await db
          .select()
          .from(taskWorkspacePreparations)
          .where(eq(taskWorkspacePreparations.id, input.id))
      )[0]
      if (
        current === undefined ||
        current.artifactJson === null ||
        current.state !== 'prepared' ||
        current.admittedTaskId !== null
      )
        return null
      const artifact = JSON.parse(current.artifactJson) as Record<string, unknown>
      if (artifact.uploads !== undefined) return null
      const rows = await db
        .update(taskWorkspacePreparations)
        .set({
          artifactJson: JSON.stringify({
            ...artifact,
            uploads: { requestDigest: input.requestDigest, packedByKey: input.packedByKey },
          }),
          version: input.expectedVersion + 1,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskWorkspacePreparations.id, input.id),
            eq(taskWorkspacePreparations.version, input.expectedVersion),
            eq(taskWorkspacePreparations.ownerFence, input.ownerFence),
            eq(taskWorkspacePreparations.state, 'prepared'),
            eq(taskWorkspacePreparations.lane, 'pre-materialized'),
            isNull(taskWorkspacePreparations.admittedTaskId),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
    async advance(input) {
      if (!next[input.from].includes(input.to))
        throw new ConflictError(
          'workspace-preparation-transition-invalid',
          'invalid workspace preparation transition',
        )
      if (input.to === 'prepared' && input.artifactJson === undefined)
        throw new ConflictError(
          'workspace-preparation-artifact-missing',
          'prepared workspace requires an artifact',
        )
      if (input.to === 'admitted' && input.admittedTaskId === undefined)
        throw new ConflictError(
          'workspace-preparation-task-missing',
          'admission requires a Task binding',
        )
      if (
        (input.artifactJson !== undefined && input.to !== 'prepared') ||
        (input.admittedTaskId !== undefined && input.to !== 'admitted')
      )
        throw new ConflictError(
          'workspace-preparation-facts-immutable',
          'workspace preparation facts cannot be replaced',
        )
      const rows = await db
        .update(taskWorkspacePreparations)
        .set({
          state: input.to,
          version: input.expectedVersion + 1,
          updatedAt: input.now,
          ...(input.artifactJson === undefined ? {} : { artifactJson: input.artifactJson }),
          ...(input.admittedTaskId === undefined ? {} : { admittedTaskId: input.admittedTaskId }),
        })
        .where(
          and(
            eq(taskWorkspacePreparations.id, input.id),
            eq(taskWorkspacePreparations.version, input.expectedVersion),
            eq(taskWorkspacePreparations.ownerFence, input.ownerFence),
            eq(taskWorkspacePreparations.state, input.from),
          ),
        )
        .returning()
      return rows[0] ?? null
    },
  }
}
