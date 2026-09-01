import {
  importRefSelectorKey,
  type AgentSkillRef,
  type ImportRefAmbiguity,
  type ImportRefSelection,
  type ImportRefSelector,
  type ImportRefType,
  type ResolveAgentImportRefsRequest,
  type ResolveAgentImportRefsResult,
} from '@agent-workflow/shared'
import { ConflictError, ValidationError } from '@/util/errors'
import type { AgentOperationContext } from '../../public/participants'
import type { AgentImportQueries } from '../../public/queries'
import type { AgentImportReferenceReadPort } from './importPorts'

function selectionKey(type: ImportRefType, resourceId: string): string {
  return JSON.stringify([type, resourceId])
}

function dedupeSelectors(selectors: readonly ImportRefSelector[]): ImportRefSelector[] {
  const seen = new Set<string>()
  return selectors.filter((selector) => {
    const key = importRefSelectorKey(selector)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function staleSelections(ambiguities: readonly ImportRefAmbiguity[]): ConflictError {
  return new ConflictError(
    'import-ref-selection-stale',
    'the selected import reference is no longer an available candidate',
    {
      selector: ambiguities[0]?.selector,
      ambiguities,
    },
  )
}

function unresolvedReferences(unresolved: readonly ImportRefSelector[]): ValidationError {
  return new ValidationError(
    'import-ref-unresolved',
    'one or more imported references do not resolve to an available resource',
    { unresolved },
  )
}

async function resolveSelectors(
  reads: AgentImportReferenceReadPort,
  authority: AgentOperationContext,
  selectors: readonly ImportRefSelector[],
  selections: readonly ImportRefSelection[],
): Promise<ReadonlyMap<string, string>> {
  const uniqueSelectors = dedupeSelectors(selectors)
  if (uniqueSelectors.length === 0) return new Map()

  const snapshot = await reads.snapshot(authority, uniqueSelectors, selections)
  const candidatesBySelector = new Map(
    snapshot.candidateSets.map((entry) => [importRefSelectorKey(entry.selector), entry.candidates]),
  )
  const visibleSelections = new Set(
    snapshot.visibleSelections.map((entry) => selectionKey(entry.type, entry.resourceId)),
  )
  const requestedBySelector = new Map(
    selections.map((selection) => [importRefSelectorKey(selection.selector), selection]),
  )

  const invisibleSelections = selections
    .filter(
      (selection) =>
        !visibleSelections.has(selectionKey(selection.selector.type, selection.resourceId)),
    )
    .map((selection) => selection.selector)
  if (invisibleSelections.length > 0) throw unresolvedReferences(invisibleSelections)

  const unresolved = uniqueSelectors.filter(
    (selector) =>
      requestedBySelector.get(importRefSelectorKey(selector)) === undefined &&
      (candidatesBySelector.get(importRefSelectorKey(selector)) ?? []).length === 0,
  )
  if (unresolved.length > 0) throw unresolvedReferences(unresolved)

  const ambiguities: ImportRefAmbiguity[] = []
  const stale: ImportRefAmbiguity[] = []
  const resolved = new Map<string, string>()
  for (const selector of uniqueSelectors) {
    const key = importRefSelectorKey(selector)
    const candidates = candidatesBySelector.get(key) ?? []
    const requested = requestedBySelector.get(key)
    if (candidates.length === 1) {
      const candidate = candidates[0]!
      if (
        requested !== undefined &&
        (requested.resourceId !== candidate.id ||
          requested.expectedAclRevision !== candidate.aclRevision)
      ) {
        stale.push({ selector, candidates: [...candidates] })
        continue
      }
      resolved.set(key, candidate.id)
      continue
    }
    if (requested === undefined) {
      ambiguities.push({ selector, candidates: [...candidates] })
      continue
    }
    const candidate = candidates.find((entry) => entry.id === requested.resourceId)
    if (candidate === undefined || candidate.aclRevision !== requested.expectedAclRevision) {
      stale.push({ selector, candidates: [...candidates] })
      continue
    }
    resolved.set(key, candidate.id)
  }

  if (ambiguities.length > 0) {
    throw new ConflictError(
      'import-ref-ambiguous',
      'one or more imported references match multiple available resources',
      { ambiguities },
    )
  }
  if (stale.length > 0) throw staleSelections(stale)
  return resolved
}

export function createAgentImportQueries(reads: AgentImportReferenceReadPort): AgentImportQueries {
  return Object.freeze({
    async resolve(
      authority: AgentOperationContext,
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
      const resolved = await resolveSelectors(reads, authority, selectors, request.selections)

      const names = (
        type: Exclude<ImportRefType, 'skill'>,
        values: readonly string[] | undefined,
      ): string[] | undefined =>
        values?.map((name) => {
          const id = resolved.get(importRefSelectorKey({ type, name }))
          if (id === undefined) {
            throw new ValidationError('import-ref-unresolved', 'imported reference did not resolve')
          }
          return id
        })

      const skills: AgentSkillRef[] | undefined = request.skills?.map((selector) => {
        if (selector.kind === 'project') return { kind: 'project', name: selector.name }
        const importSelector: ImportRefSelector = {
          type: 'skill',
          name: selector.name,
          ownerUsername: selector.ownerUsername,
        }
        const skillId = resolved.get(importRefSelectorKey(importSelector))
        if (skillId === undefined) {
          throw new ValidationError(
            'import-ref-unresolved',
            'imported skill reference did not resolve',
          )
        }
        return { kind: 'managed', skillId }
      })

      return Object.freeze({
        dependsOn: names('agent', request.dependsOn),
        mcp: names('mcp', request.mcp),
        plugins: names('plugin', request.plugins),
        skills,
      })
    },
  })
}
