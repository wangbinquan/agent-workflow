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
import { eq } from 'drizzle-orm'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, skills } from '@/db/schema'
import { parseFrontmatter, stringifyFrontmatter } from '@/util/frontmatter'
import { safeJoin } from '@/util/safePath'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'

type SkillRow = typeof skills.$inferSelect

export interface SkillFsOptions {
  /** App home dir; managed skills live under `${appHome}/skills/{name}/files/`. */
  appHome: string
}

// --- query helpers ---

export async function listSkills(db: DbClient): Promise<Skill[]> {
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
    createdAt: now,
    updatedAt: now,
  })

  const created = await getSkill(db, input.name)
  if (created === null) throw new Error('skill disappeared right after insert')
  return created
}

export async function importExternalSkill(
  db: DbClient,
  input: ImportExternalSkill,
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

export async function deleteSkill(
  db: DbClient,
  opts: SkillFsOptions,
  name: string,
): Promise<void> {
  const existing = await getSkill(db, name)
  if (existing === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)

  const refs = await findAgentsUsingSkill(db, name)
  if (refs.length > 0) {
    throw new ConflictError('skill-in-use', `skill '${name}' is referenced by agents`, {
      agents: refs,
    })
  }

  // Managed: delete the directory. External: just drop the DB row.
  if (existing.sourceKind === 'managed') {
    const dir = join(opts.appHome, 'skills', name)
    rmSync(dir, { recursive: true, force: true })
  }
  await db.delete(skills).where(eq(skills.name, name))
}

async function findAgentsUsingSkill(
  db: DbClient,
  skillName: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db.select({ id: agents.id, name: agents.name, skills: agents.skills }).from(agents)
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
  const raw = readFileSync(skillMdPath, 'utf-8')
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
): Promise<SkillContent> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  if (skill.sourceKind === 'external') {
    throw new ConflictError(
      'skill-external-readonly',
      `skill '${name}' is external; edit on disk instead`,
    )
  }
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

  const root = skillRoot(skill, opts)
  mkdirSync(root, { recursive: true })
  const md = stringifyFrontmatter({
    data: { name: next.name, description: next.description, ...next.frontmatterExtra },
    body: next.bodyMd,
  })
  writeFileSync(join(root, 'SKILL.md'), md, 'utf-8')

  // Keep the DB description in sync with SKILL.md.
  if (patch.description !== undefined) {
    await db
      .update(skills)
      .set({ description: patch.description, updatedAt: Date.now() })
      .where(eq(skills.name, name))
  }

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
    throw new NotFoundError('skill-file-not-found', `file '${relPath}' not found in skill '${name}'`)
  }
  if (statSync(abs).isDirectory()) {
    throw new ValidationError('skill-file-is-dir', `'${relPath}' is a directory`)
  }
  return readFileSync(abs, 'utf-8')
}

export async function writeSkillFile(
  db: DbClient,
  opts: SkillFsOptions,
  name: string,
  relPath: string,
  content: string,
): Promise<void> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  if (skill.sourceKind === 'external') {
    throw new ConflictError(
      'skill-external-readonly',
      `skill '${name}' is external; edit on disk instead`,
    )
  }
  const root = skillRoot(skill, opts)
  const abs = safeJoin(root, relPath)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf-8')

  // Touch DB updatedAt.
  await db.update(skills).set({ updatedAt: Date.now() }).where(eq(skills.name, name))
}

export async function deleteSkillFile(
  db: DbClient,
  opts: SkillFsOptions,
  name: string,
  relPath: string,
): Promise<void> {
  const skill = await getSkill(db, name)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  if (skill.sourceKind === 'external') {
    throw new ConflictError(
      'skill-external-readonly',
      `skill '${name}' is external; edit on disk instead`,
    )
  }
  // SKILL.md is special — refuse to delete it; users edit via /content endpoint.
  if (normalizeSlash(relPath) === 'SKILL.md') {
    throw new ConflictError(
      'skill-md-protected',
      'cannot delete SKILL.md; edit content via PUT /api/skills/:name/content',
    )
  }
  const root = skillRoot(skill, opts)
  const abs = safeJoin(root, relPath)
  if (!existsSync(abs)) {
    throw new NotFoundError('skill-file-not-found', `file '${relPath}' not found in skill '${name}'`)
  }
  const st = statSync(abs)
  if (st.isDirectory()) {
    rmSync(abs, { recursive: true })
  } else {
    unlinkSync(abs)
  }

  await db.update(skills).set({ updatedAt: Date.now() }).where(eq(skills.name, name))
}

// --- helpers ---

function rowToSkill(row: SkillRow): Skill {
  const out: Skill = {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceKind: row.sourceKind as 'managed' | 'external',
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.managedPath !== null) out.managedPath = row.managedPath
  if (row.externalPath !== null) out.externalPath = row.externalPath
  return out
}

function normalizeSlash(p: string): string {
  return p.split(sep).join('/')
}
