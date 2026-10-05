import { runGit } from '@/util/git'
import { captureAgentWorkspaceGitControlSnapshot } from '../../application/agentWorkspaceGitControl'
import type { AgentWorkspaceGitControlObservation } from '../../application/ports/agentWorkspaceGitControl'

/** Each capture samples the original cwd once, immediately before its six reads. */
export function bindFileAgentWorkspaceGitControlObservation(input: {
  readonly workingDirectory: () => string
}): AgentWorkspaceGitControlObservation {
  return {
    capture() {
      const cwd = input.workingDirectory()
      return captureAgentWorkspaceGitControlSnapshot({
        run(args) {
          return runGit(cwd, args as string[])
        },
      })
    },
  }
}
