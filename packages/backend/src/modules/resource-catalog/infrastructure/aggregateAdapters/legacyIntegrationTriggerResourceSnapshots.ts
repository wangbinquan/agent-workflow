// RFC-345 T4c — exact snapshots for schedule and webhook launch targets.
//
// Resource Catalog owns the target lookup + ACL projection. Launch-shape,
// closure, input mapping and trigger preflight remain with their current
// integration owners. The row mappers are Resource Catalog's own legacy
// infrastructure, so this adapter reads them directly (RFC-345 T9) instead of
// having bootstrap hand them back through the compatibility service layer —
// which is what the PostgreSQL twin already does.

import type { AclResourceType, Agent, WorkflowDetail, Workgroup } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import { agents, workflows, workgroupMembers, workgroups } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import { NotFoundError, ValidationError } from '@/util/errors'
import type { IntegrationTriggerResourceSnapshotPorts } from '../../application/participants/integrationTriggerResourceSnapshot'
import { rowToAgent } from '../legacy/agent'
import { rowToWorkflowDetail } from '../legacy/workflow'
import { rowToWorkgroup } from '../legacy/workgroups'
import type { ResourceRequestContext } from '../../public/participants'
import type {
  TaskExecutionAgentSnapshot,
  TaskExecutionWorkflowSnapshot,
  TaskExecutionWorkgroupSnapshot,
} from '../../public/types'

type AclRow = Readonly<{
  readonly id: string
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
}>

export interface LegacyDigitalEmployeeIntegrationTriggerParticipant {
  loadIdentity(employeeDefinitionId: string): Readonly<{
    readonly id: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly archivedAt: number | null
    readonly currentRevision: number | null
    readonly typeId: string
    readonly typeRevision: number
  }> | null
  loadCurrentSnapshot(employeeDefinitionId: string):
    | Readonly<{ readonly kind: 'revision-unavailable' }>
    | Readonly<{ readonly kind: 'intake-unavailable' }>
    | Readonly<{
        readonly kind: 'ready'
        readonly employeeDefinitionId: string
        readonly currentRevision: number
        readonly typeId: string
        readonly typeRevision: number
        readonly intake: Readonly<{
          readonly acceptedKinds: readonly ('body' | 'files' | 'body-and-files' | 'external-id')[]
          readonly targetFields: readonly Readonly<{
            readonly fieldRef: string
            readonly required: boolean
          }>[]
        }>
      }>
}

export interface LegacyIntegrationTriggerResourceDependencies {
  readonly canViewResourceInTx: (
    tx: DbTxSync,
    actor: Actor,
    type: AclResourceType,
    row: AclRow,
  ) => boolean
  readonly assertNotBuiltin: (
    type: AclResourceType,
    row: Readonly<{ builtin?: boolean | null }>,
  ) => void
}

export interface LegacyIntegrationTriggerResourceOptions {
  readonly tx: DbTxSync
  readonly authority: ResourceRequestContext
  readonly actor: Actor
  readonly digitalEmployees: LegacyDigitalEmployeeIntegrationTriggerParticipant
}

function workflowSnapshot(workflow: WorkflowDetail): TaskExecutionWorkflowSnapshot {
  return Object.freeze({
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    definition: workflow.definition,
  })
}

function agentSnapshot(agent: Agent): TaskExecutionAgentSnapshot {
  return Object.freeze({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    outputs: agent.outputs,
    outputKinds: agent.outputKinds,
    branchPorts: agent.branchPorts,
    inputs: agent.inputs,
    outputWrapperPortNames: agent.outputWrapperPortNames,
    role: agent.role,
    syncOutputsOnIterate: agent.syncOutputsOnIterate,
    runtime: agent.runtime,
    permission: agent.permission,
    skills: agent.skills,
    dependsOn: agent.dependsOn,
    mcp: agent.mcp,
    plugins: agent.plugins,
    frontmatterExtra: agent.frontmatterExtra,
    bodyMd: agent.bodyMd,
    schemaVersion: agent.schemaVersion,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  })
}

function workgroupSnapshot(workgroup: Workgroup): TaskExecutionWorkgroupSnapshot {
  return Object.freeze({
    id: workgroup.id,
    name: workgroup.name,
    description: workgroup.description,
    instructions: workgroup.instructions,
    mode: workgroup.mode,
    outputContract: workgroup.outputContract,
    leaderMemberId: workgroup.leaderMemberId,
    switches: workgroup.switches,
    maxRounds: workgroup.maxRounds,
    completionGate: workgroup.completionGate,
    clarifyBudget: workgroup.clarifyBudget,
    fanOut: workgroup.fanOut,
    members: workgroup.members,
    version: workgroup.version,
  })
}

export function createLegacyIntegrationTriggerResourceSnapshotPorts(
  options: LegacyIntegrationTriggerResourceOptions,
  dependencies: LegacyIntegrationTriggerResourceDependencies,
): IntegrationTriggerResourceSnapshotPorts {
  const actorFor = (authority: ResourceRequestContext): Actor => {
    if (authority !== options.authority) {
      throw new Error('foreign-integration-trigger-authority')
    }
    return options.actor
  }

  const loadWorkflow = (
    authority: ResourceRequestContext,
    workflowId: string,
  ): TaskExecutionWorkflowSnapshot => {
    const actor = actorFor(authority)
    const row = options.tx.select().from(workflows).where(eq(workflows.id, workflowId)).get()
    if (
      row === undefined ||
      !dependencies.canViewResourceInTx(options.tx, actor, 'workflow', row)
    ) {
      throw new NotFoundError('workflow-not-found', 'workflow not found')
    }
    dependencies.assertNotBuiltin('workflow', row)
    return workflowSnapshot(rowToWorkflowDetail(row))
  }

  const ports: IntegrationTriggerResourceSnapshotPorts = {
    scheduledWorkflow(authority, request) {
      return Object.freeze({
        kind: 'scheduled-workflow' as const,
        workflow: loadWorkflow(authority, request.workflowId),
      })
    },

    scheduledAgent(authority, request) {
      const actor = actorFor(authority)
      const row = options.tx.select().from(agents).where(eq(agents.id, request.agentId)).get()
      if (row === undefined || !dependencies.canViewResourceInTx(options.tx, actor, 'agent', row)) {
        throw new NotFoundError('agent-not-found', 'agent not found')
      }
      dependencies.assertNotBuiltin('agent', row)
      return Object.freeze({
        kind: 'scheduled-agent' as const,
        agent: agentSnapshot(rowToAgent(row)),
      })
    },

    scheduledWorkgroup(authority, request) {
      const actor = actorFor(authority)
      const row = options.tx
        .select()
        .from(workgroups)
        .where(eq(workgroups.id, request.workgroupId))
        .get()
      if (
        row === undefined ||
        !dependencies.canViewResourceInTx(options.tx, actor, 'workgroup', row)
      ) {
        throw new NotFoundError('workgroup-not-found', 'workgroup not found')
      }
      const members = options.tx
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, row.id))
        .all()
      return Object.freeze({
        kind: 'scheduled-workgroup' as const,
        workgroup: workgroupSnapshot(rowToWorkgroup(row, members)),
      })
    },

    webhookWorkflow(authority, request) {
      return Object.freeze({
        kind: 'webhook-workflow' as const,
        workflow: loadWorkflow(authority, request.workflowId),
      })
    },

    webhookDigitalEmployee(authority, request) {
      const actor = actorFor(authority)
      const identity = options.digitalEmployees.loadIdentity(request.employeeDefinitionId)
      if (
        identity === null ||
        identity.archivedAt !== null ||
        identity.currentRevision === null ||
        !dependencies.canViewResourceInTx(options.tx, actor, 'digital_employee', identity)
      ) {
        throw new NotFoundError('employee-definition-not-found', 'digital employee not found')
      }
      const snapshot = options.digitalEmployees.loadCurrentSnapshot(request.employeeDefinitionId)
      if (snapshot.kind === 'revision-unavailable') {
        throw new ValidationError(
          'employee-definition-unavailable',
          'the current digital employee revision is unavailable',
        )
      }
      if (snapshot.kind === 'intake-unavailable') {
        throw new ValidationError(
          'employee-intake-contract-unavailable',
          'the digital employee intake contract is unavailable',
        )
      }
      return Object.freeze({
        kind: 'webhook-digital-employee' as const,
        employee: Object.freeze({
          employeeDefinitionId: snapshot.employeeDefinitionId,
          currentRevision: snapshot.currentRevision,
          typeId: snapshot.typeId,
          typeRevision: snapshot.typeRevision,
          intake: snapshot.intake,
        }),
      })
    },
  }
  return Object.freeze(ports)
}
