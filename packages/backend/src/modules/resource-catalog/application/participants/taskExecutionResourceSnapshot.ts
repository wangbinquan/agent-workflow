import type {
  ResourceCurrentAuthorityInTx,
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
    authority: ResourceCurrentAuthorityInTx,
    request: RequestOf<'workflow-launch'>,
  ) => SnapshotOf<'workflow-launch'>
  readonly agentInjection: (
    authority: ResourceCurrentAuthorityInTx,
    request: RequestOf<'agent-injection'>,
  ) => SnapshotOf<'agent-injection'>
  readonly callWorkflow: (
    authority: ResourceCurrentAuthorityInTx,
    request: RequestOf<'call-workflow'>,
  ) => SnapshotOf<'call-workflow'>
  readonly callWorkgroup: (
    authority: ResourceCurrentAuthorityInTx,
    request: RequestOf<'call-workgroup'>,
  ) => SnapshotOf<'call-workgroup'>
}

export function createTaskExecutionResourceSnapshotInTx(
  ports: TaskExecutionResourceSnapshotPorts,
): TaskExecutionResourceSnapshotInTx {
  return {
    loadAuthorized(authority, requests) {
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
  }
}
