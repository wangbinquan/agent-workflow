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
  scope: {
    total: number
    completeTotal?: number
    offset: number
    limit: number
    truncated: boolean
  }
  relationScope?: {
    total: number
    completeTotal: number
    offset: number
    limit: number
    truncated: boolean
  }
}
export interface GraphEvidenceData {
  candidate?: {
    basisId: string
    basisDigest: string
    candidateTreeOid: string
    obligationIds: string[]
  } | null
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

const collections = [
  'concerns',
  'elements',
  'relations',
  'models',
  'views',
  'sources',
  'obligations',
] as const
type GraphChangeField = 'title' | 'goals' | (typeof collections)[number]
export interface GraphDocumentChange {
  id: string
  field: GraphChangeField
  entityId?: string
  before: string
  after: string
}

export function graphChangeLabel(change: GraphDocumentChange, zh: boolean) {
  const labels: Record<GraphChangeField, [string, string]> = {
    title: ['设计标题', 'Design title'],
    goals: ['目标', 'Goals'],
    concerns: ['关注问题', 'Concern'],
    elements: ['设计元素', 'Element'],
    relations: ['关系', 'Relation'],
    models: ['语义模型', 'Model'],
    views: ['视图', 'View'],
    sources: ['来源', 'Source'],
    obligations: ['验收要求', 'Acceptance requirement'],
  }
  return `${labels[change.field][zh ? 0 : 1]}${change.entityId ? ` · ${change.entityId}` : ''}`
}

export function graphDocumentChanges(
  before: GraphDesignDocument,
  after: GraphDesignDocument,
  readSet?: readonly { id: string }[],
) {
  const changes: GraphDocumentChange[] = []
  const reads = readSet ? new Set(readSet.map((ref) => ref.id)) : null
  for (const field of ['title', 'goals'] as const) {
    if (
      (!reads || reads.has(`${before.id}:scope`)) &&
      JSON.stringify(before[field]) !== JSON.stringify(after[field])
    )
      changes.push({
        id: field,
        field,
        before: typeof before[field] === 'string' ? before[field] : before[field].join('\n'),
        after: typeof after[field] === 'string' ? after[field] : after[field].join('\n'),
      })
  }
  for (const field of collections) {
    const prior = new Map(before[field].map((value) => [value.id, value]))
    for (const next of after[field]) {
      const old = prior.get(next.id)
      if ((!old || !reads || reads.has(next.id)) && JSON.stringify(old) !== JSON.stringify(next))
        changes.push({
          id: `${field}:${next.id}`,
          field,
          entityId: next.id,
          before: old ? JSON.stringify(old, null, 2) : '—',
          after: JSON.stringify(next, null, 2),
        })
      prior.delete(next.id)
    }
    for (const old of [...prior.values()].filter((value) => !reads || reads.has(value.id)))
      changes.push({
        id: `${field}:${old.id}`,
        field,
        entityId: old.id,
        before: JSON.stringify(old, null, 2),
        after: '—',
      })
  }
  return changes
}

export interface GraphDraftConflict {
  path: string
  local: unknown
  remote: unknown
}

/** Preserve concurrent edits, requiring an explicit choice only for divergent fields. */
export function rebaseGraphDraft(
  base: GraphDesignDocument,
  draft: GraphDesignDocument,
  latest: GraphDesignDocument,
  resolutions: Record<string, 'local' | 'remote'> = {},
): { document: GraphDesignDocument; conflicts: GraphDraftConflict[] } {
  const conflicts: GraphDraftConflict[] = []
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const merge = (before: unknown, local: unknown, remote: unknown, path: string): unknown => {
    if (equal(local, before)) return remote
    if (equal(remote, before) || equal(local, remote)) return local
    if (record(before) && record(local) && record(remote)) {
      const result: Record<string, unknown> = {}
      for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
        const value =
          key === 'revision'
            ? remote[key]
            : merge(before[key], local[key], remote[key], `${path}.${key}`)
        if (value !== undefined) result[key] = value
      }
      return result
    }
    const resolution = resolutions[path]
    if (!resolution) conflicts.push({ path, local, remote })
    return resolution === 'local' ? local : remote
  }
  const next = structuredClone(latest)
  next.title = merge(base.title, draft.title, latest.title, 'title') as string
  next.goals = merge(base.goals, draft.goals, latest.goals, 'goals') as string[]
  for (const field of collections) {
    // Original material and human answers are immutable in the design editor.
    if (field === 'sources') continue
    const before = new Map<string, unknown>(base[field].map((item) => [item.id, item]))
    const local = new Map<string, unknown>(draft[field].map((item) => [item.id, item]))
    const remote = new Map<string, unknown>(latest[field].map((item) => [item.id, item]))
    const values: unknown[] = []
    for (const id of new Set([...remote.keys(), ...local.keys()])) {
      const value = merge(before.get(id), local.get(id), remote.get(id), `${field}.${id}`)
      if (value !== undefined) values.push(value)
    }
    Object.assign(next, { [field]: values })
  }
  return { document: next, conflicts }
}

export function graphStateLabel(state: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    required: ['必须覆盖', 'Required'],
    important: ['重要', 'Important'],
    optional: ['可选', 'Optional'],
    open: ['待解决', 'Open'],
    addressed: ['已解决', 'Addressed'],
    deferred: ['暂缓', 'Deferred'],
    'out-of-scope': ['不在范围', 'Out of scope'],
    passed: ['通过', 'Passed'],
    failed: ['失败', 'Failed'],
    pending: ['待处理', 'Pending'],
    current: ['适用于当前版本', 'Current'],
    stale: ['已过期', 'Stale'],
    unknown: ['尚未确认', 'Unknown'],
    proposed: ['待确认', 'Proposed'],
    accepted: ['已受理', 'Accepted'],
    rejected: ['已拒绝', 'Rejected'],
    running: ['执行中', 'Running'],
    interrupted: ['已中断', 'Interrupted'],
    canceled: ['已取消', 'Canceled'],
    queued: ['已排队', 'Queued'],
    completed: ['已完成', 'Completed'],
    'reference-checked': ['引用已核对', 'Reference checked'],
    'coverage-reviewed': ['覆盖已复核', 'Coverage reviewed'],
    clarify: ['原始澄清', 'Original clarification'],
    material: ['需求材料', 'Requirement material'],
    code: ['代码事实', 'Code fact'],
    review: ['审核回执', 'Review receipt'],
    model: ['模型推导', 'Model inference'],
    evidence: ['验证证据', 'Verification evidence'],
    needs_review: ['需要复核', 'Needs review'],
  }
  return labels[state]?.[zh ? 0 : 1] ?? state
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
