// Boot notifications can arrive before the complete admission effect exists.
// This inbox only buffers IDs; connecting transfers them to the frozen owner.
export interface QueuedIntentNotifications {
  enqueue(sessionIds: readonly string[]): void
  connect(consumer: (sessionIds: readonly string[]) => void): void
}

export function createQueuedIntentNotifications(): QueuedIntentNotifications {
  const pending = new Set<string>()
  let consumer: ((sessionIds: readonly string[]) => void) | undefined
  return Object.freeze({
    enqueue(sessionIds: readonly string[]) {
      if (consumer !== undefined) {
        consumer(sessionIds)
        return
      }
      for (const sessionId of sessionIds) pending.add(sessionId)
    },
    connect(next: (sessionIds: readonly string[]) => void) {
      if (consumer !== undefined) throw new Error('intent-queued-notifications-already-connected')
      const sessionIds = Object.freeze([...pending])
      pending.clear()
      consumer = next
      next(sessionIds)
    },
  })
}
