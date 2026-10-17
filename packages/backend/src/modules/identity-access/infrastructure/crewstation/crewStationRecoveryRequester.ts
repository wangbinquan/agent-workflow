import { and, eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { externalIdentities } from '@/db/schema'
import type { DirectAuthorityIdentity } from '../../public/participants'
import { CREWSTATION_ISSUER } from './crewStationIdentityToken'
import {
  admitDurableWorkOwner,
  type DirectAuthorityAdmissionRuntime,
} from '../local/localCredentialAdmission'

/** RFC-370 §9.2 V4 — the AW account a CrewStation recovery request runs as.
 * The platform user is matched through its existing CrewStation identity
 * link; a request never provisions an account. */
export function createCrewStationRecoveryRequester(input: {
  readonly db: ProviderNeutralDatabase
  readonly identityAccess: DirectAuthorityAdmissionRuntime
}): {
  resolve(requestedBy: string): Promise<DirectAuthorityIdentity | null>
} {
  return {
    async resolve(requestedBy) {
      const [link] = await input.db
        .select({ userId: externalIdentities.userId })
        .from(externalIdentities)
        .where(
          and(
            eq(externalIdentities.issuer, CREWSTATION_ISSUER),
            eq(externalIdentities.subject, `user:${requestedBy}`),
          ),
        )
        .limit(1)
      if (link === undefined) return null
      return admitDurableWorkOwner(input.identityAccess, link.userId)
    },
  }
}
