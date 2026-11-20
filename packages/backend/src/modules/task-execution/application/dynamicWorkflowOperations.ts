// RFC-514 — the dynamic-workflow generation engine's operations are a conditional dependency: only a task that selected
// that engine needs them, and one that did fails closed without them.
export function requireDynamicWorkflowOperations<T>(dynamicWorkflow: T | undefined): T {
  if (dynamicWorkflow === undefined) {
    throw new Error('dynamic-workflow-operations-not-composed')
  }
  return dynamicWorkflow
}
