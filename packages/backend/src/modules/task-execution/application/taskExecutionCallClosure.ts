import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  detectCallCycles,
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
} from '@agent-workflow/shared'

import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionResourceRequest,
  TaskExecutionWorkflowSnapshot,
  TaskExecutionWorkgroupSnapshot,
} from '@/modules/resource-catalog/public/types'
import { ValidationError } from '@/util/errors'
import type { TaskExecutionCallClosureRoot } from './ports/taskExecutionResourceSnapshots'

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

type WorkflowRequest = Extract<TaskExecutionResourceRequest, { readonly kind: 'call-workflow' }>
type WorkgroupRequest = Extract<TaskExecutionResourceRequest, { readonly kind: 'call-workgroup' }>
type WorkflowSnapshot = Extract<
  FrozenTaskExecutionResourceSnapshot,
  { readonly kind: 'call-workflow' }
>
type WorkgroupSnapshot = Extract<
  FrozenTaskExecutionResourceSnapshot,
  { readonly kind: 'call-workgroup' }
>

function edgeKey(sourceWorkflowId: string, nodeId: string): string {
  return `${sourceWorkflowId}#${nodeId}`
}

function exactSnapshot<K extends FrozenTaskExecutionResourceSnapshot['kind']>(
  snapshots: readonly FrozenTaskExecutionResourceSnapshot[],
  kind: K,
): Extract<FrozenTaskExecutionResourceSnapshot, { readonly kind: K }> {
  const snapshot = snapshots[0]
  if (snapshots.length !== 1 || snapshot === undefined || snapshot.kind !== kind) {
    throw new Error(`task-execution-resource-kind-mismatch:${kind}`)
  }
  return snapshot as Extract<FrozenTaskExecutionResourceSnapshot, { readonly kind: K }>
}

/** Pure graph state machine shared by the synchronous SQLite and async PostgreSQL adapters. */
export class TaskExecutionCallClosureBuilder {
  private readonly root: Readonly<{ readonly id: string; readonly definition: WorkflowDefinition }>
  private readonly hasCalls: boolean
  private readonly workflowQueue: WorkflowRequest[]
  private readonly workflowByEdge = new Map<string, TaskExecutionWorkflowSnapshot>()
  private readonly workflowById = new Map<string, TaskExecutionWorkflowSnapshot>()
  private workgroupQueue: WorkgroupRequest[] | undefined
  private readonly closure: FrozenCallClosureV2 = {
    closureVersion: 2,
    workflows: {},
    workgroups: {},
  }

  constructor(root: TaskExecutionCallClosureRoot) {
    this.root = Object.freeze({
      id: root.id,
      definition: migrateWorkflowDefinitionToLatest(root.definition),
    })
    this.workflowQueue = collectWorkflowCallRefs(this.root.definition).map((ref) => ({
      kind: 'call-workflow',
      sourceWorkflowId: this.root.id,
      nodeId: ref.nodeId,
      name: ref.workflowName,
      ...(ref.workflowId === undefined ? {} : { idHint: ref.workflowId }),
    }))
    this.hasCalls =
      this.workflowQueue.length > 0 || collectWorkgroupCallRefs(this.root.definition).length > 0
  }

  isEmpty(): boolean {
    return !this.hasCalls
  }

  nextWorkflowRequest(): WorkflowRequest | null {
    while (this.workflowQueue.length > 0) {
      const request = this.workflowQueue.shift()
      if (request === undefined) break
      if (this.workflowByEdge.has(edgeKey(request.sourceWorkflowId, request.nodeId))) continue
      return request
    }
    return null
  }

  acceptWorkflow(
    request: WorkflowRequest,
    snapshots: readonly FrozenTaskExecutionResourceSnapshot[],
  ) {
    const snapshot: WorkflowSnapshot = exactSnapshot(snapshots, 'call-workflow')
    if (
      snapshot.sourceWorkflowId !== request.sourceWorkflowId ||
      snapshot.nodeId !== request.nodeId
    ) {
      throw new Error('task-execution-resource-edge-mismatch:call-workflow')
    }
    const key = edgeKey(request.sourceWorkflowId, request.nodeId)
    this.workflowByEdge.set(key, snapshot.workflow)
    this.workflowById.set(snapshot.workflow.id, snapshot.workflow)
    for (const ref of collectWorkflowCallRefs(snapshot.workflow.definition)) {
      this.workflowQueue.push({
        kind: 'call-workflow',
        sourceWorkflowId: snapshot.workflow.id,
        nodeId: ref.nodeId,
        name: ref.workflowName,
        ...(ref.workflowId === undefined ? {} : { idHint: ref.workflowId }),
      })
    }
  }

  beginWorkgroups(): void {
    if (this.workgroupQueue !== undefined) return
    const cycleReport = detectCallCycles(this.root, (ref, sourceId) => {
      const snapshot = this.workflowByEdge.get(edgeKey(sourceId, ref.nodeId))
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

    for (const [key, workflow] of this.workflowByEdge) {
      this.closure.workflows[key] = {
        id: workflow.id,
        version: workflow.version,
        definition: workflow.definition,
      }
    }

    const requests: WorkgroupRequest[] = collectWorkgroupCallRefs(this.root.definition).map(
      (ref) => ({
        kind: 'call-workgroup',
        sourceWorkflowId: this.root.id,
        nodeId: ref.nodeId,
        name: ref.workgroupName,
        ...(ref.workgroupId === undefined ? {} : { idHint: ref.workgroupId }),
      }),
    )
    for (const workflow of this.workflowById.values()) {
      for (const ref of collectWorkgroupCallRefs(workflow.definition)) {
        requests.push({
          kind: 'call-workgroup',
          sourceWorkflowId: workflow.id,
          nodeId: ref.nodeId,
          name: ref.workgroupName,
          ...(ref.workgroupId === undefined ? {} : { idHint: ref.workgroupId }),
        })
      }
    }
    this.workgroupQueue = requests
  }

  nextWorkgroupRequest(): WorkgroupRequest | null {
    if (this.workgroupQueue === undefined) throw new Error('call-closure-workgroups-not-started')
    return this.workgroupQueue.shift() ?? null
  }

  acceptWorkgroup(
    request: WorkgroupRequest,
    snapshots: readonly FrozenTaskExecutionResourceSnapshot[],
  ): void {
    const snapshot: WorkgroupSnapshot = exactSnapshot(snapshots, 'call-workgroup')
    if (
      snapshot.sourceWorkflowId !== request.sourceWorkflowId ||
      snapshot.nodeId !== request.nodeId
    ) {
      throw new Error('task-execution-resource-edge-mismatch:call-workgroup')
    }
    this.closure.workgroups[edgeKey(request.sourceWorkflowId, request.nodeId)] = {
      id: snapshot.workgroup.id,
      version: snapshot.workgroup.version,
      group: snapshot.workgroup,
    }
  }

  serialize(): string | null {
    if (this.isEmpty()) return null
    if (this.workgroupQueue === undefined || this.workgroupQueue.length > 0) {
      throw new Error('call-closure-not-complete')
    }
    return JSON.stringify(this.closure)
  }
}

export type SyncTaskExecutionResourceReader = (
  requests: readonly TaskExecutionResourceRequest[],
) => readonly FrozenTaskExecutionResourceSnapshot[]

export type AsyncTaskExecutionResourceReader = (
  requests: readonly TaskExecutionResourceRequest[],
) => Promise<readonly FrozenTaskExecutionResourceSnapshot[]>

export function freezeTaskExecutionCallClosureSync(
  root: TaskExecutionCallClosureRoot,
  load: SyncTaskExecutionResourceReader,
): string | null {
  const builder = new TaskExecutionCallClosureBuilder(root)
  if (builder.isEmpty()) return null
  for (
    let request = builder.nextWorkflowRequest();
    request !== null;
    request = builder.nextWorkflowRequest()
  ) {
    builder.acceptWorkflow(request, load([request]))
  }
  builder.beginWorkgroups()
  for (
    let request = builder.nextWorkgroupRequest();
    request !== null;
    request = builder.nextWorkgroupRequest()
  ) {
    builder.acceptWorkgroup(request, load([request]))
  }
  return builder.serialize()
}

export async function freezeTaskExecutionCallClosureAsync(
  root: TaskExecutionCallClosureRoot,
  load: AsyncTaskExecutionResourceReader,
): Promise<string | null> {
  const builder = new TaskExecutionCallClosureBuilder(root)
  if (builder.isEmpty()) return null
  for (
    let request = builder.nextWorkflowRequest();
    request !== null;
    request = builder.nextWorkflowRequest()
  ) {
    builder.acceptWorkflow(request, await load([request]))
  }
  builder.beginWorkgroups()
  for (
    let request = builder.nextWorkgroupRequest();
    request !== null;
    request = builder.nextWorkgroupRequest()
  ) {
    builder.acceptWorkgroup(request, await load([request]))
  }
  return builder.serialize()
}
