// RFC-294 / RFC-376 G3: exact public boundaries and retained contract fixtures.
// Baselines are file pairs or symbol roots from committed HEAD; no projection is read.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { sourceUnit, type SourceUnit } from './architecture/census'
import {
  sourceUnits,
  publicSurfaceViolations,
  capabilityForgeViolations,
  crossContextInternalPairs,
  createGateCorpus,
  exactAllowlist,
} from './architecture/rfc294Gates'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')
const MODULES_ROOT = resolve(REPO_ROOT, 'packages', 'backend', 'src', 'modules')
const portable = (path: string): string => path.replaceAll('\\', '/')
const crossContextViolations = (units: readonly SourceUnit[]): string[] =>
  crossContextInternalPairs(createGateCorpus(units))

function typeResolutionCorpus(): SourceUnit[] {
  return [
    ...productionModuleUnits(),
    ...unitsUnder(resolve(REPO_ROOT, 'packages', 'shared', 'src')),
    ...unitsUnder(resolve(REPO_ROOT, 'packages', 'backend', 'src', 'platform')),
  ]
}

function unitsUnder(root: string): SourceUnit[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(path)
    }
  }
  visit(root)
  return files
    .sort()
    .map((path) => sourceUnit(portable(relative(REPO_ROOT, path)), readFileSync(path, 'utf8')))
}

function productionModuleUnits(): SourceUnit[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) files.push(path)
    }
  }
  visit(MODULES_ROOT)
  return files
    .sort()
    .map((path) => sourceUnit(portable(relative(REPO_ROOT, path)), readFileSync(path, 'utf8')))
}

const VALID_TARGET_FIXTURE = sourceUnits({
  'packages/backend/src/modules/task-execution/public/participants.ts': `
    declare const taskEffectCapabilityBrand: unique symbol
    export type TaskEffectCapability = Readonly<{ [taskEffectCapabilityBrand]: true }>
    export interface TaskEffectParticipant { apply(input: Readonly<{ taskId: string }>): Promise<void> }
  `,
  'packages/backend/src/modules/task-execution/public/types.ts': `
    export type TaskRef = Readonly<{ taskId: string }>
  `,
  'packages/backend/src/modules/task-execution/application/taskEffectCapability.ts': `
    import type { TaskEffectCapability } from '../public/participants'
    const claims = new WeakMap<TaskEffectCapability, Readonly<{ taskId: string }>>()
    export function mintTaskEffectCapability(taskId: string): TaskEffectCapability {
      const capability = Object.freeze({})
      claims.set(capability, Object.freeze({ taskId }))
      return capability as TaskEffectCapability
    }
  `,
  'packages/backend/src/modules/integration/public/types.ts': `
    export type DeliveryRef = Readonly<{ deliveryId: string }>
  `,
  'packages/backend/src/modules/integration/application/consume.ts': `
    import type { TaskEffectParticipant } from '@/modules/task-execution/public/participants'
    import type { TaskRef } from '../../task-execution/public/types'
    export type Consumer = Readonly<{ participant: TaskEffectParticipant; task: TaskRef }>
  `,
  'packages/backend/src/modules/integration/application/adapters/task-adapter.ts': `
    import type { GatePort } from '@/modules/collaboration/composition/required-ports'
    export type Adapter = Readonly<{ gate: GatePort }>
  `,
  'packages/backend/src/modules/collaboration/composition/required-ports.ts': `
    export interface GatePort { open(): Promise<void> }
  `,
})

// RFC-317 T25 —— 扩面与豁免各自的正反 fixture。
//
// **为什么必须有这一节**：T25 落地后跑了两条变异，**两条都没被抓住**——
//   ① 撤掉 `resolveUnit` 对 `@agent-workflow/shared` 的识别（退回扩面前的失明）；
//   ② 把「确定性 typeof」豁免放宽成「任何 typeof 都不算 taint」。
// 全部断言照绿。原因和 RFC-317 T26 撞到的那次一模一样：**真实语料证明不了它当前
// 没有触及的性质**——今天没有一条公共合同里躺着裸 `typeof value`，也没有哪条断言
// 会因为 shared 解析不到而变色（叶子数即使被低估，也仍在预算内）。
// 于是这次扩面在被写出来的当天就是**不可证伪**的：任何人把它改回去，没有一条测试会红。
// 下面两组 fixture 把这两个性质变成可断言的事实。

const SHARED_RESOLUTION_FIXTURE = sourceUnits({
  'packages/shared/src/index.ts': `
    export * from './schemas/probe'
  `,
  'packages/shared/src/schemas/probe.ts': `
    export type ProbeDto = {
      readonly a1: string; readonly a2: string; readonly a3: string; readonly a4: string
      readonly a5: string; readonly a6: string; readonly a7: string; readonly a8: string
      readonly a9: string; readonly b1: string; readonly b2: string; readonly b3: string
      readonly b4: string; readonly b5: string; readonly b6: string; readonly b7: string
      readonly b8: string; readonly b9: string; readonly c1: string; readonly c2: string
      readonly c3: string; readonly c4: string; readonly c5: string; readonly c6: string
      readonly c7: string; readonly c8: string; readonly c9: unknown
    }
  `,
  'packages/backend/src/modules/probe/public/participants.ts': `
    import type { ProbeDto } from '@agent-workflow/shared'
    export type ProbeParticipant = Readonly<{ payload: ProbeDto }>
  `,
})

const DETERMINISTIC_TYPEOF_FIXTURE = sourceUnits({
  'packages/backend/src/modules/probe/public/types.ts': `
    import { z } from 'zod'
    const ProbeSchema = z.object({ a: z.string() })
    const PROBE_KINDS = ['a', 'b'] as const
    const PROBE_MAP = { a: 1, b: 2 } as const
    export type FromSchema = z.infer<typeof ProbeSchema>
    export type FromArray = (typeof PROBE_KINDS)[number]
    export type FromKeys = keyof typeof PROBE_MAP
  `,
})

const BARE_TYPEOF_FIXTURE = sourceUnits({
  'packages/backend/src/modules/probe/public/types.ts': `
    declare const runGit: (argv: readonly string[]) => Promise<string>
    export type RepositoryGit = typeof runGit
  `,
})

const OPERATION_REEXPORT_FIXTURE = sourceUnits({
  'packages/backend/src/modules/probe/application/operations.ts': `
    export interface ProbeOperations {
      one(): void; two(): void; three(): void; four(): void; five(): void; six(): void
    }
    export function createProbeDescriptors(operations: ProbeOperations): unknown {
      return operations
    }
  `,
  'packages/backend/src/modules/probe/public/operations.ts': `
    export { createProbeDescriptors, type ProbeOperations } from '../application/operations'
  `,
})

describe('RFC-317 T25 —— 解析扩面与 typeof 豁免的正反 fixture', () => {
  test('shared 的类型确实被解析并检查 public 合同（撤掉扩面 ⇒ 这条红）', () => {
    expect(publicSurfaceViolations(SHARED_RESOLUTION_FIXTURE)).toEqual([
      'modules/probe/public/participants.ts#ProbeParticipant: unsafe/open type UnknownKeyword',
    ])
  })

  test('三种确定性 typeof 派生都不算 taint（豁免被撤掉 ⇒ 这条红）', () => {
    expect(
      publicSurfaceViolations(DETERMINISTIC_TYPEOF_FIXTURE),
      'z.infer<typeof S> / (typeof A)[number] / keyof typeof A 是本仓「schema·常量与类型' +
        '单一事实源」的标准写法（全仓 586 + 85 + 6 处），把它们判成开放类型会逼着后来的人' +
        '给动态载荷编假联合',
    ).toEqual([])
  })

  test('**裸** typeof value 仍然算 taint（豁免被放宽 ⇒ 这条红）', () => {
    expect(
      publicSurfaceViolations(BARE_TYPEOF_FIXTURE),
      '裸 typeof 才是真正开放的形态：类型等于某个值恰好是什么，消费者在编译期说不出它的形状。' +
        '豁免一旦放宽成「任何 typeof 都放行」，这条就会漏',
    ).toEqual(['modules/probe/public/types.ts#RepositoryGit: unsafe/open type TypeQuery'])
  })

  test('public/operations 的 re-export 保留 operation-catalog 专属射程', () => {
    expect(publicSurfaceViolations(OPERATION_REEXPORT_FIXTURE)).toEqual([])
  })
})

describe('RFC-294 W0-R target architecture scanner contract', () => {
  test('accepts exact public edges, same-context internals, and the narrow required-SPI adapter lane', () => {
    expect(crossContextViolations(VALID_TARGET_FIXTURE)).toEqual([])
    expect(publicSurfaceViolations(VALID_TARGET_FIXTURE)).toEqual([])
    expect(capabilityForgeViolations(VALID_TARGET_FIXTURE)).toEqual([])
  })

  test('cross-context static/type/dynamic/re-export/import-type mutations all turn red', () => {
    const mutated = sourceUnits({
      'packages/backend/src/modules/alpha/application/use.ts': `
        import type { Hidden } from '@/modules/beta/application/hidden'
        export { secret } from '@/modules/beta/infrastructure/secret'
        export type CommandShape = import('@/modules/beta/application/contracts').CommandShape
        import type { Indexed } from '@/modules/beta/public/types/index'
        export type IndexedAlias = Indexed
        export async function lazy() { return import('@/modules/beta/domain/model') }
      `,
      'packages/backend/src/modules/beta/application/hidden.ts': 'export type Hidden = string',
      'packages/backend/src/modules/beta/application/contracts.ts':
        'export type CommandShape = string',
      'packages/backend/src/modules/beta/infrastructure/secret.ts': 'export const secret = 1',
      'packages/backend/src/modules/beta/domain/model.ts': 'export const model = 1',
      'packages/backend/src/modules/beta/public/types/index.ts': 'export type Indexed = string',
      'packages/backend/src/modules/beta/public/commands.ts': 'export type CommandShape = string',
    })
    const violations = crossContextViolations(mutated).join('\n')
    for (const target of [
      'application/hidden',
      'infrastructure/secret',
      'domain/model',
      'application/contracts',
      'public/types/index',
    ])
      expect(violations).toContain(` -> packages/backend/src/modules/beta/${target}.ts`)
  })

  test('public export-star and multi-hop namespace alias/generic adapter taint turn red', () => {
    const mutated = sourceUnits({
      'packages/backend/src/modules/catalog/public/types.ts': `
        export * from '../domain/leak'
        export type { LeakedView } from '../domain/bridge'
      `,
      'packages/backend/src/modules/catalog/domain/bridge.ts': `
        export type { LeakedView } from './leak'
      `,
      'packages/backend/src/modules/catalog/domain/leak.ts': `
        import type * as Database from '@/db/client'
        type Envelope<T> = Readonly<{ value: T }>
        export type LeakedView = Envelope<Database.DbClient> | Readonly<{ fallback: unknown }>
      `,
    })
    const violations = publicSurfaceViolations(mutated).join('\n')
    expect(violations).toContain('export * is forbidden')
    expect(violations).toContain('forbidden type import @/db/client#DbClient')
    expect(violations).toContain('unsafe/open type UnknownKeyword')
  })

  test('capability cast, spread-rewrap, deserialize, mutation, and serialization turn red', () => {
    const mutated = sourceUnits({
      'packages/backend/src/modules/identity-access/public/participants.ts': `
        declare const requestAuthorityBrand: unique symbol
        export type RequestAuthority = Readonly<{ [requestAuthorityBrand]: true }>
      `,
      'packages/backend/src/modules/identity-access/application/requestAuthority.ts': `
        import type { RequestAuthority } from '../public/participants'
        const claims = new WeakMap<RequestAuthority, Readonly<{ subjectRef: string }>>()
        export function mintRequestAuthority(subjectRef: string): RequestAuthority {
          const authority = Object.freeze({})
          claims.set(authority, Object.freeze({ subjectRef }))
          return authority as RequestAuthority
        }
      `,
      'packages/backend/src/modules/identity-access/public/events.ts': `
        import type { RequestAuthority } from './participants'
        export type BadAuthorityEvent = Readonly<{ authority: RequestAuthority }>
      `,
      'packages/backend/src/modules/tasks/application/forge.ts': `
        import type { RequestAuthority as Trusted } from '@/modules/identity-access/public/participants'
        type LocalAuthority = Trusted
        export function forge(real: LocalAuthority, raw: string): LocalAuthority {
          const parsed = JSON.parse(raw) as LocalAuthority
          const changed = { ...real, subjectRef: 'other' } as LocalAuthority
          changed.subjectRef = 'again'
          JSON.stringify(parsed)
          return changed
        }
      `,
    })
    const violations = capabilityForgeViolations(mutated).join('\n')
    expect(violations).toContain('casts/rewraps RequestAuthority outside owner factory')
    expect(violations).toContain('mutates sensitive changed')
    expect(violations).toContain('serializes sensitive capability/authority')
    expect(violations).toContain('RequestAuthority leaks through public/events')
  })
})

// BEGIN COMMITTED G3 BASELINES — committed source 2a70c93285000d9413dfb7c2c835714a99701e2d.
const CROSS_CONTEXT_INTERNAL_DEBT: readonly string[] = [
  'packages/backend/src/modules/code-capability/infrastructure/postgresqlCapabilityTemplatePackageMutationOwner.ts -> packages/backend/src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants.ts',
  'packages/backend/src/modules/code-capability/infrastructure/postgresqlCapabilityTemplatePackageMutationOwner.ts -> packages/backend/src/modules/resource-catalog/infrastructure/postgresql/repositorySupport.ts',
  'packages/backend/src/modules/collaboration/infrastructure/clarify/seal.ts -> packages/backend/src/modules/task-execution/infrastructure/taskLifecycleCommittedEvents.ts',
  'packages/backend/src/modules/collaboration/infrastructure/clarify/service.ts -> packages/backend/src/modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts',
  'packages/backend/src/modules/collaboration/infrastructure/clarifyDecision.ts -> packages/backend/src/modules/task-execution/infrastructure/taskDecisionParticipant.ts',
  'packages/backend/src/modules/collaboration/infrastructure/collaborationTaskAccess.ts -> packages/backend/src/modules/resource-catalog/application/resourceDefaults.ts',
  'packages/backend/src/modules/collaboration/infrastructure/collaborationWorkgroupClarify.ts -> packages/backend/src/modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts',
  'packages/backend/src/modules/collaboration/infrastructure/humanGateTerminalSweep.ts -> packages/backend/src/modules/task-execution/infrastructure/taskLifecycleCommittedEvents.ts',
  'packages/backend/src/modules/collaboration/infrastructure/review.ts -> packages/backend/src/modules/task-execution/application/nextRetryIndex.ts',
  'packages/backend/src/modules/collaboration/infrastructure/review.ts -> packages/backend/src/modules/task-execution/infrastructure/humanGateTaskTransition.ts',
  'packages/backend/src/modules/collaboration/infrastructure/review.ts -> packages/backend/src/modules/task-execution/infrastructure/nodeRunLifecyclePersistence.ts',
  'packages/backend/src/modules/collaboration/infrastructure/review.ts -> packages/backend/src/modules/task-execution/infrastructure/nodeRunLifecycleTransition.ts',
  'packages/backend/src/modules/collaboration/infrastructure/review.ts -> packages/backend/src/modules/task-execution/infrastructure/nodeRunMintParticipant.ts',
  'packages/backend/src/modules/collaboration/infrastructure/review.ts -> packages/backend/src/modules/task-execution/infrastructure/taskAuthorization.ts',
  'packages/backend/src/modules/collaboration/infrastructure/review.ts -> packages/backend/src/modules/task-execution/infrastructure/taskDecisionParticipant.ts',
  'packages/backend/src/modules/collaboration/infrastructure/reviewTaskAccess.ts -> packages/backend/src/modules/resource-catalog/application/resourceDefaults.ts',
  'packages/backend/src/modules/collaboration/infrastructure/reviewTaskAccess.ts -> packages/backend/src/modules/resource-catalog/domain/resourceAccess.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskCollab.ts -> packages/backend/src/modules/resource-catalog/application/resourceDefaults.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskCollab.ts -> packages/backend/src/modules/resource-catalog/domain/resourceAccess.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskQuestionDispatch.ts -> packages/backend/src/modules/task-execution/application/nextRetryIndex.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskQuestionDispatch.ts -> packages/backend/src/modules/task-execution/application/ports/nodeRunLifecyclePersistence.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskQuestionDispatch.ts -> packages/backend/src/modules/task-execution/infrastructure/nodeRunMintParticipant.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskQuestionDispatch.ts -> packages/backend/src/modules/task-execution/infrastructure/taskDecisionParticipant.ts',
  'packages/backend/src/modules/collaboration/infrastructure/taskQuestionDispatch.ts -> packages/backend/src/modules/task-execution/infrastructure/taskLifecycleCommittedEvents.ts',
  'packages/backend/src/modules/development-automation/infrastructure/developmentDeliveryProvider.ts -> packages/backend/src/modules/integration/composition/codeHostEffects.ts',
  'packages/backend/src/modules/development-automation/infrastructure/missionCodeHostEventContinuation.ts -> packages/backend/src/modules/integration/application/ports/codeHostEventResponse.ts',
  'packages/backend/src/modules/integration/application/mrTerminalControlWorker.ts -> packages/backend/src/modules/task-execution/application/sourceTerminationCapability.ts',
  'packages/backend/src/modules/integration/composition/scheduledTasks.ts -> packages/backend/src/modules/resource-catalog/composition/integrationTrigger.ts',
  'packages/backend/src/modules/integration/composition/webhookIngress.ts -> packages/backend/src/modules/event-center/composition.ts',
  'packages/backend/src/modules/integration/composition/webhookTerminalControl.ts -> packages/backend/src/modules/task-execution/application/sourceTerminationCapability.ts',
  'packages/backend/src/modules/integration/infrastructure/integrationTriggerResources.ts -> packages/backend/src/modules/digital-employee/composition.ts',
  'packages/backend/src/modules/integration/infrastructure/integrationTriggerResources.ts -> packages/backend/src/modules/resource-catalog/composition/integrationTrigger.ts',
  'packages/backend/src/modules/intent/composition/apply.ts -> packages/backend/src/modules/resource-catalog/application/ports/providerResourceCatalogPersistence.ts',
  'packages/backend/src/modules/intent/composition/apply.ts -> packages/backend/src/modules/resource-catalog/composition/intentApply.ts',
  'packages/backend/src/modules/intent/composition/apply.ts -> packages/backend/src/modules/resource-catalog/infrastructure/aclReadRepository.ts',
  'packages/backend/src/modules/intent/composition/apply.ts -> packages/backend/src/modules/resource-catalog/infrastructure/mcpTransactionLifecycle.ts',
  'packages/backend/src/modules/intent/infrastructure/intentApplyEngine.ts -> packages/backend/src/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourceParticipants.ts',
  'packages/backend/src/modules/knowledge-evolution/application/fusionOrchestration.ts -> packages/backend/src/modules/memory/public/catalog.ts',
  'packages/backend/src/modules/knowledge-evolution/application/fusionOrchestration.ts -> packages/backend/src/modules/task-execution/domain/taskLaunchOrigin.ts',
  'packages/backend/src/modules/knowledge-evolution/application/skillProvenanceQuery.ts -> packages/backend/src/modules/memory/public/catalog.ts',
  'packages/backend/src/modules/knowledge-evolution/composition/fusion.ts -> packages/backend/src/modules/memory/public/catalog.ts',
  'packages/backend/src/modules/knowledge-evolution/inbound/fusionRoutes.ts -> packages/backend/src/modules/memory/public/catalog.ts',
  'packages/backend/src/modules/knowledge-evolution/inbound/fusionRoutes.ts -> packages/backend/src/modules/task-execution/inbound/directTaskInitiator.ts',
  'packages/backend/src/modules/knowledge-evolution/inbound/skillProvenanceRoutes.ts -> packages/backend/src/modules/memory/public/catalog.ts',
  'packages/backend/src/modules/knowledge-evolution/public/participants.ts -> packages/backend/src/modules/memory/public/catalog.ts',
  'packages/backend/src/modules/resource-catalog/composition/crewstationMcpDiagnostics.ts -> packages/backend/src/modules/task-execution/composition/crewstationMcpDiagnosticRunner.ts',
  'packages/backend/src/modules/resource-catalog/infrastructure/adapters/runtimeProfileParticipants.ts -> packages/backend/src/modules/runtime-management/application/ports/runtimeProfileParticipants.ts',
  'packages/backend/src/modules/runtime-management/application/ports/agentLiveCapture.ts -> packages/backend/src/modules/task-execution/application/ports/runtimeSessionCapturePersistence.ts',
  'packages/backend/src/modules/runtime-management/infrastructure/local/taskAgentRuntimeBindings.ts -> packages/backend/src/modules/task-execution/application/ports/nodeRunRuntimePersistence.ts',
  'packages/backend/src/modules/system-operations/application/overview.ts -> packages/backend/src/modules/memory/public/catalog.ts',
  'packages/backend/src/modules/system-operations/composition.ts -> packages/backend/src/modules/knowledge-evolution/composition/fusion.ts',
  'packages/backend/src/modules/system-operations/composition.ts -> packages/backend/src/modules/memory/composition.ts',
  'packages/backend/src/modules/system-operations/composition.ts -> packages/backend/src/modules/resource-catalog/composition/skillVersionCommit.ts',
  'packages/backend/src/modules/system-operations/composition.ts -> packages/backend/src/modules/source-control/composition.ts',
  'packages/backend/src/modules/task-execution/composition/agentInvocation.ts -> packages/backend/src/modules/runtime-management/infrastructure/local/agentMaterialCompiler.ts',
  'packages/backend/src/modules/task-execution/composition/agentInvocation.ts -> packages/backend/src/modules/runtime-management/infrastructure/local/agentMaterialEvidence.ts',
  'packages/backend/src/modules/task-execution/composition/crewstationRuntimeManagement.ts -> packages/backend/src/modules/runtime-management/composition/crewstationRuntimeManagement.ts',
  'packages/backend/src/modules/task-execution/composition/crewstationRuntimeManagement.ts -> packages/backend/src/modules/runtime-management/composition/crewstationSystemAgentMaterial.ts',
  'packages/backend/src/modules/task-execution/composition/crewstationRuntimeManagement.ts -> packages/backend/src/modules/runtime-management/composition/runtimeManagement.ts',
  'packages/backend/src/modules/task-execution/composition/crewstationSystemAgentRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/crewstationSystemAgentMaterial.ts',
  'packages/backend/src/modules/task-execution/composition/crewstationSystemAgentRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/systemAgentMaterial.ts',
  'packages/backend/src/modules/task-execution/composition/gateContinuationPreDrive.ts -> packages/backend/src/modules/collaboration/infrastructure/clarifyContinuationConvergence.ts',
  'packages/backend/src/modules/task-execution/composition/gateContinuationPreDrive.ts -> packages/backend/src/modules/collaboration/infrastructure/humanGateOperationPersistence.ts',
  'packages/backend/src/modules/task-execution/composition/localRuntimeManagement.ts -> packages/backend/src/modules/runtime-management/composition/runtimeDiagnosticTargets.ts',
  'packages/backend/src/modules/task-execution/composition/localRuntimeManagement.ts -> packages/backend/src/modules/runtime-management/composition/runtimeManagement.ts',
  'packages/backend/src/modules/task-execution/composition/localRuntimeManagement.ts -> packages/backend/src/modules/runtime-management/infrastructure/local/runtimeManagementEffects.ts',
  'packages/backend/src/modules/task-execution/composition/localRuntimeSmokeRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/localAgentMaterial.ts',
  'packages/backend/src/modules/task-execution/composition/localRuntimeSmokeRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/runtimeDiagnosticTargets.ts',
  'packages/backend/src/modules/task-execution/composition/localRuntimeSmokeRunFamily.ts -> packages/backend/src/modules/runtime-management/infrastructure/local/agentProtocol.ts',
  'packages/backend/src/modules/task-execution/composition/localSystemAgentRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/localAgentMaterial.ts',
  'packages/backend/src/modules/task-execution/composition/localSystemAgentRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/systemAgentMaterial.ts',
  'packages/backend/src/modules/task-execution/composition/localTaskAgentRunFamily.ts -> packages/backend/src/modules/resource-catalog/composition/taskAgentMaterialReferences.ts',
  'packages/backend/src/modules/task-execution/composition/localTaskAgentRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/localAgentMaterial.ts',
  'packages/backend/src/modules/task-execution/composition/localTaskAgentRunFamily.ts -> packages/backend/src/modules/runtime-management/composition/taskAgentRuntimeBindings.ts',
  'packages/backend/src/modules/task-execution/composition/localTaskAgentRunFamily.ts -> packages/backend/src/modules/source-control/composition/agentWorkspaceGitControl.ts',
  'packages/backend/src/modules/task-execution/composition/localTaskAgentRunFamily.ts -> packages/backend/src/modules/source-control/composition/taskAgentWorkspaceContents.ts',
  'packages/backend/src/modules/task-execution/composition/providerRuntime.ts -> packages/backend/src/modules/collaboration/composition.ts',
  'packages/backend/src/modules/task-execution/composition/taskDeletionEffects.ts -> packages/backend/src/modules/source-control/composition.ts',
  'packages/backend/src/modules/task-execution/composition/taskExecutionPersistence.ts -> packages/backend/src/modules/source-control/composition/workspacePresence.ts',
  'packages/backend/src/modules/task-execution/composition/triggerExecution.ts -> packages/backend/src/modules/integration/application/ports/webhookExecution.ts',
  'packages/backend/src/modules/task-execution/infrastructure/agentLaunchResourceOperations.ts -> packages/backend/src/modules/resource-catalog/composition/resourceAcl.ts',
  'packages/backend/src/modules/task-execution/infrastructure/agentLaunchResourceOperations.ts -> packages/backend/src/modules/resource-catalog/infrastructure/legacy/agent.ts',
  'packages/backend/src/modules/task-execution/infrastructure/agentLaunchResourceOperations.ts -> packages/backend/src/modules/resource-catalog/infrastructure/legacy/workflow.validator.ts',
  'packages/backend/src/modules/task-execution/infrastructure/humanGateTaskLifecyclePersistence.ts -> packages/backend/src/modules/collaboration/infrastructure/humanGateOpenParticipant.ts',
  'packages/backend/src/modules/task-execution/infrastructure/humanGateTaskLifecyclePersistence.ts -> packages/backend/src/modules/collaboration/infrastructure/humanGateOperationJournal.ts',
  'packages/backend/src/modules/task-execution/infrastructure/local/nativeTaskAgentRun.ts -> packages/backend/src/modules/runtime-management/infrastructure/local/agentProtocol.ts',
  'packages/backend/src/modules/task-execution/infrastructure/local/nativeTaskAgentRun.ts -> packages/backend/src/modules/source-control/composition/agentWorkspaceGitControl.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskCatalogSources.ts -> packages/backend/src/modules/task-catalog/composition/required-ports.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskExecutionCatalogSources.ts -> packages/backend/src/modules/task-catalog/composition/required-ports.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskRouteLaunchOperations.ts -> packages/backend/src/modules/integration/public/mrTerminalControl.ts',
  'packages/backend/src/modules/task-execution/infrastructure/workgroupLaunchResourceOperations.ts -> packages/backend/src/modules/resource-catalog/composition/resourceAcl.ts',
  'packages/backend/src/modules/task-execution/infrastructure/workgroupLaunchResourceOperations.ts -> packages/backend/src/modules/resource-catalog/infrastructure/legacy/workgroups.ts',
]
const PUBLIC_SURFACE_DEBT: readonly string[] = [
  'modules/development-automation/composition/pipelineEvidence.ts#composeSelectedDevelopmentPipelineEvidence: unsafe/open type ObjectKeyword',
  'modules/identity-access/public/participants.ts#HttpAuthenticationParticipant: unsafe/open type FunctionType',
  'modules/identity-access/public/participants.ts#WebSocketAuthenticationParticipant: unsafe/open type FunctionType',
  'modules/identity-access/public/participants.ts#WebSocketCredential: unsafe/open type ObjectKeyword',
  'modules/integration/application/ports/developmentPurposeBinding.ts#RequirementAdapterBinding: unsafe/open type ObjectKeyword',
  'modules/integration/application/ports/scheduledTaskPersistence.ts#IntegrationOverviewQueries: forbidden type import @/auth/actor#Actor',
  'modules/integration/public/mrTerminalControl.ts: non-exact public entrypoint',
  'modules/knowledge-evolution/public/participants.ts#FusionOperations: forbidden type import @/auth/actor#Actor',
  'modules/knowledge-evolution/public/participants.ts#FusionPersistence: forbidden type Partial',
  'modules/knowledge-evolution/public/participants.ts#FusionPersistence: forbidden type import @/auth/actor#Actor',
  'modules/memory/public/catalog.ts: non-exact public entrypoint',
  'modules/resource-catalog/application/intent/artifactOwners.ts#IntentSkillArtifactOwner: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  'modules/resource-catalog/application/ports/taskAgentMaterialReferences.ts#TaskAgentMaterialReferences: forbidden type import @/util/log#Logger',
  'modules/resource-catalog/public/participants.ts#HostedIntentResourceArtifacts: unsafe/open type UnknownKeyword',
  'modules/resource-catalog/public/participants.ts#SkillVersionCommitHooks: unsafe/open type FunctionType',
  'modules/resource-catalog/public/queries.ts#AgentResourceIntegrityQueries: unsafe/open type TypeQuery',
  'modules/run-observability/application/ports/taskFacts.ts#ObservationTaskFactsPort: forbidden type import @/auth/actor#Actor',
  'modules/runtime-management/application/ports/agentMaterialEvidence.ts#AgentMaterialEvidence: forbidden type import @/services/runtime/types#NormalizedEvent',
  'modules/runtime-management/application/ports/agentMaterialEvidence.ts#AgentMaterialEvidence: forbidden type import @/services/runtime/types#SessionCaptureContext',
  'modules/runtime-management/application/ports/agentMaterialEvidence.ts#AgentMaterialEvidence: forbidden type import @/services/runtime/types#SystemAgentSessionSweepContext',
  'modules/runtime-management/application/ports/agentMaterialEvidence.ts#AgentMaterialEvidence: forbidden type import @/services/runtime/types#SystemAgentSessionSweepOutcome',
  'modules/runtime-management/application/ports/agentMaterialEvidence.ts#AgentMaterialEvidence: forbidden type import @/util/log#Logger',
  'modules/runtime-management/application/ports/agentMaterialEvidence.ts#AgentMaterialEvidence: unsafe/open type FunctionType',
  'modules/runtime-management/application/ports/agentProtocol.ts#AgentInvocationProtocol: forbidden type import @/services/runtime/types#NormalizedEvent',
  'modules/runtime-management/application/ports/agentProtocol.ts#AgentInvocationProtocol: forbidden type import @/services/runtime/types#RuntimeDriverCapabilities',
  'modules/runtime-management/application/ports/agentProtocol.ts#AgentInvocationProtocol: forbidden type import @/services/runtime/types#SystemEventObservation',
  'modules/runtime-management/application/ports/agentProtocol.ts#AgentInvocationProtocol: unsafe/open type UnknownKeyword',
  'modules/runtime-management/application/ports/agentSessionEvents.ts#SystemAgentEventSinkV1: forbidden type import @/services/runtime/types#NormalizedEventKind',
  'modules/runtime-management/domain/usageMeter.ts#JsonObject: unsafe/open type UnknownKeyword',
  'modules/runtime-management/domain/usageMeter.ts#modelKey: unsafe/open type UnknownKeyword',
  'modules/runtime-management/public/commands.ts#RuntimeProfileCommands: unsafe/open type UnknownKeyword',
  'modules/runtime-management/public/participants.ts#RealtimeChannelAccess: forbidden type import @/auth/actor#Actor',
  'modules/runtime-management/public/participants.ts#RealtimeChannelAccess: forbidden type import @/auth/actor#ActorSource',
  'modules/runtime-management/public/participants.ts#RealtimeCompositionPolicy: forbidden type import @/auth/actor#Actor',
  'modules/runtime-management/public/participants.ts#RealtimeCompositionPolicy: forbidden type import @/auth/actor#ActorSource',
  'modules/runtime-management/public/participants.ts#RealtimeCompositionPolicy: unsafe/open type FunctionType',
  'modules/runtime-management/public/participants.ts#RealtimeCompositionPolicy: unsafe/open type UnknownKeyword',
  'modules/source-control/composition/isolationWorkspaces.ts#requireIsolationWorkspaceScope: unsafe/open type UnknownKeyword',
  'modules/source-control/composition/isolationWorkspaces.ts#selectIsolationWorkspaceFactory: forbidden type import @/util/log#Logger',
  'modules/source-control/composition/isolationWorkspaces.ts#selectIsolationWorkspaceFactory: unsafe/open type FunctionType',
  'modules/source-control/composition/repositoryGitWorkspaces.ts#selectRepositoryGitWorkspaceFactory: unsafe/open type FunctionType',
  'modules/source-control/composition/repositoryGitWorkspaces.ts#selectRepositoryGitWorkspaceFactory: unsafe/open type TypeQuery',
  'modules/source-control/composition/workspaceExcludeProfiles.ts#selectWorkspaceExcludeProfileFactory: unsafe/open type FunctionType',
  'modules/source-control/composition/workspaceUploads.ts#requireWorkspaceUploadContent: unsafe/open type UnknownKeyword',
  'modules/source-control/infrastructure/crewstation/workspaceOwnership.ts#readHostedWorkspaceOwnerForBusinessTask: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/source-control/infrastructure/repositoryScopeAuthorization.ts#repositoryScopeExistenceReads: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  'modules/source-control/public/types.ts#WorkspaceMaintenanceEffects: forbidden type import @/util/git#WorktreeCleanupProvenance',
  'modules/source-control/public/types.ts#WorkspaceMaintenanceEffects: unsafe/open type FunctionType',
  'modules/system-operations/application/ports/executionAuthority.ts#ExecutionAuthorityPort: forbidden type Partial',
  'modules/system-operations/application/ports/executionAuthority.ts#ExecutionAuthorityPort: unsafe/open type FunctionType',
  'modules/system-operations/infrastructure/crewstation/objectPublicationContract.ts#HostedObjectPublications: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/system-operations/infrastructure/crewstation/objectPublicationContract.ts#HostedObjectPublications: unsafe/open type FunctionType',
  'modules/system-operations/infrastructure/crewstation/restoreNormalizationContract.ts#HostedRestoreNormalizationParticipant: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/system-operations/public/commands.ts#ApplicationConfigurationCommands: unsafe/open type UnknownKeyword',
  'modules/system-operations/public/queries.ts#SystemOverviewAuthority: forbidden type import @/auth/actor#Actor',
  'modules/task-execution/application/frameChain.ts#loadFrameChain: unsafe/open type FunctionType',
  'modules/task-execution/application/launchConfiguration.ts#resolveTaskCommitPushFromReader: unsafe/open type FunctionType',
  'modules/task-execution/application/launchConfiguration.ts#resolveTaskLaunchRuntimeFromReader: unsafe/open type FunctionType',
  'modules/task-execution/application/launchConfiguration.ts#resolveTaskSubagentLiveCaptureFromReader: unsafe/open type FunctionType',
  'modules/task-execution/application/launchConfiguration.ts#resolveTaskUploadLimitsFromReader: unsafe/open type FunctionType',
  'modules/task-execution/application/ports/agentInvocation.ts#AgentInvocationBinding: forbidden type import @/services/runtime/types#NormalizedEvent',
  'modules/task-execution/application/ports/agentInvocation.ts#AgentInvocationBinding: forbidden type import @/services/runtime/types#SystemEventObservation',
  'modules/task-execution/application/ports/agentInvocation.ts#AgentInvocationBinding: forbidden type import @/util/log#Logger',
  'modules/task-execution/application/ports/agentInvocation.ts#AgentInvocationBinding: unsafe/open type FunctionType',
  'modules/task-execution/application/ports/agentInvocation.ts#AgentInvocationBinding: unsafe/open type UnknownKeyword',
  'modules/task-execution/application/ports/runtimeSmoke.ts#RuntimeSmokeInvocationFamily: forbidden type import @/util/log#Logger',
  'modules/task-execution/application/ports/systemAgentRunFamily.ts#SystemAgentRunFamily: forbidden type import @/util/log#Logger',
  'modules/task-execution/application/ports/taskExecutionResourceSnapshots.ts#TaskExecutionResourceAuthority: forbidden type import @/auth/actor#Actor',
  'modules/task-execution/application/ports/taskRecoveryOperations.ts#TaskBootOrphanOperations: unsafe/open type UnknownKeyword',
  'modules/task-execution/application/workspaceUploads.ts#resolveUniqueUploadNameSync: unsafe/open type FunctionType',
  'modules/task-execution/domain/environmentChain.ts#resolveSourceFrame: unsafe/open type FunctionType',
  'modules/task-execution/infrastructure/isolationCleanup.ts#discardNodeIso: forbidden type import @/platform/workspace/local/isolation#DiscardLock',
  'modules/task-execution/infrastructure/isolationCleanup.ts#discardNodeIso: forbidden type import @/platform/workspace/local/isolation#IsoHandle',
  'modules/task-execution/infrastructure/isolationCleanup.ts#discardNodeIso: forbidden type import @/util/log#Logger',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#createIsoUnderLock: forbidden type Partial',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#createIsoUnderLock: forbidden type import @/services/nodeIsolation#CanonRepo',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#createIsoUnderLock: forbidden type import @/services/nodeIsolation#IsoHandle',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#createIsoUnderLock: forbidden type import @/util/log#Logger',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#createIsoUnderLock: unsafe/open type FunctionType',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#createIsoUnderLock: unsafe/open type UnknownKeyword',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#markMergeFailed: forbidden type import @/util/log#Logger',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#mergeBackAndSettle: forbidden type import @/services/nodeIsolation#IsoHandle',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#mergeBackAndSettle: forbidden type import @/services/nodeIsolation#MergeBackConflict',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#mergeBackAndSettle: forbidden type import @/util/log#Logger',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#mergeBackAndSettle: unsafe/open type FunctionType',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#persistIsoBase: forbidden type import @/services/nodeIsolation#IsoHandle',
  'modules/task-execution/infrastructure/isolatedAgentRun.ts#persistIsoNodeTree: forbidden type import @/services/nodeIsolation#IsoHandle',
  'modules/task-execution/public/commands.ts#AgentRouteTaskLaunchOperations: forbidden type import @/auth/actor#Actor',
  'modules/task-execution/public/commands.ts#WorkgroupRouteTaskLaunchOperations: forbidden type import @/auth/actor#Actor',
  'modules/task-execution/public/commands.ts#WorkgroupTaskRoomTaskParticipantInTx: forbidden type import @/platform/events/committed/types#CommittedEventRef',
  'modules/task-execution/public/participants.ts#createTerminalMaintenanceStore: unsafe/open type TypeQuery',
  'modules/task-execution/public/queries.ts#TaskOverviewQuery: forbidden type import @/auth/actor#Actor',
  'modules/task-execution/public/taskRoutes.ts#TaskRouteOperations: forbidden type import @/auth/actor#Actor',
  'modules/task-execution/public/taskRoutes.ts#TaskRouteOperations: unsafe/open type FunctionType',
  'modules/task-execution/public/taskRoutes.ts: non-exact public entrypoint',
  'modules/task-execution/public/types.ts#TaskClarifyDirectiveRouteOperations: forbidden type import @/auth/actor#Actor',
  'packages/shared/src/schemas/workflow.ts#parseLoopExitCondition: unsafe/open type UnknownKeyword',
  // RFC-395 II-a transitional owner contracts bound to the caller's session / transaction / statement.
  // Successor RFC-294 S5/S6: binding in composition; shared platform DTOs avoid new context edges.
  'modules/resource-catalog/infrastructure/executionResourceQueries.ts#createAgentExecutionQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/resource-catalog/infrastructure/executionResourceQueries.ts#createWorkflowExecutionQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/resource-catalog/infrastructure/executionResourceQueries.ts#workflowNameExpression: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/resource-catalog/infrastructure/executionResourceQueries.ts#workflowNameExpression: forbidden type import drizzle-orm#SQL',
  'modules/resource-catalog/infrastructure/executionResourceQueries.ts#workflowNameExpression: forbidden type import drizzle-orm#SQLWrapper',
  'modules/source-control/infrastructure/repositoryIdentityQueries.ts#existingRepositoryIds: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/source-control/infrastructure/repositoryIdentityQueries.ts#repositoryExistsExpression: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/source-control/infrastructure/repositoryIdentityQueries.ts#repositoryExistsExpression: forbidden type import drizzle-orm#SQL',
  'modules/source-control/infrastructure/repositoryIdentityQueries.ts#repositoryExistsExpression: forbidden type import drizzle-orm#SQLWrapper',
  'modules/task-execution/composition/taskSubjectQueries.ts#createTaskSubjectQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/consumedInputsParticipant.ts#createConsumedInputsParticipantInTx: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  'modules/task-execution/infrastructure/humanGatePersistenceParticipant.ts#createHumanGatePersistenceParticipantInTx: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  'modules/task-execution/infrastructure/nodeEventQueries.ts#listNodeEventContents: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/nodeOutputQueries.ts#createNodeOutputQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/nodeRunQueries.ts#createNodeRunQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/nodeRunQueries.ts#createNodeRunQueries: forbidden type import @/platform/taskCheckpoint#TaskCheckpointRollbackRequest',
  'modules/task-execution/infrastructure/nodeRunQueries.ts#nodeRunStatusCondition: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/nodeRunQueries.ts#nodeRunStatusCondition: forbidden type import drizzle-orm#AnyColumn',
  'modules/task-execution/infrastructure/runSelection/oracle/reader.ts#createRunSelectionReader: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/runSelection/selectionWrite.ts#reselectRunInTx: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  'modules/task-execution/infrastructure/taskClarifyDirectivePersistence.ts#createTaskClarifyDirectivePersistence: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskGateQueries.ts#createTaskGateQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskGateQueries.ts#taskGateOpenCondition: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskGateQueries.ts#taskGateOpenCondition: forbidden type import drizzle-orm#AnyColumn',
  'modules/task-execution/infrastructure/taskGateQueries.ts#taskGateOpenCondition: forbidden type import drizzle-orm#SQL',
  'modules/task-execution/infrastructure/taskGateQueries.ts#taskGateVisibleCondition: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskGateQueries.ts#taskGateVisibleCondition: forbidden type import drizzle-orm#AnyColumn',
  'modules/task-execution/infrastructure/taskGateQueries.ts#taskGateVisibleCondition: forbidden type import drizzle-orm#SQL',
  'modules/task-execution/infrastructure/taskKnowledgeQueries.ts#createTaskKnowledgeQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskTriggerQueries.ts#createTaskTriggerQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/public/commands.ts#WorkgroupHostLedgerRun: forbidden type import @/platform/runSelectionProjection#WorkgroupRunSelectionProjection',
  'modules/task-execution/public/commands.ts#WorkgroupTaskRoomHostRunSnapshot: forbidden type import @/platform/runSelectionProjection#WorkgroupRunSelectionProjection',
  'modules/collaboration/infrastructure/taskDeletionParticipant.ts#createTaskDeletionCollaborationParticipantInTx: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  'modules/task-execution/infrastructure/taskDeletionQueries.ts#createTaskDeletionQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskDeletionParticipant.ts#createTaskDeletionParticipantInTx: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  'modules/task-execution/infrastructure/taskDetailQueries.ts#createTaskDetailQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskPreparationQueries.ts#createTaskPreparationQueries: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/taskPreparationParticipant.ts#createTaskPreparationParticipantInTx: forbidden type import @/platform/persistence/persistenceDb#PersistenceTx',
  // RFC-395 II-b O3, plan §6.13: user-accepted same-statement webhook DELETE fragment.
  'modules/task-execution/infrastructure/nonTerminalTaskExists.ts#nonTerminalTaskExists: forbidden type import @/platform/persistence/persistenceDb#PersistenceDb',
  'modules/task-execution/infrastructure/nonTerminalTaskExists.ts#nonTerminalTaskExists: forbidden type import drizzle-orm#AnyColumn',
  'modules/task-execution/infrastructure/nonTerminalTaskExists.ts#nonTerminalTaskExists: forbidden type import drizzle-orm#SQL',
]
// END COMMITTED G3 BASELINES
const G3_SUCCESSORS = {
  crossContext: {
    successor: 'RFC-294 S5/S6',
    reason: 'Replace cross-context internal imports with exact public contracts.',
  },
  publicSurface: {
    successor: 'RFC-294 S5/S6',
    reason: 'Close retained public DTO and entrypoint deviations through exact contracts.',
  },
}

// RFC-349's provider cutover exposed existing cross-domain transaction-bound
// participants that the 2026-08 W0-R capability-name heuristic classifies as
// opaque capabilities. Keep that heuristic exact for the historical corpus:
// an added or retired finding changes this list, while the target fixtures
// above continue to prove real cast/serialization/forge mutations turn red.
const CAPABILITY_COMPATIBILITY_DEBT: string[] = [
  'modules/collaboration/infrastructure/clarifyDecision.ts: constructs ClarifySealDecisionParticipantInTx outside owner factory',
  'modules/collaboration/infrastructure/workgroupTaskRoomClarifyParticipant.ts#createWorkgroupTaskRoomClarifyParticipantInTx: factory is outside capability owner',
  'modules/collaboration/infrastructure/workgroupTaskRoomClarifyParticipant.ts: casts/rewraps WorkgroupTaskRoomClarifyParticipantInTx outside owner factory',
  'modules/collaboration/public/types.ts: ReviewActor leaks through public/types',
  // RFC-365：IA 的 event-automation delegated-context adapter 按既有 `delegatedRequests`
  // 形态重包 `Actor`（与 `forSchedule` / `forWebhook` 同族），命中这条历史启发式。
  'modules/identity-access/application/adapters/event-automation-adapter.ts: casts/rewraps Actor outside owner factory',
  'modules/task-execution/application/sourceTerminationCapability.ts#mintSourceTerminationEffectCapability: factory is outside capability owner',
  'modules/task-execution/application/sourceTerminationCapability.ts: casts/rewraps SourceTerminationEffectCapability outside owner factory',
  // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①②）：触发器参与者两个引擎合成一份，
  // 这两条因此塌成一条（`createTaskExecutionTriggerParticipant`）。
  'modules/task-execution/composition/triggerExecution.ts#createTaskExecutionTriggerParticipant: factory is outside capability owner',
  // RFC-395 II-a A2/A3/A7: existing caller-owned writes moved into these exact InTx ports.
  'modules/task-execution/infrastructure/consumedInputsParticipant.ts#createConsumedInputsParticipantInTx: factory is outside capability owner',
  'modules/task-execution/infrastructure/humanGatePersistenceParticipant.ts#createHumanGatePersistenceParticipantInTx: factory is outside capability owner',
  'modules/task-execution/infrastructure/nodeRunLifecyclePersistence.ts#createNodeRunLifecycleParticipantInTx: factory is outside capability owner',
  'modules/task-execution/infrastructure/nodeRunMintParticipant.ts#createNodeRunMintParticipantInTx: factory is outside capability owner',
  // RFC-395 II-a A3: proposed-revision participant is a port adapter, with no persisted selection state yet.
  'modules/task-execution/infrastructure/runSelection/oracle/participant.ts#createRunSelectionParticipantInTx: factory is outside capability owner',
  'modules/task-execution/infrastructure/runtimeSessionLeaseOperations.ts: constructs RuntimeSessionLeaseToken outside owner factory',
  'modules/task-execution/infrastructure/taskAuthorization.ts#createTaskAuthorizationParticipantInTx: factory is outside capability owner',
  'modules/task-execution/infrastructure/taskCreationParticipant.ts#createTaskCreationParticipantInTx: factory is outside capability owner',
  'modules/task-execution/infrastructure/workgroupHostLedgerParticipant.ts#createWorkgroupHostLedgerParticipantInTx: factory is outside capability owner',
  'modules/task-execution/infrastructure/workgroupTaskRoomTaskParticipant.ts#createWorkgroupTaskRoomTaskParticipantInTx: factory is outside capability owner',
  'modules/task-execution/public/participants.ts#TaskDecisionParticipantInTx: missing owner factory',
  'modules/task-execution/public/participants.ts#TaskDecisionParticipantInTx: missing private brand',
  'modules/task-execution/public/participants.ts#TaskDecisionParticipantInTx: not readonly',
  'modules/task-execution/public/types.ts: Actor leaks through public/types',
  'modules/task-execution/public/types.ts: TaskPortArtifactActor leaks through public/types',
]

describe('RFC-294 W0-R current modules ratchet', () => {
  const modules = typeResolutionCorpus()
  test('cross-context internals match the in-file file-pair allowlist exactly', () => {
    expect(exactAllowlist(crossContextViolations(modules), CROSS_CONTEXT_INTERNAL_DEBT)).toEqual({
      unregistered: [],
      stale: [],
    })
  })
  test('public-surface deviations match the in-file symbol-root allowlist exactly', () => {
    expect(exactAllowlist(publicSurfaceViolations(modules), PUBLIC_SURFACE_DEBT)).toEqual({
      unregistered: [],
      stale: [],
    })
  }, 60_000)
  test('both allowlists reject missing and stale entries and retain successors', () => {
    for (const debt of [CROSS_CONTEXT_INTERNAL_DEBT, PUBLIC_SURFACE_DEBT]) {
      expect(debt.length).toBeGreaterThan(0)
      expect(exactAllowlist(debt, debt.slice(1)).unregistered).toEqual([debt[0]!])
      expect(exactAllowlist(debt, [...debt, 'fabricated: stale']).stale).toEqual([
        'fabricated: stale',
      ])
    }
    for (const entry of Object.values(G3_SUCCESSORS)) {
      expect(entry.successor).toMatch(/RFC-\d+/)
      expect(entry.reason.length).toBeGreaterThan(20)
    }
  })
  test('module capability ownership cannot be structurally forged or serialized', () => {
    expect(capabilityForgeViolations(modules)).toEqual(CAPABILITY_COMPATIBILITY_DEBT)
  }, 180_000)
})

// RFC-317 T13 —— 语料非空（守卫的守卫：architecture/rfc317-guard-corpus-floor.test.ts）。
//
// 上面每条断言的绿都可能来自两处：真的没有违规，或者**扫描根失效、语料被筛成空**。
// 两者在断言层面同形，后者是永久静默的假绿。这一条把「扫描器还活着」变成可断言事实；
// 下限同时两向钉进 architecture/guard-manifest.json，静默调低会红。
describe('RFC-317 T13 —— 语料非空', () => {
  // 全模块仍逐个构建 AST；hosted macOS 实际用了 5469.66ms，超过默认 5s。
  // 本例验证语料下限，按同类全语料扫描分配 30s；扫描与 120 阈值保持。
  test('扫描确实覆盖到源码语料（扫空即假绿）', () => {
    expect(productionModuleUnits().length).toBeGreaterThanOrEqual(120)
  }, 30_000)
})
