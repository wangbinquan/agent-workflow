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

import {
  skillTextView,
  skillTreeTextView,
  type SkillVersionTextEntry as TreeEntry,
} from '../../application/skills/textView'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import type {
  ResourceVisibility,
  SkillContent,
  SkillVersion,
  SkillVersionContent,
  SkillVersionDiff,
  SkillVersionSource,
} from '@agent-workflow/shared'
import { structuredPatch } from 'diff'
import { eq } from 'drizzle-orm'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'

/** RFC-359 W4-D23b：版本机器改吃中立句柄，两个 provider 共用同一套发布阶梯。 */
type SkillVersionDb = PersistenceDb
import {
  advancePhase,
  finishOperation,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import { NotFoundError, ValidationError } from '@/util/errors'
import { tokenToVersionFence } from '@/modules/resource-catalog/infrastructure/legacy/skillToken'
import { parseFrontmatter } from '@/util/frontmatter'

import type {
  SkillVersionContentChange,
  SkillVersionContentStore,
  SkillVersionPublication,
} from '../../application/skills/versionContentStore'
import { createFileSkillVersionContentStore } from '../local/fileSkillVersionContentStore'

import type { SkillVersionContentReader } from '../../application/skills/versionContentReader'
import { createFileSkillVersionContentReader } from '../local/fileSkillVersionContentReader'

import type { SkillLifecycleContentStore } from '../../application/skills/lifecycleContentStore'
import { createFileSkillLifecycleContentStore } from '../local/fileSkillLifecycleContentStore'

import type { SkillDeletionContentStore } from '../../application/skills/deletionContentStore'

export interface SkillVersionFsOptions {
  contentKind?: 'local-file' | 'database-bytes'
  /** App home dir; managed skills live under `${appHome}/skills/{id}/...`. */
  appHome: string
  lifecycleContent?: SkillLifecycleContentStore
  deletionContent?: SkillDeletionContentStore
  versionContent?: SkillVersionContentStore
  versionReader?: SkillVersionContentReader
}

type SkillRow = PersistenceTables['skills']['$inferSelect']
type SkillVersionRow = PersistenceTables['skillVersions']['$inferSelect']

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
import { markSkillBootVerified } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'

import { skillApplyContentFor } from '../skillApplyContent'
import { createSkillApplyScene } from '../skillAtomicApply'

export type { SkillVersionTextEntry as TreeEntry } from '../../application/skills/textView'

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
export function gitStyleDirDiff(
  a: ReadonlyMap<string, TreeEntry>,
  b: ReadonlyMap<string, TreeEntry>,
): string {
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

async function loadSkillRow(db: SkillVersionDb, skillId: string): Promise<SkillRow | null> {
  const { skills } = tablesOf(db)
  const rows = (await db.select().from(skills).where(eq(skills.id, skillId))) as SkillRow[]
  return rows[0] ?? null
}

async function versionRows(db: SkillVersionDb, skillId: string): Promise<SkillVersionRow[]> {
  const { skillVersions } = tablesOf(db)
  return (await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skillId))) as SkillVersionRow[]
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

/** Epoch-1 backfill belongs to the switch converter; this old entry is no longer a writer. */
export async function ensureInitialSkillVersion(
  _db: SkillVersionDb,
  _opts: SkillVersionFsOptions,
  _skillId: string,
): Promise<void> {
  throw new Error('skill-legacy-upgrade-requires-conversion')
}
export async function backfillLegacySkillVersions(
  _db: SkillVersionDb,
  _opts: SkillVersionFsOptions,
): Promise<{ backfilled: number; husksRemoved: number }> {
  throw new Error('skill-legacy-upgrade-requires-conversion')
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
  txExtra?: (tx: PersistenceTx, newVersion: number) => void | Promise<void>
  /** Test-only fault seam: throw before pre-commit content compensation. */
  __beforeRollbackCleanupForTest?: () => void
  /** Test-only fault seam after DB authority commits, before live publish. */
  __afterDbCommitForTest?: () => void
}

/**
 * 旧格式 Intent journal 里记下的版本暂存（RFC-271 T10 的四段漏斗留下的形状）。RFC-401 T5 起新写入经 skill 写入场景，这个形状
 * 只剩兼容执行器 `composeLegacyIntentSkillArtifactCompat` 前滚旧记录时使用（`publishStagedSkillVersion`）。
 */
export interface StagedSkillVersion {
  contentKind?: 'local-file' | 'database-bytes'
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

function publicationOf(staged: StagedSkillVersion): SkillVersionPublication {
  return {
    skillId: staged.skillId,
    version: staged.newVersion,
    publicationId: staged.publishId,
    liveRef: staged.filesDir,
    versionRef: staged.versionDir,
    stagingRef: staged.stagingDir,
  }
}

/**
 * 兼容执行器：把旧格式记录里的 staging 发布成 live `files/` 并收尾旧 operation。崩在两次 rename 之间只会留下一棵完整的树，
 * `reconcileSkillLiveFiles()` 在启动时从 `versions/v{cur}` 重新同步 live。
 */
export async function publishStagedSkillVersion(
  db: SkillVersionDb,
  opts: SkillVersionFsOptions,
  staged: StagedSkillVersion,
): Promise<void> {
  if (staged.noop !== null) return
  const { opId } = staged
  const content = opts.versionContent ?? createFileSkillVersionContentStore(opts.appHome)
  await content.publish(publicationOf(staged), staged.newHash)
  if (opId) {
    const session = databaseSessionFor(db)
    await session.transaction(async (tx) => await advancePhase(tx, opId, 'fs-published'))
    await session.transaction(async (tx) => await finishOperation(tx, opId))
  }
  // RFC-170 §invariant④: the snapshot we just published IS verified this boot.
  markSkillBootVerified(staged.skillId)
}

/**
 * RFC-401 T5 —— 普通编辑、ZIP 覆盖与 restore 推进一版：经 skill 写入场景（`skillAtomicApply.ts`）。场景取技能锁、暂存并固化
 * 版本快照，唯一 skill 写入参与者在提交事务里判复合前置条件、写版本行（description 变化时 metaRevision + 1），提交后发布 live；
 * 编辑器内容与 live 相同则不写版本，返回当前版本。提交之后的失败由 AtomicApply 恢复前滚，不再把技能锁到重启。
 */
export async function commitSkillVersion(
  db: SkillVersionDb,
  opts: SkillVersionFsOptions,
  skillId: string,
  produce: SkillVersionContentChange | ((stagingDir: string) => void),
  commit: SkillVersionCommitOpts,
): Promise<SkillVersion> {
  const scene = createSkillApplyScene({
    db,
    content: skillApplyContentFor(
      db,
      {
        appHome: opts.appHome,
        ...(opts.contentKind === undefined ? {} : { contentKind: opts.contentKind }),
        ...(opts.versionContent === undefined ? {} : { versionContent: opts.versionContent }),
        ...(opts.deletionContent === undefined ? {} : { deletionContent: opts.deletionContent }),
      },
      typeof produce === 'function' ? produce : undefined,
    ),
  })
  const editor = commit.source === 'editor'
  const written = await scene.version({
    skillId,
    change: typeof produce === 'function' ? { kind: 'retain' } : produce,
    compareLive: editor,
    mutation: {
      fence: {
        ...(commit.expectedSkillId === undefined
          ? {}
          : { expectedSkillId: commit.expectedSkillId }),
        ...(commit.expectedVersion === undefined
          ? {}
          : { expectedVersion: commit.expectedVersion }),
        ...(commit.expectedMetaRevision === undefined
          ? {}
          : { expectedMetaRevision: commit.expectedMetaRevision }),
        ...(commit.expectedOwnerUserId === undefined
          ? {}
          : { expectedOwnerUserId: commit.expectedOwnerUserId }),
        ...(commit.expectedAclRevision === undefined
          ? {}
          : { expectedAclRevision: commit.expectedAclRevision }),
        ...(commit.expectedVisibility === undefined
          ? {}
          : { expectedVisibility: commit.expectedVisibility }),
      },
      source: commit.source,
      summary: commit.summary ?? null,
      fusionId: commit.fusionId ?? null,
      restoredFromVersion: commit.restoredFromVersion ?? null,
      authorUserId: commit.authorUserId,
      ...(commit.setDescription === undefined ? {} : { description: commit.setDescription }),
      // restore 总是推进一版；编辑与导入内容不变时不推进（proposal §5 第 9 项）。
      advance: editor || commit.source === 'import' ? 'on-change' : 'always',
    },
    faults: {
      ...(commit.__afterDbCommitForTest === undefined
        ? {}
        : { afterCommit: commit.__afterDbCommitForTest }),
      ...(commit.__beforeRollbackCleanupForTest === undefined
        ? {}
        : { beforeCompensate: commit.__beforeRollbackCleanupForTest }),
    },
    ...(commit.txExtra === undefined
      ? {}
      : {
          hooks: (tx: PersistenceTx) => ({
            after: async (version: number) => {
              await commit.txExtra!(tx, version)
            },
          }),
        }),
  })
  const skill = await loadSkillRow(db, skillId)
  const row = (await versionRows(db, skillId)).find((r) => r.versionIndex === written.versionIndex)
  if (skill === null || row === undefined)
    throw new Error('skill_versions row disappeared after commit')
  return rowToSkillVersion(row, skill.name)
}

// --- read / history --------------------------------------------------------

export async function listSkillVersions(
  db: SkillVersionDb,
  opts: SkillVersionFsOptions,
  skillId: string,
): Promise<SkillVersion[]> {
  const skill = await loadSkillRow(db, skillId)
  if (skill === null) {
    throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  }
  return (await versionRows(db, skillId))
    .sort((x, y) => y.versionIndex - x.versionIndex)
    .map((row) => rowToSkillVersion(row, skill.name))
}

async function requireVersionRow(
  db: SkillVersionDb,
  skillId: string,
  v: number,
): Promise<SkillVersionRow> {
  const row = (await versionRows(db, skillId)).find((r) => r.versionIndex === v)
  if (!row) {
    throw new NotFoundError('skill-version-not-found', `skill '${skillId}' has no version ${v}`)
  }
  return row
}

/**
 * The description a SKILL.md declares: the value `skills.description` must hold
 * while that SKILL.md is current. Writes that replace SKILL.md without an
 * explicit description (a fusion's tree, a restore) fold it into the version
 * bump, as the editor and ZIP import do with `setDescription`.
 */
export function skillMainDescription(main: string | null): string {
  if (main === null) return ''
  const description = parseFrontmatter(main.replace(/^\uFEFF/, '')).data.description
  return typeof description === 'string' ? description : ''
}

export async function getSkillVersionContent(
  db: SkillVersionDb,
  opts: SkillVersionFsOptions,
  skillId: string,
  v: number,
): Promise<SkillVersionContent> {
  const skill = await loadSkillRow(db, skillId)
  if (skill === null) {
    throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  }
  await requireVersionRow(db, skillId, v)
  const reader = opts.versionReader ?? createFileSkillVersionContentReader(opts.appHome, db)
  const snapshot = await reader.readSnapshot({ skillId, version: v })
  let content: SkillContent
  if (snapshot.main !== null) {
    const parsed = parseFrontmatter(skillTextView(snapshot.main, reader))
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
  return { versionIndex: v, content, files: [...snapshot.files] }
}

export async function diffSkillVersions(
  db: SkillVersionDb,
  opts: SkillVersionFsOptions,
  skillId: string,
  from: number,
  to: number,
): Promise<SkillVersionDiff> {
  if ((await loadSkillRow(db, skillId)) === null) {
    throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  }
  await requireVersionRow(db, skillId, from)
  await requireVersionRow(db, skillId, to)
  const reader = opts.versionReader ?? createFileSkillVersionContentReader(opts.appHome, db)
  const a = await reader.readTree({ skillId, version: from })
  const b = await reader.readTree({ skillId, version: to })
  return {
    from,
    to,
    diff: gitStyleDirDiff(skillTreeTextView(a, reader), skillTreeTextView(b, reader)),
  }
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
/**
 * RFC-353 T3/T7：回滚要退回哪些记忆，由调用方**注入一个协调器**决定。
 *
 * 由来：这件事 PostgreSQL 侧早就是注入的（`postgresqlSkillContentLifecycle.prepareRestore`
 * 拿 memory 的 participant），SQLite 侧却穿过一个 legacy facade——同一件事两条取用路径，
 * 而且实测已经漂过（两边选中的集合一样、**返回顺序不一样**）。收成注入之后两侧同源。
 *
 * T7 进一步把「回滚时该退回哪些」这条判据交给 knowledge-evolution（`memoriesToUnfuseOnRestore`）：
 * 本端口从此只说「拿去这个事务与这个回滚目标，还我被退回的 id」，resource-catalog 既不认识
 * memory 也不认识 aboveVersion 的算法。装配在 bootstrap——RFC-294 的目标边表里
 * `resource-catalog → knowledge-evolution` 不存在，RC 不能 import KE。
 */
export interface SkillRestoreMembershipPort {
  unfuseForRestore(
    tx: PersistenceTx,
    request: { readonly skillId: string; readonly targetVersion: number },
  ): readonly string[] | Promise<readonly string[]>
}

export async function restoreSkillVersion(
  db: SkillVersionDb,
  opts: SkillVersionFsOptions,
  skillId: string,
  target: number,
  authorUserId: string | null,
  memoryMembership: SkillRestoreMembershipPort,
  reason?: string,
  // RFC-170 (4th-review [high]): owner the route authorized against; funnel 409s on drift.
  expectedOwnerUserId?: string | null,
  // RFC-170 F3: composite precondition token — OCC-fenced in the version-bump tx.
  expectedToken?: string,
): Promise<RestoreResult> {
  const skill = await loadSkillRow(db, skillId)
  if (skill === null) throw new NotFoundError('skill-not-found', `skill '${skillId}' not found`)
  await requireVersionRow(db, skillId, target)
  const fence = tokenToVersionFence(expectedToken)
  if (fence === null) {
    throw new ValidationError(
      'skill-token-invalid',
      'malformed precondition token; reload and retry',
    )
  }
  let unfusedMemoryIds: string[] = []
  // The restored SKILL.md becomes current, and so does the description it declares.
  const reader = opts.versionReader ?? createFileSkillVersionContentReader(opts.appHome, db)
  const restoredMain = (await reader.readSnapshot({ skillId, version: target })).main
  const restoredDescription = skillMainDescription(
    restoredMain === null ? null : skillTextView(restoredMain, reader),
  )
  const version = await commitSkillVersion(
    db,
    opts,
    skillId,
    { kind: 'restore-version', version: target },
    {
      source: 'restore',
      restoredFromVersion: target,
      setDescription: restoredDescription,
      authorUserId,
      ...(expectedOwnerUserId !== undefined ? { expectedOwnerUserId } : {}),
      ...(fence ?? {}),
      summary: reason && reason.length > 0 ? reason : `Restored from v${target}`,
      txExtra: async (tx) => {
        // Un-fuse in the SAME tx as the version bump so the fused⟺in-current
        // invariant never observes a torn state.
        //
        // 选中规则与它的 v1 已知缺口都住在 knowledge-evolution 的
        // `domain/skillRestore.ts#memoriesToUnfuseOnRestore`——这里只负责把事务交过去。
        unfusedMemoryIds = [
          ...(await memoryMembership.unfuseForRestore(tx, {
            skillId,
            targetVersion: target,
          })),
        ]
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
export async function reconcileSkillLiveFiles(
  db: SkillVersionDb,
  opts: SkillVersionFsOptions,
): Promise<void> {
  const content = opts.lifecycleContent ?? createFileSkillLifecycleContentStore(opts.appHome, db)
  const { skills } = tablesOf(db)
  const rows = (await db.select().from(skills)) as SkillRow[]
  for (const skill of rows) {
    try {
      const fresh = await loadSkillRow(db, skill.id)
      if (!fresh) continue
      await content.restoreLiveIfMissing(skill.id, fresh.contentVersion)
    } catch {
      // best-effort per skill; never block startup
    }
  }
}
