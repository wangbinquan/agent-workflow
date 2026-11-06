// RFC-453 — the code-review reads a test drives the workspace-insight use cases with directly: the task workspace
// plus this host's standalone selections (native worktrees, the appHome artifact files, the local deep indexing),
// each overridable. The HTTP composition always passes all of them; since RFC-453 the use cases no longer build the
// standalone artifact store or the deep indexing themselves, so direct callers assemble them here.
import type { TaskCodeWorkspaceQueries } from '@/modules/task-execution/public/types'
import { composeLocalRepositoryRevisionContent } from '@/modules/source-control/public/participants'
import {
  composeLocalCodeReviewArtifacts,
  composeStructuralDeepIndexing,
} from '@/modules/workspace-insight/composition'
import type { CodeReviewReads } from '@/modules/workspace-insight/application/structuralDiff/taskStructuralDiff'

export function localCodeReviewReads(
  workspace: TaskCodeWorkspaceQueries,
  overrides: Partial<Omit<CodeReviewReads, 'workspace'>> = {},
): CodeReviewReads {
  return {
    workspace,
    content: overrides.content ?? composeLocalRepositoryRevisionContent(),
    artifacts: overrides.artifacts ?? composeLocalCodeReviewArtifacts(),
    deep: overrides.deep ?? composeStructuralDeepIndexing(),
  }
}
