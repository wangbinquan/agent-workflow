// RFC-304 T2c — freezing a change, and letting it go again.
//
// An artifact is a change the platform has SHOWN someone. From that moment it
// must be reproducible byte for byte, because the thing that eventually happens
// to it is a push to their branch and the only honest push is the one they read.
//
// Two halves, and the second is the one that gets forgotten:
//
//   freeze   — commit the worktree, hold a ref, record the digest. Done at the
//              moment of posting, not at the moment of confirmation.
//   release  — drop the ref and let git collect the object. Done as soon as the
//              artifact is consumed OR invalidated. Skipping this leaves a
//              growing set of refs pinning dead commits in the object store: on
//              a repository handling a few of these a day, that is an unbounded
//              leak that only shows up months later as a slow clone.
//
// ## Why a digest of the DIFF rather than the commit sha
//
// The commit sha depends on the parent, the author and the timestamp. Two
// commits carrying the identical change have different shas, and a person
// re-reading "the same fix" would be told it is a different one. What the human
// agreed to is the change, so the change is what is identified.

import { and, desc, eq, lte, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { sha256Hex } from '@/util/hash'
import { codeArtifacts } from '@/db/schema'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'

/** Where an artifact's keep-alive ref lives. */
export function artifactKeepRef(artifactId: string): string {
  // Under `refs/aw/` rather than `refs/heads/` so it never appears as a branch
  // in anyone's tooling, and never gets pushed by a `--all`.
  return `refs/aw/artifacts/${artifactId}`
}

/**
 * The identity of a change.
 *
 * Line endings are normalised first: the same edit produced on Windows and on
 * Linux would otherwise digest differently, and the platform would offer the
 * same fix twice as if they were two.
 */
export function digestOfDiff(diff: string): string {
  return sha256Hex(diff.replace(/\r\n/g, '\n'))
}

export interface FreezeArtifactArgs {
  db: DbClient
  git: GitPort
  repoPath: string
  worktreePath: string
  baseSha: string
  /** Commit subject; what a person sees in `git log` after it is pushed. */
  message: string
  roundId?: string
  workItemId?: string
  generation?: number
  authorName?: string
  authorEmail?: string
  now?: number
}

export interface FrozenArtifact {
  id: string
  commitSha: string
  digest: string
  diff: string
  baseSha: string
  keepRef: string
}

export type FreezeResult =
  | { ok: true; artifact: FrozenArtifact }
  /** The agent changed nothing. Not a failure — there is just nothing to show. */
  | { ok: false; reason: 'no-changes' }
  | { ok: false; reason: 'failed'; error: string }

/**
 * Commit the worktree as it stands and record it as an artifact.
 *
 * The ref is written before the row, and the row is what the rest of the system
 * reads. If the process dies between them the object is pinned by a ref nobody
 * knows about — which `reclaimOrphanRefs` exists to sweep up, and which is the
 * safe direction to fail: a leaked object costs disk, a collected one costs the
 * human's confirmation.
 */
export async function freezeArtifact(args: FreezeArtifactArgs): Promise<FreezeResult> {
  const now = args.now ?? Date.now()
  const id = ulid()
  const keepRef = artifactKeepRef(id)

  const committed = await args.git.commitWorktree({
    repoPath: args.repoPath,
    worktreePath: args.worktreePath,
    message: args.message,
    keepRef,
    ...(args.authorName === undefined ? {} : { authorName: args.authorName }),
    ...(args.authorEmail === undefined ? {} : { authorEmail: args.authorEmail }),
  })
  if (!committed.ok) {
    return committed.reason === 'no-changes'
      ? { ok: false, reason: 'no-changes' }
      : { ok: false, reason: 'failed', error: committed.error }
  }

  const read = await args.git.readCommitDiff({
    repoPath: args.repoPath,
    commitSha: committed.commitSha,
  })
  if (!read.ok) {
    // The commit exists but cannot be read, so it can never be shown or
    // verified. Drop the ref rather than leaving a pinned object nobody can
    // ever use.
    await args.git.deleteRef({ repoPath: args.repoPath, ref: keepRef })
    return { ok: false, reason: 'failed', error: read.error }
  }

  const digest = digestOfDiff(read.diff)

  // At most ONE artifact is pending per work item, enforced here rather than
  // sorted out later. Two live diffs on one thread are ambiguous for the
  // person too — "/aw apply" would have no answer to "which one?" — and the
  // older one describes code the newer one has already moved past.
  if (args.workItemId !== undefined) {
    await supersedeLiveArtifacts(args.db, args.git, args.workItemId, now)
  }

  await args.db.insert(codeArtifacts).values({
    id,
    repoPath: args.repoPath,
    commitSha: committed.commitSha,
    baseSha: args.baseSha,
    digest,
    keepRef,
    ...(args.roundId === undefined ? {} : { roundId: args.roundId }),
    ...(args.workItemId === undefined ? {} : { workItemId: args.workItemId }),
    generation: args.generation ?? 1,
    // One reference from the moment it is frozen: the thread it is posted to.
    // Starting at zero would make it collectable before it has been shown.
    refCount: 1,
    state: 'live',
    createdAt: now,
  })

  return {
    ok: true,
    artifact: {
      id,
      commitSha: committed.commitSha,
      digest,
      diff: read.diff,
      baseSha: args.baseSha,
      keepRef,
    },
  }
}

export interface ArtifactRow {
  id: string
  repoPath: string
  commitSha: string
  baseSha: string
  digest: string
  keepRef: string
  workItemId: string | null
  generation: number
  refCount: number
  state: string
}

/** Find a live artifact by the digest a comment carried (full or short). */
export async function findLiveArtifactByDigest(
  db: DbClient,
  digestPrefix: string,
): Promise<ArtifactRow | null> {
  const rows = await db.select().from(codeArtifacts).where(eq(codeArtifacts.state, 'live'))
  // Prefix match in code rather than SQL `LIKE`: the input comes from a comment
  // body, and a `LIKE` pattern assembled from it would let `%` match anything.
  const hit = rows.find((row) => row.digest.startsWith(digestPrefix))
  return hit === undefined ? null : toRow(hit)
}

/**
 * The artifact pending on a work item.
 *
 * `freezeArtifact` supersedes the previous one, so there is normally exactly
 * zero or one. The ordering below is the tiebreak for the abnormal case, and it
 * deliberately does NOT rely on the id: `ulid()` draws fresh randomness per
 * call, so two ids minted in the same millisecond sort in random order relative
 * to each other. Sorting by id would then pick the wrong "newest" — which here
 * means pushing a change the person did not confirm.
 */
export async function findPendingArtifact(
  db: DbClient,
  workItemId: string,
): Promise<ArtifactRow | null> {
  const rows = await db
    .select()
    .from(codeArtifacts)
    .where(and(eq(codeArtifacts.workItemId, workItemId), eq(codeArtifacts.state, 'live')))
    .orderBy(desc(codeArtifacts.generation), desc(codeArtifacts.createdAt))
  const newest = rows[0]
  return newest === undefined ? null : toRow(newest)
}

function toRow(row: typeof codeArtifacts.$inferSelect): ArtifactRow {
  return {
    id: row.id,
    repoPath: row.repoPath,
    commitSha: row.commitSha,
    baseSha: row.baseSha,
    digest: row.digest,
    keepRef: row.keepRef,
    workItemId: row.workItemId,
    generation: row.generation,
    refCount: row.refCount,
    state: row.state,
  }
}

/** One more thing needs this artifact. */
export async function retainArtifact(db: DbClient, artifactId: string): Promise<void> {
  await db
    .update(codeArtifacts)
    .set({ refCount: sql`${codeArtifacts.refCount} + 1` })
    .where(eq(codeArtifacts.id, artifactId))
}

export type ReleaseReason = 'consumed' | 'superseded' | 'abandoned'

/**
 * One fewer thing needs this artifact; collect it if that was the last.
 *
 * The ref is deleted only when the count reaches zero, and the row is marked
 * rather than deleted: "this MR had a change proposed and the author never
 * answered" is a question the activity view has to be able to answer after the
 * object is gone.
 */
export async function releaseArtifact(
  db: DbClient,
  git: GitPort,
  artifactId: string,
  reason: ReleaseReason,
  now: number = Date.now(),
): Promise<{ collected: boolean }> {
  const [row] = await db.select().from(codeArtifacts).where(eq(codeArtifacts.id, artifactId))
  if (row === undefined || row.state !== 'live') return { collected: false }

  const remaining = Math.max(0, row.refCount - 1)
  if (remaining > 0) {
    await db
      .update(codeArtifacts)
      .set({ refCount: remaining })
      .where(eq(codeArtifacts.id, artifactId))
    return { collected: false }
  }

  // The ref goes first. If the row update fails afterwards the artifact reads
  // as live with a missing object, which the confirmation path detects and
  // refuses — whereas the reverse order can leave a ref pinned by a row nobody
  // will ever look at again.
  await git.deleteRef({ repoPath: row.repoPath, ref: row.keepRef })
  await db
    .update(codeArtifacts)
    .set({ refCount: 0, state: reason, releasedAt: now })
    .where(eq(codeArtifacts.id, artifactId))
  return { collected: true }
}

/**
 * Invalidate every live artifact of a work item below a generation.
 *
 * Called when the branch moves: everything computed against the old code is now
 * describing something that no longer exists, and leaving it live means a
 * confirmation could still name it.
 */
export async function supersedeArtifacts(
  db: DbClient,
  git: GitPort,
  workItemId: string,
  generation: number,
  now: number = Date.now(),
): Promise<{ superseded: string[] }> {
  const rows = await db
    .select()
    .from(codeArtifacts)
    .where(
      and(
        eq(codeArtifacts.workItemId, workItemId),
        eq(codeArtifacts.state, 'live'),
        lte(codeArtifacts.generation, generation),
      ),
    )

  return { superseded: await supersedeRows(db, git, rows, now) }
}

/**
 * Invalidate every live artifact of a work item, whatever its generation.
 *
 * Used when a NEW artifact is frozen for the same item: the replacement makes
 * the previous one unapplicable regardless of which generation it belonged to.
 */
async function supersedeLiveArtifacts(
  db: DbClient,
  git: GitPort,
  workItemId: string,
  now: number,
): Promise<void> {
  const rows = await db
    .select()
    .from(codeArtifacts)
    .where(and(eq(codeArtifacts.workItemId, workItemId), eq(codeArtifacts.state, 'live')))
  await supersedeRows(db, git, rows, now)
}

async function supersedeRows(
  db: DbClient,
  git: GitPort,
  rows: readonly (typeof codeArtifacts.$inferSelect)[],
  now: number,
): Promise<string[]> {
  const superseded: string[] = []
  for (const row of rows) {
    await git.deleteRef({ repoPath: row.repoPath, ref: row.keepRef })
    await db
      .update(codeArtifacts)
      .set({ refCount: 0, state: 'superseded', releasedAt: now })
      .where(eq(codeArtifacts.id, row.id))
    superseded.push(row.id)
  }
  return superseded
}
