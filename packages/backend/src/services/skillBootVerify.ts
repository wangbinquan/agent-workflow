// RFC-170 §invariant④ / §10 (T-BOOT) — managed-skill snapshot integrity
// reverification + the SINGLE availability predicate.
//
// A managed skill's version snapshot (versions/v<contentVersion>/files) is the
// sole content authority (§6a/§13). But a durable `version_state='snapshot-
// authoritative'` only records that the FIRST adoption was trusted — it does NOT
// prove the snapshot is still intact THIS boot (G6-4: a snapshot could be
// corrupted offline; a permanently-authoritative flag would keep signing tokens
// over garbage and let a save mint the corruption as a new authoritative version).
//
// So: at boot, AFTER opening HTTP, a background pass re-hashes every managed
// snapshot against its recorded `content_hash`. Passing skills enter the in-memory
// `bootVerifiedSet` (boot-epoch scoped, NOT persisted, managed only); failing ones
// are CAS'd to `version_state='quarantined'` (fail-closed). Quarantined rows stay
// in the boot rescan, so a later-restored snapshot (backup/re-sync) that matches
// the recorded hash again exits quarantine on the next boot. Every gate
// (detail/list/runtime/token-writer/scheduler) shares `isSkillAvailableThisBoot`.
//
// The gate is INACTIVE until the reverify runs, so unit tests and the pre-HTTP
// window behave exactly as before (no skill hidden). Any freshly WRITTEN snapshot
// (commitSkillVersion) is marked verified immediately — a just-written tree is,
// by construction, the tree we hashed.

import { and, eq, inArray } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { skills, skillVersions } from '@/db/schema'
import { hashDir } from '@/services/skillHash'
import { createLogger } from '@/util/log'

const log = createLogger('skill-boot-verify')

/** Managed skillIds whose CURRENT snapshot passed integrity re-hash THIS boot. */
const bootVerifiedSet = new Set<string>()
/** The gate only restricts once the boot reverify has run (production boot). */
let bootReverifyActivated = false

/** A just-written / freshly-verified managed snapshot is available immediately. */
export function markSkillBootVerified(skillId: string): void {
  bootVerifiedSet.add(skillId)
}
export function isSkillBootVerified(skillId: string): boolean {
  return bootVerifiedSet.has(skillId)
}
export function isBootReverifyActive(): boolean {
  return bootReverifyActivated
}
/** Test-only: reset the in-memory boot-epoch state between tests. */
export function resetSkillBootVerifyForTest(): void {
  bootVerifiedSet.clear()
  bootReverifyActivated = false
}
/** Test-only: turn the gate ON to exercise availability filtering. */
export function activateBootReverifyForTest(): void {
  bootReverifyActivated = true
}

/** The minimal row shape the availability predicate needs. */
export interface SkillAvailabilityRow {
  id: string
  reservationState?: string | null
  versionState?: string | null
}

/**
 * RFC-170 §invariant④ (G8-2) — the ONE availability predicate shared by every
 * skill entry point. Returns true (no gating) until the boot reverify activates
 * it. Once active (RFC-178: skills are managed-only): reservation 'ready' +
 * version_state 'snapshot-authoritative' + this boot's `bootVerifiedSet` (content
 * re-hash passed) — a durable authoritative flag alone is NOT enough (G6-4).
 */
export function isSkillAvailableThisBoot(skill: SkillAvailabilityRow): boolean {
  if (!bootReverifyActivated) return true
  return (
    (skill.reservationState ?? 'ready') === 'ready' &&
    skill.versionState === 'snapshot-authoritative' &&
    bootVerifiedSet.has(skill.id)
  )
}

/**
 * RFC-170 T9 (§invariant④) — the RUNTIME injection variant of the predicate,
 * keyed only on (id, sourceKind) so the leaf resolver / stageSkills can call it
 * without the full row. A managed skill must be boot-verified THIS boot to be
 * staged into a spawn (else fail-closed — never inject unverified/quarantined
 * content). A `project` (repo-local self-discovered) skill is not a platform
 * snapshot, so it is not gated. Inactive (returns true) until the boot reverify
 * runs.
 */
export function isSkillInjectableThisBoot(skill: {
  id: string
  sourceKind: 'managed' | 'project'
}): boolean {
  if (!bootReverifyActivated) return true
  if (skill.sourceKind === 'managed') return bootVerifiedSet.has(skill.id)
  return true
}

interface ReverifySkill {
  id: string
  name: string
  contentVersion: number
}

/**
 * Re-hash a managed skill's CURRENT snapshot against its recorded content_hash.
 * `hashDir` skips symlinks and hashes file bytes, so a match proves the tree is
 * byte-identical to commit time (catches both content tampering and a file
 * replaced by an escaping symlink → its bytes vanish → mismatch). Passing marks
 * the skill boot-verified; failing CAS-quarantines it (fail-closed).
 */
export function verifyManagedSnapshot(
  db: DbClient,
  opts: { appHome: string },
  skill: ReverifySkill,
): 'verified' | 'quarantined' {
  const quarantine = (reason: string): 'quarantined' => {
    dbTxSync(db, (tx) =>
      tx.update(skills).set({ versionState: 'quarantined' }).where(eq(skills.id, skill.id)).run(),
    )
    bootVerifiedSet.delete(skill.id)
    log.warn('managed skill snapshot quarantined this boot', {
      skillId: skill.id,
      name: skill.name,
      reason,
    })
    return 'quarantined'
  }
  const ver = db
    .select({ filesPath: skillVersions.filesPath, contentHash: skillVersions.contentHash })
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillName, skill.name),
        eq(skillVersions.versionIndex, skill.contentVersion),
      ),
    )
    .limit(1)
    .all() as Array<{ filesPath: string; contentHash: string | null }>
  const v = ver[0]
  if (v === undefined || v.contentHash === null) return quarantine('no current version row / hash')
  const dir = join(opts.appHome, v.filesPath)
  if (!existsSync(join(dir, 'SKILL.md'))) return quarantine('snapshot SKILL.md missing')
  if (hashDir(dir) !== v.contentHash) return quarantine('snapshot hash mismatch (tampered/corrupt)')
  bootVerifiedSet.add(skill.id)
  return 'verified'
}

/**
 * RFC-170 §invariant④ — the post-HTTP background reverify. ACTIVATES the gate,
 * then re-verifies every managed snapshot (`snapshot-authoritative` recheck +
 * `snapshot-unverified` first-adoption deep verify + `quarantined` recovery
 * probe). Passing skills join `bootVerifiedSet`; a passing non-authoritative
 * state is promoted to `snapshot-authoritative`. Rescanning quarantined rows
 * is what makes quarantine RECOVERABLE: a skill whose snapshot was
 * corrupted/lost and later restored (backup, re-sync) passes the same
 * content_hash check that granted trust originally and comes back on the next
 * boot — without this, quarantine was a one-way door with no UI surface and
 * DB surgery as the only exit. A still-corrupt snapshot re-fails the hash and
 * simply stays quarantined. No global barrier — a large legit tree is just
 * "available later", never quarantined for size.
 */
export function runBootSnapshotReverify(
  db: DbClient,
  opts: { appHome: string },
): { verified: number; quarantined: number } {
  bootReverifyActivated = true
  const rows = db
    .select({
      id: skills.id,
      name: skills.name,
      contentVersion: skills.contentVersion,
      versionState: skills.versionState,
    })
    .from(skills)
    .where(
      and(
        eq(skills.sourceKind, 'managed'),
        inArray(skills.versionState, [
          'snapshot-authoritative',
          'snapshot-unverified',
          'quarantined',
        ]),
      ),
    )
    .all() as Array<ReverifySkill & { versionState: string }>
  let verified = 0
  let quarantined = 0
  for (const r of rows) {
    if (verifyManagedSnapshot(db, opts, r) === 'verified') {
      verified++
      if (r.versionState !== 'snapshot-authoritative') {
        dbTxSync(db, (tx) =>
          tx
            .update(skills)
            .set({ versionState: 'snapshot-authoritative' })
            .where(eq(skills.id, r.id))
            .run(),
        )
        if (r.versionState === 'quarantined') {
          log.info('quarantined skill snapshot verified again; restored', {
            skillId: r.id,
            name: r.name,
          })
        }
      }
    } else {
      quarantined++
    }
  }
  log.info('boot snapshot reverify complete', { verified, quarantined, scanned: rows.length })
  return { verified, quarantined }
}
