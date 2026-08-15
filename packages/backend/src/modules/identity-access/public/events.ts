export interface AuthorityRevisionChanged {
  readonly type: 'authority.revision-changed'
  readonly subjectRef: { readonly userId: string }
  readonly revision: number
}

export interface IdentityAccessEventSink {
  authorityRevisionChanged(event: AuthorityRevisionChanged): void
}
