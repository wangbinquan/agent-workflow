import type { DbClient } from '@/db/client'
import type { ExactResourceRef } from '../domain/model'
import type { WorkspaceFailureClass } from '@/modules/digital-employee/public/types'
import type { ReactionExecutionPlan } from '../domain/runtimeModel'

export interface ToolConnectionProjection {
  readonly ref: ExactResourceRef
  readonly purpose: string
  readonly available: boolean
  readonly closureSummary: string
}

/**
 * Digital employees consume the platform-wide retry limits. This port is
 * intentionally read-only: authoring an employee must never create a second
 * retry-policy namespace beside Settings -> Limits.
 */
export interface EmployeeRetryLimitsPort {
  current(): {
    readonly defaultNodeRetries: number
    readonly sessionRestartBudget: number
  }
}

/**
 * Resolves one exact, platform-owned connection revision. The consumer owns
 * this narrow contract; provider credentials and executable details never
 * cross into Digital Employee authoring or Agent input.
 */
export interface ToolConnectionCatalogPort {
  resolve(ref: ExactResourceRef): Promise<ToolConnectionProjection | null>
}

export interface ProgramArtifactPort {
  put(input: {
    readonly runtimeKind: 'bash' | 'node' | 'python'
    readonly source: string
    readonly parameterValues: Readonly<Record<string, string | number | boolean>> | null
  }): Promise<{
    readonly executableArtifactRef: string
    readonly executableDigest: string
    readonly parameterValuesRef: string | null
  }>
  read(input: {
    readonly runtimeKind: 'bash' | 'node' | 'python'
    readonly executableArtifactRef: string
    readonly executableDigest: string
    readonly parameterValuesRef: string | null
  }): {
    readonly source: string
    readonly parameterValues: Readonly<Record<string, string | number | boolean>> | null
  } | null
}

/**
 * Content-addressed bytes are owned by the platform artifact mechanism. The
 * Digital Employee OS stores only an opaque blob ref and verified byte facts.
 */
export interface EmployeeInputArtifactPort {
  putFile(absolutePath: string): Promise<{
    readonly blobRef: string
    readonly sha256: string
    readonly bytes: number
  }>
  hasBlob(blobRef: string): boolean
  copyBlobTo(blobRef: string, absoluteTargetPath: string): void
}

export type ReactionExecutionSnapshot =
  | { readonly kind: 'pending'; readonly executionRef: string }
  | { readonly kind: 'completed'; readonly executionRef: string; readonly outputJson: string }
  | {
      readonly kind: 'failed'
      readonly executionRef: string
      /** RFC-317 T31（DE-03）—— 决定重试落在同场景还是新场景，见 WorkspaceFailureClass。 */
      readonly errorClass: WorkspaceFailureClass
      readonly errorCode: string
      readonly errorDetail: string
    }

export interface ReactionExecutionPort {
  launch(
    plan: ReactionExecutionPlan,
    attempt: {
      readonly ordinal: number
      readonly mode: 'initial' | 'same-scene' | 'fresh-scene'
      readonly previousError: string | null
    },
  ): Promise<{ readonly executionRef: string }>
  inspect(executionRef: string): Promise<ReactionExecutionSnapshot>
  inspectHumanReview?(executionRef: string): 'planning' | 'waiting' | 'approved' | 'failed' | null
  cancel(executionRef: string): Promise<void>
}

/**
 * Deterministic platform-owned work items (for example source-control publish
 * or merge-readiness evaluation) execute outside Agent/Workflow/Script. The
 * participant must return the same exact output envelope as every other tool.
 */
export interface PlatformWorkItemExecutionPort {
  execute(plan: ReactionExecutionPlan): Promise<string>
}

/** RFC-317 T41（DE-01）—— 一条待排空的旧 Mission 在迁移报告里的样子。 */
export interface LegacyMissionDrainEntry {
  readonly missionId: string
  readonly status: string
  readonly activeMrClaimCount: number
  readonly childLinkCount: number
  readonly pendingApprovalCount: number
}

export interface LegacyMissionDrainReport {
  /** 采样是否被 limit 截断（报告要如实说，不能让人以为这就是全部）。 */
  readonly truncated: boolean
  readonly entries: ReadonlyArray<LegacyMissionDrainEntry>
}

/**
 * 旧 Mission 的**排空视图**。
 *
 * 为什么需要这条端口：单写者切换（`writerCutover.ts`）要回答「还有多少条旧 Mission
 * 没终结」，此前的做法是 digital-employee 直接 import `developmentMissions` /
 * `developmentMrClaims` / `developmentMissionLinks` / `developmentApprovalSagas`
 * 四张 development-automation 的表跑 Drizzle 查询，还把该 context 的状态字面量
 * （`['approved','rejected','expired','unavailable']`）抄了一份。RFC-294 明令禁止
 * 「以复用方便为由共享 Drizzle table」——代价是通用 OS 离开 development 的 schema
 * 就装配不起来，且 development 改一个列会静默改坏 digital-employee 的查询。
 *
 * **为什么留在 `required-ports.ts` 而不是 `public/types.ts`**：`openMissionCount` 必须收一个
 * 事务读句柄，而任何 DB 句柄类型都被 RFC-294 的 public 面 taint 判据禁止（实测：
 * `public/types.ts#LegacyMissionDrainPort: forbidden type DbClient`）——那条禁令是对的，
 * public 合同不该泄漏 ORM。于是本端口留在非公共的 required-ports 层，实现方
 * （development-automation）**不 import 它**，靠 bootstrap 装配点的赋值做结构校验——
 * 这正是本仓既有跨界实现的形态（`composeDevelopmentEmployeeWorkspace` /
 * `composeDevelopmentEmployeePlatformWorkItems` 都各自声明结构化入参，无一 import 端口类型）。
 *
 * `openMissionCount` 收一个**读句柄**而不是自己取 db：计数与
 * `employeeOsWriterState` 的写必须落在同一个事务里，否则记下的
 * `legacyOpenMissionCount` 会与同一行的 `mode` 不一致（一个是事务前的、一个是事务内的）。
 * 句柄类型是平台的 `Pick<DbClient,'select'>`，不是 development-automation 的任何类型
 * ——跨界的是「在这个事务里读」这件事，不是那四张表的形状。
 */
export interface LegacyMissionDrainPort {
  openMissionCount(reader: Pick<DbClient, 'select'>): number
  drainReport(limit: number): LegacyMissionDrainReport
}
