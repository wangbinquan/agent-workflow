// RFC-496: moved from infrastructure/attemptSupport.ts. Which Git metadata paths the `git-meta` protected root leaves out of
// its byte comparison is a rule with no dependencies, so it lives in the domain.

/**
 * TaskEngine owns these paths across one whole attempt: RFC-130 creates and
 * removes isolated worktrees, snapshots full state into its private ref
 * namespace, and refreshes the common object store/index/config. They cannot
 * identify an Agent-side Git command in an attempt-wide byte snapshot.
 *
 * The runner therefore enforces the Agent's no-Git contract over the exact
 * child-process window (HEAD, refs, index and config semantic state). Keep the
 * evidence root completely unfiltered here.
 */
export const PLATFORM_OWNED_GIT_METADATA_PREFIXES = [
  'ORIG_HEAD',
  'agent-workflow',
  'config',
  'config.worktree',
  'index',
  'logs',
  'objects',
  'refs/agent-workflow',
  'worktrees',
] as const

/**
 * The runtime's own cache in the Git common directory, written by the runtime
 * process rather than by an Agent-side Git command: OpenCode stores its project
 * id at `<git common dir>/opencode` every time it starts in a repository
 * (opencode packages/core/src/project.ts:124-126, called from
 * packages/opencode/src/project/project.ts:306-308). An Agent node runs in an
 * RFC-130 linked worktree whose common directory is the action workspace's
 * `.git`, so the first real OpenCode round of every action workspace reported
 * it as added (RFC-370 hosted acceptance, 2026-10-19). It is not Git state;
 * HEAD, refs, index and config stay covered by the runner's window check.
 */
export const RUNTIME_OWNED_GIT_METADATA_PREFIXES = ['opencode'] as const

/** What the `git-meta` protected root leaves out of its byte comparison. */
export const GIT_METADATA_SKIP_PREFIXES: readonly string[] = [
  ...PLATFORM_OWNED_GIT_METADATA_PREFIXES,
  ...RUNTIME_OWNED_GIT_METADATA_PREFIXES,
]
