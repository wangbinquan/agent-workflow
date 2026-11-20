// RFC-516 — the live presence connections: a session-sourced connection opens a lease, release is idempotent and
// shutdown releases every live lease.
import type { PresenceConnectionTracker, PresenceLease } from '../public/participants'
import type { TrackUserPresence } from './commands/trackUserPresence'
import type { DirectAuthorityRuntime } from './operationContext'

export class RuntimePresenceConnections implements PresenceConnectionTracker {
  private readonly live = new Set<PresenceLease>()

  constructor(
    private readonly direct: DirectAuthorityRuntime,
    private readonly tracker: TrackUserPresence,
  ) {}

  open(authority: Parameters<PresenceConnectionTracker['open']>[0]): PresenceLease | null {
    const actor = this.direct.legacyProjectionForAuthority(authority)
    if (actor.source !== 'session') return null
    this.tracker.opened(actor.userId)
    let released = false
    const lease = Object.freeze({
      release: () => {
        if (released) return
        released = true
        this.live.delete(lease)
        this.tracker.closed(actor.userId)
      },
    }) as PresenceLease
    this.live.add(lease)
    return lease
  }

  shutdown(): void {
    for (const lease of [...this.live]) lease.release()
  }
}
