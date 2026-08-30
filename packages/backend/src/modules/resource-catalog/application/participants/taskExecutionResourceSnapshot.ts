import type {
  ResourceRequestContext,
  TaskExecutionResourceSnapshotInTx,
} from '../../public/participants'
import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionResourceRequest,
} from '../../public/types'

type RequestOf<K extends TaskExecutionResourceRequest['kind']> = Extract<
  TaskExecutionResourceRequest,
  { readonly kind: K }
>
type SnapshotOf<K extends FrozenTaskExecutionResourceSnapshot['kind']> = Extract<
  FrozenTaskExecutionResourceSnapshot,
  { readonly kind: K }
>

export interface TaskExecutionResourceSnapshotPorts {
  readonly workflowLaunch: (
    authority: ResourceRequestContext,
    request: RequestOf<'workflow-launch'>,
  ) => SnapshotOf<'workflow-launch'>
  readonly agentInjection: (
    authority: ResourceRequestContext,
    request: RequestOf<'agent-injection'>,
  ) => SnapshotOf<'agent-injection'>
  readonly callWorkflow: (
    authority: ResourceRequestContext,
    request: RequestOf<'call-workflow'>,
  ) => SnapshotOf<'call-workflow'>
  readonly callWorkgroup: (
    authority: ResourceRequestContext,
    request: RequestOf<'call-workgroup'>,
  ) => SnapshotOf<'call-workgroup'>
}

const trustedTaskExecutionSnapshots = new WeakSet<TaskExecutionResourceSnapshotInTx>()

export function createTaskExecutionResourceSnapshotInTx(
  ports: TaskExecutionResourceSnapshotPorts,
): TaskExecutionResourceSnapshotInTx {
  const participant = Object.freeze({
    loadAuthorized(
      authority: ResourceRequestContext,
      requests: readonly TaskExecutionResourceRequest[],
    ) {
      return requests.map((request): FrozenTaskExecutionResourceSnapshot => {
        switch (request.kind) {
          case 'workflow-launch':
            return ports.workflowLaunch(authority, request)
          case 'agent-injection':
            return ports.agentInjection(authority, request)
          case 'call-workflow':
            return ports.callWorkflow(authority, request)
          case 'call-workgroup':
            return ports.callWorkgroup(authority, request)
        }
      })
    },
  }) as unknown as TaskExecutionResourceSnapshotInTx
  trustedTaskExecutionSnapshots.add(participant)
  return participant
}
