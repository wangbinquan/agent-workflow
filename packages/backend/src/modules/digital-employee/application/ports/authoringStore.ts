import type {
  DigitalEmployeeDefinitionContent,
  DigitalEmployeeDefinitionDraft,
  EmployeeJobTemplateContent,
  EmployeeTypePackageDescriptor,
  EmployeeTypeRef,
  ExactResourceRef,
  GlobalExecutionPolicy,
  ToolRegistrationContent,
  ToolValidationReceipt,
} from '../../domain/model'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

export interface TypePackageRecord {
  readonly descriptor: EmployeeTypePackageDescriptor
  readonly descriptorDigest: string
  readonly state: 'published' | 'retired'
  readonly registeredAt: number
}

/**
 * Schema-independent projection of a frozen type package row.
 *
 * Draft-overlay startup must be able to identify a same-revision descriptor
 * drift before parsing descriptor JSON with the current schema. The durable
 * descriptor remains available through get/listTypePackages for normal reads.
 */
export interface TypePackageRegistrationRecord {
  readonly typeRef: EmployeeTypeRef
  readonly descriptorDigest: string
  readonly state: 'published' | 'retired'
  readonly registeredAt: number
}

export interface ToolDraftRecord {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly workItemRef: string
  readonly content: ToolRegistrationContent
  readonly validationReceipt: ToolValidationReceipt
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  /** RFC-330 —— 第 14 类 ACL 资源的可见性；平台目录项恒 'public'。 */
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly retiredAt: number | null
  /** Platform catalog entries are immutable projections, never user drafts. */
  readonly origin?: 'custom' | 'platform'
  /** Automatic entries explain platform behavior but cannot be bound by a job. */
  readonly selection?: 'selectable' | 'automatic'
}

export interface ToolRevisionRecord {
  readonly ref: ExactResourceRef
  readonly content: ToolRegistrationContent
  readonly contentDigest: string
  readonly validationReceipt: ToolValidationReceipt
  readonly state: 'published' | 'retired'
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface DigitalEmployeePlatformToolCatalog {
  list(typeRef: EmployeeTypeRef, workItemRef: string): readonly ToolDraftRecord[]
  getRevision(ref: ExactResourceRef): ToolRevisionRecord | null
  resolveCompatibleRevision(input: {
    readonly sourceRef: ExactResourceRef
    readonly targetTypeRef: EmployeeTypeRef
    readonly workItemRef: string
  }): ToolRevisionRecord | null
  isPlatformTool(toolId: string): boolean
}

export const EMPTY_DIGITAL_EMPLOYEE_PLATFORM_TOOL_CATALOG: DigitalEmployeePlatformToolCatalog = {
  list: () => [],
  getRevision: () => null,
  resolveCompatibleRevision: () => null,
  isPlatformTool: () => false,
}

export interface JobTemplateRecord {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly name: string
  readonly draft: EmployeeJobTemplateContent
  readonly publishedRevision: number | null
  readonly ownerUserId: string | null
  /** RFC-330 —— 第 15 类 ACL 资源的可见性。 */
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

export interface JobTemplateRevisionRecord {
  readonly ref: ExactResourceRef
  readonly content: EmployeeJobTemplateContent
  readonly contentDigest: string
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface EmployeeDefinitionRecord {
  readonly id: string
  readonly name: string
  readonly typeRef: EmployeeTypeRef
  readonly configuration: DigitalEmployeeDefinitionDraft
  /**
   * Exact immutable revision used by every new Case. Null is read compatibility
   * for incomplete definitions created before save became atomic; current
   * authoring commands never create or return that state.
   */
  readonly currentRevision: number | null
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
  readonly archivedAt: number | null
}

export interface EmployeeDefinitionRevisionRecord {
  readonly ref: ExactResourceRef
  readonly content: DigitalEmployeeDefinitionContent
  readonly contentDigest: string
  readonly createdAt: number
  readonly createdBy: string | null
}

export interface WorkScopeRevisionRecord {
  readonly ref: ExactResourceRef
  readonly typeRef: EmployeeTypeRef
  readonly encodedScope: unknown
  readonly displaySummary: string
  readonly contentDigest: string
  readonly createdAt: number
  readonly createdBy: string | null
}

export interface ExecutionPolicyRevisionRecord {
  readonly revision: number
  readonly content: GlobalExecutionPolicy
  readonly contentDigest: string
  readonly publishedAt: number
  readonly publishedBy: string | null
}

export interface DigitalEmployeeAclIdentityMutationRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly aclRevision: number
}

/**
 * RFC-359 W4-D6c —— owner 在 resource-catalog 的目录写事务里交出的 identity 行（与目录的
 * `ResourceAclIdentityMutation` 结构同形，bootstrap 处结构装配）：撞名判定与写回都绑定同一个统一事务句柄，
 * `update` 以 aclRevision 为 CAS（false = 有人先写了），目录据此回滚整笔事务。
 */
export interface DigitalEmployeeAclIdentityMutation {
  readonly current: DigitalEmployeeAclIdentityMutationRow
  readonly ownerNameIsUnique: boolean
  hasOwnerNameCollision(nextOwnerUserId: string): Promise<boolean>
  update(input: {
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly aclRevision: number
    readonly updatedAt: number
  }): Promise<boolean>
}

export type DigitalEmployeeAclIdentityType =
  | 'employee_definition'
  | 'employee_tool'
  | 'employee_job_template'

export interface DigitalEmployeeAclIdentityPersistence {
  readonly type: DigitalEmployeeAclIdentityType
  getRevision(resourceId: string): Promise<number>
  loadForMutation(
    transaction: DatabaseTransaction,
    resourceId: string,
  ): Promise<DigitalEmployeeAclIdentityMutation | undefined>
}

export interface DigitalEmployeeAclIdentities {
  readonly employeeDefinition: DigitalEmployeeAclIdentityPersistence
  readonly employeeTool: DigitalEmployeeAclIdentityPersistence
  readonly employeeJobTemplate: DigitalEmployeeAclIdentityPersistence
}

/** Live provider contract：两个 provider 同一份实现，只有异步形态（RFC-359 W4-D6c）。 */
export interface DigitalEmployeeAuthoringPersistence {
  ensureTypePackage(input: TypePackageRecord): Promise<void>
  listTypePackageRegistrations(): Promise<TypePackageRegistrationRecord[]>
  /**
   * Raw immutable descriptors for schema-tolerant bootstrap projections.
   *
   * A historical row can predate the current authoring schema while still
   * carrying the minimal work-item contract needed by a compatibility
   * catalog. Callers that need current authoring semantics must continue to
   * use list/getTypePackages, which parse the full descriptor.
   */
  listTypePackageDescriptorJsons(): Promise<string[]>
  listTypePackages(): Promise<TypePackageRecord[]>
  getTypePackage(ref: EmployeeTypeRef): Promise<TypePackageRecord | null>

  createTool(input: ToolDraftRecord): Promise<void>
  updateToolValidation(
    id: string,
    content: ToolRegistrationContent,
    receipt: ToolValidationReceipt,
    updatedAt: number,
  ): Promise<void>
  getTool(id: string): Promise<ToolDraftRecord | null>
  /**
   * RFC-330 —— 只读 ACL 窄查询（与 getEmployeeDefinitionAcl 同理由）：不解析
   * draft_json，对任何存在的行都可答；retired 行仍返回，由调用方决定是否视为消失。
   */
  getToolAcl(id: string): Promise<{
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly retiredAt: number | null
  } | null>
  listTools(typeRef: EmployeeTypeRef, workItemRef: string): Promise<ToolDraftRecord[]>
  publishTool(input: ToolRevisionRecord): Promise<void>
  getToolRevision(ref: ExactResourceRef): Promise<ToolRevisionRecord | null>
  retireTool(id: string, retiredAt: number): Promise<void>

  createJobTemplate(input: JobTemplateRecord): Promise<void>
  updateJobTemplate(
    id: string,
    name: string,
    draft: EmployeeJobTemplateContent,
    now: number,
  ): Promise<void>
  getJobTemplate(id: string): Promise<JobTemplateRecord | null>
  /** RFC-330 —— 岗位模版的只读 ACL 窄查询（同上）。 */
  getJobTemplateAcl(id: string): Promise<{
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly archivedAt: number | null
  } | null>
  listJobTemplates(typeRef: EmployeeTypeRef): Promise<JobTemplateRecord[]>
  listJobTemplatesByTypeId(typeId: string): Promise<JobTemplateRecord[]>
  publishJobTemplate(input: JobTemplateRevisionRecord): Promise<void>
  getJobTemplateRevision(ref: ExactResourceRef): Promise<JobTemplateRevisionRecord | null>

  getEmployeeDefinition(id: string): Promise<EmployeeDefinitionRecord | null>
  /**
   * RFC-317 T8 —— 只取行级 ACL 三元组，**不解析配置内容**。
   *
   * `getEmployeeDefinition` 会把 `configuration_json` zod 解析成完整草稿；对一行
   * 尚未完成、或存储内容随 schema 漂移到解析不了的员工定义，它会抛。授权判据不能
   * 依赖内容可解析——否则那样的行会从「谁都改不动」退化成 500，甚至绕过判据。
   */
  getEmployeeDefinitionAcl(id: string): Promise<{
    readonly id: string
    /** RFC-324 —— 改名围栏要比对「事务外看到的当前名字」，这是同一行上的零成本一列。 */
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly archivedAt: number | null
  } | null>
  listEmployeeDefinitions(typeRef?: EmployeeTypeRef): Promise<EmployeeDefinitionRecord[]>
  saveEmployeeDefinition(input: {
    revision: EmployeeDefinitionRevisionRecord
    workScope: WorkScopeRevisionRecord
    definitionMutation:
      | {
          readonly kind: 'create'
          readonly record: EmployeeDefinitionRecord
        }
      | {
          readonly kind: 'update'
          readonly expectedTypeRef: EmployeeTypeRef
          readonly targetTypeRef: EmployeeTypeRef
          readonly name: string
          readonly configuration: DigitalEmployeeDefinitionDraft
          readonly updatedAt: number
        }
  }): Promise<void>
  getEmployeeDefinitionRevision(
    ref: ExactResourceRef,
  ): Promise<EmployeeDefinitionRevisionRecord | null>
  getWorkScopeRevision(ref: ExactResourceRef): Promise<WorkScopeRevisionRecord | null>

  getCurrentExecutionPolicy(): Promise<ExecutionPolicyRevisionRecord | null>
  getExecutionPolicyRevision(revision: number): Promise<ExecutionPolicyRevisionRecord | null>
  ensureExecutionPolicy(
    input: Omit<ExecutionPolicyRevisionRecord, 'revision'>,
  ): Promise<ExecutionPolicyRevisionRecord>
}

/** infrastructure 交出的完整适配器：作者面持久化 + 交给 resource-catalog 的 ACL identity 面。 */
export interface DigitalEmployeeAuthoringAdapter extends DigitalEmployeeAuthoringPersistence {
  readonly resourceAclIdentities: DigitalEmployeeAclIdentities
}
