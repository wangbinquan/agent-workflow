import type { NodeRunLifecyclePersistence } from '../../application/ports/nodeRunLifecyclePersistence'
import type { TaskExecutionContextRef } from '../../application/ports/taskExecutionTopology'
import type { NodeRunLedger } from '../../application/ports/executionKernel'

/** Bind the existing lifecycle participant; selection and mint policy stay with the caller. */
export function bindNodeRunLedger(
  nodeRuns: NodeRunLifecyclePersistence,
  executionContext?: TaskExecutionContextRef,
): NodeRunLedger {
  const contextInput = () => (executionContext === undefined ? {} : { executionContext })
  return {
    executionContextInput: contextInput,
    async mintNodeRun(input) {
      return await nodeRuns.mint({ ...input, ...contextInput() })
    },
    async setNodeRunStatus(input) {
      return await nodeRuns.set({ ...input, ...contextInput() })
    },
    async transitionNodeRunStatus(input) {
      return await nodeRuns.transition({ ...input, ...contextInput() })
    },
    async loadEnvelopeNonce(nodeRunId) {
      return await nodeRuns.loadEnvelopeNonce(nodeRunId)
    },
  }
}
