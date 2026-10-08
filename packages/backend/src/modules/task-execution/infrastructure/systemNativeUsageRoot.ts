import { eq } from 'drizzle-orm'
import { sha256Hex } from '@/util/hash'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { SystemNativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { nativeRootOrdinalKey } from './nativeUsageLeaseRoot'
import { withSystemNativeUsageOwner } from './systemObservationOwner'

/** Only the original System parser's accepted root/reset boundary may append this fact. */
export async function recordSystemNativeUsageRoot(
  db: ProviderNeutralDatabase,
  binding: SystemNativeUsageOwnerBinding,
  input: {
    readonly sessionId: string
    readonly previous?: string
    readonly resumeSessionId?: string
    readonly ownerNonce: string
    readonly observedAt: number
  },
): Promise<void> {
  const {
    nativeUsageRootHeads: heads,
    nativeUsageRootTransitions: transitions,
    nativeUsageRootSets: sets,
  } = nativeUsageEvidenceStorage('system')
  await withSystemNativeUsageOwner(db, binding, async (tx, facts) => {
    if (await tx.select().from(sets).where(eq(sets.invocationId, binding.invocationId)).get())
      throw new Error('Original System root population is already frozen')
    const head = await tx
      .select()
      .from(heads)
      .where(eq(heads.invocationId, binding.invocationId))
      .get()
    if (
      head &&
      (head.taskId !== binding.taskId ||
        head.nodeRunId !== binding.nodeRunId ||
        head.claimFence !== facts.fence ||
        head.protocol !== 'opencode')
    )
      throw new Error('Original System native root owner changed')
    if (
      (head === undefined) !== (input.previous === undefined) ||
      (head && head.lastRootSessionId !== input.previous)
    )
      throw new Error('Original System native root transition changed its actual outgoing root')
    const ordinal = head?.nextOrdinal ?? '0'
    const document = JSON.stringify({
      contract: 'native-usage-root-transition-v3',
      invocationId: binding.invocationId,
      taskId: binding.taskId,
      nodeRunId: binding.nodeRunId,
      claimFence: facts.fence,
      protocol: 'opencode',
      leaseNonceDigest: sha256Hex(input.ownerNonce),
      ordinal,
      rootSessionId: input.sessionId,
      mode: head ? 'reset' : input.resumeSessionId === input.sessionId ? 'resume' : 'fresh',
      outgoingRootSessionId: input.previous ?? null,
      observedAt: input.observedAt,
    })
    const digest = sha256Hex(
      JSON.stringify([
        head?.digest ?? sha256Hex(JSON.stringify(['native-root-source-v3', binding.invocationId])),
        document,
      ]),
    )
    if (head)
      await tx
        .update(heads)
        .set({
          nextOrdinal: String(BigInt(ordinal) + 1n),
          lastRootSessionId: input.sessionId,
          digest,
        })
        .where(eq(heads.invocationId, binding.invocationId))
    else
      await tx.insert(heads).values({
        invocationId: binding.invocationId,
        taskId: binding.taskId,
        nodeRunId: binding.nodeRunId,
        claimFence: facts.fence,
        protocol: 'opencode',
        nextOrdinal: '1',
        firstRootSessionId: input.sessionId,
        lastRootSessionId: input.sessionId,
        digest,
      })
    await tx.insert(transitions).values({
      invocationId: binding.invocationId,
      ordinalKey: nativeRootOrdinalKey(ordinal),
      rootSessionId: input.sessionId,
      document,
      digest,
    })
  })
}
