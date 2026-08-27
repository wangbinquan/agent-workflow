// RFC-333 — collaboration composition root. Legacy callers enter through one
// temporary service bridge until their constructors receive these dependencies.

export { composeTaskExecutionHumanGateAdapter } from './application/adapters/task-execution-human-gate-adapter'
export { createCollaborationCommandContext } from './composition/commandContext'
