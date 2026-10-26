import { epochDeploymentCapabilities } from '@/modules/system-operations/domain/epochSwitch/deploymentCapabilities'
import { epochArtifactPath } from '@/platform/persistence/migration/run/paths'
import { EpochSwitchError } from '../../domain/epochSwitch/model'
import {
  type EpochSwitchDependencies,
  type EpochSwitchApplicationWithWithdrawal,
  withEpochOperation,
  requireEpochJournal,
  materializeEpochArtifacts,
  runArtifact,
} from './session'
import {
  discoverEpochOperation,
  planEpochOperation,
  acknowledgeEpochPlan,
  withdrawEpochAcknowledgements,
} from './planner'
import { runEpochSwitch } from './runner'
import { rollbackEpochSwitch, discardEpochSwitch } from './rollback'
import { completeEpochSwitch, verifyEpochSwitch } from './completion'
import { restoreEpochBackup } from './restore'
import { epochSwitchStatus, epochSwitchSummary } from './status'

export function createEpochSwitchApplication(
  deps: EpochSwitchDependencies,
): EpochSwitchApplicationWithWithdrawal {
  return {
    async plan(input) {
      const operationId = input.operationId ?? (await discoverEpochOperation(deps, input))
      return withEpochOperation(deps, operationId, (s) => planEpochOperation(s, input))
    },
    acknowledge: (input) =>
      withEpochOperation(deps, input.operationId, (s) => acknowledgeEpochPlan(s, input)),
    withdrawAcknowledgements: (input) =>
      withEpochOperation(deps, input.operationId, (s) => withdrawEpochAcknowledgements(s, input)),
    run: (input) => withEpochOperation(deps, input.operationId, (s) => runEpochSwitch(s, input)),
    async status(input) {
      if (!input.operationId) return (await deps.journal.list()).map(epochSwitchSummary)
      return epochSwitchStatus(deps, await requireEpochJournal(deps, input.operationId))
    },
    async trace(input) {
      const lock = await deps.journal.lockOperation(input.operationId)
      try {
        const journal = await requireEpochJournal(deps, input.operationId)
        await materializeEpochArtifacts(deps, journal)
        const p = journal.payload
        if (!p.target.generationId || !p.target.location || !p.run)
          throw new EpochSwitchError('v3-target-missing')
        const target = await deps.target.open({
          generationId: p.target.generationId,
          provider: p.target.provider,
          location: p.target.location,
          faults: deps.faults,
        })
        try {
          if ('taskId' in input)
            return {
              operationId: input.operationId,
              taskId: input.taskId,
              restrictions: await target
                .trace()
                .restrictions({ taskId: input.taskId, runId: p.run.runId }),
            }
          if (!deps.trace) throw new EpochSwitchError('v3-trace-adapter-required')
          return await deps.trace(target.trace(), { ...input, runId: input.runId ?? p.run.runId })
        } finally {
          await target.close()
        }
      } finally {
        await lock.release()
      }
    },
    verify: (input) => withEpochOperation(deps, input.operationId, verifyEpochSwitch),
    rollback: (input) => withEpochOperation(deps, input.operationId, rollbackEpochSwitch),
    complete: (input) => withEpochOperation(deps, input.operationId, completeEpochSwitch),
    discard: (input) =>
      withEpochOperation(deps, input.operationId, (s) => discardEpochSwitch(s, input.confirm)),
    async receipt(input) {
      const journal = await requireEpochJournal(deps, input.operationId)
      const names = {
        plan: `plans/${journal.payload.plan?.digest}.json`,
        run: runArtifact(journal, 'receipt-export.json'),
        activation: 'activation-receipt.json',
        switch:
          journal.payload.phase === 'completed' ? 'completion-receipt.json' : 'switch-receipt.json',
        rollback: 'rollback-receipt.json',
      }
      const name = names[input.kind]
      const bytes = await deps.journal.readArtifact(input.operationId, name)
      if (!bytes) throw new EpochSwitchError('v3-receipt-not-found')
      return {
        path: epochDeploymentCapabilities(journal.payload.deployment).localPaths
          ? epochArtifactPath(deps.journal.operationRoot(input.operationId), name)
          : null,
        json: Buffer.from(bytes).toString('utf8'),
      }
    },
    restoreBackup: (input) => restoreEpochBackup(deps, input),
  }
}
