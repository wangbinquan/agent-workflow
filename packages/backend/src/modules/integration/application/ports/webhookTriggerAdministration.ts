import type { WebhookFireOutcome } from '@agent-workflow/shared'
import type { WebhookTriggerRecord } from './webhookDispatchPersistence'

export type WebhookTriggerFireRecord = Readonly<{
  id: string
  deliveryId: string
  triggerId: string
  streamKey: string
  outcome: WebhookFireOutcome
  supersededTaskId: string | null
  taskId: string | null
  employeeCaseId: string | null
  error: string | null
  firedAt: number
}>

export type WebhookTriggerCreateRecord = Omit<
  WebhookTriggerRecord,
  | 'lastFiredAt'
  | 'lastStatus'
  | 'lastError'
  | 'lastTaskId'
  | 'consecutiveFailures'
  | 'createdAt'
  | 'updatedAt'
>

export type WebhookTriggerMutablePatch = Partial<
  Pick<
    WebhookTriggerRecord,
    | 'name'
    | 'enabled'
    | 'repoScope'
    | 'eventTypes'
    | 'branchFilter'
    | 'commandPrefix'
    | 'ignoreUsernames'
    | 'launchRefId'
    | 'launchPayload'
    | 'maxConsecutiveFires'
    | 'autoRegisterRepos'
    | 'cancelOnMrTerminal'
  >
> &
  Readonly<{ templateSyntaxVersion: 2; updatedAt: number }>

export interface WebhookTriggerAdministrationPort {
  list(): Promise<readonly WebhookTriggerRecord[]>
  get(id: string): Promise<WebhookTriggerRecord | null>
  endpointExists(endpointId: string): Promise<boolean>
  create(record: WebhookTriggerCreateRecord): Promise<WebhookTriggerRecord>
  update(input: {
    readonly triggerId: string
    readonly patch: WebhookTriggerMutablePatch
    readonly expectedLaunchConfiguration?: Readonly<{
      templateSyntaxVersion: number
      launchRefId: string
      launchPayload: string
      eventTypes: string
      autoRegisterRepos: boolean
      cancelOnMrTerminal: boolean
    }>
  }): Promise<WebhookTriggerRecord | null>
  delete(triggerId: string): Promise<void>
  listFires(triggerId: string, limit: number): Promise<readonly WebhookTriggerFireRecord[]>
  resetStream(input: {
    readonly triggerId: string
    readonly streamKey: string
    readonly resetAt: number
    readonly resetBy: string
  }): Promise<void>
}
