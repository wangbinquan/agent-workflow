import { createLocalTaskAgentWorkspaceContents } from '../infrastructure/local/taskAgentWorkspaceContents'

export function composeLocalTaskAgentWorkspaceContents(
  input: Parameters<typeof createLocalTaskAgentWorkspaceContents>[0],
) {
  return createLocalTaskAgentWorkspaceContents(input)
}
