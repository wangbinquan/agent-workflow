export interface OidcProviderPersistenceRecord {
  readonly id: string
  readonly slug: string
  readonly displayName: string
  readonly issuerUrl: string
  readonly clientId: string
  readonly clientSecretEnc: string
  readonly scopes: string
  readonly provisioning: 'auto' | 'allowlist' | 'invite'
  readonly allowedEmailDomainsJson: string
  readonly iconUrl: string | null
  readonly enabled: boolean
  readonly authorizationEndpoint: string | null
  readonly tokenEndpoint: string | null
  readonly userinfoEndpoint: string | null
  readonly userinfoRequestStyle: 'get_bearer' | 'post_json'
  readonly jwksUri: string | null
  readonly trustEmailVerified: boolean
  readonly usernameClaim: string | null
  readonly gitNameClaim: string | null
  readonly emailClaim: string | null
  readonly subjectClaim: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly schemaVersion: number
}

export type InsertOidcProviderRecord = OidcProviderPersistenceRecord

export type PatchOidcProviderRecord = Partial<
  Omit<OidcProviderPersistenceRecord, 'id' | 'createdAt' | 'schemaVersion'>
> & {
  readonly updatedAt: number
}

export type OidcProviderWriteResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false
      readonly code:
        | 'oidc-provider-not-found'
        | 'oidc-slug-taken'
        | 'last-enabled-oidc-required'
        | 'subject-claim-locked-by-identities'
        | 'provider-still-linked'
    }

export interface OidcProviderRepository {
  list(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>>
  listEnabled(): Promise<ReadonlyArray<OidcProviderPersistenceRecord>>
  findById(id: string): Promise<OidcProviderPersistenceRecord | null>
  findBySlug(slug: string): Promise<OidcProviderPersistenceRecord | null>
  insert(
    record: InsertOidcProviderRecord,
  ): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>>
  patch(input: {
    readonly id: string
    readonly updates: PatchOidcProviderRecord
    readonly subjectClaimChanges: boolean
  }): Promise<OidcProviderWriteResult<OidcProviderPersistenceRecord>>
  remove(input: {
    readonly id: string
    readonly force: boolean
  }): Promise<OidcProviderWriteResult<undefined>>
}
