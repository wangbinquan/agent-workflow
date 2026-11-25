// RFC-585 — the two node-isolation errors other contexts recognise, moved verbatim from the node isolation implementation
// (formerly platform/workspace/local/isolation.ts) so Task Execution can take them from Source Control's public types.

/** 全部代际都被残留挡住——带上够排障的现场。 */
export class IsoWorkspaceBlockedError extends Error {
  readonly code = 'iso-workspace-blocked' as const
  constructor(
    readonly detail: {
      baseKey: string
      generationsTried: number
      residualPath: string
      lastError: string
    },
  ) {
    super(
      `无法回收残留的隔离工作树（已尝试 ${detail.generationsTried} 代）\n` +
        `  残留: ${detail.residualPath}\n` +
        `  最后错误: ${detail.lastError}`,
    )
    this.name = 'IsoWorkspaceBlockedError'
  }
}

/**
 * The merge agent process survived its TERM/KILL escalation. This is a hard
 * framework barrier: the resolve worktree must remain intact and no later
 * conflict agent may start while the old writer can still mutate it.
 */
export class MergeAgentChildUnreapedError extends Error {
  constructor() {
    super('merge-agent-child-unreaped')
    this.name = 'MergeAgentChildUnreapedError'
  }
}
