// RFC-436: the route-facing handle of the digital-employee module. Its only
// production consumer is this module's own HTTP binding
// (`inbound/http/digitalEmployeeRoutes`); bootstrap reaches the same types
// through `composition.ts`. Kept out of `public/`: an administration surface
// with no cross-context consumer is not part of the module contract
// (RFC-294 design §3.3).
import type { ToolConnectionVisibilitySubject } from '../../composition/required-ports'
import type {
  CreateToolRegistrationBody,
  DigitalEmployeeDefinitionContent,
  DigitalEmployeeDefinitionDraft,
  EmployeeAuthoringManifest,
  EmployeeJobTemplateContent,
  EmployeeTypePackageDescriptor,
  EmployeeTypeRef,
  ExactResourceRef,
  GlobalExecutionPolicy,
  LaneAdapterBinding,
  ToolRegistrationContent,
  ToolValidationReceipt,
} from '../../domain/model'
import type { DigitalEmployeeAuthoringService } from '../authoringService'
import type { DigitalEmployeeRuntimeService } from '../runtimeService'
import type { EmployeeCaseLaunchInput, EmployeeCaseProjectionDocument } from './caseRuntime'
import type { EmployeeInputUploadRecord } from './inputUploadStore'
import type { DigitalEmployeeMigrationStatus } from './writerCutoverPersistence'

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
    /** Bootstrap barrier: registrations / upgrades / global policy done, or the boot error. */
    ready(): Promise<void>
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
      dispatchOneReaction(): Promise<'launched' | 'retried' | 'settled' | 'idle'>
      pumpOneDelivery(): Promise<boolean>
      planOneReaction(): Promise<string | null>
      inspectOneExecution(): Promise<'completed' | 'retried' | 'failed' | 'pending' | 'idle'>
      publishOneChannelResult(): Promise<'completed' | 'idle'>
    }
  } | null
}

export interface DigitalEmployeeModuleWithRuntime extends DigitalEmployeeModule {
  readonly runtime: NonNullable<DigitalEmployeeModule['runtime']>
}
