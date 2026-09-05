import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  createOwnerIdentityQueries,
  type OwnerIdentityQueries,
} from '../application/ports/ownerIdentityQueries'
import { DrizzleOwnerIdentityPersistence } from '../infrastructure/ownerIdentityQueries'

/** owner 身份查询：一份实现，两个 provider 共用（RFC-359 W4-B4 的持久化 + W4-D8 的装配入口）。 */
export function composeOwnerIdentityQueries(db: ProviderNeutralDatabase): OwnerIdentityQueries {
  return createOwnerIdentityQueries({
    persistence: new DrizzleOwnerIdentityPersistence(db),
    systemUserId: SYSTEM_USER_ID,
  })
}
