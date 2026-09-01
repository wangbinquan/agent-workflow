import type { TaskStatus, WebhookFireOutcome } from '@agent-workflow/shared'

export type WebhookTriggerRecord = Readonly<{
  id: string
  name: string
  endpointId: string
  ownerUserId: string
  enabled: boolean
  repoScope: string
  eventTypes: string
  branchFilter: string | null
  commandPrefix: string | null
  ignoreUsernames: string
  launchKind: 'workflow' | 'agent' | 'workgroup' | 'digital-employee' | 'code-round'
  launchRefId: string
  launchPayload: string
  templateSyntaxVersion: number
  maxConsecutiveFires: number
  autoRegisterRepos: boolean
  cancelOnMrTerminal: boolean
  lastFiredAt: number | null
  lastStatus: 'launched' | 'failed' | null
  lastError: string | null
  lastTaskId: string | null
  consecutiveFailures: number
  createdAt: number
  updatedAt: number
}>

export type WebhookEndpointRecord = Readonly<{
  id: string
  name: string
  provider: 'gitlab' | 'github'
  urlToken: string
  secretEnc: string
  enabled: boolean
  preferredCloneProtocol: 'http' | 'ssh'
  lastDeliveryAt: number | null
  createdAt: number
  updatedAt: number
}>

export type WebhookDeliveryMrFact = Readonly<{
  streamKey: string | null
  revision: number | null
  stateAfter: 'open' | 'closed' | 'merged' | null
}>

export type WebhookTriggerStreamRecord = Readonly<{
  consecutiveFires: number
  lastFireAt: number | null
}>

export type WebhookSubscriptionEnvelope = Readonly<{
  endpoint: WebhookEndpointRecord
  delivery: Readonly<{
    bodyJson: string | null
    gitlabEventHeader: string | null
    replayedFromDeliveryId: string | null
  }>
}>

export type WebhookFireRecordInput = Readonly<{
  fireId: string
  deliveryId: string
  triggerId: string
  streamKey: string
  outcome: WebhookFireOutcome
  supersededTaskId?: string | null
  taskId?: string | null
  employeeCaseId?: string | null
  error?: string | null
}>

/** Persistence required by webhook matching and work-start orchestration. */
export interface WebhookDispatchPersistencePort {
  triggerEnabled(triggerId: string): Promise<boolean | null>
  migrateTriggerTemplate(input: {
    readonly triggerId: string
    readonly expectedLaunchPayload: string
    readonly launchPayload: string
    readonly now: number
  }): Promise<WebhookTriggerRecord | null>
  recordFire(input: WebhookFireRecordInput): Promise<void>
  fireExists(deliveryId: string, triggerId: string): Promise<boolean>
  findTaskByOrigin(input: {
    readonly fireId: string
    readonly eventDeliveryId?: string
  }): Promise<string | null>
  getTrigger(triggerId: string): Promise<WebhookTriggerRecord | null>
  getTriggerStream(triggerId: string, streamKey: string): Promise<WebhookTriggerStreamRecord | null>
  putTriggerStream(input: {
    readonly triggerId: string
    readonly streamKey: string
    readonly consecutiveFires: number
    readonly lastFireAt?: number
  }): Promise<void>
  getDeliveryMrFact(deliveryId: string): Promise<WebhookDeliveryMrFact | null>
  findLatestLaunchedTask(
    triggerId: string,
    streamKey: string,
  ): Promise<Readonly<{ id: string; status: TaskStatus }> | null>
  markTriggerLaunchFailed(triggerId: string, error: string, now: number): Promise<void>
  markTriggerLaunched(input: {
    readonly triggerId: string
    readonly taskId: string | null
    readonly now: number
  }): Promise<void>
  listEnabledTriggers(endpointId: string): Promise<readonly WebhookTriggerRecord[]>
  deliveryControlEffectId(deliveryId: string): Promise<string | null>
  subscriptionEnvelope(deliveryId: string): Promise<WebhookSubscriptionEnvelope | null>
}
