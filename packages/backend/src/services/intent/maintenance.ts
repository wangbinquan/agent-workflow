// RFC-234 §1.2/§11 — provider-neutral Intent recovery and scratch GC.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { IntentPersistence } from '@/modules/intent/public/operations'
import { createLogger, type Logger } from '@/util/log'
import { INTENT_SCRATCH_DIRNAME } from './turnEngine'

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
  persistence: IntentPersistence,
  appHome: string,
  retentionHours: number,
  log: Logger = createLogger('intent'),
): Promise<number> {
  const root = join(appHome, INTENT_SCRATCH_DIRNAME)
  if (!existsSync(root)) return 0
  const cutoff = Date.now() - retentionHours * 3600_000
  const candidates: Array<{ readonly name: string; readonly dir: string }> = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      if (statSync(dir).mtimeMs <= cutoff) candidates.push({ name, dir })
    } catch {
      // A concurrent cleanup already won.
    }
  }
  const running = await persistence.listRunningTurnIds(candidates.map(({ name }) => name))
  let removed = 0
  for (const candidate of candidates) {
    if (running.has(candidate.name)) continue
    try {
      rmSync(candidate.dir, { recursive: true, force: true })
      removed += 1
      log.info('intent-scratch-swept', { dir: candidate.name })
    } catch (error) {
      log.warn('intent-scratch-sweep-failed', {
        dir: candidate.name,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return removed
}
