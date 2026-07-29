// RFC-234 §1.2/§11 (T5) — intent maintenance: boot recovery for orphaned
// in-flight turns + the deterministic scratch GC owner (design-gate P1-7).

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { eq, isNotNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { intentSessions, intentTurns } from '@/db/schema'
import { createLogger, type Logger } from '@/util/log'
import { INTENT_SCRATCH_DIRNAME } from './turnEngine'

/** Daemon boot: any session still holding an in-flight turn belongs to a dead
 *  process — settle the turn as a daemon-restart error and free the slot. The
 *  scratch dir (if any) is left for the GC sweep below. */
export function recoverIntentTurnsOnBoot(
  db: DbClient,
  log: Logger = createLogger('intent'),
): number {
  return dbTxSync(db, (tx) => {
    const orphaned = tx
      .select()
      .from(intentSessions)
      .where(isNotNull(intentSessions.inFlightTurnId))
      .all()
    for (const session of orphaned) {
      const turnId = session.inFlightTurnId as string
      const turn = tx
        .select({ captureState: intentTurns.captureState })
        .from(intentTurns)
        .where(eq(intentTurns.id, turnId))
        .get()
      tx.update(intentTurns)
        .set({
          kind: 'error',
          contentJson: JSON.stringify({ code: 'intent-run-daemon-restart' }),
          scratchRetained: true,
          // A process restart cannot prove that the stream and post-run store
          // flush completed. Only an actually-live capture is downgraded:
          // already-settled complete/truncated/incomplete evidence is immutable.
          ...(turn?.captureState === 'live'
            ? {
                captureState: 'incomplete' as const,
                captureIncompleteReason: 'post-exit-flush-timeout' as const,
              }
            : {}),
        })
        .where(eq(intentTurns.id, turnId))
        .run()
      tx.update(intentSessions)
        .set({ inFlightTurnId: null, updatedAt: Date.now() })
        .where(eq(intentSessions.id, session.id))
        .run()
      log.warn('intent-orphan-turn-recovered', { sessionId: session.id, turnId })
    }
    return orphaned.length
  })
}

/** Hourly + boot sweep of `<appHome>/intent-scratch/`. A dir is removed when
 *  its turn is terminal (or unknown) AND older than the retention window;
 *  in-flight turns' dirs are never touched. */
export function sweepIntentScratch(
  db: DbClient,
  appHome: string,
  retentionHours: number,
  log: Logger = createLogger('intent'),
): number {
  const root = join(appHome, INTENT_SCRATCH_DIRNAME)
  if (!existsSync(root)) return 0
  const cutoff = Date.now() - retentionHours * 3600_000
  let removed = 0
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    let mtime: number
    try {
      mtime = statSync(dir).mtimeMs
    } catch {
      continue
    }
    if (mtime > cutoff) continue
    const kind = db
      .select({ kind: intentTurns.kind })
      .from(intentTurns)
      .where(eq(intentTurns.id, name))
      .get()?.kind
    if (kind === 'running') continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removed += 1
      log.info('intent-scratch-swept', { dir: name, kind: kind ?? 'unknown' })
    } catch (err) {
      log.warn('intent-scratch-sweep-failed', {
        dir: name,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return removed
}
