import {
  tryHandlerForParsedKind,
  tryParseKind,
  type Agent,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

export type WorkflowStarterId = 'standard-development' | 'audit-only' | 'blank'
export type WorkflowStarterRole = 'coder' | 'auditor' | 'aggregator' | 'fixer'
export type WorkflowStarterRoleMapping = Partial<Record<WorkflowStarterRole, string>>

export interface WorkflowStarterCatalogEntry {
  id: WorkflowStarterId
  labelKey: string
  descriptionKey: string
  roles: readonly WorkflowStarterRole[]
}

export const WORKFLOW_STARTER_CATALOG: readonly WorkflowStarterCatalogEntry[] = [
  {
    id: 'standard-development',
    labelKey: 'editor.starter.standardTitle',
    descriptionKey: 'editor.starter.standardDescription',
    roles: ['coder', 'auditor', 'aggregator', 'fixer'],
  },
  {
    id: 'audit-only',
    labelKey: 'editor.starter.auditTitle',
    descriptionKey: 'editor.starter.auditDescription',
    roles: ['auditor'],
  },
  {
    id: 'blank',
    labelKey: 'editor.starter.blankTitle',
    descriptionKey: 'editor.starter.blankDescription',
    roles: [],
  },
] as const

export interface WorkflowStarterCopy {
  requestLabel: string
  artifactLabel: string
  inputTitle: string
  coderTitle: string
  gitTitle: string
  fanoutTitle: string
  auditorTitle: string
  aggregatorTitle: string
  fixerTitle: string
  outputTitle: string
}

export const DEFAULT_WORKFLOW_STARTER_COPY: WorkflowStarterCopy = {
  requestLabel: 'Task request',
  artifactLabel: 'Artifact to audit',
  inputTitle: 'Request',
  coderTitle: 'Implement',
  gitTitle: 'Code changes',
  fanoutTitle: 'Audit changed files',
  auditorTitle: 'Audit each file',
  aggregatorTitle: 'Aggregate findings',
  fixerTitle: 'Fix findings',
  outputTitle: 'Result',
}

export interface WorkflowStarterPreflightIssue {
  role: WorkflowStarterRole
  code: 'role-unmapped' | 'agent-missing' | 'aggregator-role-required' | 'data-output-required'
}

export type WorkflowStarterPlan =
  | { ok: false; issues: WorkflowStarterPreflightIssue[] }
  | {
      ok: true
      definition: WorkflowDefinition
      outputPorts: Partial<Record<WorkflowStarterRole, string>>
    }

function firstDataOutput(agent: Agent): string | null {
  for (const output of agent.outputs) {
    const rawKind = agent.outputKinds?.[output]
    if (rawKind === undefined) return output
    const parsed = tryParseKind(rawKind)
    if (parsed === null) continue
    const handler = tryHandlerForParsedKind(parsed)
    if (handler === null || handler.carriesData(parsed)) return output
  }
  return null
}

export function workflowStarterAgentIneligibleReason(
  role: WorkflowStarterRole,
  agent: Agent,
): WorkflowStarterPreflightIssue['code'] | null {
  if (role === 'aggregator' && agent.role !== 'aggregator') return 'aggregator-role-required'
  if (role !== 'coder' && firstDataOutput(agent) === null) return 'data-output-required'
  return null
}

export function planWorkflowStarter(
  starterId: Exclude<WorkflowStarterId, 'blank'>,
  mapping: WorkflowStarterRoleMapping,
  agents: readonly Agent[],
  copy: WorkflowStarterCopy = DEFAULT_WORKFLOW_STARTER_COPY,
): WorkflowStarterPlan {
  const entry = WORKFLOW_STARTER_CATALOG.find((candidate) => candidate.id === starterId)!
  const byId = new Map(agents.map((agent) => [agent.id, agent] as const))
  const resolved = new Map<WorkflowStarterRole, Agent>()
  const issues: WorkflowStarterPreflightIssue[] = []

  for (const role of entry.roles) {
    const agentId = mapping[role]
    if (agentId === undefined || agentId === '') {
      issues.push({ role, code: 'role-unmapped' })
      continue
    }
    const agent = byId.get(agentId)
    if (agent === undefined) {
      issues.push({ role, code: 'agent-missing' })
      continue
    }
    const reason = workflowStarterAgentIneligibleReason(role, agent)
    if (reason !== null) {
      issues.push({ role, code: reason })
      continue
    }
    resolved.set(role, agent)
  }
  if (issues.length > 0) return { ok: false, issues }

  if (starterId === 'audit-only') {
    const auditor = resolved.get('auditor')!
    const auditOutput = firstDataOutput(auditor)!
    return {
      ok: true,
      outputPorts: { auditor: auditOutput },
      definition: {
        $schema_version: 4,
        inputs: [{ kind: 'text', key: 'artifact', label: copy.artifactLabel, required: true }],
        nodes: [
          {
            id: 'starter_input',
            kind: 'input',
            title: copy.inputTitle,
            inputKey: 'artifact',
            position: { x: 80, y: 180 },
          },
          {
            id: 'starter_auditor',
            kind: 'agent-single',
            title: copy.auditorTitle,
            agentId: auditor.id,
            agentName: auditor.name,
            promptTemplate: 'Audit {{artifact}} and report concrete findings.',
            position: { x: 420, y: 180 },
          },
          {
            id: 'starter_output',
            kind: 'output',
            title: copy.outputTitle,
            ports: [
              {
                name: 'audit_report',
                bind: { nodeId: 'starter_auditor', portName: auditOutput },
              },
            ],
            position: { x: 780, y: 180 },
          },
        ],
        edges: [
          {
            id: 'starter_edge_artifact',
            source: { nodeId: 'starter_input', portName: 'artifact' },
            target: { nodeId: 'starter_auditor', portName: 'artifact' },
          },
          {
            id: 'starter_edge_audit_output',
            source: { nodeId: 'starter_auditor', portName: auditOutput },
            target: { nodeId: 'starter_output', portName: 'audit_report' },
          },
        ],
      },
    }
  }

  const coder = resolved.get('coder')!
  const auditor = resolved.get('auditor')!
  const aggregator = resolved.get('aggregator')!
  const fixer = resolved.get('fixer')!
  const auditOutput = firstDataOutput(auditor)!
  const aggregateOutput = firstDataOutput(aggregator)!
  const fixerOutput = firstDataOutput(fixer)!
  const promotedOutput = aggregator.outputWrapperPortNames?.[aggregateOutput] ?? aggregateOutput

  return {
    ok: true,
    outputPorts: {
      auditor: auditOutput,
      aggregator: aggregateOutput,
      fixer: fixerOutput,
    },
    definition: {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'request', label: copy.requestLabel, required: true }],
      nodes: [
        {
          id: 'starter_input',
          kind: 'input',
          title: copy.inputTitle,
          inputKey: 'request',
          position: { x: 40, y: 220 },
        },
        {
          id: 'starter_git',
          kind: 'wrapper-git',
          title: copy.gitTitle,
          nodeIds: ['starter_coder'],
          position: { x: 300, y: 100 },
        },
        {
          id: 'starter_coder',
          kind: 'agent-single',
          title: copy.coderTitle,
          agentId: coder.id,
          agentName: coder.name,
          promptTemplate: 'Implement {{request}} in the worktree.',
          position: { x: 360, y: 180 },
        },
        {
          id: 'starter_fanout',
          kind: 'wrapper-fanout',
          title: copy.fanoutTitle,
          nodeIds: ['starter_auditor', 'starter_aggregator'],
          inputs: [{ name: 'changed_files', kind: 'list<path<*>>', isShardSource: true }],
          position: { x: 760, y: 70 },
        },
        {
          id: 'starter_auditor',
          kind: 'agent-single',
          title: copy.auditorTitle,
          agentId: auditor.id,
          agentName: auditor.name,
          promptTemplate: 'Audit changed file {{file}} and report concrete findings.',
          position: { x: 850, y: 150 },
        },
        {
          id: 'starter_aggregator',
          kind: 'agent-single',
          title: copy.aggregatorTitle,
          agentId: aggregator.id,
          agentName: aggregator.name,
          promptTemplate: 'Deduplicate and prioritize {{findings}}.',
          position: { x: 1110, y: 300 },
        },
        {
          id: 'starter_fixer',
          kind: 'agent-single',
          title: copy.fixerTitle,
          agentId: fixer.id,
          agentName: fixer.name,
          promptTemplate: 'Fix every actionable item in {{findings}}.',
          position: { x: 1440, y: 220 },
        },
        {
          id: 'starter_output',
          kind: 'output',
          title: copy.outputTitle,
          ports: [
            {
              name: 'result',
              bind: { nodeId: 'starter_fixer', portName: fixerOutput },
            },
          ],
          position: { x: 1780, y: 220 },
        },
      ],
      edges: [
        {
          id: 'starter_edge_request',
          source: { nodeId: 'starter_input', portName: 'request' },
          target: { nodeId: 'starter_coder', portName: 'request' },
        },
        {
          id: 'starter_edge_git_diff',
          source: { nodeId: 'starter_git', portName: 'git_diff' },
          target: { nodeId: 'starter_fanout', portName: 'changed_files' },
        },
        {
          id: 'starter_edge_fanout_input',
          source: { nodeId: 'starter_fanout', portName: 'changed_files' },
          target: { nodeId: 'starter_auditor', portName: 'file' },
          boundary: 'wrapper-input',
        },
        {
          id: 'starter_edge_audit_findings',
          source: { nodeId: 'starter_auditor', portName: auditOutput },
          target: { nodeId: 'starter_aggregator', portName: 'findings' },
        },
        {
          id: 'starter_edge_fix',
          source: { nodeId: 'starter_fanout', portName: promotedOutput },
          target: { nodeId: 'starter_fixer', portName: 'findings' },
        },
        {
          id: 'starter_edge_result',
          source: { nodeId: 'starter_fixer', portName: fixerOutput },
          target: { nodeId: 'starter_output', portName: 'result' },
        },
      ],
    },
  }
}
