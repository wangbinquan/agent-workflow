export type McpRuntimeProtocol = 'opencode' | 'claude-code'

export interface McpRuntimeTestLeaseToken {
  readonly protocol: McpRuntimeProtocol
  readonly runtimeSessionId: string
  readonly testSessionId: string
  readonly turnId: string
  readonly leaseNonceDigest: string
}

export interface McpRuntimeTestLeaseInput extends McpRuntimeTestLeaseToken {
  readonly leasedAt?: number
}

export class McpRuntimeTestLeaseError extends Error {
  readonly code = 'mcp-test-session-conflict' as const

  constructor(readonly reason: string) {
    super('mcp-test-session-conflict')
    this.name = 'McpRuntimeTestLeaseError'
  }
}

/** Provider-neutral single-writer lease participant for one MCP playground. */
export interface McpRuntimeTestLeaseOperations {
  claimNew(input: McpRuntimeTestLeaseInput): Promise<McpRuntimeTestLeaseToken>
  preclaim(input: McpRuntimeTestLeaseInput): Promise<McpRuntimeTestLeaseToken>
  rotate(
    token: McpRuntimeTestLeaseToken,
    nextRuntimeSessionId: string,
  ): Promise<McpRuntimeTestLeaseToken>
  release(token: McpRuntimeTestLeaseToken): Promise<boolean>
  repairAfterReap(testSessionId: string, turnId: string, childReaped: true): Promise<boolean>
}
