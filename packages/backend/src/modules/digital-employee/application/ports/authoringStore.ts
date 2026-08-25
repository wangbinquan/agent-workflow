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

export interface DigitalEmployeeAuthoringStore {
  ensureTypePackage(input: TypePackageRecord): void
  listTypePackageRegistrations(): TypePackageRegistrationRecord[]
  /**
   * Raw immutable descriptors for schema-tolerant bootstrap projections.
   *
   * A historical row can predate the current authoring schema while still
   * carrying the minimal work-item contract needed by a compatibility
   * catalog. Callers that need current authoring semantics must continue to
   * use list/getTypePackages, which parse the full descriptor.
   */
  listTypePackageDescriptorJsons(): string[]
  listTypePackages(): TypePackageRecord[]
  getTypePackage(ref: EmployeeTypeRef): TypePackageRecord | null

  createTool(input: ToolDraftRecord): void
  updateToolValidation(
    id: string,
    content: ToolRegistrationContent,
    receipt: ToolValidationReceipt,
    updatedAt: number,
  ): void
  getTool(id: string): ToolDraftRecord | null
  listTools(typeRef: EmployeeTypeRef, workItemRef: string): ToolDraftRecord[]
  publishTool(input: ToolRevisionRecord): void
  getToolRevision(ref: ExactResourceRef): ToolRevisionRecord | null
  retireTool(id: string, retiredAt: number): void

  createJobTemplate(input: JobTemplateRecord): void
  updateJobTemplate(id: string, name: string, draft: EmployeeJobTemplateContent, now: number): void
  getJobTemplate(id: string): JobTemplateRecord | null
  listJobTemplates(typeRef: EmployeeTypeRef): JobTemplateRecord[]
  listJobTemplatesByTypeId(typeId: string): JobTemplateRecord[]
  publishJobTemplate(input: JobTemplateRevisionRecord): void
  getJobTemplateRevision(ref: ExactResourceRef): JobTemplateRevisionRecord | null

  getEmployeeDefinition(id: string): EmployeeDefinitionRecord | null
  /**
   * RFC-317 T8 —— 只取行级 ACL 三元组，**不解析配置内容**。
   *
   * `getEmployeeDefinition` 会把 `configuration_json` zod 解析成完整草稿；对一行
   * 尚未完成、或存储内容随 schema 漂移到解析不了的员工定义，它会抛。授权判据不能
   * 依赖内容可解析——否则那样的行会从「谁都改不动」退化成 500，甚至绕过判据。
   */
  getEmployeeDefinitionAcl(id: string): {
    readonly id: string
    /** RFC-324 —— 改名围栏要比对「事务外看到的当前名字」，这是同一行上的零成本一列。 */
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly archivedAt: number | null
  } | null
  listEmployeeDefinitions(typeRef?: EmployeeTypeRef): EmployeeDefinitionRecord[]
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
  }): void
  getEmployeeDefinitionRevision(ref: ExactResourceRef): EmployeeDefinitionRevisionRecord | null
  getWorkScopeRevision(ref: ExactResourceRef): WorkScopeRevisionRecord | null

  getCurrentExecutionPolicy(): ExecutionPolicyRevisionRecord | null
  getExecutionPolicyRevision(revision: number): ExecutionPolicyRevisionRecord | null
  ensureExecutionPolicy(
    input: Omit<ExecutionPolicyRevisionRecord, 'revision'>,
  ): ExecutionPolicyRevisionRecord
}
