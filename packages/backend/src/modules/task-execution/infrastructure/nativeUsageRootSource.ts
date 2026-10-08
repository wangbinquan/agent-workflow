import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { and, asc, eq, gt } from 'drizzle-orm'

import { sha256Hex } from '@/util/hash'
import type { NativeUsageExecutionOwnerBinding as NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import type { NativeUsageOwnerFacts } from './nativeUsageOwnerTransaction'
import type { TaskExecutionTransaction } from './ownedTaskExecution'
import { nativeRootOrdinalKey } from './nativeUsageLeaseRoot'

export async function originalNativeRootHead(
  tx: TaskExecutionTransaction,
  binding: Pick<NativeUsageOwnerBinding, 'invocationId' | 'taskId' | 'nodeRunId' | 'sourceKind'>,
  facts: Pick<NativeUsageOwnerFacts, 'fence'>,
) {
  const { nativeUsageRootHeads } = nativeUsageEvidenceStorage(binding.sourceKind)

  const head = (
    await tx
      .select()
      .from(nativeUsageRootHeads)
      .where(eq(nativeUsageRootHeads.invocationId, binding.invocationId))
      .limit(1)
  )[0]
  if (
    head &&
    (head.taskId !== binding.taskId ||
      head.nodeRunId !== binding.nodeRunId ||
      head.claimFence !== facts.fence ||
      head.protocol !== 'opencode')
  )
    throw new Error('Native roots do not retain the actual Task invocation claim')
  return head
}

/** Every original successful transition, not just roots whose final scan succeeded. */
export async function verifyNativeRootSource(
  tx: TaskExecutionTransaction,
  binding: Pick<NativeUsageOwnerBinding, 'invocationId' | 'taskId' | 'nodeRunId' | 'sourceKind'>,
  facts: Pick<NativeUsageOwnerFacts, 'fence'>,
) {
  const { nativeUsageRootTransitions } = nativeUsageEvidenceStorage(binding.sourceKind)

  const head = await originalNativeRootHead(tx, binding, facts)
  let after: string | undefined,
    count = 0n
  let digest = sha256Hex(JSON.stringify(['native-root-source-v3', binding.invocationId]))
  let lastRoot: string | null = null,
    firstRoot: string | null = null,
    initialMode: 'fresh' | 'resume' | null = null
  for (;;) {
    const rows = await tx
      .select()
      .from(nativeUsageRootTransitions)
      .where(
        and(
          eq(nativeUsageRootTransitions.invocationId, binding.invocationId),
          after === undefined ? undefined : gt(nativeUsageRootTransitions.ordinalKey, after),
        ),
      )
      .orderBy(asc(nativeUsageRootTransitions.ordinalKey))
      .limit(40)
    if (rows.length === 0) break
    for (const row of rows) {
      const value = JSON.parse(row.document) as {
        contract: string
        invocationId: string
        taskId: string
        nodeRunId: string
        claimFence: string | null
        protocol: string
        leaseNonceDigest: string
        ordinal: string
        rootSessionId: string
        outgoingRootSessionId: string | null
        mode: 'fresh' | 'resume' | 'reset'
        observedAt: number
      }
      digest = sha256Hex(JSON.stringify([digest, row.document]))
      if (
        !head ||
        value.contract !== 'native-usage-root-transition-v3' ||
        value.invocationId !== binding.invocationId ||
        value.taskId !== binding.taskId ||
        value.nodeRunId !== binding.nodeRunId ||
        value.claimFence !== facts.fence ||
        value.protocol !== 'opencode' ||
        !value.leaseNonceDigest ||
        value.ordinal !== String(count) ||
        row.ordinalKey !== nativeRootOrdinalKey(String(count)) ||
        value.rootSessionId !== row.rootSessionId ||
        value.outgoingRootSessionId !== lastRoot ||
        (count === 0n ? !['fresh', 'resume'].includes(value.mode) : value.mode !== 'reset') ||
        !Number.isSafeInteger(value.observedAt) ||
        value.observedAt < 0 ||
        row.digest !== digest
      )
        throw new Error('Native root source omitted or changed an original lease transition')
      if (count === 0n) {
        firstRoot = value.rootSessionId
        initialMode = value.mode as 'fresh' | 'resume'
      }
      lastRoot = value.rootSessionId
      count++
    }
    const next = rows.at(-1)!.ordinalKey
    if (next === after) throw new Error('Native root transitions did not reach original EOF')
    after = next
  }
  if (
    head &&
    (head.nextOrdinal !== String(count) ||
      head.digest !== digest ||
      head.firstRootSessionId !== firstRoot ||
      head.lastRootSessionId !== lastRoot)
  )
    throw new Error('Native root source differs from its actual original watermark')
  return { nextOrdinal: String(count), digest, firstRoot, lastRoot, initialMode }
}

/** DISTINCT is over the retained original identities. Forty is only the transport packet size. */
export async function originalNativeRootPage(
  tx: TaskExecutionTransaction,
  invocationId: string,
  after: string | null,
  sourceKind: 'task' | 'system' = 'task',
): Promise<readonly string[]> {
  const { nativeUsageRootTransitions } = nativeUsageEvidenceStorage(sourceKind)

  const rows = await tx
    .selectDistinct({ root: nativeUsageRootTransitions.rootSessionId })
    .from(nativeUsageRootTransitions)
    .where(
      and(
        eq(nativeUsageRootTransitions.invocationId, invocationId),
        after === null ? undefined : gt(nativeUsageRootTransitions.rootSessionId, after),
      ),
    )
    .orderBy(asc(nativeUsageRootTransitions.rootSessionId))
    .limit(40)
  return rows.map((row) => row.root)
}
