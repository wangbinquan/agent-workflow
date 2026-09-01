// RFC-349 — provider-neutral recovery orchestrator for already-committed
// human-gate continuations. Persistence is selected once by bootstrap.

import type {
  HumanGateContinuationRecoveryQueries,
  PendingHumanGateContinuation,
} from '@/modules/collaboration/application/ports/humanGateContinuationRecovery'

export type { PendingHumanGateContinuation }

export type HumanGateContinuationRecoveryResult = Readonly<{
  attempted: readonly PendingHumanGateContinuation[]
  woken: readonly PendingHumanGateContinuation[]
  failed: readonly Readonly<
    PendingHumanGateContinuation & {
      error: string
    }
  >[]
}>

export function listPendingHumanGateContinuations(
  queries: HumanGateContinuationRecoveryQueries,
): Promise<readonly PendingHumanGateContinuation[]> {
  return queries.listPending()
}

export async function recoverPendingHumanGateContinuations(input: {
  queries: HumanGateContinuationRecoveryQueries
  wake: (continuation: PendingHumanGateContinuation) => Promise<void>
}): Promise<HumanGateContinuationRecoveryResult> {
  const pending = await input.queries.listPending()

  const woken: PendingHumanGateContinuation[] = []
  const failed: Array<PendingHumanGateContinuation & { error: string }> = []
  for (const continuation of pending) {
    try {
      await input.wake(continuation)
      woken.push(continuation)
    } catch (error) {
      failed.push({
        ...continuation,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { attempted: pending, woken, failed }
}
