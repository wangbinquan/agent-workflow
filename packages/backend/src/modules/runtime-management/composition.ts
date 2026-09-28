// RFC-349 — runtime-management owns provider-selected realtime composition.

import type { ProviderNeutralDatabase } from '@/db/query'
import type { WebSocketAuthenticationParticipant } from '@/modules/identity-access/public/participants'
import { createRealtimeChannelAccess } from './application/realtimeChannelAccess'
import { DrizzleRealtimeStore } from './infrastructure/realtimeStore'
import type { RealtimeCompositionPolicy, RealtimeRuntime } from './public/participants'

export type { RealtimeCompositionPolicy } from './public/participants'

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
  readonly db: ProviderNeutralDatabase
  readonly credentials: WebSocketAuthenticationParticipant
  readonly policy: RealtimeCompositionPolicy
}): RealtimeRuntime {
  return composeRealtimeRuntime({
    credentials: input.credentials,
    channels: createRealtimeChannelAccess(new DrizzleRealtimeStore(input.db), input.policy),
  })
}
