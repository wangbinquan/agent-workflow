import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { DbTxSync } from '@/db/txSync'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import type { EventCenterParticipant } from '@/modules/event-center/public/participants'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import {
  DigitalEmployeeAuthoringService,
  type AutomaticTypeUpgradeIssue,
} from './application/authoringService'
import { DigitalEmployeeRuntimeService } from './application/runtimeService'
import type {
  EmployeeInputArtifactPort,
  EmployeeRetryLimitsPort,
  ProgramArtifactPort,
  PlatformWorkItemExecutionPort,
  ReactionExecutionPort,
  ToolConnectionCatalogPort,
  ToolConnectionVisibilitySubject,
} from './composition/required-ports'
import { createProgramArtifactStore } from './infrastructure/programArtifactStore'
import { createSqliteReactionRoundQueries } from './infrastructure/sqliteReactionRoundQueries'
import { createPostgresqlReactionRoundQueries } from './infrastructure/postgresqlReactionRoundQueries'
import type { EmployeeReactionRoundQueryPort } from './public/types'
import { createEmployeeInputArtifactStore } from './infrastructure/inputArtifactStore'
import { createSqliteEmployeeInputUploadPersistence } from './infrastructure/inputUploadStore'
import type {
  EmployeeInputUploadPersistence,
  EmployeeInputUploadRecord,
} from './application/ports/inputUploadStore'
import {
  asAsyncDigitalEmployeeAuthoringPersistence,
  createSqliteDigitalEmployeeAuthoringStore,
} from './infrastructure/sqliteAuthoringStore'
import { createPostgresqlDigitalEmployeeAuthoringPersistence } from './infrastructure/postgresqlAuthoringStore'
import type {
  DigitalEmployeeAuthoringPersistence,
  DigitalEmployeeAuthoringStore,
} from './application/ports/authoringStore'
import { withTypePackageDraftOverlay } from './application/typePackageDraftOverlay'
import { createSqliteRuntimePersistence } from './infrastructure/sqliteRuntimeStore'
import { createPostgresqlRuntimePersistence } from './infrastructure/postgresqlRuntimeStore'
import type { RuntimeCasePersistence } from './application/ports/runtimeStore'
import { createPostgresqlEmployeeInputUploadPersistence } from './infrastructure/postgresqlInputUploadStore'
import {
  createDigitalEmployeeWriterCutoverOperations,
  type DigitalEmployeeMigrationStatus,
  type DigitalEmployeeWriterCutoverOperations,
} from './composition/writerCutover'
import {
  createPostgresqlDigitalEmployeeWriterCutoverPersistence,
  createSqliteDigitalEmployeeWriterCutoverPersistence,
} from './infrastructure/writerCutoverPersistence'
import { z } from 'zod'
import {
  contractValidationCheckSchema,
  employeeTypePackageDescriptorSchema,
  workContractSchema,
} from './domain/model'
import {
  employeeTypeRefSchema,
  exactResourceRefSchema,
  toolRegistrationContentSchema,
  toolValidationReceiptSchema,
} from './domain/model'
import type {
  CreateToolRegistrationBody,
  DigitalEmployeeDefinitionContent,
  DigitalEmployeeDefinitionDraft,
  EmployeeAuthoringManifest,
  EmployeeJobTemplateContent,
  EmployeeTypePackageDescriptor,
  EmployeeTypeRef,
  EmployeeTypeRuntimePackage,
  ExactResourceRef,
  GlobalExecutionPolicy,
  LaneAdapterBinding,
  ToolRegistrationContent,
  ToolValidationReceipt,
} from './domain/model'
import type {
  EmployeeCaseDetailProjectionParticipant,
  EmployeeCaseLaunchInput,
  EmployeeCaseProjectionDocument,
  EmployeeTypePackageRegistration,
  EmployeeTypeCollaborationCodec,
  EmployeeTypeContextCodec,
  EmployeeTypeReactionCodec,
} from './public/types'
import type { DigitalEmployeePlatformToolCatalogParticipant } from './public/types'
import type { DigitalEmployeePlatformToolCatalog } from './application/ports/authoringStore'
import type { DigitalEmployeeMaintenanceCommands } from './public/commands'
import type {
  DigitalEmployeePlatformInventoryParticipant,
  DigitalEmployeePlatformInventoryResourceType,
  DigitalEmployeePlatformInventoryRow,
} from './public/participants'
import {
  createSqliteDigitalEmployeeIntegrationTriggerParticipant,
  createSqliteDigitalEmployeeIntegrationTriggerParticipantSync,
} from './infrastructure/sqliteIntegrationTriggerParticipant'

export { createPostgresqlDigitalEmployeeIntegrationTriggerParticipant } from './infrastructure/postgresqlIntegrationTriggerParticipant'

export { createReactionExecutionAdapter } from './application/adapters/task-execution-adapter'
export { composeDigitalEmployeeTaskCatalogSource } from './application/adapters/task-catalog-adapter'
export { runDigitalEmployeeOsCycle, startDigitalEmployeeOsWorker } from './application/osWorker'
export { composeDigitalEmployeeAgentTemplateCatalogParticipant } from './composition/agentTemplateCatalog'
export type {
  DigitalEmployeeMigrationStatus,
  DigitalEmployeeWriterCutoverOperations,
  DigitalEmployeeWriterState,
} from './composition/writerCutover'
export { createEmployeeInputArtifactStore } from './infrastructure/inputArtifactStore'

/** Worker-bootstrap composition for the context-owned temporary-input cleanup. */
export function composeDigitalEmployeeMaintenanceCommands(
  db: DbClient,
): DigitalEmployeeMaintenanceCommands {
  const uploads = createSqliteEmployeeInputUploadPersistence(db)
  return {
    sweepExpiredInputUploads: (now, limit) => uploads.sweepExpired(now, limit),
  }
}

export function composePostgresqlDigitalEmployeeMaintenanceCommands(
  db: PostgresqlDatabaseClient,
): DigitalEmployeeMaintenanceCommands {
  const uploads = createPostgresqlEmployeeInputUploadPersistence(db)
  return {
    sweepExpiredInputUploads: (now, limit) => uploads.sweepExpired(now, limit),
  }
}

export function composeSqliteDigitalEmployeeWriterCutover(
  db: DbClient,
): DigitalEmployeeWriterCutoverOperations {
  return createDigitalEmployeeWriterCutoverOperations(
    createSqliteDigitalEmployeeWriterCutoverPersistence(db),
  )
}

export function composePostgresqlDigitalEmployeeWriterCutover(
  db: PostgresqlDatabaseClient,
): DigitalEmployeeWriterCutoverOperations {
  return createDigitalEmployeeWriterCutoverOperations(
    createPostgresqlDigitalEmployeeWriterCutoverPersistence(db),
  )
}

/** Bootstrap projection owned by Digital Employee; consumers never read its tables directly. */
export function readPersistedDigitalEmployeeTypePackageDescriptorJsons(
  db: DbClient,
): readonly string[] {
  return createSqliteDigitalEmployeeAuthoringStore(db).listTypePackageDescriptorJsons()
}

/** Bootstrap consumes this provider-neutral async projection, never a database handle. */
export interface DigitalEmployeeBootstrapReads {
  listTypePackageDescriptorJsons(): Promise<readonly string[]>
}

export function composeSqliteDigitalEmployeeBootstrapReads(
  db: DbClient,
): DigitalEmployeeBootstrapReads {
  const authoring = asAsyncDigitalEmployeeAuthoringPersistence(
    createSqliteDigitalEmployeeAuthoringStore(db),
  )
  return Object.freeze({
    listTypePackageDescriptorJsons: () => authoring.listTypePackageDescriptorJsons(),
  })
}

export function composePostgresqlDigitalEmployeeBootstrapReads(
  db: PostgresqlDatabaseClient,
): DigitalEmployeeBootstrapReads {
  const authoring = createPostgresqlDigitalEmployeeAuthoringPersistence(db)
  return Object.freeze({
    listTypePackageDescriptorJsons: () => authoring.listTypePackageDescriptorJsons(),
  })
}

/**
 * Owner composition for the integration-trigger snapshot participant.
 *
 * Persistence closures stay inside the Digital Employee owner. Resource Catalog
 * receives only the branded, data-only participant and therefore cannot import
 * employee tables, authoring stores, or schema-shaped rows.
 */
export function composeDigitalEmployeeIntegrationTriggerParticipant(tx: DbTxSync) {
  return createSqliteDigitalEmployeeIntegrationTriggerParticipantSync(tx)
}

export function composeAsyncDigitalEmployeeIntegrationTriggerParticipant(tx: DbTxSync) {
  return createSqliteDigitalEmployeeIntegrationTriggerParticipant(tx)
}

type EmployeeTypeRuntimeCodec = EmployeeTypeContextCodec &
  EmployeeTypeReactionCodec &
  EmployeeTypeCollaborationCodec

export interface ToolRegistrationView {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly workItemRef: string
  readonly content: ToolRegistrationContent
  readonly validationReceipt: ToolValidationReceipt
  readonly publishedRevision: number | null
  readonly state: 'draft' | 'published' | 'retired'
  readonly origin: 'custom' | 'platform'
  readonly editable: boolean
  readonly selection: 'selectable' | 'automatic'
  /** RFC-330 —— 行级 ACL 事实（判据留在 transport，与员工定义同形）；平台工具恒 public / null。 */
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ToolAuthoringView extends ToolRegistrationView {
  readonly body: CreateToolRegistrationBody
}

export interface JobTemplateView {
  readonly id: string
  readonly typeRef: EmployeeTypeRef
  readonly name: string
  readonly draft: EmployeeJobTemplateContent
  readonly publishedRevision: number | null
  /** RFC-330 —— 行级 ACL 事实（判据留在 transport）。 */
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeDefinitionView {
  readonly id: string
  readonly name: string
  readonly typeRef: EmployeeTypeRef
  readonly configuration: DigitalEmployeeDefinitionDraft
  readonly revision: number
  readonly definition: DigitalEmployeeDefinitionContent
  /** Defaults from the exact immutable job revision referenced by configuration.jobTemplateRef. */
  readonly inheritedAdapterBindings: readonly LaneAdapterBinding[]
  /** Secret-free provenance for every exact binding in the compiled employee closure. */
  readonly adapterBindingSources: readonly (LaneAdapterBinding & {
    readonly source: 'job-default' | 'employee-override'
  })[]
  /** Exact decoded scope frozen into the current employee revision. */
  readonly workScope: unknown
  /**
   * RFC-317 T8 —— 行级 ACL 事实。表自建起就有这两列，但它们此前不出现在视图里，
   * 于是 transport 层根本没有可判可见性的输入（findings.md ACL-02）。
   * 判据本身仍留在 transport（`filterVisibleRows` / `requireResourceOwner`），
   * 与其余 12 类同形——ACL 不下沉进本模块。
   */
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ExecutionPolicyView {
  readonly revision: number
  readonly content: GlobalExecutionPolicy
  readonly contentDigest: string
  readonly publishedAt: number
}

export interface DigitalEmployeeCommands {
  createTool(input: {
    readonly typeRef: EmployeeTypeRef
    readonly workItemRef: string
    readonly body: unknown
    readonly actorUserId: string | null
  }): Promise<ToolRegistrationView>
  updateTool(
    input: Parameters<DigitalEmployeeAuthoringService['updateTool']>[0],
  ): Promise<ToolRegistrationView>
  validateTool(
    input: Parameters<DigitalEmployeeAuthoringService['validateTool']>[0],
  ): Promise<ToolRegistrationView>
  publishTool(
    input: Parameters<DigitalEmployeeAuthoringService['publishTool']>[0],
  ): Promise<ExactResourceRef>
  retireTool(input: Parameters<DigitalEmployeeAuthoringService['retireTool']>[0]): Promise<void>
  createJobTemplate(input: {
    readonly typeRef: EmployeeTypeRef
    readonly body: unknown
    readonly actorUserId: string | null
    readonly adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): Promise<JobTemplateView>
  updateJobTemplate(
    input: Parameters<DigitalEmployeeAuthoringService['updateJobTemplate']>[0],
  ): Promise<JobTemplateView>
  publishJobTemplate(
    input: Parameters<DigitalEmployeeAuthoringService['publishJobTemplate']>[0],
  ): Promise<ExactResourceRef>
  createEmployee(input: {
    readonly typeRef: EmployeeTypeRef
    readonly body: unknown
    readonly actorUserId: string | null
    readonly adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): Promise<EmployeeDefinitionView>
  updateEmployee(input: {
    readonly id: string
    readonly body: unknown
    readonly actorUserId: string | null
    readonly adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): Promise<EmployeeDefinitionView>
}

export interface DigitalEmployeeQueries {
  listTypes(): Promise<EmployeeTypePackageDescriptor[]>
  getType(ref: EmployeeTypeRef): Promise<EmployeeTypePackageDescriptor>
  getAuthoringManifest(ref: EmployeeTypeRef): Promise<EmployeeAuthoringManifest>
  listTools(ref: EmployeeTypeRef, workItemRef: string): Promise<ToolRegistrationView[]>
  getToolAuthoring(
    input: Parameters<DigitalEmployeeAuthoringService['getToolAuthoring']>[0],
  ): Promise<ToolAuthoringView>
  listJobTemplates(ref: EmployeeTypeRef): Promise<JobTemplateView[]>
  listEmployees(ref?: EmployeeTypeRef): Promise<EmployeeDefinitionView[]>
  listLaunchableEmployees(): Promise<EmployeeDefinitionView[]>
  getEmployee(id: string): Promise<EmployeeDefinitionView>
  /**
   * RFC-317 T8 —— 只读 ACL 三元组的**窄查询**。
   *
   * 为什么不复用 `getEmployee`：那个视图要物化 current revision 与 work scope，
   * 对「还没有 current revision」的行会抛；而 ACL 判据必须对**任何存在的行**都能
   * 作答（否则半成品行会变成「谁都改得动」）。也不让 transport 直接查
   * `employee_definitions` 表——那是跨界读模块私表，正是 RFC-317 R5 要禁的形态。
   */
  getEmployeeAcl(id: string): Promise<{
    readonly id: string
    /** RFC-324 —— 供改名围栏比对；仍是同一条窄查询，不物化 revision。 */
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
  } | null>
  /**
   * RFC-330 —— 工具的只读 ACL 窄查询。平台目录工具没有 DB 行：投影为
   * `builtin: true` / public / 无 owner（D9），transport 据此让 `/acl` 404、写 403。
   * retired 行仍返回（retiredAt 非空），由调用方决定是否视为消失。
   */
  getToolAcl(id: string): Promise<{
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly builtin: boolean
    readonly retiredAt: number | null
  } | null>
  /** RFC-330 —— 岗位模版的只读 ACL 窄查询；archived 视为消失（返回 null）。 */
  getJobTemplateAcl(id: string): Promise<{
    readonly id: string
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
  } | null>
  getExecutionPolicy(): Promise<ExecutionPolicyView>
  getMigrationStatus(): Promise<DigitalEmployeeMigrationStatus>
}

export interface DigitalEmployeeModule {
  readonly commands: DigitalEmployeeCommands
  readonly queries: DigitalEmployeeQueries
  readonly maintenance: {
    /** Bootstrap-only async validation for changed WorkContract successors. */
    settleAutomaticUpgrades(): Promise<void>
  }
  readonly inputUploads: {
    create(input: {
      readonly absolutePath: string
      readonly originalName: string
      readonly actorUserId: string | null
      readonly idempotencyKey: string | null
    }): Promise<EmployeeInputUploadRecord>
    delete(uploadRef: string, actorUserId: string | null): Promise<void>
    sweepExpired(): Promise<number>
  }
  readonly runtime: {
    readonly commands: {
      launch(input: EmployeeCaseLaunchInput): Promise<EmployeeCaseProjectionDocument>
      launchWork(input: {
        readonly employeeId: string
        readonly intake: unknown
        readonly actorUserId: string | null
        readonly eventOrigin?: {
          readonly eventSubscriptionId: string
          readonly eventDeliveryId: string
        }
      }): Promise<EmployeeCaseProjectionDocument>
      previewPolicyUpgrade(caseId: string, targetPolicyRevision: number): Promise<string>
      applyPolicyUpgrade(previewToken: string): Promise<EmployeeCaseProjectionDocument>
      terminate(caseId: string, terminalKind: string): Promise<EmployeeCaseProjectionDocument>
      resume(caseId: string): Promise<EmployeeCaseProjectionDocument>
      /** RFC-330 D19/D20 —— 同一事务内改 owner + 全量替换成员；输入已由调用方规范化。 */
      replaceCaseMembers(
        input: Parameters<DigitalEmployeeRuntimeService['replaceCaseMembers']>[0],
      ): ReturnType<DigitalEmployeeRuntimeService['replaceCaseMembers']>
    }
    readonly queries: {
      getCase(caseId: string): Promise<EmployeeCaseProjectionDocument>
      /** RFC-330 —— 案例归属窄查询；不存在 ⇒ null（transport 给出与不可见同形的 404）。 */
      getCaseAcl(caseId: string): ReturnType<DigitalEmployeeRuntimeService['getCaseAcl']>
      /** RFC-330 —— apply 前解出 preview token 指向的案例 id（完整校验仍在 apply）。 */
      peekPolicyUpgradeCaseId(previewToken: string): string
      listCaseMembers(caseId: string): ReturnType<DigitalEmployeeRuntimeService['listCaseMembers']>
      getCaseMemberRole(
        caseId: string,
        userId: string,
      ): ReturnType<DigitalEmployeeRuntimeService['getCaseMemberRole']>
      listCases(employeeId?: string, state?: string): Promise<string>
      listTerminalOutcomeGroups(): Promise<string>
      listCasePage(
        input: Parameters<DigitalEmployeeRuntimeService['listCasePage']>[0],
      ): Promise<string>
      findByExternalSubject(
        subjectType: string,
        subjectRef: string,
      ): Promise<EmployeeCaseProjectionDocument | null>
    }
    readonly worker: {
      runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
      pumpOneDelivery(): Promise<boolean>
      planOneReaction(): Promise<string | null>
      inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
      publishOneChannelResult(): Promise<'completed' | 'idle'>
    }
  } | null
}

export interface DigitalEmployeeCompositionOptions {
  readonly appHome: string
  readonly typePackages: readonly EmployeeTypePackageRegistration[]
  /** Explicit Bun-dev escape hatch; normal start and embedded builds stay immutable. */
  readonly connectionCatalog?: ToolConnectionCatalogPort
  readonly programArtifacts?: ProgramArtifactPort
  readonly inputArtifacts?: EmployeeInputArtifactPort
  readonly executionContracts: ExecutionContractParticipant
  readonly platformTools?: DigitalEmployeePlatformToolCatalogParticipant
  readonly onAutomaticUpgradeIssue?: (issue: AutomaticTypeUpgradeIssue) => void
  /** Read-only projection of Settings -> Limits; never employee-local config. */
  readonly retryLimits?: EmployeeRetryLimitsPort
  /**
   * RFC-317 T41（DE-01）—— 旧 Mission 的排空视图。可选：只有迁移报告用得到它，
   * 没接线时报告说「零条待排空」而不是去猜 development 的表长什么样。
   * 装配方（cli/start.ts）传入 development-automation 的实现。
   */
  readonly runtime?: {
    readonly eventCenter: EventCenterParticipant
    readonly execution: ReactionExecutionPort
    readonly platformWorkItems?: PlatformWorkItemExecutionPort
    readonly codecs: readonly EmployeeTypeRuntimeCodec[]
    readonly detailProjectionParticipants?: readonly EmployeeCaseDetailProjectionParticipant[]
    readonly workerId?: string
  }
  readonly now?: () => number
  readonly id?: () => string
}

export interface ComposeDigitalEmployeeOptions extends DigitalEmployeeCompositionOptions {
  readonly db: DbClient
  /** Explicit Bun-dev escape hatch; normal start and embedded builds stay immutable. */
  readonly typePackageDriftPolicy?: 'reject' | 'draft-overlay'
}

export interface ComposePostgresqlDigitalEmployeeOptions extends DigitalEmployeeCompositionOptions {
  readonly db: PostgresqlDatabaseClient
}

interface DigitalEmployeePersistenceBundle {
  readonly authoring: DigitalEmployeeAuthoringPersistence
  readonly runtime: RuntimeCasePersistence
  readonly inputUploads: EmployeeInputUploadPersistence
  readonly migrationStatus: () => Promise<DigitalEmployeeMigrationStatus>
}

/**
 * RFC-317 T41（DE-02）—— 反应轮次只读查询面的装配入口。
 *
 * 走 composition 而不是让调用方直接 import `infrastructure/`：infrastructure 是本
 * context 的私有实现层，装配面才是对外的那一层。development-automation 与 bootstrap
 * 只认这个工厂与 `public/queries.ts` 里的接口。
 */
export function createEmployeeReactionRoundQueries(db: DbClient): EmployeeReactionRoundQueryPort {
  return createSqliteReactionRoundQueries(db)
}

export function createPostgresqlEmployeeReactionRoundQueries(
  db: PostgresqlDatabaseClient,
): EmployeeReactionRoundQueryPort {
  return createPostgresqlReactionRoundQueries(db)
}

/**
 * RFC-348 —— intent 平台库存（`services/intent/platformInventory.ts`）列出真实数字人行时读的
 * 授权面切片：类型包 / 工具 / 岗位模板 / 员工定义的只读 list。
 *
 * 同 DE-02：调用方只认这个装配工厂，不直接 import `infrastructure/sqliteAuthoringStore`
 * 或 `application/ports/authoringStore`（RFC-310 manifest 只放行 composition / public）。
 * 正解仍是 bootstrap 装配 `IntentPlatformInventory` 后注入，见 commons-debt.json 对应条目。
 */
export type DigitalEmployeeAuthoringReads = Pick<
  DigitalEmployeeAuthoringPersistence,
  | 'listTypePackages'
  | 'listTypePackageDescriptorJsons'
  | 'listTools'
  | 'listJobTemplates'
  | 'listEmployeeDefinitions'
>

/** @deprecated Bootstrap should inject createSqliteDigitalEmployeeAuthoringReads. */
export function createDigitalEmployeeAuthoringReads(
  db: DbClient,
): Pick<
  DigitalEmployeeAuthoringStore,
  | 'listTypePackages'
  | 'listTypePackageDescriptorJsons'
  | 'listTools'
  | 'listJobTemplates'
  | 'listEmployeeDefinitions'
> {
  return createSqliteDigitalEmployeeAuthoringStore(db)
}

export function createSqliteDigitalEmployeeAuthoringReads(
  db: DbClient,
): DigitalEmployeeAuthoringReads {
  return asAsyncDigitalEmployeeAuthoringPersistence(createSqliteDigitalEmployeeAuthoringStore(db))
}

export function createPostgresqlDigitalEmployeeAuthoringReads(
  db: PostgresqlDatabaseClient,
): DigitalEmployeeAuthoringReads {
  return createPostgresqlDigitalEmployeeAuthoringPersistence(db)
}

interface DigitalEmployeePlatformInventoryAclRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
}

/** Selected-provider Resource Catalog authorization face used by this owner adapter. */
export interface DigitalEmployeePlatformInventoryAccess {
  filterVisibleRows<T extends DigitalEmployeePlatformInventoryAclRow>(
    authority: DirectAuthenticatedAuthority,
    type: DigitalEmployeePlatformInventoryResourceType,
    rows: readonly T[],
  ): Promise<T[]>
}

function inventoryText(value: unknown): string | null {
  if (typeof value === 'string') return value.length === 0 ? null : value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ['en', 'en-US', 'zh', 'zh-CN', ...Object.keys(record)]) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return null
}

function sortInventoryRows(
  rows: readonly DigitalEmployeePlatformInventoryRow[],
): DigitalEmployeePlatformInventoryRow[] {
  return [...rows].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  )
}

/**
 * Owner adapter for Intent's three Digital Employee inventory kinds. The
 * selected SQLite/PostgreSQL module supplies the rows and the selected
 * Resource Catalog authorization application filters them before projection.
 */
export function composeDigitalEmployeePlatformInventoryParticipant(input: {
  readonly queries: Pick<
    DigitalEmployeeQueries,
    'listTypes' | 'listTools' | 'listJobTemplates' | 'listEmployees'
  >
  readonly access: DigitalEmployeePlatformInventoryAccess
}): DigitalEmployeePlatformInventoryParticipant {
  const visible = async <T extends DigitalEmployeePlatformInventoryAclRow>(
    type: DigitalEmployeePlatformInventoryResourceType,
    authority: DirectAuthenticatedAuthority,
    rows: readonly T[],
    project: (row: T) => DigitalEmployeePlatformInventoryRow,
  ): Promise<readonly DigitalEmployeePlatformInventoryRow[]> =>
    sortInventoryRows((await input.access.filterVisibleRows(authority, type, rows)).map(project))

  return Object.freeze({
    async listVisibleRows(
      type: DigitalEmployeePlatformInventoryResourceType,
      authority: DirectAuthenticatedAuthority,
    ) {
      if (type === 'employee_definition') {
        return await visible(type, authority, await input.queries.listEmployees(), (row) => {
          return {
            id: row.id,
            name: row.name,
            description: `type ${row.typeRef.typeId}@${row.typeRef.revision}`,
          }
        })
      }

      const packages = await input.queries.listTypes()
      if (type === 'employee_job_template') {
        const rows = (
          await Promise.all(packages.map((item) => input.queries.listJobTemplates(item.typeRef)))
        ).flat()
        return await visible(type, authority, rows, (row) => {
          return {
            id: row.id,
            name: row.name,
            description:
              inventoryText(row.draft.description) ??
              `type ${row.typeRef.typeId}@${row.typeRef.revision}`,
          }
        })
      }

      const rows = new Map<string, ToolRegistrationView>()
      await Promise.all(
        packages.flatMap((item) =>
          item.authoringManifest.workItems.map(async (workItem) => {
            for (const tool of await input.queries.listTools(item.typeRef, workItem.workItemRef)) {
              rows.set(tool.id, tool)
            }
          }),
        ),
      )
      return await visible(type, authority, [...rows.values()], (row) => {
        return {
          id: row.id,
          name: inventoryText(row.content.displayName) ?? row.id,
          description: `${inventoryText(row.content.description) ?? (row.origin === 'platform' ? 'platform tool' : 'custom tool')} (${row.workItemRef})`,
        }
      })
    },
  })
}

function runtimePackageOf(
  registration: EmployeeTypePackageRegistration,
): EmployeeTypeRuntimePackage {
  const descriptor = employeeTypePackageDescriptorSchema.parse(
    JSON.parse(registration.descriptorJson) as unknown,
  )
  const programUpgradeResultSchema = z
    .object({
      runtimeKind: z.enum(['bash', 'node', 'python']),
      source: z.string().min(1).max(5_000_000),
    })
    .strict()
  return {
    descriptor,
    parseWorkScope(input) {
      return JSON.parse(registration.parseWorkScopeJson(JSON.stringify(input))) as unknown
    },
    summarizeWorkScope(scope, locale) {
      return registration.summarizeWorkScopeJson(JSON.stringify(scope), locale)
    },
    validateContractFixture(input) {
      return z
        .array(contractValidationCheckSchema)
        .parse(
          JSON.parse(registration.validateContractFixtureJson(JSON.stringify(input))) as unknown,
        )
    },
    ...(registration.upgradeProgramSourceJson === undefined
      ? {}
      : {
          upgradeProgramSource(input) {
            const request = {
              sourceContract: workContractSchema.parse(input.sourceContract),
              targetContract: workContractSchema.parse(input.targetContract),
              implementation: input.implementation,
              source: input.source,
            }
            const resultJson = registration.upgradeProgramSourceJson!(JSON.stringify(request))
            return resultJson === null
              ? null
              : programUpgradeResultSchema.parse(JSON.parse(resultJson) as unknown)
          },
        }),
  }
}

function toolView(
  record: Awaited<ReturnType<DigitalEmployeeAuthoringService['listTools']>>[number],
): ToolRegistrationView {
  return {
    id: record.id,
    typeRef: record.typeRef,
    workItemRef: record.workItemRef,
    content: record.content,
    validationReceipt: record.validationReceipt,
    publishedRevision: record.publishedRevision,
    state:
      record.retiredAt !== null
        ? 'retired'
        : record.publishedRevision === null
          ? 'draft'
          : 'published',
    origin: record.origin ?? 'custom',
    editable: record.origin !== 'platform',
    selection: record.selection ?? 'selectable',
    ownerUserId: record.origin === 'platform' ? null : record.ownerUserId,
    visibility: record.origin === 'platform' ? 'public' : record.visibility,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

const platformToolDraftSchema = z
  .object({
    id: z.string().min(1).max(500),
    typeRef: employeeTypeRefSchema,
    workItemRef: z.string().min(1).max(160),
    content: toolRegistrationContentSchema,
    validationReceipt: toolValidationReceiptSchema,
    publishedRevision: z.number().int().positive().nullable(),
    ownerUserId: z.string().nullable(),
    // RFC-330 —— 平台目录项没有 ACL 行，恒 public（参与者 JSON 里不带这一列）。
    visibility: z.enum(['private', 'public']).default('public'),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    retiredAt: z.number().int().nonnegative().nullable(),
    origin: z.literal('platform'),
    selection: z.enum(['selectable', 'automatic']),
  })
  .strict()

const platformToolRevisionSchema = z
  .object({
    ref: exactResourceRefSchema,
    content: toolRegistrationContentSchema,
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    validationReceipt: toolValidationReceiptSchema,
    state: z.enum(['published', 'retired']),
    publishedAt: z.number().int().nonnegative(),
    publishedBy: z.string().nullable(),
  })
  .strict()

function platformToolCatalogOf(
  participant: DigitalEmployeePlatformToolCatalogParticipant | undefined,
): DigitalEmployeePlatformToolCatalog {
  if (participant === undefined) {
    return {
      list: () => [],
      getRevision: () => null,
      resolveCompatibleRevision: () => null,
      isPlatformTool: () => false,
    }
  }
  return {
    list(typeRef, workItemRef) {
      return z
        .array(platformToolDraftSchema)
        .parse(JSON.parse(participant.listJson(JSON.stringify(typeRef), workItemRef)) as unknown)
    },
    getRevision(ref) {
      const encoded = participant.getRevisionJson(JSON.stringify(ref))
      return encoded === null
        ? null
        : platformToolRevisionSchema.parse(JSON.parse(encoded) as unknown)
    },
    resolveCompatibleRevision(input) {
      const encoded = participant.resolveCompatibleRevisionJson?.(
        JSON.stringify(input.sourceRef),
        JSON.stringify(input.targetTypeRef),
        input.workItemRef,
      )
      return encoded == null
        ? null
        : platformToolRevisionSchema.parse(JSON.parse(encoded) as unknown)
    },
    isPlatformTool: (toolId) => participant.isPlatformTool(toolId),
  }
}

function jobView(
  record: Awaited<ReturnType<DigitalEmployeeAuthoringService['listJobTemplates']>>[number],
): JobTemplateView {
  return {
    id: record.id,
    typeRef: record.typeRef,
    name: record.name,
    draft: record.draft,
    publishedRevision: record.publishedRevision,
    ownerUserId: record.ownerUserId,
    visibility: record.visibility,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function composeDigitalEmployeeFromPersistence(
  options: DigitalEmployeeCompositionOptions,
  persistence: DigitalEmployeePersistenceBundle,
): DigitalEmployeeModule {
  const store = persistence.authoring
  const inputUploadStore = persistence.inputUploads
  const inputArtifacts =
    options.inputArtifacts ??
    createEmployeeInputArtifactStore(join(options.appHome, 'artifacts', 'employee-inputs'))
  const runtimePackages = options.typePackages.map(runtimePackageOf)
  const platformTools = platformToolCatalogOf(options.platformTools)
  const service = new DigitalEmployeeAuthoringService({
    store,
    typePackages: runtimePackages,
    connectionCatalog: options.connectionCatalog ?? {
      async resolve() {
        return null
      },
    },
    programArtifacts: options.programArtifacts ?? createProgramArtifactStore(options.appHome),
    executionContracts: options.executionContracts,
    platformTools,
    ...(options.onAutomaticUpgradeIssue === undefined
      ? {}
      : { onAutomaticUpgradeIssue: options.onAutomaticUpgradeIssue }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.id === undefined ? {} : { id: options.id }),
  })

  const employeeView = async (
    record: Awaited<ReturnType<DigitalEmployeeAuthoringService['getEmployeeDefinition']>>,
  ): Promise<EmployeeDefinitionView> => {
    if (record.currentRevision === null) {
      throw new Error(`employee has no current revision: ${record.id}`)
    }
    const revision = await store.getEmployeeDefinitionRevision({
      id: record.id,
      revision: record.currentRevision,
    })
    if (revision === null) throw new Error(`employee revision is missing: ${record.id}`)
    const workScope = await store.getWorkScopeRevision(revision.content.workScopeRef)
    if (workScope === null) throw new Error(`employee work scope is missing: ${record.id}`)
    const jobRevision = await store.getJobTemplateRevision(record.configuration.jobTemplateRef)
    if (jobRevision === null) throw new Error(`employee job revision is missing: ${record.id}`)
    const overrideKeys = new Set(
      record.configuration.adapterOverrides.map(
        (binding) => `${binding.laneId}\u0000${binding.slotRef}`,
      ),
    )
    return {
      id: record.id,
      name: record.name,
      typeRef: record.typeRef,
      configuration: record.configuration,
      revision: record.currentRevision,
      definition: revision.content,
      inheritedAdapterBindings: jobRevision.content.defaultAdapterBindings,
      adapterBindingSources: revision.content.exactAdapterBindings.map((binding) => ({
        ...binding,
        source: overrideKeys.has(`${binding.laneId}\u0000${binding.slotRef}`)
          ? 'employee-override'
          : 'job-default',
      })),
      workScope: workScope.encodedScope,
      ownerUserId: record.ownerUserId,
      visibility: record.visibility,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    }
  }

  const policyView = async (): Promise<ExecutionPolicyView> => {
    const policy =
      options.retryLimits === undefined
        ? await service.getExecutionPolicy()
        : await service.ensureExecutionPolicyFromLimits(options.retryLimits.current())
    return {
      revision: policy.revision,
      content: policy.content,
      contentDigest: policy.contentDigest,
      publishedAt: policy.publishedAt,
    }
  }

  const runtimeService =
    options.runtime === undefined
      ? null
      : new DigitalEmployeeRuntimeService({
          store: persistence.runtime,
          authoringStore: store,
          eventCenter: options.runtime.eventCenter,
          execution: options.runtime.execution,
          platformWorkItems: options.runtime.platformWorkItems ?? {
            async execute(plan) {
              return JSON.stringify({
                schemaVersion: 1,
                roundRef: plan.roundRef,
                executionNonce: plan.executionNonce,
                status: 'blocked',
                summary: `No deterministic platform handler is registered for ${plan.workItemRef}`,
                contextPatches: [],
                effectSuggestions: [],
                artifactRefs: [],
              })
            },
          },
          runtimeCodecs: options.runtime.codecs,
          detailProjectionParticipants: options.runtime.detailProjectionParticipants ?? [],
          currentTypeRefs: runtimePackages.map((runtime) => runtime.descriptor.typeRef),
          executionContracts: options.executionContracts,
          platformTools,
          resolveExecutionPolicy: () =>
            options.retryLimits === undefined
              ? service.getExecutionPolicy()
              : service.ensureExecutionPolicyFromLimits(options.retryLimits.current()),
          inputUploads: inputUploadStore,
          inputArtifacts,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.id === undefined ? {} : { id: options.id }),
          ...(options.runtime.workerId === undefined ? {} : { workerId: options.runtime.workerId }),
        })

  const runtimeDocument = async (caseId: string): Promise<EmployeeCaseProjectionDocument> => {
    if (runtimeService === null) throw new Error('digital employee runtime is not composed')
    const projection = await runtimeService.project(caseId)
    return {
      caseRef: { id: projection.case.id, revision: projection.case.revision },
      state: projection.case.state,
      currentWorkItemRef: projection.case.currentWorkItemRef,
      projectionJson: JSON.stringify(projection),
      projectionRevision: projection.case.revision,
    }
  }

  return {
    maintenance: {
      settleAutomaticUpgrades: () => service.settleAutomaticUpgrades(),
    },
    inputUploads: {
      async create(input) {
        const artifact = await inputArtifacts.putFile(input.absolutePath)
        return await inputUploadStore.create({
          actorUserId: input.actorUserId,
          originalName: input.originalName,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          blobRef: artifact.blobRef,
          idempotencyKey: input.idempotencyKey,
          now: options.now?.() ?? Date.now(),
        })
      },
      delete: async (uploadRef, actorUserId) =>
        await inputUploadStore.delete(uploadRef, actorUserId),
      sweepExpired: async () => await inputUploadStore.sweepExpired(options.now?.() ?? Date.now()),
    },
    queries: {
      listTypes: () => service.listTypes(),
      getType: (ref) => service.getType(ref),
      getAuthoringManifest: (ref) => service.getAuthoringManifest(ref),
      listTools: async (ref, workItemRef) =>
        (await service.listTools(ref, workItemRef)).map(toolView),
      getToolAuthoring: async (input) => {
        const authoring = await service.getToolAuthoring(input)
        return { ...toolView(authoring.record), body: authoring.body }
      },
      listJobTemplates: async (ref) => (await service.listJobTemplates(ref)).map(jobView),
      listEmployees: async (ref) =>
        await Promise.all((await service.listEmployeeDefinitions(ref)).map(employeeView)),
      listLaunchableEmployees: async () =>
        await Promise.all((await service.listLaunchableEmployeeDefinitions()).map(employeeView)),
      getEmployee: async (id) => await employeeView(await service.getEmployeeDefinition(id)),
      getEmployeeAcl: async (id) => {
        // 走 store 的**窄查询**（只选三列，不解析配置内容）：
        //   - service.getEmployeeDefinition 对 currentRevision === null 的半成品行抛
        //     not-found；
        //   - store.getEmployeeDefinition 会 zod 解析 configuration_json，内容不合
        //     schema 时抛。
        // 授权判据必须对**任何存在的行**可答，否则那些行会从「谁都改不动」退化成
        // 500 甚至绕过判据。archived 仍按「已消失」处理，与详情面 404 同形。
        const record = await store.getEmployeeDefinitionAcl(id)
        if (record === null || record.archivedAt !== null) return null
        return {
          id: record.id,
          name: record.name,
          ownerUserId: record.ownerUserId,
          visibility: record.visibility,
        }
      },
      getToolAcl: async (id) => {
        if (platformTools.isPlatformTool(id)) {
          return {
            id,
            name: id,
            ownerUserId: null,
            visibility: 'public',
            builtin: true,
            retiredAt: null,
          }
        }
        const record = await store.getToolAcl(id)
        return record === null ? null : { ...record, builtin: false }
      },
      getJobTemplateAcl: async (id) => {
        const record = await store.getJobTemplateAcl(id)
        if (record === null || record.archivedAt !== null) return null
        return {
          id: record.id,
          name: record.name,
          ownerUserId: record.ownerUserId,
          visibility: record.visibility,
        }
      },
      getExecutionPolicy: policyView,
      getMigrationStatus: () => persistence.migrationStatus(),
    },
    commands: {
      createTool: async (input) =>
        toolView(
          await service.createTool({
            typeRef: input.typeRef,
            workItemRef: input.workItemRef,
            body: input.body,
            ownerUserId: input.actorUserId,
          }),
        ),
      updateTool: async (input) => toolView(await service.updateTool(input)),
      validateTool: async (input) => toolView(await service.validateTool(input)),
      publishTool: async (input) => (await service.publishTool(input)).ref,
      retireTool: (input) => service.retireTool(input),
      createJobTemplate: async (input) =>
        jobView(
          await service.createJobTemplate({
            typeRef: input.typeRef,
            body: input.body,
            ownerUserId: input.actorUserId,
            adapterVisibilitySubject: input.adapterVisibilitySubject,
          }),
        ),
      updateJobTemplate: async (input) => jobView(await service.updateJobTemplate(input)),
      publishJobTemplate: (input) => service.publishJobTemplate(input),
      createEmployee: async (input) =>
        await employeeView(
          await service.createEmployeeDefinition({
            typeRef: input.typeRef,
            body: input.body,
            ownerUserId: input.actorUserId,
            adapterVisibilitySubject: input.adapterVisibilitySubject,
          }),
        ),
      updateEmployee: async (input) =>
        await employeeView(await service.updateEmployeeDefinition(input)),
    },
    runtime:
      runtimeService === null
        ? null
        : {
            commands: {
              launch: async (input) => {
                const record = await runtimeService.launchCase(input)
                return await runtimeDocument(record.id)
              },
              launchWork: async (input) => {
                const record = await runtimeService.launchWork(input)
                return await runtimeDocument(record.id)
              },
              previewPolicyUpgrade: (caseId, targetPolicyRevision) =>
                runtimeService.previewPolicyUpgrade(caseId, targetPolicyRevision),
              applyPolicyUpgrade: async (previewToken) => {
                const record = await runtimeService.applyPolicyUpgrade(previewToken)
                return await runtimeDocument(record.id)
              },
              terminate: async (caseId, terminalKind) => {
                const record = await runtimeService.terminate(caseId, terminalKind)
                return await runtimeDocument(record.id)
              },
              resume: async (caseId) => {
                const record = await runtimeService.resume(caseId)
                return await runtimeDocument(record.id)
              },
              replaceCaseMembers: (input) => runtimeService.replaceCaseMembers(input),
            },
            queries: {
              getCase: runtimeDocument,
              getCaseAcl: (caseId) => runtimeService.getCaseAcl(caseId),
              peekPolicyUpgradeCaseId: (previewToken) =>
                runtimeService.peekPolicyUpgradeCaseId(previewToken),
              listCaseMembers: (caseId) => runtimeService.listCaseMembers(caseId),
              getCaseMemberRole: (caseId, userId) =>
                runtimeService.getCaseMemberRole(caseId, userId),
              listCases: async (employeeId, state) =>
                JSON.stringify(await runtimeService.listCases(employeeId, state)),
              listTerminalOutcomeGroups: async () =>
                JSON.stringify(await runtimeService.listTerminalOutcomeGroups()),
              listCasePage: async (input) =>
                JSON.stringify(await runtimeService.listCasePage(input)),
              findByExternalSubject: async (subjectType, subjectRef) => {
                const record = await runtimeService.findCaseByExternalSubject(
                  subjectType,
                  subjectRef,
                )
                return record === null ? null : await runtimeDocument(record.id)
              },
            },
            worker: {
              runOneOutbox: () => runtimeService.runOneOutbox(),
              pumpOneDelivery: () => runtimeService.pumpOneDelivery(),
              planOneReaction: async () => (await runtimeService.planOneReaction())?.id ?? null,
              inspectOneExecution: () => runtimeService.inspectOneExecution(),
              publishOneChannelResult: () => runtimeService.publishOneChannelResult(),
            },
          },
  }
}

/** SQLite compatibility composition and behavior oracle. */
export function composeDigitalEmployee(
  options: ComposeDigitalEmployeeOptions,
): DigitalEmployeeModule {
  const persistedStore = createSqliteDigitalEmployeeAuthoringStore(options.db)
  const synchronousStore =
    options.typePackageDriftPolicy === 'draft-overlay'
      ? withTypePackageDraftOverlay(persistedStore)
      : persistedStore
  return composeDigitalEmployeeFromPersistence(options, {
    authoring: asAsyncDigitalEmployeeAuthoringPersistence(synchronousStore),
    runtime: createSqliteRuntimePersistence(options.db),
    inputUploads: createSqliteEmployeeInputUploadPersistence(options.db),
    migrationStatus: () => composeSqliteDigitalEmployeeWriterCutover(options.db).analyze(),
  })
}

/** Real PostgreSQL composition; all durable Digital Employee behavior shares one provider. */
export function composePostgresqlDigitalEmployee(
  options: ComposePostgresqlDigitalEmployeeOptions,
): DigitalEmployeeModule {
  return composeDigitalEmployeeFromPersistence(options, {
    authoring: createPostgresqlDigitalEmployeeAuthoringPersistence(options.db),
    runtime: createPostgresqlRuntimePersistence(options.db),
    inputUploads: createPostgresqlEmployeeInputUploadPersistence(options.db),
    migrationStatus: () => composePostgresqlDigitalEmployeeWriterCutover(options.db).analyze(),
  })
}

export { createDigitalEmployeeResourceCatalogAclProviders } from './composition/resourceCatalogAcl'
