import { createLocalTaskAgentRuntimeBindings } from '../infrastructure/local/taskAgentRuntimeBindings'

export function composeLocalTaskAgentRuntimeBindings(
  input: Parameters<typeof createLocalTaskAgentRuntimeBindings>[0],
) {
  return createLocalTaskAgentRuntimeBindings(input)
}
