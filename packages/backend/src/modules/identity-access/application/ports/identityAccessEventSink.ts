// RFC-551 (RFC-294 S9): the sink a user-access update reports an authority revision change to, and that event. They sat on `public/` without any other module consuming them.
export interface AuthorityRevisionChanged {
  readonly type: 'authority.revision-changed'
  readonly subjectRef: { readonly userId: string }
  readonly revision: number
}

export interface IdentityAccessEventSink {
  authorityRevisionChanged(event: AuthorityRevisionChanged): void
}
