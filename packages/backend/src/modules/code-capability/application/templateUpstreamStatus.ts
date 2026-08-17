// RFC-309 T16 — the upstream link, connected to something.
//
// `domain/templateUpstream.ts` has been correct and unreachable since RFC-304:
// four states, a three-way diff and a safe merge, with no production caller.
// This file is the join. It reads the two rows, feeds the pure functions, and
// turns their answer into what a person can act on.
//
// ## Why this matters more after the merge than before
//
// RFC-309 removed the shared department framework, so "everyone runs the same
// scripts" is no longer a fact about the data model — it is a fact about where
// people copied from. The upstream link is the only record of that, and an
// upstream fix reaches a copy only if somebody is TOLD there is one.
//
// ## The base snapshot, and what happens without it
//
// A three-way merge needs the values as they were at copy time. Copies made
// before 0175 have only a digest, which answers "was this edited" but not
// "which field did WE change". Rather than invent a base — every plausible
// guess silently discards somebody's edit — a template with no base recorded
// reports every difference as a `conflict`. That is the honest degradation: it
// still shows what upstream changed, and it never applies anything on its own.

import { eq } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { capabilityTemplates } from '@/db/schema'
import {
  judgeUpstream,
  mergeUnoverridden,
  resolveThreeWay,
  type FieldResolution,
  type UpstreamStatus,
} from '@/modules/code-capability/domain/templateUpstream'
import {
  mayReadScripts,
  mergeableSnapshot,
  templateDigest,
  MERGEABLE_FIELDS,
  type MergeableField,
} from '@/services/capabilityTemplates'

type TemplateRow = typeof capabilityTemplates.$inferSelect

export interface UpstreamReport {
  /** Absent when this template was authored here rather than copied. */
  link: { upstreamId: string; upstreamVersion: number } | null
  status: UpstreamStatus | null
  /** The upstream's current name, so the badge can say WHICH template. */
  upstreamName: string | null
  /** Per-field verdicts. Empty when there is no upstream to compare against. */
  fields: readonly FieldResolution[]
  /**
   * False when the copy predates the base snapshot. The UI says so rather than
   * offering a merge whose result it cannot predict.
   */
  baseRecorded: boolean
}

/**
 * Where this template stands relative to what it was copied from.
 *
 * Returns a null status — not an error — for a template that was authored
 * rather than copied. "No upstream" is the normal case for an original, and
 * making the caller handle an error for it would put a failure path on the
 * common one.
 */
export async function readUpstreamReport(db: DbClient, row: TemplateRow): Promise<UpstreamReport> {
  if (row.upstreamId === null || row.upstreamVersion === null || row.baseDigest === null) {
    return { link: null, status: null, upstreamName: null, fields: [], baseRecorded: false }
  }

  const link = { upstreamId: row.upstreamId, upstreamVersion: row.upstreamVersion }
  const upstream = await getRow(db, row.upstreamId)
  const local = mergeableSnapshot(row)
  const base = readBase(row)

  if (upstream === null) {
    // Orphaned. No comparison is possible and none is offered — reporting
    // fields here would invite a merge against a row that is gone.
    return {
      link,
      status: judgeUpstream({
        link: { ...link, baseDigest: row.baseDigest },
        upstreamVersionNow: null,
        localDigest: templateDigest(row),
        localOverrides: base === null ? [] : changedFields(base, local),
      }),
      upstreamName: null,
      fields: [],
      baseRecorded: base !== null,
    }
  }

  const upstreamNow = mergeableSnapshot(upstream)
  const fields = resolveThreeWay(
    MERGEABLE_FIELDS.map((field) => ({
      field,
      // With no recorded base, the stand-in is a value equal to NEITHER side.
      // `resolveThreeWay` then reads both as changed, which lands on
      // `conflict` for every real difference and `unchanged` wherever the two
      // already agree — the honest answer when we cannot prove who moved.
      // Standing in with LOCAL would be the tempting alternative and it is
      // wrong in the dangerous direction: every difference would read
      // `take-upstream` and a merge would silently overwrite local edits.
      base: base === null ? NO_BASE : base[field],
      upstream: upstreamNow[field],
      local: local[field],
    })),
  )

  return {
    link,
    status: judgeUpstream({
      link: { ...link, baseDigest: row.baseDigest },
      upstreamVersionNow: upstream.updatedAt,
      localDigest: templateDigest(row),
      localOverrides: fields
        .filter((f) => f.action === 'keep-local' || f.action === 'conflict')
        .map((f) => f.field),
    }),
    upstreamName: upstream.name,
    fields,
    baseRecorded: base !== null,
  }
}

export interface MergeOutcome {
  applied: readonly string[]
  keptLocal: readonly string[]
  stillConflicted: readonly string[]
}

/**
 * Take everything upstream changed that we did not, and nothing else.
 *
 * Conflicts are deliberately left as they are. Applying one would discard the
 * local change that was the reason for copying; there is no safe automatic
 * answer, which is why the domain function has never had a `force` flag.
 *
 * ## Where the new base comes from, which took two tries to get right
 *
 * The obvious move — record the merged LOCAL row as the new base — is wrong,
 * and wrong in a way that only shows up on the second read. A field we
 * deliberately kept would then have a base equal to our value and an upstream
 * still holding theirs, so the next comparison reads it as "upstream changed
 * this, we did not" and offers to undo the very override we just protected.
 *
 * The base is a common ANCESTOR, so it has to move to UPSTREAM's values —
 * except on the fields still in conflict, which keep the old base precisely so
 * they stay in conflict. Advancing them would resolve, silently and in
 * upstream's favour, exactly the disagreements a person was asked to settle.
 *
 * `upstreamVersion` moves only when nothing is left in conflict, for the same
 * reason: with an outstanding conflict the copy is not up to date, and saying
 * `current` would retire the badge with the disagreement still open.
 */
export async function mergeFromUpstream(
  db: DbClient,
  row: TemplateRow,
  actor: Actor,
  now: number = Date.now(),
): Promise<
  | { ok: false; code: 'no-upstream' | 'upstream-gone' | 'scripts-forbidden' }
  | ({ ok: true } & MergeOutcome)
> {
  // The hole this closes: a merge applies upstream's `scripts`, and scripts run
  // as the daemon. Without this, "update from upstream" would be a way to
  // install a script body without the grant authoring one requires — pick an
  // upstream whose scripts you like, press update. Checked HERE rather than at
  // the route so a second caller cannot become a way around it, exactly as
  // `assertTemplateFieldsAllowed` is checked in the service.
  if (!mayReadScripts(actor)) return { ok: false, code: 'scripts-forbidden' }
  if (row.upstreamId === null || row.upstreamVersion === null)
    return { ok: false, code: 'no-upstream' }
  const upstream = await getRow(db, row.upstreamId)
  if (upstream === null) return { ok: false, code: 'upstream-gone' }

  const report = await readUpstreamReport(db, row)
  const outcome = mergeUnoverridden(report.fields)
  const taken = new Map(
    report.fields
      .filter((f): f is Extract<FieldResolution, { action: 'take-upstream' }> => {
        return f.action === 'take-upstream'
      })
      .map((f) => [f.field, f.value]),
  )

  // Nothing to take is a genuine no-op, written as one. A merge that took
  // nothing but still advanced the base would resolve every conflict by
  // forgetting it — and that is the state a copy with no recorded base is
  // always in, which is why that case must not reach a write at all.
  if (taken.size === 0) return { ok: true, ...outcome }

  const next = { ...row }
  for (const [field, value] of taken) {
    writeField(next, field as MergeableField, value)
  }

  const oldBase = readBase(row)
  const upstreamNow = mergeableSnapshot(upstream)
  const conflicted = new Set(outcome.stillConflicted)
  const newBase: Record<string, unknown> = {}
  for (const field of MERGEABLE_FIELDS) {
    newBase[field] = conflicted.has(field) ? (oldBase?.[field] ?? null) : upstreamNow[field]
  }

  next.baseSnapshotJson = JSON.stringify(newBase)
  next.baseDigest = templateDigest(next)
  if (conflicted.size === 0) next.upstreamVersion = upstream.updatedAt
  next.updatedAt = now

  await db.update(capabilityTemplates).set(next).where(eq(capabilityTemplates.id, row.id))
  return { ok: true, ...outcome }
}

/**
 * A sentinel that equals neither side, used as the base when none was recorded.
 *
 * Deliberately a value no template field can hold, so it can never accidentally
 * compare equal to a real one and turn a genuine conflict into `take-upstream`.
 */
const NO_BASE = Symbol('no-base-recorded')

function readBase(row: TemplateRow): Record<MergeableField, unknown> | null {
  if (row.baseSnapshotJson === null) return null
  try {
    const parsed: unknown = JSON.parse(row.baseSnapshotJson)
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed as Record<MergeableField, unknown>
  } catch {
    return null
  }
}

function changedFields(
  base: Record<MergeableField, unknown>,
  local: Record<MergeableField, unknown>,
): string[] {
  return MERGEABLE_FIELDS.filter((f) => JSON.stringify(base[f]) !== JSON.stringify(local[f]))
}

function writeField(row: TemplateRow, field: MergeableField, value: unknown): void {
  switch (field) {
    case 'description':
      row.description = typeof value === 'string' ? value : null
      return
    case 'scripts':
      row.scriptsJson = JSON.stringify(value ?? {})
      return
    case 'hooks':
      row.hooksJson = JSON.stringify(value ?? [])
      return
    case 'paramSchema':
      row.paramSchemaJson = JSON.stringify(value ?? [])
      return
    case 'paramDefaults':
      row.paramDefaultsJson = JSON.stringify(value ?? {})
      return
    case 'agentBySlot':
      row.agentBySlotJson = JSON.stringify(value ?? {})
      return
    case 'promptBySlot':
      row.promptBySlotJson = JSON.stringify(value ?? {})
      return
    case 'params':
      row.paramsJson = JSON.stringify(value ?? {})
      return
    case 'stageContractVer':
      row.stageContractVer = typeof value === 'number' ? value : row.stageContractVer
      return
  }
}

async function getRow(db: DbClient, id: string): Promise<TemplateRow | null> {
  return (
    (
      await db.select().from(capabilityTemplates).where(eq(capabilityTemplates.id, id)).limit(1)
    )[0] ?? null
  )
}
