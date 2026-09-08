// Process-local historical regressions for scripts/rfc359-p0-mutations.ts.
// No production file is written. Each process replaces one real export, while
// existing tests retain the real database, transaction and task driver.
import {
  WG_PORT_ASSIGNMENTS,
  WG_PORT_DECISION,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASK_RESULTS,
  WG_PORT_TASKS_ADD,
} from '@agent-workflow/shared'
import { mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import type * as ClarifySeal from '../../src/modules/collaboration/infrastructure/clarify/seal'
import type * as TaskDagCollaboration from '../../src/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import type {
  createWorkgroupClarifyAskGate as CreateWorkgroupClarifyAskGate,
  WorkgroupClarifyAskInput,
} from '../../src/modules/collaboration/infrastructure/workgroupClarifyAskGate'
import type { renderWgProtocolBlock as RenderWgProtocolBlock } from '../../src/modules/resource-catalog/application/workgroups/workgroupProtocol'
import type * as WorkflowRepository from '../../src/modules/resource-catalog/infrastructure/workflowRepository'
import type * as DevelopmentAutomation from '../../src/modules/development-automation/composition'
import type * as SkillCatalogBoot from '../../src/modules/resource-catalog/composition/skillCatalogBoot'
import { TaskExecutionError } from '../../src/modules/task-execution/application/taskExecutionError'
import type * as TaskDriverRelease from '../../src/modules/task-execution/infrastructure/taskDriverRelease'
import type * as OwnedTaskExecution from '../../src/modules/task-execution/infrastructure/ownedTaskExecution'

function sourcePath(relative: string): string {
  return fileURLToPath(new URL(`../../src/${relative}`, import.meta.url))
}

async function restoreOutputOnlyProtocol(): Promise<void> {
  const target = sourcePath('modules/resource-catalog/application/workgroups/workgroupProtocol.ts')
  const original = await import(target)
  // 01e4b1b7b: resource-catalog/application/workgroups/workgroupTurnsDriver.ts
  // lines 425–439. Rendering bytes are original; only the private role type and
  // current fc_member spelling are adapted to the current exported signature.
  type OriginalRole = 'leader' | 'worker' | 'fc-member'
  function protocolPorts(role: OriginalRole): string[] {
    if (role === 'leader') return [WG_PORT_ASSIGNMENTS, WG_PORT_MESSAGES, WG_PORT_DECISION]
    if (role === 'fc-member') return [WG_PORT_TASK_RESULTS, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]
    return [WG_PORT_RESULT, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]
  }
  function protocolBlock(role: OriginalRole, envelopeNonce: string): string {
    return [
      '## Workgroup output protocol',
      `This is the ${role} turn.`,
      `Emit only declared workgroup JSON ports in <workflow-output nonce="${envelopeNonce}">.`,
      `Allowed ports: ${protocolPorts(role).join(', ')}.`,
    ].join('\n')
  }
  const renderWgProtocolBlock: typeof RenderWgProtocolBlock = (role, _config, nonce = '') =>
    protocolBlock(role === 'fc_member' ? 'fc-member' : role, nonce)
  mock.module(target, () => ({ ...original, renderWgProtocolBlock }))
}

async function restoreBudgetOnlyGate(): Promise<void> {
  const target = sourcePath('modules/collaboration/infrastructure/workgroupClarifyAskGate.ts')
  const original = await import(target)
  // 01e4b1b7b: workgroupTurnsDriver.ts:559–561, with only the config binding
  // adapted to the current input. It does not read the persisted ask count.
  // Both selected tests explicitly configure budget=1; no default is a witness.
  const createWorkgroupClarifyAskGate: typeof CreateWorkgroupClarifyAskGate = () =>
    Object.freeze({
      allowed: async (input: WorkgroupClarifyAskInput) =>
        input.members.some((member) => member.memberType === 'human') &&
        (input.clarifyBudget ?? 3) > 0,
    })
  mock.module(target, () => ({ ...original, createWorkgroupClarifyAskGate }))
}

async function restoreStrictClarifyTransition(): Promise<void> {
  const target = sourcePath('modules/collaboration/infrastructure/clarify/seal.ts')
  const original = await import(target)
  const current = `      if (flipNow) {
        await tx
          .update(nodeRuns)
          .set({ status: 'done', finishedAt: ts })
          .where(and(eq(nodeRuns.id, args.originNodeRunId), eq(nodeRuns.status, 'awaiting_human')))
      }`
  const source = readFileSync(target, 'utf8')
  if (source.split(current).length !== 2) throw new Error('P0-5 mutation site drifted')
  // 01e4b1b7b: postgresqlCollaborationRouteOperations.ts:2168–2188 calls
  // completeClarifyNode; postgresqlNodeRunLifecyclePersistence.ts:154–160 calls
  // set(allowedFrom=[expectedStatus]). Restore that strict call through today's
  // real participant in the SAME seal transaction. Its real terminal-row error
  // rolls back answers; no fabricated exception or fake transaction is involved.
  const participant = sourcePath(
    'modules/task-execution/infrastructure/nodeRunLifecyclePersistence.ts',
  )
  const changed = `import { createNodeRunLifecycleParticipantInTx } from ${JSON.stringify(participant)}\n${source.replace(
    current,
    `      if (flipNow) {
        await createNodeRunLifecycleParticipantInTx(tx).set({
          nodeRunId: args.originNodeRunId,
          to: 'done',
          allowedFrom: ['awaiting_human'],
          extra: { finishedAt: ts },
          reason: 'clarify-deferred-answer',
        })
      }`,
  )}`
  const virtualModule = registerMemorySource(target, changed, 'seal')
  const mutated: typeof ClarifySeal = await import(virtualModule)
  mock.module(target, () => ({ ...original, sealRoundQuestions: mutated.sealRoundQuestions }))
}

async function restoreDecodeBeforeWorkflowDelete(): Promise<void> {
  const target = sourcePath('modules/resource-catalog/infrastructure/workflowRepository.ts')
  const original: typeof WorkflowRepository = await import(target)
  const current = `    async delete(authority, id, deletion) {
      const deletedVersion = await runResourceCatalogTransaction(input.db, async (transaction) => {
        const row = (
          await transaction.select().from(workflows).where(eq(workflows.id, id)).limit(1)
        )[0]
        if (row === undefined) throw notFound(id)`
  const versionCheck = 'if (row.version !== deletion.expectedVersion) throw staleRow(id, row)'
  const source = readFileSync(target, 'utf8')
  if (source.split(current).length !== 2 || source.split(versionCheck).length !== 2) {
    throw new Error('P0-6 mutation site drifted')
  }
  // 01e4b1b7b: postgresqlWorkflowRepository.ts:256–259. The original delete
  // decoded the stored definition before checking the version. Restore those
  // two statements in the real transaction; the real JSON decoder supplies 422.
  const changed = source
    .replace(current, `${current}\n        const current = workflowFromPersistenceRow(row)`)
    .replace(
      versionCheck,
      'if (current.version !== deletion.expectedVersion) throw stale(id, current)',
    )
  const virtualModule = registerMemorySource(target, changed, 'workflow-delete')
  const mutated: typeof WorkflowRepository = await import(virtualModule)
  mock.module(target, () => ({
    ...original,
    createWorkflowRepository: mutated.createWorkflowRepository,
  }))
}

function registerMemorySource(
  target: string,
  changed: string,
  name: 'seal' | 'workflow-delete' | 'driver-release' | 'ownerless-recovery',
): string {
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' })
  const javascript = transpiler.transformSync(changed)
  let resolvedImports = 0
  const contents = javascript.replace(
    /\bfrom\s+(['"])([^'"]+)\1/g,
    (_all, _quote, specifier: string) => {
      resolvedImports += 1
      return `from ${JSON.stringify(Bun.resolveSync(specifier, dirname(target)))}`
    },
  )
  const imports = transpiler.scanImports(javascript)
  if (
    imports.some((item) => item.kind !== 'import-statement') ||
    imports.length !== resolvedImports
  ) {
    throw new Error(`${name} mutation import shape drifted`)
  }
  // A virtual module holds the in-memory source; mock.module changes only the
  // real exported function. This also avoids a copied repository/module on disk.
  const virtualModule = `rfc359-p0-mutation:${name}`
  Bun.plugin({
    name: `rfc359-${name}-memory-source`,
    setup(builder) {
      builder.module(virtualModule, () => ({ contents, loader: 'js' }))
    },
  })
  return virtualModule
}

interface DeferredTaskQuestionDispatcher {
  autoDispatchDeferredQuestions(taskId: string): Promise<void>
}

// Original class: 01e4b1b7b:cli/postgresqlDaemonApplication.ts:315–327.
// That root constructed the holder at 719 and never called bind on it.
class DeferredTaskQuestionDispatcherBinding implements DeferredTaskQuestionDispatcher {
  private current: DeferredTaskQuestionDispatcher | null = null

  bind(participant: DeferredTaskQuestionDispatcher): void {
    if (this.current !== null) throw new Error('deferred-question-dispatcher-already-bound')
    this.current = participant
  }

  async autoDispatchDeferredQuestions(taskId: string): Promise<void> {
    if (this.current === null) throw new Error('deferred-question-dispatcher-not-bound')
    await this.current.autoDispatchDeferredQuestions(taskId)
  }
}

async function restoreUnboundDeferredDispatcher(): Promise<void> {
  const target = sourcePath(
    'modules/collaboration/infrastructure/taskDagCollaborationOperations.ts',
  )
  const original: typeof TaskDagCollaboration = await import(target)
  const createOriginal = original.createTaskDagCollaborationOperations
  mock.module(target, () => ({
    ...original,
    createTaskDagCollaborationOperations: (db: Parameters<typeof createOriginal>[0]) => {
      const deferredQuestions = new DeferredTaskQuestionDispatcherBinding()
      return Object.freeze({
        ...createOriginal(db),
        autoDispatchDeferredQuestions: (taskId: string) =>
          deferredQuestions.autoDispatchDeferredQuestions(taskId),
      })
    },
  }))
}

async function restoreMissingLegacyMissionLaunchers(): Promise<void> {
  const target = sourcePath('modules/development-automation/composition.ts')
  const original: typeof DevelopmentAutomation = await import(target)
  const composeOriginal = original.composeDevelopmentAutomation
  // 01e4b1b7b: cli/postgresqlDaemonApplication.ts:1385–1400 constructed
  // composePostgresqlDevelopmentAutomation without either launcher. Restore
  // that exact input omission at today's shared factory; its actual admission,
  // materializer and orchestrator persist the original *-launcher-not-wired
  // block. No failure or database row is supplied by this preload.
  mock.module(target, () => ({
    ...original,
    composeDevelopmentAutomation: (
      input: Parameters<typeof original.composeDevelopmentAutomation>[0],
    ) => {
      const { agentLauncher: _agent, scriptLauncher: _script, ...withoutLaunchers } = input
      return composeOriginal(withoutLaunchers)
    },
  }))
}

async function restoreMissingLegacyTerminalForwarding(): Promise<void> {
  const target = sourcePath(
    'modules/development-automation/composition/executionTerminalObserver.ts',
  )
  const original = await import(target)
  // 01e4b1b7b: cli/postgresqlDaemonApplication.ts has no execution terminal
  // observer construction/call. Factor that omitted forwarding out from the
  // missing launchers above: the real host can finish, but no wake/collection
  // occurs. These empty callbacks model the absent CALL, not historical function
  // bytes. They provide no task/attempt result and manufacture no exception.
  mock.module(target, () => ({
    ...original,
    createDevelopmentMissionExecutionTerminalObserver: () =>
      Object.freeze({
        agent: async () => {},
        script: async () => {},
      }),
  }))
}

async function restoreMissingSkillBootCall(call: 'barrier' | 'reverify'): Promise<void> {
  const target = sourcePath('modules/resource-catalog/composition/skillCatalogBoot.ts')
  const original: typeof SkillCatalogBoot = await import(target)
  const composeOriginal = original.composeSkillCatalogBoot
  // 01e4b1b7b: cli/postgresqlDaemonApplication.ts:436 proceeds from restore
  // without constructing/calling skill boot; there is no skillCatalogBoot token
  // anywhere in that root. Restore the two omitted calls independently at the
  // real composer boundary. No empty receipt is invented: skipped calls return
  // void, and the nonempty tests inspect actual operations/locks/snapshot state.
  mock.module(target, () => ({
    ...original,
    composeSkillCatalogBoot: (input: Parameters<typeof composeOriginal>[0]) => ({
      ...composeOriginal(input),
      ...(call === 'barrier'
        ? { runIdentityMigrationBarrier: async () => {} }
        : { reverifySnapshots: async () => {} }),
    }),
  }))
}

async function restoreUnsettledDriverRelease(): Promise<void> {
  const target = sourcePath('modules/task-execution/infrastructure/taskDriverRelease.ts')
  const original: typeof TaskDriverRelease = await import(target)
  const source = readFileSync(target, 'utf8')
  const start = '      await persistence.effects.resolveQuiescedManagedProcesses({'
  const end = '    } else {\n      await persistence.ownership.markRecoveryRequired({'
  if (source.split(start).length !== 2 || source.split(end).length !== 2) {
    throw new Error('P0-10 mutation site drifted')
  }
  const from = source.indexOf(start)
  const to = source.indexOf(end, from)
  const removed = source.slice(from, to)
  if (
    to <= from ||
    !removed.includes('await persistence.effects.unresolvedEffectIds(input.taskId)') ||
    !removed.includes('await persistence.effects.closeOutcomeUnknownAndRelease({') ||
    !removed.includes('await persistence.ownership.releaseAfterStop({')
  ) {
    throw new Error('P0-10 release sequence drifted')
  }
  // 01e4b1b7b: postgresqlTaskDriverLifecycle.ts:106–159 released the owner
  // directly, without settling process effects or closing outcome-unknown.
  // The same real stop proof is already constructed immediately above this
  // span. Keep today's two-phase registry scaffolding: copying the historical
  // awaitStopped placement would deadlock the newer API, not reproduce P0-10.
  const changed = `${source.slice(0, from)}      await persistence.ownership.releaseAfterStop({
        token,
        intentId,
        proof: stopProof,
        now: verifiedAt,
      })
${source.slice(to)}`
  const mutated: typeof TaskDriverRelease = await import(
    registerMemorySource(target, changed, 'driver-release')
  )
  const releaseTaskDriverAndFinalize: typeof TaskDriverRelease.releaseTaskDriverAndFinalize =
    async (deps, input) => {
      try {
        await mutated.releaseTaskDriverAndFinalize(deps, input)
      } catch (error) {
        if (
          error instanceof TaskExecutionError &&
          error.code === 'task-execution-recovery-required'
        ) {
          // Read actual persistence after its failed release transaction. This
          // witness does not create the error, replace rows or alter settlement.
          const owner = await deps.persistence.ownership.read(input.taskId)
          const unresolved = await deps.persistence.effects.unresolvedEffectIds(input.taskId)
          console.error(
            `[rfc359-p0-10-state] ${JSON.stringify({
              taskId: input.taskId,
              ownerState: owner?.state,
              unresolvedEffectCount: unresolved.length,
            })}`,
          )
        }
        throw error
      }
    }
  mock.module(target, () => ({ ...original, releaseTaskDriverAndFinalize }))
}

async function restoreMissingTaskBootRecovery(): Promise<void> {
  const target = sourcePath('modules/task-execution/composition/bootRecovery.ts')
  const original = await import(target)
  // 01e4b1b7b: cli/start.ts:1570–1581 awaits the never-returning PostgreSQL
  // daemon from 1160–1163; the recovery calls at 2007–2037 are unreachable.
  // This empty callback models the omitted CALL at today's shared boundary,
  // not historical function bytes. It returns no fabricated recovery report:
  // the selected test checks the actual owner/task/run/intent rows instead.
  mock.module(target, () => ({
    ...original,
    runTaskExecutionBootRecovery: async () => {},
  }))
}

async function restoreRevokedOwnerReconcileRefusal(): Promise<void> {
  const target = sourcePath('modules/task-execution/infrastructure/ownedTaskExecution.ts')
  const original: typeof OwnedTaskExecution = await import(target)
  const source = readFileSync(target, 'utf8')
  const current = "  if (rows[0] !== undefined && rows[0].state === 'claimed') {"
  if (source.split(current).length !== 2) throw new Error('P0-4 mutation site drifted')
  // 01e4b1b7b: postgresqlTaskLifecycleTransaction.ts:182–199. Restore only
  // its original state predicate. The actual lifecycle transaction raises its
  // original error, and the unchanged recovery adapter catches it as false.
  // The selected periodic command then leaves the real task/run in running;
  // neither an error nor that result is supplied by this preload.
  const changed = source.replace(
    current,
    "  if (rows[0] !== undefined && rows[0].state !== 'released') {",
  )
  const mutated: typeof OwnedTaskExecution = await import(
    registerMemorySource(target, changed, 'ownerless-recovery')
  )
  mock.module(target, () => ({
    ...original,
    assertTaskOwnerlessTx: mutated.assertTaskOwnerlessTx,
    fenceTaskWrite: mutated.fenceTaskWrite,
  }))
}

const mutation = process.env['RFC359_P0_MUTATION']
switch (mutation) {
  case 'p0-12-protocol':
    await restoreOutputOnlyProtocol()
    break
  case 'p0-12-budget':
    await restoreBudgetOnlyGate()
    break
  case 'p0-5':
    await restoreStrictClarifyTransition()
    break
  case 'p0-6':
    await restoreDecodeBeforeWorkflowDelete()
    break
  case 'p0-7':
    await restoreUnboundDeferredDispatcher()
    break
  case 'p0-9-launchers':
    await restoreMissingLegacyMissionLaunchers()
    break
  case 'p0-9-terminal-observer':
    await restoreMissingLegacyTerminalForwarding()
    break
  case 'p0-11-barrier':
    await restoreMissingSkillBootCall('barrier')
    break
  case 'p0-11-reverify':
    await restoreMissingSkillBootCall('reverify')
    break
  case 'p0-10-unsettled-release':
    await restoreUnsettledDriverRelease()
    break
  case 'p0-3-boot-omitted':
    await restoreMissingTaskBootRecovery()
    break
  case 'p0-4-revoked-reconcile':
    await restoreRevokedOwnerReconcileRefusal()
    break
  default:
    throw new Error(`Unknown RFC359_P0_MUTATION: ${mutation ?? '(missing)'}`)
}
console.error(`[rfc359-p0-mutation] installed=${mutation}`)
