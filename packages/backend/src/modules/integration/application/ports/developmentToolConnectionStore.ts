// RFC-502 (RFC-294 S10 step 9): the read port of the Digital Employee tool connection catalog, moved here unchanged
// from infrastructure/developmentToolConnectionStore.ts so the catalog in application can take it; the store implements it.

import type { DevelopmentAdapterIdentityRow } from '../developmentAdapterCommands'

export interface DevelopmentToolConnectionStore {
  identity(id: string): Promise<DevelopmentAdapterIdentityRow | null>
  identities(): Promise<readonly DevelopmentAdapterIdentityRow[]>
  revision(
    id: string,
    revision: number,
  ): Promise<{ readonly contentJson: string; readonly contentDigest: string } | null>
  grantedUserIds(id: string): Promise<ReadonlySet<string>>
}
