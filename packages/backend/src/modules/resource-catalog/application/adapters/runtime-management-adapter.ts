import type { RealtimeResourceAclPort } from '@/modules/runtime-management/composition/required-ports'
import type { RealtimeResourceAcl } from '../ports/realtimeResourceAcl'

export function composeRealtimeResourceAclPort(
  resources: RealtimeResourceAcl,
): RealtimeResourceAclPort {
  return { find: (kind, id) => resources.find(kind, id) }
}
