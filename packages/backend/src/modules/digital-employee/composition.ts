import { join } from 'node:path'

import type { DbClient } from '@/db/client'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import type { EventCenterParticipant } from '@/modules/event-center/public/participants'
import {
  DigitalEmployeeAuthoringService,
  type AutomaticTypeUpgradeIssue,
} from './application/authoringService'
import { DigitalEmployeeRuntimeService } from './application/runtimeService'
import type {
  EmployeeInputArtifactPort,
  EmployeeRetryLimitsPort,
  LegacyMissionDrainPort,
  ProgramArtifactPort,
  PlatformWorkItemExecutionPort,
  ReactionExecutionPort,
  ToolConnectionCatalogPort,
  ToolConnectionVisibilitySubject,
} from './composition/required-ports'
import { createProgramArtifactStore } from './infrastructure/programArtifactStore'
import { createSqliteReactionRoundQueries } from './infrastructure/sqliteReactionRoundQueries'
import type { EmployeeReactionRoundQueryPort } from './public/types'
import { createEmployeeInputArtifactStore } from './infrastructure/inputArtifactStore'
import {
  createEmployeeInputUploadStore,
  type EmployeeInputUploadRecord,
} from './infrastructure/inputUploadStore'
import { createSqliteDigitalEmployeeAuthoringStore } from './infrastructure/sqliteAuthoringStore'
import { withTypePackageDraftOverlay } from './application/typePackageDraftOverlay'
import { createSqliteRuntimeStore } from './infrastructure/sqliteRuntimeStore'
import { analyzeDigitalEmployeeMigration } from './composition/writerCutover'
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
  EmployeeCaseLaunchInput,
  EmployeeCaseProjectionDocument,
  EmployeeTypePackageRegistration,
  EmployeeTypeCollaborationCodec,
  EmployeeTypeContextCodec,
  EmployeeTypeReactionCodec,
} from './public/types'
import type { DigitalEmployeePlatformToolCatalogParticipant } from './public/types'
import type { DigitalEmployeePlatformToolCatalog } from './application/ports/authoringStore'

export { createReactionExecutionAdapter } from './application/adapters/task-execution-adapter'
export { composeDigitalEmployeeTaskCatalogSource } from './application/adapters/task-catalog-adapter'
export { startDigitalEmployeeOsWorker } from './application/osWorker'
export {
  activateDigitalEmployeeOsWriter,
  readDigitalEmployeeWriterState,
  refreshDigitalEmployeeWriterState,
} from './composition/writerCutover'
export { createEmployeeInputArtifactStore } from './infrastructure/inputArtifactStore'

/** Bootstrap projection owned by Digital Employee; consumers never read its tables directly. */
export function readPersistedDigitalEmployeeTypePackageDescriptorJsons(
  db: DbClient,
): readonly string[] {
  return createSqliteDigitalEmployeeAuthoringStore(db).listTypePackageDescriptorJsons()
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
  retireTool(input: Parameters<DigitalEmployeeAuthoringService['retireTool']>[0]): void
  createJobTemplate(input: {
    readonly typeRef: EmployeeTypeRef
    readonly body: unknown
    readonly actorUserId: string | null
    readonly adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): JobTemplateView
  updateJobTemplate(
    input: Parameters<DigitalEmployeeAuthoringService['updateJobTemplate']>[0],
  ): JobTemplateView
  publishJobTemplate(
    input: Parameters<DigitalEmployeeAuthoringService['publishJobTemplate']>[0],
  ): ExactResourceRef
  createEmployee(input: {
    readonly typeRef: EmployeeTypeRef
    readonly body: unknown
    readonly actorUserId: string | null
    readonly adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): EmployeeDefinitionView
  updateEmployee(input: {
    readonly id: string
    readonly body: unknown
    readonly actorUserId: string | null
    readonly adapterVisibilitySubject?: ToolConnectionVisibilitySubject | null
  }): EmployeeDefinitionView
}

export interface DigitalEmployeeQueries {
  listTypes(): EmployeeTypePackageDescriptor[]
  getType(ref: EmployeeTypeRef): EmployeeTypePackageDescriptor
  getAuthoringManifest(ref: EmployeeTypeRef): EmployeeAuthoringManifest
  listTools(ref: EmployeeTypeRef, workItemRef: string): ToolRegistrationView[]
  getToolAuthoring(
    input: Parameters<DigitalEmployeeAuthoringService['getToolAuthoring']>[0],
  ): Promise<ToolAuthoringView>
  listJobTemplates(ref: EmployeeTypeRef): JobTemplateView[]
  listEmployees(ref?: EmployeeTypeRef): EmployeeDefinitionView[]
  listLaunchableEmployees(): EmployeeDefinitionView[]
  getEmployee(id: string): EmployeeDefinitionView
  /**
   * RFC-317 T8 —— 只读 ACL 三元组的**窄查询**。
   *
   * 为什么不复用 `getEmployee`：那个视图要物化 current revision 与 work scope，
   * 对「还没有 current revision」的行会抛；而 ACL 判据必须对**任何存在的行**都能
   * 作答（否则半成品行会变成「谁都改得动」）。也不让 transport 直接查
   * `employee_definitions` 表——那是跨界读模块私表，正是 RFC-317 R5 要禁的形态。
   */
  getEmployeeAcl(id: string): {
    readonly id: string
    /** RFC-324 —— 供改名围栏比对；仍是同一条窄查询，不物化 revision。 */
    readonly name: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
  } | null
  getExecutionPolicy(): ExecutionPolicyView
  getMigrationStatus(): ReturnType<typeof analyzeDigitalEmployeeMigration>
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
    delete(uploadRef: string, actorUserId: string | null): void
    sweepExpired(): number
  }
  readonly runtime: {
    readonly commands: {
      launch(input: EmployeeCaseLaunchInput): EmployeeCaseProjectionDocument
      launchWork(input: {
        readonly employeeId: string
        readonly intake: unknown
        readonly actorUserId: string | null
        readonly eventOrigin?: {
          readonly eventSubscriptionId: string
          readonly eventDeliveryId: string
        }
      }): EmployeeCaseProjectionDocument
      previewPolicyUpgrade(caseId: string, targetPolicyRevision: number): string
      applyPolicyUpgrade(previewToken: string): EmployeeCaseProjectionDocument
      terminate(caseId: string, terminalKind: string): EmployeeCaseProjectionDocument
      resume(caseId: string): EmployeeCaseProjectionDocument
    }
    readonly queries: {
      getCase(caseId: string): EmployeeCaseProjectionDocument
      listCases(employeeId?: string, state?: string): string
      listTerminalOutcomeGroups(): string
      listCasePage(input: Parameters<DigitalEmployeeRuntimeService['listCasePage']>[0]): string
      findByExternalSubject(
        subjectType: string,
        subjectRef: string,
      ): EmployeeCaseProjectionDocument | null
    }
    readonly worker: {
      runOneOutbox(): Promise<'completed' | 'retried' | 'idle'>
      pumpOneDelivery(): boolean
      planOneReaction(): string | null
      inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
      publishOneChannelResult(): 'completed' | 'idle'
    }
  } | null
}

export interface ComposeDigitalEmployeeOptions {
  readonly db: DbClient
  readonly appHome: string
  readonly typePackages: readonly EmployeeTypePackageRegistration[]
  /** Explicit Bun-dev escape hatch; normal start and embedded builds stay immutable. */
  readonly typePackageDriftPolicy?: 'reject' | 'draft-overlay'
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
  readonly legacyMissionDrain?: LegacyMissionDrainPort
  readonly runtime?: {
    readonly eventCenter: EventCenterParticipant
    readonly execution: ReactionExecutionPort
    readonly platformWorkItems?: PlatformWorkItemExecutionPort
    readonly codecs: readonly EmployeeTypeRuntimeCodec[]
    readonly workerId?: string
  }
  readonly now?: () => number
  readonly id?: () => string
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

/**
 * 未接线时的排空视图：**零条**。
 *
 * 刻意不是「抛错」也不是「去查 development 的表」——通用 OS 必须能在没有
 * development-automation 的部署里装配起来（这正是 DE-01 要解决的问题）。
 * 报告里 `drainingTotal` 仍取 writer 行上记录的计数，所以「有没有接排空实现」
 * 与「切换状态机记了多少」两件事不会互相掩盖。
 */
const EMPTY_LEGACY_MISSION_DRAIN: LegacyMissionDrainPort = {
  openMissionCount: () => 0,
  drainReport: () => ({ truncated: false, entries: [] }),
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
  record: ReturnType<DigitalEmployeeAuthoringService['listTools']>[number],
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
  record: ReturnType<DigitalEmployeeAuthoringService['listJobTemplates']>[number],
): JobTemplateView {
  return {
    id: record.id,
    typeRef: record.typeRef,
    name: record.name,
    draft: record.draft,
    publishedRevision: record.publishedRevision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function composeDigitalEmployee(
  options: ComposeDigitalEmployeeOptions,
): DigitalEmployeeModule {
  const persistedStore = createSqliteDigitalEmployeeAuthoringStore(options.db)
  const store =
    options.typePackageDriftPolicy === 'draft-overlay'
      ? withTypePackageDraftOverlay(persistedStore)
      : persistedStore
  const inputUploadStore = createEmployeeInputUploadStore(options.db)
  const inputArtifacts =
    options.inputArtifacts ??
    createEmployeeInputArtifactStore(join(options.appHome, 'artifacts', 'employee-inputs'))
  const runtimePackages = options.typePackages.map(runtimePackageOf)
  const platformTools = platformToolCatalogOf(options.platformTools)
  const service = new DigitalEmployeeAuthoringService({
    store,
    typePackages: runtimePackages,
    connectionCatalog: options.connectionCatalog ?? {
      resolve() {
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

  const employeeView = (
    record: ReturnType<DigitalEmployeeAuthoringService['getEmployeeDefinition']>,
  ): EmployeeDefinitionView => {
    if (record.currentRevision === null) {
      throw new Error(`employee has no current revision: ${record.id}`)
    }
    const revision = store.getEmployeeDefinitionRevision({
      id: record.id,
      revision: record.currentRevision,
    })
    if (revision === null) throw new Error(`employee revision is missing: ${record.id}`)
    const workScope = store.getWorkScopeRevision(revision.content.workScopeRef)
    if (workScope === null) throw new Error(`employee work scope is missing: ${record.id}`)
    const jobRevision = store.getJobTemplateRevision(record.configuration.jobTemplateRef)
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

  const policyView = (): ExecutionPolicyView => {
    const policy =
      options.retryLimits === undefined
        ? service.getExecutionPolicy()
        : service.ensureExecutionPolicyFromLimits(options.retryLimits.current())
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
          store: createSqliteRuntimeStore(options.db),
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

  const runtimeDocument = (caseId: string): EmployeeCaseProjectionDocument => {
    if (runtimeService === null) throw new Error('digital employee runtime is not composed')
    const projection = runtimeService.project(caseId)
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
        return inputUploadStore.create({
          actorUserId: input.actorUserId,
          originalName: input.originalName,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          blobRef: artifact.blobRef,
          idempotencyKey: input.idempotencyKey,
          now: options.now?.() ?? Date.now(),
        })
      },
      delete: (uploadRef, actorUserId) => inputUploadStore.delete(uploadRef, actorUserId),
      sweepExpired: () => inputUploadStore.sweepExpired(options.now?.() ?? Date.now()),
    },
    queries: {
      listTypes: () => service.listTypes(),
      getType: (ref) => service.getType(ref),
      getAuthoringManifest: (ref) => service.getAuthoringManifest(ref),
      listTools: (ref, workItemRef) => service.listTools(ref, workItemRef).map(toolView),
      getToolAuthoring: async (input) => {
        const authoring = await service.getToolAuthoring(input)
        return { ...toolView(authoring.record), body: authoring.body }
      },
      listJobTemplates: (ref) => service.listJobTemplates(ref).map(jobView),
      listEmployees: (ref) => service.listEmployeeDefinitions(ref).map(employeeView),
      listLaunchableEmployees: () => service.listLaunchableEmployeeDefinitions().map(employeeView),
      getEmployee: (id) => employeeView(service.getEmployeeDefinition(id)),
      getEmployeeAcl: (id) => {
        // 走 store 的**窄查询**（只选三列，不解析配置内容）：
        //   - service.getEmployeeDefinition 对 currentRevision === null 的半成品行抛
        //     not-found；
        //   - store.getEmployeeDefinition 会 zod 解析 configuration_json，内容不合
        //     schema 时抛。
        // 授权判据必须对**任何存在的行**可答，否则那些行会从「谁都改不动」退化成
        // 500 甚至绕过判据。archived 仍按「已消失」处理，与详情面 404 同形。
        const record = store.getEmployeeDefinitionAcl(id)
        if (record === null || record.archivedAt !== null) return null
        return {
          id: record.id,
          name: record.name,
          ownerUserId: record.ownerUserId,
          visibility: record.visibility,
        }
      },
      getExecutionPolicy: policyView,
      getMigrationStatus: () =>
        analyzeDigitalEmployeeMigration(
          options.db,
          options.legacyMissionDrain ?? EMPTY_LEGACY_MISSION_DRAIN,
        ),
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
      createJobTemplate: (input) =>
        jobView(
          service.createJobTemplate({
            typeRef: input.typeRef,
            body: input.body,
            ownerUserId: input.actorUserId,
            adapterVisibilitySubject: input.adapterVisibilitySubject,
          }),
        ),
      updateJobTemplate: (input) => jobView(service.updateJobTemplate(input)),
      publishJobTemplate: (input) => service.publishJobTemplate(input),
      createEmployee: (input) =>
        employeeView(
          service.createEmployeeDefinition({
            typeRef: input.typeRef,
            body: input.body,
            ownerUserId: input.actorUserId,
            adapterVisibilitySubject: input.adapterVisibilitySubject,
          }),
        ),
      updateEmployee: (input) => employeeView(service.updateEmployeeDefinition(input)),
    },
    runtime:
      runtimeService === null
        ? null
        : {
            commands: {
              launch: (input) => {
                const record = runtimeService.launchCase(input)
                return runtimeDocument(record.id)
              },
              launchWork: (input) => {
                const record = runtimeService.launchWork(input)
                return runtimeDocument(record.id)
              },
              previewPolicyUpgrade: (caseId, targetPolicyRevision) =>
                runtimeService.previewPolicyUpgrade(caseId, targetPolicyRevision),
              applyPolicyUpgrade: (previewToken) => {
                const record = runtimeService.applyPolicyUpgrade(previewToken)
                return runtimeDocument(record.id)
              },
              terminate: (caseId, terminalKind) => {
                const record = runtimeService.terminate(caseId, terminalKind)
                return runtimeDocument(record.id)
              },
              resume: (caseId) => {
                const record = runtimeService.resume(caseId)
                return runtimeDocument(record.id)
              },
            },
            queries: {
              getCase: runtimeDocument,
              listCases: (employeeId, state) =>
                JSON.stringify(runtimeService.listCases(employeeId, state)),
              listTerminalOutcomeGroups: () =>
                JSON.stringify(runtimeService.listTerminalOutcomeGroups()),
              listCasePage: (input) => JSON.stringify(runtimeService.listCasePage(input)),
              findByExternalSubject: (subjectType, subjectRef) => {
                const record = runtimeService.findCaseByExternalSubject(subjectType, subjectRef)
                return record === null ? null : runtimeDocument(record.id)
              },
            },
            worker: {
              runOneOutbox: () => runtimeService.runOneOutbox(),
              pumpOneDelivery: () => runtimeService.pumpOneDelivery(),
              planOneReaction: () => runtimeService.planOneReaction()?.id ?? null,
              inspectOneExecution: () => runtimeService.inspectOneExecution(),
              publishOneChannelResult: () => runtimeService.publishOneChannelResult(),
            },
          },
  }
}
