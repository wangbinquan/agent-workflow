// RFC-019: ZIP batch import for skills.
//
// decodeZip:   raw bytes → normalised entries (safety limits + zip-slip) — RFC-455: in domain/zipArchive.ts.
// parseSkillZip:   thin wrapper around shared parseSkillZipEntries that also
//                  decorates candidates with DB-conflict info.
// commitSkillZip:  applies a decision map and writes accepted candidates to
//                  ~/.agent-workflow/skills/{id}/files/.

import { skillTextBytes } from '../../application/skills/textView'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq, inArray } from 'drizzle-orm'
import {
  parseSkillZipEntries,
  SKILL_NAME_RE,
  type CommitSkillZipResponse,
  type ParseSkillZipResponse,
  type ResourceVisibility,
  type Skill,
  type SkillCandidate,
  type SkillZipCandidateConflict,
  type SkillZipCandidateView,
  type SkillZipCommitFailure,
  type SkillZipCommitSkipped,
  type SkillZipDecisionMap,
  type SkillZipError,
  type SkillZipOverwriteCandidate,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createManagedSkillWithFiles,
  getSkillById,
  readSkillMainText,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { isSkillAvailableThisBoot } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import {
  decodeSkillToken,
  encodeSkillToken,
  skillTokenMatches,
} from '@/modules/resource-catalog/infrastructure/legacy/skillToken'
import {
  commitSkillVersion,
  type SkillVersionFsOptions,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import {
  canEditResource,
  canViewResource,
} from '@/modules/resource-catalog/composition/resourceAcl'
import { canEditRow } from '@/modules/resource-catalog/domain/resourceAccess'
import { listWritableGrantedResourceIds } from '@/modules/resource-catalog/infrastructure/sqliteResourceGrantRepository'
import { ConflictError } from '@/util/errors'
import { decodeZip } from '../../domain/zipArchive'
import { createLogger } from '@/util/log'
import { preserveSkillMarkdownBytes, renderSkillMarkdown } from '../skillMarkdown'
import type { SkillCreationContentStore } from '../../application/skills/creationContentStore'

const log = createLogger('skill-zip')

export interface SkillZipFsOptions extends SkillVersionFsOptions {
  creationContent?: SkillCreationContentStore
}

// RFC-455: `decodeZip` (and `ZIP_LIMITS`) live in `../../domain/zipArchive.ts`.

// --- parse (HTTP-facing) -----------------------------------------------------

type SkillZipTargetRow = {
  id: string
  name: string
  ownerUserId: string | null
  visibility: ResourceVisibility
  aclRevision: number
  contentVersion: number
  metaRevision: number
  reservationState: 'reserving' | 'ready'
  versionState:
    | 'legacy-unbackfilled'
    | 'snapshot-unverified'
    | 'snapshot-authoritative'
    | 'quarantined'
}

async function listTargetRowsByName(
  db: PersistenceDb,
  names: ReadonlyArray<string>,
): Promise<SkillZipTargetRow[]> {
  if (names.length === 0) return []
  const { skills } = tablesOf(db)
  return db
    .select({
      id: skills.id,
      name: skills.name,
      ownerUserId: skills.ownerUserId,
      visibility: skills.visibility,
      aclRevision: skills.aclRevision,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
      reservationState: skills.reservationState,
      versionState: skills.versionState,
    })
    .from(skills)
    .where(inArray(skills.name, [...new Set(names)]))
}

async function loadTargetRowById(
  db: PersistenceDb,
  skillId: string,
): Promise<SkillZipTargetRow | null> {
  const { skills } = tablesOf(db)
  const rows = await db
    .select({
      id: skills.id,
      name: skills.name,
      ownerUserId: skills.ownerUserId,
      visibility: skills.visibility,
      aclRevision: skills.aclRevision,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
      reservationState: skills.reservationState,
      versionState: skills.versionState,
    })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1)
  return rows[0] ?? null
}

function targetIsAvailable(row: SkillZipTargetRow): boolean {
  return row.reservationState === 'ready' && isSkillAvailableThisBoot(row)
}

function toOverwriteCandidate(row: SkillZipTargetRow): SkillZipOverwriteCandidate {
  return {
    skillId: row.id,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    expectedAclRevision: row.aclRevision,
    expectedToken: encodeSkillToken({
      skillId: row.id,
      contentVersion: row.contentVersion,
      metaRevision: row.metaRevision,
    }),
  }
}

export async function parseSkillZipBuffer(
  db: PersistenceDb,
  actor: Actor,
  buffer: Uint8Array,
): Promise<{ response: ParseSkillZipResponse; candidates: SkillCandidate[] }> {
  const entries = decodeZip(buffer)
  const parsed = parseSkillZipEntries(entries)

  const existing = await listTargetRowsByName(
    db,
    parsed.skills.map((candidate) => candidate.name),
  )
  // RFC-324 —— 覆盖候选的判据从「我是不是 owner」变成「我改不改得动」，而这里是
  // 同步 filter，所以先把这一类里我拿到 `write` 档的 id 预取一次。
  const writableSkillIds = await listWritableGrantedResourceIds(db, actor, 'skill')
  const byName = new Map<string, SkillZipTargetRow[]>()
  for (const row of existing) {
    const rows = byName.get(row.name) ?? []
    rows.push(row)
    byName.set(row.name, rows)
  }

  const skillsView: SkillZipCandidateView[] = parsed.skills.map((c) => {
    const sameName = byName.get(c.name) ?? []
    const ownSlotOccupied = sameName.some((row) => row.ownerUserId === actor.user.id)
    const overwriteCandidates = sameName
      .filter((row) => targetIsAvailable(row) && canEditRow(actor, row, writableSkillIds))
      .sort((a, b) => {
        const ownerOrder = (a.ownerUserId ?? '').localeCompare(b.ownerUserId ?? '')
        return ownerOrder !== 0 ? ownerOrder : a.id.localeCompare(b.id)
      })
      .map(toOverwriteCandidate)
    const view: SkillZipCandidateView = {
      name: c.name,
      description: c.description,
      fileCount: c.files.length,
      totalBytes: c.totalBytes,
      warnings: c.warnings,
      ...(ownSlotOccupied
        ? { conflict: 'managed' as const satisfies SkillZipCandidateConflict }
        : {}),
      overwriteCandidates,
    }
    return view
  })

  return {
    response: { skills: skillsView, errors: parsed.errors satisfies SkillZipError[] },
    candidates: parsed.skills,
  }
}

// --- commit ------------------------------------------------------------------

interface CommitOutcome {
  created: Skill[]
  updated: Skill[]
  skipped: SkillZipCommitSkipped[]
  failed: SkillZipCommitFailure[]
}

export async function commitSkillZipBuffer(
  db: PersistenceDb,
  opts: SkillZipFsOptions,
  buffer: Uint8Array,
  decisions: SkillZipDecisionMap,
  aclOpts: {
    actor: Actor
    /** Test-only race seam after preview checks, before the version funnel tx. */
    __beforeOverwriteVersionForTest?: (target: {
      skillId: string
      candidateName: string
    }) => void | Promise<void>
  },
): Promise<CommitSkillZipResponse> {
  // Re-parse only the archive at apply time. Existing DB rows are never
  // resolved again by name: overwrite decisions must bind the exact previewed
  // skillId and generation snapshot.
  const candidates = parseSkillZipEntries(decodeZip(buffer)).skills
  const decisionFor = new Map(Object.entries(decisions))

  // Track target names already touched in this commit so a rename collision
  // inside the batch is rejected just like a DB collision.
  const claimedNames = new Set<string>()

  const outcome: CommitOutcome = { created: [], updated: [], skipped: [], failed: [] }

  for (const candidate of candidates) {
    const decision = decisionFor.get(candidate.name)
    if (decision === undefined || decision.action === 'skip') {
      outcome.skipped.push({
        name: candidate.name,
        reason: decision === undefined ? 'no decision in request' : 'skipped by user',
      })
      continue
    }

    let targetName = candidate.name
    if (decision.action === 'rename') {
      targetName = decision.newName
    }

    if (!SKILL_NAME_RE.test(targetName)) {
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-name-invalid',
        message: `target name '${targetName}' is not a valid skill name`,
      })
      continue
    }

    if (claimedNames.has(targetName)) {
      outcome.failed.push({
        name: candidate.name,
        code: 'skill-rename-conflict',
        message: `target name '${targetName}' already taken by another candidate in this import`,
      })
      continue
    }

    const overwriteDecision = decision.action === 'overwrite' ? decision : null
    const isOverwrite = overwriteDecision !== null
    let overwriteTarget: SkillZipTargetRow | null = null
    let overwriteFence:
      | { expectedSkillId: string; expectedVersion: number; expectedMetaRevision: number }
      | undefined

    if (isOverwrite) {
      const target = await loadTargetRowById(db, overwriteDecision.skillId)
      if (target === null) {
        outcome.failed.push({
          name: candidate.name,
          code: 'resource-operation-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }

      // Missing and invisible targets deliberately share one response. A
      // stolen or stale preview must not become an existence or generation
      // oracle for a resource the caller can no longer inspect.
      if (!(await canViewResource(db, aclOpts.actor, 'skill', target))) {
        outcome.failed.push({
          name: candidate.name,
          code: 'resource-operation-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }
      if (!(await canEditResource(db, aclOpts.actor, 'skill', target))) {
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-overwrite-forbidden',
          message: 'you can no longer overwrite the previewed skill; review the ZIP again',
        })
        continue
      }
      if (!targetIsAvailable(target)) {
        outcome.failed.push({
          name: candidate.name,
          code: 'resource-operation-stale',
          message: 'the previewed overwrite target is no longer available; review the ZIP again',
        })
        continue
      }

      const token = decodeSkillToken(overwriteDecision.expectedToken)
      if (
        target.name !== candidate.name ||
        overwriteDecision.expectedOwnerUserId !== target.ownerUserId ||
        overwriteDecision.expectedVisibility !== target.visibility ||
        overwriteDecision.expectedAclRevision !== target.aclRevision ||
        token === null ||
        !skillTokenMatches(token, {
          skillId: target.id,
          contentVersion: target.contentVersion,
          metaRevision: target.metaRevision,
        })
      ) {
        outcome.failed.push({
          name: candidate.name,
          code: 'resource-operation-stale',
          message: 'the previewed overwrite target changed; review the ZIP again',
        })
        continue
      }
      overwriteTarget = target
      overwriteFence = {
        expectedSkillId: token.skillId,
        expectedVersion: token.contentVersion,
        expectedMetaRevision: token.metaRevision,
      }
    } else {
      // Import/rename claims only the actor's namespace. Another owner may hold
      // the same display name without blocking this create.
      const ownRows = await listTargetRowsByName(db, [targetName])
      const occupied = ownRows.filter((row) => row.ownerUserId === aclOpts.actor.user.id)
      if (occupied.length > 0) {
        const unavailable = occupied.every((row) => !targetIsAvailable(row))
        outcome.failed.push({
          name: candidate.name,
          code: 'skill-rename-conflict',
          message: unavailable
            ? `target name '${targetName}' is held by an unavailable skill for this owner; pick a different name`
            : `skill '${targetName}' already exists for this owner; pick a different name or choose Overwrite`,
        })
        continue
      }
    }

    try {
      if (overwriteTarget === null) {
        // CREATE — route through the SAME reserve→v1-snapshot→ready pipeline as
        // POST /api/skills. The old direct live-write + bare row insert left
        // versionState='legacy-unbackfilled' with no snapshot, which the RFC-170
        // availability gate hides on a live daemon: the post-insert re-read came
        // back null and every zip create failed with "skill disappeared right
        // after insert" (unit tests passed — the gate is inactive there).
        const created = await createManagedSkillWithFiles(
          db,
          opts,
          {
            name: targetName,
            description: candidate.description,
            // RFC-231: the ZIP importer becomes owner and the new row is private.
            ownerUserId: aclOpts.actor.user.id,
            actor: aclOpts.actor,
          },
          {
            kind: 'files',
            files: candidate.files.map((file) => ({ path: file.relPath, content: file.bytes })),
            mainContent: skillTextBytes(candidateMainContent(candidate, targetName)),
          },
        )
        outcome.created.push(created)
      } else {
        await aclOpts.__beforeOverwriteVersionForTest?.({
          skillId: overwriteTarget.id,
          candidateName: candidate.name,
        })
        // OVERWRITE: route through the version funnel (RFC-170 §2 "ZIP overwrite" as
        // a version writer) — op-scoped staging + atomic publish + crash rollback +
        // the in-tx composite/owner fence (expectedOwnerUserId = the owner we
        // authorized against above, so a transfer in the await window → 409, not a
        // silent clobber). Replaces the old direct writeCandidate + updateManagedRow;
        // commitSkillVersion's setDescription keeps skills.description in sync + bumps
        // the version, and it archives the tree as an immutable snapshot.
        await commitSkillVersion(
          db,
          opts,
          overwriteTarget.id,
          {
            kind: 'replace-files',
            files: candidate.files.map((file) => ({ path: file.relPath, content: file.bytes })),
            // 与当前 SKILL.md 解析等价时保留原字节：同一份内容重导入不推进版本。
            mainContent: skillTextBytes(
              preserveSkillMarkdownBytes(
                await readSkillMainText(db, opts, overwriteTarget),
                candidateMainContent(candidate, targetName),
              ),
            ),
          },
          {
            source: 'editor',
            authorUserId: aclOpts.actor.user.id,
            expectedOwnerUserId: overwriteDecision!.expectedOwnerUserId,
            expectedAclRevision: overwriteDecision!.expectedAclRevision,
            expectedVisibility: overwriteDecision!.expectedVisibility,
            ...overwriteFence,
            setDescription: candidate.description,
          },
        )
        const updated = await getSkillById(db, overwriteTarget.id)
        if (updated !== null) outcome.updated.push(updated)
      }
      claimedNames.add(targetName)
    } catch (err) {
      log.error('zip-commit: skill write failed', {
        candidate: candidate.name,
        target: targetName,
        error: err instanceof Error ? err.message : String(err),
      })
      // A name-in-use ConflictError here is the reserve INSERT losing a race
      // (or a squatter slipping past the pre-check) — report it as the same
      // conflict the pre-checks use, not as a generic write failure. No FS
      // cleanup in either path: the create funnel rolls back its own writes
      // (row + files + op), and the old best-effort rm of the target files dir
      // could delete a CONCURRENT winner's just-published live files.
      const isNameConflict = err instanceof ConflictError && err.code === 'skill-name-in-use'
      // RFC-285 B5：技能版本围栏冲突已归一 resource-operation-stale（Q1/Q7）。
      const isStaleOverwrite =
        isOverwrite && err instanceof ConflictError && err.code === 'resource-operation-stale'
      outcome.failed.push({
        name: candidate.name,
        code: isNameConflict
          ? 'skill-rename-conflict'
          : isStaleOverwrite
            ? 'resource-operation-stale'
            : 'skill-write-failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Surface candidates that weren't even attempted (decisions referenced
  // candidate names that don't exist in the zip).
  const candidateNames = new Set(candidates.map((c) => c.name))
  for (const name of decisionFor.keys()) {
    if (!candidateNames.has(name)) {
      outcome.skipped.push({ name, reason: 'no matching candidate in zip' })
    }
  }

  return outcome
}

function candidateMainContent(candidate: SkillCandidate, targetName: string): string {
  // RFC-401 T5：唯一字节合同（design §2.3）。
  return renderSkillMarkdown({
    name: targetName,
    description: candidate.description,
    bodyMd: candidate.bodyMd,
    frontmatterExtra: candidate.frontmatterExtra,
  })
}

// The old direct-write create helpers (writeCandidate → live files/ +
// insertManagedRow → bare skills row) are gone: a bare row has no v1 snapshot
// (versionState 'legacy-unbackfilled'), so the RFC-170 boot availability gate
// hid it on a live daemon and the post-insert re-read failed with "skill
// disappeared right after insert". Creates now route through
// createManagedSkillWithFiles (reserve → v1 snapshot → ready), same as
// POST /api/skills; overwrites through commitSkillVersion, whose
// setDescription syncs skills.description inside the version-bump tx.
