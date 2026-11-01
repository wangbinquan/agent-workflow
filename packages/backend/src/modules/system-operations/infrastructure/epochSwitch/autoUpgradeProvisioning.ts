// RFC-398 design §1 / §3.4: adapt the module's journal identities to the database provisioning port.
import type { DatabaseProvisioning } from '@/platform/persistence/migration/databaseProvisioning'
import type { EpochTargetProvisioningPort } from '../../application/ports/epochSwitch'

export function createAutoUpgradeProvisioning(
  database: DatabaseProvisioning,
): EpochTargetProvisioningPort {
  const port: EpochTargetProvisioningPort = {
    prepare: (request) => database.prepare(request),
    retained: () => database.retained(),
    async nextTargetLocation(previous, next) {
      if (!next.payload.run || !next.payload.target.generationId)
        throw new Error('postgresql-next-generation-required')
      if (
        previous.payload.operationId !== next.payload.operationId ||
        next.payload.run!.runId === previous.payload.run?.runId
      )
        throw new Error('postgresql-next-run-identity-invalid')
      const receipt = await port.prepare({
        sessionOperationId: next.payload.operationId,
        runId: next.payload.run!.runId,
        generationId: next.payload.target.generationId,
      })
      if (next.payload.inputs.scratchProfileRef !== receipt.scratch.profileRef)
        throw new Error('postgresql-next-scratch-binding-mismatch')
      return { kind: 'postgresql-target', profileRef: receipt.target.profileRef }
    },
  }
  return port
}
