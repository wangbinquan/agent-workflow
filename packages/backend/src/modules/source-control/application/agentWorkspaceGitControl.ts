import { sha256Hex } from '@/util/hash'
import type {
  RepositoryGitOutcome as GitRunResult,
  RepositoryGitWorkspaceScope,
} from './ports/repositoryGitWorkspace'
import type { AgentWorkspaceGitControlSnapshot as GitControlSnapshot } from './ports/agentWorkspaceGitControl'

function digestGitObservation(result: GitRunResult, stdout = result.stdout): string {
  return sha256Hex(`${result.exitCode}\0${stdout}\0${result.stderr}`)
}

/**
 * Capture semantic Git control state around the exact Agent child window.
 * Read-only commands such as `git status` may refresh index stat data, so the
 * index observation deliberately hashes `ls-files --stage`, not `.git/index`
 * bytes. Platform-private refs are excluded; TaskEngine owns that namespace.
 */
export async function captureAgentWorkspaceGitControlSnapshot(
  workspace: Pick<RepositoryGitWorkspaceScope, 'run'>,
): Promise<GitControlSnapshot> {
  const [head, symbolicHead, index, refs, localConfig, worktreeConfig] = await Promise.all([
    workspace.run(['rev-parse', '--verify', 'HEAD']),
    workspace.run(['symbolic-ref', '--quiet', 'HEAD']),
    workspace.run(['ls-files', '--stage', '-z']),
    workspace.run(['for-each-ref', '--format=%(refname) %(objectname)']),
    workspace.run(['config', '--local', '--null', '--list']),
    workspace.run(['config', '--worktree', '--null', '--list']),
  ])
  const publicRefs = refs.stdout
    .split('\n')
    .filter((line) => !line.startsWith('refs/agent-workflow/'))
    .join('\n')
  return {
    head: digestGitObservation(head),
    symbolicHead: digestGitObservation(symbolicHead),
    index: digestGitObservation(index),
    refs: digestGitObservation(refs, publicRefs),
    localConfig: digestGitObservation(localConfig),
    worktreeConfig: digestGitObservation(worktreeConfig),
  }
}
