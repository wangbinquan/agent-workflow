/** Logical System content namespace; the selected owner interprets its layout. */
export interface SystemAgentWorkspaceScope {
  readonly namespace: 'intent' | 'shared'
  readonly name?: string
}

/** Capture the selected owner's scope at the caller's original read point. */
export interface SystemAgentWorkspaceScopes {
  capture(input: SystemAgentWorkspaceScope): SystemAgentWorkspaceScope
  withName(scope: SystemAgentWorkspaceScope, name: string): SystemAgentWorkspaceScope
}

export interface SystemAgentRetainedContents {
  release(input: {
    readonly retainedRef: string
    readonly scope: SystemAgentWorkspaceScope
  }):
    | { readonly removed: boolean; readonly reason?: 'unsafe-path' | 'remove-failed' }
    | Promise<{ readonly removed: boolean; readonly reason?: 'unsafe-path' | 'remove-failed' }>
}
