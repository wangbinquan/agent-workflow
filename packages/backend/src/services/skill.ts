// Skill service.
//
// Storage model (design.md §2):
//   ~/.agent-workflow/skills/{name}/files/SKILL.md      (+ support files)
//
// DB row holds only the index. For external skills, `externalPath` points at
// a user-managed directory; the platform reads from there but never writes.
//
// Reference check: an agent's frontmatter.skills[] referencing this skill
// makes it un-deletable; same as agents <-> workflows in P-1-08.

import type {
  CreateManagedSkill,
  FileNode,
  ImportExternalSkill,
  Skill,
  SkillContent,
  UpdateSkill,
  UpdateSkillContent,
} from '@agent-workflow/shared'
import { isProtectedSkillMainFile } from '@agent-workflow/shared'
import { and, eq, sql } from 'drizzle-orm'
import {
  existsSync,
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
import { dbTxSync } from '@/db/txSync'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
} from '@/services/skillOperations'
import { parseFrontmatter, stringifyFrontmatter } from '@/util/frontmatter'
import { realpathInside, safeJoin } from '@/util/safePath'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

type SkillRow = typeof skills.$inferSelect

export interface SkillFsOptions {
  /** App home dir; managed skills live under `${appHome}/skills/{name}/files/`. */
  appHome: string
}

// --- query helpers ---

export async function listSkills(db: DbClient): Promise<Skill[]> {
  // RFC-017: lazy reconcile every enabled skill_source before returning, so
  // child skills mirror the filesystem without a manual rescan. The helper
  // swallows per-source errors into lastScanError; listing never fails when a
  // parent dir is temporarily missing.
  const { reconcileAllSources } = await import('@/services/skill-source')
  await reconcileAllSources(db)
  // RFC-170 §9: skills mid-creation (reservation_state='reserving') are not yet
  // published and must stay invisible until their reserve op reaches 'ready'.
  const rows = await db.select().from(skills).where(eq(skills.reservationState, 'ready'))
  return rows.map(rowToSkill)
}

export async function getSkill(db: DbClient, name: string): Promise<Skill | null> {
  // RFC-170 §9: only surface a fully-reserved (published) skill.
  const rows = await db
    .select()
    .from(skills)
    .where(and(eq(skills.name, name), eq(skills.reservationState, 'ready')))
    .limit(1)
  const row = rows[0]
  return row ? rowToSkill(row) : null
}

/**
 * Resolve the absolute root directory holding files/ for a skill.
 * Managed -> `${appHome}/skills/{name}/files`.
 * External -> the registered absolute path itself.
 */
export function skillRoot(skill: Skill, opts: SkillFsOptions): string {
  if (skill.sourceKind === 'managed') {
    return join(opts.appHome, 'skills', skill.name, 'files')
  }
  if (skill.externalPath === undefined) {
    throw new Error(`external skill '${skill.name}' has no externalPath`)
  }
  return skill.externalPath
}

// --- create / import ---

export async function createManagedSkill(
  db: DbClient,
  opts: SkillFsOptions,
  input: CreateManagedSkill,
  aclOpts?: { ownerUserId?: string },
): Promise<Skill> {
  // Fast-path name check (already-ready skills). The real guard against a racing
  // same-name create is the reserve INSERT's unique(name) below — it rejects the
  // loser BEFORE any files are written (RFC-170 §9: no more "both see name free →
  // loser clobbers winner's live").
  if ((await getSkill(db, input.name)) !== null) {
    throw new ConflictError('skill-name-in-use', `skill '${input.name}' already exists`)
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
          name: input.name,
          description: input.description,
          sourceKind: 'managed',
          managedPath: `skills/${input.name}/files`,
          externalPath: null,
          // RFC-099: creator becomes owner; new resources default to 'public' (D18).
          ownerUserId: aclOpts?.ownerUserId ?? null,
          visibility: 'public',
          reservationState: 'reserving',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      return beginOperation(tx, {
        skillId: id,
        kind: 'reserve',
        ownerUserId: aclOpts?.ownerUserId ?? undefined,
        preconditionJson: JSON.stringify({ name: input.name }),
      })
    })
  } catch (err) {
    if (/UNIQUE constraint failed:? *skills\.name/i.test(err instanceof Error ? err.message : '')) {
      throw new ConflictError('skill-name-in-use', `skill '${input.name}' already exists`)
    }
    throw err
  }

  const skillDir = join(opts.appHome, 'skills', input.name)
  try {
    // ② fs-staged: write SKILL.md into the (still-invisible) files dir.
    const filesDir = join(skillDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    const skillMd = stringifyFrontmatter({
      data: { name: input.name, description: input.description, ...input.frontmatterExtra },
      body: input.bodyMd,
    })
    writeFileSync(join(filesDir, 'SKILL.md'), skillMd, 'utf-8')
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))

    // ③ fs-published: archive the tree as v1 + atomically publish (RFC-101/170).
    // skipOp: reserve already holds this skill's op lock — commitSkillVersion must
    // NOT open its own version-write op (it would self-conflict on the same lock).
    commitSkillVersion(db, opts, input.name, () => {}, {
      source: 'initial',
      authorUserId: aclOpts?.ownerUserId ?? null,
      skipOp: true,
    })
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-published'))

    // ④ db-committed: flip to 'ready' — the skill becomes visible now, atomically.
    dbTxSync(db, (tx) => {
      tx.update(skills).set({ reservationState: 'ready' }).where(eq(skills.id, id)).run()
      advancePhase(tx, opId, 'db-committed')
    })
    dbTxSync(db, (tx) => finishOperation(tx, opId))
  } catch (err) {
    // Roll back (in-process): discard the reserving row + files + retire the op.
    // (A crash — not an in-process throw — is recovered at boot by the reserve
    // recovery handler, which does the same.)
    rmSync(skillDir, { recursive: true, force: true })
    dbTxSync(db, (tx) => {
      tx.delete(skills).where(eq(skills.id, id)).run()
      abandonOperation(tx, opId)
    })
    throw err
  }

  const created = await getSkill(db, input.name)
  if (created === null) throw new Error('skill disappeared right after reserve')
  return created
}

export async function importExternalSkill(
  db: DbClient,
  input: ImportExternalSkill,
  aclOpts?: { ownerUserId?: string },
): Promise<Skill> {
  if (!existsSync(input.externalPath)) {
    throw new ValidationError(
      'skill-external-path-missing',
      `external path does not exist: ${input.externalPath}`,
    )
  }
  if (!statSync(input.externalPath).isDirectory()) {
    throw new ValidationError(
      'skill-external-path-not-dir',
      `external path is not a directory: ${input.externalPath}`,
    )
  }
  if ((await getSkill(db, input.name)) !== null) {
    throw new ConflictError('skill-name-in-use', `skill '${input.name}' already exists`)
  }

  const id = ulid()
  const now = Date.now()
  await db.insert(skills).values({
    id,
    name: input.name,
    description: input.description,
    sourceKind: 'external',
    // RFC-170 (G3-7/G5-5, Codex F1): a hand-imported external skill is
    // `hand-external` authority — WITHOUT this it defaults to 'managed' and the
    // §8 owner-transfer block, metadata read-only guard, and FE capability gating
    // are all bypassed. The importer is the content controller (`externalPath` is
    // theirs), so record it in `authorityOwnerUserId` (design §10: only a NEW
    // import can reliably prove the content controller = the actor).
    authorityKind: 'hand-external',
    authorityOwnerUserId: aclOpts?.ownerUserId ?? null,
    managedPath: null,
    externalPath: input.externalPath,
    // RFC-099: creator becomes owner; new resources default to 'public' (D18).
    ownerUserId: aclOpts?.ownerUserId ?? null,
    visibility: 'public',
    createdAt: now,
    updatedAt: now,
  })

  const created = await getSkill(db, input.name)
  if (created === null) throw new Error('skill disappeared right after insert')
  return created
}

// --- update / delete ---

export async function updateSkill(db: DbClient, name: string, patch: UpdateSkill): Promise<Skill> {
  const existing = await getSkill(db, name)
  if (existing === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  // A patch with no description is a no-op — nothing to write or fence.
  if (patch.description === undefined) return existing

  // RFC-170 §8 (Codex F2): the guard + write must be ONE transaction keyed on the
  // IMMUTABLE skill id, not a name-based read-then-write. Otherwise a same-name
  // delete→recreate between the check and the UPDATE lets a request authorized
  // against a managed/hand-external row modify a freshly-created source-external
  // row. And every metadata write MUST advance `meta_revision` so the composite
  // precondition token actually drifts on a description change (else the T3/T4/T6
  // token OCC is blind to metadata edits).
  const description = patch.description
  dbTxSync(db, (tx) => {
    // Re-read the authority by immutable id INSIDE the tx.
    const cur = tx
      .select({ authorityKind: skills.authorityKind })
      .from(skills)
      .where(eq(skills.id, existing.id))
      .get()
    if (!cur) throw new ConflictError('skill-changed', `skill '${name}' changed; reload and retry`)
    // §8 (G3-2): a source-external skill's metadata is owned by its registered
    // source dir (SKILL.md is authoritative) — a direct write would be clobbered
    // on the next reconcile, so reject it. hand-external + managed are writable.
    if (cur.authorityKind === 'source-external') {
      throw new ForbiddenError(
        'skill-source-external-metadata-readonly',
        "a source-external skill's description is owned by its source directory; edit it there",
      )
    }
    tx.update(skills)
      .set({
        description,
        metaRevision: sql`${skills.metaRevision} + 1`, // fence the token on every meta write
        updatedAt: Date.now(),
      })
      .where(eq(skills.id, existing.id))
      .run()
  })
  const updated = await getSkill(db, name)
  if (updated === null) throw new Error('skill disappeared after update')
  return updated
}

export async function deleteSkill(db: DbClient, opts: SkillFsOptions, name: string): Promise<void> {
  const existing = await getSkill(db, name)
  if (existing === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)

  const refs = await findAgentsUsingSkill(db, name)
  if (refs.length > 0) {
    throw new ConflictError('skill-in-use', `skill '${name}' is referenced by agents`, {
      agents: refs,
    })
  }

  if (existing.sourceKind === 'managed') {
    // RFC-170 §6a: crash-safe op-based delete — rename the whole root to trash,
    // DELETE the row in the same tx as the phase advance, then drop the trash.
    // A crash between steps is recovered by the boot driver (deleteRecoveryHandler).
    const { deleteManagedSkillOp } = await import('@/services/skillDeleteOp')
    deleteManagedSkillOp(db, { appHome: opts.appHome }, { id: existing.id, name: existing.name })
  } else {
    // External: no managed directory — a single DB row drop is already atomic.
    await removeSkillRowAndFiles(db, opts, existing)
  }
}

/**
 * RFC-102: drop a skill's DB row plus (for managed skills) its files directory.
 * NO agent-reference check — callers that must preserve referential integrity
 * (deleteSkill) check first; the source-conflict replace path intentionally
 * skips it because the skill name is preserved across the replace, so agent
 * references stay valid.
 */
export async function removeSkillRowAndFiles(
  db: DbClient,
  opts: SkillFsOptions,
  skill: Skill,
): Promise<void> {
  // Managed: delete the directory. External: just drop the DB row.
  if (skill.sourceKind === 'managed') {
    const dir = join(opts.appHome, 'skills', skill.name)
    rmSync(dir, { recursive: true, force: true })
  }
  await db.delete(skills).where(eq(skills.name, skill.name))
}

async function findAgentsUsingSkill(
  db: DbClient,
  skillName: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, skills: agents.skills })
    .from(agents)
  const out: Array<{ id: string; name: string }> = []
  for (const row of rows) {
    try {
      const skillsArr = JSON.parse(row.skills) as string[]
      if (skillsArr.includes(skillName)) out.push({ id: row.id, name: row.name })
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
  name: string,
): Promise<SkillContent> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  const root = skillRoot(skill, opts)
  const skillMdPath = join(root, 'SKILL.md')
  if (!existsSync(skillMdPath)) {
    throw new NotFoundError('skill-md-missing', `SKILL.md not found at ${skillMdPath}`)
  }
  // RFC-170 G3-1 (security): SKILL.md may be a symlink in an external skill dir;
  // contain it so a `SKILL.md -> ~/.ssh/id_rsa` link can't leak host files to a
  // shared skill's readers (same fix as readSkillFile).
  const raw = readFileSync(realpathInside(root, skillMdPath), 'utf-8')
  const parsed = parseFrontmatter(raw)
  const { name: _ignoredName, description: descRaw, ...rest } = parsed.data
  // RFC-170 §2/T3: emit the opaque composite precondition token so the client can
  // echo it on the eventual combined-save (T4) for OCC. metaRevision is read from
  // the row (not on the Skill DTO); defaults to 0 for legacy rows.
  const metaRow = await db
    .select({ metaRevision: skills.metaRevision })
    .from(skills)
    .where(eq(skills.id, skill.id))
    .limit(1)
  const { encodeSkillToken } = await import('@/services/skillToken')
  const token = encodeSkillToken({
    skillId: skill.id,
    contentVersion: skill.contentVersion,
    metaRevision: metaRow[0]?.metaRevision ?? 0,
  })
  return {
    name: skill.name,
    description: typeof descRaw === 'string' ? descRaw : skill.description,
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

export async function writeSkillContent(
  db: DbClient,
  opts: SkillFsOptions,
  name: string,
  patch: UpdateSkillContent,
  authorUserId?: string | null,
): Promise<SkillContent> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  ensureSkillIsWritable(skill)
  const current = await readSkillContent(db, opts, name).catch(() => ({
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
    name,
    (staging) => {
      writeFileSync(join(staging, 'SKILL.md'), md, 'utf-8')
    },
    {
      source: 'editor',
      authorUserId: authorUserId ?? null,
      setDescription: patch.description !== undefined ? patch.description : undefined,
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
  name: string,
  patch: UpdateSkillContent,
  expectedToken: string,
  authorUserId?: string | null,
): Promise<SkillContent> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  ensureSkillIsWritable(skill)
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
      `skill '${name}' changed since you loaded it; reload and retry`,
    )
  }
  await writeSkillContent(db, opts, name, patch, authorUserId)
  // Re-read so the response carries the FRESH token (writeSkillContent's return
  // omits it) — the client reuses it for the next save without a reload.
  return readSkillContent(db, opts, name)
}

// --- file tree ---

export async function listSkillFiles(
  db: DbClient,
  opts: SkillFsOptions,
  name: string,
): Promise<FileNode[]> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  const root = skillRoot(skill, opts)
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
  name: string,
  relPath: string,
): Promise<string> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  const root = skillRoot(skill, opts)
  const abs = safeJoin(root, relPath)
  if (!existsSync(abs)) {
    throw new NotFoundError(
      'skill-file-not-found',
      `file '${relPath}' not found in skill '${name}'`,
    )
  }
  // RFC-170 G3-1 (security): safeJoin does NOT resolve symlinks, but readFileSync
  // follows them — an external skill dir can hold a symlink pointing outside root
  // (e.g. `secret -> ~/.ssh/id_rsa`), so a SHARED skill would leak host files to
  // any authorized/public reader. realpathInside resolves + verifies containment,
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
  name: string,
  relPath: string,
  content: string,
  authorUserId?: string | null,
): Promise<void> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  ensureSkillIsWritable(skill)
  // RFC-169: SKILL.md is edited exclusively through PUT /content — the file tree
  // must never write it via an arbitrary path (before RFC-169 there was NO
  // check, so adding a file named `SKILL.md` / `./SKILL.md` truncated it).
  assertNotSkillMainFile(skillRoot(skill, opts), relPath)
  // RFC-101: support-file writes version the whole files/ tree too.
  commitSkillVersion(
    db,
    opts,
    name,
    (staging) => {
      const abs = safeJoin(staging, relPath)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf-8')
    },
    { source: 'editor', authorUserId: authorUserId ?? null },
  )
}

export async function deleteSkillFile(
  db: DbClient,
  opts: SkillFsOptions,
  name: string,
  relPath: string,
  authorUserId?: string | null,
): Promise<void> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  ensureSkillIsWritable(skill)
  const root = skillRoot(skill, opts)
  // RFC-169: SKILL.md is special — refuse to delete it (users edit via /content).
  // The pre-RFC-169 raw `=== 'SKILL.md'` compare was bypassable via `./SKILL.md`,
  // a trailing separator, or a case variant on a case-insensitive filesystem.
  assertNotSkillMainFile(root, relPath)
  if (!existsSync(safeJoin(root, relPath))) {
    throw new NotFoundError(
      'skill-file-not-found',
      `file '${relPath}' not found in skill '${name}'`,
    )
  }
  // RFC-101: deletion versions the tree (the removal IS the change).
  commitSkillVersion(
    db,
    opts,
    name,
    (staging) => {
      const abs = safeJoin(staging, relPath)
      if (!existsSync(abs)) return
      if (statSync(abs).isDirectory()) rmSync(abs, { recursive: true })
      else unlinkSync(abs)
    },
    { source: 'editor', authorUserId: authorUserId ?? null },
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
    sourceKind: row.sourceKind as 'managed' | 'external',
    // RFC-170 (G5-P2) — stable authority discriminator drives the FE capability
    // table (edit-description / delete / transfer-owner). Backfilled for all rows.
    authorityKind: row.authorityKind,
    schemaVersion: row.schemaVersion,
    contentVersion: row.contentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.managedPath !== null) out.managedPath = row.managedPath
  if (row.externalPath !== null) out.externalPath = row.externalPath
  if (row.sourceId !== null) out.sourceId = row.sourceId
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
 * Symlink edge cases that need a pre-planted link to reproduce are RFC-170.
 */
function assertNotSkillMainFile(root: string, relPath: string): void {
  if (isProtectedSkillMainFile(relPath) || resolvesToSkillMainFile(root, relPath)) {
    throw new ConflictError(
      'skill-md-protected',
      'cannot write or delete SKILL.md; edit content via PUT /api/skills/:name/content',
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

/**
 * RFC-017: enforce "external folders are read-only from the platform"
 * uniformly. Hand-imported `sourceKind='external'` rows keep the original
 * `skill-external-readonly` code; rows imported by a registered
 * skill_sources row carry `sourceId != null` and surface
 * `skill-source-readonly` so the UI can render a precise "edit in the source
 * directory" hint.
 */
function ensureSkillIsWritable(skill: Skill): void {
  if (skill.sourceKind !== 'external') return
  if (skill.sourceId !== undefined) {
    throw new ConflictError(
      'skill-source-readonly',
      `skill '${skill.name}' is managed by a folder source; edit files in the source directory`,
    )
  }
  throw new ConflictError(
    'skill-external-readonly',
    `skill '${skill.name}' is external; edit on disk instead`,
  )
}
