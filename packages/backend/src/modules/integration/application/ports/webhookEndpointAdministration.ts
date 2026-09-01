import type { WebhookEndpoint } from '@agent-workflow/shared'

export type WebhookEndpointRecord = Readonly<{
  id: string
  name: string
  provider: WebhookEndpoint['provider']
  urlToken: string
  secretEnc: string
  enabled: boolean
  preferredCloneProtocol: WebhookEndpoint['preferredCloneProtocol']
  lastDeliveryAt: number | null
  createdAt: number
  updatedAt: number
}>

export type WebhookEndpointCreateRecord = Readonly<{
  id: string
  name: string
  provider: WebhookEndpoint['provider']
  urlToken: string
  secretEnc: string
  preferredCloneProtocol: WebhookEndpoint['preferredCloneProtocol']
}>

export type WebhookEndpointMutablePatch = Readonly<
  Partial<Pick<WebhookEndpointRecord, 'name' | 'enabled' | 'preferredCloneProtocol'>> & {
    readonly secretEnc?: string
    readonly urlToken?: string
    readonly updatedAt: number
  }
>

export interface WebhookEndpointAdministrationPort {
  list(): Promise<readonly WebhookEndpointRecord[]>
  get(id: string): Promise<WebhookEndpointRecord | null>
  getByUrlToken(urlToken: string): Promise<WebhookEndpointRecord | null>
  /** Returns null only when the minted URL token collided with an existing endpoint. */
  tryCreate(record: WebhookEndpointCreateRecord): Promise<WebhookEndpointRecord | null>
  update(id: string, patch: WebhookEndpointMutablePatch): Promise<WebhookEndpointRecord | null>
  hasTriggerReferences(id: string): Promise<boolean>
  delete(id: string): Promise<boolean>
}
