import type {
  IntegrationTriggerResourceSnapshotInTx,
  ResourceCurrentAuthorityInTx,
} from '../../public/participants'
import type {
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
} from '../../public/types'

type RequestOf<K extends IntegrationTriggerResourceRequest['kind']> = Extract<
  IntegrationTriggerResourceRequest,
  { readonly kind: K }
>
type SnapshotOf<K extends FrozenIntegrationTriggerResourceSnapshot['kind']> = Extract<
  FrozenIntegrationTriggerResourceSnapshot,
  { readonly kind: K }
>
type SnapshotPort<K extends IntegrationTriggerResourceRequest['kind']> = (
  authority: ResourceCurrentAuthorityInTx,
  request: RequestOf<K>,
) => SnapshotOf<K>

export interface IntegrationTriggerResourceSnapshotPorts {
  readonly scheduledWorkflow: SnapshotPort<'scheduled-workflow'>
  readonly scheduledAgent: SnapshotPort<'scheduled-agent'>
  readonly scheduledWorkgroup: SnapshotPort<'scheduled-workgroup'>
  readonly webhookWorkflow: SnapshotPort<'webhook-workflow'>
  readonly webhookDigitalEmployee: SnapshotPort<'webhook-digital-employee'>
}

export function createIntegrationTriggerResourceSnapshotInTx(
  ports: IntegrationTriggerResourceSnapshotPorts,
): IntegrationTriggerResourceSnapshotInTx {
  return {
    loadAuthorized(authority, requests) {
      return requests.map((request): FrozenIntegrationTriggerResourceSnapshot => {
        switch (request.kind) {
          case 'scheduled-workflow':
            return ports.scheduledWorkflow(authority, request)
          case 'scheduled-agent':
            return ports.scheduledAgent(authority, request)
          case 'scheduled-workgroup':
            return ports.scheduledWorkgroup(authority, request)
          case 'webhook-workflow':
            return ports.webhookWorkflow(authority, request)
          case 'webhook-digital-employee':
            return ports.webhookDigitalEmployee(authority, request)
        }
      })
    },
  }
}
