// RFC-345 T4c — exact snapshots for schedule and webhook launch targets.
//
// Resource Catalog owns the target lookup + ACL projection. Launch-shape,
// closure, input mapping and trigger preflight remain with their current
// integration owners. RFC-359 W4-D1：一份实现，两个 provider 共用——每一次 ACL 与内容读取都绑定到
// Integration owner 交来的那一个事务句柄与那一对已准入的 authority。

import type { AclResourceType, Agent, WorkflowDetail, Workgroup } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import { agents, resourceGrants, workflows, workgroupMembers, workgroups } from '@/db/schema'
import type { DigitalEmployeeIntegrationTriggerParticipant } from '@/modules/digital-employee/public/participants'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { NotFoundError, ValidationError } from '@/util/errors'
import {
  canViewAccess,
  resolveAccessFrom,
  resourceAclAudienceAuthority,
  type AclRow,
} from '../../domain/resourceAccess'
import type { ResourceRequestContext } from '../../public/participants'
import type {
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
  TaskExecutionAgentSnapshot,
  TaskExecutionWorkflowSnapshot,
  TaskExecutionWorkgroupSnapshot,
} from '../../public/types'
import { agentFromPersistenceRow } from '../agentPersistence'
import { workflowDetailOf, workflowFromPersistenceRow } from '../workflowPersistence'
import { workgroupFromPostgresqlRows } from '../postgresqlWorkgroupRepository'

export interface IntegrationTriggerResourceDependencies {
  readonly assertNotBuiltin: (
    type: AclResourceType,
    row: Readonly<{ readonly builtin?: boolean | null }>,
  ) => void
}

export interface IntegrationTriggerResourceSnapshotReader {
  loadAuthorized(
    authority: ResourceRequestContext,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
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

async function canView(
  transaction: DatabaseTransaction,
  actor: Actor,
  resourceType: 'workflow' | 'agent' | 'workgroup' | 'digital_employee',
  row: AclRow,
): Promise<boolean> {
  const audience = resourceAclAudienceAuthority(actor)
  const grant =
    audience.bypass || !audience.private
      ? null
      : ((
          await transaction
            .select({ level: resourceGrants.level })
            .from(resourceGrants)
            .where(
              and(
                eq(resourceGrants.resourceType, resourceType),
                eq(resourceGrants.resourceId, row.id),
                eq(resourceGrants.userId, actor.user.id),
              ),
            )
            .limit(1)
        )[0]?.level ?? null)
  return canViewAccess(resolveAccessFrom(audience, actor.user.id, row, grant))
}

export function createIntegrationTriggerResourceSnapshotReader(
  input: {
    readonly transaction: DatabaseTransaction
    readonly authority: ResourceRequestContext
    readonly actor: Actor
    readonly digitalEmployees: DigitalEmployeeIntegrationTriggerParticipant
  },
  dependencies: IntegrationTriggerResourceDependencies,
): IntegrationTriggerResourceSnapshotReader {
  const actorFor = (authority: ResourceRequestContext): Actor => {
    if (authority !== input.authority) throw new Error('foreign-integration-trigger-authority')
    return input.actor
  }

  async function loadOne(
    authority: ResourceRequestContext,
    request: IntegrationTriggerResourceRequest,
  ): Promise<FrozenIntegrationTriggerResourceSnapshot> {
    const actor = actorFor(authority)
    if (request.kind === 'scheduled-workflow' || request.kind === 'webhook-workflow') {
      const row = (
        await input.transaction
          .select()
          .from(workflows)
          .where(eq(workflows.id, request.workflowId))
          .limit(1)
      )[0]
      if (row === undefined || !(await canView(input.transaction, actor, 'workflow', row))) {
        throw new NotFoundError('workflow-not-found', 'workflow not found')
      }
      dependencies.assertNotBuiltin('workflow', row)
      return Object.freeze({
        kind: request.kind,
        workflow: workflowSnapshot(workflowDetailOf(workflowFromPersistenceRow(row))),
      })
    }
    if (request.kind === 'scheduled-agent') {
      const row = (
        await input.transaction.select().from(agents).where(eq(agents.id, request.agentId)).limit(1)
      )[0]
      if (row === undefined || !(await canView(input.transaction, actor, 'agent', row))) {
        throw new NotFoundError('agent-not-found', 'agent not found')
      }
      dependencies.assertNotBuiltin('agent', row)
      return Object.freeze({
        kind: request.kind,
        agent: agentSnapshot(agentFromPersistenceRow(row)),
      })
    }
    if (request.kind === 'scheduled-workgroup') {
      const row = (
        await input.transaction
          .select()
          .from(workgroups)
          .where(eq(workgroups.id, request.workgroupId))
          .limit(1)
      )[0]
      if (row === undefined || !(await canView(input.transaction, actor, 'workgroup', row))) {
        throw new NotFoundError('workgroup-not-found', 'workgroup not found')
      }
      const members = await input.transaction
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, row.id))
      return Object.freeze({
        kind: request.kind,
        workgroup: workgroupSnapshot(workgroupFromPostgresqlRows(row, members)),
      })
    }

    const identity = await input.digitalEmployees.loadIdentity(request.employeeDefinitionId)
    if (
      identity === null ||
      identity.archivedAt !== null ||
      identity.currentRevision === null ||
      !(await canView(input.transaction, actor, 'digital_employee', identity))
    ) {
      throw new NotFoundError('employee-definition-not-found', 'digital employee not found')
    }
    const snapshot = await input.digitalEmployees.loadCurrentSnapshot(request.employeeDefinitionId)
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
      kind: 'webhook-digital-employee',
      employee: Object.freeze({
        employeeDefinitionId: snapshot.employeeDefinitionId,
        currentRevision: snapshot.currentRevision,
        typeId: snapshot.typeId,
        typeRevision: snapshot.typeRevision,
        intake: snapshot.intake,
      }),
    })
  }

  const reader: IntegrationTriggerResourceSnapshotReader = {
    async loadAuthorized(authority, requests) {
      const snapshots: FrozenIntegrationTriggerResourceSnapshot[] = []
      for (const request of requests) snapshots.push(await loadOne(authority, request))
      return Object.freeze(snapshots)
    },
  }
  return Object.freeze(reader)
}
