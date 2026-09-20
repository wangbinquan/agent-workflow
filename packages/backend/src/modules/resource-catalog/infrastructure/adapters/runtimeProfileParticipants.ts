import { eq } from 'drizzle-orm'
import { agents } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { RuntimeProfileUsageParticipantInTx } from '@/modules/runtime-management/application/ports/runtimeProfileParticipants'
import type { RuntimeProfileTestInvalidationInTx } from '../../public/participants'
import { transitionRuntimeTests } from '../mcpRuntimeTestTransitions'

/** Both participants operate on the caller's transaction, without opening another transaction. */
export function createRuntimeProfileParticipants(): {
  readonly testInvalidation: RuntimeProfileTestInvalidationInTx<DatabaseTransaction>
  readonly usage: RuntimeProfileUsageParticipantInTx<DatabaseTransaction>
} {
  const testInvalidation: RuntimeProfileTestInvalidationInTx<DatabaseTransaction> = {
    async invalidate(transaction, input) {
      for (const runtimeName of input.runtimeNames) {
        await transitionRuntimeTests(transaction, {
          runtimeName,
          reason: input.reason,
          now: input.now,
        })
      }
    },
  }
  const usage: RuntimeProfileUsageParticipantInTx<DatabaseTransaction> = {
    async inspect(transaction, input) {
      const referencedAgents = await transaction
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.runtime, input.runtimeName))
        .all()
      return referencedAgents.map((agent) => `agent '${agent.name}'`)
    },
  }
  return Object.freeze({
    testInvalidation: Object.freeze(testInvalidation),
    usage: Object.freeze(usage),
  })
}
