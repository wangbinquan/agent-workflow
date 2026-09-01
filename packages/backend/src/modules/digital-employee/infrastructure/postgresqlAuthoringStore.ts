// RFC-349 — real asynchronous PostgreSQL persistence for Digital Employee authoring.

import { and, eq, isNull, sql } from 'drizzle-orm'

import {
  employeeDefinitionRevisions,
  employeeDefinitions,
  employeeExecutionPolicyRevisions,
  employeeJobTemplateRevisions,
  employeeJobTemplates,
  employeeOsSettings,
  employeeToolRegistrationRevisions,
  employeeToolRegistrations,
  employeeTypePackages,
  employeeWorkScopeRevisions,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  DigitalEmployeeAuthoringPersistence,
  EmployeeDefinitionRecord,
  EmployeeDefinitionRevisionRecord,
  JobTemplateRecord,
  JobTemplateRevisionRecord,
  ToolDraftRecord,
  ToolRevisionRecord,
  TypePackageRecord,
  TypePackageRegistrationRecord,
} from '../application/ports/authoringStore'
import {
  digitalEmployeeDefinitionContentSchema,
  digitalEmployeeDefinitionDraftSchema,
  employeeJobTemplateContentSchema,
  globalExecutionPolicySchema,
  parsePersistedEmployeeTypePackageDescriptor,
  toolRegistrationContentSchema,
  toolValidationReceiptSchema,
  type EmployeeTypeRef,
} from '../domain/model'

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

function uniqueError(error: unknown, code: string, message: string): never {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.toLowerCase().includes('unique')) throw new ConflictError(code, message)
  throw error
}

function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest
}

function typePackageDriftMessage(
  typeId: string,
  revision: number,
  registeredDigest: string,
  currentDigest: string,
): string {
  return [
    `employee type package ${typeId}@${revision} changed without a revision bump ` +
      `(registered digest ${shortDigest(registeredDigest)}, current build ${shortDigest(currentDigest)}).`,
    'a registered type revision is immutable — publish the edited descriptor by bumping typeRef.revision,',
    'or, when the registered row is a stale local registration with no dependents, drop it and restart:',
    `  DELETE FROM employee_type_packages WHERE type_id = '${typeId}' AND revision = ${revision};`,
    '  (the daemon DB path is logged at boot as `db ready path=…`)',
  ].join('\n')
}

function typeWhere(ref: EmployeeTypeRef) {
  return and(
    eq(employeeTypePackages.typeId, ref.typeId),
    eq(employeeTypePackages.revision, ref.revision),
  )
}

function compareTypeRefs(left: EmployeeTypeRef, right: EmployeeTypeRef): number {
  const byType = left.typeId.localeCompare(right.typeId)
  return byType === 0 ? right.revision - left.revision : byType
}

function toTypePackageRegistration(row: {
  readonly typeId: string
  readonly revision: number
  readonly descriptorDigest: string
  readonly state: 'published' | 'retired'
  readonly registeredAt: number
}): TypePackageRegistrationRecord {
  return {
    typeRef: { typeId: row.typeId, revision: row.revision },
    descriptorDigest: row.descriptorDigest,
    state: row.state,
    registeredAt: row.registeredAt,
  }
}

function toTypePackage(row: typeof employeeTypePackages.$inferSelect): TypePackageRecord {
  return {
    descriptor: parsePersistedEmployeeTypePackageDescriptor(parseJson(row.descriptorJson)),
    descriptorDigest: row.descriptorDigest,
    state: row.state,
    registeredAt: row.registeredAt,
  }
}

function toTool(row: typeof employeeToolRegistrations.$inferSelect): ToolDraftRecord {
  const draft = zRecord(row.draftJson)
  return {
    id: row.id,
    typeRef: { typeId: row.typeId, revision: row.typeRevision },
    workItemRef: row.workItemRef,
    content: toolRegistrationContentSchema.parse(draft.content),
    validationReceipt: toolValidationReceiptSchema.parse(draft.validationReceipt),
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    retiredAt: row.retiredAt,
  }
}

function zRecord(text: string): Record<string, unknown> {
  const value = parseJson(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('persisted digital employee JSON is not an object')
  }
  return Object.fromEntries(Object.entries(value))
}

function toToolRevision(
  row: typeof employeeToolRegistrationRevisions.$inferSelect,
): ToolRevisionRecord {
  return {
    ref: { id: row.toolId, revision: row.revision },
    content: toolRegistrationContentSchema.parse(parseJson(row.contentJson)),
    contentDigest: row.contentDigest,
    validationReceipt: toolValidationReceiptSchema.parse(parseJson(row.validationReceiptJson)),
    state: row.state,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  }
}

function toJobTemplate(row: typeof employeeJobTemplates.$inferSelect): JobTemplateRecord {
  return {
    id: row.id,
    typeRef: { typeId: row.typeId, revision: row.typeRevision },
    name: row.name,
    draft: employeeJobTemplateContentSchema.parse(parseJson(row.draftJson)),
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

function toJobTemplateRevision(
  row: typeof employeeJobTemplateRevisions.$inferSelect,
): JobTemplateRevisionRecord {
  return {
    ref: { id: row.templateId, revision: row.revision },
    content: employeeJobTemplateContentSchema.parse(parseJson(row.contentJson)),
    contentDigest: row.contentDigest,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  }
}

function toEmployee(row: typeof employeeDefinitions.$inferSelect): EmployeeDefinitionRecord {
  return {
    id: row.id,
    name: row.name,
    typeRef: { typeId: row.typeId, revision: row.typeRevision },
    configuration: digitalEmployeeDefinitionDraftSchema.parse(parseJson(row.configurationJson)),
    currentRevision: row.currentRevision,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  }
}

function toEmployeeRevision(
  row: typeof employeeDefinitionRevisions.$inferSelect,
): EmployeeDefinitionRevisionRecord {
  return {
    ref: { id: row.employeeId, revision: row.revision },
    content: digitalEmployeeDefinitionContentSchema.parse(parseJson(row.contentJson)),
    contentDigest: row.contentDigest,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  }
}

export function createPostgresqlDigitalEmployeeAuthoringPersistence(
  db: PostgresqlDatabaseClient,
): DigitalEmployeeAuthoringPersistence {
  return {
    async ensureTypePackage(input) {
      const existing = await db
        .select()
        .from(employeeTypePackages)
        .where(typeWhere(input.descriptor.typeRef))
        .get()
      if (existing !== undefined) {
        if (existing.descriptorDigest !== input.descriptorDigest) {
          const { typeId, revision } = input.descriptor.typeRef
          throw new ConflictError(
            'employee-type-revision-drift',
            typePackageDriftMessage(
              typeId,
              revision,
              existing.descriptorDigest,
              input.descriptorDigest,
            ),
            {
              typeId,
              revision,
              registeredDigest: existing.descriptorDigest,
              currentDigest: input.descriptorDigest,
            },
          )
        }
        return
      }
      await db
        .insert(employeeTypePackages)
        .values({
          typeId: input.descriptor.typeRef.typeId,
          revision: input.descriptor.typeRef.revision,
          descriptorJson: JSON.stringify(input.descriptor),
          descriptorDigest: input.descriptorDigest,
          state: input.state,
          registeredAt: input.registeredAt,
        })
        .run()
    },
    async listTypePackageRegistrations() {
      const rows = await db
        .select({
          typeId: employeeTypePackages.typeId,
          revision: employeeTypePackages.revision,
          descriptorDigest: employeeTypePackages.descriptorDigest,
          state: employeeTypePackages.state,
          registeredAt: employeeTypePackages.registeredAt,
        })
        .from(employeeTypePackages)
        .all()
      return rows
        .map(toTypePackageRegistration)
        .sort((a, b) => compareTypeRefs(a.typeRef, b.typeRef))
    },
    async listTypePackageDescriptorJsons() {
      return (
        await db
          .select({ descriptorJson: employeeTypePackages.descriptorJson })
          .from(employeeTypePackages)
          .all()
      ).map((row) => row.descriptorJson)
    },
    async listTypePackages() {
      return (await db.select().from(employeeTypePackages).all())
        .map(toTypePackage)
        .sort((a, b) => compareTypeRefs(a.descriptor.typeRef, b.descriptor.typeRef))
    },
    async getTypePackage(ref) {
      const row = await db.select().from(employeeTypePackages).where(typeWhere(ref)).get()
      return row === undefined ? null : toTypePackage(row)
    },
    async createTool(input) {
      await db
        .insert(employeeToolRegistrations)
        .values({
          id: input.id,
          typeId: input.typeRef.typeId,
          typeRevision: input.typeRef.revision,
          workItemRef: input.workItemRef,
          draftJson: JSON.stringify({
            content: input.content,
            validationReceipt: input.validationReceipt,
          }),
          publishedRevision: input.publishedRevision,
          ownerUserId: input.ownerUserId,
          name: input.content.displayName,
          visibility: input.visibility,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          retiredAt: input.retiredAt,
        })
        .run()
    },
    async updateToolValidation(id, content, receipt, updatedAt) {
      const updated = await db
        .update(employeeToolRegistrations)
        .set({
          draftJson: JSON.stringify({ content, validationReceipt: receipt }),
          name: content.displayName,
          updatedAt,
        })
        .where(
          and(eq(employeeToolRegistrations.id, id), isNull(employeeToolRegistrations.retiredAt)),
        )
        .returning({ id: employeeToolRegistrations.id })
        .all()
      if (updated.length !== 1)
        throw new NotFoundError('employee-tool-not-found', `tool registration not found: ${id}`)
    },
    async getTool(id) {
      const row = await db
        .select()
        .from(employeeToolRegistrations)
        .where(eq(employeeToolRegistrations.id, id))
        .get()
      return row === undefined ? null : toTool(row)
    },
    async getToolAcl(id) {
      const row = await db
        .select({
          id: employeeToolRegistrations.id,
          name: employeeToolRegistrations.name,
          ownerUserId: employeeToolRegistrations.ownerUserId,
          visibility: employeeToolRegistrations.visibility,
          retiredAt: employeeToolRegistrations.retiredAt,
        })
        .from(employeeToolRegistrations)
        .where(eq(employeeToolRegistrations.id, id))
        .get()
      return row ?? null
    },
    async listTools(typeRef, workItemRef) {
      const rows = await db
        .select()
        .from(employeeToolRegistrations)
        .where(
          and(
            eq(employeeToolRegistrations.typeId, typeRef.typeId),
            eq(employeeToolRegistrations.typeRevision, typeRef.revision),
            eq(employeeToolRegistrations.workItemRef, workItemRef),
            isNull(employeeToolRegistrations.retiredAt),
          ),
        )
        .all()
      return rows
        .map(toTool)
        .sort((a, b) => a.content.displayName.localeCompare(b.content.displayName))
    },
    async publishTool(input) {
      await db.transaction(async (tx) => {
        const identity = await tx
          .select({ id: employeeToolRegistrations.id })
          .from(employeeToolRegistrations)
          .where(
            and(
              eq(employeeToolRegistrations.id, input.ref.id),
              isNull(employeeToolRegistrations.retiredAt),
            ),
          )
          .get()
        if (identity === undefined)
          throw new NotFoundError(
            'employee-tool-not-found',
            `tool registration not found: ${input.ref.id}`,
          )
        await tx
          .insert(employeeToolRegistrationRevisions)
          .values({
            toolId: input.ref.id,
            revision: input.ref.revision,
            contentJson: JSON.stringify(input.content),
            contentDigest: input.contentDigest,
            validationReceiptJson: JSON.stringify(input.validationReceipt),
            state: input.state,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        await tx
          .update(employeeToolRegistrations)
          .set({ publishedRevision: input.ref.revision, updatedAt: input.publishedAt })
          .where(eq(employeeToolRegistrations.id, input.ref.id))
          .run()
      })
    },
    async getToolRevision(ref) {
      const row = await db
        .select()
        .from(employeeToolRegistrationRevisions)
        .where(
          and(
            eq(employeeToolRegistrationRevisions.toolId, ref.id),
            eq(employeeToolRegistrationRevisions.revision, ref.revision),
          ),
        )
        .get()
      return row === undefined ? null : toToolRevision(row)
    },
    async retireTool(id, retiredAt) {
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(employeeToolRegistrations)
          .set({ retiredAt, updatedAt: retiredAt })
          .where(
            and(eq(employeeToolRegistrations.id, id), isNull(employeeToolRegistrations.retiredAt)),
          )
          .returning({ id: employeeToolRegistrations.id })
          .all()
        if (updated.length !== 1)
          throw new NotFoundError('employee-tool-not-found', `tool registration not found: ${id}`)
        await tx
          .update(employeeToolRegistrationRevisions)
          .set({ state: 'retired' })
          .where(eq(employeeToolRegistrationRevisions.toolId, id))
          .run()
      })
    },
    async createJobTemplate(input) {
      try {
        await db
          .insert(employeeJobTemplates)
          .values({
            id: input.id,
            typeId: input.typeRef.typeId,
            typeRevision: input.typeRef.revision,
            name: input.name,
            draftJson: JSON.stringify(input.draft),
            publishedRevision: input.publishedRevision,
            ownerUserId: input.ownerUserId,
            visibility: input.visibility,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
            archivedAt: input.archivedAt,
          })
          .run()
      } catch (error) {
        uniqueError(
          error,
          'employee-job-template-name-conflict',
          'job template name already exists',
        )
      }
    },
    async updateJobTemplate(id, name, draft, now) {
      try {
        const updated = await db
          .update(employeeJobTemplates)
          .set({ name, draftJson: JSON.stringify(draft), updatedAt: now })
          .where(and(eq(employeeJobTemplates.id, id), isNull(employeeJobTemplates.archivedAt)))
          .returning({ id: employeeJobTemplates.id })
          .all()
        if (updated.length !== 1)
          throw new NotFoundError(
            'employee-job-template-not-found',
            `job template not found: ${id}`,
          )
      } catch (error) {
        if (error instanceof NotFoundError) throw error
        uniqueError(
          error,
          'employee-job-template-name-conflict',
          'job template name already exists',
        )
      }
    },
    async getJobTemplate(id) {
      const row = await db
        .select()
        .from(employeeJobTemplates)
        .where(eq(employeeJobTemplates.id, id))
        .get()
      return row === undefined ? null : toJobTemplate(row)
    },
    async getJobTemplateAcl(id) {
      const row = await db
        .select({
          id: employeeJobTemplates.id,
          name: employeeJobTemplates.name,
          ownerUserId: employeeJobTemplates.ownerUserId,
          visibility: employeeJobTemplates.visibility,
          archivedAt: employeeJobTemplates.archivedAt,
        })
        .from(employeeJobTemplates)
        .where(eq(employeeJobTemplates.id, id))
        .get()
      return row ?? null
    },
    async listJobTemplates(typeRef) {
      const rows = await db
        .select()
        .from(employeeJobTemplates)
        .where(
          and(
            eq(employeeJobTemplates.typeId, typeRef.typeId),
            eq(employeeJobTemplates.typeRevision, typeRef.revision),
            isNull(employeeJobTemplates.archivedAt),
          ),
        )
        .all()
      return rows.map(toJobTemplate).sort((a, b) => a.name.localeCompare(b.name))
    },
    async listJobTemplatesByTypeId(typeId) {
      const rows = await db
        .select()
        .from(employeeJobTemplates)
        .where(
          and(eq(employeeJobTemplates.typeId, typeId), isNull(employeeJobTemplates.archivedAt)),
        )
        .all()
      return rows
        .map(toJobTemplate)
        .sort(
          (left, right) =>
            right.typeRef.revision - left.typeRef.revision ||
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        )
    },
    async publishJobTemplate(input) {
      await db.transaction(async (tx) => {
        await tx
          .insert(employeeJobTemplateRevisions)
          .values({
            templateId: input.ref.id,
            revision: input.ref.revision,
            contentJson: JSON.stringify(input.content),
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        const updated = await tx
          .update(employeeJobTemplates)
          .set({ publishedRevision: input.ref.revision, updatedAt: input.publishedAt })
          .where(
            and(eq(employeeJobTemplates.id, input.ref.id), isNull(employeeJobTemplates.archivedAt)),
          )
          .returning({ id: employeeJobTemplates.id })
          .all()
        if (updated.length !== 1)
          throw new NotFoundError(
            'employee-job-template-not-found',
            `job template not found: ${input.ref.id}`,
          )
      })
    },
    async getJobTemplateRevision(ref) {
      const row = await db
        .select()
        .from(employeeJobTemplateRevisions)
        .where(
          and(
            eq(employeeJobTemplateRevisions.templateId, ref.id),
            eq(employeeJobTemplateRevisions.revision, ref.revision),
          ),
        )
        .get()
      return row === undefined ? null : toJobTemplateRevision(row)
    },
    async getEmployeeDefinition(id) {
      const row = await db
        .select()
        .from(employeeDefinitions)
        .where(eq(employeeDefinitions.id, id))
        .get()
      return row === undefined ? null : toEmployee(row)
    },
    async getEmployeeDefinitionAcl(id) {
      const row = await db
        .select({
          id: employeeDefinitions.id,
          name: employeeDefinitions.name,
          ownerUserId: employeeDefinitions.ownerUserId,
          visibility: employeeDefinitions.visibility,
          archivedAt: employeeDefinitions.archivedAt,
        })
        .from(employeeDefinitions)
        .where(eq(employeeDefinitions.id, id))
        .get()
      return row ?? null
    },
    async listEmployeeDefinitions(typeRef) {
      const where =
        typeRef === undefined
          ? isNull(employeeDefinitions.archivedAt)
          : and(
              eq(employeeDefinitions.typeId, typeRef.typeId),
              eq(employeeDefinitions.typeRevision, typeRef.revision),
              isNull(employeeDefinitions.archivedAt),
            )
      const rows = await db.select().from(employeeDefinitions).where(where).all()
      return rows.map(toEmployee).sort((a, b) => a.name.localeCompare(b.name))
    },
    async saveEmployeeDefinition(input) {
      try {
        await db.transaction(async (tx) => {
          if (input.definitionMutation.kind === 'create') {
            const record = input.definitionMutation.record
            await tx
              .insert(employeeDefinitions)
              .values({
                id: record.id,
                name: record.name,
                typeId: record.typeRef.typeId,
                typeRevision: record.typeRef.revision,
                configurationJson: JSON.stringify(record.configuration),
                currentRevision: input.revision.ref.revision,
                ownerUserId: record.ownerUserId,
                visibility: record.visibility,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                archivedAt: record.archivedAt,
              })
              .run()
          }
          await tx
            .insert(employeeWorkScopeRevisions)
            .values({
              scopeId: input.workScope.ref.id,
              revision: input.workScope.ref.revision,
              typeId: input.workScope.typeRef.typeId,
              typeRevision: input.workScope.typeRef.revision,
              encodedScopeJson: JSON.stringify(input.workScope.encodedScope),
              displaySummary: input.workScope.displaySummary,
              contentDigest: input.workScope.contentDigest,
              createdAt: input.workScope.createdAt,
              createdBy: input.workScope.createdBy,
            })
            .run()
          await tx
            .insert(employeeDefinitionRevisions)
            .values({
              employeeId: input.revision.ref.id,
              revision: input.revision.ref.revision,
              contentJson: JSON.stringify(input.revision.content),
              contentDigest: input.revision.contentDigest,
              createdAt: input.revision.createdAt,
              createdBy: input.revision.createdBy,
            })
            .run()
          if (input.definitionMutation.kind === 'update') {
            const update = input.definitionMutation
            const updated = await tx
              .update(employeeDefinitions)
              .set({
                name: update.name,
                typeId: update.targetTypeRef.typeId,
                typeRevision: update.targetTypeRef.revision,
                configurationJson: JSON.stringify(update.configuration),
                currentRevision: input.revision.ref.revision,
                updatedAt: update.updatedAt,
              })
              .where(
                and(
                  eq(employeeDefinitions.id, input.revision.ref.id),
                  eq(employeeDefinitions.typeId, update.expectedTypeRef.typeId),
                  eq(employeeDefinitions.typeRevision, update.expectedTypeRef.revision),
                  isNull(employeeDefinitions.archivedAt),
                ),
              )
              .returning({ id: employeeDefinitions.id })
              .all()
            if (updated.length !== 1)
              throw new NotFoundError(
                'employee-definition-not-found',
                `employee not found or changed while saving: ${input.revision.ref.id}`,
              )
          }
        })
      } catch (error) {
        if (error instanceof NotFoundError) throw error
        uniqueError(error, 'employee-definition-name-conflict', 'employee name already exists')
      }
    },
    async getEmployeeDefinitionRevision(ref) {
      const row = await db
        .select()
        .from(employeeDefinitionRevisions)
        .where(
          and(
            eq(employeeDefinitionRevisions.employeeId, ref.id),
            eq(employeeDefinitionRevisions.revision, ref.revision),
          ),
        )
        .get()
      return row === undefined ? null : toEmployeeRevision(row)
    },
    async getWorkScopeRevision(ref) {
      const row = await db
        .select()
        .from(employeeWorkScopeRevisions)
        .where(
          and(
            eq(employeeWorkScopeRevisions.scopeId, ref.id),
            eq(employeeWorkScopeRevisions.revision, ref.revision),
          ),
        )
        .get()
      return row === undefined
        ? null
        : {
            ref: { id: row.scopeId, revision: row.revision },
            typeRef: { typeId: row.typeId, revision: row.typeRevision },
            encodedScope: parseJson(row.encodedScopeJson),
            displaySummary: row.displaySummary,
            contentDigest: row.contentDigest,
            createdAt: row.createdAt,
            createdBy: row.createdBy,
          }
    },
    async getCurrentExecutionPolicy() {
      const current = await db
        .select({ revision: employeeOsSettings.executionPolicyRevision })
        .from(employeeOsSettings)
        .where(eq(employeeOsSettings.singletonKey, 'global'))
        .get()
      if (current === undefined) return null
      const row = await db
        .select()
        .from(employeeExecutionPolicyRevisions)
        .where(eq(employeeExecutionPolicyRevisions.revision, current.revision))
        .get()
      return row === undefined
        ? null
        : {
            revision: row.revision,
            content: globalExecutionPolicySchema.parse(parseJson(row.contentJson)),
            contentDigest: row.contentDigest,
            publishedAt: row.publishedAt,
            publishedBy: row.publishedBy,
          }
    },
    async getExecutionPolicyRevision(revision) {
      const row = await db
        .select()
        .from(employeeExecutionPolicyRevisions)
        .where(eq(employeeExecutionPolicyRevisions.revision, revision))
        .get()
      return row === undefined
        ? null
        : {
            revision: row.revision,
            content: globalExecutionPolicySchema.parse(parseJson(row.contentJson)),
            contentDigest: row.contentDigest,
            publishedAt: row.publishedAt,
            publishedBy: row.publishedBy,
          }
    },
    async ensureExecutionPolicy(input) {
      return await db.transaction(async (tx) => {
        await tx.run(
          sql`select ${employeeOsSettings.singletonKey} from ${employeeOsSettings} where ${employeeOsSettings.singletonKey} = ${'global'} for update`,
        )
        const current = await tx
          .select({ revision: employeeOsSettings.executionPolicyRevision })
          .from(employeeOsSettings)
          .where(eq(employeeOsSettings.singletonKey, 'global'))
          .get()
        if (current !== undefined) {
          const row = await tx
            .select()
            .from(employeeExecutionPolicyRevisions)
            .where(eq(employeeExecutionPolicyRevisions.revision, current.revision))
            .get()
          if (row !== undefined && row.contentDigest === input.contentDigest) {
            return {
              revision: row.revision,
              content: globalExecutionPolicySchema.parse(parseJson(row.contentJson)),
              contentDigest: row.contentDigest,
              publishedAt: row.publishedAt,
              publishedBy: row.publishedBy,
            }
          }
        }
        const revision = (current?.revision ?? 0) + 1
        await tx
          .insert(employeeExecutionPolicyRevisions)
          .values({
            revision,
            contentJson: JSON.stringify(input.content),
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        await tx
          .insert(employeeOsSettings)
          .values({
            singletonKey: 'global',
            executionPolicyRevision: revision,
            updatedAt: input.publishedAt,
          })
          .onConflictDoUpdate({
            target: employeeOsSettings.singletonKey,
            set: { executionPolicyRevision: revision, updatedAt: input.publishedAt },
          })
          .run()
        return { revision, ...input }
      })
    },
  }
}
