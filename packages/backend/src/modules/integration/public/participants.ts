import type { StartAgentTask, StartTask, StartWorkgroupTask } from '@agent-workflow/shared'

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

export interface DigitalEmployeeWorkStartPort {
  launch(input: {
    readonly employeeId: string
    readonly intake: Extract<WorkStartTarget, { readonly kind: 'digital-employee' }>['intake'] & {
      readonly idempotencyKey: string
    }
    readonly actorUserId: string | null
    readonly origin: EventWorkStartOrigin
  }): Promise<{ readonly caseId: string }>
}

// RFC-566: `SelectedPipelineEvidenceExecution` left the public — Development Automation types the pipeline execution with
// its own runner port, and bootstrap hands this module's implementation over (it satisfies that port structurally).
export type {
  RequirementAdapterBinding,
  PipelineAdapterBinding,
  ApprovalAdapterBinding,
} from '../application/ports/developmentPurposeBinding'
export type {
  AdapterConfigurationReference,
  AdapterProgramReference,
  AdapterProgramFactory,
  AdapterProcessObservation,
  RequirementAdapterEffects,
  PipelineAdapterEffects,
  ApprovalAdapterEffects,
} from '../application/ports/developmentAdapterEffects'
