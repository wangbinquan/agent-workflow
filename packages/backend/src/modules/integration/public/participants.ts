import type {
  CodeHostProvider,
  RepositoryEndpointCandidate,
  StartAgentTask,
  StartTask,
  StartWorkgroupTask,
} from '@agent-workflow/shared'

/** Secret-free provider metadata query used by source-control endpoint resolution. */
export interface RepositoryEndpointDiscoveryParticipant {
  discover(input: {
    readonly provider: CodeHostProvider
    readonly project: string
    readonly connectionGeneration: string
  }): Promise<RepositoryEndpointCandidate | null>
}

export interface EventWorkStartOrigin {
  readonly eventSubscriptionId: string
  readonly eventDeliveryId: string
}

export type WorkStartTarget =
  | { readonly kind: 'workflow'; readonly refId: string; readonly payload: StartTask }
  | {
      readonly kind: 'agent'
      readonly refId: string
      readonly payload: StartAgentTask & { readonly agentId: string }
    }
  | {
      readonly kind: 'workgroup'
      readonly refId: string
      readonly payload: StartWorkgroupTask & { readonly workgroupId: string }
    }
  | {
      readonly kind: 'digital-employee'
      readonly refId: string
      readonly intake: {
        readonly kind: 'body' | 'external-id'
        readonly target: Readonly<Record<string, string>>
        readonly body: string | null
        readonly externalId: string | null
        readonly uploads: readonly []
      }
    }

export type WorkStartReceipt =
  | { readonly kind: 'orchestration'; readonly taskId: string }
  | { readonly kind: 'digital-employee'; readonly caseId: string }

export interface DigitalEmployeeWorkStartPort {
  launch(input: {
    readonly employeeId: string
    readonly intake: Extract<WorkStartTarget, { readonly kind: 'digital-employee' }>['intake'] & {
      readonly idempotencyKey: string
    }
    readonly actorUserId: string | null
    readonly origin: EventWorkStartOrigin
  }): { readonly caseId: string }
}
