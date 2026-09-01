/** Origin facts needed by the Webhook terminal-workspace policy. */
export interface WebhookTerminalWorkspaceAttribution {
  readonly webhookTriggerId: string | null
  readonly eventSubscriptionId: string | null
}

/** Provider-neutral narrow read; task content and persistence rows stay private. */
export interface WebhookTerminalWorkspaceAttributionQueries {
  load(taskId: string): Promise<WebhookTerminalWorkspaceAttribution | null>
}
