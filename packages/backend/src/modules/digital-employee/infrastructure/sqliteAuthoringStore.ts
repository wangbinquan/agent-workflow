import { and, eq, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
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
import { ConflictError, NotFoundError } from '@/util/errors'
import {
  digitalEmployeeDefinitionContentSchema,
  digitalEmployeeDefinitionDraftSchema,
  employeeJobTemplateContentSchema,
  globalExecutionPolicySchema,
  parsePersistedEmployeeTypePackageDescriptor,
  toolRegistrationContentSchema,
  toolValidationReceiptSchema,
  type EmployeeTypeRef,
  type ExactResourceRef,
} from '../domain/model'
import type {
  DigitalEmployeeAuthoringStore,
  EmployeeDefinitionRecord,
  EmployeeDefinitionRevisionRecord,
  JobTemplateRecord,
  JobTemplateRevisionRecord,
  ToolDraftRecord,
  ToolRevisionRecord,
  TypePackageRecord,
  TypePackageRegistrationRecord,
} from '../application/ports/authoringStore'

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown
}

function uniqueError(error: unknown, code: string, message: string): never {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.includes('UNIQUE constraint failed')) throw new ConflictError(code, message)
  throw error
}

function shortDigest(digest: string): string {
  return digest.length > 12 ? `${digest.slice(0, 12)}…` : digest
}

/**
 * A registered type revision is immutable, so a descriptor edit without a
 * revision bump aborts daemon boot. The daemon prints only `err.message`
 * (`main.ts` top-level handler), so the remediation has to live in the message
 * itself — see `tests/digital-employee-type-package-drift.test.ts`.
 */
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
  const draft = parseJson(row.draftJson) as Record<string, unknown>
  return {
    id: row.id,
    typeRef: { typeId: row.typeId, revision: row.typeRevision },
    workItemRef: row.workItemRef,
    content: toolRegistrationContentSchema.parse(draft.content),
    validationReceipt: toolValidationReceiptSchema.parse(draft.validationReceipt),
    publishedRevision: row.publishedRevision,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    retiredAt: row.retiredAt,
  }
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

function getToolRevisionRow(db: DbClient, ref: ExactResourceRef) {
  return db
    .select()
    .from(employeeToolRegistrationRevisions)
    .where(
      and(
        eq(employeeToolRegistrationRevisions.toolId, ref.id),
        eq(employeeToolRegistrationRevisions.revision, ref.revision),
      ),
    )
    .get()
}

export function createSqliteDigitalEmployeeAuthoringStore(
  db: DbClient,
): DigitalEmployeeAuthoringStore {
  return {
    ensureTypePackage(input) {
      const existing = db
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
      db.insert(employeeTypePackages)
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

    listTypePackageRegistrations() {
      return db
        .select({
          typeId: employeeTypePackages.typeId,
          revision: employeeTypePackages.revision,
          descriptorDigest: employeeTypePackages.descriptorDigest,
          state: employeeTypePackages.state,
          registeredAt: employeeTypePackages.registeredAt,
        })
        .from(employeeTypePackages)
        .all()
        .map(toTypePackageRegistration)
        .sort((a, b) => compareTypeRefs(a.typeRef, b.typeRef))
    },

    listTypePackageDescriptorJsons() {
      return db
        .select({ descriptorJson: employeeTypePackages.descriptorJson })
        .from(employeeTypePackages)
        .all()
        .map((row) => row.descriptorJson)
    },

    listTypePackages() {
      return db
        .select()
        .from(employeeTypePackages)
        .all()
        .map(toTypePackage)
        .sort((a, b) => compareTypeRefs(a.descriptor.typeRef, b.descriptor.typeRef))
    },

    getTypePackage(ref) {
      const row = db.select().from(employeeTypePackages).where(typeWhere(ref)).get()
      return row === undefined ? null : toTypePackage(row)
    },

    createTool(input) {
      db.insert(employeeToolRegistrations)
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
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
          retiredAt: input.retiredAt,
        })
        .run()
    },

    updateToolValidation(id, content, receipt, updatedAt) {
      const result = db
        .update(employeeToolRegistrations)
        .set({
          draftJson: JSON.stringify({ content, validationReceipt: receipt }),
          updatedAt,
        })
        .where(
          and(eq(employeeToolRegistrations.id, id), isNull(employeeToolRegistrations.retiredAt)),
        )
        .run()
      if ((result as unknown as { changes?: number }).changes !== 1) {
        throw new NotFoundError('employee-tool-not-found', `tool registration not found: ${id}`)
      }
    },

    getTool(id) {
      const row = db
        .select()
        .from(employeeToolRegistrations)
        .where(eq(employeeToolRegistrations.id, id))
        .get()
      return row === undefined ? null : toTool(row)
    },

    listTools(typeRef, workItemRef) {
      return db
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
        .map(toTool)
        .sort((a, b) => a.content.displayName.localeCompare(b.content.displayName))
    },

    publishTool(input) {
      db.transaction((tx) => {
        const identity = tx
          .select({ id: employeeToolRegistrations.id })
          .from(employeeToolRegistrations)
          .where(
            and(
              eq(employeeToolRegistrations.id, input.ref.id),
              isNull(employeeToolRegistrations.retiredAt),
            ),
          )
          .get()
        if (identity === undefined) {
          throw new NotFoundError(
            'employee-tool-not-found',
            `tool registration not found: ${input.ref.id}`,
          )
        }
        tx.insert(employeeToolRegistrationRevisions)
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
        tx.update(employeeToolRegistrations)
          .set({ publishedRevision: input.ref.revision, updatedAt: input.publishedAt })
          .where(eq(employeeToolRegistrations.id, input.ref.id))
          .run()
      })
    },

    getToolRevision(ref) {
      const row = getToolRevisionRow(db, ref)
      return row === undefined ? null : toToolRevision(row)
    },

    retireTool(id, retiredAt) {
      db.transaction((tx) => {
        const result = tx
          .update(employeeToolRegistrations)
          .set({ retiredAt, updatedAt: retiredAt })
          .where(
            and(eq(employeeToolRegistrations.id, id), isNull(employeeToolRegistrations.retiredAt)),
          )
          .run()
        if ((result as unknown as { changes?: number }).changes !== 1) {
          throw new NotFoundError('employee-tool-not-found', `tool registration not found: ${id}`)
        }
        tx.update(employeeToolRegistrationRevisions)
          .set({ state: 'retired' })
          .where(eq(employeeToolRegistrationRevisions.toolId, id))
          .run()
      })
    },

    createJobTemplate(input) {
      try {
        db.insert(employeeJobTemplates)
          .values({
            id: input.id,
            typeId: input.typeRef.typeId,
            typeRevision: input.typeRef.revision,
            name: input.name,
            draftJson: JSON.stringify(input.draft),
            publishedRevision: input.publishedRevision,
            ownerUserId: input.ownerUserId,
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

    updateJobTemplate(id, name, draft, now) {
      try {
        const result = db
          .update(employeeJobTemplates)
          .set({ name, draftJson: JSON.stringify(draft), updatedAt: now })
          .where(and(eq(employeeJobTemplates.id, id), isNull(employeeJobTemplates.archivedAt)))
          .run()
        if ((result as unknown as { changes?: number }).changes !== 1) {
          throw new NotFoundError(
            'employee-job-template-not-found',
            `job template not found: ${id}`,
          )
        }
      } catch (error) {
        if (error instanceof NotFoundError) throw error
        uniqueError(
          error,
          'employee-job-template-name-conflict',
          'job template name already exists',
        )
      }
    },

    getJobTemplate(id) {
      const row = db
        .select()
        .from(employeeJobTemplates)
        .where(eq(employeeJobTemplates.id, id))
        .get()
      return row === undefined ? null : toJobTemplate(row)
    },

    listJobTemplates(typeRef) {
      return db
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
        .map(toJobTemplate)
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    listJobTemplatesByTypeId(typeId) {
      return db
        .select()
        .from(employeeJobTemplates)
        .where(
          and(eq(employeeJobTemplates.typeId, typeId), isNull(employeeJobTemplates.archivedAt)),
        )
        .all()
        .map(toJobTemplate)
        .sort((left, right) => {
          const revision = right.typeRef.revision - left.typeRef.revision
          return revision === 0
            ? left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
            : revision
        })
    },

    publishJobTemplate(input) {
      db.transaction((tx) => {
        tx.insert(employeeJobTemplateRevisions)
          .values({
            templateId: input.ref.id,
            revision: input.ref.revision,
            contentJson: JSON.stringify(input.content),
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        const result = tx
          .update(employeeJobTemplates)
          .set({ publishedRevision: input.ref.revision, updatedAt: input.publishedAt })
          .where(
            and(eq(employeeJobTemplates.id, input.ref.id), isNull(employeeJobTemplates.archivedAt)),
          )
          .run()
        if ((result as unknown as { changes?: number }).changes !== 1) {
          throw new NotFoundError(
            'employee-job-template-not-found',
            `job template not found: ${input.ref.id}`,
          )
        }
      })
    },

    getJobTemplateRevision(ref) {
      const row = db
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

    getEmployeeDefinition(id) {
      const row = db.select().from(employeeDefinitions).where(eq(employeeDefinitions.id, id)).get()
      return row === undefined ? null : toEmployee(row)
    },

    getEmployeeDefinitionAcl(id) {
      const row = db
        .select({
          id: employeeDefinitions.id,
          ownerUserId: employeeDefinitions.ownerUserId,
          visibility: employeeDefinitions.visibility,
          archivedAt: employeeDefinitions.archivedAt,
        })
        .from(employeeDefinitions)
        .where(eq(employeeDefinitions.id, id))
        .get()
      return row === undefined ? null : row
    },

    listEmployeeDefinitions(typeRef) {
      const where =
        typeRef === undefined
          ? isNull(employeeDefinitions.archivedAt)
          : and(
              eq(employeeDefinitions.typeId, typeRef.typeId),
              eq(employeeDefinitions.typeRevision, typeRef.revision),
              isNull(employeeDefinitions.archivedAt),
            )
      return db
        .select()
        .from(employeeDefinitions)
        .where(where)
        .all()
        .map(toEmployee)
        .sort((a, b) => a.name.localeCompare(b.name))
    },

    saveEmployeeDefinition(input) {
      try {
        db.transaction((tx) => {
          if (input.definitionMutation.kind === 'create') {
            const record = input.definitionMutation.record
            tx.insert(employeeDefinitions)
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
          tx.insert(employeeWorkScopeRevisions)
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
          tx.insert(employeeDefinitionRevisions)
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
            const result = tx
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
              .run()
            if ((result as unknown as { changes?: number }).changes !== 1) {
              throw new NotFoundError(
                'employee-definition-not-found',
                `employee not found or changed while saving: ${input.revision.ref.id}`,
              )
            }
          }
        })
      } catch (error) {
        if (error instanceof NotFoundError) throw error
        uniqueError(error, 'employee-definition-name-conflict', 'employee name already exists')
      }
    },

    getEmployeeDefinitionRevision(ref) {
      const row = db
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

    getWorkScopeRevision(ref) {
      const row = db
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
            encodedScope: JSON.parse(row.encodedScopeJson) as unknown,
            displaySummary: row.displaySummary,
            contentDigest: row.contentDigest,
            createdAt: row.createdAt,
            createdBy: row.createdBy,
          }
    },

    getCurrentExecutionPolicy() {
      const current = db
        .select({ revision: employeeOsSettings.executionPolicyRevision })
        .from(employeeOsSettings)
        .where(eq(employeeOsSettings.singletonKey, 'global'))
        .get()
      if (current === undefined) return null
      const row = db
        .select()
        .from(employeeExecutionPolicyRevisions)
        .where(eq(employeeExecutionPolicyRevisions.revision, current.revision))
        .get()
      if (row === undefined) return null
      return {
        revision: row.revision,
        content: globalExecutionPolicySchema.parse(parseJson(row.contentJson)),
        contentDigest: row.contentDigest,
        publishedAt: row.publishedAt,
        publishedBy: row.publishedBy,
      }
    },

    getExecutionPolicyRevision(revision) {
      const row = db
        .select()
        .from(employeeExecutionPolicyRevisions)
        .where(eq(employeeExecutionPolicyRevisions.revision, revision))
        .get()
      return row === undefined
        ? null
        : {
            revision: row.revision,
            content: globalExecutionPolicySchema.parse(JSON.parse(row.contentJson) as unknown),
            contentDigest: row.contentDigest,
            publishedAt: row.publishedAt,
            publishedBy: row.publishedBy,
          }
    },

    ensureExecutionPolicy(input) {
      return db.transaction((tx) => {
        const current = tx
          .select({ revision: employeeOsSettings.executionPolicyRevision })
          .from(employeeOsSettings)
          .where(eq(employeeOsSettings.singletonKey, 'global'))
          .get()
        if (current !== undefined) {
          const row = tx
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
        tx.insert(employeeExecutionPolicyRevisions)
          .values({
            revision,
            contentJson: JSON.stringify(input.content),
            contentDigest: input.contentDigest,
            publishedAt: input.publishedAt,
            publishedBy: input.publishedBy,
          })
          .run()
        tx.insert(employeeOsSettings)
          .values({
            singletonKey: 'global',
            executionPolicyRevision: revision,
            updatedAt: input.publishedAt,
          })
          .onConflictDoUpdate({
            target: employeeOsSettings.singletonKey,
            set: {
              executionPolicyRevision: revision,
              updatedAt: input.publishedAt,
            },
          })
          .run()
        return { revision, ...input }
      })
    },
  }
}
