// RFC-301 — trusted inbound authentication projection.
//
// Actor is an identity-access result. Only this thin inbound adapter observes
// its source; task-execution domain receives the closed manual/api initiator.

import type { ActorSource } from '@/auth/actor'
import type { DirectTaskInitiator } from '@/modules/task-execution/domain/taskLaunchOrigin'

export function directTaskInitiatorFromActorSource(source: ActorSource): DirectTaskInitiator {
  switch (source) {
    case 'session':
      return 'manual'
    case 'pat':
    case 'daemon':
      return 'api'
  }
}
