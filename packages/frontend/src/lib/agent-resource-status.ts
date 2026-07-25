// RFC-228 — wire shape of GET /api/agents/:id/resource-status.

export type AgentResourceRefKind = 'skill' | 'mcp' | 'plugin' | 'agent'
export type AgentResourceDisplayState = 'available' | 'hidden' | 'missing' | 'unavailable'

export interface AgentResourceDisplayRef {
  kind: AgentResourceRefKind
  refId: string
  name: string | null
  state: AgentResourceDisplayState
}

export interface AgentResourceDisplayIssue {
  code: string
  refKind: AgentResourceRefKind
  state: AgentResourceDisplayState
  refId: string | null
  refName: string | null
  ownerAgentId: string | null
  ownerAgentName: string | null
  direct: boolean
}

export interface AgentResourceStatus {
  ok: boolean
  references: AgentResourceDisplayRef[]
  issues: AgentResourceDisplayIssue[]
}

export type Translate = (key: string, values?: Record<string, unknown>) => string

export function agentResourceKindLabel(kind: AgentResourceRefKind, t: Translate): string {
  return t(`agentForm.resourceKind.${kind}`)
}

export function agentResourceReferenceLabel(ref: AgentResourceDisplayRef, t: Translate): string {
  const kind = agentResourceKindLabel(ref.kind, t)
  if (ref.state === 'missing') return t('agentForm.resourceMissingLabel', { kind })
  if (ref.state === 'hidden') return t('agentForm.resourceHiddenLabel', { kind })
  if (ref.state === 'unavailable') {
    return t('agentForm.resourceUnavailableLabel', {
      name: ref.name ?? kind,
    })
  }
  return ref.name ?? t('agentForm.resourceLoadingLabel', { kind })
}

export function agentResourceIssueLabel(issue: AgentResourceDisplayIssue, t: Translate): string {
  const resource = agentResourceReferenceLabel(
    {
      kind: issue.refKind,
      refId: issue.refId ?? '',
      name: issue.refName,
      state: issue.state,
    },
    t,
  )
  if (!issue.direct) {
    return t('agentForm.resourceClosureIssue', {
      agent: issue.ownerAgentName ?? t('agentForm.resourceHiddenAgent'),
      resource,
    })
  }
  return t('agentForm.resourceDirectIssue', { resource })
}
