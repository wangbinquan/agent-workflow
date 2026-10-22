import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { RuntimeProfileUsageReader } from '@/modules/runtime-management/application/ports/runtimeProfileParticipants'
import type { RuntimeProfileTestInvalidationInTx } from '../../public/participants'
import { createRuntimeProfileTestInvalidationInTx } from '../../application/runtimeProfileTestInvalidation'
import { transitionRuntimeTests } from '../mcpRuntimeTestTransitions'

/** Both participants operate on the caller's transaction, without opening another transaction. */
export function createRuntimeProfileParticipants(): {
  readonly testInvalidation: RuntimeProfileTestInvalidationInTx<PersistenceTx>
  readonly usage: RuntimeProfileUsageReader<PersistenceTx>
} {
  const testInvalidation = createRuntimeProfileTestInvalidationInTx<PersistenceTx>({
    async invalidate(transaction, input) {
      for (const runtimeName of input.runtimeNames) {
        await transitionRuntimeTests(transaction, {
          runtimeName,
          reason: input.reason,
          now: input.now,
        })
      }
    },
  })
  const usage: RuntimeProfileUsageReader<PersistenceTx> = {
    async inspect(transaction, input) {
      const { agents } = tablesOf(transaction)
      const referencedAgents = await transaction
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.runtime, input.runtimeName))
      return referencedAgents.map((agent) => `agent '${agent.name}'`)
    },
  }
  return Object.freeze({
    testInvalidation: Object.freeze(testInvalidation),
    usage: Object.freeze(usage),
  })
}
