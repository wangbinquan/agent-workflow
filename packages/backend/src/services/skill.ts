// Skill service.
//
// Storage model (design.md §2):
//   ~/.agent-workflow/skills/{id}/files/SKILL.md      (+ support files)
//
// DB row holds only the index. RFC-178: skills are managed-only — the external
// (hand-imported) and parent-directory (skill_sources / RFC-017) source kinds
// were removed, so the platform owns every skill's files.
//
// Reference check: an agent's frontmatter.skills[] referencing this skill
// makes it un-deletable; same as agents <-> workflows in P-1-08.

import type {
  CreateManagedSkill,
  FileNode,
  Skill,
  SkillContent,
  UpdateSkillContent,
} from '@agent-workflow/shared'
import { isProtectedSkillMainFile } from '@agent-workflow/shared'
import { and, eq, isNull } from 'drizzle-orm'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, skills } from '@/db/schema'
import { commitSkillVersion } from '@/services/skillVersion'
import { isSkillAvailableThisBoot } from '@/services/skillBootVerify'
import { tokenToVersionFence } from '@/services/skillToken'
import { dbTxSync } from '@/db/txSync'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
} from '@/services/skillOperations'
import { parseFrontmatter, stringifyFrontmatter } from '@/util/frontmatter'
import { realpathInside, realpathWriteInside, safeJoin } from '@/util/safePath'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { discloseRefs } from './resourceAcl'
import type { Actor } from '@/auth/actor'
import {
  skillFilesAbs,
  skillFilesRel,
  skillVersionAbs,
  skillRootAbs,
} from '@/services/skillIdentityPaths'

type SkillRow = typeof skills.$inferSelect

export interface SkillFsOptions {
  /** App home dir; managed skills live under `${appHome}/skills/{id}/files/`. */
  appHome: string
}

// --- query helpers ---

export async function listSkills(db: DbClient): Promise<Skill[]> {
  // RFC-170 §9: skills mid-creation (reservation_state='reserving') are not yet
  // published and must stay invisible until their reserve op reaches 'ready'.
  const rows = await db.select().from(skills).where(eq(skills.reservationState, 'ready'))
  // RFC-170 §invariant④ (G8-2): also hide anything not available THIS boot — a
  // managed skill whose snapshot hasn't (yet) re-verified, or a quarantined one.
  // Inactive before the boot reverify runs (tests / pre-HTTP), so no filtering then.
  return rows.filter((r) => isSkillAvailableThisBoot(r)).map(rowToSkill)
}

export async function getSkill(db: DbClient, name: string): Promise<Skill | null> {
  // RFC-170 §9: only surface a fully-reserved (published) skill.
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.name, name), eq(skills.reservationState, 'ready')))
    .limit(1)
  const row = rows[0]
  // RFC-170 §invariant④: gate on the unified availability predicate (see listSkills).
  if (!row || !isSkillAvailableThisBoot(row)) return null
  return rowToSkill(row)
}

export async function getSkillById(db: DbClient, skillId: string): Promise<Skill | null> {
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready')))
    .limit(1)
  const row = rows[0]
  if (!row || !isSkillAvailableThisBoot(row)) return null
  return rowToSkill(row)
}

/**
 * Resolve the absolute root directory holding files/ for a (managed) skill:
 * `${appHome}/skills/{id}/files`. RFC-178: skills are managed-only.
 */
export function skillRoot(skill: Skill, opts: SkillFsOptions): string {
  return skillFilesAbs(opts.appHome, skill.id)
}

/**
 * RFC-170 (G1-1) — the AUTHORITATIVE dir to READ a skill's content from: the
 * current version's IMMUTABLE snapshot (`versions/v<contentVersion>/files`), not
 * live `files/`. After every commit the two are identical (swapInStaged), but the
 * snapshot is the source of truth — a torn/half-published live dir (crash
 * mid-swap) can't corrupt a read, and the content always matches the signed
 * precondition token's `contentVersion`. Falls back to live for a legacy skill
 * with no snapshot yet.
 */
export function skillReadRoot(skill: Skill, opts: SkillFsOptions): string {
  const live = skillRoot(skill, opts)
  const snapshot = skillVersionAbs(opts.appHome, skill.id, skill.contentVersion)
  return existsSync(snapshot) ? snapshot : live
}

/**
 * Raw name-occupancy check: ANY skills row counts, including rows the gated
 * getSkill hides (mid-create 'reserving', 'quarantined', boot-unverified).
 * Callers use it to report "name taken by an unavailable skill" accurately
 * instead of falling through to a UNIQUE-constraint error at insert time.
 */
export async function isSkillNameOccupied(db: DbClient, name: string): Promise<boolean> {
  const rows = await db.select({ id: skills.id }).from(skills).where(eq(skills.name, name)).limit(1)
  return rows.length > 0
}

/**
 * RFC-223 AC19 — raw occupancy inside one owner's namespace. Hidden reserving
 * and quarantined rows still occupy the slot; another owner's same-named row
 * does not.
 */
export async function isSkillNameOccupiedForOwner(
  db: DbClient,
  name: string,
  ownerUserId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ id: skills.id })
    .from(skills)
    .where(
      and(
        eq(skills.name, name),
        ownerUserId === null ? isNull(skills.ownerUserId) : eq(skills.ownerUserId, ownerUserId),
      ),
    )
    .limit(1)
  return rows.length > 0
}

// --- create ---

export async function createManagedSkill(
  db: DbClient,
  opts: SkillFsOptions,
  input: CreateManagedSkill,
  aclOpts?: { ownerUserId?: string },
): Promise<Skill> {
  return createManagedSkillWithFiles(
    db,
    opts,
    { name: input.name, description: input.description, ownerUserId: aclOpts?.ownerUserId },
    (filesDir) => {
      const skillMd = stringifyFrontmatter({
        data: { name: input.name, description: input.description, ...input.frontmatterExtra },
        body: input.bodyMd,
      })
      writeFileSync(join(filesDir, 'SKILL.md'), skillMd, 'utf-8')
    },
  )
}

/**
 * THE shared create pipeline (RFC-170 §9): reserve (invisible row + op lock) →
 * produce the files tree into the still-invisible live files/ → archive it as
 * v1 via commitSkillVersion(initial) (=> 'snapshot-authoritative' + boot-
 * verified) → flip 'ready' (atomically visible). Any throw rolls the whole
 * create back (row + files + op).
 *
 * Used by POST /api/skills (single-SKILL.md producer above) AND the ZIP
 * import's create branch (whole candidate tree). The zip path used to insert a
 * bare row with no v1 snapshot (schema-default versionState
 * 'legacy-unbackfilled'), which the RFC-170 availability gate hides on a live
 * daemon — its own post-insert re-read came back null and every zip create
 * failed with "skill disappeared right after insert".
 */
export async function createManagedSkillWithFiles(
  db: DbClient,
  opts: SkillFsOptions,
  meta: { name: string; description: string; ownerUserId?: string },
  produceFiles: (filesDir: string) => void,
  hooks: {
    /** Test-only fault seam after ready + db-committed, before op retirement. */
    __afterDbCommitForTest?: () => void
  } = {},
): Promise<Skill> {
  // Fast-path occupancy check — RAW inside the target owner's namespace (any
  // row, even gate-hidden), so a squatted owner/name slot 409s cleanly while a
  // different owner may use the same display name. The expression unique index
  // remains the racing-create guard before any files are written.
  const ownerUserId = meta.ownerUserId ?? null
  if (await isSkillNameOccupiedForOwner(db, meta.name, ownerUserId)) {
    throw new ConflictError('skill-name-in-use', `skill '${meta.name}' already exists`)
  }

  const id = ulid()
  const now = Date.now()

  // ① reserve intent: insert the row at reservation_state='reserving' (invisible
  //    to getSkill/list) + open the reserve op + lock, one tx. A unique(name)
  //    violation here means a concurrent create won the slot → 409, nothing written.
  let opId: string
  try {
    opId = dbTxSync(db, (tx) => {
      tx.insert(skills)
        .values({
          id,
          name: meta.name,
          description: meta.description,
          sourceKind: 'managed',
          managedPath: skillFilesRel(id),
          // RFC-099: creator becomes owner; new resources default to 'public' (D18).
          ownerUserId,
          visibility: 'public',
          reservationState: 'reserving',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      return beginOperation(tx, {
        skillId: id,
        kind: 'reserve',
        ownerUserId: ownerUserId ?? undefined,
        preconditionJson: JSON.stringify({ skillId: id }),
      })
    })
  } catch (err) {
    if (
      /skills_owner_name_unique|UNIQUE constraint failed:? *skills\.(?:owner_user_id|name)/i.test(
        err instanceof Error ? err.message : '',
      )
    ) {
      throw new ConflictError('skill-name-in-use', `skill '${meta.name}' already exists`)
    }
    throw err
  }

  const skillDir = skillRootAbs(opts.appHome, id)
  let committed = false
  try {
    // ② fs-staged: produce the files tree into the (still-invisible) files dir.
    const filesDir = join(skillDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    produceFiles(filesDir)
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))

    // ③ fs-published: archive the tree as v1 + atomically publish (RFC-101/170).
    // skipOp: reserve already holds this skill's op lock — commitSkillVersion must
    // NOT open its own version-write op (it would self-conflict on the same lock).
    commitSkillVersion(db, opts, id, () => {}, {
      source: 'initial',
      authorUserId: ownerUserId,
      skipOp: true,
    })
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-published'))

    // ④ db-committed: flip to 'ready' — the skill becomes visible now, atomically.
    dbTxSync(db, (tx) => {
      tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, id)).run()
      advancePhase(tx, opId, 'db-committed')
    })
    committed = true
    hooks.__afterDbCommitForTest?.()
    dbTxSync(db, (tx) => finishOperation(tx, opId))
  } catch (err) {
    // ready + db-committed is authoritative. Never reverse it in-process:
    // preserve row/root/op/lock so the boot barrier can prove and roll forward.
    if (committed) throw err
    // Roll back (in-process): discard the reserving row + files + retire the op.
    // (A crash — not an in-process throw — is recovered at boot by the reserve
    // recovery handler, which does the same.)
    // RFC-208: the filesystem cleanup must never be able to skip the DB
    // rollback. `force: true` only swallows ENOENT — EPERM / EBUSY / ENOTEMPTY
    // still throw, and when they did, `abandonOperation` never ran: the row
    // stayed `reserving` and the operation lock stayed ACTIVE, so every endpoint
    // for that skill answered 409 skill-operation-busy forever. The orphan sweep
    // could not clear it either, since it only reclaims locks whose op is no
    // longer active — and this one is. Leftover files are recoverable (GC, and
    // the boot reserve-recovery handler); a stuck lock is not.
    try {
      rmSync(skillDir, { recursive: true, force: true })
    } catch {
      /* best-effort: a leftover dir is reclaimable, a stranded lock is not */
    }
    dbTxSync(db, (tx) => {
      tx.delete(skills).where(eq(skills.id, id)).run()
      abandonOperation(tx, opId)
    })
    throw err
  }

  const created = await getSkillById(db, id)
  if (created === null) throw new Error('skill disappeared right after reserve')
  return created
}

// --- delete ---

export async function deleteSkill(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
  actor: Actor,
  expected?: { token: string; aclRevision: number; ownerUserId: string | null },
): Promise<void> {
  const existing = await getSkillById(db, skillId)
  if (existing === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  let deleteFence:
    | {
        skillId: string
        contentVersion: number
        metaRevision: number
        ownerUserId: string | null
        aclRevision: number
      }
    | undefined
  if (expected !== undefined) {
    const { decodeSkillToken } = await import('@/services/skillToken')
    const decoded = decodeSkillToken(expected.token)
    if (decoded === null) {
      throw new ValidationError(
        'skill-token-invalid',
        'malformed precondition token; reload and retry',
      )
    }
    const live = await db
      .select({
        id: skills.id,
        contentVersion: skills.contentVersion,
        metaRevision: skills.metaRevision,
        ownerUserId: skills.ownerUserId,
        aclRevision: skills.aclRevision,
      })
      .from(skills)
      .where(eq(skills.id, skillId))
      .limit(1)
    const current = live[0]
    if (
      current === undefined ||
      current.id !== decoded.skillId ||
      current.contentVersion !== decoded.contentVersion ||
      current.metaRevision !== decoded.metaRevision ||
      current.ownerUserId !== expected.ownerUserId ||
      current.aclRevision !== expected.aclRevision
    ) {
      throw new ConflictError(
        'skill-version-conflict',
        `skill '${skillId}' changed since this operation started; reload and retry`,
      )
    }
    deleteFence = {
      skillId: decoded.skillId,
      contentVersion: decoded.contentVersion,
      metaRevision: decoded.metaRevision,
      ownerUserId: expected.ownerUserId,
      aclRevision: expected.aclRevision,
    }
  }

  // RFC-223 (PR-1): agents.skills stores typed refs — match managed refs by id.
  const refs = await findAgentsUsingSkill(db, existing.id)
  if (refs.length > 0) {
    // RFC-203 T6: principal-aware disclosure (deleteWorkflow precedent).
    throw new ConflictError(
      'skill-in-use',
      `skill '${existing.name}' is referenced by ${refs.length} agent(s)`,
      await discloseRefs(db, actor, 'agent', refs),
    )
  }

  // RFC-170 §6a: crash-safe op-based delete — rename the whole root to trash,
  // DELETE the row in the same tx as the phase advance, then drop the trash.
  // A crash between steps is recovered by the boot driver (deleteRecoveryHandler).
  const { deleteManagedSkillOp } = await import('@/services/skillDeleteOp')
  deleteManagedSkillOp(db, { appHome: opts.appHome }, { id: existing.id }, {}, deleteFence)
}

// RFC-223 (PR-1): agents.skills stores typed refs (managed{skillId} /
// project{name}); a skill is "used" by an agent that carries a MANAGED ref to
// this skill's id. Project refs (repo-local, no DB row) never match here.
async function findAgentsUsingSkill(
  db: DbClient,
  skillId: string,
): Promise<
  Array<{ id: string; name: string; ownerUserId: string | null; visibility: 'public' | 'private' }>
> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      skills: agents.skills,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
  const out: Array<{
    id: string
    name: string
    ownerUserId: string | null
    visibility: 'public' | 'private'
  }> = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.skills) as unknown
      const referencesSkill =
        Array.isArray(parsed) &&
        parsed.some(
          (ref) =>
            typeof ref === 'object' &&
            ref !== null &&
            (ref as { kind?: unknown }).kind === 'managed' &&
            (ref as { skillId?: unknown }).skillId === skillId,
        )
      if (referencesSkill)
        out.push({
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
    } catch {
      // skip malformed
    }
  }
  return out
}

// --- SKILL.md content (parsed view) ---

export async function readSkillContent(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
): Promise<SkillContent> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  // RFC-170 (G1-1): read the SKILL.md body + sign the token from the AUTHORITATIVE
  // version snapshot, not live — so the returned content always matches the token's
  // contentVersion and a torn live dir can't corrupt the read.
  const root = skillReadRoot(skill, opts)
  const skillMdPath = join(root, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    throw new NotFoundError('skill-md-missing', `SKILL.md not found at ${skillMdPath}`)
  }
  // RFC-170 G3-1 (security): SKILL.md may be a symlink; contain it so a
  // `SKILL.md -> ~/.ssh/id_rsa` link can't leak host files to a shared skill's
  // readers (same fix as readSkillFile).
  const raw = readFileSync(realpathInside(root, skillMdPath), 'utf-8')
  const parsed = parseFrontmatter(raw)
  const { name: _ignoredName, description: descRaw, ...rest } = parsed.data
  // RFC-170 §2/T3 + re-review-3: emit the composite precondition token AND the DB
  // description-fallback from ONE atomic row snapshot, keyed on the immutable id.
  // Reading skills.description and metaRevision in two separate queries let a
  // concurrent description save land between them → the response would pair an OLD
  // description with the NEW token, and the client's next save would pass OCC and
  // silently roll the concurrent edit back. If the row vanished (concurrent
  // delete), that is a 409 — NOT a fabricated metaRevision-0 token pointing at a
  // gone generation.
  const gen = (
    await db
      .select({ description: skills.description, metaRevision: skills.metaRevision })
      .from(skills)
      .where(eq(skills.id, skill.id))
      .limit(1)
  )[0]
  if (gen === undefined) {
    throw new ConflictError('skill-changed', `skill '${skill.name}' changed; reload and retry`)
  }
  const { encodeSkillToken } = await import('@/services/skillToken')
  const token = encodeSkillToken({
    skillId: skill.id,
    contentVersion: skill.contentVersion,
    metaRevision: gen.metaRevision,
  })
  // The SKILL.md frontmatter description is authoritative (contentVersion-tied via
  // the token); fall back to the DB row's description (read from the SAME snapshot
  // as the token's metaRevision above) when the frontmatter has none.
  const description = typeof descRaw === 'string' ? descRaw : gen.description
  return {
    name: skill.name,
    description,
    bodyMd: parsed.body,
    frontmatterExtra: rest,
    token,
  }
}

/**
 * RFC-170 T6 — the composite precondition token for a skill BY NAME, or null if
 * the skill is gone / not yet published. DB-only (no FS read), same codec as the
 * detail read. Used by the fusion approval flow: a fusion links to its target by
 * NAME, so a delete→recreate rebuild keeps the name but mints a new skillId — the
 * token's skillId (plus contentVersion/metaRevision) defeats that ABA and any
 * concurrent skill edit between fusion create and approve / re-run.
 */
export async function getSkillPreconditionToken(
  db: DbClient,
  name: string,
): Promise<string | null> {
  const row = await db
    .select({
      id: skills.id,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
    })
    .from(skills)
    .where(and(eq(skills.name, name), eq(skills.reservationState, 'ready')))
    .limit(1)
  const r = row[0]
  if (r === undefined) return null
  const { encodeSkillToken } = await import('@/services/skillToken')
  return encodeSkillToken({
    skillId: r.id,
    contentVersion: r.contentVersion,
    metaRevision: r.metaRevision,
  })
}

/**
 * RFC-170 T6 (Codex re-review F11) — the composite precondition token for a skill
 * BY IMMUTABLE ID (not name), or null if that exact skill row is gone / not ready.
 * The fusion flow authorizes a skill row, then must bind its token to THAT row's
 * id: a by-NAME token re-read can silently pick up a same-name delete→recreate
 * replacement (a different, possibly private, skill). Binding by id makes an
 * A→B recreate resolve to null → the fusion is refused before any side effect.
 */
export async function getSkillPreconditionTokenById(
  db: DbClient,
  skillId: string,
): Promise<string | null> {
  const row = await db
    .select({
      id: skills.id,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
    })
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.reservationState, 'ready')))
    .limit(1)
  const r = row[0]
  if (r === undefined) return null
  const { encodeSkillToken } = await import('@/services/skillToken')
  return encodeSkillToken({
    skillId: r.id,
    contentVersion: r.contentVersion,
    metaRevision: r.metaRevision,
  })
}

export async function writeSkillContent(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
  patch: UpdateSkillContent,
  authorUserId?: string | null,
  // RFC-170 T-BSAFE③ (Codex F1-review): when the caller holds a precondition token
  // (combined-save), thread the full expected {skillId, contentVersion, metaRevision}
  // into commitSkillVersion's IN-TX composite fence (F4). The token check in
  // saveSkillWithToken is a pre-check that is TOCTOU vs this write — without the
  // in-tx fence a concurrent save / delete-recreate ABA between them silently
  // LWW-clobbers. Omitted by non-OCC internal callers (tests, fusion base).
  // `ownerUserId` (4th-review [high]) is the owner the ROUTE authorized against
  // (requireResourceOwner); the funnel 409s if it drifted — closing the
  // owner-transfer-during-save race so a demoted ex-owner can't commit.
  expected?: {
    skillId: string
    contentVersion: number
    metaRevision: number
    ownerUserId?: string | null
  },
): Promise<SkillContent> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  const current = await readSkillContent(db, opts, skillId).catch(() => ({
    name: skill.name,
    description: skill.description,
    bodyMd: '',
    frontmatterExtra: {} as Record<string, unknown>,
  }))

  const next: SkillContent = {
    name: skill.name,
    description: patch.description ?? current.description,
    bodyMd: patch.bodyMd ?? current.bodyMd,
    frontmatterExtra: patch.frontmatterExtra ?? current.frontmatterExtra,
  }

  const md = stringifyFrontmatter({
    data: { name: next.name, description: next.description, ...next.frontmatterExtra },
    body: next.bodyMd,
  })

  // RFC-101: route through the single versioning funnel — archives the prior
  // files/ as a version, writes the new SKILL.md, bumps content_version, and
  // (when description changed) syncs the DB description in the same tx.
  commitSkillVersion(
    db,
    opts,
    skillId,
    (staging) => {
      // RFC-170 impl-gate (Codex 2026-07-22): commitSkillVersion cpSync-copies
      // the prior files/ into `staging` WITHOUT dereferencing links, so a live
      // `SKILL.md` that is a symlink lands here as a symlink and a raw
      // writeFileSync would FOLLOW it to overwrite the host target. Route through
      // the same no-follow containment guard the file-tree writer uses (~L694).
      const target = realpathWriteInside(staging, join(staging, 'SKILL.md'))
      writeFileSync(target, md, 'utf-8')
    },
    {
      source: 'editor',
      authorUserId: authorUserId ?? null,
      setDescription: patch.description !== undefined ? patch.description : undefined,
      // Fence the composite precondition + owner atomically with the version bump.
      ...(expected !== undefined
        ? {
            expectedSkillId: expected.skillId,
            expectedVersion: expected.contentVersion,
            expectedMetaRevision: expected.metaRevision,
            ...(expected.ownerUserId !== undefined
              ? { expectedOwnerUserId: expected.ownerUserId }
              : {}),
          }
        : {}),
    },
  )

  return next
}

/**
 * RFC-170 §2/T4 — combined save with composite-token OCC. One request carries the
 * description + body + the precondition token the client got from the detail read
 * (T3). The token is verified against the CURRENT (skillId, contentVersion,
 * metaRevision) inside the same load; a stale token (another writer advanced the
 * version, or a delete-recreate reused the name = ABA) → 409, no write. A
 * malformed token → 400 (fail-closed). On match, the write goes through
 * writeSkillContent (which bumps content_version) and returns the fresh token.
 */
export async function saveSkillWithToken(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
  patch: UpdateSkillContent,
  expectedToken: string,
  authorUserId?: string | null,
  // RFC-170 (4th-review [high]): the owner the route authorized this actor against
  // (requireResourceOwner). Threaded into the version-bump tx so an owner transfer
  // in this call's await window 409s instead of committing a post-revocation version.
  expectedOwnerUserId?: string | null,
): Promise<SkillContent> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  const metaRow = await db
    .select({ metaRevision: skills.metaRevision })
    .from(skills)
    .where(eq(skills.id, skill.id))
    .limit(1)
  const current = {
    skillId: skill.id,
    contentVersion: skill.contentVersion,
    metaRevision: metaRow[0]?.metaRevision ?? 0,
  }
  const { decodeSkillToken, skillTokenMatches } = await import('@/services/skillToken')
  const decoded = decodeSkillToken(expectedToken)
  if (decoded === null) {
    throw new ValidationError(
      'skill-token-invalid',
      'malformed precondition token; reload and retry',
    )
  }
  if (!skillTokenMatches(decoded, current)) {
    throw new ConflictError(
      'skill-version-conflict',
      `skill '${skill.name}' changed since you loaded it; reload and retry`,
    )
  }

  // managed: the six-writer version funnel. Feed the decoded token into
  // commitSkillVersion's IN-TX composite fence (F4) so the OCC is atomic with the
  // version bump — the outer skillTokenMatches above is only a pre-check.
  await writeSkillContent(db, opts, skillId, patch, authorUserId, {
    skillId: decoded.skillId,
    contentVersion: decoded.contentVersion,
    metaRevision: decoded.metaRevision,
    ...(expectedOwnerUserId !== undefined ? { ownerUserId: expectedOwnerUserId } : {}),
  })
  // Re-read so the response carries the FRESH token (writeSkillContent's return
  // omits it) — the client reuses it for the next save without a reload.
  return readSkillContent(db, opts, skillId)
}

// --- file tree ---

export async function listSkillFiles(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
): Promise<FileNode[]> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  // RFC-170 (G1-1): the file tree reflects the AUTHORITATIVE snapshot, not live —
  // consistent with readSkillContent/readSkillFile.
  const root = skillReadRoot(skill, opts)
  if (!existsSync(root)) return []
  return walkDir(root, '')
}

function walkDir(absRoot: string, relRoot: string): FileNode[] {
  const out: FileNode[] = []
  const entries = readdirSync(join(absRoot, relRoot), { withFileTypes: true })
  for (const entry of entries) {
    const childRel = relRoot ? `${relRoot}/${entry.name}` : entry.name
    const abs = join(absRoot, childRel)
    if (entry.isDirectory()) {
      out.push({ path: childRel, type: 'dir' })
      out.push(...walkDir(absRoot, childRel))
    } else if (entry.isFile()) {
      const st = statSync(abs)
      out.push({
        path: childRel,
        type: 'file',
        size: st.size,
        modifiedAt: Math.floor(st.mtimeMs),
      })
    }
    // Symlinks intentionally skipped in v1.
  }
  return out
}

export async function readSkillFile(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
  relPath: string,
): Promise<string> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  // RFC-170 (G1-1): read from the AUTHORITATIVE snapshot, not live.
  const root = skillReadRoot(skill, opts)
  const abs = safeJoin(root, relPath)
  if (!existsSync(abs)) {
    throw new NotFoundError(
      'skill-file-not-found',
      `file '${relPath}' not found in skill '${skill.name}'`,
    )
  }
  // RFC-170 G3-1 (security): safeJoin does NOT resolve symlinks, but readFileSync
  // follows them — a skill dir can hold a symlink pointing outside root (e.g.
  // `secret -> ~/.ssh/id_rsa`), so a SHARED skill would leak host files to any
  // authorized/public reader. realpathInside resolves + verifies containment,
  // throwing path-traversal on an escaping link (internal symlinks still resolve).
  const real = realpathInside(root, abs)
  if (statSync(real).isDirectory()) {
    throw new ValidationError('skill-file-is-dir', `'${relPath}' is a directory`)
  }
  return readFileSync(real, 'utf-8')
}

export async function writeSkillFile(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
  relPath: string,
  content: string,
  authorUserId?: string | null,
  // RFC-170 (4th-review [high]): the owner the route authorized against — the
  // funnel 409s if it drifts before the version commits (owner-transfer race).
  expectedOwnerUserId?: string | null,
  // RFC-170 F3: composite precondition token (from the client's canonical token
  // store) — OCC-fenced in the version-bump tx. Malformed → 400, stale → 409.
  expectedToken?: string,
): Promise<void> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  // RFC-169: SKILL.md is edited exclusively through POST /save — the file tree
  // must never write it via an arbitrary path (before RFC-169 there was NO
  // check, so adding a file named `SKILL.md` / `./SKILL.md` truncated it).
  assertNotSkillMainFile(skillRoot(skill, opts), relPath)
  const fence = tokenToVersionFence(expectedToken)
  if (fence === null) {
    throw new ValidationError(
      'skill-token-invalid',
      'malformed precondition token; reload and retry',
    )
  }
  // RFC-101: support-file writes version the whole files/ tree too.
  commitSkillVersion(
    db,
    opts,
    skillId,
    (staging) => {
      const abs = safeJoin(staging, relPath)
      // RFC-170 G3-1 parity with the read path: safeJoin is lexical, but
      // writeFileSync FOLLOWS symlinks. A symlinked path component (or leaf)
      // copied into staging would otherwise let this write escape the skill root
      // — as the daemon uid, often root. Refuse an escaping ancestor BEFORE
      // mkdir (which also follows links), then an escaping leaf symlink.
      // See design/test-guard-audit-2026-07-21 gap B5-security-8.
      const target = realpathWriteInside(staging, abs)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf-8')
    },
    {
      source: 'editor',
      authorUserId: authorUserId ?? null,
      ...(expectedOwnerUserId !== undefined ? { expectedOwnerUserId } : {}),
      ...(fence ?? {}),
    },
  )
}

export async function deleteSkillFile(
  db: DbClient,
  opts: SkillFsOptions,
  skillId: string,
  relPath: string,
  authorUserId?: string | null,
  // RFC-170 (4th-review [high]): owner the route authorized against; funnel 409s on drift.
  expectedOwnerUserId?: string | null,
  // RFC-170 F3: composite precondition token — OCC-fenced in the version-bump tx.
  expectedToken?: string,
): Promise<void> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  const root = skillRoot(skill, opts)
  // RFC-169: SKILL.md is special — refuse to delete it (users edit via /save).
  // The pre-RFC-169 raw `=== 'SKILL.md'` compare was bypassable via `./SKILL.md`,
  // a trailing separator, or a case variant on a case-insensitive filesystem.
  assertNotSkillMainFile(root, relPath)
  if (!existsSync(safeJoin(root, relPath))) {
    throw new NotFoundError(
      'skill-file-not-found',
      `file '${relPath}' not found in skill '${skill.name}'`,
    )
  }
  const fence = tokenToVersionFence(expectedToken)
  if (fence === null) {
    throw new ValidationError(
      'skill-token-invalid',
      'malformed precondition token; reload and retry',
    )
  }
  // RFC-101: deletion versions the tree (the removal IS the change).
  commitSkillVersion(
    db,
    opts,
    skillId,
    (staging) => {
      const abs = safeJoin(staging, relPath)
      if (!existsSync(abs)) return
      // A symlink at the leaf: remove the LINK, never its target. lstat (no
      // follow) decides link-ness; realpathWriteInside refuses an escaping
      // ancestor and verifies an escaping leaf link before we touch it.
      const target = realpathWriteInside(staging, abs)
      if (lstatSync(target).isSymbolicLink()) {
        unlinkSync(target) // removes the symlink itself, not what it points to
        return
      }
      // statSync (follows) is safe now: the ancestor chain is verified contained
      // and the leaf is not a symlink.
      if (statSync(target).isDirectory()) rmSync(target, { recursive: true })
      else unlinkSync(target)
    },
    {
      source: 'editor',
      authorUserId: authorUserId ?? null,
      ...(expectedOwnerUserId !== undefined ? { expectedOwnerUserId } : {}),
      ...(fence ?? {}),
    },
  )
}

// --- helpers ---

function rowToSkill(row: SkillRow): Skill {
  const out: Skill = {
    id: row.id,
    name: row.name,
    description: row.description,
    // RFC-099 ACL projection — routes filter on these.
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    // RFC-178: skills are managed-only.
    sourceKind: 'managed',
    schemaVersion: row.schemaVersion,
    contentVersion: row.contentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.managedPath !== null) out.managedPath = row.managedPath
  return out
}

/**
 * RFC-169 — reject any file-tree write/delete that targets the skill's main
 * `SKILL.md`. Two layers (design §5.2):
 *   1. lexical (`isProtectedSkillMainFile`, shared front+back) — catches pure
 *      aliases: `SKILL.md`, `./SKILL.md`, `SKILL.md/`, `skill.md`, dot-segments;
 *   2. filesystem identity — catches names the lexical layer can't see because
 *      they only collide on the actual filesystem: APFS folding `ſKILL.md`
 *      (U+017F) onto SKILL.md's inode, or a symlink already pointing at it. We
 *      compare realpath, then dev+inode, of the resolved target vs root
 *      SKILL.md. On a case-sensitive filesystem these are genuinely different
 *      files and correctly fall through.
 */
function assertNotSkillMainFile(root: string, relPath: string): void {
  if (isProtectedSkillMainFile(relPath) || resolvesToSkillMainFile(root, relPath)) {
    throw new ConflictError(
      'skill-md-protected',
      'cannot write or delete SKILL.md; edit content via POST /api/skills/:id/save',
    )
  }
}

function resolvesToSkillMainFile(root: string, relPath: string): boolean {
  const mainFile = join(root, 'SKILL.md')
  let target: string
  try {
    target = safeJoin(root, relPath)
  } catch {
    // Traversal / absolute / backslash — handled (and rejected) elsewhere.
    return false
  }
  try {
    if (realpathSync(target) === realpathSync(mainFile)) return true
  } catch {
    // target or main not present yet — fall through to the inode check.
  }
  try {
    const st = statSync(target)
    const sm = statSync(mainFile)
    if (st.dev === sm.dev && st.ino === sm.ino) return true
  } catch {
    // not present on disk — nothing to collide with.
  }
  return false
}
