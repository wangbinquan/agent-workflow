// RFC-223 AC10 — ACL-aware portable selector resolution for import boundaries.
//
// This is intentionally the only production service that may turn a resource
// name into a persisted id after owner-scoped uniqueness is enabled. Ordinary
// CRUD accepts canonical ids only.

import {
  importRefSelectorKey,
  type AgentSkillRef,
  type ImportRefAmbiguity,
  type ImportRefCandidate,
  type ImportRefSelection,
  type ImportRefSelector,
  type ImportRefType,
  type ResolveAgentImportRefsRequest,
  type ResolveAgentImportRefsResult,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { type DbTxSync, dbTxSync } from '@/db/txSync'
import { resourceGrants, users } from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'
import { ACL_TABLES, isResourceAdminActor, isVisibleRow } from './resourceAcl'

interface ImportRefRow {
  id: string
  name: string
  ownerUserId: string | null
  visibility: 'private' | 'public'
  aclRevision: number
}

interface ImportRefCandidateSnapshot {
  candidate: ImportRefCandidate
  name: string
  grantedToActor: boolean
}

interface ImportRefResolutionFenceEntry {
  selector: ImportRefSelector
  selectedId: string
  selectedExplicitly: boolean
  candidates: ImportRefCandidateSnapshot[]
}

export interface ImportRefResolutionFence {
  entries: ImportRefResolutionFenceEntry[]
}

export interface ResolvedImportRefs {
  bySelector: Map<string, string>
  selections: ImportRefSelection[]
  /**
   * Internal check-to-write fence. Import writers must re-check this inside
   * the same synchronous transaction as their final persistence statement.
   */
  fence: ImportRefResolutionFence
}

export async function resolveAgentImportRefs(
  db: DbClient,
  actor: Actor,
  request: ResolveAgentImportRefsRequest,
): Promise<ResolveAgentImportRefsResult> {
  const selectors: ImportRefSelector[] = [
    ...(request.dependsOn ?? []).map((name) => ({ type: 'agent' as const, name })),
    ...(request.mcp ?? []).map((name) => ({ type: 'mcp' as const, name })),
    ...(request.plugins ?? []).map((name) => ({ type: 'plugin' as const, name })),
    ...(request.skills ?? [])
      .filter((selector) => selector.kind === 'managed')
      .map((selector) => ({
        type: 'skill' as const,
        name: selector.name,
        ownerUsername: selector.ownerUsername,
      })),
  ]
  const resolved = await resolveImportRefs(db, actor, selectors, request.selections)

  const resolveNames = (
    type: Exclude<ImportRefType, 'skill'>,
    names: readonly string[] | undefined,
  ): string[] | undefined =>
    names?.map((name) => {
      const id = resolved.bySelector.get(importRefSelectorKey({ type, name }))
      if (id === undefined) {
        throw new ValidationError('import-ref-unresolved', 'imported reference did not resolve')
      }
      return id
    })

  let skills: AgentSkillRef[] | undefined
  if (request.skills !== undefined) {
    skills = request.skills.map((selector) => {
      if (selector.kind === 'project') return { kind: 'project', name: selector.name }
      const importSelector: ImportRefSelector = {
        type: 'skill',
        name: selector.name,
        ownerUsername: selector.ownerUsername,
      }
      const id = resolved.bySelector.get(importRefSelectorKey(importSelector))
      if (id === undefined) {
        throw new ValidationError(
          'import-ref-unresolved',
          'imported skill reference did not resolve',
        )
      }
      return { kind: 'managed', skillId: id }
    })
  }

  return {
    dependsOn: resolveNames('agent', request.dependsOn),
    mcp: resolveNames('mcp', request.mcp),
    plugins: resolveNames('plugin', request.plugins),
    skills,
  }
}

/**
 * Resolve selectors against the actor's RFC-099 usable universe
 * (owner/public/grant/admin). Invisible rows behave exactly like missing rows.
 *
 * Zero visible matches is a stable 422. Multiple visible matches is a 409
 * carrying only visible candidate metadata. A second request must select a
 * candidate by stable id; the whole candidate set and ACL are re-read, so a
 * rename/transfer/visibility race fails closed instead of rebinding by name.
 */
export async function resolveImportRefs(
  db: DbClient,
  actor: Actor,
  selectors: readonly ImportRefSelector[],
  requestedSelections: readonly ImportRefSelection[] = [],
): Promise<ResolvedImportRefs> {
  // Candidate rows, the actor's fresh grants, and owner usernames must be one
  // coherent SQLite snapshot. Splitting these reads across awaits can combine
  // a pre-transfer row with post-transfer ACL/username metadata.
  return dbTxSync(db, (tx) => resolveImportRefsInTx(tx, actor, selectors, requestedSelections))
}

/**
 * Re-check a successful resolution at the workflow import commit point.
 *
 * Ordering is security-significant:
 *   1. load every selected id and re-evaluate visibility from fresh grants;
 *      missing and invisible are the same unresolved shape;
 *   2. only then compare selector/candidate/name/owner/visibility/ACL fences.
 *
 * Call this only from an existing dbTxSync body immediately before the final
 * INSERT/UPDATE. It performs no async work and never opens a nested
 * transaction.
 */
export function assertImportRefsStableInTx(
  tx: DbTxSync,
  actor: Actor,
  fence: ImportRefResolutionFence,
): void {
  if (fence.entries.length === 0) return

  assertSelectedIdsVisibleInTx(tx, actor, fence.entries)

  const selectors = fence.entries.map((entry) => entry.selector)
  const currentBySelector = buildCandidateSnapshotsInTx(tx, actor, selectors)
  const newlyAmbiguous: ImportRefAmbiguity[] = []
  const stale: ImportRefAmbiguity[] = []
  for (const entry of fence.entries) {
    const key = importRefSelectorKey(entry.selector)
    const current = currentBySelector.get(key) ?? []
    if (
      current.some((candidate) => candidate.candidate.id === entry.selectedId) &&
      candidateSnapshotsEqual(entry.candidates, current)
    ) {
      continue
    }
    if (!entry.selectedExplicitly && current.length > 1) {
      newlyAmbiguous.push({
        selector: entry.selector,
        candidates: current.map((snapshot) => snapshot.candidate),
      })
      continue
    }
    stale.push({
      selector: entry.selector,
      // Returning the complete *current visible* set lets the UI discard the
      // stale selection and require an explicit second confirmation. It may be
      // empty after a rename; no hidden row metadata is ever included.
      candidates: current.map((snapshot) => snapshot.candidate),
    })
  }
  if (newlyAmbiguous.length > 0) {
    throw new ConflictError(
      'import-ref-ambiguous',
      'one or more imported references match multiple available resources',
      { ambiguities: newlyAmbiguous },
    )
  }
  if (stale.length > 0) throw staleSelections(stale)
}

function resolveImportRefsInTx(
  tx: DbTxSync,
  actor: Actor,
  selectors: readonly ImportRefSelector[],
  requestedSelections: readonly ImportRefSelection[],
): ResolvedImportRefs {
  const uniqueSelectors = dedupeSelectors(selectors)
  if (uniqueSelectors.length === 0) {
    return { bySelector: new Map(), selections: [], fence: { entries: [] } }
  }

  const requestedBySelector = new Map(
    requestedSelections.map((selection) => [
      importRefSelectorKey(selection.selector),
      {
        resourceId: selection.resourceId,
        expectedAclRevision: selection.expectedAclRevision,
      },
    ]),
  )
  assertSelectedIdsVisibleInTx(
    tx,
    actor,
    uniqueSelectors.flatMap((selector) => {
      const requested = requestedBySelector.get(importRefSelectorKey(selector))
      return requested === undefined ? [] : [{ selector, selectedId: requested.resourceId }]
    }),
  )
  const candidatesBySelector = buildCandidateSnapshotsInTx(tx, actor, uniqueSelectors)

  const unresolved = uniqueSelectors.filter((selector) => {
    const key = importRefSelectorKey(selector)
    return (
      requestedBySelector.get(key) === undefined &&
      (candidatesBySelector.get(key) ?? []).length === 0
    )
  })
  if (unresolved.length > 0) {
    throw unresolvedReferences(unresolved)
  }

  const ambiguities: ImportRefAmbiguity[] = []
  const bySelector = new Map<string, string>()
  const selections: ImportRefSelection[] = []
  const fenceEntries: ImportRefResolutionFenceEntry[] = []
  for (const selector of uniqueSelectors) {
    const key = importRefSelectorKey(selector)
    const snapshots = candidatesBySelector.get(key) ?? []
    const candidates = snapshots.map((snapshot) => snapshot.candidate)
    const requested = requestedBySelector.get(key)
    if (candidates.length === 1) {
      if (
        requested !== undefined &&
        (requested.resourceId !== candidates[0]!.id ||
          requested.expectedAclRevision !== candidates[0]!.aclRevision)
      ) {
        throw staleSelection(selector, candidates)
      }
      bySelector.set(key, candidates[0]!.id)
      selections.push({
        selector,
        resourceId: candidates[0]!.id,
        expectedAclRevision: candidates[0]!.aclRevision,
      })
      fenceEntries.push({
        selector,
        selectedId: candidates[0]!.id,
        selectedExplicitly: requested !== undefined,
        candidates: snapshots,
      })
      continue
    }
    if (requested === undefined) {
      ambiguities.push({ selector, candidates })
      continue
    }
    const requestedId = requested.resourceId
    const selectedCandidate = candidates.find((candidate) => candidate.id === requestedId)
    if (selectedCandidate === undefined) {
      throw staleSelection(selector, candidates)
    }
    if (selectedCandidate.aclRevision !== requested.expectedAclRevision) {
      throw staleSelection(selector, candidates)
    }
    bySelector.set(key, requestedId)
    selections.push({
      selector,
      resourceId: requestedId,
      expectedAclRevision: selectedCandidate.aclRevision,
    })
    fenceEntries.push({
      selector,
      selectedId: requestedId,
      selectedExplicitly: true,
      candidates: snapshots,
    })
  }

  if (ambiguities.length > 0) {
    throw new ConflictError(
      'import-ref-ambiguous',
      'one or more imported references match multiple available resources',
      { ambiguities },
    )
  }
  return { bySelector, selections, fence: { entries: fenceEntries } }
}

function assertSelectedIdsVisibleInTx(
  tx: DbTxSync,
  actor: Actor,
  entries: readonly {
    selector: ImportRefSelector
    selectedId: string
  }[],
): void {
  const invisibleSelectors: ImportRefSelector[] = []
  for (const type of new Set(entries.map((entry) => entry.selector.type))) {
    const typeEntries = entries.filter((entry) => entry.selector.type === type)
    const selectedIds = [...new Set(typeEntries.map((entry) => entry.selectedId))]
    const table = ACL_TABLES[type]
    const selectedRows = tx
      .select({
        id: table.id,
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
        aclRevision: table.aclRevision,
      })
      .from(table)
      .where(inArray(table.id, selectedIds))
      .all() as ImportRefRow[]
    const grantedIds = grantedIdsInTx(tx, actor, type)
    const visibleSelectedIds = new Set(
      selectedRows.filter((row) => isVisibleRow(actor, row, grantedIds)).map((row) => row.id),
    )
    for (const entry of typeEntries) {
      if (!visibleSelectedIds.has(entry.selectedId)) invisibleSelectors.push(entry.selector)
    }
  }
  if (invisibleSelectors.length > 0) throw unresolvedReferences(invisibleSelectors)
}

function buildCandidateSnapshotsInTx(
  tx: DbTxSync,
  actor: Actor,
  selectors: readonly ImportRefSelector[],
): Map<string, ImportRefCandidateSnapshot[]> {
  const candidatesBySelector = new Map<string, ImportRefCandidateSnapshot[]>()
  for (const type of new Set(selectors.map((selector) => selector.type))) {
    const typeSelectors = selectors.filter((selector) => selector.type === type)
    const names = [...new Set(typeSelectors.map((selector) => selector.name))]
    const table = ACL_TABLES[type]
    const rows = tx
      .select({
        id: table.id,
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
        aclRevision: table.aclRevision,
      })
      .from(table)
      .where(inArray(table.name, names))
      .all() as ImportRefRow[]
    const grantedIds = grantedIdsInTx(tx, actor, type)
    const visible = rows.filter((row) => isVisibleRow(actor, row, grantedIds))
    const ownerIds = [
      ...new Set(
        visible
          .map((row) => row.ownerUserId)
          .filter((ownerUserId): ownerUserId is string => ownerUserId !== null),
      ),
    ]
    const ownerRows =
      ownerIds.length === 0
        ? []
        : tx
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.id, ownerIds))
            .all()
    const usernameById = new Map(ownerRows.map((row) => [row.id, row.username]))

    for (const selector of typeSelectors) {
      const matches = visible
        .filter(
          (row) =>
            row.name === selector.name &&
            (selector.ownerUsername === undefined ||
              (row.ownerUserId !== null &&
                ownerUsernameFor(row.ownerUserId, usernameById) === selector.ownerUsername)),
        )
        .map(
          (row): ImportRefCandidateSnapshot => ({
            candidate: {
              id: row.id,
              ownerUserId: row.ownerUserId,
              ownerUsername:
                row.ownerUserId === null ? null : (usernameById.get(row.ownerUserId) ?? null),
              visibility: row.visibility,
              aclRevision: row.aclRevision,
            },
            name: row.name,
            grantedToActor: grantedIds.has(row.id),
          }),
        )
        .sort((a, b) => a.candidate.id.localeCompare(b.candidate.id))
      candidatesBySelector.set(importRefSelectorKey(selector), matches)
    }
  }
  return candidatesBySelector
}

function grantedIdsInTx(tx: DbTxSync, actor: Actor, type: ImportRefType): ReadonlySet<string> {
  if (isResourceAdminActor(actor)) return new Set()
  const rows = tx
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, actor.user.id)))
    .all()
  return new Set(rows.map((row) => row.resourceId))
}

function candidateSnapshotsEqual(
  expected: readonly ImportRefCandidateSnapshot[],
  current: readonly ImportRefCandidateSnapshot[],
): boolean {
  if (expected.length !== current.length) return false
  return expected.every((candidate, index) => {
    const other = current[index]
    return (
      other !== undefined &&
      candidate.candidate.id === other.candidate.id &&
      candidate.name === other.name &&
      candidate.candidate.ownerUserId === other.candidate.ownerUserId &&
      candidate.candidate.ownerUsername === other.candidate.ownerUsername &&
      candidate.candidate.visibility === other.candidate.visibility &&
      candidate.candidate.aclRevision === other.candidate.aclRevision &&
      candidate.grantedToActor === other.grantedToActor
    )
  })
}

function ownerUsernameFor(
  ownerUserId: string,
  usernameById: ReadonlyMap<string, string>,
): string | undefined {
  return ownerUserId === SYSTEM_USER_ID ? SYSTEM_USER_ID : usernameById.get(ownerUserId)
}

function dedupeSelectors(selectors: readonly ImportRefSelector[]): ImportRefSelector[] {
  const seen = new Set<string>()
  const out: ImportRefSelector[] = []
  for (const selector of selectors) {
    const key = importRefSelectorKey(selector)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(selector)
  }
  return out
}

function staleSelection(
  selector: ImportRefSelector,
  candidates: ImportRefCandidate[],
): ConflictError {
  return staleSelections([{ selector, candidates }])
}

function staleSelections(ambiguities: ImportRefAmbiguity[]): ConflictError {
  return new ConflictError(
    'import-ref-selection-stale',
    'the selected import reference is no longer an available candidate',
    {
      selector: ambiguities[0]?.selector,
      ambiguities,
    },
  )
}

function unresolvedReferences(unresolved: ImportRefSelector[]): ValidationError {
  return new ValidationError(
    'import-ref-unresolved',
    'one or more imported references do not resolve to an available resource',
    { unresolved },
  )
}
