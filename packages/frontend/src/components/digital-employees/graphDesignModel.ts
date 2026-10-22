import type {
  GraphDesignDocument,
  GraphEvidenceBinding,
  GraphPresentation,
  GraphTraceLink,
  GraphViewSpec,
} from '@agent-workflow/shared'

export interface GraphWorkspaceData {
  document: GraphDesignDocument
  currentRevision: number
  presentationRevision: number
  presentation: Record<string, GraphPresentation>
  host: {
    caseId: string
    state: string
    workItemRef: string | null
    executionRef: string | null
    editableClarify: { taskId: string; roundId: string } | null
  }
  revisions: { revision: number; createdAt: number }[]
  proposals: { id: string; status: string; createdAt: number }[]
  requests: { id: string; kind: string; status: string; payload: unknown; updatedAt: number }[]
  bases: { id: string; createdAt: number }[]
  executionLinks: {
    kind?: string
    taskId?: string
    workItemRef?: string
    receipt?: {
      id: string
      basisDigest: string
      taskId: string
      decision: string
      reason: string
      decidedAt: number
    }
    commitSha?: string
    publication?: { remoteRef: string; newSha: string } | null
  }[]
}
export interface GraphViewData {
  view: GraphViewSpec
  available: boolean
  renderings: {
    modelId: string
    format: 'mermaid' | 'markdown'
    source: string
    elementIndex: { renderId: string; elementId: string; label: string }[]
  }[]
  elements: GraphDesignDocument['elements']
  relations: GraphDesignDocument['relations']
  scope: { total: number; offset: number; limit: number; truncated: boolean }
}
export interface GraphEvidenceData {
  evidence: {
    evidence: GraphEvidenceBinding
    freshness: 'current' | 'stale' | 'unknown'
    reasons: string[]
  }[]
  traces: GraphTraceLink[]
  obligations: {
    obligationId: string
    state: 'passed' | 'failed' | 'pending'
    evidenceIds: string[]
  }[]
}
export interface GraphVerificationProfile {
  id: string
  name: string
  revision: number
  digest: string
}

export function graphDocumentChanges(before: GraphDesignDocument, after: GraphDesignDocument) {
  const changes: { id: string; before: string; after: string }[] = []
  for (const field of [
    'concerns',
    'elements',
    'relations',
    'models',
    'views',
    'obligations',
  ] as const) {
    const prior = new Map(before[field].map((value) => [value.id, value]))
    for (const next of after[field]) {
      const old = prior.get(next.id)
      if (JSON.stringify(old) !== JSON.stringify(next))
        changes.push({
          id: next.id,
          before: old ? JSON.stringify(old, null, 2) : '—',
          after: JSON.stringify(next, null, 2),
        })
      prior.delete(next.id)
    }
    for (const old of prior.values())
      changes.push({ id: old.id, before: JSON.stringify(old, null, 2), after: '—' })
  }
  return changes
}

export function graphSelectionAnchor(
  document: GraphDesignDocument,
  selectedIds: readonly string[],
  viewId?: string,
) {
  return {
    artifactRef: document.id,
    elementIds: selectedIds.filter((id) => document.elements.some((element) => element.id === id)),
    relationIds: selectedIds.filter((id) =>
      document.relations.some((relation) => relation.id === id),
    ),
    ...(viewId ? { viewId } : {}),
  }
}
