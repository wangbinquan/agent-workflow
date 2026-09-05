// RFC-359 W4-D6c —— Digital Employee 作者面持久化：一份实现，两个 provider 共用。
//
// 类型包 / 工具 / 岗位模版 / 员工定义 / 全局执行策略五个聚合的 identity + immutable revision 行都在这里。语义沿
// RFC-310 的 SQLite store：撞唯一索引经能力矩阵归类成 typed 409；写多张表的操作走统一事务原语；「行不存在或已
// 归档 / 已退役」按 returning 的行数判 typed 404；ensureExecutionPolicy 先 lockAggregateRoot 锁住单例行再读—改—写
// （PG 上是 FOR UPDATE，SQLite 独占事务下 no-op）。resource-catalog 的 foreign-owner ACL 面（employee_definition /
// employee_tool / employee_job_template）也由本文件交出：目录持有写事务，owner 只回答「这行现在长什么样」与
// 「把 ACL 列写回去」（aclRevision CAS）。列表在 JS 侧按 displayName / name 排序——两个引擎的 collation 不同，
// DB 端 ORDER BY 会让顺序取决于部署选了哪个数据库。

import { and, eq, isNull, ne } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
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
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  DigitalEmployeeAclIdentityMutation,
  DigitalEmployeeAclIdentityPersistence,
  DigitalEmployeeAuthoringAdapter,
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

function zRecord(text: string): Record<string, unknown> {
  const value = parseJson(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('persisted digital employee JSON is not an object')
  }
  return Object.fromEntries(Object.entries(value))
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

function toExecutionPolicy(row: typeof employeeExecutionPolicyRevisions.$inferSelect) {
  return {
    revision: row.revision,
    content: globalExecutionPolicySchema.parse(parseJson(row.contentJson)),
    contentDigest: row.contentDigest,
    publishedAt: row.publishedAt,
    publishedBy: row.publishedBy,
  }
}

// ---------------------------------------------------------------------------
// resource-catalog 交来的 foreign-owner ACL identity 面（目录写事务内读 / 写自己那张表）
// ---------------------------------------------------------------------------

// 列映射在函数内构造：provider 投影是按调用时的 schema 代理解析列（RFC-349 数值投影），模块级常量会把
// SQLite 形态的列句柄冻结在 PG 路径上——aclRevision 会以 int8 字符串回来，CAS 永远不等。
function aclColumns(
  table:
    | typeof employeeDefinitions
    | typeof employeeToolRegistrations
    | typeof employeeJobTemplates,
) {
  return {
    id: table.id,
    name: table.name,
    ownerUserId: table.ownerUserId,
    visibility: table.visibility,
    aclRevision: table.aclRevision,
  }
}

function employeeDefinitionAclIdentity(
  db: ProviderNeutralDatabase,
): DigitalEmployeeAclIdentityPersistence {
  const identity: DigitalEmployeeAclIdentityPersistence = {
    type: 'employee_definition',
    async getRevision(resourceId) {
      const columns = aclColumns(employeeDefinitions)
      const rows = await db
        .select({ aclRevision: columns.aclRevision })
        .from(employeeDefinitions)
        .where(eq(columns.id, resourceId))
        .limit(1)
      return rows[0]?.aclRevision ?? 0
    },
    async loadForMutation(transaction: DatabaseTransaction, resourceId: string) {
      const columns = aclColumns(employeeDefinitions)
      const row = (
        await transaction
          .select(columns)
          .from(employeeDefinitions)
          .where(eq(columns.id, resourceId))
          .limit(1)
      )[0]
      if (row === undefined) return undefined
      const mutation: DigitalEmployeeAclIdentityMutation = {
        current: row,
        ownerNameIsUnique: true,
        async hasOwnerNameCollision(nextOwnerUserId) {
          const rows = await transaction
            .select({ id: columns.id })
            .from(employeeDefinitions)
            .where(
              and(
                eq(columns.ownerUserId, nextOwnerUserId),
                eq(columns.name, row.name),
                ne(columns.id, resourceId),
              ),
            )
            .limit(1)
          return rows[0] !== undefined
        },
        async update(input) {
          const updated = await transaction
            .update(employeeDefinitions)
            .set({
              ownerUserId: input.ownerUserId,
              visibility: input.visibility,
              aclRevision: input.aclRevision,
              updatedAt: input.updatedAt,
            })
            .where(and(eq(columns.id, resourceId), eq(columns.aclRevision, row.aclRevision)))
            .returning({ id: columns.id })
          return updated.length === 1
        },
      }
      return mutation
    },
  }
  return Object.freeze(identity)
}

function employeeToolAclIdentity(
  db: ProviderNeutralDatabase,
): DigitalEmployeeAclIdentityPersistence {
  const identity: DigitalEmployeeAclIdentityPersistence = {
    type: 'employee_tool',
    async getRevision(resourceId) {
      const columns = aclColumns(employeeToolRegistrations)
      const rows = await db
        .select({ aclRevision: columns.aclRevision })
        .from(employeeToolRegistrations)
        .where(eq(columns.id, resourceId))
        .limit(1)
      return rows[0]?.aclRevision ?? 0
    },
    async loadForMutation(transaction: DatabaseTransaction, resourceId: string) {
      const columns = aclColumns(employeeToolRegistrations)
      const row = (
        await transaction
          .select(columns)
          .from(employeeToolRegistrations)
          .where(eq(columns.id, resourceId))
          .limit(1)
      )[0]
      if (row === undefined) return undefined
      const mutation: DigitalEmployeeAclIdentityMutation = {
        current: row,
        // 工具的 name 镜像 displayName，没有 owner+name 唯一索引（RFC-330）。
        ownerNameIsUnique: false,
        hasOwnerNameCollision: async () => false,
        async update(input) {
          const updated = await transaction
            .update(employeeToolRegistrations)
            .set({
              ownerUserId: input.ownerUserId,
              visibility: input.visibility,
              aclRevision: input.aclRevision,
              updatedAt: input.updatedAt,
            })
            .where(and(eq(columns.id, resourceId), eq(columns.aclRevision, row.aclRevision)))
            .returning({ id: columns.id })
          return updated.length === 1
        },
      }
      return mutation
    },
  }
  return Object.freeze(identity)
}

function employeeJobTemplateAclIdentity(
  db: ProviderNeutralDatabase,
): DigitalEmployeeAclIdentityPersistence {
  const identity: DigitalEmployeeAclIdentityPersistence = {
    type: 'employee_job_template',
    async getRevision(resourceId) {
      const columns = aclColumns(employeeJobTemplates)
      const rows = await db
        .select({ aclRevision: columns.aclRevision })
        .from(employeeJobTemplates)
        .where(eq(columns.id, resourceId))
        .limit(1)
      return rows[0]?.aclRevision ?? 0
    },
    async loadForMutation(transaction: DatabaseTransaction, resourceId: string) {
      const columns = aclColumns(employeeJobTemplates)
      const row = (
        await transaction
          .select({
            ...columns,
            typeId: employeeJobTemplates.typeId,
            typeRevision: employeeJobTemplates.typeRevision,
          })
          .from(employeeJobTemplates)
          .where(eq(columns.id, resourceId))
          .limit(1)
      )[0]
      if (row === undefined) return undefined
      const mutation: DigitalEmployeeAclIdentityMutation = {
        current: {
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
          aclRevision: row.aclRevision,
        },
        ownerNameIsUnique: true,
        // 岗位模版的唯一分区是 (owner, type_id, type_revision, name)：另一个类型版本下的同名不算撞。
        async hasOwnerNameCollision(nextOwnerUserId) {
          const rows = await transaction
            .select({ id: columns.id })
            .from(employeeJobTemplates)
            .where(
              and(
                eq(columns.ownerUserId, nextOwnerUserId),
                eq(employeeJobTemplates.typeId, row.typeId),
                eq(employeeJobTemplates.typeRevision, row.typeRevision),
                eq(columns.name, row.name),
                ne(columns.id, resourceId),
              ),
            )
            .limit(1)
          return rows[0] !== undefined
        },
        async update(input) {
          const updated = await transaction
            .update(employeeJobTemplates)
            .set({
              ownerUserId: input.ownerUserId,
              visibility: input.visibility,
              aclRevision: input.aclRevision,
              updatedAt: input.updatedAt,
            })
            .where(and(eq(columns.id, resourceId), eq(columns.aclRevision, row.aclRevision)))
            .returning({ id: columns.id })
          return updated.length === 1
        },
      }
      return mutation
    },
  }
  return Object.freeze(identity)
}

// ---------------------------------------------------------------------------
// 作者面持久化
// ---------------------------------------------------------------------------

export function createDigitalEmployeeAuthoringPersistence(
  db: ProviderNeutralDatabase,
): DigitalEmployeeAuthoringAdapter {
  const session = databaseSessionFor(db)
  const uniqueError = (error: unknown, code: string, message: string): never => {
    if (session.engine.classifyError(error) === 'unique-violation') {
      throw new ConflictError(code, message)
    }
    throw error
  }
  const toolNotFound = (id: string): NotFoundError =>
    new NotFoundError('employee-tool-not-found', `tool registration not found: ${id}`)
  const jobTemplateNotFound = (id: string): NotFoundError =>
    new NotFoundError('employee-job-template-not-found', `job template not found: ${id}`)

  return {
    resourceAclIdentities: Object.freeze({
      employeeDefinition: employeeDefinitionAclIdentity(db),
      employeeTool: employeeToolAclIdentity(db),
      employeeJobTemplate: employeeJobTemplateAclIdentity(db),
    }),

    async ensureTypePackage(input) {
      const existing = (
        await db
          .select()
          .from(employeeTypePackages)
          .where(typeWhere(input.descriptor.typeRef))
          .limit(1)
      )[0]
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
      await db.insert(employeeTypePackages).values({
        typeId: input.descriptor.typeRef.typeId,
        revision: input.descriptor.typeRef.revision,
        descriptorJson: JSON.stringify(input.descriptor),
        descriptorDigest: input.descriptorDigest,
        state: input.state,
        registeredAt: input.registeredAt,
      })
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
      return rows
        .map(toTypePackageRegistration)
        .sort((a, b) => compareTypeRefs(a.typeRef, b.typeRef))
    },

    async listTypePackageDescriptorJsons() {
      const rows = await db
        .select({ descriptorJson: employeeTypePackages.descriptorJson })
        .from(employeeTypePackages)
      return rows.map((row) => row.descriptorJson)
    },

    async listTypePackages() {
      const rows = await db.select().from(employeeTypePackages)
      return rows
        .map(toTypePackage)
        .sort((a, b) => compareTypeRefs(a.descriptor.typeRef, b.descriptor.typeRef))
    },

    async getTypePackage(ref) {
      const row = (await db.select().from(employeeTypePackages).where(typeWhere(ref)).limit(1))[0]
      return row === undefined ? null : toTypePackage(row)
    },

    async createTool(input) {
      await db.insert(employeeToolRegistrations).values({
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
        // RFC-330 —— `name` 镜像 displayName（ACL kernel 的 table.name 契约）。
        name: input.content.displayName,
        visibility: input.visibility,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
        retiredAt: input.retiredAt,
      })
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
      if (updated.length !== 1) throw toolNotFound(id)
    },

    async getTool(id) {
      const row = (
        await db
          .select()
          .from(employeeToolRegistrations)
          .where(eq(employeeToolRegistrations.id, id))
          .limit(1)
      )[0]
      return row === undefined ? null : toTool(row)
    },

    async getToolAcl(id) {
      const row = (
        await db
          .select({
            id: employeeToolRegistrations.id,
            name: employeeToolRegistrations.name,
            ownerUserId: employeeToolRegistrations.ownerUserId,
            visibility: employeeToolRegistrations.visibility,
            retiredAt: employeeToolRegistrations.retiredAt,
          })
          .from(employeeToolRegistrations)
          .where(eq(employeeToolRegistrations.id, id))
          .limit(1)
      )[0]
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
      return rows
        .map(toTool)
        .sort((a, b) => a.content.displayName.localeCompare(b.content.displayName))
    },

    async publishTool(input) {
      await session.transaction(async (tx) => {
        const identity = (
          await tx
            .select({ id: employeeToolRegistrations.id })
            .from(employeeToolRegistrations)
            .where(
              and(
                eq(employeeToolRegistrations.id, input.ref.id),
                isNull(employeeToolRegistrations.retiredAt),
              ),
            )
            .limit(1)
        )[0]
        if (identity === undefined) throw toolNotFound(input.ref.id)
        await tx.insert(employeeToolRegistrationRevisions).values({
          toolId: input.ref.id,
          revision: input.ref.revision,
          contentJson: JSON.stringify(input.content),
          contentDigest: input.contentDigest,
          validationReceiptJson: JSON.stringify(input.validationReceipt),
          state: input.state,
          publishedAt: input.publishedAt,
          publishedBy: input.publishedBy,
        })
        await tx
          .update(employeeToolRegistrations)
          .set({ publishedRevision: input.ref.revision, updatedAt: input.publishedAt })
          .where(eq(employeeToolRegistrations.id, input.ref.id))
      })
    },

    async getToolRevision(ref) {
      const row = (
        await db
          .select()
          .from(employeeToolRegistrationRevisions)
          .where(
            and(
              eq(employeeToolRegistrationRevisions.toolId, ref.id),
              eq(employeeToolRegistrationRevisions.revision, ref.revision),
            ),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : toToolRevision(row)
    },

    async retireTool(id, retiredAt) {
      await session.transaction(async (tx) => {
        const updated = await tx
          .update(employeeToolRegistrations)
          .set({ retiredAt, updatedAt: retiredAt })
          .where(
            and(eq(employeeToolRegistrations.id, id), isNull(employeeToolRegistrations.retiredAt)),
          )
          .returning({ id: employeeToolRegistrations.id })
        if (updated.length !== 1) throw toolNotFound(id)
        await tx
          .update(employeeToolRegistrationRevisions)
          .set({ state: 'retired' })
          .where(eq(employeeToolRegistrationRevisions.toolId, id))
      })
    },

    async createJobTemplate(input) {
      try {
        await db.insert(employeeJobTemplates).values({
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
        if (updated.length !== 1) throw jobTemplateNotFound(id)
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
      const row = (
        await db.select().from(employeeJobTemplates).where(eq(employeeJobTemplates.id, id)).limit(1)
      )[0]
      return row === undefined ? null : toJobTemplate(row)
    },

    async getJobTemplateAcl(id) {
      const row = (
        await db
          .select({
            id: employeeJobTemplates.id,
            name: employeeJobTemplates.name,
            ownerUserId: employeeJobTemplates.ownerUserId,
            visibility: employeeJobTemplates.visibility,
            archivedAt: employeeJobTemplates.archivedAt,
          })
          .from(employeeJobTemplates)
          .where(eq(employeeJobTemplates.id, id))
          .limit(1)
      )[0]
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
      return rows.map(toJobTemplate).sort((a, b) => a.name.localeCompare(b.name))
    },

    async listJobTemplatesByTypeId(typeId) {
      const rows = await db
        .select()
        .from(employeeJobTemplates)
        .where(
          and(eq(employeeJobTemplates.typeId, typeId), isNull(employeeJobTemplates.archivedAt)),
        )
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
      await session.transaction(async (tx) => {
        // 先判 identity：revision 表带 FK，缺席行直接插会以驱动错误而不是 typed 404 收场。
        const identity = (
          await tx
            .select({ id: employeeJobTemplates.id })
            .from(employeeJobTemplates)
            .where(
              and(
                eq(employeeJobTemplates.id, input.ref.id),
                isNull(employeeJobTemplates.archivedAt),
              ),
            )
            .limit(1)
        )[0]
        if (identity === undefined) throw jobTemplateNotFound(input.ref.id)
        await tx.insert(employeeJobTemplateRevisions).values({
          templateId: input.ref.id,
          revision: input.ref.revision,
          contentJson: JSON.stringify(input.content),
          contentDigest: input.contentDigest,
          publishedAt: input.publishedAt,
          publishedBy: input.publishedBy,
        })
        const updated = await tx
          .update(employeeJobTemplates)
          .set({ publishedRevision: input.ref.revision, updatedAt: input.publishedAt })
          .where(
            and(eq(employeeJobTemplates.id, input.ref.id), isNull(employeeJobTemplates.archivedAt)),
          )
          .returning({ id: employeeJobTemplates.id })
        if (updated.length !== 1) throw jobTemplateNotFound(input.ref.id)
      })
    },

    async getJobTemplateRevision(ref) {
      const row = (
        await db
          .select()
          .from(employeeJobTemplateRevisions)
          .where(
            and(
              eq(employeeJobTemplateRevisions.templateId, ref.id),
              eq(employeeJobTemplateRevisions.revision, ref.revision),
            ),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : toJobTemplateRevision(row)
    },

    async getEmployeeDefinition(id) {
      const row = (
        await db.select().from(employeeDefinitions).where(eq(employeeDefinitions.id, id)).limit(1)
      )[0]
      return row === undefined ? null : toEmployee(row)
    },

    async getEmployeeDefinitionAcl(id) {
      const row = (
        await db
          .select({
            id: employeeDefinitions.id,
            name: employeeDefinitions.name,
            ownerUserId: employeeDefinitions.ownerUserId,
            visibility: employeeDefinitions.visibility,
            archivedAt: employeeDefinitions.archivedAt,
          })
          .from(employeeDefinitions)
          .where(eq(employeeDefinitions.id, id))
          .limit(1)
      )[0]
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
      const rows = await db.select().from(employeeDefinitions).where(where)
      return rows.map(toEmployee).sort((a, b) => a.name.localeCompare(b.name))
    },

    async saveEmployeeDefinition(input) {
      try {
        await session.transaction(async (tx) => {
          if (input.definitionMutation.kind === 'update') {
            // 先判 identity（同一谓词：存在、类型未变、未归档）：revision / work scope 表带 FK，缺席行直接插会以
            // 驱动错误而不是 typed 404 收场。
            const update = input.definitionMutation
            const current = (
              await tx
                .select({ id: employeeDefinitions.id })
                .from(employeeDefinitions)
                .where(
                  and(
                    eq(employeeDefinitions.id, input.revision.ref.id),
                    eq(employeeDefinitions.typeId, update.expectedTypeRef.typeId),
                    eq(employeeDefinitions.typeRevision, update.expectedTypeRef.revision),
                    isNull(employeeDefinitions.archivedAt),
                  ),
                )
                .limit(1)
            )[0]
            if (current === undefined) {
              throw new NotFoundError(
                'employee-definition-not-found',
                `employee not found or changed while saving: ${input.revision.ref.id}`,
              )
            }
          }
          if (input.definitionMutation.kind === 'create') {
            const record = input.definitionMutation.record
            await tx.insert(employeeDefinitions).values({
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
          }
          await tx.insert(employeeWorkScopeRevisions).values({
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
          await tx.insert(employeeDefinitionRevisions).values({
            employeeId: input.revision.ref.id,
            revision: input.revision.ref.revision,
            contentJson: JSON.stringify(input.revision.content),
            contentDigest: input.revision.contentDigest,
            createdAt: input.revision.createdAt,
            createdBy: input.revision.createdBy,
          })
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
            if (updated.length !== 1) {
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

    async getEmployeeDefinitionRevision(ref) {
      const row = (
        await db
          .select()
          .from(employeeDefinitionRevisions)
          .where(
            and(
              eq(employeeDefinitionRevisions.employeeId, ref.id),
              eq(employeeDefinitionRevisions.revision, ref.revision),
            ),
          )
          .limit(1)
      )[0]
      return row === undefined ? null : toEmployeeRevision(row)
    },

    async getWorkScopeRevision(ref) {
      const row = (
        await db
          .select()
          .from(employeeWorkScopeRevisions)
          .where(
            and(
              eq(employeeWorkScopeRevisions.scopeId, ref.id),
              eq(employeeWorkScopeRevisions.revision, ref.revision),
            ),
          )
          .limit(1)
      )[0]
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
      const current = (
        await db
          .select({ revision: employeeOsSettings.executionPolicyRevision })
          .from(employeeOsSettings)
          .where(eq(employeeOsSettings.singletonKey, 'global'))
          .limit(1)
      )[0]
      if (current === undefined) return null
      const row = (
        await db
          .select()
          .from(employeeExecutionPolicyRevisions)
          .where(eq(employeeExecutionPolicyRevisions.revision, current.revision))
          .limit(1)
      )[0]
      return row === undefined ? null : toExecutionPolicy(row)
    },

    async getExecutionPolicyRevision(revision) {
      const row = (
        await db
          .select()
          .from(employeeExecutionPolicyRevisions)
          .where(eq(employeeExecutionPolicyRevisions.revision, revision))
          .limit(1)
      )[0]
      return row === undefined ? null : toExecutionPolicy(row)
    },

    async ensureExecutionPolicy(input) {
      return await session.transaction(async (tx) => {
        await session.engine.lockAggregateRoot(
          tx,
          employeeOsSettings,
          employeeOsSettings.singletonKey,
          'global',
        )
        const current = (
          await tx
            .select({ revision: employeeOsSettings.executionPolicyRevision })
            .from(employeeOsSettings)
            .where(eq(employeeOsSettings.singletonKey, 'global'))
            .limit(1)
        )[0]
        if (current !== undefined) {
          const row = (
            await tx
              .select()
              .from(employeeExecutionPolicyRevisions)
              .where(eq(employeeExecutionPolicyRevisions.revision, current.revision))
              .limit(1)
          )[0]
          if (row !== undefined && row.contentDigest === input.contentDigest) {
            return toExecutionPolicy(row)
          }
        }
        const revision = (current?.revision ?? 0) + 1
        await tx.insert(employeeExecutionPolicyRevisions).values({
          revision,
          contentJson: JSON.stringify(input.content),
          contentDigest: input.contentDigest,
          publishedAt: input.publishedAt,
          publishedBy: input.publishedBy,
        })
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
        return { revision, ...input }
      })
    },
  }
}
