export interface ReviewUpstreamAgentQuery {
  outputProfile(agentId: string): Promise<{
    readonly syncOutputsOnIterate: boolean
    readonly outputs: string
    readonly frontmatterExtra: string
  } | null>
}
