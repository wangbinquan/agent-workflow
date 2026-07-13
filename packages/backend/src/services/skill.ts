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
import { eq } from 'drizzle-orm'
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
import { parseFrontmatter, stringifyFrontmatter } from '@/util/frontmatter'
import { realpathInside, safeJoin } from '@/util/safePath'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

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
  const rows = await db.select().from(skills)
  return rows.map(rowToSkill)
}

export async function getSkill(db: DbClient, name: string): Promise<Skill | null> {
  const rows = await db.select().from(skills).where(eq(skills.name, name)).limit(1)
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
  if ((await getSkill(db, input.name)) !== null) {
    throw new ConflictError('skill-name-in-use', `skill '${input.name}' already exists`)
  }

  // Write SKILL.md to disk first; if anything fails we don't leave a DB row.
  const filesDir = join(opts.appHome, 'skills', input.name, 'files')
  mkdirSync(filesDir, { recursive: true })

  const skillMd = stringifyFrontmatter({
    data: { name: input.name, description: input.description, ...input.frontmatterExtra },
    body: input.bodyMd,
  })
  writeFileSync(join(filesDir, 'SKILL.md'), skillMd, 'utf-8')

  const id = ulid()
  const now = Date.now()
  await db.insert(skills).values({
    id,
    name: input.name,
    description: input.description,
    sourceKind: 'managed',
    managedPath: `skills/${input.name}/files`,
    externalPath: null,
    // RFC-099: creator becomes owner; new resources default to 'public' (D18).
    ownerUserId: aclOpts?.ownerUserId ?? null,
    visibility: 'public',
    createdAt: now,
    updatedAt: now,
  })

  // RFC-101: archive the freshly-written files/ as v1. produce is a no-op —
  // SKILL.md is already on disk; commitSkillVersion snapshots it + records the
  // skill_versions(v1) row. On failure, unwind the half-created skill so we
  // never leave a row without a v1 (mirrors the original fail-safe intent).
  try {
    commitSkillVersion(db, opts, input.name, () => {}, {
      source: 'initial',
      authorUserId: aclOpts?.ownerUserId ?? null,
    })
  } catch (err) {
    await db.delete(skills).where(eq(skills.name, input.name))
    rmSync(join(opts.appHome, 'skills', input.name), { recursive: true, force: true })
    throw err
  }

  const created = await getSkill(db, input.name)
  if (created === null) throw new Error('skill disappeared right after insert')
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
  const set: Partial<typeof skills.$inferInsert> = { updatedAt: Date.now() }
  if (patch.description !== undefined) set.description = patch.description
  await db.update(skills).set(set).where(eq(skills.name, name))
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

  await removeSkillRowAndFiles(db, opts, existing)
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
  return {
    name: skill.name,
    description: typeof descRaw === 'string' ? descRaw : skill.description,
    bodyMd: parsed.body,
    frontmatterExtra: rest,
  }
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
