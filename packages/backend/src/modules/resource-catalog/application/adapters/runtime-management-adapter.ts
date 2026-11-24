import type { RealtimeResourceAclPort } from '@/modules/runtime-management/composition/required-ports'
// RFC-556: Resource Catalog's infrastructure takes Runtime Management's usage reader port from this designated adapter only.
export type { RuntimeProfileUsageReader } from '@/modules/runtime-management/composition/required-ports'
import type { RealtimeResourceAcl } from '../ports/realtimeResourceAcl'

export function composeRealtimeResourceAclPort(
  resources: RealtimeResourceAcl,
): RealtimeResourceAclPort {
  return { find: (kind, id) => resources.find(kind, id) }
}
