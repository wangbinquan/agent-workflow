// RFC-170 §6a / T-BOOT — boot-time crash-recovery driver.
//
// Orchestrates recovery of every in-flight skill_operations row on daemon start,
// BEFORE HTTP/runtime open (§invariant④). It is a thin dispatcher over three
// already-tested pieces:
//   - listActiveOps        (skillOperations) — the crashed ops, locks still held
//   - recoveryDirection    (skillOpRecovery) — the §6a verdict per (kind, phase)
//   - skillFsPublish / per-kind handlers      — the concrete FS recovery
//
// Per-kind FS recovery lives WITH each op (registered here as it lands), so the
// forward path and its recovery can't drift. The driver owns the generic parts:
//   - dispatch by direction;
//   - quarantine (impossible state) → mark the managed skill version_state=
//     'quarantined' + retire the op — fail-closed, never guess;
//   - the DB terminal (abandonOperation on rollback, finishOperation on
//     rollforward) that releases the op's locks;
//   - gcOrphanLocks AFTER every active op is recovered (§6a ordering: locks are
//     the exclusion primitive during recovery, cleaned only once nothing needs
//     them).
//
// Handlers do FS work OUTSIDE the tx (renames/copies aren't transactional) and
// may contribute DB writes to the terminal tx via `recoverDb`. Registering no
// handler for a kind is legal — the generic terminal still releases the lock;
// the boot log flags it so a missing handler is visible, not silent.

import { eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { dbTxSync } from '@/db/txSync'
import { skills } from '@/db/schema'
import { createLogger } from '@/util/log'
import {
  abandonOperation,
  finishOperation,
  gcOrphanLocks,
  listActiveOps,
  type SkillOperationRow,
} from '@/services/skillOperations'
import { recoveryDirection } from '@/services/skillOpRecovery'
import type { SkillOpKind, SkillOpPhase } from '@/services/skillOperations'

const log = createLogger('skill-op-recovery')

/** FS-side recovery for one kind. `recoverDb` (optional) contributes writes to
 *  the driver's terminal tx (e.g. version-write rollforward re-INSERTing v1). */
export interface OpRecoveryHandler {
  /** Undo the half-done work (phase < db-committed). FS-side, non-transactional. */
  rollbackFs?: (fsOpts: SkillOpFsOptions, op: SkillOperationRow) => void
  /** Complete the publish (phase ≥ db-committed). FS-side, non-transactional. */
  rollForwardFs?: (fsOpts: SkillOpFsOptions, op: SkillOperationRow) => void
  /** Optional DB writes contributed to the terminal tx (both directions). */
  recoverDb?: (tx: DbTxSync, op: SkillOperationRow, dir: 'rollback' | 'rollforward') => void
}

export type OpRecoveryRegistry = Partial<Record<SkillOpKind, OpRecoveryHandler>>
export interface SkillOpFsOptions {
  appHome: string
}

export interface RecoveryReport {
  total: number
  rolledBack: number
  rolledForward: number
  quarantined: number
  noHandler: number
  orphanLocksCleared: number
}

/**
 * Recover all active skill operations. Returns a report (also logged). Idempotent:
 * a second run over the already-terminal state is a no-op (no active ops left).
 */
export function recoverSkillOperations(
  db: DbClient,
  fsOpts: SkillOpFsOptions,
  registry: OpRecoveryRegistry,
): RecoveryReport {
  const active = listActiveOps(db)
  const report: RecoveryReport = {
    total: active.length,
    rolledBack: 0,
    rolledForward: 0,
    quarantined: 0,
    noHandler: 0,
    orphanLocksCleared: 0,
  }

  for (const op of active) {
    const dir = recoveryDirection(op.kind, op.phase as SkillOpPhase)
    const handler = registry[op.kind]

    if (dir === 'noop') {
      // An active row at a terminal phase is itself an inconsistency — retire it.
      dbTxSync(db, (tx) => abandonOperation(tx, op.opId))
      continue
    }

    if (dir === 'quarantine') {
      report.quarantined++
      log.warn('quarantine impossible-state op', {
        opId: op.opId,
        skillId: op.skillId,
        kind: op.kind,
        phase: op.phase,
      })
      quarantineSkill(db, op)
      continue
    }

    const fsFn = dir === 'rollback' ? handler?.rollbackFs : handler?.rollForwardFs
    // A handler "covers" this op if it has either the direction's FS recovery OR a
    // recoverDb (a pure-DB recovery — e.g. reserve rollforward has no FS work, only
    // the 'ready' fixup). Only a genuinely absent handler is a loud gap.
    if (fsFn === undefined && handler?.recoverDb === undefined) {
      report.noHandler++
      log.warn('no recovery handler; releasing lock only', {
        opId: op.opId,
        kind: op.kind,
        phase: op.phase,
        dir,
      })
    } else if (fsFn !== undefined) {
      fsFn(fsOpts, op)
    }

    dbTxSync(db, (tx) => {
      handler?.recoverDb?.(tx, op, dir)
      if (dir === 'rollback') abandonOperation(tx, op.opId)
      else finishOperation(tx, op.opId)
    })
    if (dir === 'rollback') report.rolledBack++
    else report.rolledForward++
  }

  // Locks were held through every active-op recovery; clean orphans last.
  report.orphanLocksCleared = dbTxSync(db, (tx) => gcOrphanLocks(tx))
  if (report.total > 0 || report.orphanLocksCleared > 0) {
    log.info('skill operations recovered', { ...report })
  }
  return report
}

/** Mark a managed skill quarantined (version_state) + retire the impossible op.
 *  External skills have no snapshot authority — retire the op only. */
function quarantineSkill(db: DbClient, op: SkillOperationRow): void {
  dbTxSync(db, (tx) => {
    tx.update(skills).set({ versionState: 'quarantined' }).where(eq(skills.id, op.skillId)).run()
    abandonOperation(tx, op.opId)
  })
}
