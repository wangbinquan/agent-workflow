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
  ) => Promise<SnapshotOf<'workflow-launch'>>
  readonly agentInjection: (
    authority: ResourceRequestContext,
    request: RequestOf<'agent-injection'>,
  ) => Promise<SnapshotOf<'agent-injection'>>
  readonly callWorkflow: (
    authority: ResourceRequestContext,
    request: RequestOf<'call-workflow'>,
  ) => Promise<SnapshotOf<'call-workflow'>>
  readonly callWorkgroup: (
    authority: ResourceRequestContext,
    request: RequestOf<'call-workgroup'>,
  ) => Promise<SnapshotOf<'call-workgroup'>>
}

const trustedTaskExecutionSnapshots = new WeakSet<TaskExecutionResourceSnapshotInTx>()

export function createTaskExecutionResourceSnapshotInTx(
  ports: TaskExecutionResourceSnapshotPorts,
): TaskExecutionResourceSnapshotInTx {
  const participant = Object.freeze({
    async loadAuthorized(
      authority: ResourceRequestContext,
      requests: readonly TaskExecutionResourceRequest[],
    ) {
      // 顺序求值：闭包冻结依赖「一条请求的结果决定下一条」，并发化会改变错误的先后。
      const snapshots: FrozenTaskExecutionResourceSnapshot[] = []
      for (const request of requests) {
        switch (request.kind) {
          case 'workflow-launch':
            snapshots.push(await ports.workflowLaunch(authority, request))
            break
          case 'agent-injection':
            snapshots.push(await ports.agentInjection(authority, request))
            break
          case 'call-workflow':
            snapshots.push(await ports.callWorkflow(authority, request))
            break
          case 'call-workgroup':
            snapshots.push(await ports.callWorkgroup(authority, request))
            break
        }
      }
      return snapshots
    },
  }) as unknown as TaskExecutionResourceSnapshotInTx
  trustedTaskExecutionSnapshots.add(participant)
  return participant
}
