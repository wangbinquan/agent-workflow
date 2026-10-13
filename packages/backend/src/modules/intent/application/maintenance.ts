// RFC-234 §1.2/§11 — provider-neutral Intent recovery and scratch GC.

import type { IntentPersistence } from '@/modules/intent/application/ports/intentPersistence'
import type { IntentScratchStore } from './ports/intentScratchStore'
import { createLogger, type Logger } from '@/util/log'

export async function listIntentTurnIdsForBootRecovery(
  persistence: IntentPersistence,
): Promise<readonly string[]> {
  return await persistence.listTurnIdsForBootRecovery()
}

export async function recoverIntentTurnsOnBoot(
  persistence: IntentPersistence,
  log: Logger = createLogger('intent'),
  turnIds?: readonly string[],
): Promise<number> {
  const captured = turnIds ?? (await listIntentTurnIdsForBootRecovery(persistence))
  if (captured.length === 0) return 0
  const recovered = await persistence.recoverTurnsOnBoot({
    turnIds: captured,
    now: Date.now(),
    reason: 'intent-run-daemon-restart',
  })
  if (recovered > 0) log.warn('intent-orphan-turns-recovered', { recovered })
  return recovered
}

export async function sweepIntentScratch(
  persistence: Pick<IntentPersistence, 'listRunningTurnIds'>,
  scratch: IntentScratchStore,
  retentionHours: number,
  log: Logger = createLogger('intent'),
): Promise<number> {
  const staleTurnIds = scratch.staleTurnIds.bind(scratch),
    remove = scratch.remove.bind(scratch)
  const listRunning = persistence.listRunningTurnIds.bind(persistence)
  const cutoff = Date.now() - retentionHours * 3600_000
  const candidates = await staleTurnIds(cutoff)
  const running = await listRunning(candidates)
  let removed = 0
  for (const candidate of candidates) {
    if (running.has(candidate)) continue
    try {
      await remove(candidate)
      removed += 1
      log.info('intent-scratch-swept', { dir: candidate })
    } catch (error) {
      log.warn('intent-scratch-sweep-failed', {
        dir: candidate,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return removed
}
