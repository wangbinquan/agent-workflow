// RFC-101 — skill content versioning + history (PR-A foundation).
//
// THE single funnel for writing a managed skill's files/. Every write path
// (createManagedSkill / writeSkillContent / writeSkillFile / deleteSkillFile,
// and PR-B fusion apply / restore) routes through commitSkillVersion, which:
//   1. archives the new files/ tree as an immutable snapshot under
//      skills/{id}/versions/v{n}/files,
//   2. bumps skills.content_version + inserts a skill_versions row (one tx),
//   3. syncs live files/ from the snapshot.
//
// Module-cycle discipline (RFC-079): this file queries the `skills` table
// DIRECTLY and never imports services/skill.ts. skill.ts imports THIS — one
// direction only.

import type {
  FileNode,
  ResourceVisibility,
  SkillContent,
  SkillVersion,
  SkillVersionContent,
  SkillVersionDiff,
  SkillVersionSource,
} from '@agent-workflow/shared'
import { structuredPatch } from 'diff'
import { and, eq } from 'drizzle-orm'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  type Dirent,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { skills, skillVersions } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { realpathInside } from '@/util/safePath'
import {
  cleanupOpDirs,
  opStagedDir,
  swapInStaged,
} from '@/modules/resource-catalog/infrastructure/legacy/skillFsPublish'
import {
  abandonOperation,
  advancePhase,
  beginOperation,
  finishOperation,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { unfuseMemoriesTx } from '@/services/memory'
import { NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { tokenToVersionFence } from '@/modules/resource-catalog/infrastructure/legacy/skillToken'
import { parseFrontmatter } from '@/util/frontmatter'
import {
  realDirectoryChainState,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'

export interface SkillVersionFsOptions {
  /** App home dir; managed skills live under `${appHome}/skills/{id}/...`. */
  appHome: string
}

type SkillRow = typeof skills.$inferSelect
type SkillVersionRow = typeof skillVersions.$inferSelect

export { skillVersionRelPath } from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'

// --- pure helpers (unit-tested) --------------------------------------------

/**
 * Given the fused memories of a skill and a restore target version N, return
 * the ids of memories that must be UN-fused because the restored content (=
 * version N) predates their absorption. Invariant: fused ⟺ knowledge is in the
 * current version, so memories fused at a version > N no longer apply.
 * Pure；状态翻转由 restore 路径实际执行（RFC-101 已 Done；RFC-317 T66 把原来的
 * 「PR-B wires the actual status flip」改成陈述——那是施工期的将来时）。
 */
export function memoriesToUnfuseOnRestore(
  fused: ReadonlyArray<{ id: string; fusedIntoSkillVersion: number | null }>,
  targetVersion: number,
): string[] {
  return fused
    .filter((m) => m.fusedIntoSkillVersion !== null && m.fusedIntoSkillVersion > targetVersion)
    .map((m) => m.id)
}

// RFC-170: hashing primitives moved to the leaf `skillHash` module so
// skillBootVerify can share them without a skillVersion↔skillBootVerify cycle.
// Re-exported here for existing importers of `hashDir` from this module.
export {
  hashDir,
  collectFiles,
  NUL,
} from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import {
  assertRegularFileTree,
  collectFiles,
  hashRegularFileTree,
} from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import {
  markSkillBootVerified,
  unmarkSkillBootVerified,
} from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { sha256Hex } from '@/util/hash'

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
        ? { kind: 'binary', hash: sha256Hex(buf) }
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

function loadSkillRow(db: DbClient, skillId: string): SkillRow | null {
  const rows = db.select().from(skills).where(eq(skills.id, skillId)).all() as SkillRow[]
  return rows[0] ?? null
}

function versionRows(db: DbClient, skillId: string): SkillVersionRow[] {
  return db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))
    .all() as SkillVersionRow[]
}

function rowToSkillVersion(row: SkillVersionRow, skillName: string): SkillVersion {
  return {
    id: row.id,
    skillName,
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
 * called at the top of every version-funnel access. No-op when files/ has no
 * SKILL.md (e.g. mid-create).
 */
export function ensureInitialSkillVersion(
  db: DbClient,
  opts: SkillVersionFsOptions,
  skillId: string,
): void {
  const skill = loadSkillRow(db, skillId)
  if (!skill) return
  if (versionRows(db, skillId).length > 0) return
  const filesDir = skillFilesAbs(opts.appHome, skillId)
  if (!existsSync(join(filesDir, 'SKILL.md'))) return
  assertRegularFileTree(filesDir)
  const versionDir = skillVersionAbs(opts.appHome, skillId, 1)
  rmSync(versionDir, { recursive: true, force: true })
  mkdirSync(dirname(versionDir), { recursive: true })
  cpSync(filesDir, versionDir, { recursive: true })
  const hash = hashRegularFileTree(versionDir)
  const now = Date.now()
  dbTxSync(db, (tx) => {
    tx.update(skills)
      .set({
        contentVersion: 1,
        // RFC-170 §invariant④ / T4a: the lazily-materialised v1 IS the authority —
        // promote out of 'legacy-unbackfilled' so the availability gate stops
        // hiding it (and mark it boot-verified below, having just written it).
        versionState: 'snapshot-authoritative',
        updatedAt: now,
      })
      .where(eq(skills.id, skillId))
      .run()
    tx.insert(skillVersions)
      .values({
        id: ulid(),
        skillId,
        versionIndex: 1,
        filesPath: skillVersionRelPath(skillId, 1),
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
  markSkillBootVerified(skill.id)
}

/**
 * Fail-safe content probe for the husk sweep: true ONLY when the directory
 * holds no files/symlinks at all (missing dir = no content). Any read error
 * (e.g. EACCES) counts as "has content" so the sweep never deletes what it
 * could not fully inspect.
 */
function dirHasNoContent(root: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
  for (const d of entries) {
    if (d.isDirectory()) {
      if (!dirHasNoContent(join(root, d.name))) return false
    } else {
      return false // file / symlink / anything else counts as content
    }
  }
  return true
}

/**
 * Boot-time legacy backfill + husk sweep (RFC-170 T4a; extracted from cli/start
 * so it is unit-testable). For every managed row still at
 * versionState='legacy-unbackfilled' AND reservationState='ready' — 'reserving'
 * rows belong to an in-flight/crashed create and are the reserve-op recovery
 * handler's job, never this sweep's:
 *   - live files/SKILL.md present → ensureInitialSkillVersion: archive live as
 *     v1, promote to 'snapshot-authoritative' + boot-verified (a pre-RFC-101
 *     legacy skill surfacing after an upgrade).
 *   - no SKILL.md, no skill_versions rows AND the skill dir is entirely empty
 *     (dirHasNoContent — zero files/symlinks anywhere under it) → an orphaned
 *     HUSK: zero recoverable content, yet the row keeps unique(name) reserved
 *     while the availability gate keeps it invisible — a permanent name
 *     squatter. Delete the row (+ leftover empty dir). Known producer: the
 *     pre-fix ZIP-import create failure path (rm'd files/, kept the row).
 *     Emptiness is REQUIRED (Codex P1): "SKILL.md missing" alone also matches
 *     a legacy skill whose main file was lost but whose support files remain —
 *     deleting that would destroy recoverable content, so it is left in place
 *     (warned) for a human to repair instead.
 *   - anything else (versions exist / dir has files) → leave it and warn;
 *     reconcile/reverify or a human decide, never this sweep.
 */
export function backfillLegacySkillVersions(
  db: DbClient,
  opts: SkillVersionFsOptions,
): { backfilled: number; husksRemoved: number } {
  const log = createLogger('skill-version-backfill')
  const rows = db
    .select()
    .from(skills)
    .where(
      and(eq(skills.versionState, 'legacy-unbackfilled'), eq(skills.reservationState, 'ready')),
    )
    .all() as SkillRow[]
  let backfilled = 0
  let husksRemoved = 0
  for (const row of rows) {
    try {
      if (existsSync(join(skillFilesAbs(opts.appHome, row.id), 'SKILL.md'))) {
        ensureInitialSkillVersion(db, opts, row.id)
        backfilled++
        continue
      }
      if (versionRows(db, row.id).length > 0) {
        log.warn('legacy-state skill has versions but no live SKILL.md; leaving for reconcile', {
          name: row.name,
          id: row.id,
        })
        continue
      }
      const skillDir = skillRootAbs(opts.appHome, row.id)
      if (!dirHasNoContent(skillDir)) {
        log.warn('legacy skill has no SKILL.md but its dir is not empty; leaving for repair', {
          name: row.name,
          id: row.id,
        })
        continue
      }
      dbTxSync(db, (tx) => {
        tx.delete(skills).where(eq(skills.id, row.id)).run()
        return null
      })
      rmSync(skillDir, { recursive: true, force: true })
      husksRemoved++
      log.warn('removed orphaned skill husk (no content, no versions; was squatting the name)', {
        name: row.name,
        id: row.id,
      })
    } catch (e) {
      log.warn('legacy skill v1 backfill failed on boot', {
        name: row.name,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return { backfilled, husksRemoved }
}

// --- the funnel ------------------------------------------------------------

export interface SkillVersionCommitOpts {
  source: SkillVersionSource
  authorUserId: string | null
  summary?: string | null
  fusionId?: string | null
  restoredFromVersion?: number | null
  /** OCC: throw resource-operation-stale (RFC-285 B5) if current content_version != this. */
  expectedVersion?: number
  /**
   * RFC-170 (Codex F4) — composite-token OCC fenced INSIDE the db-committed tx
   * (atomic with the version bump), so a delete→recreate (skillId drift) or a
   * metadata edit (metaRevision drift) that slipped past a caller's pre-check is
   * still caught. Fusion approve passes the decoded precondition token here.
   */
  expectedSkillId?: string
  expectedMetaRevision?: number
  /**
   * RFC-170 (Codex 4th-review [high]) — the skill's `owner_user_id` at the moment
   * the caller authorized the actor (route `requireResourceOwner`). Re-checked in
   * the version-bump tx: an owner transfer during the operation's await window
   * makes that route-level authorization stale, so the write is rejected (409),
   * closing the owner-transfer-during-save race that would otherwise let a demoted
   * ex-owner commit a post-revocation version. `undefined` = no owner fence
   * (system / `initial` / not-yet-wired callers — threading the six writers to
   * pass it is tracked in IMPLEMENTATION §7; this is the funnel-side machinery).
   */
  expectedOwnerUserId?: string | null
  /**
   * RFC-223 AC19 — ACL preview fence for ZIP overwrite. `aclRevision` changes
   * on owner, visibility, or grant updates; visibility is also compared
   * explicitly so the apply contract remains self-describing.
   */
  expectedAclRevision?: number
  expectedVisibility?: ResourceVisibility
  /** Fold a description change into the same tx (keeps DB ↔ SKILL.md in sync). */
  setDescription?: string
  /**
   * RFC-101 PR-B hook: run extra writes (e.g. fuse memories) inside the SAME
   * transaction as the version bump, given the new version number.
   */
  txExtra?: (tx: Parameters<Parameters<DbClient['transaction']>[0]>[0], newVersion: number) => void
  /**
   * RFC-170 §6a/T7② — skip opening a version-write op (lock+recovery). Set by a
   * caller that ALREADY holds the skill's op lock (e.g. reserve/createManagedSkill,
   * whose reserve op owns the skill for the whole create). Without this, opening a
   * version-write op on a skill the caller already locked would self-conflict.
   */
  skipOp?: boolean
  /** Test-only fault seam: throw before pre-commit FS rollback cleanup. */
  __beforeRollbackCleanupForTest?: () => void
  /** Test-only fault seam after DB authority commits, before live publish. */
  __afterDbCommitForTest?: () => void
}

/**
 * Archive the produced files/ tree as the next version of a managed skill.
 * `produce(stagingDir)` receives a copy of the current files/ pre-seeded and
 * mutates it in place (editor delta) or fully replaces it (fusion / restore).
 * Returns the new (or, on an empty editor write, the unchanged latest) version.
 */
/**
 * RFC-170 (Codex F4 + re-review): the composite-token OCC. Re-reads the
 * requested row by immutable id INSIDE the given tx and throws
 * resource-operation-stale (RFC-285 B5) if any expected field drifted (delete→recreate ABA /
 * metadata edit / version bump / owner or ACL change). No-op when the caller
 * passed no expected fields.
 * Called from BOTH the version-bump tx (atomic with the UPDATE) AND before the
 * editor no-op short-circuit — otherwise an identical-content delete→recreate in
 * the caller's await window slips through unfenced and returns the substitute's row.
 */
function assertCompositePrecondition(
  tx: Parameters<Parameters<DbClient['transaction']>[0]>[0],
  skillId: string,
  commit: SkillVersionCommitOpts,
): void {
  if (
    commit.expectedSkillId === undefined &&
    commit.expectedMetaRevision === undefined &&
    commit.expectedVersion === undefined &&
    commit.expectedOwnerUserId === undefined &&
    commit.expectedAclRevision === undefined &&
    commit.expectedVisibility === undefined
  ) {
    return
  }
  const live = tx
    .select({
      id: skills.id,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
      ownerUserId: skills.ownerUserId,
      aclRevision: skills.aclRevision,
      visibility: skills.visibility,
    })
    .from(skills)
    .where(eq(skills.id, skillId))
    .get()
  if (
    !live ||
    (commit.expectedSkillId !== undefined && live.id !== commit.expectedSkillId) ||
    (commit.expectedMetaRevision !== undefined &&
      live.metaRevision !== commit.expectedMetaRevision) ||
    (commit.expectedVersion !== undefined && live.contentVersion !== commit.expectedVersion) ||
    // RFC-170 (4th-review [high]): owner-drift — the actor was authorized (route
    // requireResourceOwner) against the owner at request time; if it transferred
    // during the operation's await window that authorization is stale → reject, so
    // a demoted ex-owner cannot commit a post-revocation version. Conservative for
    // ACL-bypass actors (an owner change during their write also 409s → reload), which is safe.
    (commit.expectedOwnerUserId !== undefined && live.ownerUserId !== commit.expectedOwnerUserId) ||
    (commit.expectedAclRevision !== undefined && live.aclRevision !== commit.expectedAclRevision) ||
    (commit.expectedVisibility !== undefined && live.visibility !== commit.expectedVisibility)
  ) {
    throw staleConflictError(
      'skill',
      `skill '${skillId}' changed since this operation started; reload and retry`,
    )
  }
}

/**
 * RFC-271 T10 —— 一次版本提交被拆成**四段**，让批量导入能把「DB 提交」这一段和
 * 别的资源放进同一个事务。
 *
 *   stage      → FS 暂存 + 候选目录 + 开 op（DB 里还看不见）
 *   commitInTx → 版本行 + skills 行的推进（**引擎把它塞进自己的 big tx**）
 *   publish    → 原子 swap 发布 live files/
 *   abort      → pre-commit 补偿
 *
 * ⚠️ 引擎必须有 `abort`：没有它，批量场景失败时只能复制状态机内部逻辑去清理，
 * 而那正是这套两阶段提交当初为之而生的东西。
 *
 * ⚠️ **`unmarkSkillBootVerified` 不在 publish 段里**。单条路径在 DB 提交返回后
 * 立刻 unmark；批量场景必须在 big tx 返回后、**任何**逐项 publish 之前一次性
 * unmark 全部已提交技能——否则先 publish 的那个已经 mark 回来了，而后一个还没
 * 发布的技能仍带着上一代的 admission。
 */
export interface StagedSkillVersion {
  skillId: string
  skillName: string
  /** null = 调用方已持有该技能的 op 锁（reserve / create 路径的 skipOp）。 */
  opId: string | null
  publishId: string
  newVersion: number
  newHash: string
  filesDir: string
  versionDir: string
  stagingDir: string
  /**
   * 空写短路（编辑器 Save 内容未变）。**它仍然是一个 fence-only 的已暂存 op**：
   * 照样进事务重验那四道 token，只跳过版本写入与 publish。整条 op 跳过会破坏
   * 整包基线——调用方会以为这个目标没被校验过。
   */
  noop: SkillVersionRow | null
}

export function stageSkillVersion(
  db: DbClient,
  opts: SkillVersionFsOptions,
  skillId: string,
  produce: (stagingDir: string) => void,
  commit: SkillVersionCommitOpts,
): StagedSkillVersion {
  const skill = loadSkillRow(db, skillId)
  if (!skill) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  if (commit.source !== 'initial') ensureInitialSkillVersion(db, opts, skillId)

  const cur = loadSkillRow(db, skillId)
  if (!cur) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  const existing = versionRows(db, skillId)
  const maxIndex = existing.reduce((m, r) => Math.max(m, r.versionIndex), 0)
  const N = cur.contentVersion

  if (commit.expectedVersion !== undefined && commit.expectedVersion !== N) {
    throw staleConflictError(
      'skill',
      `skill '${cur.name}' is at version ${N}, expected ${commit.expectedVersion}; reload and retry`,
    )
  }

  const newVersion = maxIndex === 0 ? 1 : maxIndex + 1
  const filesDir = skillFilesAbs(opts.appHome, skillId)
  const versionDir = skillVersionAbs(opts.appHome, skillId, newVersion)
  // RFC-170 §6a/§13: build into an op-scoped staged dir so the live publish is an
  // ATOMIC rename-swap (swapInStaged). publishId scopes the sibling names.
  const publishId = ulid()
  const staging = opStagedDir(filesDir, publishId)

  // RFC-170 §6a/T7②: open a version-write op (serialising lease + crash recovery)
  // UNLESS the caller already holds the skill's op lock (skipOp — reserve/create).
  // A concurrent same-skill write is rejected 409-busy; a crash is recovered at
  // boot by versionWriteRecoveryHandler. Its paths ride in the op columns.
  const opId = commit.skipOp
    ? null
    : dbTxSync(db, (tx) =>
        beginOperation(tx, {
          skillId: cur.id,
          kind: 'version-write',
          targetVersion: newVersion,
          stagingPath: relative(opts.appHome, staging),
          candidatePath: relative(opts.appHome, versionDir),
          preconditionJson: JSON.stringify({ skillId }),
        }),
      )

  const staged: StagedSkillVersion = {
    skillId,
    skillName: cur.name,
    opId,
    publishId,
    newVersion,
    newHash: '',
    filesDir,
    versionDir,
    stagingDir: staging,
    noop: null,
  }
  try {
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    if (existsSync(filesDir)) cpSync(filesDir, staging, { recursive: true })
    produce(staging)

    staged.newHash = hashRegularFileTree(staging)
    // Empty-write short-circuit: an editor Save with no real change must not
    // inflate the history. (Initial / fusion / restore always commit.)
    if (
      commit.source === 'editor' &&
      maxIndex > 0 &&
      staged.newHash === hashRegularFileTree(filesDir)
    ) {
      const latest = existing.find((r) => r.versionIndex === maxIndex)
      if (latest) {
        // 空写：丢掉 staging，但**保留 op**（若有）—— 它仍要在事务里重验那四道
        // token，只是不写版本、不发布。整条跳过会破坏整包基线。
        rmSync(staging, { recursive: true, force: true })
        staged.noop = latest
        return staged
      }
    }
    if (opId) dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-staged'))

    rmSync(versionDir, { recursive: true, force: true })
    mkdirSync(dirname(versionDir), { recursive: true })
    cpSync(staging, versionDir, { recursive: true })
    assertRegularFileTree(versionDir)
    if (opId) dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-versioned'))
    return staged
  } catch (err) {
    // 暂存段自身失败：这里还没有任何 DB 可见物，直接补偿。
    abortStagedSkillVersion(db, staged, commit)
    throw err
  }
}

/**
 * 第二段：**纯 DB**。调用方把它塞进自己的事务，于是「这个技能的新版本」与同一
 * 包里其它资源的写入要么一起可见、要么一起不可见。
 *
 * 空写（`staged.noop !== null`）仍然跑那四道 token 复核，只跳过两个写入。
 * 返回 null 表示没有新版本行。
 */
export function commitSkillVersionInTx(
  tx: DbTxSync,
  staged: StagedSkillVersion,
  commit: SkillVersionCommitOpts,
): SkillVersionRow | null {
  // RFC-170 (Codex F4): fence the composite precondition IN the version-bump
  // tx (atomic with the UPDATE), so a drift that slipped past the caller's
  // earlier pre-check cannot be applied to the wrong generation.
  assertCompositePrecondition(tx, staged.skillId, commit)
  if (staged.noop !== null) {
    if (staged.opId) abandonOperation(tx, staged.opId) // nothing committed
    return null
  }
  const id = ulid()
  const now = Date.now()
  const skillSet: Partial<typeof skills.$inferInsert> = {
    contentVersion: staged.newVersion,
    updatedAt: now,
    // RFC-170 §invariant④: a freshly-written snapshot IS the authority.
    versionState: 'snapshot-authoritative',
  }
  if (commit.setDescription !== undefined) skillSet.description = commit.setDescription
  tx.update(skills).set(skillSet).where(eq(skills.id, staged.skillId)).run()
  tx.insert(skillVersions)
    .values({
      id,
      skillId: staged.skillId,
      versionIndex: staged.newVersion,
      filesPath: skillVersionRelPath(staged.skillId, staged.newVersion),
      source: commit.source,
      summary: commit.summary ?? null,
      fusionId: commit.fusionId ?? null,
      restoredFromVersion: commit.restoredFromVersion ?? null,
      authorUserId: commit.authorUserId,
      contentHash: staged.newHash,
      createdAt: now,
    })
    .run()
  commit.txExtra?.(tx, staged.newVersion)
  if (staged.opId) advancePhase(tx, staged.opId, 'db-committed')
  const created = (
    tx.select().from(skillVersions).where(eq(skillVersions.id, id)).all() as SkillVersionRow[]
  )[0]
  if (!created) throw new Error('skill_versions row disappeared after insert')
  return created
}

/**
 * 第三段：把 staging 原子发布成 live `files/`（`swapInStaged` 两次同父 rename）。
 *
 * ⚠️ 这一段**故意不含** `unmarkSkillBootVerified` —— 见 `StagedSkillVersion` 的
 * 注释：批量场景要在 big tx 返回后、任何逐项 publish 之前一次性 unmark 全部。
 * 崩在两次 rename 之间只会留下一棵完整的树，`reconcileSkillLiveFiles()` 在启动
 * 时从 `versions/v{cur}` 重新同步 live。
 */
export function publishStagedSkillVersion(
  db: DbClient,
  opts: SkillVersionFsOptions,
  staged: StagedSkillVersion,
): void {
  if (staged.noop !== null) return
  const { filesDir, publishId, opId } = staged
  mkdirSync(dirname(filesDir), { recursive: true })
  swapInStaged(filesDir, publishId)
  const root = skillRootAbs(opts.appHome, staged.skillId)
  if (realDirectoryChainState(root, filesDir) !== 'real-directory') {
    throw new Error(`skill version ${staged.newVersion} live publish is not a real directory`)
  }
  if (hashRegularFileTree(filesDir) !== staged.newHash) {
    throw new Error(
      `skill version ${staged.newVersion} live publish does not match committed content hash`,
    )
  }
  cleanupOpDirs(filesDir, publishId)
  if (opId) {
    dbTxSync(db, (tx) => advancePhase(tx, opId, 'fs-published'))
    dbTxSync(db, (tx) => finishOperation(tx, opId))
  }
  // RFC-170 §invariant④: the snapshot we just published IS verified this boot.
  markSkillBootVerified(staged.skillId)
}

/**
 * 第四段：**pre-commit 补偿**。没有它，引擎在批量失败时只能复制这套状态机的内部
 * 逻辑去清理。清理本身若无法证明完成，**保留** active op + 锁——启动恢复要靠它
 * 当 oracle（这条与既有实现逐字一致）。
 */
export function abortStagedSkillVersion(
  db: DbClient,
  staged: StagedSkillVersion,
  commit?: Pick<SkillVersionCommitOpts, '__beforeRollbackCleanupForTest'>,
): void {
  if (staged.opId === null) return
  try {
    commit?.__beforeRollbackCleanupForTest?.()
    cleanupOpDirs(staged.filesDir, staged.publishId)
    rmSync(staged.versionDir, { recursive: true, force: true })
    const opId = staged.opId
    dbTxSync(db, (tx) => abandonOperation(tx, opId))
  } catch {
    /* active op + lock intentionally preserved for boot recovery */
  }
}

/**
 * 四段的顺序组合 —— 单条路径的既有形态，行为逐字不变。
 * 批量路径不走这里：它要把第二段并进自己的事务。
 */
export function commitSkillVersion(
  db: DbClient,
  opts: SkillVersionFsOptions,
  skillId: string,
  produce: (stagingDir: string) => void,
  commit: SkillVersionCommitOpts,
): SkillVersion {
  const staged = stageSkillVersion(db, opts, skillId, produce, commit)
  let committed = false
  try {
    const created = dbTxSync(db, (tx) => commitSkillVersionInTx(tx, staged, commit))
    committed = true
    if (staged.noop !== null) return rowToSkillVersion(staged.noop, staged.skillName)
    // The DB now names a generation that live files/ has not yet published.
    // Remove any prior-generation admission immediately; a post-commit fault
    // must remain hidden while its active op + lock await boot recovery.
    unmarkSkillBootVerified(staged.skillId)
    commit.__afterDbCommitForTest?.()
    publishStagedSkillVersion(db, opts, staged)
    if (!created) throw new Error('skill_versions row disappeared after insert')
    return rowToSkillVersion(created, staged.skillName)
  } catch (err) {
    // Post-db-committed: the version is durable, but the two-rename live publish
    // may be incomplete. Preserve the active op + lock as recovery evidence.
    if (!committed) abortStagedSkillVersion(db, staged, commit)
    throw err
  }
}

// --- read / history --------------------------------------------------------

export function listSkillVersions(
  db: DbClient,
  opts: SkillVersionFsOptions,
  skillId: string,
): SkillVersion[] {
  const skill = loadSkillRow(db, skillId)
  if (skill === null) {
    throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  }
  ensureInitialSkillVersion(db, opts, skillId)
  return versionRows(db, skillId)
    .sort((x, y) => y.versionIndex - x.versionIndex)
    .map((row) => rowToSkillVersion(row, skill.name))
}

function requireVersionRow(db: DbClient, skillId: string, v: number): SkillVersionRow {
  const row = versionRows(db, skillId).find((r) => r.versionIndex === v)
  if (!row) {
    throw new NotFoundError('skill-version-not-found', `skill '${skillId}' has no version ${v}`)
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
  skillId: string,
  v: number,
): SkillVersionContent {
  const skill = loadSkillRow(db, skillId)
  if (skill === null) {
    throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  }
  ensureInitialSkillVersion(db, opts, skillId)
  requireVersionRow(db, skillId, v)
  const versionDir = skillVersionAbs(opts.appHome, skillId, v)
  const skillMdPath = join(versionDir, 'SKILL.md')
  let content: SkillContent
  if (existsSync(skillMdPath)) {
    // RFC-170 G3-1 (security): a historical SKILL.md may be a symlink escaping the
    // version dir; contain it so `/versions/:v/content` can't leak host files.
    const parsed = parseFrontmatter(readFileSync(realpathInside(versionDir, skillMdPath), 'utf-8'))
    const { name: _n, description: descRaw, ...rest } = parsed.data
    content = {
      name: skill.name,
      description: typeof descRaw === 'string' ? descRaw : '',
      bodyMd: parsed.body,
      frontmatterExtra: rest,
    }
  } else {
    content = { name: skill.name, description: '', bodyMd: '', frontmatterExtra: {} }
  }
  return { versionIndex: v, content, files: fileTreeOf(versionDir) }
}

export function diffSkillVersions(
  db: DbClient,
  opts: SkillVersionFsOptions,
  skillId: string,
  from: number,
  to: number,
): SkillVersionDiff {
  if (loadSkillRow(db, skillId) === null) {
    throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  }
  ensureInitialSkillVersion(db, opts, skillId)
  requireVersionRow(db, skillId, from)
  requireVersionRow(db, skillId, to)
  const a = readTree(skillVersionAbs(opts.appHome, skillId, from))
  const b = readTree(skillVersionAbs(opts.appHome, skillId, to))
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
  skillId: string,
  target: number,
  authorUserId: string | null,
  reason?: string,
  // RFC-170 (4th-review [high]): owner the route authorized against; funnel 409s on drift.
  expectedOwnerUserId?: string | null,
  // RFC-170 F3: composite precondition token — OCC-fenced in the version-bump tx.
  expectedToken?: string,
): RestoreResult {
  const skill = loadSkillRow(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  ensureInitialSkillVersion(db, opts, skillId)
  requireVersionRow(db, skillId, target)
  const fence = tokenToVersionFence(expectedToken)
  if (fence === null) {
    throw new ValidationError(
      'skill-token-invalid',
      'malformed precondition token; reload and retry',
    )
  }
  const targetDir = skillVersionAbs(opts.appHome, skillId, target)
  let unfusedMemoryIds: string[] = []
  const version = commitSkillVersion(
    db,
    opts,
    skillId,
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
      ...(expectedOwnerUserId !== undefined ? { expectedOwnerUserId } : {}),
      ...(fence ?? {}),
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
        unfusedMemoryIds = unfuseMemoriesTx(tx, {
          skillId,
          aboveVersion: target,
        })
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
 * snapshot (Codex P1): an out-of-band writer (manual edits under ~/.agent-workflow;
 * every platform write path — editor, fusion, restore, and both ZIP import
 * branches — goes through the funnel now) may have legitimately changed live,
 * and overwriting it with the recorded snapshot would silently lose that write.
 * The only mismatch a fully-funneled write can leave is a crash between
 * commitSkillVersion's DB tx and its live-sync; that is rare and
 * non-destructive (live keeps the prior valid content and the next funnel
 * write re-syncs), so we accept it rather than risk data loss.
 */
export function reconcileSkillLiveFiles(db: DbClient, opts: SkillVersionFsOptions): void {
  const rows = db.select().from(skills).all() as SkillRow[]
  for (const skill of rows) {
    try {
      ensureInitialSkillVersion(db, opts, skill.id)
      const fresh = loadSkillRow(db, skill.id)
      if (!fresh) continue
      const filesDir = skillFilesAbs(opts.appHome, skill.id)
      if (existsSync(join(filesDir, 'SKILL.md'))) continue // live present — never clobber
      const versionDir = skillVersionAbs(opts.appHome, skill.id, fresh.contentVersion)
      if (!existsSync(versionDir)) continue
      rmSync(filesDir, { recursive: true, force: true })
      mkdirSync(dirname(filesDir), { recursive: true })
      cpSync(versionDir, filesDir, { recursive: true })
    } catch {
      // best-effort per skill; never block startup
    }
  }
}
