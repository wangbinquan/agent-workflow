// RFC-368 刀 3 —— 把「旧字符串合同形状」的执行 fake 包成新合同，供存量数字员工测试复用。
//
// 那些测试锁的是数字员工自己的行为（规划、结算、上下文投影、协作……），执行 port 只是一个
// 可编排的替身。合同切换之后没必要逐个改写替身的形状：这里把
//   `launch(plan, { ordinal, mode, previousError })` / `inspect(executionRef)` / `cancel(executionRef)`
// 转接到 `ReactionExecutionPortV1` 上——反馈 ref 解回正文交给 `previousError`，失败详情经数字员工
// 的诊断 sink 存档后只回 ref（与生产的 TE 适配器同一条路）。admission 走真的 TE 日志。
//
// 新合同自己的判据（预分配执行身份、重放、access 核对）不在这里测，见 tests/rfc368-*.test.ts。

import type { ProviderNeutralDatabase } from '@/db/query'
import type { ReactionArtifactPersistence } from '@/modules/digital-employee/application/ports/reactionArtifacts'
import type { DigitalEmployeeReactionExecutionWiring } from '@/modules/digital-employee/application/runtimeService'
import type { DigitalEmployeeReactionExecutionProvider } from '@/modules/digital-employee/composition'
import { composeReactionArtifactPorts } from '@/modules/digital-employee/composition/reactionArtifacts'
import type {
  ReactionDiagnosticsSinkV1,
  ReactionExecutionPortV1,
  ReactionRetryFeedbackReaderV1,
} from '@/modules/digital-employee/composition/required-ports'
import {
  parseReactionArtifactRef,
  reactionArtifactRef,
} from '@/modules/digital-employee/domain/reactionArtifacts'
import type { ReactionExecutionPlan } from '@/modules/digital-employee/domain/runtimeModel'
import { composeReactionExecutionAdmissionParticipantInTx } from '@/modules/task-execution/application/adapters/reaction-admission-adapter'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'

interface Metering {
  readonly sourceRef: string
  readonly durationMs: number
  readonly totalTokens: number
}

export type LegacyShapedSnapshot =
  | { readonly kind: 'pending'; readonly executionRef?: string }
  | {
      readonly kind: 'completed'
      readonly executionRef?: string
      readonly outputJson: string
      readonly metering: Metering
    }
  | {
      readonly kind: 'failed'
      readonly executionRef?: string
      readonly errorClass: 'boundary' | 'semantic' | 'infrastructure'
      readonly errorCode: string
      readonly errorDetail: string
      readonly metering: Metering
    }

export interface LegacyShapedExecutionFake {
  launch?(
    plan: ReactionExecutionPlan,
    attempt: {
      readonly ordinal: number
      readonly mode: 'initial' | 'same-scene' | 'fresh-scene'
      readonly previousError: string | null
    },
  ): Promise<{ readonly executionRef: string }>
  inspect(executionRef: string): Promise<LegacyShapedSnapshot>
  inspectHumanReview?(
    executionRef: string,
  ): Promise<'planning' | 'waiting' | 'approved' | 'failed' | null>
  cancel?(executionRef: string): Promise<void>
}

function legacyShapedPort(
  fake: LegacyShapedExecutionFake,
  artifacts: {
    readonly retryFeedback: ReactionRetryFeedbackReaderV1
    readonly diagnosticsSink: ReactionDiagnosticsSinkV1
  },
): ReactionExecutionPortV1 {
  return {
    async launch(prepared) {
      if (fake.launch === undefined) throw new Error('execution fake does not launch')
      const { attempt } = prepared.request
      const previousError =
        attempt.retryFeedback.kind === 'artifact'
          ? await artifacts.retryFeedback.read(attempt.retryFeedback.ref)
          : null
      return await fake.launch(prepared.request.plan as ReactionExecutionPlan, {
        ordinal: attempt.ordinal,
        mode: attempt.mode,
        previousError,
      })
    },
    async inspect(access) {
      const snapshot = await fake.inspect(access.executionRef)
      switch (snapshot.kind) {
        case 'pending':
          return { kind: 'pending' }
        case 'completed':
          return { kind: 'completed', outputJson: snapshot.outputJson, metering: snapshot.metering }
        case 'failed':
          return {
            kind: 'failed',
            errorClass: snapshot.errorClass,
            errorCode: snapshot.errorCode,
            diagnostics: await artifacts.diagnosticsSink.put({
              errorCode: snapshot.errorCode,
              errorDetail: snapshot.errorDetail,
              workspaceRoot: null,
            }),
            metering: snapshot.metering,
          }
      }
    },
    async inspectHumanReview(access) {
      const state = (await fake.inspectHumanReview?.(access.executionRef)) ?? null
      return { kind: state ?? 'unknown' }
    },
    async cancel(access) {
      await fake.cancel?.(access.executionRef)
      return `stopped:${access.executionRef}` as never
    },
  }
}

/** 给 `composeDigitalEmployee({ runtime: { reactionExecution } })` 用：admission 走真 TE 日志。 */
export function legacyShapedReactionExecution(
  fake: LegacyShapedExecutionFake,
  now: () => number = Date.now,
): DigitalEmployeeReactionExecutionProvider {
  return {
    admission: (tx: ProviderNeutralDatabase) =>
      composeReactionExecutionAdmissionParticipantInTx(createReactionAdmissionStore(tx), { now }),
    port: (artifacts) => legacyShapedPort(fake, artifacts),
  }
}

/** 进程内产物存档，给直接 `new DigitalEmployeeRuntimeService(...)` 的测试用。 */
export function inMemoryReactionArtifacts(): ReactionArtifactPersistence {
  const bodies = new Map<string, string>()
  return {
    async put(kind, text) {
      bodies.set(text.digest, text.body)
      return reactionArtifactRef(kind, text.digest)
    },
    async read(ref) {
      const parsed = parseReactionArtifactRef(ref)
      return parsed === null ? null : (bodies.get(parsed.digest) ?? null)
    },
  }
}

/** 给直接 `new DigitalEmployeeRuntimeService({ reactionExecution })` 的测试用。 */
export function legacyShapedReactionWiring(
  fake: LegacyShapedExecutionFake,
): DigitalEmployeeReactionExecutionWiring {
  const artifacts = inMemoryReactionArtifacts()
  return {
    port: legacyShapedPort(fake, composeReactionArtifactPorts(artifacts, Date.now)),
    artifacts,
  }
}
