// RFC-019: client-side pure helpers for the ZIP import flow. Kept separate
// from the React component so they're easy to unit-test.

import { SKILL_NAME_RE, SKILL_ZIP_LIMITS } from '@agent-workflow/shared'
import type {
  CommitSkillZipResponse,
  ParseSkillZipResponse,
  SkillZipCandidateView,
  SkillZipDecisionMap,
} from '@agent-workflow/shared'

export type DecisionAction = 'import' | 'skip' | 'overwrite' | 'rename'

export interface DecisionState {
  action: DecisionAction
  /** Only meaningful when action === 'rename'. */
  newName: string
  /** Immutable existing-resource identity; only meaningful for overwrite. */
  overwriteSkillId: string
}

export interface RowState {
  /** Original candidate name from parse response. */
  candidate: SkillZipCandidateView
  decision: DecisionState
}

/**
 * Compute the initial decision per candidate row when a parse response comes
 * in: no conflict → import; any conflict → skip (safer than overwrite). The
 * user can switch to rename always, and to overwrite only when the preview
 * supplied at least one exact target (see availableActionsFor).
 */
export function initialDecisionFor(c: SkillZipCandidateView): DecisionState {
  const overwriteSkillId =
    c.overwriteCandidates.length === 1 ? c.overwriteCandidates[0]!.skillId : ''
  if (c.conflict === undefined) return { action: 'import', newName: '', overwriteSkillId }
  return { action: 'skip', newName: '', overwriteSkillId }
}

/**
 * RFC-102: actions offered for a candidate row, gated by conflict + write
 * exact preview targets.
 *   no own conflict, no target → import / skip
 *   no own conflict + target   → import / skip / overwrite (resource admin)
 *   own conflict + target      → skip / overwrite / rename
 *   own conflict, no target    → skip / rename (hidden/unavailable target)
 */
export function availableActionsFor(c: SkillZipCandidateView): DecisionAction[] {
  if (c.conflict === undefined) {
    return c.overwriteCandidates.length > 0 ? ['import', 'skip', 'overwrite'] : ['import', 'skip']
  }
  if (c.conflict === 'managed' && c.overwriteCandidates.length > 0) {
    return ['skip', 'overwrite', 'rename']
  }
  return ['skip', 'rename']
}

export interface RenameValidation {
  ok: boolean
  reason?: 'invalid' | 'duplicate-in-batch' | 'conflict-with-db' | 'empty'
}

/**
 * Validate a proposed rename target against:
 *   - kebab-case regex
 *   - other rename targets in the same batch (no two renames to the same name)
 *   - existing skills (the DB conflict info known from /api/skills)
 */
export function validateRenameTarget(
  newName: string,
  selfCandidateName: string,
  allRows: RowState[],
  existingSkillNames: ReadonlySet<string>,
): RenameValidation {
  if (newName.length === 0) return { ok: false, reason: 'empty' }
  if (!SKILL_NAME_RE.test(newName)) return { ok: false, reason: 'invalid' }
  if (existingSkillNames.has(newName)) return { ok: false, reason: 'conflict-with-db' }
  for (const row of allRows) {
    if (row.candidate.name === selfCandidateName) continue
    const target = effectiveTargetName(row)
    if (target === newName) return { ok: false, reason: 'duplicate-in-batch' }
  }
  return { ok: true }
}

/**
 * The skill name a row will land on after commit. Skip → null (won't write).
 */
export function effectiveTargetName(row: RowState): string | null {
  if (row.decision.action === 'skip') return null
  if (row.decision.action === 'rename') return row.decision.newName
  return row.candidate.name
}

/**
 * Build the decisions map to POST to /api/skills/import-zip/commit. Rows
 * with invalid rename targets are filtered out (caller's `submitDisabled`
 * should prevent that case anyway).
 */
export function buildDecisionMap(rows: RowState[]): SkillZipDecisionMap {
  const out: SkillZipDecisionMap = {}
  for (const row of rows) {
    const d = row.decision
    if (d.action === 'skip') {
      out[row.candidate.name] = { action: 'skip' }
    } else if (d.action === 'overwrite') {
      const target = row.candidate.overwriteCandidates.find(
        (candidate) => candidate.skillId === d.overwriteSkillId,
      )
      if (target === undefined) continue
      out[row.candidate.name] = {
        action: 'overwrite',
        skillId: target.skillId,
        expectedOwnerUserId: target.ownerUserId,
        expectedVisibility: target.visibility,
        expectedAclRevision: target.expectedAclRevision,
        expectedToken: target.expectedToken,
      }
    } else if (d.action === 'rename') {
      if (d.newName.length === 0) continue
      out[row.candidate.name] = { action: 'rename', newName: d.newName }
    } else {
      out[row.candidate.name] = { action: 'import' }
    }
  }
  return out
}

/** Summary line: "Will import N, overwrite M, skip K". Used in import button. */
export interface RowsSummary {
  importing: number
  overwriting: number
  renaming: number
  skipping: number
  total: number
}

export function summarizeRows(rows: RowState[]): RowsSummary {
  let importing = 0
  let overwriting = 0
  let renaming = 0
  let skipping = 0
  for (const row of rows) {
    switch (row.decision.action) {
      case 'import':
        importing++
        break
      case 'overwrite':
        overwriting++
        break
      case 'rename':
        renaming++
        break
      case 'skip':
        skipping++
        break
    }
  }
  return { importing, overwriting, renaming, skipping, total: rows.length }
}

export function rowsFromParseResponse(resp: ParseSkillZipResponse): RowState[] {
  return resp.skills.map((c) => ({
    candidate: c,
    decision: initialDecisionFor(c),
  }))
}

export type SkillZipFileCheck =
  | { ok: true; file: File }
  | { ok: false; reason: 'type' | 'too-large' }

/** Cheap browser-side feedback; the backend still owns all archive safety checks. */
export function validateSkillZipFile(file: File): SkillZipFileCheck {
  if (!file.name.toLowerCase().endsWith('.zip')) return { ok: false, reason: 'type' }
  if (file.size > SKILL_ZIP_LIMITS.totalBytes) return { ok: false, reason: 'too-large' }
  return { ok: true, file }
}

export interface ReviewSummary {
  candidates: number
  conflicts: number
  readonlyConflicts: number
  archiveErrors: number
}

export function deriveReviewSummary(parse: ParseSkillZipResponse): ReviewSummary {
  return {
    candidates: parse.skills.length,
    conflicts: parse.skills.filter((candidate) => candidate.conflict !== undefined).length,
    readonlyConflicts: parse.skills.filter(
      (candidate) => candidate.conflict !== undefined && candidate.overwriteCandidates.length === 0,
    ).length,
    archiveErrors: parse.errors.length,
  }
}

export interface ExistingNamesState {
  /** True after at least one successful names response, including cached data. */
  available: boolean
  names: ReadonlySet<string>
}

export interface SubmitState {
  enabled: boolean
  reason?:
    | 'nothing-selected'
    | 'rename-invalid'
    | 'names-unavailable'
    | 'overwrite-target-required'
    | 'busy'
  counts: RowsSummary
}

export function deriveSubmitState(
  rows: RowState[],
  existingNames: ExistingNamesState,
  busy: boolean,
): SubmitState {
  const counts = summarizeRows(rows)
  if (busy) return { enabled: false, reason: 'busy', counts }

  const selected = counts.importing + counts.overwriting + counts.renaming
  if (selected === 0) return { enabled: false, reason: 'nothing-selected', counts }

  if (
    rows.some(
      (row) =>
        row.decision.action === 'overwrite' &&
        !row.candidate.overwriteCandidates.some(
          (candidate) => candidate.skillId === row.decision.overwriteSkillId,
        ),
    )
  ) {
    return { enabled: false, reason: 'overwrite-target-required', counts }
  }

  const renameRows = rows.filter((row) => row.decision.action === 'rename')
  if (renameRows.length > 0 && !existingNames.available) {
    return { enabled: false, reason: 'names-unavailable', counts }
  }
  if (
    renameRows.some(
      (row) =>
        !validateRenameTarget(row.decision.newName, row.candidate.name, rows, existingNames.names)
          .ok,
    )
  ) {
    return { enabled: false, reason: 'rename-invalid', counts }
  }
  return { enabled: true, counts }
}

export type ResultKind = 'success' | 'partial' | 'no-write'

export function resultKind(summary: CommitSkillZipResponse): ResultKind {
  const written = summary.created.length + summary.updated.length
  if (written === 0) return 'no-write'
  return summary.failed.length > 0 ? 'partial' : 'success'
}
