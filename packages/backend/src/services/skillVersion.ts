// RFC-101 — skill content versioning + history (PR-A foundation).
//
// THE single funnel for writing a managed skill's files/. Every write path
// (createManagedSkill / writeSkillContent / writeSkillFile / deleteSkillFile,
// and PR-B fusion apply / restore) routes through commitSkillVersion, which:
//   1. archives the new files/ tree as an immutable snapshot under
//      skills/{name}/versions/v{n}/files,
//   2. bumps skills.content_version + inserts a skill_versions row (one tx),
//   3. syncs live files/ from the snapshot.
//
// Module-cycle discipline (RFC-079): this file queries the `skills` table
// DIRECTLY and never imports services/skill.ts. skill.ts imports THIS — one
// direction only.

import type {
  FileNode,
  SkillContent,
  SkillVersion,
  SkillVersionContent,
  SkillVersionDiff,
  SkillVersionSource,
} from '@agent-workflow/shared'
import { structuredPatch } from 'diff'
import { eq } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { skills, skillVersions } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { realpathInside } from '@/util/safePath'
import { cleanupOpDirs, opStagedDir, swapInStaged } from '@/services/skillFsPublish'
import { unfuseMemoriesTx } from '@/services/memory'
import { ConflictError, NotFoundError } from '@/util/errors'
import { parseFrontmatter } from '@/util/frontmatter'

export interface SkillVersionFsOptions {
  /** App home dir; managed skills live under `${appHome}/skills/{name}/...`. */
  appHome: string
}

type SkillRow = typeof skills.$inferSelect
type SkillVersionRow = typeof skillVersions.$inferSelect

// --- path helpers ----------------------------------------------------------

function skillFilesDir(appHome: string, name: string): string {
  return join(appHome, 'skills', name, 'files')
}
function skillVersionsRoot(appHome: string, name: string): string {
  return join(appHome, 'skills', name, 'versions')
}
function skillVersionDirAbs(appHome: string, name: string, v: number): string {
  return join(skillVersionsRoot(appHome, name), `v${v}`, 'files')
}
/** App-home-relative, forward-slash path stored in skill_versions.files_path. */
export function skillVersionRelPath(name: string, v: number): string {
  return `skills/${name}/versions/v${v}/files`
}

// --- pure helpers (unit-tested) --------------------------------------------

/**
 * Given the fused memories of a skill and a restore target version N, return
 * the ids of memories that must be UN-fused because the restored content (=
 * version N) predates their absorption. Invariant: fused ⟺ knowledge is in the
 * current version, so memories fused at a version > N no longer apply.
 * Pure; used by restore (RFC-101 PR-B wires the actual status flip).
 */
export function memoriesToUnfuseOnRestore(
  fused: ReadonlyArray<{ id: string; fusedIntoSkillVersion: number | null }>,
  targetVersion: number,
): string[] {
  return fused
    .filter((m) => m.fusedIntoSkillVersion !== null && m.fusedIntoSkillVersion > targetVersion)
    .map((m) => m.id)
}

const NUL = '\x00'

/**
 * Deterministic sha256 of a files/ tree: sorted relpath + bytes. Binary-safe
 * (hashes raw Buffer). Missing dir hashes to the empty digest.
 */
export function hashDir(dir: string): string {
  const h = createHash('sha256')
  if (!existsSync(dir)) return h.digest('hex')
  const rels: string[] = []
  collectFiles(dir, '', rels)
  rels.sort()
  for (const rel of rels) {
    h.update(rel)
    h.update(NUL)
    h.update(readFileSync(join(dir, rel)))
    h.update(NUL)
  }
  return h.digest('hex')
}

function collectFiles(absRoot: string, relRoot: string, out: string[]): void {
  const entries = readdirSync(join(absRoot, relRoot), { withFileTypes: true })
  for (const entry of entries) {
    const childRel = relRoot ? `${relRoot}/${entry.name}` : entry.name
    if (entry.isDirectory()) collectFiles(absRoot, childRel, out)
    else if (entry.isFile()) out.push(childRel)
    // symlinks intentionally skipped (parity with skill.ts walkDir)
  }
}

/** A file in a version snapshot: utf-8 text, or a binary file keyed by hash. */
export type TreeEntry = { kind: 'text'; content: string } | { kind: 'binary'; hash: string }

/** Read a files/ tree into a path→entry map (binary detected by NUL byte). */
function readTree(dir: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>()
  if (!existsSync(dir)) return out
  const rels: string[] = []
  collectFiles(dir, '', rels)
  for (const rel of rels) {
    const buf = readFileSync(join(dir, rel))
    out.set(
      rel,
      buf.includes(0)
        ? { kind: 'binary', hash: createHash('sha256').update(buf).digest('hex') }
        : { kind: 'text', content: buf.toString('utf-8') },
    )
  }
  return out
}

function sameEntry(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (a.kind === 'text' && b.kind === 'text') return a.content === b.content
  if (a.kind === 'binary' && b.kind === 'binary') return a.hash === b.hash
  return false // text↔binary kind flip is a change
}

/**
 * Pure git-style unified diff between two files/ trees. Emits
 * `diff --git a/<p> b/<p>` blocks so the frontend DiffViewer (splitByFile)
 * renders it like any worktree diff. Binary changes are noted, not shown.
 */
export function gitStyleDirDiff(a: Map<string, TreeEntry>, b: Map<string, TreeEntry>): string {
  const paths = Array.from(new Set([...a.keys(), ...b.keys()])).sort()
  const blocks: string[] = []
  for (const p of paths) {
    const av = a.get(p)
    const bv = b.get(p)
    if (av === undefined && bv === undefined) continue
    if (sameEntry(av, bv)) continue
    const header = `diff --git a/${p} b/${p}`
    if ((av && av.kind === 'binary') || (bv && bv.kind === 'binary')) {
      blocks.push(`${header}\nBinary files a/${p} and b/${p} differ`)
      continue
    }
    const oldStr = av && av.kind === 'text' ? av.content : ''
    const newStr = bv && bv.kind === 'text' ? bv.content : ''
    const oldName = av === undefined ? '/dev/null' : `a/${p}`
    const newName = bv === undefined ? '/dev/null' : `b/${p}`
    const patch = structuredPatch(p, p, oldStr, newStr, '', '', { context: 3 })
    const lines: string[] = [header, `--- ${oldName}`, `+++ ${newName}`]
    for (const hunk of patch.hunks) {
      lines.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      )
    }
    blocks.push(lines.join('\n'))
  }
  return blocks.join('\n')
}

// --- db helpers ------------------------------------------------------------

function loadSkillRow(db: DbClient, name: string): SkillRow | null {
  const rows = db.select().from(skills).where(eq(skills.name, name)).all() as SkillRow[]
  return rows[0] ?? null
}

function versionRows(db: DbClient, name: string): SkillVersionRow[] {
  return db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillName, name))
    .all() as SkillVersionRow[]
}

function rowToSkillVersion(row: SkillVersionRow): SkillVersion {
  return {
    id: row.id,
    skillName: row.skillName,
    versionIndex: row.versionIndex,
    source: row.source as SkillVersionSource,
    summary: row.summary,
    fusionId: row.fusionId,
    restoredFromVersion: row.restoredFromVersion,
    authorUserId: row.authorUserId,
    contentHash: row.contentHash,
    createdAt: row.createdAt,
  }
}

// --- backfill --------------------------------------------------------------

/**
 * Lazily snapshot a managed skill's CURRENT files/ as v1 when it has no
 * skill_versions rows yet (legacy skill created before this RFC). Idempotent;
 * called at the top of every version-funnel access. No-op for non-managed
 * skills or skills whose files/ has no SKILL.md (e.g. mid-create).
 */
export function ensureInitialSkillVersion(
  db: DbClient,
  opts: SkillVersionFsOptions,
  name: string,
): void {
  const skill = loadSkillRow(db, name)
  if (!skill || skill.sourceKind !== 'managed') return
  if (versionRows(db, name).length > 0) return
  const filesDir = skillFilesDir(opts.appHome, name)
  if (!existsSync(join(filesDir, 'SKILL.md'))) return
  const versionDir = skillVersionDirAbs(opts.appHome, name, 1)
  rmSync(versionDir, { recursive: true, force: true })
  mkdirSync(dirname(versionDir), { recursive: true })
  cpSync(filesDir, versionDir, { recursive: true })
  const hash = hashDir(versionDir)
  const now = Date.now()
  dbTxSync(db, (tx) => {
    tx.update(skills).set({ contentVersion: 1, updatedAt: now }).where(eq(skills.name, name)).run()
    tx.insert(skillVersions)
      .values({
        id: ulid(),
        skillName: name,
        versionIndex: 1,
        filesPath: skillVersionRelPath(name, 1),
        source: 'initial',
        summary: null,
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: '__system__',
        contentHash: hash,
        createdAt: now,
      })
      .run()
    return null
  })
}

// --- the funnel ------------------------------------------------------------

export interface SkillVersionCommitOpts {
  source: SkillVersionSource
  authorUserId: string | null
  summary?: string | null
  fusionId?: string | null
  restoredFromVersion?: number | null
  /** OCC: throw skill-version-conflict if current content_version != this. */
  expectedVersion?: number
  /** Fold a description change into the same tx (keeps DB ↔ SKILL.md in sync). */
  setDescription?: string
  /**
   * RFC-101 PR-B hook: run extra writes (e.g. fuse memories) inside the SAME
   * transaction as the version bump, given the new version number.
   */
  txExtra?: (tx: Parameters<Parameters<DbClient['transaction']>[0]>[0], newVersion: number) => void
}

/**
 * Archive the produced files/ tree as the next version of a managed skill.
 * `produce(stagingDir)` receives a copy of the current files/ pre-seeded and
 * mutates it in place (editor delta) or fully replaces it (fusion / restore).
 * Returns the new (or, on an empty editor write, the unchanged latest) version.
 */
export function commitSkillVersion(
  db: DbClient,
  opts: SkillVersionFsOptions,
  name: string,
  produce: (stagingDir: string) => void,
  commit: SkillVersionCommitOpts,
): SkillVersion {
  const skill = loadSkillRow(db, name)
  if (!skill) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  if (skill.sourceKind !== 'managed') {
    throw new ConflictError('skill-not-managed', `skill '${name}' is not managed; cannot version`)
  }

  if (commit.source !== 'initial') ensureInitialSkillVersion(db, opts, name)

  const cur = loadSkillRow(db, name)
  if (!cur) throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  const existing = versionRows(db, name)
  const maxIndex = existing.reduce((m, r) => Math.max(m, r.versionIndex), 0)
  const N = cur.contentVersion

  if (commit.expectedVersion !== undefined && commit.expectedVersion !== N) {
    throw new ConflictError(
      'skill-version-conflict',
      `skill '${name}' is at version ${N}, expected ${commit.expectedVersion}; reload and retry`,
    )
  }

  const newVersion = maxIndex === 0 ? 1 : maxIndex + 1
  const filesDir = skillFilesDir(opts.appHome, name)
  // RFC-170 §6a/§13: build into an op-scoped staged dir so the live publish can be
  // an ATOMIC rename-swap (swapInStaged) instead of the old rmSync+cpSync (which
  // left a window where files/ was missing/partial on crash). publishId scopes the
  // staged/backup sibling names collision-free.
  const publishId = ulid()
  const staging = opStagedDir(filesDir, publishId)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  if (existsSync(filesDir)) cpSync(filesDir, staging, { recursive: true })
  produce(staging)

  const newHash = hashDir(staging)
  // Empty-write short-circuit: an editor Save with no real change must not
  // inflate the history. (Initial / fusion / restore always commit.)
  if (commit.source === 'editor' && maxIndex > 0 && newHash === hashDir(filesDir)) {
    rmSync(staging, { recursive: true, force: true })
    const latest = existing.find((r) => r.versionIndex === maxIndex)
    if (latest) return rowToSkillVersion(latest)
  }

  const versionDir = skillVersionDirAbs(opts.appHome, name, newVersion)
  rmSync(versionDir, { recursive: true, force: true })
  mkdirSync(dirname(versionDir), { recursive: true })
  cpSync(staging, versionDir, { recursive: true })

  const id = ulid()
  const now = Date.now()
  const created = dbTxSync(db, (tx) => {
    const skillSet: Partial<typeof skills.$inferInsert> = {
      contentVersion: newVersion,
      updatedAt: now,
    }
    if (commit.setDescription !== undefined) skillSet.description = commit.setDescription
    tx.update(skills).set(skillSet).where(eq(skills.name, name)).run()
    tx.insert(skillVersions)
      .values({
        id,
        skillName: name,
        versionIndex: newVersion,
        filesPath: skillVersionRelPath(name, newVersion),
        source: commit.source,
        summary: commit.summary ?? null,
        fusionId: commit.fusionId ?? null,
        restoredFromVersion: commit.restoredFromVersion ?? null,
        authorUserId: commit.authorUserId,
        contentHash: newHash,
        createdAt: now,
      })
      .run()
    commit.txExtra?.(tx, newVersion)
    return (
      tx.select().from(skillVersions).where(eq(skillVersions.id, id)).all() as SkillVersionRow[]
    )[0]
  })

  // Publish live files/ from the staged snapshot LAST, ATOMICALLY (RFC-170
  // §6a/§13): swapInStaged moves the current live aside to an op-scoped backup
  // then renames staged → files (two same-parent renames, each atomic), so files/
  // is never observed missing/partial — the old rmSync+cpSync window is gone.
  // A crash between the two renames still leaves a complete tree (old or new);
  // reconcileSkillLiveFiles() (startup) remains the backstop that re-syncs from
  // versions/v{cur} if needed.
  mkdirSync(dirname(filesDir), { recursive: true })
  swapInStaged(filesDir, publishId)
  cleanupOpDirs(filesDir, publishId)

  if (!created) throw new Error('skill_versions row disappeared after insert')
  return rowToSkillVersion(created)
}

// --- read / history --------------------------------------------------------

export function listSkillVersions(
  db: DbClient,
  opts: SkillVersionFsOptions,
  name: string,
): SkillVersion[] {
  if (loadSkillRow(db, name) === null) {
    throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  }
  ensureInitialSkillVersion(db, opts, name)
  return versionRows(db, name)
    .sort((x, y) => y.versionIndex - x.versionIndex)
    .map(rowToSkillVersion)
}

function requireVersionRow(db: DbClient, name: string, v: number): SkillVersionRow {
  const row = versionRows(db, name).find((r) => r.versionIndex === v)
  if (!row) {
    throw new NotFoundError('skill-version-not-found', `skill '${name}' has no version ${v}`)
  }
  return row
}

function fileTreeOf(absRoot: string): FileNode[] {
  if (!existsSync(absRoot)) return []
  const out: FileNode[] = []
  const rels: string[] = []
  // Reuse collectFiles to enumerate files; add dir nodes by inference.
  const seenDirs = new Set<string>()
  collectFiles(absRoot, '', rels)
  rels.sort()
  for (const rel of rels) {
    const parts = rel.split('/')
    let acc = ''
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string)
      if (!seenDirs.has(acc)) {
        seenDirs.add(acc)
        out.push({ path: acc, type: 'dir' })
      }
    }
    const st = statSync(join(absRoot, rel))
    out.push({ path: rel, type: 'file', size: st.size, modifiedAt: Math.floor(st.mtimeMs) })
  }
  return out
}

export function getSkillVersionContent(
  db: DbClient,
  opts: SkillVersionFsOptions,
  name: string,
  v: number,
): SkillVersionContent {
  if (loadSkillRow(db, name) === null) {
    throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  }
  ensureInitialSkillVersion(db, opts, name)
  requireVersionRow(db, name, v)
  const versionDir = skillVersionDirAbs(opts.appHome, name, v)
  const skillMdPath = join(versionDir, 'SKILL.md')
  let content: SkillContent
  if (existsSync(skillMdPath)) {
    // RFC-170 G3-1 (security): a historical SKILL.md may be a symlink escaping the
    // version dir; contain it so `/versions/:v/content` can't leak host files.
    const parsed = parseFrontmatter(readFileSync(realpathInside(versionDir, skillMdPath), 'utf-8'))
    const { name: _n, description: descRaw, ...rest } = parsed.data
    content = {
      name,
      description: typeof descRaw === 'string' ? descRaw : '',
      bodyMd: parsed.body,
      frontmatterExtra: rest,
    }
  } else {
    content = { name, description: '', bodyMd: '', frontmatterExtra: {} }
  }
  return { versionIndex: v, content, files: fileTreeOf(versionDir) }
}

export function diffSkillVersions(
  db: DbClient,
  opts: SkillVersionFsOptions,
  name: string,
  from: number,
  to: number,
): SkillVersionDiff {
  if (loadSkillRow(db, name) === null) {
    throw new NotFoundError('skill-not-found', `skill '${name}' not found`)
  }
  ensureInitialSkillVersion(db, opts, name)
  requireVersionRow(db, name, from)
  requireVersionRow(db, name, to)
  const a = readTree(skillVersionDirAbs(opts.appHome, name, from))
  const b = readTree(skillVersionDirAbs(opts.appHome, name, to))
  return { from, to, diff: gitStyleDirDiff(a, b) }
}

// --- restore ---------------------------------------------------------------

export interface RestoreResult {
  version: SkillVersion
  /** PR-B: ids of memories un-fused by this restore (empty in PR-A). */
  unfusedMemoryIds: string[]
}

/**
 * Restore a skill to the content of version `target` by minting a NEW version
 * (source='restore') whose content equals v{target}. Forward-only, never
 * destructive. Memories fused at a version > target are un-fused in the SAME
 * transaction as the version bump (invariant: fused ⟺ knowledge is in current).
 */
export function restoreSkillVersion(
  db: DbClient,
  opts: SkillVersionFsOptions,
  name: string,
  target: number,
  authorUserId: string | null,
  reason?: string,
): RestoreResult {
  ensureInitialSkillVersion(db, opts, name)
  requireVersionRow(db, name, target)
  const targetDir = skillVersionDirAbs(opts.appHome, name, target)
  let unfusedMemoryIds: string[] = []
  const version = commitSkillVersion(
    db,
    opts,
    name,
    (staging) => {
      // full replace: clear pre-seeded copy, then lay down the target snapshot
      for (const e of readdirSync(staging))
        rmSync(join(staging, e), { recursive: true, force: true })
      if (existsSync(targetDir)) cpSync(targetDir, staging, { recursive: true })
    },
    {
      source: 'restore',
      restoredFromVersion: target,
      authorUserId,
      summary: reason && reason.length > 0 ? reason : `Restored from v${target}`,
      txExtra: (tx) => {
        // Un-fuse in the SAME tx as the version bump so the fused⟺in-current
        // invariant never observes a torn state.
        //
        // KNOWN v1 LIMITATION (Codex P2 #4): this un-fuses memories absorbed at
        // a version > target, but does NOT re-fuse memories that the target
        // version included if a prior restore-below already un-fused them
        // (provenance is cleared on un-fuse, so we can't re-derive it). The
        // narrow case "restore to v1, then restore forward to v2" thus leaves a
        // memory approved whose knowledge is back in the skill → mild
        // double-injection, not data loss. The complete fix records each
        // fusion version's incorporated memory ids on skill_versions and
        // re-fuses from the target's set; deferred to a follow-up (design §10).
        unfusedMemoryIds = unfuseMemoriesTx(tx, { skillName: name, aboveVersion: target })
      },
    },
  )
  return { version, unfusedMemoryIds }
}

// --- live-files reconciler (crash recovery + legacy backfill) --------------

/**
 * Startup self-heal: for every managed skill, ensure a v1 snapshot exists
 * (legacy backfill) and restore live files/ from the current version snapshot
 * ONLY when live is lost entirely (files/SKILL.md missing — e.g. deleted
 * out-of-band). Idempotent; safe to call repeatedly.
 *
 * Deliberately does NOT clobber an existing-but-differing live files/ from the
 * snapshot (Codex P1): an out-of-funnel writer — e.g. RFC-019 ZIP import /
 * overwrite, which rewrites files/ without bumping content_version — may have
 * legitimately changed live, and overwriting it with the recorded snapshot
 * would silently lose that write. The only mismatch a fully-funneled write can
 * leave is a crash between commitSkillVersion's DB tx and its live-sync; that
 * is rare and non-destructive (live keeps the prior valid content and the next
 * funnel write re-syncs), so we accept it rather than risk data loss.
 */
export function reconcileSkillLiveFiles(db: DbClient, opts: SkillVersionFsOptions): void {
  const rows = db.select().from(skills).where(eq(skills.sourceKind, 'managed')).all() as SkillRow[]
  for (const skill of rows) {
    try {
      ensureInitialSkillVersion(db, opts, skill.name)
      const fresh = loadSkillRow(db, skill.name)
      if (!fresh) continue
      const filesDir = skillFilesDir(opts.appHome, skill.name)
      if (existsSync(join(filesDir, 'SKILL.md'))) continue // live present — never clobber
      const versionDir = skillVersionDirAbs(opts.appHome, skill.name, fresh.contentVersion)
      if (!existsSync(versionDir)) continue
      rmSync(filesDir, { recursive: true, force: true })
      mkdirSync(dirname(filesDir), { recursive: true })
      cpSync(versionDir, filesDir, { recursive: true })
    } catch {
      // best-effort per skill; never block startup
    }
  }
}
