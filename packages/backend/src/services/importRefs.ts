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
import { inArray } from 'drizzle-orm'
import { SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'
import { ACL_TABLES, filterVisibleRows } from './resourceAcl'

interface ImportRefRow {
  id: string
  name: string
  ownerUserId: string | null
  visibility: 'private' | 'public'
}

export interface ResolvedImportRefs {
  bySelector: Map<string, string>
  selections: ImportRefSelection[]
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
  const uniqueSelectors = dedupeSelectors(selectors)
  if (uniqueSelectors.length === 0) {
    return { bySelector: new Map(), selections: [] }
  }

  const requestedBySelector = new Map(
    requestedSelections.map((selection) => [
      importRefSelectorKey(selection.selector),
      selection.resourceId,
    ]),
  )
  const candidatesBySelector = new Map<string, ImportRefCandidate[]>()

  for (const type of new Set(uniqueSelectors.map((selector) => selector.type))) {
    const typeSelectors = uniqueSelectors.filter((selector) => selector.type === type)
    const names = [...new Set(typeSelectors.map((selector) => selector.name))]
    const table = ACL_TABLES[type]
    const rows = (await db
      .select({
        id: table.id,
        name: table.name,
        ownerUserId: table.ownerUserId,
        visibility: table.visibility,
      })
      .from(table)
      .where(inArray(table.name, names))) as ImportRefRow[]
    const visible = await filterVisibleRows(db, actor, type, rows)
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
        : await db
            .select({ id: users.id, username: users.username })
            .from(users)
            .where(inArray(users.id, ownerIds))
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
          (row): ImportRefCandidate => ({
            id: row.id,
            ownerUserId: row.ownerUserId,
            ownerUsername:
              row.ownerUserId === null ? null : (usernameById.get(row.ownerUserId) ?? null),
            visibility: row.visibility,
          }),
        )
        .sort((a, b) => a.id.localeCompare(b.id))
      candidatesBySelector.set(importRefSelectorKey(selector), matches)
    }
  }

  const unresolved = uniqueSelectors.filter(
    (selector) => (candidatesBySelector.get(importRefSelectorKey(selector)) ?? []).length === 0,
  )
  if (unresolved.length > 0) {
    throw new ValidationError(
      'import-ref-unresolved',
      'one or more imported references do not resolve to an available resource',
      { unresolved },
    )
  }

  const ambiguities: ImportRefAmbiguity[] = []
  const bySelector = new Map<string, string>()
  const selections: ImportRefSelection[] = []
  for (const selector of uniqueSelectors) {
    const key = importRefSelectorKey(selector)
    const candidates = candidatesBySelector.get(key) ?? []
    const requestedId = requestedBySelector.get(key)
    if (candidates.length === 1) {
      if (requestedId !== undefined && requestedId !== candidates[0]!.id) {
        throw staleSelection(selector, candidates)
      }
      bySelector.set(key, candidates[0]!.id)
      selections.push({ selector, resourceId: candidates[0]!.id })
      continue
    }
    if (requestedId === undefined) {
      ambiguities.push({ selector, candidates })
      continue
    }
    if (!candidates.some((candidate) => candidate.id === requestedId)) {
      throw staleSelection(selector, candidates)
    }
    bySelector.set(key, requestedId)
    selections.push({ selector, resourceId: requestedId })
  }

  if (ambiguities.length > 0) {
    throw new ConflictError(
      'import-ref-ambiguous',
      'one or more imported references match multiple available resources',
      { ambiguities },
    )
  }
  return { bySelector, selections }
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
  return new ConflictError(
    'import-ref-selection-stale',
    'the selected import reference is no longer an available candidate',
    { selector, ambiguities: [{ selector, candidates }] },
  )
}
