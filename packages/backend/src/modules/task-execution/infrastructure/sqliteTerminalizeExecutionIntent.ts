// SQLite provider-private transaction participant.
import type { DbTxSync } from '@/db/txSync'
import {
  driveSyncProgram,
  executeTransactionStepSync,
} from '@/platform/persistence/transactionProgram'
import { taskExecutionIntentTerminalSequence } from './taskExecutionIntentTerminalSequence'

/**
 * Close active intents for one task and return any unconsumed replay
 * authorization to requires-actor in the same control/recovery transaction.
 * Successor-daemon recovery can fence this to the interrupted claimed epoch so
 * a gate decision committed before the crash keeps its pending successor.
 */
export function terminalizeTaskExecutionIntentsTx(input: {
  tx: DbTxSync
  taskId: string
  state: 'canceled' | 'failed'
  failureCode: string
  now: number
  claimedOwnerEpoch?: number
}): void {
  driveSyncProgram(
    taskExecutionIntentTerminalSequence(input.tx, input, 'unchecked'),
    executeTransactionStepSync,
  )
}
