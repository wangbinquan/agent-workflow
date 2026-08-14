// RFC-303 — process-local owners for pre-task Webhook launch work.
export class InMemoryWebhookLaunchSupervisor {
  private readonly owners = new Map<string, AbortController>()

  register(guardId: string, controller: AbortController): boolean {
    if (this.owners.has(guardId)) return false
    this.owners.set(guardId, controller)
    return true
  }

  abort(guardId: string): boolean {
    const controller = this.owners.get(guardId)
    if (controller === undefined) return false
    controller.abort(new Error('webhook-mr-terminal-launch-revoked'))
    return true
  }

  has(guardId: string): boolean {
    return this.owners.has(guardId)
  }

  release(guardId: string, controller: AbortController): boolean {
    if (this.owners.get(guardId) !== controller) return false
    this.owners.delete(guardId)
    return true
  }

  abortAll(): void {
    for (const controller of this.owners.values()) {
      controller.abort(new Error('daemon-shutdown'))
    }
    this.owners.clear()
  }
}
