// RFC-359 W12 — shared fixed-point traversal and receipt projection. Each
// target retains its own transaction and existing post-commit stop sequence.
import type { TaskStopCause } from '../domain/sourceTermination'
import type {
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationReceipt,
} from './applySourceTerminationEffect'

export async function executeSourceTermination<
  Target extends {
    readonly receipt: TaskSourceTerminationReceipt
    readonly ownerWithoutLocalToken: boolean
  },
>(
  input: TaskSourceTerminationEffectInput,
  listTargets: () => Promise<readonly { readonly id: string }[]>,
  applyTarget: (taskId: string) => Promise<Target | null>,
  completeTarget: (
    target: Target,
  ) => Promise<
    { readonly kind: 'released' } | { readonly kind: 'unreaped'; readonly code: string } | null
  >,
  finalizeWithoutDriver?: (taskId: string) => Promise<void>,
): Promise<readonly TaskSourceTerminationReceipt[]> {
  const receipts = new Map<string, TaskSourceTerminationReceipt>()
  const processed = new Set<string>()
  for (;;) {
    const pending = (await listTargets()).filter((row) => !processed.has(row.id))
    if (pending.length === 0) break
    for (const row of pending) {
      processed.add(row.id)
      const applied = await applyTarget(row.id)
      if (applied === null) continue
      let receipt = applied.receipt
      const stopped = await completeTarget(applied)
      if (stopped !== null) {
        receipt =
          stopped.kind === 'released'
            ? { ...receipt, releaseOutcome: 'released' }
            : { ...receipt, releaseOutcome: 'unreaped', errorCode: stopped.code }
      } else if (applied.ownerWithoutLocalToken) {
        receipt = {
          ...receipt,
          releaseOutcome: 'unreaped',
          errorCode: 'task-execution-recovery-required',
        }
      } else if (input.kind !== 'clear-closed') {
        await finalizeWithoutDriver?.(row.id)
        receipt = { ...receipt, releaseOutcome: 'no-active-owner' }
      }
      receipts.set(row.id, receipt)
    }
  }
  return [...receipts.values()]
}

function fenceFor(input: TaskSourceTerminationEffectInput): 'closed' | 'merged' | null {
  if (input.kind === 'fence-closed') return 'closed'
  if (input.kind === 'fence-merged') return 'merged'
  return null
}

export function terminalCause(
  input: TaskSourceTerminationEffectInput,
  parentTaskId: string | null,
): TaskStopCause | null {
  const terminal = fenceFor(input)
  if (terminal === null) return null
  return parentTaskId === null
    ? {
        kind: 'webhook-terminal',
        terminal,
        deliveryId: input.deliveryId,
        streamRevision: input.streamRevision,
      }
    : {
        kind: 'parent-cascade',
        parentTaskId,
        rootCause: {
          terminal,
          deliveryId: input.deliveryId,
          streamRevision: input.streamRevision,
        },
      }
}
