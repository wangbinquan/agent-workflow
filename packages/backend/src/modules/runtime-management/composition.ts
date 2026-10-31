// RFC-349 — runtime-management owns provider-selected realtime composition.

import type { RealtimeTaskFactsPort, RealtimeResourceAclPort } from './composition/required-ports'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { WebSocketAuthenticationParticipant } from '@/modules/identity-access/public/participants'
import { createRealtimeChannelAccess } from './application/realtimeChannelAccess'
import { DrizzleRealtimeStore } from './infrastructure/realtimeStore'
import type { RealtimeRuntime } from './public/participants'
import type { RealtimeCompositionPolicy } from './application/ports/realtimeCompositionPolicy'

export type { RealtimeCompositionPolicy } from './application/ports/realtimeCompositionPolicy'

function composeRealtimeRuntime(input: {
  readonly credentials: WebSocketAuthenticationParticipant
  readonly channels: ReturnType<typeof createRealtimeChannelAccess>
}): RealtimeRuntime {
  return Object.freeze({
    credentials: input.credentials,
    channels: input.channels,
  })
}

/**
 * RFC-359：此前是两个**函数体逐字相同**的孪生，唯一差别是形参上 `db` 的声明类型——
 * 而 `DrizzleRealtimeStore` 本来就收中立客户端。收成一份（plan §5ds）。
 */
export function composeRealtimeRuntimeFor(input: {
  readonly db: PersistenceDb
  readonly taskFacts: RealtimeTaskFactsPort
  readonly resources: RealtimeResourceAclPort
  readonly credentials: WebSocketAuthenticationParticipant
  readonly policy: RealtimeCompositionPolicy
}): RealtimeRuntime {
  return composeRealtimeRuntime({
    credentials: input.credentials,
    channels: createRealtimeChannelAccess(
      new DrizzleRealtimeStore(input.db, input.taskFacts, input.resources),
      input.policy,
    ),
  })
}

export { schemaContribution } from './composition/schema'
