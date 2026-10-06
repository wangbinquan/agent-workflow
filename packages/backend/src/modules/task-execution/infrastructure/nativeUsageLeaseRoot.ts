import { eq } from 'drizzle-orm'
import { nativeUsageRootHeads, nativeUsageRootTransitions, nativeUsageRootSets } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import type { RuntimeSessionLeaseToken } from '../application/ports/runtimeSessionLeaseOperations'
import type { TaskExecutionTransaction } from './ownedTaskExecution'

/** A variable-length decimal order key. It does not impose an ordinal/population ceiling. */
export function nativeRootOrdinalKey(ordinal: string): string {
  if (!/^(0|[1-9]\d*)$/.test(ordinal)) throw new Error('Original root ordinal is not exact')
  return 'z'.repeat(ordinal.length) + ':' + ordinal
}

/** Called inside the original successful lease transaction, before its claim/rotation ACK. */
export async function recordNativeUsageLeaseRoot(
  tx: TaskExecutionTransaction,
  input: {
    readonly taskId: string
    readonly token: RuntimeSessionLeaseToken
    readonly mode: 'fresh' | 'resume' | 'reset'
    readonly outgoingRootSessionId: string | null
    readonly observedAt: number
  },
): Promise<void> {
  const invocationId = input.token.nativeInvocationId
  if (!invocationId) return
  const frozen = (
    await tx
      .select({ invocationId: nativeUsageRootSets.invocationId })
      .from(nativeUsageRootSets)
      .where(eq(nativeUsageRootSets.invocationId, invocationId))
      .limit(1)
  )[0]
  if (frozen) throw new Error('Original native root population is already frozen')
  const context = currentTaskExecutionContext(input.taskId)
  const claimFence = context
    ? JSON.stringify([
        context.intentId,
        context.token.taskId,
        context.token.ownerId,
        context.token.daemonGeneration,
        context.token.epoch,
      ])
    : null
  const head = (
    await tx
      .select()
      .from(nativeUsageRootHeads)
      .where(eq(nativeUsageRootHeads.invocationId, invocationId))
      .limit(1)
  )[0]
  if (
    head &&
    (head.taskId !== input.taskId ||
      head.nodeRunId !== input.token.nodeRunId ||
      head.claimFence !== claimFence ||
      head.protocol !== input.token.protocol)
  )
    throw new Error('Original native root source changed its execution owner')
  if (
    (head === undefined) !== (input.mode !== 'reset') ||
    (head && head.lastRootSessionId !== input.outgoingRootSessionId)
  )
    throw new Error('Original native root transition changed its actual outgoing lease')
  const ordinal = head?.nextOrdinal ?? '0'
  const document = JSON.stringify({
    contract: 'native-usage-root-transition-v3',
    invocationId,
    taskId: input.taskId,
    nodeRunId: input.token.nodeRunId,
    claimFence,
    protocol: input.token.protocol,
    leaseNonceDigest: input.token.leaseNonceDigest,
    ordinal,
    rootSessionId: input.token.sessionId,
    mode: input.mode,
    outgoingRootSessionId: input.outgoingRootSessionId,
    observedAt: input.observedAt,
  })
  const previous =
    head?.digest ?? sha256Hex(JSON.stringify(['native-root-source-v3', invocationId]))
  const digest = sha256Hex(JSON.stringify([previous, document]))
  if (!head)
    await tx.insert(nativeUsageRootHeads).values({
      invocationId,
      taskId: input.taskId,
      nodeRunId: input.token.nodeRunId,
      claimFence,
      protocol: input.token.protocol,
      nextOrdinal: '1',
      firstRootSessionId: input.token.sessionId,
      lastRootSessionId: input.token.sessionId,
      digest,
    })
  else
    await tx
      .update(nativeUsageRootHeads)
      .set({
        nextOrdinal: String(BigInt(ordinal) + 1n),
        lastRootSessionId: input.token.sessionId,
        digest,
      })
      .where(eq(nativeUsageRootHeads.invocationId, invocationId))
  await tx.insert(nativeUsageRootTransitions).values({
    invocationId,
    ordinalKey: nativeRootOrdinalKey(ordinal),
    rootSessionId: input.token.sessionId,
    document,
    digest,
  })
}
