import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import type { DecodedSourceValue } from '@/platform/persistence/migration/sourceTypes'
import type { TaskSettlement } from '@/platform/persistence/migration/conversion/types'
import { taskStopProjection, type TaskStopProjection } from '../../../domain/sourceTermination'

/**
 * RFC-626 §3.2.4: the stop reason a settled task is written with, from the single source of
 * task stop causes. A task the upgrade ends is `upgrade`; a child it takes along is
 * `parent-cascade`, exactly as the cancel transaction stamps a cascaded child.
 */
export function settlementStop(settlement: TaskSettlement): TaskStopProjection {
  if (settlement.cause !== 'parent-cascade') return taskStopProjection({ kind: 'upgrade' })
  if (settlement.parentTaskId === null)
    throw new ConversionContractError('v2-settlement-cascade', settlement.taskId)
  return taskStopProjection({ kind: 'parent-cascade', parentTaskId: settlement.parentTaskId })
}

/** A revision counter one step on, keeping the integer representation the codec decodes. */
export function nextRevision(value: DecodedSourceValue | undefined): DecodedSourceValue | null {
  if (typeof value === 'bigint') return value + 1n
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  return Number.isSafeInteger(value + 1) ? value + 1 : BigInt(value) + 1n
}
