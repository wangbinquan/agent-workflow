// RFC-345 T4a — reference-closure freeze through the named Resource Catalog
// participant. The storage wire stays RFC-243 v2; only row/ACL ownership moves.

import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  detectCallCycles,
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionResourceRequest,
  TaskExecutionWorkflowSnapshot,
  TaskExecutionWorkgroupSnapshot,
} from '@/modules/resource-catalog/public/types'
import type { TaskExecutionResourceAuthority } from '@/services/execution/taskExecutionResources'
import { ValidationError } from '@/util/errors'

interface FrozenWorkflowRef {
  readonly id: string
  readonly version: number
  readonly definition: WorkflowDefinition
}

interface FrozenWorkgroupRef {
  readonly id: string
  readonly version: number
  readonly group: TaskExecutionWorkgroupSnapshot
}

interface FrozenCallClosureV2 {
  readonly closureVersion: 2
  readonly workflows: Record<string, FrozenWorkflowRef>
  readonly workgroups: Record<string, FrozenWorkgroupRef>
}

function edgeKey(sourceWorkflowId: string, nodeId: string): string {
  return `${sourceWorkflowId}#${nodeId}`
}

export function freezeTaskExecutionCallClosure(
  db: DbClient,
  root: Readonly<{ readonly id: string; readonly definition: WorkflowDefinition }>,
  resourceAuthority: TaskExecutionResourceAuthority,
): string | null {
  const canonicalRoot = Object.freeze({
    id: root.id,
    definition: migrateWorkflowDefinitionToLatest(root.definition),
  })
  const rootWorkflowRefs = collectWorkflowCallRefs(canonicalRoot.definition)
  const rootWorkgroupRefs = collectWorkgroupCallRefs(canonicalRoot.definition)
  if (rootWorkflowRefs.length === 0 && rootWorkgroupRefs.length === 0) return null

  return dbTxSync(db, (tx) => {
    const participant = resourceAuthority.resources.inTransaction(tx, resourceAuthority)
    const load = <K extends TaskExecutionResourceRequest['kind']>(
      request: Extract<TaskExecutionResourceRequest, { readonly kind: K }>,
    ): Extract<FrozenTaskExecutionResourceSnapshot, { readonly kind: K }> => {
      const [snapshot] = participant.loadAuthorized(resourceAuthority.authority, [request])
      if (snapshot === undefined || snapshot.kind !== request.kind) {
        throw new Error(`task-execution-resource-kind-mismatch:${request.kind}`)
      }
      return snapshot as Extract<FrozenTaskExecutionResourceSnapshot, { readonly kind: K }>
    }

    type WorkflowEdge = Readonly<{
      sourceWorkflowId: string
      nodeId: string
      name: string
      idHint?: string
    }>
    const queue: WorkflowEdge[] = rootWorkflowRefs.map((ref) => ({
      sourceWorkflowId: canonicalRoot.id,
      nodeId: ref.nodeId,
      name: ref.workflowName,
      ...(ref.workflowId === undefined ? {} : { idHint: ref.workflowId }),
    }))
    const workflowByEdge = new Map<string, TaskExecutionWorkflowSnapshot>()
    const workflowById = new Map<string, TaskExecutionWorkflowSnapshot>()
    while (queue.length > 0) {
      const edge = queue.shift()
      if (edge === undefined) break
      const key = edgeKey(edge.sourceWorkflowId, edge.nodeId)
      if (workflowByEdge.has(key)) continue
      const snapshot = load({
        kind: 'call-workflow',
        sourceWorkflowId: edge.sourceWorkflowId,
        nodeId: edge.nodeId,
        name: edge.name,
        ...(edge.idHint === undefined ? {} : { idHint: edge.idHint }),
      }).workflow
      workflowByEdge.set(key, snapshot)
      workflowById.set(snapshot.id, snapshot)
      for (const ref of collectWorkflowCallRefs(snapshot.definition)) {
        queue.push({
          sourceWorkflowId: snapshot.id,
          nodeId: ref.nodeId,
          name: ref.workflowName,
          ...(ref.workflowId === undefined ? {} : { idHint: ref.workflowId }),
        })
      }
    }

    const cycleReport = detectCallCycles(canonicalRoot, (ref, sourceId) => {
      const snapshot = workflowByEdge.get(edgeKey(sourceId, ref.nodeId))
      return snapshot === undefined ? null : { id: snapshot.id, definition: snapshot.definition }
    })
    if (cycleReport.cycles.length > 0) {
      throw new ValidationError('workflow-call-cycle', 'workflow call graph contains a cycle', {
        cycle: cycleReport.cycles[0],
      })
    }
    if (cycleReport.unresolved.length > 0) {
      throw new ValidationError(
        'workflow-call-ref-missing',
        'workflow call closure could not be fully resolved',
      )
    }

    const workgroupEdges: Array<
      Readonly<{
        sourceWorkflowId: string
        nodeId: string
        name: string
        idHint?: string
      }>
    > = rootWorkgroupRefs.map((ref) => ({
      sourceWorkflowId: canonicalRoot.id,
      nodeId: ref.nodeId,
      name: ref.workgroupName,
      ...(ref.workgroupId === undefined ? {} : { idHint: ref.workgroupId }),
    }))
    for (const workflow of workflowById.values()) {
      for (const ref of collectWorkgroupCallRefs(workflow.definition)) {
        workgroupEdges.push({
          sourceWorkflowId: workflow.id,
          nodeId: ref.nodeId,
          name: ref.workgroupName,
          ...(ref.workgroupId === undefined ? {} : { idHint: ref.workgroupId }),
        })
      }
    }

    const closure: FrozenCallClosureV2 = {
      closureVersion: 2,
      workflows: {},
      workgroups: {},
    }
    for (const [key, workflow] of workflowByEdge) {
      closure.workflows[key] = {
        id: workflow.id,
        version: workflow.version,
        definition: workflow.definition,
      }
    }
    for (const edge of workgroupEdges) {
      const snapshot = load({
        kind: 'call-workgroup',
        sourceWorkflowId: edge.sourceWorkflowId,
        nodeId: edge.nodeId,
        name: edge.name,
        ...(edge.idHint === undefined ? {} : { idHint: edge.idHint }),
      }).workgroup
      closure.workgroups[edgeKey(edge.sourceWorkflowId, edge.nodeId)] = {
        id: snapshot.id,
        version: snapshot.version,
        group: snapshot,
      }
    }
    return JSON.stringify(closure)
  })
}
