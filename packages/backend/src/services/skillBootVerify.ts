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
// So: before opening HTTP the boot barrier ACTIVATES an empty availability set;
// after HTTP opens, a background pass re-hashes every managed
// snapshot against its recorded `content_hash`. Passing skills enter the in-memory
// `bootVerifiedSet` (boot-epoch scoped, NOT persisted, managed only); failing ones
// are CAS'd to `version_state='quarantined'` (fail-closed). Quarantined rows stay
// in the boot rescan, so a later-restored snapshot (backup/re-sync) that matches
// the recorded hash again exits quarantine on the next boot. Every gate
// (detail/list/runtime/token-writer/scheduler) shares `isSkillAvailableThisBoot`.
//
// The gate stays inactive in unit-only service use until explicitly activated.
// Production activates it before any consumer/HTTP can observe persisted rows.

import { and, eq, inArray } from 'drizzle-orm'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { skills, skillVersions } from '@/db/schema'
import { hashRegularFileTree } from '@/services/skillHash'
import {
  realDirectoryChainState,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '@/services/skillIdentityPaths'
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
/** A committed generation is hidden until its exact live publish is proven. */
export function unmarkSkillBootVerified(skillId: string): void {
  bootVerifiedSet.delete(skillId)
}
export function isSkillBootVerified(skillId: string): boolean {
  return bootVerifiedSet.has(skillId)
}
export function isBootReverifyActive(): boolean {
  return bootReverifyActivated
}
/** Production boot boundary: hide every persisted skill until this boot verifies it. */
export function activateBootReverify(): void {
  bootVerifiedSet.clear()
  bootReverifyActivated = true
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

type VerifyOutcome = 'verified' | 'quarantined' | 'superseded'

interface BootVerifyOptions {
  appHome: string
  /** Test-only race seam, after filesystem inspection and before generation CAS. */
  __beforeFinalizeForTest?: (event: {
    skillId: string
    contentVersion: number
    verdict: 'verified' | 'quarantined'
  }) => void
}

/**
 * Re-hash a managed skill's CURRENT snapshot against its recorded content_hash.
 * Every historical snapshot and the live tree must first pass a strict shape
 * proof (real directories + regular files only), then match its recorded hash.
 * Passing marks the skill boot-verified; failing CAS-quarantines it fail-closed.
 */
export function verifyManagedSnapshot(
  db: DbClient,
  opts: BootVerifyOptions,
  skill: ReverifySkill,
): VerifyOutcome {
  let inspected = skill
  // A concurrent legitimate commit may advance contentVersion while the old
  // generation is being inspected. Retry from the fresh row; never quarantine
  // or unverify the new authoritative generation on an old verdict.
  for (let attempt = 0; attempt < 8; attempt++) {
    const result = inspectManagedSnapshot(db, opts, inspected)
    opts.__beforeFinalizeForTest?.({
      skillId: inspected.id,
      contentVersion: inspected.contentVersion,
      verdict: result.ok ? 'verified' : 'quarantined',
    })
    if (result.ok) {
      const finalized = dbTxSync(db, (tx) => {
        const current = tx
          .select({
            contentVersion: skills.contentVersion,
            reservationState: skills.reservationState,
          })
          .from(skills)
          .where(eq(skills.id, inspected.id))
          .get()
        if (
          current === undefined ||
          current.contentVersion !== inspected.contentVersion ||
          current.reservationState !== 'ready'
        ) {
          return false
        }
        tx.update(skills)
          .set({ versionState: 'snapshot-authoritative' })
          .where(
            and(
              eq(skills.id, inspected.id),
              eq(skills.contentVersion, inspected.contentVersion),
            ),
          )
          .run()
        return true
      })
      if (finalized) {
        bootVerifiedSet.add(inspected.id)
        return 'verified'
      }
    } else {
      const quarantined = dbTxSync(db, (tx) => {
        const current = tx
          .select({
            contentVersion: skills.contentVersion,
            reservationState: skills.reservationState,
          })
          .from(skills)
          .where(eq(skills.id, inspected.id))
          .get()
        if (
          current === undefined ||
          current.contentVersion !== inspected.contentVersion ||
          current.reservationState !== 'ready'
        ) {
          return false
        }
        tx.update(skills)
          .set({ versionState: 'quarantined' })
          .where(
            and(
              eq(skills.id, inspected.id),
              eq(skills.contentVersion, inspected.contentVersion),
            ),
          )
          .run()
        return true
      })
      if (quarantined) {
        bootVerifiedSet.delete(inspected.id)
        log.warn('managed skill snapshot quarantined this boot', {
          skillId: inspected.id,
          name: inspected.name,
          reason: result.reason,
        })
        return 'quarantined'
      }
    }

    const fresh = db
      .select({
        id: skills.id,
        name: skills.name,
        contentVersion: skills.contentVersion,
      })
      .from(skills)
      .where(eq(skills.id, inspected.id))
      .get()
    if (fresh === undefined) return 'superseded'
    inspected = fresh
  }
  // Repeated generation churn is not corruption. Leave the newest writer's
  // verified-set decision untouched and let a later boot pass inspect it.
  log.warn('managed skill snapshot verification deferred after generation churn', {
    skillId: inspected.id,
  })
  return 'superseded'
}

function inspectManagedSnapshot(
  db: DbClient,
  opts: BootVerifyOptions,
  skill: ReverifySkill,
): { ok: true } | { ok: false; reason: string } {
  const reject = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })
  try {
    const root = skillRootAbs(opts.appHome, skill.id)
    const versions = db
      .select({
        versionIndex: skillVersions.versionIndex,
        filesPath: skillVersions.filesPath,
        contentHash: skillVersions.contentHash,
      })
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skill.id))
      .all() as Array<{
      versionIndex: number
      filesPath: string
      contentHash: string | null
    }>
    const current = versions.find((version) => version.versionIndex === skill.contentVersion)
    if (current === undefined || current.contentHash === null) {
      return reject('no current version row / hash')
    }
    const indices = versions.map((version) => version.versionIndex).sort((a, b) => a - b)
    if (
      indices.length !== skill.contentVersion ||
      indices.some((version, offset) => version !== offset + 1)
    ) {
      return reject('version history is not the complete 1..contentVersion sequence')
    }
    for (const version of versions) {
      if (version.filesPath !== skillVersionRelPath(skill.id, version.versionIndex)) {
        return reject(`version ${version.versionIndex} path is not canonical`)
      }
      if (version.contentHash === null) {
        return reject(`version ${version.versionIndex} has no content hash`)
      }
      const dir = skillVersionAbs(opts.appHome, skill.id, version.versionIndex)
      if (realDirectoryChainState(root, dir) !== 'real-directory') {
        return reject(`version ${version.versionIndex} directory missing`)
      }
      const main = lstatSync(join(dir, 'SKILL.md'))
      if (!main.isFile() || main.isSymbolicLink()) {
        return reject(`version ${version.versionIndex} SKILL.md missing`)
      }
      if (hashRegularFileTree(dir) !== version.contentHash) {
        return reject(`version ${version.versionIndex} hash mismatch (tampered/corrupt)`)
      }
    }

    // Runtime staging consumes live files/, so a green snapshot alone is not
    // enough. Live must be the byte-identical current committed version.
    const live = skillFilesAbs(opts.appHome, skill.id)
    if (realDirectoryChainState(root, live) !== 'real-directory') {
      return reject('canonical live files directory missing')
    }
    if (hashRegularFileTree(live) !== current.contentHash) {
      return reject('canonical live tree differs from current committed version')
    }
    return { ok: true }
  } catch (err) {
    return reject(
      `snapshot verification I/O failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
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
 * simply stays quarantined.
 *
 * The recovery probe is limited to reservationState='ready' rows (Codex P1):
 * op-recovery also quarantines rows in IMPOSSIBLE op states — e.g. a broken
 * reserve op whose row never reached 'ready' but whose v1 snapshot happens to
 * hash clean. A snapshot match proves content integrity only, not that the
 * create/reservation invariants hold, and `resolveSkills` gates injection on
 * `bootVerifiedSet` alone — so lifting such a row's quarantine could stage a
 * never-published skill into a spawn. Those rows stay fail-closed.
 * No global barrier — a large legit tree is just "available later", never
 * quarantined for size.
 */
export function runBootSnapshotReverify(
  db: DbClient,
  opts: BootVerifyOptions,
): { verified: number; quarantined: number } {
  bootReverifyActivated = true
  const rows = db
    .select({
      id: skills.id,
      name: skills.name,
      contentVersion: skills.contentVersion,
      versionState: skills.versionState,
      reservationState: skills.reservationState,
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
    .orderBy(skills.id)
    .all() as Array<ReverifySkill & { versionState: string; reservationState: string }>
  let verified = 0
  let quarantined = 0
  for (const r of rows) {
    if (r.versionState === 'quarantined' && r.reservationState !== 'ready') {
      quarantined++ // op-recovery fail-closed on a never-published row — not ours to lift
      continue
    }
    const outcome = verifyManagedSnapshot(db, opts, r)
    if (outcome === 'verified') {
      verified++
      if (r.versionState === 'quarantined') {
        log.info('quarantined skill snapshot verified again; restored', {
          skillId: r.id,
          name: r.name,
        })
      }
    } else if (outcome === 'quarantined') {
      quarantined++
    }
  }
  log.info('boot snapshot reverify complete', { verified, quarantined, scanned: rows.length })
  return { verified, quarantined }
}
