import {
  importRefSelectorKey,
  type ImportRefAmbiguity,
  type ImportRefCandidate,
  type ImportRefSelection,
  type ImportRefSelector,
  type ImportRefType,
} from '@agent-workflow/shared'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import { ConflictError, ValidationError } from '@/util/errors'
import type {
  AgentImportResolutionSnapshot,
  TransactionBoundImportReferenceReadPort,
  TransactionBoundImportReferenceSyncReadPort,
} from './agents/importPorts'

const DANGLE_TOLERANT_IMPORT_REF_TYPES: ReadonlySet<ImportRefType> = new Set([
  'workflow',
  'workgroup',
])

export interface PortableImportReferenceBinding {
  readonly selector: ImportRefSelector
  readonly resourceId: string
}

export interface PortableImportReferenceFenceEntry {
  readonly selector: ImportRefSelector
  readonly selectedId: string
  readonly selectedExplicitly: boolean
  readonly candidates: readonly ImportRefCandidate[]
}

export interface PortableImportReferenceFence {
  readonly entries: readonly PortableImportReferenceFenceEntry[]
}

export interface PortableImportReferenceResolution {
  readonly bindings: readonly PortableImportReferenceBinding[]
  readonly selections: readonly ImportRefSelection[]
  readonly fence: PortableImportReferenceFence
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

function selectionKey(type: ImportRefType, resourceId: string): string {
  return JSON.stringify([type, resourceId])
}

function snapshotMaps(snapshot: AgentImportResolutionSnapshot) {
  return {
    candidates: new Map(
      snapshot.candidateSets.map((entry) => [
        importRefSelectorKey(entry.selector),
        entry.candidates,
      ]),
    ),
    visible: new Set(
      snapshot.visibleSelections.map((entry) => selectionKey(entry.type, entry.resourceId)),
    ),
  }
}

function unresolvedReferences(unresolved: readonly ImportRefSelector[]): ValidationError {
  return new ValidationError(
    'import-ref-unresolved',
    'one or more imported references do not resolve to an available resource',
    { unresolved },
  )
}

function staleSelections(ambiguities: readonly ImportRefAmbiguity[]): ConflictError {
  return new ConflictError(
    'import-ref-selection-stale',
    'the selected import reference is no longer an available candidate',
    { selector: ambiguities[0]?.selector, ambiguities },
  )
}

function resolveFromSnapshot(
  selectors: readonly ImportRefSelector[],
  requestedSelections: readonly ImportRefSelection[],
  snapshot: AgentImportResolutionSnapshot,
): PortableImportReferenceResolution {
  const uniqueSelectors = dedupeSelectors(selectors)
  if (uniqueSelectors.length === 0) {
    return Object.freeze({ bindings: [], selections: [], fence: { entries: [] } })
  }
  const { candidates, visible } = snapshotMaps(snapshot)
  const requestedBySelector = new Map(
    requestedSelections.map((selection) => [importRefSelectorKey(selection.selector), selection]),
  )
  const invisible = requestedSelections
    .filter(
      (selection) => !visible.has(selectionKey(selection.selector.type, selection.resourceId)),
    )
    .map((selection) => selection.selector)
  if (invisible.length > 0) throw unresolvedReferences(invisible)

  const unresolved = uniqueSelectors.filter((selector) => {
    const key = importRefSelectorKey(selector)
    return (
      !DANGLE_TOLERANT_IMPORT_REF_TYPES.has(selector.type) &&
      requestedBySelector.get(key) === undefined &&
      (candidates.get(key) ?? []).length === 0
    )
  })
  if (unresolved.length > 0) throw unresolvedReferences(unresolved)

  const bindings: PortableImportReferenceBinding[] = []
  const selections: ImportRefSelection[] = []
  const entries: PortableImportReferenceFenceEntry[] = []
  const ambiguities: ImportRefAmbiguity[] = []
  const stale: ImportRefAmbiguity[] = []
  for (const selector of uniqueSelectors) {
    const key = importRefSelectorKey(selector)
    const current = candidates.get(key) ?? []
    const requested = requestedBySelector.get(key)
    if (
      current.length === 0 &&
      requested === undefined &&
      DANGLE_TOLERANT_IMPORT_REF_TYPES.has(selector.type)
    ) {
      continue
    }
    let selected: ImportRefCandidate | undefined
    if (current.length === 1) {
      selected = current[0]
      if (
        requested !== undefined &&
        (requested.resourceId !== selected!.id ||
          requested.expectedAclRevision !== selected!.aclRevision)
      ) {
        stale.push({ selector, candidates: [...current] })
        continue
      }
    } else if (requested === undefined) {
      ambiguities.push({ selector, candidates: [...current] })
      continue
    } else {
      selected = current.find((candidate) => candidate.id === requested.resourceId)
      if (selected === undefined || selected.aclRevision !== requested.expectedAclRevision) {
        stale.push({ selector, candidates: [...current] })
        continue
      }
    }
    if (selected === undefined) throw new Error('unreachable-import-reference-selection')
    bindings.push(Object.freeze({ selector, resourceId: selected.id }))
    selections.push(
      Object.freeze({
        selector,
        resourceId: selected.id,
        expectedAclRevision: selected.aclRevision,
      }),
    )
    entries.push(
      Object.freeze({
        selector,
        selectedId: selected.id,
        selectedExplicitly: requested !== undefined,
        candidates: Object.freeze([...current]),
      }),
    )
  }
  if (ambiguities.length > 0) {
    throw new ConflictError(
      'import-ref-ambiguous',
      'one or more imported references match multiple available resources',
      { ambiguities },
    )
  }
  if (stale.length > 0) throw staleSelections(stale)
  return Object.freeze({
    bindings: Object.freeze(bindings),
    selections: Object.freeze(selections),
    fence: Object.freeze({ entries: Object.freeze(entries) }),
  })
}

function assertStableFromSnapshot(
  fence: PortableImportReferenceFence,
  snapshot: AgentImportResolutionSnapshot,
): void {
  if (fence.entries.length === 0) return
  const { candidates, visible } = snapshotMaps(snapshot)
  const invisible = fence.entries
    .filter((entry) => !visible.has(selectionKey(entry.selector.type, entry.selectedId)))
    .map((entry) => entry.selector)
  if (invisible.length > 0) throw unresolvedReferences(invisible)

  const newlyAmbiguous: ImportRefAmbiguity[] = []
  const stale: ImportRefAmbiguity[] = []
  for (const entry of fence.entries) {
    const current = candidates.get(importRefSelectorKey(entry.selector)) ?? []
    if (
      current.some((candidate) => candidate.id === entry.selectedId) &&
      JSON.stringify(current) === JSON.stringify(entry.candidates)
    ) {
      continue
    }
    const ambiguity = { selector: entry.selector, candidates: [...current] }
    if (!entry.selectedExplicitly && current.length > 1) newlyAmbiguous.push(ambiguity)
    else stale.push(ambiguity)
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

export function createPortableImportReferenceApplication(
  reads: TransactionBoundImportReferenceReadPort,
) {
  return Object.freeze({
    async resolve(
      authority: DirectAuthenticatedAuthority,
      selectors: readonly ImportRefSelector[],
      selections: readonly ImportRefSelection[] = [],
    ): Promise<PortableImportReferenceResolution> {
      return resolveFromSnapshot(
        selectors,
        selections,
        await reads.snapshot(authority, selectors, selections),
      )
    },
    async assertStable(
      authority: DirectAuthenticatedAuthority,
      fence: PortableImportReferenceFence,
    ): Promise<void> {
      const selectors = fence.entries.map((entry) => entry.selector)
      const selections = fence.entries.map((entry) => ({
        selector: entry.selector,
        resourceId: entry.selectedId,
        expectedAclRevision:
          entry.candidates.find((candidate) => candidate.id === entry.selectedId)?.aclRevision ?? 0,
      }))
      assertStableFromSnapshot(fence, await reads.snapshot(authority, selectors, selections))
    },
  })
}

/** SQLite-only final-write fence for an already-open synchronous transaction. */
export function createPortableImportReferenceSyncFence(
  reads: TransactionBoundImportReferenceSyncReadPort,
) {
  return Object.freeze({
    assertStable(
      authority: DirectAuthenticatedAuthority,
      fence: PortableImportReferenceFence,
    ): void {
      const selectors = fence.entries.map((entry) => entry.selector)
      const selections = fence.entries.map((entry) => ({
        selector: entry.selector,
        resourceId: entry.selectedId,
        expectedAclRevision:
          entry.candidates.find((candidate) => candidate.id === entry.selectedId)?.aclRevision ?? 0,
      }))
      assertStableFromSnapshot(fence, reads.snapshotSync(authority, selectors, selections))
    },
  })
}

export type PortableImportReferenceApplication = ReturnType<
  typeof createPortableImportReferenceApplication
>
export type PortableImportReferenceSyncFence = ReturnType<
  typeof createPortableImportReferenceSyncFence
>
